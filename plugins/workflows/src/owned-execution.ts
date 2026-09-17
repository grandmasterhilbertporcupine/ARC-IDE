import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "./data.js";
import {
  ownedAdapterRpcContract,
  ownedStepFailureSchema,
  ownedStepRefKey,
  ownedStepObservationLookupInputSchema,
  ownedControlReceiptSchema,
  resolveOwnedRequirements,
  type OwnedRunControl,
  type OwnedContinuationKey,
  type OwnedContinuationReserve,
  type OwnedContinuationStart,
  type OwnedRuleContinuationStart,
  type OwnedAddressedContinuationStart,
  type OwnedRunStartInput,
  type OwnedStepFailure,
  type OwnedStepRef,
} from "./owned-contract.js";
import {
  activeOwnedAttempts,
  checkingOwnedAttempts,
  outdatedOwnedValidationAttempts,
  unverifiedOwnedValidationAttempts,
  pendingOwnedValidationRequests,
  reserveOwnedValidationRequest,
  admitOwnedStep,
  createOwnedRun,
  controlOwnedRun,
  failOwnedRun,
  finishOwnedRun,
  hashOwnedValue,
  hasRunningOwnedValidation,
  markOwnedAttemptUncertain,
  ownedTerminalObservation,
  ownedReceiptIsCurrent,
  ownedStepDependencyReceipts,
  ownedRunClockExcluded,
  OwnedAdmissionBlocked,
  OwnedBudgetExhausted,
  pendingOwnedRunIds,
  recordOwnedObservation,
  recoverOwnedRuns,
  reconcileOwnedRunState,
  redispatchOwnedAttempt,
  requireOwnedAttempt,
  requireOwnedOwner,
  requireOwnedRun,
  requiredOwnedGateAttempts,
  reserveOwnedActiveInterval,
  selectedOwnedAttempt,
  settleOwnedActiveInterval,
  staleOwnedAttempts,
  viewOwnedRun,
  type OwnedAttemptRecord,
  type OwnedRunRecord,
  type OwnedValidationRequest,
} from "./owned-data.js";
import {
  reserveOwnedContinuation,
  inspectOwnedContinuation,
  startOwnedContinuation,
  startOwnedRuleContinuation,
  startOwnedAddressedContinuation,
  inspectOwnedRuleContext,
  cancelOwnedContinuation,
  finalizeOwnedContinuations,
} from "./owned-continuation-data.js";
import { executeWorkflowScript } from "./runtime.js";
import { parseWorkflowSource } from "./parser.js";
import type { JsonValue, WorkflowCapabilities } from "./types.js";

class OwnedStepExecutionError extends Error {
  readonly stepFailure: OwnedStepFailure;

  constructor(attempt: OwnedAttemptRecord) {
    const observation = ownedTerminalObservation(attempt);
    if (observation === null || observation.state === "succeeded")
      throw new Error("Step has no failure receipt");
    super(
      `Step ${attempt.row.node_id} iteration ${attempt.row.iteration} ${observation.state}`,
    );
    const request = attempt.request;
    this.stepFailure = ownedStepFailureSchema.parse({
      workflowRunId: request.workflowRunId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      iteration: request.iteration,
      attempt: request.attempt,
      effectId: request.effectId,
      requestHash: request.requestHash,
      state: observation.state,
      receipt: observation.receipt,
      receiptHash: observation.receiptHash,
    });
  }
}

interface StepWaiter {
  runId: string;
  ref: OwnedStepRef;
  input: JsonValue;
  generation: number;
  signal: AbortSignal;
  promise: Promise<JsonValue>;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  freshness: Map<string, string>;
  terminalOnly: false | "successful" | "validated";
}

export function createOwnedRunOperations(args: {
  bb: BbPluginApi;
  db: Db;
  controllers: Map<string, AbortController>;
  publish: (originThreadId: string) => void;
  now?: () => number;
  monotonicNow?: () => number;
}) {
  const { bb, db, controllers, publish } = args;
  const now = args.now ?? Date.now;
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  const adapter = bb.rpc.experimental_client({
    pluginId: "arc",
    contract: ownedAdapterRpcContract,
  });
  const invocations = new Map<string, Promise<boolean>>();
  const advancingInvocations = new Map<
    string,
    {
      runId: string;
      generation: number;
      method: "executeStep" | "observeStep";
      controller: AbortController;
      signal: AbortSignal;
    }
  >();
  const waiters = new Map<string, StepWaiter>();
  const progress = new Map<string, Promise<void>>();
  const activeClocks = new Map<string, { started: number; reserved: number }>();

  function changed(runId: string): void {
    publish(requireOwnedRun(db, runId).input.originThreadId);
  }

  function removeWaiter(key: string): void {
    waiters.get(key)?.cleanup();
    waiters.delete(key);
  }

  function holdDispatch(runId: string): void {
    controllers.get(runId)?.abort();
    for (const invocation of advancingInvocations.values()) {
      if (invocation.runId === runId) invocation.controller.abort();
    }
  }

  async function invoke(
    attempt: OwnedAttemptRecord,
    method: "executeStep" | "observeStep" | "interruptStep",
    signal?: AbortSignal,
  ): Promise<boolean> {
    const existing = invocations.get(attempt.row.effect_id);
    if (existing !== undefined) return existing;
    const run = requireOwnedRun(db, attempt.row.run_id);
    if (
      method === "executeStep" &&
      (run.row.desired_control !== "run" || run.row.state !== "running")
    )
      return false;
    if (
      method === "observeStep" &&
      run.row.desired_control === "run" &&
      run.row.state !== "running" &&
      ownedTerminalObservation(attempt) !== null
    )
      return false;
    const generation = run.row.dispatch_generation;
    const invocationController = new AbortController();
    const advancing =
      run.row.desired_control === "run" && method !== "interruptStep";
    let validationRequest: OwnedValidationRequest | null = null;
    const operation = (async () => {
      try {
        const signals = [
          invocationController.signal,
          AbortSignal.timeout(10_000),
        ];
        if (signal !== undefined) signals.push(signal);
        const runSignal = advancing
          ? controllers.get(run.row.id)?.signal
          : undefined;
        if (runSignal !== undefined) signals.push(runSignal);
        const callSignal = AbortSignal.any(signals);
        if (advancing)
          advancingInvocations.set(attempt.row.effect_id, {
            runId: run.row.id,
            generation,
            method,
            controller: invocationController,
            signal: callSignal,
          });
        const request = { ...attempt.request, dispatchGeneration: generation };
        const retained = requireOwnedAttempt(db, attempt.row.effect_id);
        const validity = ownedTerminalObservation(retained)?.validity;
        const validation =
          validity !== undefined && "validationId" in validity
            ? {
                validationId: validity.validationId,
                state: validity.state,
                activity:
                  validity.state === "checking" ? validity.activity : null,
                generation: retained.row.validation_generation,
              }
            : null;
        const lookup = ownedStepObservationLookupInputSchema.parse({
          ...("schemaVersion" in request
            ? { schemaVersion: request.schemaVersion }
            : {}),
          workflowRunId: request.workflowRunId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          iteration: request.iteration,
          attempt: request.attempt,
          effectId: request.effectId,
          requestHash: request.requestHash,
          dispatchGeneration: generation,
          ...(validation === null ? {} : { validation }),
        });
        callSignal.throwIfAborted();
        if (method === "observeStep" && advancing && validity !== undefined)
          validationRequest = reserveOwnedValidationRequest(
            db,
            attempt.row.effect_id,
            generation,
          );
        else if (
          method === "interruptStep" &&
          retained.row.validation_request_id !== null &&
          retained.row.validation_request_generation !== null
        )
          validationRequest = {
            id: retained.row.validation_request_id,
            generation: retained.row.validation_request_generation,
          };
        const observation =
          method === "executeStep"
            ? await adapter.call(method, request, { signal: callSignal })
            : await adapter.call(method, lookup, { signal: callSignal });
        const accepted = recordOwnedObservation(
          db,
          attempt.row.effect_id,
          generation,
          observation,
          now(),
          validationRequest,
        );
        const current = requireOwnedRun(db, run.row.id);
        if (current.row.desired_control !== "run") holdDispatch(run.row.id);
        return accepted;
      } catch (error) {
        markOwnedAttemptUncertain(
          db,
          attempt.row.effect_id,
          generation,
          error instanceof Error ? error.message : String(error),
          now(),
          validationRequest,
        );
        if (requireOwnedRun(db, run.row.id).row.desired_control !== "run")
          holdDispatch(run.row.id);
        return false;
      } finally {
        if ("schemaVersion" in run.input) tickClock(run.row.id);
        changed(run.row.id);
      }
    })();
    invocations.set(attempt.row.effect_id, operation);
    try {
      return await operation;
    } finally {
      if (invocations.get(attempt.row.effect_id) === operation)
        invocations.delete(attempt.row.effect_id);
      if (
        advancingInvocations.get(attempt.row.effect_id)?.controller ===
        invocationController
      )
        advancingInvocations.delete(attempt.row.effect_id);
    }
  }

  async function freshReceipt(
    waiter: StepWaiter,
    attempt: OwnedAttemptRecord,
  ): Promise<boolean> {
    let observation = ownedTerminalObservation(attempt);
    if (observation === null) return false;
    const remembered = waiter.freshness.get(attempt.row.effect_id);
    const identity =
      "validationId" in observation.validity
        ? observation.validity.validationId
        : `legacy:${observation.receiptHash}`;
    if (
      observation.validity.state === "checking" &&
      attempt.row.validation_generation === waiter.generation
    ) {
      waiter.freshness.set(attempt.row.effect_id, identity);
      return false;
    }
    if (
      remembered !== undefined &&
      "validationId" in observation.validity &&
      ownedReceiptIsCurrent(attempt, waiter.generation)
    ) {
      waiter.freshness.set(attempt.row.effect_id, identity);
      return true;
    }
    if (!(await invoke(attempt, "observeStep", waiter.signal))) return false;
    const current = requireOwnedAttempt(db, attempt.row.effect_id);
    observation = ownedTerminalObservation(current);
    if (observation === null) return false;
    waiter.freshness.set(
      attempt.row.effect_id,
      "validationId" in observation.validity
        ? observation.validity.validationId
        : `legacy:${observation.receiptHash}`,
    );
    return ownedReceiptIsCurrent(current, waiter.generation);
  }

  async function progressWaiter(
    key: string,
    waiter: StepWaiter,
  ): Promise<void> {
    if (progress.has(key)) return progress.get(key);
    const operation = (async () => {
      try {
        tickClock(waiter.runId);
        if (waiter.signal.aborted) throw new Error("Workflow dispatch is held");
        const run = requireOwnedRun(db, waiter.runId);
        if (
          run.row.dispatch_generation !== waiter.generation ||
          run.row.desired_control !== "run"
        )
          throw new Error("Workflow dispatch is held");
        if (run.row.state !== "running") return;
        const definition = run.input.steps.find(
          (step) => ownedStepRefKey(step) === ownedStepRefKey(waiter.ref),
        );
        if (definition === undefined)
          throw new Error("Step was not admitted by the immutable manifest");
        let references: OwnedStepRef[];
        if (waiter.terminalOnly) references = [];
        else if ("dependencies" in definition)
          references = definition.dependencies;
        else {
          const resolution = resolveOwnedRequirements(definition, (ref) => {
            const attempt = selectedOwnedAttempt(db, waiter.runId, ref);
            const observation =
              attempt === null ? null : ownedTerminalObservation(attempt);
            return observation?.resource?.kind === "owner-control" &&
              observation.state !== "interrupted"
              ? ownedControlReceiptSchema.parse(observation.receipt)
              : null;
          });
          if (resolution.state === "pending") return;
          if (resolution.state === "unselected")
            throw new Error(
              `Step ${definition.nodeId} was not selected by ${resolution.decision.nodeId}`,
            );
          references = resolution.receipts.map((receipt) => receipt.step);
        }
        for (const ref of references) {
          const attempt = selectedOwnedAttempt(db, waiter.runId, ref);
          if (
            attempt !== null &&
            ownedTerminalObservation(attempt) !== null &&
            !(await freshReceipt(waiter, attempt))
          )
            return;
        }
        const dependencies = waiter.terminalOnly
          ? []
          : "dependencies" in definition
            ? definition.dependencies
            : ownedStepDependencyReceipts(db, waiter.runId, definition).map(
                (receipt) => ({
                  nodeId: receipt.nodeId,
                  iteration: receipt.iteration,
                  requiredOutcome: receipt.outcome,
                }),
              );
        for (const dependency of dependencies) {
          const selected = selectedOwnedAttempt(db, waiter.runId, dependency);
          if (selected === null) return;
          const terminal = ownedTerminalObservation(selected);
          if (terminal === null) return;
          const fresh = ownedTerminalObservation(
            requireOwnedAttempt(db, selected.row.effect_id),
          );
          if (
            fresh === null ||
            !ownedReceiptIsCurrent(
              requireOwnedAttempt(db, selected.row.effect_id),
              waiter.generation,
            )
          )
            return;
          if (fresh.state !== dependency.requiredOutcome)
            throw new Error(
              `Required ${dependency.requiredOutcome} dependency ${dependency.nodeId} did not match`,
            );
        }
        const before = selectedOwnedAttempt(db, waiter.runId, waiter.ref);
        let attempt = waiter.terminalOnly
          ? before
          : admitOwnedStep(
              db,
              waiter.runId,
              waiter.ref,
              waiter.input,
              waiter.generation,
              now(),
            );
        if (attempt === null) {
          if (waiter.terminalOnly)
            throw new Error(
              "Final verification cannot allocate a missing effect",
            );
          return;
        }
        if (waiter.terminalOnly && ownedTerminalObservation(attempt) === null)
          return;
        if (before?.row.effect_id !== attempt.row.effect_id) {
          if (!(await invoke(attempt, "executeStep", waiter.signal))) return;
        } else if (attempt.row.state === "not-started") {
          if (
            !redispatchOwnedAttempt(
              db,
              attempt.row.effect_id,
              waiter.generation,
            )
          )
            return;
          if (
            !(await invoke(
              requireOwnedAttempt(db, attempt.row.effect_id),
              "executeStep",
              waiter.signal,
            ))
          )
            return;
        } else if (
          ownedTerminalObservation(attempt) !== null &&
          !(await freshReceipt(waiter, attempt))
        )
          return;
        attempt = requireOwnedAttempt(db, attempt.row.effect_id);
        const terminal = ownedTerminalObservation(attempt);
        if (terminal === null) return;
        if (terminal.validity.state === "checking") {
          waiter.freshness.set(
            attempt.row.effect_id,
            terminal.validity.validationId,
          );
          return;
        }
        if (!ownedReceiptIsCurrent(attempt, waiter.generation)) return;
        if (
          terminal.state !== "succeeded" &&
          waiter.terminalOnly !== "validated"
        )
          throw new OwnedStepExecutionError(attempt);
        waiter.resolve(terminal.receipt);
        removeWaiter(key);
      } catch (error) {
        if (error instanceof OwnedAdmissionBlocked && !waiter.signal.aborted)
          return;
        waiter.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        removeWaiter(key);
      }
    })();
    progress.set(key, operation);
    try {
      await operation;
    } finally {
      if (progress.get(key) === operation) progress.delete(key);
    }
  }

  function step(
    run: OwnedRunRecord,
    ref: OwnedStepRef,
    input: JsonValue,
    signal: AbortSignal,
    terminalOnly: StepWaiter["terminalOnly"] = false,
  ): Promise<JsonValue> {
    const key = `${run.row.id}:${ownedStepRefKey(ref)}`;
    const existing = waiters.get(key);
    if (existing !== undefined) {
      if (hashOwnedValue(existing.input) !== hashOwnedValue(input))
        return Promise.reject(
          new Error("Step identity was reused with different input"),
        );
      return existing.promise;
    }
    if (signal.aborted)
      return Promise.reject(new Error("Workflow dispatch is held"));
    let resolve = (_value: JsonValue): void => {};
    let reject = (_error: Error): void => {};
    const promise = new Promise<JsonValue>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const abort = () => {
      reject(new Error("Workflow dispatch is held"));
      removeWaiter(key);
    };
    const waiter: StepWaiter = {
      runId: run.row.id,
      ref,
      input,
      generation: run.row.dispatch_generation,
      signal,
      promise,
      resolve,
      reject,
      cleanup: () => signal.removeEventListener("abort", abort),
      freshness: new Map(),
      terminalOnly,
    };
    waiters.set(key, waiter);
    signal.addEventListener("abort", abort, { once: true });
    void progressWaiter(key, waiter);
    return promise;
  }

  function tickClock(runId: string): void {
    const run = requireOwnedRun(db, runId);
    const clock = activeClocks.get(runId);
    const elapsed =
      clock === undefined ? 0 : Math.max(0, monotonicNow() - clock.started);
    const pendingSteps = [...waiters.values()]
      .filter((waiter) => waiter.runId === runId)
      .map((waiter) => waiter.ref);
    const working =
      (run.row.state === "running" ||
        hasRunningOwnedValidation(db, runId) ||
        activeOwnedAttempts(db, runId).some(
          (attempt) => attempt.row.state !== "waiting",
        )) &&
      !ownedRunClockExcluded(db, runId, pendingSteps);
    if (clock !== undefined && (elapsed >= clock.reserved || !working)) {
      settleOwnedActiveInterval(db, runId, elapsed, now());
      activeClocks.delete(runId);
    }
    if (!working || activeClocks.has(runId)) return;
    try {
      const reserved = reserveOwnedActiveInterval(
        db,
        runId,
        run.row.dispatch_generation,
        now(),
        pendingSteps,
      );
      if (reserved > 0)
        activeClocks.set(runId, { started: monotonicNow(), reserved });
    } catch (error) {
      if (!(error instanceof OwnedBudgetExhausted)) throw error;
      if (run.row.desired_control === "run") {
        failOwnedRun(
          db,
          runId,
          run.row.dispatch_generation,
          error.message,
          now(),
        );
        holdDispatch(runId);
      }
    }
  }

  async function execute(
    run: OwnedRunRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const generation = run.row.dispatch_generation;
    const capabilities: WorkflowCapabilities = {
      agent: async () => {
        throw new Error("Owned workflows must use admitted step() calls");
      },
      step: (nodeId, iteration, input, callSignal) =>
        step(run, { nodeId, iteration }, input, callSignal),
      budget() {
        const view = viewOwnedRun(db, run.row.id);
        return {
          agentCalls: view.agentCalls,
          activeAgents: view.activeAgents,
          queuedAgents: [...waiters.values()].filter((waiter) => {
            if (waiter.runId !== run.row.id) return false;
            if (!("schemaVersion" in run.input)) return true;
            const definition = run.input.steps.find(
              (step) => ownedStepRefKey(step) === ownedStepRefKey(waiter.ref),
            );
            if (definition?.kind !== "agent") return false;
            const attempt = selectedOwnedAttempt(db, run.row.id, waiter.ref);
            return (
              attempt === null ||
              attempt.row.state === "not-started" ||
              attempt.row.state === "interrupted"
            );
          }).length,
          maxAgentCalls: view.limits.maxAgentCalls,
          maxConcurrentAgents: view.limits.maxConcurrentAgents,
          totalTokens: null,
        };
      },
      log: (text) => bb.log.info(`[${run.row.id}] ${text}`),
      phase: () => changed(run.row.id),
    };
    try {
      tickClock(run.row.id);
      const result = await executeWorkflowScript({
        args: run.input.args,
        body: parseWorkflowSource(run.input.source).body,
        capabilities,
        signal,
        limits: {
          maxAgentCalls: run.input.limits.maxAgentCalls,
          maxConcurrentAgents: run.input.limits.maxConcurrentAgents,
        },
      });
      for (const attempt of unverifiedOwnedValidationAttempts(db, run.row.id)) {
        await step(
          run,
          attempt.request,
          attempt.request.input,
          signal,
          "validated",
        );
      }
      for (const attempt of requiredOwnedGateAttempts(db, run.row.id, false)) {
        await step(
          run,
          attempt.request,
          attempt.request.input,
          signal,
          "successful",
        );
      }
      finishOwnedRun(db, run.row.id, generation, result, now());
    } catch (error) {
      const current = requireOwnedRun(db, run.row.id);
      if (
        !signal.aborted &&
        current.row.dispatch_generation === generation &&
        current.row.desired_control === "run"
      ) {
        failOwnedRun(
          db,
          run.row.id,
          generation,
          error instanceof Error ? error.message : String(error),
          now(),
        );
        holdDispatch(run.row.id);
      }
    } finally {
      for (const [key, waiter] of waiters) {
        if (waiter.runId !== run.row.id) continue;
        waiter.reject(new Error("Workflow execution ended"));
        removeWaiter(key);
      }
      controllers.delete(run.row.id);
      tickClock(run.row.id);
      changed(run.row.id);
    }
  }

  async function maintain(signal: AbortSignal): Promise<void> {
    for (const runId of new Set([
      ...pendingOwnedRunIds(db),
      ...activeClocks.keys(),
    ]))
      tickClock(runId);
    const attempts = new Map(
      [
        ...activeOwnedAttempts(db),
        ...staleOwnedAttempts(db),
        ...checkingOwnedAttempts(db),
        ...outdatedOwnedValidationAttempts(db),
        ...pendingOwnedValidationRequests(db),
      ].map((attempt) => [attempt.row.effect_id, attempt]),
    );
    await Promise.all(
      [...attempts.values()].map((attempt) => {
        const run = requireOwnedRun(db, attempt.row.run_id);
        const terminal = ownedTerminalObservation(attempt);
        if (
          terminal?.validity.state === "stale" &&
          "validationId" in terminal.validity &&
          run.row.desired_control !== "run" &&
          attempt.row.validation_request_id === null
        )
          return false;
        if (
          terminal?.validity.state === "checking" &&
          run.row.desired_control !== "run" &&
          terminal.validity.activity === "quiescent" &&
          attempt.row.validation_request_id === null
        )
          return false;
        const method =
          run.row.desired_control === "run" ||
          (attempt.row.terminal_state !== null &&
            terminal?.validity.state !== "checking" &&
            attempt.row.validation_request_id === null)
            ? "observeStep"
            : "interruptStep";
        return invoke(attempt, method, signal);
      }),
    );
    for (const runId of pendingOwnedRunIds(db)) {
      const run = requireOwnedRun(db, runId);
      const liveDispatches = new Set(
        [...advancingInvocations]
          .filter(
            ([, invocation]) =>
              invocation.runId === runId &&
              invocation.generation === run.row.dispatch_generation &&
              invocation.method === "executeStep" &&
              !invocation.signal.aborted,
          )
          .map(([effectId]) => effectId),
      );
      reconcileOwnedRunState(
        db,
        runId,
        controllers.has(runId),
        now(),
        liveDispatches,
      );
    }
    await Promise.all(
      [...waiters].map(([key, waiter]) => progressWaiter(key, waiter)),
    );
    for (const runId of pendingOwnedRunIds(db)) tickClock(runId);
    for (const runId of finalizeOwnedContinuations(db, now())) changed(runId);
  }

  return {
    execute,
    maintain,
    recover() {
      activeClocks.clear();
      recoverOwnedRuns(db, now());
    },
    start(owner: string, input: OwnedRunStartInput) {
      if (owner !== "arc")
        throw new Error("This workflow owner is not admitted");
      parseWorkflowSource(input.source);
      const view = createOwnedRun(db, owner, input, now());
      changed(view.workflowRunId);
      return view;
    },
    inspect(owner: string, runId: string) {
      requireOwnedOwner(db, runId, owner);
      return viewOwnedRun(db, runId);
    },
    inspectRuleContext(owner: string, runId: string) {
      return inspectOwnedRuleContext(db, owner, runId);
    },
    async control(owner: string, input: OwnedRunControl) {
      const view = controlOwnedRun(db, owner, input, now());
      const current = requireOwnedRun(db, input.workflowRunId);
      if (
        current.row.dispatch_generation === view.dispatchGeneration &&
        current.row.desired_control !== "run"
      ) {
        holdDispatch(input.workflowRunId);
      }
      changed(input.workflowRunId);
      return view;
    },
    reserveContinuation(owner: string, input: OwnedContinuationReserve) {
      const view = reserveOwnedContinuation(db, owner, input, now());
      if (view.predecessor.desiredControl !== "run") {
        holdDispatch(input.predecessorWorkflowRunId);
        tickClock(input.predecessorWorkflowRunId);
      }
      changed(input.predecessorWorkflowRunId);
      const current = inspectOwnedContinuation(db, owner, {
        predecessorWorkflowRunId: input.predecessorWorkflowRunId,
        operationId: input.operationId,
      });
      if (current === null)
        throw new Error("Continuation reservation disappeared");
      return current;
    },
    inspectContinuation(owner: string, input: OwnedContinuationKey) {
      return inspectOwnedContinuation(db, owner, input);
    },
    startContinuation(owner: string, input: OwnedContinuationStart) {
      parseWorkflowSource(input.successor.source);
      const view = startOwnedContinuation(db, owner, input, now());
      holdDispatch(input.predecessorWorkflowRunId);
      changed(input.predecessorWorkflowRunId);
      return view;
    },
    startRuleContinuation(owner: string, input: OwnedRuleContinuationStart) {
      parseWorkflowSource(input.successor.source);
      const view = startOwnedRuleContinuation(db, owner, input, now());
      holdDispatch(input.predecessorWorkflowRunId);
      changed(input.predecessorWorkflowRunId);
      return view;
    },
    startAddressedContinuation(
      owner: string,
      input: OwnedAddressedContinuationStart,
    ) {
      parseWorkflowSource(input.successor.source);
      const view = startOwnedAddressedContinuation(db, owner, input, now());
      holdDispatch(input.predecessorWorkflowRunId);
      changed(input.predecessorWorkflowRunId);
      return view;
    },
    cancelContinuation(owner: string, input: OwnedContinuationKey) {
      const view = cancelOwnedContinuation(db, owner, input, now());
      if (view.predecessor.desiredControl !== "run")
        holdDispatch(input.predecessorWorkflowRunId);
      changed(input.predecessorWorkflowRunId);
      return view;
    },
    async drain() {
      await Promise.allSettled(invocations.values());
      await Promise.allSettled(progress.values());
    },
  };
}

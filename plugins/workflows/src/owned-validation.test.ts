import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations } from "./data.js";
import {
  canonicalOwnedJson,
  ownedAdapterRpcContract,
  ownedRunStartInputSchema,
  ownedStepObservationInputSchema,
  ownedStepObservationSchema,
  ownedStepObservationV2Schema,
  type OwnedRunStartInput,
  type OwnedStepObservationInput,
  type OwnedStepObservationLookupInput,
  type OwnedStepRequestInput,
  type OwnedValidationReceiptValidity,
} from "./owned-contract.js";
import {
  activeOwnedAttempts,
  admitOwnedStep,
  checkingOwnedAttempts,
  claimOwnedRun,
  controlOwnedRun,
  countActiveWorkflowRuns,
  createOwnedRun,
  finishOwnedRun,
  hashOwnedValue,
  markOwnedAttemptUncertain,
  ownedReceiptIsCurrent,
  ownedRunClockExcluded,
  ownedTerminalObservation,
  recordOwnedObservation,
  recoverOwnedRuns,
  reconcileOwnedRunState,
  requireOwnedAttempt,
  requireOwnedRun,
  requiredOwnedGateAttempts,
  reserveOwnedActiveInterval,
  reserveOwnedValidationRequest,
  settleOwnedActiveInterval,
  viewOwnedRun,
  type OwnedAttemptRecord,
} from "./owned-data.js";
import { createOwnedRunOperations } from "./owned-execution.js";
import { ownedRunInput, terminalReceipt } from "./owned-test-fixtures.js";
import {
  decisionStep,
  v2Input,
  v2Step,
  waitingControl,
} from "./owned-v2-test-fixtures.js";

type Terminal = Extract<
  OwnedStepObservationInput,
  { state: "succeeded" | "failed" | "interrupted" }
>;

function terminal(
  request: OwnedStepRequestInput,
  kind: "agent" | "host-effect" = "host-effect",
): Terminal {
  const result = terminalReceipt(
    request,
    "succeeded",
    { candidate: "snapshot-1", effectId: request.effectId },
    kind,
  );
  if (!("receiptHash" in result))
    throw new Error("Fixture has no terminal receipt");
  return result;
}

function withValidity(
  receipt: Terminal,
  validity: OwnedValidationReceiptValidity,
): Terminal {
  const observation = ownedStepObservationInputSchema.parse({
    ...receipt,
    validity,
  });
  if (!("receiptHash" in observation))
    throw new Error("Fixture has no terminal receipt");
  return observation;
}

function checking(
  receipt: Terminal,
  validationId = "scan-a",
  activity: "running" | "quiescent" = "running",
): Terminal {
  return withValidity(receipt, {
    state: "checking",
    validationId,
    activity,
    reason: "Comparing the complete retained directory manifest",
  });
}

function current(receipt: Terminal, validationId = "scan-a"): Terminal {
  return withValidity(receipt, {
    state: "current",
    validationId,
    identityHash: hashOwnedValue("snapshot-1"),
  });
}

describe("owned receipt validation in the migrated SQLite ledger", () => {
  let db: Database.Database;
  const disposals: Array<() => Promise<void>> = [];
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });
  afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    db.close();
  });

  function start(input: OwnedRunStartInput = v2Input()) {
    const view = createOwnedRun(db, "arc", input, 100);
    const run = claimOwnedRun(db, 4, 110);
    if (run === null || run.row.id !== view.workflowRunId)
      throw new Error("Run was not claimed");
    return run;
  }
  function admit(runId: string, nodeId = "check") {
    const attempt = admitOwnedStep(
      db,
      runId,
      { nodeId, iteration: 0 },
      null,
      requireOwnedRun(db, runId).row.dispatch_generation,
      120,
    );
    if (attempt === null) throw new Error("Step was not admitted");
    return attempt;
  }
  function record(
    attempt: OwnedAttemptRecord,
    observation: unknown,
    generation = requireOwnedRun(db, attempt.row.run_id).row
      .dispatch_generation,
  ) {
    return recordOwnedObservation(
      db,
      attempt.row.effect_id,
      generation,
      ownedStepObservationInputSchema.parse(observation),
      130,
    );
  }
  function control(runId: string, action: "pause" | "resume" | "cancel") {
    const view = viewOwnedRun(db, runId);
    return controlOwnedRun(
      db,
      "arc",
      {
        workflowRunId: runId,
        operationId: `${action}-${view.controlVersion}`,
        expectedVersion: view.controlVersion,
        action,
      },
      200,
    );
  }

  it.each([ownedRunInput(), v2Input()])(
    "keeps the legacy manifest, request and receipt bytes unchanged for schema $schemaVersion",
    (input) => {
      const serialized = canonicalOwnedJson(input);
      expect(canonicalOwnedJson(ownedRunStartInputSchema.parse(input))).toBe(
        serialized,
      );
      const run = start(input);
      expect(run.row.request_json).toBe(serialized);
      const attempt = admit(run.row.id);
      const original = terminal(attempt.request);
      const oldSchema =
        "schemaVersion" in input
          ? ownedStepObservationV2Schema
          : ownedStepObservationSchema;
      expect(canonicalOwnedJson(oldSchema.parse(original))).toBe(
        canonicalOwnedJson(original),
      );
      expect(
        canonicalOwnedJson(ownedStepObservationInputSchema.parse(original)),
      ).toBe(canonicalOwnedJson(original));
      expect(oldSchema.safeParse(checking(original)).success).toBe(false);
      const requestBytes = attempt.row.request_json;
      record(attempt, original);
      record(attempt, checking(original));
      expect(
        requireOwnedAttempt(db, attempt.row.effect_id).row.request_json,
      ).toBe(requestBytes);
      expect(requireOwnedRun(db, run.row.id).row.request_json).toBe(serialized);
    },
  );

  it("retains exact native terminal evidence while blocking dependent admission and final completion", () => {
    const run = start(
      v2Input({
        steps: [
          v2Step("writer", { kind: "agent" }),
          v2Step("check", {
            requirements: [
              {
                kind: "receipt",
                step: { nodeId: "writer", iteration: 0 },
                outcomes: ["succeeded"],
              },
            ],
          }),
        ],
      }),
    );
    const writer = admit(run.row.id, "writer");
    const original = terminal(writer.request, "agent");
    record(writer, original);
    record(writer, checking(original));
    expect(activeOwnedAttempts(db, run.row.id)).toHaveLength(0);
    expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(1);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      activeAgents: 0,
      agentCalls: 1,
      state: "running",
    });
    expect(() => admit(run.row.id)).toThrow("receipt is unavailable");
    expect(() => finishOwnedRun(db, run.row.id, 0, null)).toThrow(
      "Required gate",
    );
    expect(record(writer, current(original, "wrong-scan"))).toBe(false);
    expect(record(writer, original)).toBe(false);
    const retained = ownedTerminalObservation(
      requireOwnedAttempt(db, writer.row.effect_id),
    );
    expect(retained).toMatchObject({
      state: original.state,
      resource: original.resource,
      receipt: original.receipt,
      receiptHash: original.receiptHash,
      validity: { state: "checking", validationId: "scan-a" },
    });
    expect(record(writer, current(original))).toBe(true);
    expect(record(writer, current(original))).toBe(true);
    const check = admit(run.row.id);
    expect(check.request.dependencyReceipts).toEqual([
      {
        nodeId: "writer",
        iteration: 0,
        effectId: writer.row.effect_id,
        outcome: "succeeded",
        receiptHash: original.receiptHash,
      },
    ]);
    record(check, terminal(check.request));
    expect(finishOwnedRun(db, run.row.id, 0, null)).toBe(true);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
  });

  it("requires a retained checking identity and rejects replacement resources, receipts and outcomes", () => {
    const run = start();
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    expect(record(attempt, current(original))).toBe(false);
    record(attempt, checking(original));
    expect(() =>
      record(attempt, {
        ...current(original),
        resource: {
          kind: "host-effect",
          hostId: "other-host",
          effectId: attempt.row.effect_id,
        },
      }),
    ).toThrow("bound native resource");
    expect(() =>
      record(attempt, {
        ...current(original),
        receipt: { replaced: true },
        receiptHash: hashOwnedValue({ replaced: true }),
      }),
    ).toThrow("immutable terminal");
    expect(() =>
      record(attempt, { ...current(original), state: "failed" }),
    ).toThrow("immutable terminal");
    expect(() => requiredOwnedGateAttempts(db, run.row.id)).toThrow(
      "Required gate",
    );
    expect(record(attempt, current(original))).toBe(true);
    expect(record(attempt, checking(original, "scan-b"))).toBe(true);
    expect(record(attempt, current(original, "scan-a"))).toBe(false);
    expect(record(attempt, checking(original, "scan-a"))).toBe(false);
    expect(record(attempt, current(original, "scan-b"))).toBe(true);
    expect(record(attempt, checking(original, "scan-b"))).toBe(false);
    expect(
      ownedReceiptIsCurrent(requireOwnedAttempt(db, attempt.row.effect_id), 0),
    ).toBe(true);
  });

  it.each(["pause", "cancel"] as const)(
    "waits for an exact scan interruption during %s without consuming another agent call",
    (action) => {
      const run = start(
        v2Input({ steps: [v2Step("check", { kind: "agent" })] }),
      );
      const attempt = admit(run.row.id);
      const original = terminal(attempt.request, "agent");
      record(attempt, checking(original));
      const held = control(run.row.id, action);
      expect(held.state).toBe(action === "pause" ? "pausing" : "cancelling");
      expect(countActiveWorkflowRuns(db)).toBe(1);
      expect(record(attempt, current(original), 0)).toBe(false);
      expect(record(attempt, current(original), held.dispatchGeneration)).toBe(
        false,
      );
      expect(
        record(attempt, checking(original, "different", "quiescent")),
      ).toBe(false);
      expect(
        reserveOwnedActiveInterval(
          db,
          run.row.id,
          held.dispatchGeneration,
          220,
        ),
      ).toBe(1000);
      record(attempt, checking(original, "scan-a", "quiescent"));
      reconcileOwnedRunState(db, run.row.id, false, 300);
      settleOwnedActiveInterval(db, run.row.id, 80, 300);
      expect(viewOwnedRun(db, run.row.id)).toMatchObject({
        state: action === "pause" ? "paused" : "cancelled",
        activeAgents: 0,
        agentCalls: 1,
        chargedActiveMs: 80,
      });
      expect(countActiveWorkflowRuns(db)).toBe(0);
      expect(
        ownedTerminalObservation(
          requireOwnedAttempt(db, attempt.row.effect_id),
        ),
      ).toMatchObject({
        receiptHash: original.receiptHash,
        resource: original.resource,
      });
      if (action === "cancel") return;
      const resumed = control(run.row.id, "resume");
      expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
      expect(record(attempt, current(original))).toBe(false);
      expect(record(attempt, checking(original))).toBe(false);
      expect(record(attempt, checking(original, "scan-b"))).toBe(true);
      expect(record(attempt, current(original))).toBe(false);
      expect(record(attempt, current(original, "scan-b"))).toBe(true);
      expect(
        finishOwnedRun(db, run.row.id, resumed.dispatchGeneration, null),
      ).toBe(true);
      expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
    },
  );

  it("charges pending validation even beside a user wait and after a confirmed interrupted scan", () => {
    const run = start(v2Input({ steps: [v2Step("check"), decisionStep()] }));
    const attempt = admit(run.row.id);
    const choice = admit(run.row.id, "choice");
    const original = terminal(attempt.request);
    record(attempt, original);
    record(choice, waitingControl(choice.request));
    expect(ownedRunClockExcluded(db, run.row.id)).toBe(true);
    expect(() =>
      record(attempt, checking(original, "scan-a", "quiescent")),
    ).toThrow("quiesce only");
    expect(record(attempt, checking(original))).toBe(true);
    expect(ownedRunClockExcluded(db, run.row.id)).toBe(false);
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 150)).toBe(1000);
    settleOwnedActiveInterval(db, run.row.id, 40, 190);
    expect(record(attempt, checking(original, "scan-a", "quiescent"))).toBe(
      true,
    );
    expect(record(attempt, current(original))).toBe(false);
    expect(ownedRunClockExcluded(db, run.row.id)).toBe(false);
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 200)).toBe(1000);
    expect(record(attempt, checking(original))).toBe(false);
    expect(record(attempt, checking(original, "scan-b"))).toBe(true);
  });

  it("recovers retained scans and rejects pre-restart proofs without changing request identity or budgets", () => {
    const run = start();
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    record(attempt, checking(original));
    reserveOwnedActiveInterval(db, run.row.id, 0, 150);
    recoverOwnedRuns(db, 300);
    const recovered = requireOwnedRun(db, run.row.id);
    expect(recovered.row.dispatch_generation).toBe(1);
    expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(1);
    expect(countActiveWorkflowRuns(db)).toBe(1);
    expect(claimOwnedRun(db, 1)?.row.id).toBe(run.row.id);
    expect(record(attempt, current(original), 0)).toBe(false);
    expect(record(attempt, current(original), 1)).toBe(false);
    expect(record(attempt, checking(original, "scan-b"), 1)).toBe(true);
    expect(record(attempt, current(original, "scan-b"), 1)).toBe(true);
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.request_json,
    ).toBe(attempt.row.request_json);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      chargedActiveMs: 1000,
      activeAgents: 0,
      agentCalls: 0,
    });
    expect(finishOwnedRun(db, run.row.id, 1, null)).toBe(true);
  });

  it("retains checking after callback failure instead of poisoning an immutable terminal receipt", () => {
    const run = start();
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    record(attempt, checking(original));
    markOwnedAttemptUncertain(
      db,
      attempt.row.effect_id,
      0,
      "The observation RPC timed out",
      200,
    );
    expect(
      ownedTerminalObservation(requireOwnedAttempt(db, attempt.row.effect_id)),
    ).toMatchObject({
      receipt: original.receipt,
      receiptHash: original.receiptHash,
      validity: {
        state: "checking",
        validationId: "scan-a",
        activity: "running",
        reason: "The observation RPC timed out",
      },
    });
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "running",
      desiredControl: "run",
      dispatchGeneration: 0,
    });
    expect(record(attempt, current(original))).toBe(true);
  });

  it("admits explicit stale-proof rechecks without dispatching independent nodes or accepting a late previous pass", () => {
    const run = start(
      v2Input({
        steps: [v2Step("check"), v2Step("independent", { kind: "agent" })],
      }),
    );
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    record(attempt, checking(original));
    record(
      attempt,
      withValidity(original, {
        state: "stale",
        validationId: "scan-a",
        reason: "Directory changed",
      }),
    );
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "needs-reconciliation",
      desiredControl: "pause",
      agentCalls: 0,
    });
    expect(record(attempt, checking(original, "scan-b"))).toBe(false);
    const resumed = control(run.row.id, "resume");
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(() => admit(run.row.id, "independent")).toThrow(
      "validation must be current",
    );
    expect(record(attempt, checking(original, "scan-b"))).toBe(true);
    expect(() => admit(run.row.id, "independent")).toThrow(
      "validation must be current",
    );
    expect(record(attempt, current(original))).toBe(false);
    expect(
      record(
        attempt,
        withValidity(original, {
          state: "stale",
          validationId: "scan-b",
          reason: "Directory still changed",
        }),
      ),
    ).toBe(true);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "needs-reconciliation",
      desiredControl: "pause",
      agentCalls: 0,
      dispatchGeneration: resumed.dispatchGeneration + 1,
    });
    control(run.row.id, "resume");
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(record(attempt, checking(original, "scan-c"))).toBe(true);
    expect(record(attempt, current(original, "scan-b"))).toBe(false);
    expect(record(attempt, current(original, "scan-c"))).toBe(true);
    const worker = admit(run.row.id, "independent");
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
    record(worker, terminal(worker.request, "agent"));
    expect(requireOwnedAttempt(db, attempt.row.effect_id).row.attempt).toBe(1);
  });

  it.each([false, true])(
    "rejects stale-proof resume when an unresolved native effect or untagged proof remains: $0",
    (legacy) => {
      const run = start(
        v2Input({
          steps: [v2Step("check"), v2Step("worker", { kind: "agent" })],
        }),
      );
      const attempt = admit(run.row.id);
      if (!legacy) admit(run.row.id, "worker");
      const original = terminal(attempt.request);
      if (!legacy) record(attempt, checking(original));
      record(
        attempt,
        legacy
          ? {
              ...original,
              validity: { state: "stale", reason: "Legacy stale source" },
            }
          : withValidity(original, {
              state: "stale",
              validationId: "scan-a",
              reason: "Changed manifest",
            }),
      );
      expect(() => control(run.row.id, "resume")).toThrow(
        "Reconcile and pause",
      );
    },
  );

  it("can acknowledge an interrupted scan after its first checking response was lost during terminal revalidation", () => {
    const run = start();
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    record(attempt, original);
    markOwnedAttemptUncertain(
      db,
      attempt.row.effect_id,
      0,
      "First scan response lost",
      200,
    );
    expect(viewOwnedRun(db, run.row.id).desiredControl).toBe("pause");
    expect(record(attempt, checking(original))).toBe(false);
    expect(record(attempt, checking(original, "scan-a", "quiescent"))).toBe(
      true,
    );
    reconcileOwnedRunState(db, run.row.id, false, 220);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "paused",
      activeAgents: 0,
      agentCalls: 0,
    });
    control(run.row.id, "resume");
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(record(attempt, current(original))).toBe(false);
    expect(record(attempt, checking(original, "scan-b"))).toBe(true);
  });

  it.each(["pause", "cancel"] as const)(
    "retains acknowledged scan A during %s when scan B's first reply was lost",
    (action) => {
      const run = start();
      const attempt = admit(run.row.id);
      const original = terminal(attempt.request);
      record(attempt, checking(original));
      record(attempt, current(original));
      const held = control(run.row.id, action);
      expect(record(attempt, checking(original, "scan-b", "quiescent"))).toBe(
        false,
      );
      expect(record(attempt, checking(original, "scan-a", "running"))).toBe(
        false,
      );
      expect(record(attempt, checking(original, "scan-a", "quiescent"))).toBe(
        true,
      );
      reconcileOwnedRunState(db, run.row.id, false);
      expect(
        ownedTerminalObservation(
          requireOwnedAttempt(db, attempt.row.effect_id),
        ),
      ).toMatchObject({
        receiptHash: original.receiptHash,
        resource: original.resource,
        validity: {
          state: "checking",
          validationId: "scan-a",
          activity: "quiescent",
        },
      });
      if (action === "cancel") return;
      const resumed = control(run.row.id, "resume");
      expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
      expect(
        record(attempt, current(original, "scan-b"), held.dispatchGeneration),
      ).toBe(false);
      expect(record(attempt, checking(original, "scan-c"))).toBe(true);
      expect(
        record(
          attempt,
          current(original, "scan-b"),
          resumed.dispatchGeneration,
        ),
      ).toBe(false);
      expect(record(attempt, current(original, "scan-c"))).toBe(true);
      expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(0);
    },
  );

  async function operations(behavior: {
    execute: (
      request: OwnedStepRequestInput,
      signal: AbortSignal,
    ) => Promise<OwnedStepObservationInput>;
    observe: (
      effectId: string,
      signal: AbortSignal,
      lookup: OwnedStepObservationLookupInput,
    ) => Promise<OwnedStepObservationInput>;
    interrupt: (
      effectId: string,
      signal: AbortSignal,
      lookup: OwnedStepObservationLookupInput,
    ) => Promise<OwnedStepObservationInput>;
  }) {
    const arc = createFakePluginHost({ pluginId: "arc" });
    const workflows = createFakePluginHost({
      pluginId: "workflows",
      experimental_internalRpc: (args) =>
        arc.harness.behavior.experimental_callInternalRpc(
          args.method,
          args.input,
          args.context,
        ),
    });
    disposals.push(
      () => arc.harness.dispose(),
      () => workflows.harness.dispose(),
    );
    arc.bb.rpc.experimental_registerInternal(ownedAdapterRpcContract, {
      executeStep: (input, context) => behavior.execute(input, context.signal),
      observeStep: (input, context) =>
        behavior.observe(input.effectId, context.signal, input),
      interruptStep: (input, context) =>
        behavior.interrupt(input.effectId, context.signal, input),
    });
    const controllers = new Map<string, AbortController>();
    return {
      owned: createOwnedRunOperations({
        bb: workflows.bb,
        db,
        controllers,
        publish() {},
      }),
      controllers,
    };
  }

  async function eventually(assertion: () => void | Promise<void>) {
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await assertion();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it.each(["run", "pause", "cancel", "lost-response"] as const)(
    "preserves an in-flight admission across an older maintenance snapshot with %s control",
    async (action) => {
      function gate() {
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { promise, release };
      }
      const observingPrior = gate();
      const releasePrior = gate();
      const executing = gate();
      const releaseExecute = gate();
      const reconciled = gate();
      const run = start(
        v2Input({
          steps: [
            v2Step("prior"),
            v2Step("check", {
              kind: "agent",
              lane: {
                hostId: "host-1",
                repositoryId: "repository-1",
                target: { kind: "environment", id: "writer-environment" },
              },
            }),
          ],
        }),
      );
      const prior = admit(run.row.id, "prior");
      const priorReceipt = terminal(prior.request);
      record(prior, { state: "running", resource: priorReceipt.resource });
      const requests: OwnedStepRequestInput[] = [];
      let nativeAdmissions = 0;
      let receipt: Terminal | null = null;
      const { owned, controllers } = await operations({
        async execute(request, signal) {
          requests.push(request);
          executing.release();
          await releaseExecute.promise;
          signal.throwIfAborted();
          const view = owned.inspect("arc", request.workflowRunId);
          if (
            view.ownerRunId !== request.ownerRunId ||
            view.desiredControl !== "run" ||
            view.dispatchGeneration !== request.dispatchGeneration ||
            view.state !== "running"
          )
            throw new Error(
              "This workflow generation cannot dispatch new work",
            );
          if (action === "lost-response")
            throw new Error("Native admission response was lost");
          nativeAdmissions += 1;
          receipt = terminal(request, "agent");
          return receipt;
        },
        async observe(effectId) {
          if (effectId === prior.row.effect_id) {
            observingPrior.release();
            await releasePrior.promise;
            return priorReceipt;
          }
          if (receipt !== null) return receipt;
          return {
            state: "needs-reconciliation",
            reason: "Native admission outcome is still unknown",
          };
        },
        async interrupt(effectId) {
          if (effectId === prior.row.effect_id) return priorReceipt;
          return { state: "not-started", reason: "No native admission exists" };
        },
      });
      const controller = new AbortController();
      controllers.set(run.row.id, controller);
      const maintenance = owned.maintain(new AbortController().signal);
      await observingPrior.promise;
      const done = owned.execute(run, controller.signal);
      disposals.push(async () => {
        controller.abort();
        releasePrior.release();
        releaseExecute.release();
        await maintenance;
        await done;
        await owned.drain();
      });
      await executing.promise;
      db.function("notify_dispatch_reconciliation", (runId) => {
        if (runId === run.row.id) reconciled.release();
        return null;
      });
      db.exec(`CREATE TEMP TRIGGER observe_dispatch_reconciliation
        AFTER UPDATE OF state ON workflow_owned_runs
        BEGIN SELECT notify_dispatch_reconciliation(NEW.id); END`);
      releasePrior.release();
      await reconciled.promise;
      db.exec("DROP TRIGGER observe_dispatch_reconciliation");
      expect(viewOwnedRun(db, run.row.id)).toMatchObject({
        state: "running",
        desiredControl: "run",
        dispatchGeneration: 0,
        activeAgents: 1,
        agentCalls: 1,
      });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(requireOwnedAttempt(db, request.effectId).row.state).toBe(
        "dispatched",
      );
      expect(nativeAdmissions).toBe(0);
      if (action === "pause" || action === "cancel")
        await owned.control("arc", {
          workflowRunId: run.row.id,
          operationId: `hold-dispatch-${action}`,
          expectedVersion: 0,
          action,
        });
      releaseExecute.release();
      await maintenance;
      if (action === "lost-response") {
        await owned.maintain(new AbortController().signal);
        expect(viewOwnedRun(db, run.row.id)).toMatchObject({
          state: "needs-reconciliation",
          desiredControl: "run",
          activeAgents: 1,
          agentCalls: 1,
        });
        expect(nativeAdmissions).toBe(0);
        expect(requireOwnedAttempt(db, request.effectId).row.state).toBe(
          "needs-reconciliation",
        );
      } else {
        await eventually(async () => {
          await owned.maintain(new AbortController().signal);
          expect(viewOwnedRun(db, run.row.id)).toMatchObject({
            state:
              action === "run"
                ? "succeeded"
                : action === "pause"
                  ? "paused"
                  : "cancelled",
            activeAgents: 0,
            agentCalls: 1,
          });
        });
        await done;
        expect(nativeAdmissions).toBe(action === "run" ? 1 : 0);
      }
      expect(requests).toHaveLength(1);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_attempts WHERE run_id = ? AND kind = 'agent'",
          )
          .get(run.row.id),
      ).toEqual({ count: 1 });
    },
  );

  it("polls asynchronous dependency and final-gate scans through the existing QuickJS executor without rescanning forever", async () => {
    const originals = new Map<string, Terminal>();
    const scans = new Map<
      string,
      { id: string; remaining: number; finished: boolean }
    >();
    const executions: string[] = [];
    let scanCount = 0;
    const { owned, controllers } = await operations({
      async execute(request) {
        executions.push(request.nodeId);
        const value = terminal(
          request,
          request.nodeId === "writer" ? "agent" : "host-effect",
        );
        originals.set(request.effectId, value);
        return value;
      },
      async observe(effectId) {
        const original = originals.get(effectId);
        if (original === undefined) throw new Error("No admitted effect");
        let scan = scans.get(effectId);
        if (scan === undefined || scan.finished) {
          scan = { id: `scan-${++scanCount}`, remaining: 2, finished: false };
          scans.set(effectId, scan);
          return checking(original, scan.id);
        }
        if (scan.remaining-- > 0) return checking(original, scan.id);
        scan.finished = true;
        return current(original, scan.id);
      },
      async interrupt() {
        throw new Error("Successful validation needs no interruption");
      },
    });
    const input = v2Input({
      steps: [
        v2Step("writer", { kind: "agent" }),
        v2Step("check", {
          requirements: [
            {
              kind: "receipt",
              step: { nodeId: "writer", iteration: 0 },
              outcomes: ["succeeded"],
            },
          ],
        }),
      ],
      source: `export const meta = {name: "async-checks", description: "Persisted validation scans"}; await step("writer", 0, null); return await step("check", 0, null);`,
    });
    const run = start(input);
    const controller = new AbortController();
    controllers.set(run.row.id, controller);
    const done = owned.execute(run, controller.signal);
    disposals.push(async () => {
      controller.abort();
      await done;
      await owned.drain();
    });
    await eventually(async () => {
      await owned.maintain(new AbortController().signal);
      const view = viewOwnedRun(db, run.row.id);
      expect(view.state, JSON.stringify(view)).toBe("succeeded");
    });
    await done;
    expect(executions).toEqual(["writer", "check"]);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      agentCalls: 1,
      activeAgents: 0,
      result: { available: true },
    });
    expect(scanCount).toBe(2);
    expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(0);
  });

  it("aborts an in-flight terminal scan observation on pause and quiesces its exact retained job before resume", async () => {
    let original: Terminal | null = null;
    let observationEntered = false;
    let observationAborted = false;
    let interrupts = 0;
    const { owned, controllers } = await operations({
      async execute(request) {
        original = terminal(request);
        return checking(original);
      },
      async observe(_effectId, signal) {
        observationEntered = true;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              observationAborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
        throw new Error("Observation should abort");
      },
      async interrupt() {
        interrupts += 1;
        if (original === null) throw new Error("No native receipt");
        return checking(original, "scan-a", "quiescent");
      },
    });
    const run = start();
    const controller = new AbortController();
    controllers.set(run.row.id, controller);
    const done = owned.execute(run, controller.signal);
    disposals.push(async () => {
      controller.abort();
      await done;
      await owned.drain();
    });
    await eventually(() =>
      expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(1),
    );
    const maintenance = owned.maintain(new AbortController().signal);
    await eventually(() => expect(observationEntered).toBe(true));
    await owned.control("arc", {
      workflowRunId: run.row.id,
      operationId: "pause-scan",
      expectedVersion: 0,
      action: "pause",
    });
    await maintenance;
    await done;
    expect(observationAborted).toBe(true);
    expect(viewOwnedRun(db, run.row.id).state).toBe("pausing");
    await owned.maintain(new AbortController().signal);
    expect(interrupts).toBe(1);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "paused",
      activeAgents: 0,
      agentCalls: 0,
    });
  });

  it.each([false, true])(
    "rechecks only after explicit resume and permits native dispatch only after a fresh pass: %s",
    async (restored) => {
      const input = v2Input({
        steps: [v2Step("check"), v2Step("worker", { kind: "agent" })],
        source: `export const meta = {name: "resume-recheck", description: "No native work before fresh proof"}; await Promise.all([step("check", 0, null), step("worker", 0, null)]); return null;`,
      });
      const initial = start(input);
      const attempt = admit(initial.row.id);
      const original = terminal(attempt.request);
      record(attempt, checking(original));
      record(
        attempt,
        withValidity(original, {
          state: "stale",
          validationId: "scan-a",
          reason: "Manifest changed",
        }),
      );
      let allowResult = false;
      let observations = 0;
      const executed: string[] = [];
      const { owned, controllers } = await operations({
        async execute(request) {
          executed.push(request.nodeId);
          return terminal(request, "agent");
        },
        async observe(_effectId, _signal, lookup) {
          observations += 1;
          if (!("validation" in lookup))
            throw new Error("Expected retained validation acknowledgement");
          if (lookup.validation.validationId === "scan-a")
            return checking(original, "scan-b");
          if (lookup.validation.state === "current")
            return checking(original, "scan-c");
          if (!allowResult)
            return checking(original, lookup.validation.validationId);
          return restored
            ? current(original, lookup.validation.validationId)
            : withValidity(original, {
                state: "stale",
                validationId: lookup.validation.validationId,
                reason: "Manifest still changed",
              });
        },
        async interrupt() {
          throw new Error("Settled proof has no native work to interrupt");
        },
      });
      await owned.maintain(new AbortController().signal);
      expect(observations).toBe(0);
      const held = viewOwnedRun(db, initial.row.id);
      await owned.control("arc", {
        workflowRunId: initial.row.id,
        operationId: "explicit-recheck",
        expectedVersion: held.controlVersion,
        action: "resume",
      });
      const run = claimOwnedRun(db, 4);
      if (run === null) throw new Error("Recheck run was not queued");
      const controller = new AbortController();
      controllers.set(run.row.id, controller);
      const done = owned.execute(run, controller.signal);
      disposals.push(async () => {
        controller.abort();
        await done;
        await owned.drain();
      });
      await eventually(async () => {
        await owned.maintain(new AbortController().signal);
        expect(observations).toBeGreaterThan(0);
      });
      expect(executed).toEqual([]);
      expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(0);
      allowResult = true;
      await eventually(async () => {
        await owned.maintain(new AbortController().signal);
        expect(viewOwnedRun(db, run.row.id).state).toBe(
          restored ? "succeeded" : "needs-reconciliation",
        );
      });
      await done;
      expect(executed).toEqual(restored ? ["worker"] : []);
      expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(restored ? 1 : 0);
      expect(requireOwnedAttempt(db, attempt.row.effect_id).row.attempt).toBe(
        1,
      );
    },
  );

  it("acknowledges lost checking and completion replies and refuses a late scan A after scan B is retained", async () => {
    let original: Terminal | null = null;
    let executions = 0;
    let lostCompletion = false;
    let lostNextChecking = false;
    let lateA = false;
    const acknowledgements: Array<OwnedStepObservationLookupInput> = [];
    const { owned, controllers } = await operations({
      async execute(request) {
        executions += 1;
        original = terminal(request, "agent");
        throw new Error("Checking A reply was lost after native completion");
      },
      async observe(_effectId, _signal, lookup) {
        acknowledgements.push(lookup);
        if (original === null)
          throw new Error("Native receipt was not retained by owner");
        if (!("validation" in lookup)) return checking(original, "scan-a");
        if (lookup.validation.validationId === "scan-a") {
          if (lookup.validation.state === "current") {
            if (!lostNextChecking) {
              lostNextChecking = true;
              throw new Error("Scan B checking reply was lost");
            }
            return checking(original, "scan-b");
          }
          expect(lookup.validation).toEqual({
            validationId: "scan-a",
            state: "checking",
            activity: "running",
            generation: 0,
          });
          if (!lostCompletion) {
            lostCompletion = true;
            throw new Error("Completed scan A response was lost");
          }
          return current(original, "scan-a");
        }
        expect(lookup.validation).toEqual({
          validationId: "scan-b",
          state: "checking",
          activity: "running",
          generation: 0,
        });
        if (!lateA) {
          lateA = true;
          return current(original, "scan-a");
        }
        return current(original, "scan-b");
      },
      async interrupt() {
        throw new Error("Response loss must not invent a native interruption");
      },
    });
    const run = start(v2Input({ steps: [v2Step("check", { kind: "agent" })] }));
    const controller = new AbortController();
    controllers.set(run.row.id, controller);
    const done = owned.execute(run, controller.signal);
    disposals.push(async () => {
      controller.abort();
      await done;
      await owned.drain();
    });
    await eventually(async () => {
      await owned.maintain(new AbortController().signal);
      expect(viewOwnedRun(db, run.row.id).state).toBe("succeeded");
    });
    await done;
    expect(executions).toBe(1);
    expect(lostCompletion).toBe(true);
    expect(lostNextChecking).toBe(true);
    expect(lateA).toBe(true);
    expect(acknowledgements[0]).not.toHaveProperty("validation");
    expect(
      acknowledgements.filter(
        (lookup) =>
          "validation" in lookup && lookup.validation.state === "current",
      ),
    ).toHaveLength(2);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      activeAgents: 0,
      agentCalls: 1,
      dispatchGeneration: 0,
      desiredControl: "run",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_attempts").get(),
    ).toEqual({ count: 1 });
  });

  it("revalidates a retained non-gate proof when the resumed script skips its completed budget branch", async () => {
    const input = v2Input({
      steps: [
        v2Step("optional", { kind: "agent" }),
        v2Step("check", { kind: "agent" }),
      ],
      source: `export const meta = {name: "resume-budget-branch", description: "Preserve completed optional evidence"}; if (budget().agentCalls === 0) await step("optional", 0, null); return await step("check", 0, null);`,
    });
    const initial = start(input);
    const optional = admit(initial.row.id, "optional");
    const original = terminal(optional.request, "agent");
    record(optional, checking(original));
    record(optional, current(original));
    control(initial.row.id, "pause");
    control(initial.row.id, "resume");
    let permitCompletion = false;
    const executions: string[] = [];
    const { owned, controllers } = await operations({
      async execute(request) {
        executions.push(request.nodeId);
        return terminal(request, "agent");
      },
      async observe(effectId, _signal, lookup) {
        if (effectId !== optional.row.effect_id) {
          return terminal(requireOwnedAttempt(db, effectId).request, "agent");
        }
        if (!("validation" in lookup))
          throw new Error("Missing retained proof acknowledgement");
        if (lookup.validation.validationId === "scan-a")
          return checking(original, "scan-b");
        return permitCompletion
          ? current(original, "scan-b")
          : checking(original, "scan-b");
      },
      async interrupt() {
        throw new Error("Successful revalidation needs no interruption");
      },
    });
    const run = claimOwnedRun(db, 4);
    if (run === null) throw new Error("Resumed run was not queued");
    const controller = new AbortController();
    controllers.set(run.row.id, controller);
    const done = owned.execute(run, controller.signal);
    disposals.push(async () => {
      controller.abort();
      await done;
      await owned.drain();
    });
    await eventually(async () => {
      await owned.maintain(new AbortController().signal);
      expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(1);
    });
    expect(executions).toEqual([]);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
    permitCompletion = true;
    await eventually(async () => {
      await owned.maintain(new AbortController().signal);
      expect(viewOwnedRun(db, run.row.id).state).toBe("succeeded");
    });
    await done;
    expect(executions).toEqual(["check"]);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(2);
    expect(requireOwnedAttempt(db, optional.row.effect_id).row.attempt).toBe(1);
  });

  it("does not finish a resumed run while a retained non-gate proof belongs to an older generation", () => {
    const run = start(
      v2Input({ steps: [v2Step("optional"), v2Step("check")] }),
    );
    const optional = admit(run.row.id, "optional");
    const original = terminal(optional.request);
    record(optional, checking(original));
    record(optional, current(original));
    const check = admit(run.row.id);
    record(check, terminal(check.request));
    control(run.row.id, "pause");
    const resumed = control(run.row.id, "resume");
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(() =>
      finishOwnedRun(db, run.row.id, resumed.dispatchGeneration, null),
    ).toThrow("receipt validation is still pending");
    expect(record(optional, checking(original, "scan-b"))).toBe(true);
    expect(record(optional, current(original, "scan-b"))).toBe(true);
    expect(
      finishOwnedRun(db, run.row.id, resumed.dispatchGeneration, null),
    ).toBe(true);
  });

  it.each([
    { outcome: "succeeded", unresolvedFirstReply: false },
    { outcome: "failed", unresolvedFirstReply: false },
    { outcome: "succeeded", unresolvedFirstReply: true },
  ] as const)(
    "waits for the skipped $outcome receipt before final completion with unresolved first reply $unresolvedFirstReply",
    async ({ outcome, unresolvedFirstReply }) => {
      const input = v2Input({
        steps: [v2Step("optional", { kind: "agent" }), v2Step("check")],
        source: `export const meta = {name: "resume-final-proof", description: "Revalidate completed history"}; if (budget().agentCalls === 0) { try { await step("optional", 0, null); } catch {} } return await step("check", 0, null);`,
      });
      const initial = start(input);
      const optional = admit(initial.row.id, "optional");
      const original = withValidity(terminal(optional.request, "agent"), {
        state: "checking",
        validationId: "scan-a",
        activity: "running",
        reason: "Initial proof",
      });
      original.state = outcome;
      if (unresolvedFirstReply)
        record(optional, terminal(optional.request, "agent"));
      else {
        record(optional, original);
        record(optional, current(original));
      }
      const check = admit(initial.row.id);
      const checkReceipt = terminal(check.request);
      record(check, checkReceipt);
      if (unresolvedFirstReply) {
        reserveOwnedValidationRequest(db, optional.row.effect_id, 0);
        recoverOwnedRuns(db, 200);
      } else {
        control(initial.row.id, "pause");
        control(initial.row.id, "resume");
      }
      let complete = false;
      let executions = 0;
      const { owned, controllers } = await operations({
        async execute() {
          executions += 1;
          throw new Error("Both native effects are already terminal");
        },
        async observe(effectId, _signal, lookup) {
          if (effectId === check.row.effect_id) return checkReceipt;
          if (!("validation" in lookup)) return checking(original, "scan-b");
          return complete && lookup.validation.validationId === "scan-b"
            ? current(original, "scan-b")
            : checking(original, "scan-b");
        },
        async interrupt() {
          throw new Error("Successful proof refresh needs no interruption");
        },
      });
      const run = claimOwnedRun(db, 4);
      if (run === null) throw new Error("Resumed run was not queued");
      const controller = new AbortController();
      controllers.set(run.row.id, controller);
      const done = owned.execute(run, controller.signal);
      disposals.push(async () => {
        controller.abort();
        await done;
        await owned.drain();
      });
      await eventually(() =>
        expect(checkingOwnedAttempts(db, run.row.id)).toHaveLength(1),
      );
      expect(viewOwnedRun(db, run.row.id).state).toBe("running");
      complete = true;
      await eventually(async () => {
        await owned.maintain(new AbortController().signal);
        expect(viewOwnedRun(db, run.row.id).state).toBe("succeeded");
      });
      await done;
      expect(executions).toBe(0);
      expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
      expect(
        ownedTerminalObservation(
          requireOwnedAttempt(db, optional.row.effect_id),
        ),
      ).toMatchObject({
        state: outcome,
        receiptHash: original.receiptHash,
        validity: { state: "current", validationId: "scan-b" },
      });
    },
  );

  it("persists an unresolved scan request before RPC and holds pause until lost scan B is quiesced under acknowledged A", async () => {
    const initial = start(
      v2Input({ steps: [v2Step("check", { kind: "agent" })] }),
    );
    const attempt = admit(initial.row.id);
    const original = terminal(attempt.request, "agent");
    record(attempt, checking(original));
    record(attempt, current(original));
    let lostReply = false;
    let liveScan = false;
    let lateB = false;
    let observes = 0;
    let interrupts = 0;
    const { owned, controllers } = await operations({
      async execute() {
        throw new Error("The native worker must not be replayed");
      },
      async observe(_effectId, _signal, lookup) {
        observes += 1;
        expect(
          requireOwnedAttempt(db, attempt.row.effect_id).row,
        ).toMatchObject({
          validation_request_id: expect.any(String),
          validation_request_generation: lookup.dispatchGeneration,
        });
        if (!("validation" in lookup))
          throw new Error("Missing scan acknowledgement");
        if (!lostReply) {
          expect(lookup.validation).toMatchObject({
            validationId: "scan-a",
            state: "current",
          });
          lostReply = true;
          liveScan = true;
          throw new Error("Scan B started but its checking reply was lost");
        }
        if (lookup.validation.validationId === "scan-a")
          return checking(original, "scan-c");
        if (!lateB) {
          lateB = true;
          return current(original, "scan-b");
        }
        return current(original, "scan-c");
      },
      async interrupt(_effectId, _signal, lookup) {
        interrupts += 1;
        expect(lookup).toMatchObject({
          dispatchGeneration: 1,
          validation: {
            validationId: "scan-a",
            state: "current",
            generation: 0,
            activity: null,
          },
        });
        liveScan = false;
        return checking(original, "scan-a", "quiescent");
      },
    });
    const firstController = new AbortController();
    controllers.set(initial.row.id, firstController);
    const first = owned.execute(initial, firstController.signal);
    disposals.push(async () => {
      firstController.abort();
      await first;
      await owned.drain();
    });
    await eventually(() => expect(lostReply).toBe(true));
    expect(liveScan).toBe(true);
    expect(
      ownedTerminalObservation(requireOwnedAttempt(db, attempt.row.effect_id)),
    ).toMatchObject({
      validity: { state: "current", validationId: "scan-a" },
      receiptHash: original.receiptHash,
    });
    const paused = await owned.control("arc", {
      workflowRunId: initial.row.id,
      operationId: "pause-lost-b",
      expectedVersion: 0,
      action: "pause",
    });
    expect(paused.state).toBe("pausing");
    expect(countActiveWorkflowRuns(db)).toBe(1);
    expect(() => control(initial.row.id, "resume")).toThrow(
      "Reconcile and pause",
    );
    await first;
    await owned.maintain(new AbortController().signal);
    expect(liveScan).toBe(false);
    expect(viewOwnedRun(db, initial.row.id)).toMatchObject({
      state: "paused",
      agentCalls: 1,
      activeAgents: 0,
    });
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.validation_request_id,
    ).toBeNull();
    const heldObserves = observes;
    await owned.maintain(new AbortController().signal);
    expect(observes).toBe(heldObserves);
    expect(interrupts).toBe(1);
    const held = viewOwnedRun(db, initial.row.id);
    await owned.control("arc", {
      workflowRunId: initial.row.id,
      operationId: "resume-c",
      expectedVersion: held.controlVersion,
      action: "resume",
    });
    const resumed = claimOwnedRun(db, 4);
    if (resumed === null) throw new Error("Resumed workflow was not queued");
    const secondController = new AbortController();
    controllers.set(resumed.row.id, secondController);
    const second = owned.execute(resumed, secondController.signal);
    disposals.push(async () => {
      secondController.abort();
      await second;
      await owned.drain();
    });
    await eventually(async () => {
      await owned.maintain(new AbortController().signal);
      expect(viewOwnedRun(db, resumed.row.id).state).toBe("succeeded");
    });
    await second;
    expect(lateB).toBe(true);
    expect(viewOwnedRun(db, resumed.row.id).agentCalls).toBe(1);
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.validation_request_id,
    ).toBeNull();
  });

  it("does not let a late callback clear a newer validation request, including after worker recovery", () => {
    const run = start();
    const attempt = admit(run.row.id);
    const original = terminal(attempt.request);
    record(attempt, checking(original));
    record(attempt, current(original));
    const older = reserveOwnedValidationRequest(db, attempt.row.effect_id, 0);
    const newer = reserveOwnedValidationRequest(db, attempt.row.effect_id, 0);
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        0,
        current(original),
        150,
        older,
      ),
    ).toBe(false);
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.validation_request_id,
    ).toBe(newer.id);
    recoverOwnedRuns(db, 200);
    expect(requireOwnedAttempt(db, attempt.row.effect_id).row).toMatchObject({
      validation_request_id: newer.id,
      validation_request_generation: 0,
    });
    expect(claimOwnedRun(db, 1)?.row.id).toBe(run.row.id);
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        0,
        current(original),
        210,
        newer,
      ),
    ).toBe(false);
    const recovered = reserveOwnedValidationRequest(
      db,
      attempt.row.effect_id,
      1,
    );
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        1,
        checking(original, "scan-c"),
        220,
        recovered,
      ),
    ).toBe(true);
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.validation_request_id,
    ).toBeNull();
    expect(record(attempt, current(original, "scan-c"))).toBe(true);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(0);
  });
});

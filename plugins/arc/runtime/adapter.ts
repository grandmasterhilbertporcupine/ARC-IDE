import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  appendDependencyHandoff,
  responseQuestion,
} from "./collaboration-service.js";
import {
  ownedAdapterRpcContract,
  ownedWorkflowRpcContract,
  ownedStepObservationSchema,
  type OwnedStepLookupInput as OwnedStepLookup,
  type OwnedStepObservationLookupInput,
  type OwnedStepRequestInput as OwnedStepRequest,
  type OwnedStepObservationInput as OwnedStepObservation,
  type OwnedReceiptValidity,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import {
  arcHostContract,
  type HostEffectRecord,
  type HostEffectRequest,
  type HostWorkspaceState,
} from "../host-contract.js";
import { hostEffectRequestHash } from "../host/hash.js";
import { runtimeNodeKey } from "./compiler.js";
import type { RuntimeNode as LegacyRuntimeNode } from "./compiler.js";
import type { GraphRuntimeNode } from "./graph-contract.js";
import type { OrchestratorRuntimeNode } from "./orchestrated-contract.js";
import {
  graphRuntimeReceiptSchema,
  graphControlReceiptSchema,
  type GraphRuntimeReceipt,
} from "./graph-receipt.js";
import {
  createGraphControlDriver,
  graphReceiptWorkspace as receiptWorkspace,
} from "./control-driver.js";
import type { RunControl } from "./control-contract.js";
import { type ArcRunStore } from "./data.js";
import {
  createGitRuntimeStore,
  gitRuntimeEffect,
  type GitRuntimeEffect as ArcRunEffect,
} from "./git-store.js";
import {
  prepareRuntimeWorker,
  runtimeWorkerTerminal,
} from "./prepared-worker.js";
import { createDirectoryRuntimeDriver } from "./directory-adapter.js";
import { runtimeHash } from "./hash.js";
import {
  assertReviewAuthority,
  reviewAuthorityDiagnostic,
} from "./review-authority.js";
import { createOrchestratorTurnDriver } from "./orchestrated-adapter.js";
import {
  runtimeReceiptSchema,
  sameWorkspaceIdentity,
  sameWorkspaceState,
  type RuntimeReceipt,
} from "./receipt.js";

type RuntimeNode =
  | LegacyRuntimeNode
  | GraphRuntimeNode
  | OrchestratorRuntimeNode;
export function createArcRuntimeAdapter(
  bb: BbPluginApi,
  baseStore: ArcRunStore,
) {
  const store = createGitRuntimeStore(baseStore);
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });

  function lookup(input: OwnedStepLookup) {
    const effect = store.findEffect(input.effectId);
    if (!effect) return null;
    if (
      effect.runId !== input.ownerRunId ||
      effect.request.workflowRunId !== input.workflowRunId ||
      effect.requestHash !== input.requestHash ||
      effect.request.nodeId !== input.nodeId ||
      effect.request.iteration !== input.iteration ||
      effect.request.attempt !== input.attempt
    )
      throw new AgentStoreError(
        "scope_denied",
        "This callback does not identify the admitted ARC effect",
      );
    return effect;
  }

  async function canAdvance(input: OwnedStepLookup, signal: AbortSignal) {
    signal.throwIfAborted();
    const { run } = await workflows.call(
      "inspectOwnedRun",
      { workflowRunId: input.workflowRunId },
      { signal },
    );
    return (
      run.ownerRunId === input.ownerRunId &&
      run.desiredControl === "run" &&
      run.dispatchGeneration === input.dispatchGeneration &&
      run.state === "running"
    );
  }

  function dependency(
    effect: ArcRunEffect,
    ref: OwnedStepRef,
  ): GraphRuntimeReceipt {
    const admitted = effect.request.dependencyReceipts.find(
      (value) => runtimeNodeKey(value) === runtimeNodeKey(ref),
    );
    if (!admitted)
      throw new AgentStoreError(
        "dependency_missing",
        "This receipt is not an admitted dependency",
      );
    const retained = store.effect(admitted.effectId);
    const value = retained.observation;
    if (value === null || !("receipt" in value))
      throw new AgentStoreError(
        "dependency_missing",
        "A required native receipt is missing",
      );
    if (
      retained.runId !== effect.runId ||
      value.receiptHash !== admitted.receiptHash ||
      value.state !== admitted.outcome
    )
      throw new AgentStoreError(
        "dependency_missing",
        "The admitted dependency receipt has changed identity",
      );
    return graphRuntimeReceiptSchema.parse(value.receipt);
  }

  function binding(
    state: HostWorkspaceState,
    originalPath: string,
    includeState = true,
  ) {
    return {
      path: state.path,
      commonGitDir: state.commonGitDir,
      originalPath,
      expectedHead: state.head,
      expectedStateDigest: includeState ? state.stateDigest : null,
    };
  }

  function validationPass(signal: AbortSignal) {
    const receipts = new Map<string, Promise<OwnedStepObservation>>();
    const inspections = new Map<string, Promise<HostWorkspaceState>>();
    const origins = new Map<string, Promise<OwnedReceiptValidity>>();
    const waiting: (() => void)[] = [];
    let active = 0;
    async function inspect(hostId: string, path: string) {
      signal.throwIfAborted();
      const key = JSON.stringify([hostId, path]);
      const existing = inspections.get(key);
      if (existing) return existing;
      const operation = (async () => {
        if (active >= 4)
          await new Promise<void>((resolve) => waiting.push(resolve));
        else active++;
        try {
          signal.throwIfAborted();
          const state = await host.call(
            "inspectWorkspace",
            { path, expected: null },
            { hostId, signal },
          );
          signal.throwIfAborted();
          return state;
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      })();
      inspections.set(key, operation);
      return operation;
    }
    return { receipts, origins, inspect };
  }

  type ValidationPass = ReturnType<typeof validationPass>;

  async function originValidity(
    effect: ArcRunEffect,
    signal: AbortSignal,
    pass = validationPass(signal),
  ): Promise<OwnedReceiptValidity> {
    const existing = pass.origins.get(effect.runId);
    if (existing) return existing;
    const result = inspectOrigin(effect, signal, pass);
    pass.origins.set(effect.runId, result);
    return result;
  }

  async function inspectOrigin(
    effect: ArcRunEffect,
    signal: AbortSignal,
    pass: ValidationPass,
  ): Promise<OwnedReceiptValidity> {
    const { compiled } = store.get(effect.runId);
    try {
      const state = await pass.inspect(
        compiled.definition.request.hostId,
        compiled.definition.source.path,
      );
      if (
        state.path !== compiled.definition.source.path ||
        state.head !== compiled.definition.source.head ||
        state.stateDigest !== compiled.definition.source.stateHash ||
        state.commonGitDir !== compiled.definition.source.commonGitDir
      )
        return {
          state: "stale",
          reason: "The original project changed after this run was started",
        };
      return { state: "current", identityHash: compiled.workflow.planHash };
    } catch (error) {
      signal.throwIfAborted();
      return {
        state: "stale",
        reason: `The original source cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function consumedFailure(
    effect: ArcRunEffect,
    expected: HostWorkspaceState,
    signal: AbortSignal,
  ) {
    const { compiled } = store.get(effect.runId);
    for (const repair of store.repairConsumers(effect.effectId)) {
      const node = compiled.nodes[runtimeNodeKey(repair.request)];
      if (
        node.kind !== "agent" ||
        node.purpose !== "repair" ||
        node.failure === null ||
        runtimeNodeKey(node.failure) !== runtimeNodeKey(effect.request) ||
        repair.workerBinding === null ||
        !sameWorkspaceState(repair.workerBinding.workspace, expected)
      )
        continue;
      const preparation = await bb.experimental_threads.getPreparation(
        { operationId: repair.effectId },
        { signal },
      );
      const requestId = preparation?.dispatch?.clientTurnRequestId;
      if (
        !preparation ||
        preparation.threadId !== repair.threadId ||
        !requestId
      )
        continue;
      const events = await bb.sdk.threads.events.list({
        threadId: preparation.threadId,
        types: ["turn/input/accepted"],
        limit: "200",
        order: "asc",
        signal,
      });
      if (
        events.some(
          (event) =>
            event.type === "turn/input/accepted" &&
            event.scope.kind === "turn" &&
            event.data.clientRequestId === requestId,
        )
      )
        return true;
    }
    return false;
  }

  async function retained(
    effect: ArcRunEffect,
    signal: AbortSignal,
    pass = validationPass(signal),
  ): Promise<OwnedStepObservation> {
    signal.throwIfAborted();
    const existing = pass.receipts.get(effect.effectId);
    if (existing) return existing;
    const result = validateRetained(effect, signal, pass);
    pass.receipts.set(effect.effectId, result);
    return result;
  }

  async function consumedApproval(
    effect: ArcRunEffect,
    expected: HostWorkspaceState,
    signal: AbortSignal,
  ) {
    const { compiled } = store.get(effect.runId);
    if (compiled.definition.schemaVersion === 1) return false;
    for (const consumer of store.approvalConsumers(effect.effectId)) {
      const node = compiled.nodes[runtimeNodeKey(consumer.request)];
      const step = compiled.workflow.steps.find(
        (item) => runtimeNodeKey(item) === runtimeNodeKey(consumer.request),
      );
      if (
        node.kind !== "agent" ||
        !("access" in node) ||
        node.access !== "write" ||
        consumer.workerBinding === null ||
        !sameWorkspaceState(consumer.workerBinding.workspace, expected) ||
        !step ||
        !("requirements" in step) ||
        !step.requirements.some(
          (requirement) =>
            requirement.kind === "receipt" &&
            requirement.outcomes.length === 1 &&
            requirement.outcomes[0] === "succeeded" &&
            runtimeNodeKey(requirement.step) === runtimeNodeKey(effect.request),
        )
      )
        continue;
      const preparation = await bb.experimental_threads.getPreparation(
        { operationId: consumer.effectId },
        { signal },
      );
      const requestId = preparation?.dispatch?.clientTurnRequestId;
      if (
        !preparation ||
        preparation.threadId !== consumer.threadId ||
        !requestId
      )
        continue;
      const events = await bb.sdk.threads.events.list({
        threadId: preparation.threadId,
        types: ["turn/input/accepted"],
        limit: "200",
        order: "asc",
        signal,
      });
      if (
        events.some(
          (event) =>
            event.type === "turn/input/accepted" &&
            event.scope.kind === "turn" &&
            event.data.clientRequestId === requestId,
        )
      )
        return true;
    }
    return false;
  }

  async function validateRetained(
    effect: ArcRunEffect,
    signal: AbortSignal,
    pass: ValidationPass,
  ): Promise<OwnedStepObservation> {
    const observation = effect.observation;
    if (observation === null || !("receipt" in observation))
      throw new Error("A terminal receipt is required");
    let validity = await originValidity(effect, signal, pass);
    signal.throwIfAborted();
    const node = store.get(effect.runId).compiled.nodes[
      runtimeNodeKey(effect.request)
    ];
    if (node.kind === "orchestrator") {
      const current = await mainTurns.validate(effect, signal);
      signal.throwIfAborted();
      return store.recordObservation(effect.effectId, current);
    }
    if (node.kind === "control") {
      for (const admitted of effect.request.dependencyReceipts) {
        const child = store.effect(admitted.effectId);
        const current = await retained(child, signal, pass);
        if (
          !("receipt" in current) ||
          current.receiptHash !== admitted.receiptHash ||
          current.state !== admitted.outcome ||
          current.validity.state !== "current"
        ) {
          validity = {
            state: "stale",
            reason: "A control's admitted evidence is no longer current",
          };
          break;
        }
      }
      if (observation.state !== "interrupted") {
        const receipt = graphControlReceiptSchema.parse(observation.receipt);
        if (validity.state === "current" && receipt.data.workspace !== null) {
          try {
            const current = await pass.inspect(
              store.get(effect.runId).compiled.definition.request.hostId,
              receipt.data.workspace.path,
            );
            if (
              !sameWorkspaceState(current, receipt.data.workspace) &&
              !(
                node.operation.type === "approval" &&
                receipt.data.decision.kind === "approval" &&
                receipt.data.decision.value === "approved" &&
                observation.state === "succeeded" &&
                sameWorkspaceIdentity(current, receipt.data.workspace) &&
                (await consumedApproval(effect, receipt.data.workspace, signal))
              )
            )
              validity = {
                state: "stale",
                reason: "The decision's candidate changed",
              };
          } catch (error) {
            signal.throwIfAborted();
            validity = {
              state: "stale",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      signal.throwIfAborted();
      return store.recordObservation(effect.effectId, {
        ...observation,
        validity,
      });
    }
    const receipt = runtimeReceiptSchema.parse(observation.receipt);
    if (receipt.kind === "native" && receipt.receipt.outcome === "invalid")
      validity = {
        state: "stale",
        reason:
          receipt.receipt.reason ?? "Native preconditions were not satisfied",
      };
    if (
      validity.state === "current" &&
      receipt.kind !== "preparation" &&
      (node.kind === "check" ||
        node.kind === "verify" ||
        (node.kind === "agent" && node.purpose === "review"))
    ) {
      const expected = receiptWorkspace(receipt);
      try {
        const state = await pass.inspect(
          store.get(effect.runId).compiled.definition.request.hostId,
          expected.path,
        );
        if (
          !sameWorkspaceState(state, expected) &&
          !(
            node.kind === "check" &&
            observation.state === "failed" &&
            receipt.kind === "native" &&
            receipt.receipt.outcome === "failed" &&
            (await consumedFailure(effect, expected, signal))
          )
        )
          validity = {
            state: "stale",
            reason: "The checked or reviewed candidate changed",
          };
      } catch (error) {
        signal.throwIfAborted();
        validity = {
          state: "stale",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    signal.throwIfAborted();
    const authority = reviewAuthorityDiagnostic(
      store.get(effect.runId).compiled,
      effect.request,
    );
    if (validity.state === "current" && authority)
      validity = { state: "stale", reason: authority.message };
    return store.recordObservation(effect.effectId, {
      ...observation,
      validity,
    });
  }

  async function nativeObservation(
    effect: ArcRunEffect,
    record: HostEffectRecord,
    signal: AbortSignal,
  ): Promise<OwnedStepObservation> {
    const hostId = store.get(effect.runId).compiled.definition.request.hostId;
    const resource = {
      kind: "host-effect",
      hostId,
      effectId: effect.effectId,
    } as const;
    if (record.state === "running") return { state: "running", resource };
    if (
      record.state === "needs-reconciliation" ||
      record.receipt === null ||
      effect.nativeRequest === null
    )
      return {
        state: "needs-reconciliation",
        reason: "The native operation has no confirmed terminal receipt",
      };
    const receipt: RuntimeReceipt = {
      kind: "native",
      request: effect.nativeRequest,
      receipt: record.receipt,
    };
    const state =
      record.receipt.outcome === "succeeded"
        ? "succeeded"
        : record.receipt.outcome === "interrupted"
          ? "interrupted"
          : "failed";
    let validity = await originValidity(effect, signal);
    const node = store.get(effect.runId).compiled.nodes[
      runtimeNodeKey(effect.request)
    ];
    if (record.receipt.outcome === "invalid")
      validity = {
        state: "stale",
        reason:
          record.receipt.reason ?? "Native preconditions were not satisfied",
      };
    else if (
      validity.state === "current" &&
      (node.kind === "check" || node.kind === "verify") &&
      record.receiptValidity?.status !== "current"
    )
      validity = {
        state: "stale",
        reason:
          record.receiptValidity?.reason ??
          "The current candidate has not been verified against this receipt",
      };
    const authority = reviewAuthorityDiagnostic(
      store.get(effect.runId).compiled,
      effect.request,
    );
    if (validity.state === "current" && authority)
      validity = { state: "stale", reason: authority.message };
    return store.recordObservation(
      effect.effectId,
      ownedStepObservationSchema.parse({
        state,
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity,
      }),
    );
  }

  function nativeRequest(
    effect: ArcRunEffect,
    node: Exclude<RuntimeNode, { kind: "agent" | "control" | "orchestrator" }>,
  ): HostEffectRequest {
    const { definition } = store.get(effect.runId).compiled;
    const base = {
      runId: effect.runId,
      effectId: effect.effectId,
      lane: effect.request.lane,
    };
    const originalPath = definition.source.path;
    if (node.kind === "prepare-worktree")
      return {
        ...base,
        workspace: {
          path: originalPath,
          commonGitDir: definition.source.commonGitDir,
          originalPath,
          expectedHead: definition.source.head,
          expectedStateDigest: definition.source.stateHash,
        },
        operation: { type: "prepare-worktree", workspaceId: node.workspaceKey },
      };
    if (node.kind === "commit")
      return {
        ...base,
        workspace: binding(
          receiptWorkspace(dependency(effect, node.worker)),
          originalPath,
        ),
        operation: { type: "commit", message: node.message },
      };
    if (node.kind === "fork-worktree")
      return {
        ...base,
        workspace: binding(
          receiptWorkspace(dependency(effect, node.candidate)),
          originalPath,
        ),
        operation: { type: "fork-worktree", workspaceId: node.workspaceKey },
      };
    if (node.kind === "integrate")
      return {
        ...base,
        workspace: binding(
          receiptWorkspace(dependency(effect, node.candidate)),
          originalPath,
        ),
        operation: {
          type: "strategy" in node ? node.strategy : "integrate",
          source: binding(
            receiptWorkspace(dependency(effect, node.commit)),
            originalPath,
          ),
        },
      };
    if (node.kind === "check")
      return {
        ...base,
        workspace: binding(
          receiptWorkspace(dependency(effect, node.candidate)),
          originalPath,
        ),
        operation: { type: "check", ...node.command },
      };
    const checked = receiptWorkspace(dependency(effect, node.check));
    const reviewed = receiptWorkspace(dependency(effect, node.review));
    if (!sameWorkspaceState(checked, reviewed))
      throw new AgentStoreError(
        "candidate_changed",
        "Review and check did not cover the same candidate",
      );
    if (definition.schemaVersion !== 1) {
      const proof = effect.request.dependencyReceipts.find(
        (value) => runtimeNodeKey(value) === runtimeNodeKey(node.check),
      );
      if (!proof)
        throw new AgentStoreError(
          "check_missing",
          "The final check has no admitted proof",
        );
      const native = controls.checkReceipt(effect, proof);
      if (
        native.proof.outcome !== "succeeded" ||
        native.receipt.receipt.outcome !== "succeeded" ||
        !sameWorkspaceState(
          receiptWorkspace(runtimeReceiptSchema.parse(native.receipt)),
          checked,
        )
      )
        throw new AgentStoreError(
          "check_failed",
          "The final candidate requires a successful native check of exactly these files",
        );
    }
    return {
      ...base,
      workspace: binding(checked, originalPath),
      operation: { type: "snapshot" },
    };
  }

  async function driveNative(
    effect: ArcRunEffect,
    node: Exclude<RuntimeNode, { kind: "agent" | "control" | "orchestrator" }>,
    input: OwnedStepLookup,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<OwnedStepObservation> {
    const hostId = store.get(effect.runId).compiled.definition.request.hostId;
    if (effect.nativeRequest === null) {
      if (!execute || !(await canAdvance(input, signal)))
        return {
          state: "not-started",
          reason: "Native dispatch has not been admitted in this generation",
        };
      const validity = await originValidity(effect, signal);
      if (validity.state === "stale")
        return { state: "needs-reconciliation", reason: validity.reason };
      assertReviewAuthority(store.get(effect.runId).compiled, effect.request);
      store.sealNative(effect.effectId, nativeRequest(effect, node));
      effect = store.effect(effect.effectId);
    }
    const request = effect.nativeRequest;
    if (request === null) throw new Error("Native request was not sealed");
    const identity = {
      runId: effect.runId,
      effectId: effect.effectId,
      requestHash: hostEffectRequestHash(request),
    };
    const previous = await host.call("observeEffect", identity, {
      hostId,
      signal,
    });
    if (previous !== null) return nativeObservation(effect, previous, signal);
    if (!execute || !(await canAdvance(input, signal)))
      return {
        state: "not-started",
        reason: "The host confirms this effect has not started",
      };
    assertReviewAuthority(store.get(effect.runId).compiled, effect.request);
    return nativeObservation(
      effect,
      await host.call("startEffect", request, { hostId, signal }),
      signal,
    );
  }

  async function driveAgent(
    effect: ArcRunEffect,
    node: Extract<RuntimeNode, { kind: "agent" }>,
    input: OwnedStepLookup,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<OwnedStepObservation> {
    const { definition } = store.get(effect.runId).compiled;
    const hostId = definition.request.hostId;
    const advance = await canAdvance(input, signal);
    const authority = reviewAuthorityDiagnostic(
      store.get(effect.runId).compiled,
      effect.request,
    );
    if (effect.workerBinding === null) {
      if (!execute || !advance)
        return {
          state: "not-started",
          reason: "Worker preparation has not started",
        };
      assertReviewAuthority(store.get(effect.runId).compiled, effect.request);
      let candidate = receiptWorkspace(dependency(effect, node.candidate));
      const previous = store.previousAttempt(effect.request);
      if (previous?.observation?.state === "interrupted") {
        const receipt = runtimeReceiptSchema.parse(
          previous.observation.receipt,
        );
        if (receipt.kind === "agent") {
          if (
            previous.observation.validity.state !== "current" ||
            !sameWorkspaceIdentity(candidate, receipt.workspace) ||
            candidate.head !== receipt.workspace.head
          )
            return {
              state: "needs-reconciliation",
              reason:
                "The interrupted worker's retained workspace no longer matches the admitted candidate",
            };
          candidate = receipt.workspace;
        }
      }
      const failure =
        node.failure === null ? null : dependency(effect, node.failure);
      const taskPrompt = [
        `Project goal: ${definition.request.goal}`,
        `Your task: ${node.task}`,
        ...("replyDecision" in node && node.replyDecision
          ? [
              `Selected question for this admitted response: ${JSON.stringify(responseQuestion(store, effect, node.replyDecision))}`,
            ]
          : []),
        `Work only in your assigned workspace ${candidate.path}. Starting commit: ${candidate.head}.`,
        "Do not commit, merge, push, deploy, or change required check configuration. ARC performs integration and required checks outside this turn.",
        node.purpose === "review"
          ? "Review this exact candidate without editing files. Use arc_run_review to submit an approved or changes-requested verdict with the candidate HEAD and concrete findings. Completing the chat without a verdict does not approve it."
          : node.purpose === "delegation"
            ? "Read the exact assigned context without editing files. Call arc_run_delegate with your ordered assignments to the declared candidate members. Each proposed assignment consumes a separately admitted child call; you cannot start a child or change the graph, task or permissions."
            : "access" in node && node.access === "read"
              ? "Inspect the assigned work without editing files and report the actual findings."
              : "Implement the assigned work, verify what you can, and report the actual changes and results.",
        failure === null
          ? ""
          : `The required check failed. Repair the implementation while preserving the required check. Native failure evidence (bounded excerpt, up to 16,000 characters):\n${JSON.stringify(failure).slice(0, 16_000)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const prompt =
        "memberId" in node
          ? appendDependencyHandoff(store, effect.effectId, taskPrompt)
          : taskPrompt;
      store.sealWorker(effect.effectId, {
        workspace: candidate,
        prompt,
      });
      effect = store.effect(effect.effectId);
    }
    const sealed = effect.workerBinding;
    if (sealed === null) throw new Error("Worker binding is missing");
    let preparation = await prepareRuntimeWorker(
      bb,
      store,
      effect,
      {
        projectId: definition.request.projectId,
        parentThreadId: definition.request.originThreadId,
        hostId,
        path: sealed.workspace.path,
        prompt: sealed.prompt,
        title: `${node.agent.definition.metadata.name} · ${node.purpose}`,
        execution: node.agent.execution,
      },
      signal,
      execute && advance && authority === null,
    );
    if (preparation === null)
      return {
        state: authority ? "needs-reconciliation" : "not-started",
        reason:
          authority?.message ??
          "Core confirms this worker has not been prepared",
      };
    store.bindThread(effect.effectId, preparation.threadId);
    if (preparation.state === "prepared" && advance) {
      if (authority)
        return {
          state: "needs-reconciliation",
          reason: authority.message,
        };
      const validity = await originValidity(effect, signal);
      if (validity.state === "stale")
        return { state: "needs-reconciliation", reason: validity.reason };
      const state = await host.call(
        "inspectWorkspace",
        {
          path: preparation.environment.path,
          expected: {
            path: sealed.workspace.path,
            commonGitDir: definition.source.commonGitDir,
            originalPath: definition.source.path,
            expectedHead: sealed.workspace.head,
            expectedStateDigest: sealed.workspace.stateDigest,
          },
        },
        { hostId, signal },
      );
      if (!sameWorkspaceState(state, sealed.workspace))
        return {
          state: "needs-reconciliation",
          reason: "The prepared worker was placed in a different workspace",
        };
      if (await canAdvance(input, signal))
        preparation = await bb.experimental_threads.startPrepared(
          {
            operationId: effect.effectId,
            expectedRevision: preparation.revision,
            environment: preparation.environment,
          },
          { signal },
        );
    }
    const resource = {
      kind: "agent",
      threadId: preparation.threadId,
      executionContextId: effect.executionContextId,
      environmentId: preparation.environment?.environmentId ?? null,
      turnRequestId: preparation.dispatch?.clientTurnRequestId ?? null,
    } as const;
    if (
      (preparation.state === "cancelled" || preparation.state === "failed") &&
      preparation.dispatch?.clientTurnRequestId == null
    ) {
      const receipt: RuntimeReceipt = {
        kind: "preparation",
        operationId: effect.effectId,
        threadId: preparation.threadId,
        revision: preparation.revision,
        state: preparation.state,
        reason: preparation.reason,
      };
      return store.recordObservation(
        effect.effectId,
        ownedStepObservationSchema.parse({
          state: preparation.state === "cancelled" ? "interrupted" : "failed",
          resource,
          receipt,
          receiptHash: runtimeHash(receipt),
          validity: {
            state: "current",
            identityHash: effect.request.definitionHash,
          },
        }),
      );
    }
    const unresolved: OwnedStepObservation =
      preparation.state === "needs-reconciliation" ||
      preparation.state === "failed" ||
      preparation.state === "cancelled"
        ? { state: "needs-reconciliation", reason: preparation.reason }
        : { state: "running", resource };
    if (resource.turnRequestId === null) return unresolved;
    const completed = await runtimeWorkerTerminal(
      bb,
      preparation.threadId,
      resource.turnRequestId,
      signal,
    );
    if (!completed) return unresolved;
    const workspace = await host.call(
      "inspectWorkspace",
      { path: sealed.workspace.path, expected: null },
      { hostId, signal },
    );
    const review = store.effect(effect.effectId).review;
    const receipt: RuntimeReceipt = {
      kind: "agent",
      threadId: resource.threadId,
      executionContextId: resource.executionContextId,
      turnRequestId: resource.turnRequestId,
      terminalEventId: completed.id,
      terminalStatus: completed.status,
      workspace,
      review,
      definitionHash: effect.request.definitionHash,
    };
    const succeeded =
      completed.status === "completed" &&
      (!("replyDecision" in node) ||
        node.replyDecision === undefined ||
        store.collaboration.hasReply(
          effect.runId,
          responseQuestion(store, effect, node.replyDecision)!.id,
        )) &&
      workspace.head === sealed.workspace.head &&
      sameWorkspaceIdentity(workspace, sealed.workspace) &&
      (!("access" in node) ||
        node.access !== "read" ||
        sameWorkspaceState(workspace, sealed.workspace)) &&
      (node.purpose !== "delegation" ||
        store.controls.delegation(effect.effectId) !== null) &&
      (node.purpose !== "review" ||
        (review?.outcome === "approved" &&
          review.candidateHead === sealed.workspace.head &&
          sameWorkspaceState(workspace, sealed.workspace)));
    let validity = await originValidity(effect, signal);
    if (
      workspace.head !== sealed.workspace.head ||
      !sameWorkspaceIdentity(workspace, sealed.workspace)
    )
      validity = {
        state: "stale",
        reason: "The worker changed its assigned Git revision or repository",
      };
    if (validity.state === "current" && authority)
      validity = { state: "stale", reason: authority.message };
    return store.recordObservation(
      effect.effectId,
      ownedStepObservationSchema.parse({
        state: succeeded
          ? "succeeded"
          : completed.status === "interrupted"
            ? "interrupted"
            : "failed",
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity,
      }),
    );
  }

  async function drive(
    input: OwnedStepObservationLookupInput,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<OwnedStepObservation> {
    const directoryEffect = baseStore.findEffect(input.effectId);
    if (
      directoryEffect &&
      baseStore.get(directoryEffect.runId).compiled.definition.schemaVersion ===
        4
    )
      return directories.drive(directoryEffect, input, signal, execute);
    const effect = lookup(input);
    if (effect === null)
      return {
        state: "not-started",
        reason: "ARC has no admitted effect for this identity",
      };
    if (effect.observation !== null && "receipt" in effect.observation)
      return retained(effect, signal);
    const node = store.get(effect.runId).compiled.nodes[
      runtimeNodeKey(effect.request)
    ];
    const observation = await (node.kind === "orchestrator"
      ? mainTurns.drive(effect, node, input, signal, execute)
      : node.kind === "control"
        ? controls.drive(effect, node.operation, signal)
        : node.kind === "agent"
          ? driveAgent(effect, node, input, signal, execute)
          : driveNative(effect, node, input, signal, execute));
    signal.throwIfAborted();
    return store.recordObservation(effect.effectId, observation);
  }

  async function interrupt(
    input: OwnedStepObservationLookupInput,
    signal: AbortSignal,
  ): Promise<OwnedStepObservation> {
    const directoryEffect = baseStore.findEffect(input.effectId);
    if (
      directoryEffect &&
      baseStore.get(directoryEffect.runId).compiled.definition.schemaVersion ===
        4
    )
      return directories.interrupt(directoryEffect, input, signal);
    const effect = lookup(input);
    if (effect === null)
      return {
        state: "not-started",
        reason: "ARC has no admitted effect for this identity",
      };
    if (effect.observation !== null && "receipt" in effect.observation)
      return retained(effect, signal);
    const node = store.get(effect.runId).compiled.nodes[
      runtimeNodeKey(effect.request)
    ];
    if (node.kind === "orchestrator")
      return store.recordObservation(
        effect.effectId,
        await mainTurns.interrupt(effect, node, input, signal),
      );
    if (node.kind === "control") {
      const { run } = await workflows.call(
        "inspectOwnedRun",
        { workflowRunId: input.workflowRunId },
        { signal },
      );
      if (run.desiredControl === "cancel")
        return store.recordObservation(
          effect.effectId,
          controls.cancel(effect),
        );
      const current = await controls.drive(effect, node.operation, signal);
      return store.recordObservation(effect.effectId, current);
    }
    if (effect.nativeRequest !== null) {
      const record = await host.call(
        "interruptEffect",
        {
          runId: effect.runId,
          effectId: effect.effectId,
          requestHash: hostEffectRequestHash(effect.nativeRequest),
        },
        {
          hostId: store.get(effect.runId).compiled.definition.request.hostId,
          signal,
        },
      );
      return record === null
        ? {
            state: "not-started",
            reason: "The host confirms this effect never started",
          }
        : nativeObservation(effect, record, signal);
    }
    const preparation = await bb.experimental_threads.getPreparation(
      { operationId: effect.effectId },
      { signal },
    );
    if (preparation !== null)
      await bb.sdk.threads.stop({ threadId: preparation.threadId });
    return drive(input, signal, false);
  }

  const controls = createGraphControlDriver({
    store,
    dependency,
    validity: originValidity,
  });
  const mainTurns = createOrchestratorTurnDriver({
    bb,
    store,
    canAdvance,
    originValidity: (effect, signal) =>
      originValidity(gitRuntimeEffect(effect), signal),
    async validateGraph(effect, effects, signal) {
      const pass = validationPass(signal);
      const [origin, observations] = await Promise.all([
        originValidity(gitRuntimeEffect(effect), signal, pass),
        Promise.all(
          effects.map((item) => retained(gitRuntimeEffect(item), signal, pass)),
        ),
      ]);
      signal.throwIfAborted();
      return { origin, observations };
    },
  });
  const directories = createDirectoryRuntimeDriver({
    bb,
    store: baseStore,
    canAdvance,
  });

  bb.rpc.experimental_registerInternal(ownedAdapterRpcContract, {
    async executeStep(input, context) {
      if (context.callerPluginId !== "workflows")
        throw new Error("Only Workflows may dispatch ARC run steps");
      if (!(await canAdvance(input, context.signal)))
        throw new Error("This workflow generation cannot dispatch new work");
      store.reserveEffect(input);
      return drive(input, context.signal, true);
    },
    async observeStep(input, context) {
      if (context.callerPluginId !== "workflows")
        throw new Error("Only Workflows may observe ARC run steps");
      return drive(input, context.signal, false);
    },
    async interruptStep(input, context) {
      if (context.callerPluginId !== "workflows")
        throw new Error("Only Workflows may interrupt ARC run steps");
      return interrupt(input, context.signal);
    },
  });
  return {
    host,
    workflows,
    async validateDecision(control: RunControl, signal: AbortSignal) {
      if (control.context.schemaVersion === 2)
        return directories.validateDecision(control, signal);
      const effect = store.effect(control.effectId);
      const { compiled } = store.get(effect.runId);
      if (
        effect.runId !== control.runId ||
        effect.requestHash !== control.context.requestHash ||
        compiled.workflow.planHash !== control.context.planHash
      )
        throw new AgentStoreError(
          "control_conflict",
          "The decision no longer identifies the admitted work",
        );
      const { run } = await workflows.call(
        "inspectOwnedRun",
        { workflowRunId: effect.request.workflowRunId },
        { signal },
      );
      if (
        run.desiredControl === "cancel" ||
        ["succeeded", "failed", "cancelled"].includes(run.state)
      )
        throw new AgentStoreError(
          "control_closed",
          "This run no longer accepts decisions",
        );
      const origin = await originValidity(effect, signal);
      if (origin.state !== "current")
        throw new AgentStoreError("candidate_changed", origin.reason);
      const pass = validationPass(signal);
      for (const proof of effect.request.dependencyReceipts) {
        const retainedEffect = store.effect(proof.effectId);
        const observation = await retained(retainedEffect, signal, pass);
        if (
          !("receipt" in observation) ||
          observation.receiptHash !== proof.receiptHash ||
          observation.state !== proof.outcome ||
          observation.validity.state !== "current"
        )
          throw new AgentStoreError(
            "candidate_changed",
            "The decision's required evidence is no longer current",
          );
      }
      if (control.context.candidate !== null) {
        const candidate = control.context.candidate;
        const actual = await host.call(
          "inspectWorkspace",
          { path: candidate.path, expected: null },
          { hostId: compiled.definition.request.hostId, signal },
        );
        if (!sameWorkspaceState(candidate, actual))
          throw new AgentStoreError(
            "candidate_changed",
            "The files or commit changed after this decision was requested",
          );
      }
    },
    revalidateTerminal(effectId: string, signal: AbortSignal) {
      if (
        baseStore.get(baseStore.effect(effectId).runId).compiled.definition
          .schemaVersion === 4
      )
        throw new AgentStoreError(
          "validation_ack_required",
          "Directory freshness is driven by its authoritative workflow validation acknowledgement",
        );
      return retained(store.effect(effectId), signal);
    },
  };
}

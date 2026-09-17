import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  appendDependencyHandoff,
  responseQuestion,
} from "./collaboration-service.js";
import {
  ownedWorkflowRpcContract,
  ownedStepObservationInputSchema,
  type OwnedStepLookupInput,
  type OwnedStepObservationInput,
  type OwnedStepObservationLookupInput,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import { arcHostContract } from "../host-contract.js";
import {
  directoryEffectRequestSchema,
  type DirectoryBinding,
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
  type DirectorySnapshot,
  type DirectoryState,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import { runtimeNodeKey } from "./compiler.js";
import { createGraphControlDriver } from "./control-driver.js";
import type { RunControl } from "./control-contract.js";
import type { ArcRunEffect, ArcRunStore } from "./data.js";
import { compiledDirectoryRunSchema } from "./directory-compiler.js";
import type { DirectoryRuntimeNode } from "./directory-contract.js";
import { createDirectoryFreshness } from "./directory-freshness.js";
import {
  directoryReceiptSnapshot,
  directoryRuntimeReceiptSchema,
  directoryWorkerBindingSchema,
  directoryReviewVerdictSchema,
  type DirectoryRuntimeReceipt,
} from "./directory-receipt.js";
import type { DirectoryValidationIntent } from "./directory-validation.js";
import { runtimeHash } from "./hash.js";
import {
  assertReviewAuthority,
  reviewAuthorityDiagnostic,
} from "./review-authority.js";
import { createOrchestratorTurnDriver } from "./orchestrated-adapter.js";
import {
  prepareRuntimeWorker,
  runtimeWorkerTerminal,
} from "./prepared-worker.js";

type Target = DirectoryValidationIntent["targets"][number];
type Observation = OwnedStepObservationInput;
type Lookup = OwnedStepObservationLookupInput;
type AgentNode = Extract<DirectoryRuntimeNode, { kind: "agent" }>;
type NativeNode = Exclude<
  DirectoryRuntimeNode,
  { kind: "agent" | "control" | "orchestrator" }
>;

export function createDirectoryRuntimeDriver(deps: {
  bb: BbPluginApi;
  store: ArcRunStore;
  canAdvance(
    input: OwnedStepLookupInput,
    signal: AbortSignal,
  ): Promise<boolean>;
}) {
  const { bb, store, canAdvance } = deps;
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });
  const freshness = createDirectoryFreshness(bb, store);
  const compiled = (effect: ArcRunEffect) =>
    compiledDirectoryRunSchema.parse(store.get(effect.runId).compiled);
  const native = (effect: ArcRunEffect) =>
    effect.nativeRequest === null
      ? null
      : directoryEffectRequestSchema.parse(effect.nativeRequest);
  const binding = (effect: ArcRunEffect) =>
    effect.workerBinding === null
      ? null
      : directoryWorkerBindingSchema.parse(effect.workerBinding);
  function assertLookup(effect: ArcRunEffect, input: Lookup) {
    if (
      effect.runId !== input.ownerRunId ||
      effect.request.workflowRunId !== input.workflowRunId ||
      effect.requestHash !== input.requestHash ||
      runtimeNodeKey(effect.request) !== runtimeNodeKey(input) ||
      effect.request.attempt !== input.attempt ||
      input.dispatchGeneration < effect.generation
    )
      throw new AgentStoreError(
        "scope_denied",
        "This callback does not identify the admitted directory effect",
      );
  }
  function dependency(
    effect: ArcRunEffect,
    ref: OwnedStepRef,
  ): DirectoryRuntimeReceipt {
    const proof = effect.request.dependencyReceipts.find(
      (item) => runtimeNodeKey(item) === runtimeNodeKey(ref),
    );
    if (!proof)
      throw new AgentStoreError(
        "dependency_missing",
        "This directory stage is missing its admitted evidence",
      );
    const retained = store.effect(proof.effectId);
    const observation = retained.observation;
    if (
      retained.runId !== effect.runId ||
      runtimeNodeKey(retained.request) !== runtimeNodeKey(proof) ||
      !observation ||
      !("receipt" in observation) ||
      observation.receiptHash !== proof.receiptHash ||
      observation.state !== proof.outcome
    )
      throw new AgentStoreError(
        "dependency_missing",
        "This directory dependency changed its admitted identity",
      );
    return directoryRuntimeReceiptSchema.parse(observation.receipt);
  }
  function snapshot(
    effect: ArcRunEffect,
    ref: OwnedStepRef,
  ): DirectorySnapshot {
    const value = directoryReceiptSnapshot(dependency(effect, ref));
    if (!value)
      throw new AgentStoreError(
        "candidate_missing",
        "This directory stage has no retained snapshot",
      );
    return value;
  }
  function working(effect: ArcRunEffect, ref: OwnedStepRef): DirectoryBinding {
    const receipt = dependency(effect, ref);
    if (
      !("kind" in receipt) ||
      receipt.kind !== "directory-native" ||
      receipt.request.operation.type !== "materialize-directory" ||
      receipt.receipt.artifact?.kind !== "working" ||
      receipt.receipt.outcome !== "succeeded"
    )
      throw new AgentStoreError(
        "workspace_missing",
        "This worker requires its exact materialized directory",
      );
    return receipt.receipt.artifact.workspace;
  }
  function target(
    state: DirectoryState | DirectoryBinding,
    manifestDigest: string | null = "manifestDigest" in state
      ? state.manifestDigest
      : state.expectedManifestDigest,
  ): Target {
    const root = {
      kind: "directory" as const,
      path: state.path,
      rootIdentity: state.rootIdentity,
    };
    return {
      target:
        "workspaceId" in state &&
        manifestDigest === state.expectedManifestDigest
          ? state
          : root,
      expected: { ...root, manifestDigest },
    };
  }
  function evidenceTargets(
    effect: ArcRunEffect,
    includeOwn: boolean,
    additional: Target[] = [],
  ): Target[] {
    const definition = compiled(effect).definition;
    const targets = new Map<string, Target>();
    function add(value: Target) {
      const prior = targets.get(value.expected.path);
      if (
        prior &&
        (runtimeHash(prior.expected.rootIdentity) !==
          runtimeHash(value.expected.rootIdentity) ||
          (prior.expected.manifestDigest !== null &&
            value.expected.manifestDigest !== null &&
            prior.expected.manifestDigest !== value.expected.manifestDigest))
      )
        throw new AgentStoreError(
          "candidate_changed",
          "Directory evidence disagrees about the exact retained files",
        );
      if (!prior || value.expected.manifestDigest !== null)
        targets.set(value.expected.path, value);
    }
    add(target(definition.source));
    const seen = new Set<string>();
    function visit(item: ArcRunEffect, own: boolean) {
      if (seen.has(item.effectId)) return;
      if (seen.size >= 4096)
        throw new AgentStoreError(
          "receipt_conflict",
          "Directory evidence exceeds the admitted graph bound",
        );
      seen.add(item.effectId);
      for (const proof of item.request.dependencyReceipts) {
        const prior = store.effect(proof.effectId);
        const observation = prior.observation;
        if (
          prior.runId !== effect.runId ||
          !observation ||
          !("receipt" in observation) ||
          observation.receiptHash !== proof.receiptHash ||
          observation.state !== proof.outcome
        )
          throw new AgentStoreError(
            "receipt_conflict",
            "A directory dependency no longer matches its exact admitted receipt",
          );
        visit(prior, true);
      }
      if (!own || !item.observation || !("receipt" in item.observation)) return;
      const node = compiled(item).nodes[runtimeNodeKey(item.request)];
      if (
        node.kind === "orchestrator" ||
        (node.kind === "control" && item.observation.state === "interrupted")
      )
        return;
      const receipt = directoryRuntimeReceiptSchema.parse(
        item.observation.receipt,
      );
      const candidate = directoryReceiptSnapshot(receipt);
      if (candidate) add(target(candidate.workspace, candidate.manifestDigest));
      if ("kind" in receipt && receipt.kind === "directory-agent") {
        const observed =
          receipt.observed ?? store.directories.workerOutput(item.effectId);
        if (observed)
          add(
            target(
              observed,
              node.kind === "agent" &&
                node.access === "write" &&
                item.observation.state !== "succeeded"
                ? null
                : observed.manifestDigest,
            ),
          );
        else
          add(
            target(
              receipt.workspace,
              node.kind === "agent" && node.access === "write"
                ? null
                : receipt.snapshot.manifestDigest,
            ),
          );
      }
      if (
        "kind" in receipt &&
        receipt.kind === "directory-native" &&
        receipt.request.operation.type === "check-directory"
      )
        add(target(receipt.request.operation.workspace));
    }
    visit(effect, includeOwn);
    for (const item of additional) add(item);
    return [...targets.values()].sort((a, b) =>
      a.expected.path.localeCompare(b.expected.path),
    );
  }
  const pending = (
    reason: string,
    resource:
      | Extract<Observation, { state: "running" }>["resource"]
      | null = null,
  ): Observation =>
    resource === null
      ? { state: "not-started", reason }
      : { state: "running", resource };
  async function inspect(
    effect: ArcRunEffect,
    input: Lookup,
    purpose: string,
    targets: Target[],
    signal: AbortSignal,
    terminal = false,
  ) {
    return freshness.validate(
      effect,
      input,
      {
        purpose,
        phase: terminal ? "revalidate" : "before-release",
        targets,
        terminal,
      },
      signal,
    );
  }
  function invalidReason(effect: ArcRunEffect): string | null {
    const observation = effect.observation;
    if (!observation || !("receipt" in observation)) return null;
    const authority = reviewAuthorityDiagnostic(
      compiled(effect),
      effect.request,
    );
    if (authority) return authority.message;
    const node = compiled(effect).nodes[runtimeNodeKey(effect.request)];
    if (
      node.kind === "orchestrator" ||
      (node.kind === "control" && observation.state === "interrupted")
    )
      return null;
    const receipt = directoryRuntimeReceiptSchema.parse(observation.receipt);
    return "kind" in receipt &&
      receipt.kind === "directory-native" &&
      receipt.receipt.outcome === "invalid"
      ? (receipt.receipt.reason ??
          "The native directory operation rejected its exact preconditions")
      : null;
  }
  async function retained(
    effect: ArcRunEffect,
    input: Lookup,
    signal: AbortSignal,
  ): Promise<Observation> {
    const observation = effect.observation;
    if (!observation || !("receipt" in observation))
      throw new Error("A terminal directory receipt is required");
    if (!(await canAdvance(input, signal)))
      return interrupt(effect, input, signal);
    const terminalNode = compiled(effect).nodes[runtimeNodeKey(effect.request)];
    const priorPass = store.directories.latestValidation(
      effect.effectId,
      input.dispatchGeneration,
      "terminal",
    );
    const acknowledgment = "validation" in input ? input.validation : null;
    const continuedTargets =
      priorPass &&
      !priorPass.quiescent &&
      !(
        acknowledgment?.state === "current" &&
        acknowledgment.validationId === priorPass.validationId &&
        acknowledgment.generation === input.dispatchGeneration
      )
        ? priorPass.intent.targets
        : null;
    const pass = await inspect(
      effect,
      input,
      "terminal",
      continuedTargets ??
        (terminalNode.kind === "orchestrator"
          ? graphTargets(effect)
          : evidenceTargets(effect, true)),
      signal,
      true,
    );
    let validity = pass.validity;
    if (validity.state === "current") {
      const reason = invalidReason(effect);
      if (reason)
        validity = {
          state: "stale",
          validationId: pass.pass.validationId,
          reason,
        };
      const node = compiled(effect).nodes[runtimeNodeKey(effect.request)];
      if (node.kind === "agent" && effect.threadId !== null) {
        const receipt = directoryRuntimeReceiptSchema.parse(
          observation.receipt,
        );
        if ("kind" in receipt && receipt.kind === "directory-agent") {
          const preparation = await bb.experimental_threads.getPreparation(
            { operationId: effect.effectId },
            { signal },
          );
          const terminal =
            preparation?.dispatch?.clientTurnRequestId ===
              receipt.turnRequestId && preparation.threadId === receipt.threadId
              ? await runtimeWorkerTerminal(
                  bb,
                  receipt.threadId,
                  receipt.turnRequestId,
                  signal,
                )
              : null;
          if (
            terminal?.id !== receipt.terminalEventId ||
            terminal.status !== receipt.terminalStatus
          )
            validity = {
              state: "stale",
              validationId: pass.pass.validationId,
              reason:
                "The worker no longer matches its retained native accepted and terminal identity",
            };
          if (
            validity.state === "current" &&
            receipt.observed === null &&
            receipt.terminalStatus !== "interrupted"
          ) {
            const observed = pass.states.find(
              (value) => value.path === receipt.workspace.path,
            );
            if (!observed)
              throw new Error(
                "The completed worker output is missing from its exact validation pass",
              );
            store.directories.recordWorkerOutput(
              effect.effectId,
              receipt.terminalEventId,
              observed,
            );
          }
        }
      }
      if (node.kind === "orchestrator") {
        const checked = await mainDriver(input, pass).validate(effect, signal);
        if ("receipt" in checked && checked.validity.state === "stale")
          validity = {
            state: "stale",
            validationId: pass.pass.validationId,
            reason: checked.validity.reason,
          };
      }
    }
    signal.throwIfAborted();
    return store.recordObservation(
      effect.effectId,
      ownedStepObservationInputSchema.parse({ ...observation, validity }),
    );
  }
  function buildNative(
    effect: ArcRunEffect,
    node: NativeNode,
  ): { request: DirectoryEffectRequest; candidate: DirectorySnapshot | null } {
    const base = {
      kind: "directory" as const,
      runId: effect.runId,
      effectId: effect.effectId,
      lane: effect.request.lane,
    };
    if (node.kind === "capture-source")
      return {
        request: {
          ...base,
          operation: {
            type: "capture-source",
            source: compiled(effect).definition.source,
            workspaceId: node.workspaceKey,
          },
        },
        candidate: null,
      };
    if (node.kind === "materialize-directory") {
      const candidate = snapshot(effect, node.candidate);
      return {
        request: {
          ...base,
          operation: {
            type: "materialize-directory",
            source: candidate,
            workspaceId: node.workspaceKey,
          },
        },
        candidate,
      };
    }
    if (node.kind === "capture-directory") {
      const worker = dependency(effect, node.worker);
      if (
        !("kind" in worker) ||
        worker.kind !== "directory-agent" ||
        worker.terminalStatus !== "completed"
      )
        throw new AgentStoreError(
          "worker_missing",
          "Only an exact completed worker can seal a directory candidate",
        );
      const proof = effect.request.dependencyReceipts.find(
        (value) => runtimeNodeKey(value) === runtimeNodeKey(node.worker),
      );
      const observed =
        worker.observed ??
        (proof ? store.directories.workerOutput(proof.effectId) : null);
      if (!observed)
        throw new AgentStoreError(
          "worker_missing",
          "The completed directory worker has no bound output inventory",
        );
      return {
        request: {
          ...base,
          operation: {
            type: "capture-directory",
            source: {
              ...worker.workspace,
              expectedManifestDigest: observed.manifestDigest,
            },
            workspaceId: node.workspaceKey,
          },
        },
        candidate: null,
      };
    }
    if (node.kind === "check") {
      const candidate = snapshot(effect, node.candidate);
      const workspace = working(effect, node.workspace);
      if (workspace.expectedManifestDigest !== candidate.manifestDigest)
        throw new AgentStoreError(
          "candidate_changed",
          "The check workspace does not contain its selected snapshot",
        );
      return {
        request: {
          ...base,
          operation: {
            type: "check-directory",
            workspace,
            snapshotId: candidate.snapshotId,
            ...node.command,
          },
        },
        candidate,
      };
    }
    const checked = snapshot(effect, node.check);
    const review = dependency(effect, node.review);
    const reviewProof = effect.request.dependencyReceipts.find(
      (value) => runtimeNodeKey(value) === runtimeNodeKey(node.review),
    );
    const reviewed =
      "kind" in review && review.kind === "directory-agent"
        ? (review.observed ??
          (reviewProof
            ? store.directories.workerOutput(reviewProof.effectId)
            : null))
        : null;
    if (
      !("kind" in review) ||
      review.kind !== "directory-agent" ||
      review.review?.outcome !== "approved" ||
      runtimeHash(review.snapshot) !== runtimeHash(checked) ||
      review.review.snapshotId !== checked.snapshotId ||
      review.review.manifestDigest !== checked.manifestDigest ||
      reviewed?.manifestDigest !== checked.manifestDigest
    )
      throw new AgentStoreError(
        "candidate_changed",
        "Final review and check must approve exactly the same retained directory snapshot",
      );
    const proof = effect.request.dependencyReceipts.find(
      (value) => runtimeNodeKey(value) === runtimeNodeKey(node.check),
    );
    if (!proof)
      throw new AgentStoreError(
        "check_missing",
        "The final directory check has no admitted proof",
      );
    const checkedReceipt = controls().checkReceipt(effect, proof);
    if (
      checkedReceipt.proof.outcome !== "succeeded" ||
      checkedReceipt.receipt.kind !== "directory-native" ||
      checkedReceipt.receipt.receipt.outcome !== "succeeded" ||
      runtimeHash(checkedReceipt.receipt.candidate) !== runtimeHash(checked)
    )
      throw new AgentStoreError(
        "check_failed",
        "The final directory candidate requires its actual successful native check",
      );
    return {
      request: {
        ...base,
        lane: null,
        operation: {
          type: "scan-directory",
          target: checked.workspace,
          consumer: {
            kind: "effect",
            effectId: effect.effectId,
            dispatchGeneration: effect.generation,
          },
          phase: "revalidate",
          validationId: `arc_final_${runtimeHash({ effectId: effect.effectId, requestHash: effect.requestHash })}`,
        },
      },
      candidate: checked,
    };
  }
  async function nativeObservation(
    effect: ArcRunEffect,
    record: DirectoryEffectRecord,
    input: Lookup,
    signal: AbortSignal,
    revalidate = true,
  ): Promise<Observation> {
    const request = native(effect);
    if (
      !request ||
      record.effectId !== effect.effectId ||
      record.runId !== effect.runId ||
      record.requestHash !== directoryEffectRequestHash(request)
    )
      throw new AgentStoreError(
        "receipt_conflict",
        "The host result does not identify the exact directory operation",
      );
    const resource = {
      kind: "host-effect" as const,
      hostId: compiled(effect).definition.request.hostId,
      effectId: effect.effectId,
    };
    if (record.state === "running") return { state: "running", resource };
    if (record.state !== "terminal" || !record.receipt)
      return {
        state: "needs-reconciliation",
        reason: "The directory operation has no confirmed terminal receipt",
      };
    const node = compiled(effect).nodes[runtimeNodeKey(effect.request)];
    if (
      node.kind === "agent" ||
      node.kind === "control" ||
      node.kind === "orchestrator"
    )
      throw new Error("A native directory node is required");
    const candidate =
      record.receipt.artifact?.kind === "snapshot"
        ? record.receipt.artifact.snapshot
        : buildNative(effect, node).candidate;
    const receipt = directoryRuntimeReceiptSchema.parse({
      kind: "directory-native",
      request,
      receipt: record.receipt,
      candidate,
    });
    const observation = ownedStepObservationInputSchema.parse({
      state:
        record.receipt.outcome === "succeeded"
          ? "succeeded"
          : record.receipt.outcome === "interrupted"
            ? "interrupted"
            : "failed",
      resource,
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: effect.requestHash },
    });
    store.recordObservation(effect.effectId, observation);
    return revalidate
      ? retained(store.effect(effect.effectId), input, signal)
      : observation;
  }
  async function driveNative(
    effect: ArcRunEffect,
    node: NativeNode,
    input: Lookup,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<Observation> {
    const hostId = compiled(effect).definition.request.hostId;
    let request = native(effect);
    if (request) {
      const prior = await host.call(
        "observeDirectoryEffect",
        {
          runId: effect.runId,
          effectId: effect.effectId,
          requestHash: directoryEffectRequestHash(request),
        },
        { hostId, signal },
      );
      if (prior) return nativeObservation(effect, prior, input, signal);
    }
    if (!execute || !(await canAdvance(input, signal)))
      return pending("The directory operation has not been dispatched");
    assertReviewAuthority(compiled(effect), effect.request);
    const pass = await inspect(
      effect,
      input,
      "native-admission",
      evidenceTargets(effect, false),
      signal,
    );
    if (pass.validity.state !== "current")
      return pass.validity.state === "checking"
        ? pending(pass.validity.reason)
        : { state: "needs-reconciliation", reason: pass.validity.reason };
    if (!request) {
      request = buildNative(effect, node).request;
      store.sealNative(effect.effectId, request);
      effect = store.effect(effect.effectId);
    }
    if (!(await canAdvance(input, signal)))
      return pending(
        "The run paused before this directory operation was released",
      );
    freshness.consume(pass.pass);
    return nativeObservation(
      effect,
      await host.call("startDirectoryEffect", request, { hostId, signal }),
      input,
      signal,
    );
  }
  async function driveAgent(
    effect: ArcRunEffect,
    node: AgentNode,
    input: Lookup,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<Observation> {
    const definition = compiled(effect).definition;
    const advance = await canAdvance(input, signal);
    const authority = reviewAuthorityDiagnostic(
      compiled(effect),
      effect.request,
    );
    let sealed = binding(effect);
    if (!sealed) {
      if (!execute || !advance)
        return pending("The directory worker has not been prepared");
      assertReviewAuthority(compiled(effect), effect.request);
      let workspace = working(effect, node.workspace);
      const candidate = snapshot(effect, node.candidate);
      const previous = store.previousAttempt(effect.request);
      if (previous?.observation?.state === "interrupted") {
        const prior = directoryRuntimeReceiptSchema.parse(
          previous.observation.receipt,
        );
        if ("kind" in prior && prior.kind === "directory-agent") {
          if (
            runtimeHash(prior.snapshot) !== runtimeHash(candidate) ||
            runtimeHash(prior.workspace.rootIdentity) !==
              runtimeHash(workspace.rootIdentity) ||
            prior.workspace.path !== workspace.path
          )
            throw new AgentStoreError(
              "candidate_changed",
              "The interrupted worker belongs to another directory candidate",
            );
          if (prior.observed === null) {
            const pass = await inspect(
              effect,
              input,
              "retry-inventory",
              evidenceTargets(effect, false, [target(workspace, null)]),
              signal,
            );
            if (pass.validity.state !== "current")
              return pass.validity.state === "checking"
                ? pending(pass.validity.reason)
                : {
                    state: "needs-reconciliation",
                    reason: pass.validity.reason,
                  };
            const state = pass.states.find(
              (value) => value.path === workspace.path,
            );
            if (!state)
              throw new Error("The interrupted directory inventory is missing");
            workspace = {
              ...workspace,
              expectedManifestDigest: state.manifestDigest,
            };
            freshness.consume(pass.pass);
          } else
            workspace = {
              ...workspace,
              expectedManifestDigest: prior.observed.manifestDigest,
            };
        }
      }
      const failure =
        node.failure === null ? null : dependency(effect, node.failure);
      const taskPrompt = [
        ...(node.replyDecision
          ? [
              `Selected question for this admitted response: ${JSON.stringify(responseQuestion(store, effect, node.replyDecision))}`,
            ]
          : []),
        `Project goal: ${definition.request.goal}`,
        `Your task: ${node.task}`,
        `Work only in your assigned directory ${workspace.path}. Input snapshot: ${candidate.snapshotId}. Input manifest: ${candidate.manifestDigest}.`,
        "ARC retains the original project and immutable snapshots separately. Do not initialize Git, change required check configuration, touch another directory, push, or deploy. ARC captures your completed files and runs the required check outside this turn.",
        node.purpose === "review"
          ? `Review without editing files. Call arc_run_review with kind directory, snapshotId ${candidate.snapshotId}, manifestDigest ${candidate.manifestDigest}, approved or changes-requested outcome, summary and concrete findings. Chat completion alone does not approve the candidate.`
          : node.purpose === "delegation"
            ? "Inspect without editing files. Call arc_run_delegate with ordered assignments to the declared candidate members. Each child consumes a separately admitted call; you cannot start a child or change the graph or permissions."
            : node.access === "read"
              ? "Inspect without editing any files and report actual findings."
              : "Implement the assigned work and report the actual changes and results.",
        failure === null
          ? ""
          : `The required check failed. Repair the implementation while preserving the required check. Native failure evidence (bounded excerpt, up to 16,000 characters): ${JSON.stringify(failure).slice(0, 16_000)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const prompt = appendDependencyHandoff(
        store,
        effect.effectId,
        taskPrompt,
      );
      store.sealWorker(effect.effectId, {
        kind: "directory",
        workspace,
        snapshot: candidate,
        prompt,
      });
      effect = store.effect(effect.effectId);
      sealed = binding(effect)!;
    }
    let preparation = await prepareRuntimeWorker(
      bb,
      store,
      effect,
      {
        projectId: definition.request.projectId,
        parentThreadId: definition.request.originThreadId,
        hostId: definition.request.hostId,
        path: sealed.workspace.path,
        prompt: sealed.prompt,
        title: `${node.agent.definition.metadata.name} · ${node.purpose}`,
        execution: node.agent.execution,
      },
      signal,
      execute && advance && authority === null,
    );
    if (!preparation)
      return authority
        ? { state: "needs-reconciliation", reason: authority.message }
        : pending("Core confirms this directory worker has not been prepared");
    const resource = () => ({
      kind: "agent" as const,
      threadId: preparation!.threadId,
      executionContextId: effect.executionContextId,
      environmentId: preparation!.environment?.environmentId ?? null,
      turnRequestId: preparation!.dispatch?.clientTurnRequestId ?? null,
    });
    if (preparation.state === "prepared" && advance) {
      if (authority)
        return {
          state: "needs-reconciliation",
          reason: authority.message,
        };
      const pass = await inspect(
        effect,
        input,
        `worker-release:${preparation.revision}`,
        evidenceTargets(effect, false, [target(sealed.workspace)]),
        signal,
      );
      if (pass.validity.state !== "current")
        return pass.validity.state === "checking"
          ? pending(pass.validity.reason, resource())
          : { state: "needs-reconciliation", reason: pass.validity.reason };
      if (await canAdvance(input, signal)) {
        freshness.consume(pass.pass);
        preparation = await bb.experimental_threads.startPrepared(
          {
            operationId: effect.effectId,
            expectedRevision: preparation.revision,
            environment: preparation.environment,
          },
          { signal },
        );
      }
    }
    const owned = resource();
    if (
      (preparation.state === "cancelled" || preparation.state === "failed") &&
      owned.turnRequestId === null
    ) {
      const receipt = directoryRuntimeReceiptSchema.parse({
        kind: "directory-preparation",
        operationId: effect.effectId,
        threadId: preparation.threadId,
        revision: preparation.revision,
        state: preparation.state,
        reason: preparation.reason,
      });
      store.recordObservation(
        effect.effectId,
        ownedStepObservationInputSchema.parse({
          state: preparation.state === "cancelled" ? "interrupted" : "failed",
          resource: owned,
          receipt,
          receiptHash: runtimeHash(receipt),
          validity: { state: "current", identityHash: effect.requestHash },
        }),
      );
      return retained(store.effect(effect.effectId), input, signal);
    }
    const unresolved: Observation = [
      "needs-reconciliation",
      "failed",
      "cancelled",
    ].includes(preparation.state)
      ? {
          state: "needs-reconciliation",
          reason:
            preparation.reason ??
            "The directory worker has no confirmed native terminal identity",
        }
      : { state: "running", resource: owned };
    if (!owned.turnRequestId) return unresolved;
    const completed = await runtimeWorkerTerminal(
      bb,
      owned.threadId,
      owned.turnRequestId,
      signal,
    );
    if (!completed) return unresolved;
    const pass = await inspect(
      effect,
      input,
      `worker-result:${owned.turnRequestId}`,
      evidenceTargets(effect, false, [
        target(
          sealed.workspace,
          node.access === "write" ? null : sealed.snapshot.manifestDigest,
        ),
      ]),
      signal,
    );
    if (pass.validity.state !== "current")
      return pass.validity.state === "checking"
        ? pending(pass.validity.reason, owned)
        : { state: "needs-reconciliation", reason: pass.validity.reason };
    const observed = pass.states.find(
      (state) => state.path === sealed.workspace.path,
    );
    if (!observed) throw new Error("The completed worker inventory is missing");
    const reviewInput = store.effect(effect.effectId).review;
    const review =
      reviewInput === null
        ? null
        : directoryReviewVerdictSchema.parse(reviewInput);
    const succeeded =
      completed.status === "completed" &&
      (node.replyDecision === undefined ||
        store.collaboration.hasReply(
          effect.runId,
          responseQuestion(store, effect, node.replyDecision)!.id,
        )) &&
      (node.purpose !== "delegation" ||
        store.controls.delegation(effect.effectId) !== null) &&
      (node.purpose !== "review" ||
        (review?.outcome === "approved" &&
          review.snapshotId === sealed.snapshot.snapshotId &&
          review.manifestDigest === sealed.snapshot.manifestDigest));
    const receipt = directoryRuntimeReceiptSchema.parse({
      kind: "directory-agent",
      threadId: owned.threadId,
      executionContextId: owned.executionContextId,
      turnRequestId: owned.turnRequestId,
      terminalEventId: completed.id,
      terminalStatus: completed.status,
      workspace: sealed.workspace,
      snapshot: sealed.snapshot,
      observed,
      review,
      definitionHash: effect.request.definitionHash,
    });
    store.recordObservation(
      effect.effectId,
      ownedStepObservationInputSchema.parse({
        state: succeeded
          ? "succeeded"
          : completed.status === "interrupted"
            ? "interrupted"
            : "failed",
        resource: owned,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: pass.validity,
      }),
    );
    return retained(store.effect(effect.effectId), input, signal);
  }
  function controls() {
    return createGraphControlDriver({
      store,
      dependency,
      async validity(effect) {
        return { state: "current", identityHash: effect.requestHash };
      },
    });
  }
  function mainDriver(
    input: Lookup,
    retainedPass?: Awaited<ReturnType<typeof inspect>>,
  ) {
    const usedPasses: Array<Awaited<ReturnType<typeof inspect>>["pass"]> = [];
    return createOrchestratorTurnDriver({
      bb,
      store,
      canAdvance,
      async originValidity(effect, signal) {
        if (retainedPass) return retainedPass.validity;
        if (!(await canAdvance(input, signal))) {
          const pass = store.directories.reserveValidation(
            {
              runId: effect.runId,
              effectId: effect.effectId,
              generation: input.dispatchGeneration,
              purpose: "terminal",
              phase: "revalidate",
              targets: graphTargets(effect),
            },
            false,
          );
          freshness.consume(pass);
          return {
            state: "checking",
            validationId: pass.validationId,
            activity: "quiescent",
            reason: "The main response inventory is paused",
          };
        }
        const preparation = await bb.experimental_turns.getPreparation(
          { operationId: effect.effectId },
          { signal },
        );
        if (preparation?.turn?.terminalEventId)
          return { state: "current", identityHash: effect.requestHash };
        const pass = await inspect(
          effect,
          input,
          `main-release:${preparation?.revision ?? 0}`,
          graphTargets(effect),
          signal,
        );
        usedPasses.push(pass.pass);
        return pass.validity;
      },
      async validateGraph(effect, effects, signal) {
        const pass = await inspect(
          effect,
          input,
          "main-graph",
          graphTargets(effect),
          signal,
        );
        usedPasses.push(pass.pass);
        return {
          origin: pass.validity,
          observations: effects.map((item) => {
            const value = item.observation;
            if (!value || !("receipt" in value))
              throw new Error(
                "Main completion requires retained terminal graph evidence",
              );
            const reason = invalidReason(item);
            return ownedStepObservationInputSchema.parse({
              ...value,
              validity:
                reason === null || pass.validity.state !== "current"
                  ? pass.validity
                  : {
                      state: "stale",
                      validationId: pass.pass.validationId,
                      reason,
                    },
            });
          }),
        };
      },
      invalidateValidation() {
        for (const pass of usedPasses) freshness.consume(pass);
      },
    });
  }
  function graphTargets(effect: ArcRunEffect): Target[] {
    const targets = new Map<string, Target>();
    for (const item of store.completionEffects(effect.runId))
      for (const value of evidenceTargets(item, true)) {
        const prior = targets.get(value.expected.path);
        if (
          prior &&
          prior.expected.manifestDigest !== null &&
          value.expected.manifestDigest !== null &&
          runtimeHash(prior.expected) !== runtimeHash(value.expected)
        )
          throw new AgentStoreError(
            "candidate_changed",
            "The settled graph disagrees about its retained directory evidence",
          );
        if (!prior || value.expected.manifestDigest !== null)
          targets.set(value.expected.path, value);
      }
    return [...targets.values()].sort((a, b) =>
      a.expected.path.localeCompare(b.expected.path),
    );
  }
  async function drive(
    effect: ArcRunEffect,
    input: Lookup,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<Observation> {
    assertLookup(effect, input);
    if (!(await canAdvance(input, signal)))
      return interrupt(effect, input, signal);
    if (effect.observation && "receipt" in effect.observation)
      return retained(effect, input, signal);
    const node = compiled(effect).nodes[runtimeNodeKey(effect.request)];
    let observation: Observation;
    if (node.kind === "orchestrator")
      observation = await mainDriver(input).drive(
        effect,
        node,
        input,
        signal,
        execute,
      );
    else if (node.kind === "agent")
      observation = await driveAgent(effect, node, input, signal, execute);
    else if (node.kind === "control") {
      const control = store.controls.find(effect.runId, effect.effectId);
      if (
        control?.state === "pending" &&
        effect.observation?.state === "waiting"
      )
        return effect.observation;
      const pass = await inspect(
        effect,
        input,
        `control:${control?.revision ?? 0}`,
        evidenceTargets(effect, false),
        signal,
      );
      if (pass.validity.state !== "current")
        return pass.validity.state === "checking"
          ? {
              state: "waiting",
              resource: { kind: "owner-control", controlId: effect.effectId },
              revision: control?.revision ?? 0,
              waitReason: "dependency",
            }
          : { state: "needs-reconciliation", reason: pass.validity.reason };
      observation = await controls().drive(effect, node.operation, signal);
      if (observation.state === "waiting") freshness.consume(pass.pass);
    } else
      observation = await driveNative(effect, node, input, signal, execute);
    signal.throwIfAborted();
    const saved = store.recordObservation(effect.effectId, observation);
    return "receipt" in saved
      ? retained(store.effect(effect.effectId), input, signal)
      : saved;
  }
  async function interrupt(
    effect: ArcRunEffect,
    input: Lookup,
    signal: AbortSignal,
  ): Promise<Observation> {
    assertLookup(effect, input);
    const scansStopped = await freshness.interrupt(effect, signal);
    if (effect.observation && "receipt" in effect.observation) {
      const acknowledged = "validation" in input ? input.validation : null;
      const retainedId =
        acknowledged?.validationId ??
        ("validationId" in effect.observation.validity
          ? effect.observation.validity.validationId
          : null);
      let pass =
        retainedId === null
          ? store.directories.latestValidation(
              effect.effectId,
              input.dispatchGeneration,
              "terminal",
            )
          : store.directories.validation(retainedId);
      if (
        pass &&
        (pass.intent.effectId !== effect.effectId ||
          pass.intent.runId !== effect.runId)
      )
        throw new AgentStoreError(
          "validation_conflict",
          "The paused validation belongs to another admitted directory effect",
        );
      if (!pass)
        pass = store.directories.reserveValidation(
          {
            runId: effect.runId,
            effectId: effect.effectId,
            generation: input.dispatchGeneration,
            purpose: "terminal",
            phase: "revalidate",
            targets: evidenceTargets(effect, true),
          },
          false,
        );
      if (scansStopped) freshness.consume(pass);
      return store.recordObservation(effect.effectId, {
        ...effect.observation,
        validity: {
          state: "checking",
          validationId: pass.validationId,
          activity: scansStopped ? "quiescent" : "running",
          reason: scansStopped
            ? "Directory validation is paused"
            : "Waiting for directory inspections to stop",
        },
      });
    }
    const node = compiled(effect).nodes[runtimeNodeKey(effect.request)];
    if (node.kind === "orchestrator") {
      const observation = store.recordObservation(
        effect.effectId,
        await mainDriver(input).interrupt(effect, node, input, signal),
      );
      return "receipt" in observation
        ? interrupt(store.effect(effect.effectId), input, signal)
        : observation;
    }
    if (node.kind === "control") {
      const { run } = await workflows.call(
        "inspectOwnedRun",
        { workflowRunId: input.workflowRunId },
        { signal },
      );
      if (run.desiredControl === "cancel")
        return store.recordObservation(
          effect.effectId,
          controls().cancel(effect),
        );
      return (
        effect.observation ??
        pending("The pending directory decision is paused")
      );
    }
    const request = native(effect);
    if (request) {
      const record = await host.call(
        "interruptDirectoryEffect",
        {
          runId: effect.runId,
          effectId: effect.effectId,
          requestHash: directoryEffectRequestHash(request),
        },
        { hostId: compiled(effect).definition.request.hostId, signal },
      );
      if (!record)
        return pending("The host confirms this directory effect never started");
      const observation = await nativeObservation(
        effect,
        record,
        input,
        signal,
        false,
      );
      if ("receipt" in observation)
        return interrupt(store.effect(effect.effectId), input, signal);
      return observation;
    }
    const preparation = await bb.experimental_threads.getPreparation(
      { operationId: effect.effectId },
      { signal },
    );
    if (!preparation)
      return pending("Core confirms this directory worker was never prepared");
    await bb.sdk.threads.stop({ threadId: preparation.threadId });
    const requestId = preparation.dispatch?.clientTurnRequestId;
    const sealed = binding(effect);
    if (requestId && sealed) {
      const completed = await runtimeWorkerTerminal(
        bb,
        preparation.threadId,
        requestId,
        signal,
      );
      if (completed) {
        const storedReview = store.effect(effect.effectId).review;
        const review =
          storedReview === null
            ? null
            : directoryReviewVerdictSchema.parse(storedReview);
        const succeeded =
          completed.status === "completed" &&
          (node.kind !== "agent" ||
            ((node.purpose !== "delegation" ||
              store.controls.delegation(effect.effectId) !== null) &&
              (node.purpose !== "review" ||
                (review?.outcome === "approved" &&
                  review.snapshotId === sealed.snapshot.snapshotId &&
                  review.manifestDigest === sealed.snapshot.manifestDigest))));
        const receipt = directoryRuntimeReceiptSchema.parse({
          kind: "directory-agent",
          threadId: preparation.threadId,
          executionContextId: effect.executionContextId,
          turnRequestId: requestId,
          terminalEventId: completed.id,
          terminalStatus: completed.status,
          workspace: sealed.workspace,
          snapshot: sealed.snapshot,
          observed: null,
          review,
          definitionHash: effect.request.definitionHash,
        });
        store.recordObservation(
          effect.effectId,
          ownedStepObservationInputSchema.parse({
            state:
              completed.status === "interrupted"
                ? "interrupted"
                : succeeded
                  ? "succeeded"
                  : "failed",
            resource: {
              kind: "agent",
              threadId: preparation.threadId,
              executionContextId: effect.executionContextId,
              environmentId: preparation.environment?.environmentId ?? null,
              turnRequestId: requestId,
            },
            receipt,
            receiptHash: runtimeHash(receipt),
            validity: { state: "current", identityHash: effect.requestHash },
          }),
        );
        return interrupt(store.effect(effect.effectId), input, signal);
      }
      return {
        state: "running",
        resource: {
          kind: "agent",
          threadId: preparation.threadId,
          executionContextId: effect.executionContextId,
          environmentId: preparation.environment?.environmentId ?? null,
          turnRequestId: requestId,
        },
      };
    }
    const stopped = await bb.experimental_threads.getPreparation(
      { operationId: effect.effectId },
      { signal },
    );
    if (stopped?.state === "cancelled" || stopped?.state === "failed") {
      const receipt = directoryRuntimeReceiptSchema.parse({
        kind: "directory-preparation",
        operationId: effect.effectId,
        threadId: stopped.threadId,
        revision: stopped.revision,
        state: stopped.state,
        reason: stopped.reason,
      });
      store.recordObservation(
        effect.effectId,
        ownedStepObservationInputSchema.parse({
          state: stopped.state === "cancelled" ? "interrupted" : "failed",
          resource: {
            kind: "agent",
            threadId: stopped.threadId,
            executionContextId: effect.executionContextId,
            environmentId: stopped.environment?.environmentId ?? null,
            turnRequestId: null,
          },
          receipt,
          receiptHash: runtimeHash(receipt),
          validity: { state: "current", identityHash: effect.requestHash },
        }),
      );
      return interrupt(store.effect(effect.effectId), input, signal);
    }
    return {
      state: "needs-reconciliation",
      reason:
        "The stopped directory worker has no confirmed terminal preparation",
    };
  }
  return {
    drive,
    interrupt,
    async validateDecision(control: RunControl, signal: AbortSignal) {
      const effect = store.effect(control.effectId);
      const plan = compiled(effect);
      if (
        control.context.schemaVersion !== 2 ||
        control.runId !== effect.runId ||
        control.context.requestHash !== effect.requestHash ||
        control.context.planHash !== plan.workflow.planHash
      )
        throw new AgentStoreError(
          "control_conflict",
          "This decision no longer identifies the exact directory plan",
        );
      const { run } = await workflows.call(
        "inspectOwnedRun",
        { workflowRunId: effect.request.workflowRunId },
        { signal },
      );
      const decisionLookup = {
        ...effect.request,
        dispatchGeneration: run.dispatchGeneration,
      };
      if (!(await canAdvance(decisionLookup, signal)))
        throw new AgentStoreError(
          "control_closed",
          "Resume this directory run before deciding its pending work",
        );
      const pass = await inspect(
        effect,
        decisionLookup,
        `decision:${control.contextHash}:${control.revision}`,
        evidenceTargets(
          effect,
          false,
          control.context.candidate === null
            ? []
            : [
                target(
                  control.context.candidate.workspace,
                  control.context.candidate.manifestDigest,
                ),
              ],
        ),
        signal,
      );
      if (!(await canAdvance(decisionLookup, signal))) {
        await freshness.interrupt(effect, signal);
        throw new AgentStoreError(
          "control_closed",
          "This directory run paused before the decision could be applied",
        );
      }
      if (pass.validity.state !== "current")
        throw new AgentStoreError(
          pass.validity.state === "checking"
            ? "validation_pending"
            : "candidate_changed",
          pass.validity.reason,
        );
      freshness.consume(pass.pass);
    },
  };
}

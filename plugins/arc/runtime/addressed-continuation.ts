import type {
  BbPluginApi,
  ExperimentalAddressedDispatchResult,
} from "@get-bb/plugin-sdk";
import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";
import { AgentStoreError, type AgentStore } from "../data.js";
import { arcHostContract } from "../host-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import type { PolicyStore } from "../policy/data.js";
import type { PolicyService } from "../policy/service.js";
import type { TeamStore } from "../teams/data.js";
import type { ArcRunStore } from "./data.js";
import {
  type AddressedContinuation,
  type AddressedContinuationInput,
} from "./addressed-continuation-data.js";
import { addressedFollowupSchema } from "./addressed-continuation-contract.js";
import {
  compiledOrchestratedRunSchema,
  compileArcOrchestratedRun,
} from "./orchestrated-compiler.js";
import {
  compiledDirectoryRunSchema,
  compileArcDirectoryRun,
} from "./directory-compiler.js";
import {
  directoryReceiptSnapshot,
  directoryRuntimeReceiptSchema,
} from "./directory-receipt.js";
import {
  receiptWorkspace,
  runtimeReceiptSchema,
  sameWorkspaceState,
} from "./receipt.js";
import { orchestratedGraphOutcome } from "./orchestrated-outcome.js";
import { runtimeHash } from "./hash.js";
import { runtimeNodeKey } from "./compiler.js";
import type { AddressedComponent } from "./addressed-composition.js";
import { preserveAddressedVerification } from "./addressed-continuation-graph.js";
import {
  addressedRepairIdentities,
  stabilizeAddressedRepairStages,
} from "./addressed-repair-identity.js";

function retainedDefinition(store: ArcRunStore, runId: string) {
  const current = store.get(runId);
  if (
    current.compiled.definition.schemaVersion !== 3 &&
    current.compiled.definition.schemaVersion !== 4
  )
    throw new AgentStoreError(
      "addressed_continuation_unsupported",
      "This conversation's earlier run does not support addressed follow-ups. Open a new conversation.",
    );
  const compiled =
    current.compiled.definition.schemaVersion === 3
      ? compiledOrchestratedRunSchema.parse(current.compiled)
      : compiledDirectoryRunSchema.parse(current.compiled);
  if (!compiled.definition.request.addressedRecipients)
    throw new AgentStoreError(
      "addressed_continuation_unsupported",
      "Use a new conversation to address agents after a manually started run.",
    );
  return { ...current, compiled };
}

export function latestAddressedRun(
  store: ArcRunStore,
  projectId: string,
  threadId: string,
) {
  let latest = store.latestForThread(projectId, threadId);
  const visited = new Set<string>();
  while (
    latest &&
    (latest.compiled.definition.schemaVersion === 3 ||
      latest.compiled.definition.schemaVersion === 4) &&
    latest.compiled.definition.request.addressedRecipients &&
    !visited.has(latest.summary.runId)
  ) {
    visited.add(latest.summary.runId);
    const incoming = store.addressedContinuations.incoming(
      latest.summary.runId,
    );
    if (incoming?.state !== "cancelled") break;
    latest = store.get(incoming.predecessorRunId ?? incoming.rootRunId);
  }
  return latest;
}

export function continuationCandidate(store: ArcRunStore, runId: string) {
  const { compiled } = retainedDefinition(store, runId);
  const effects = store.completionEffects(runId);
  const outcome = orchestratedGraphOutcome(compiled, effects);
  if (outcome.state !== "settled")
    throw new AgentStoreError(
      "followup_candidate_pending",
      "The earlier run has not settled its native evidence. Reconcile that run before continuing.",
    );
  const keys = new Set(
    compiled.references.finalGates.map((gate) => runtimeNodeKey(gate.verify)),
  );
  const candidates = effects.filter(
    (effect) =>
      keys.has(runtimeNodeKey(effect.request)) &&
      effect.observation?.state === "succeeded" &&
      effect.observation.validity.state === "current",
  );
  const identities = new Set(
    candidates.map((candidate) => {
      const observation = candidate.observation;
      if (!observation || !("receipt" in observation))
        throw new Error("Final verification receipt is missing");
      if (compiled.definition.schemaVersion === 4) {
        const snapshot = directoryReceiptSnapshot(
          directoryRuntimeReceiptSchema.parse(observation.receipt),
        );
        if (!snapshot)
          throw new Error("Final verification snapshot is missing");
        return runtimeHash(snapshot);
      }
      return runtimeHash(
        receiptWorkspace(runtimeReceiptSchema.parse(observation.receipt)),
      );
    }),
  );
  if (identities.size !== 1)
    throw new AgentStoreError(
      "followup_candidate_unavailable",
      "The earlier run has no single verified integration candidate. Its work is retained. Resolve its failed checks or candidate integration before continuing.",
    );
  return candidates[candidates.length - 1];
}

export function createAddressedContinuationService(
  bb: BbPluginApi,
  store: ArcRunStore,
  agents: AgentStore,
  graph: { policies: PolicyStore; policy: PolicyService; teams: TeamStore },
) {
  const queue = store.addressedContinuations;
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function notify(item: AddressedContinuation) {
    bb.realtime.publish("addressed:changed", {
      projectId: item.input.projectId,
      threadId: item.input.threadId,
    });
    bb.realtime.publish("runs:changed", {
      projectId: item.input.projectId,
      runId:
        item.state === "applied"
          ? item.successorRunId
          : (item.predecessorRunId ?? item.rootRunId),
    });
    return item;
  }
  async function environment(
    item: AddressedContinuation,
    current: ReturnType<typeof retainedDefinition>,
  ) {
    const root = retainedDefinition(store, item.rootRunId).compiled.definition;
    const definition = current.compiled.definition;
    const [project, parent] = await Promise.all([
      bb.sdk.projects.get({ projectId: item.input.projectId }),
      bb.sdk.threads.get({ threadId: item.input.threadId }),
    ]);
    const registered = project.sources.find(
      (source) => source.hostId === root.request.hostId,
    );
    if (
      project.kind === "personal" ||
      parent.projectId !== item.input.projectId ||
      parent.parentThreadId ||
      parent.experimental_executionContextId ||
      parent.archivedAt ||
      parent.environmentId !==
        definition.completion.environment.environmentId ||
      parent.providerId !== definition.completion.execution.providerId ||
      !registered
    )
      throw new AgentStoreError(
        "followup_environment_changed",
        "Restore this conversation's original project, host and execution environment before retrying the follow-up.",
      );
    const selected = await host.call(
      "inspectProjectSource",
      { path: registered.path },
      { hostId: root.request.hostId },
    );
    if (
      selected.path !== root.source.path ||
      selected.kind !== (root.schemaVersion === 3 ? "git" : "directory")
    )
      throw new AgentStoreError(
        "followup_source_changed",
        "The registered project source changed. Restore it before continuing.",
      );
    const actual = await bb.sdk.environments.get({
      environmentId: definition.completion.environment.environmentId,
    });
    if (
      actual.projectId !== item.input.projectId ||
      actual.status !== "ready" ||
      actual.hostId !== definition.request.hostId ||
      actual.path !== definition.completion.environment.path
    )
      throw new AgentStoreError(
        "followup_environment_changed",
        "The original conversation environment is not ready. Restore it before retrying.",
      );
    const policy = graph.policies.resolve({
      projectId: item.input.projectId,
      threadId: item.input.threadId,
      expectedProjectPolicyVersion:
        definition.request.expectedProjectPolicyVersion,
      expectedSessionPolicyVersion:
        definition.request.expectedSessionPolicyVersion,
    });
    if (runtimeHash(policy) !== runtimeHash(definition.policy))
      throw new AgentStoreError(
        "followup_policy_changed",
        "The shared budget or project rules changed. Review this run's rules before continuing.",
      );
    graph.policy.validatePins(item.input.projectId, policy);
    for (const member of Object.values(definition.members))
      agents.assignedSkills.resolve(member.definition.metadata.skills ?? []);
    for (const member of definition.team.definition.members)
      agents.assignedSkills.resolve(member.skills ?? []);
    return root;
  }
  async function scanDirectory(
    item: AddressedContinuation,
    current: ReturnType<typeof retainedDefinition>,
    operationId: string,
    path: string,
  ) {
    const definition = current.compiled.definition;
    let setup = store.directories.reserveSetup({
      operationId,
      projectId: item.input.projectId,
      originThreadId: item.input.threadId,
      hostId: definition.request.hostId,
      path,
      originEnvironment: definition.completion.environment,
      providerId: definition.completion.execution.providerId,
    });
    const job = setup.job;
    if (job.operation.type !== "scan-directory")
      throw new Error("Follow-up source inspection identity is invalid");
    if (setup.record?.state !== "terminal") {
      const record =
        (await host.call(
          "observeDirectoryEffect",
          {
            runId: job.runId,
            effectId: job.effectId,
            requestHash: directoryEffectRequestHash(job),
          },
          { hostId: definition.request.hostId },
        )) ??
        (await host.call("startDirectoryEffect", job, {
          hostId: definition.request.hostId,
        }));
      setup = store.directories.recordSetupInspection({
        projectId: item.input.projectId,
        operationId,
        record,
      });
    }
    if (setup.record?.state === "needs-reconciliation")
      throw new AgentStoreError(
        "followup_scan_interrupted",
        "The candidate scan was interrupted. Its files are retained; reconcile its host before retrying.",
      );
    if (setup.record?.state !== "terminal") return null;
    if (
      setup.record.receipt?.outcome !== "succeeded" ||
      setup.record.receipt.artifact?.kind !== "inspection"
    )
      throw new AgentStoreError(
        "followup_source_unavailable",
        setup.record.receipt?.reason ??
          "The follow-up source could not be verified.",
      );
    return {
      source: setup.record.receipt.artifact.state,
      inspectionId: job.operation.validationId,
    };
  }
  async function compile(
    item: AddressedContinuation,
    current: ReturnType<typeof retainedDefinition>,
  ) {
    const root = await environment(item, current);
    const before = current.compiled.definition;
    const inherited = { revision: before.team, members: before.members };
    let selected = inherited;
    if (
      item.composition !== null &&
      runtimeHash(item.composition) !== runtimeHash(inherited)
    ) {
      const proposed = item.composition;
      const team = {
        teamId: proposed.revision.teamId,
        revision: proposed.revision.revision,
      };
      const projected =
        before.schemaVersion === 3
          ? compileArcOrchestratedRun({
              ...before,
              team: proposed.revision,
              members: proposed.members,
              request: { ...before.request, team },
            })
          : compileArcDirectoryRun({
              ...before,
              team: proposed.revision,
              members: proposed.members,
              request: { ...before.request, team },
            });
      const finalReviewIds = [
        ...new Set(
          projected.references.finalGates
            .map(
              (gate) =>
                projected.references.origins[runtimeNodeKey(gate.verify)]
                  ?.graphNodeId,
            )
            .filter((id): id is string => id != null),
        ),
      ];
      selected = preserveAddressedVerification(
        before.team,
        proposed,
        finalReviewIds,
        current.compiled.references.finalGates.map((gate) => {
          const checkNodeId =
            current.compiled.references.origins[runtimeNodeKey(gate.check)]
              ?.graphNodeId;
          const reviewNodeId =
            current.compiled.references.origins[runtimeNodeKey(gate.review)]
              ?.graphNodeId;
          if (!checkNodeId || !reviewNodeId)
            throw new AgentStoreError(
              "followup_verification_unsupported",
              "The earlier final verification cannot be mapped to its pinned check and review. Keep the existing recipients and versions to retain all verification gates.",
            );
          return { checkNodeId, reviewNodeId };
        }),
      );
    }
    for (const member of Object.values(selected.members))
      agents.assignedSkills.resolve(member.definition.metadata.skills ?? []);
    for (const member of selected.revision.definition.members)
      agents.assignedSkills.resolve(member.skills ?? []);
    const candidateEffect = continuationCandidate(store, current.summary.runId);
    const observation = candidateEffect.observation;
    if (!observation || !("receipt" in observation))
      throw new Error("Verified candidate receipt is missing");
    const request = {
      ...before.request,
      operationId: item.input.operationId,
      goal: item.input.goal,
      team: {
        teamId: selected.revision.teamId,
        revision: selected.revision.revision,
      },
      addressedRecipients: item.input.recipients,
      addressedAttachments: item.input.attachments,
      invocation: null,
    };
    const base = {
      ...before,
      runId: item.successorRunId,
      team: selected.revision,
      members: selected.members,
      createdAt: item.createdAt,
    };
    if (before.schemaVersion === 3 && root.schemaVersion === 3) {
      const candidate = receiptWorkspace(
        runtimeReceiptSchema.parse(observation.receipt),
      );
      const [original, actual] = await Promise.all([
        host.call(
          "inspectWorkspace",
          { path: root.source.path, expected: null },
          { hostId: before.request.hostId },
        ),
        host.call(
          "inspectWorkspace",
          { path: candidate.path, expected: null },
          { hostId: before.request.hostId },
        ),
      ]);
      if (
        !original.clean ||
        original.head !== root.source.head ||
        original.commonGitDir !== root.source.commonGitDir ||
        original.stateDigest !== root.source.stateHash ||
        !actual.clean ||
        !sameWorkspaceState(actual, candidate) ||
        actual.commonGitDir !== root.source.commonGitDir
      )
        throw new AgentStoreError(
          "followup_source_changed",
          "The original project or verified candidate changed. Reconcile the retained candidate before continuing.",
        );
      return compileArcOrchestratedRun({
        ...base,
        schemaVersion: 3,
        request: { ...request, path: actual.path, expectedHead: actual.head },
        source: {
          path: actual.path,
          commonGitDir: actual.commonGitDir,
          head: actual.head,
          branch: actual.currentBranch,
          stateHash: actual.stateDigest,
        },
      });
    }
    if (before.schemaVersion !== 4 || root.schemaVersion !== 4)
      throw new Error("Follow-up source kind changed");
    const candidate = directoryReceiptSnapshot(
      directoryRuntimeReceiptSchema.parse(observation.receipt),
    );
    if (!candidate)
      throw new AgentStoreError(
        "followup_candidate_unavailable",
        "The prior directory candidate has no retained snapshot.",
      );
    const original = await scanDirectory(
      item,
      current,
      `${item.input.operationId}:origin`,
      root.source.path,
    );
    if (!original) return null;
    if (runtimeHash(original.source) !== runtimeHash(root.source))
      throw new AgentStoreError(
        "followup_source_changed",
        "The original folder changed. Reconcile its retained candidate before continuing.",
      );
    const actual = await scanDirectory(
      item,
      current,
      item.input.operationId,
      candidate.workspace.path,
    );
    if (!actual) return null;
    if (
      actual.source.path !== candidate.workspace.path ||
      runtimeHash(actual.source.rootIdentity) !==
        runtimeHash(candidate.workspace.rootIdentity) ||
      actual.source.manifestDigest !== candidate.manifestDigest
    )
      throw new AgentStoreError(
        "followup_candidate_changed",
        "The verified directory candidate changed. Its retained snapshot is preserved; reconcile the candidate before continuing.",
      );
    return compileArcDirectoryRun({
      ...base,
      schemaVersion: 4,
      source: actual.source,
      request: {
        ...before.request,
        ...request,
        path: actual.source.path,
        sourceInspectionId: actual.inspectionId,
        expectedSource: {
          rootIdentity: actual.source.rootIdentity,
          manifestDigest: actual.source.manifestDigest,
        },
      },
    });
  }
  async function advance(input: AddressedContinuation) {
    let item = queue.find(input.input.projectId, input.input.operationId)!;
    if (["applied", "cancelled", "action-required"].includes(item.state))
      return item;
    if (
      queue.firstPending(item.input.projectId, item.input.threadId) !==
      item.sequence
    )
      return item;
    try {
      const predecessor =
        item.predecessorRunId ??
        latestAddressedRun(store, item.input.projectId, item.input.threadId)
          ?.summary.runId ??
        item.rootRunId;
      const current = retainedDefinition(store, predecessor);
      if (!current.summary.workflowRunId) return item;
      const { run } = await workflows.call("inspectOwnedRun", {
        workflowRunId: current.summary.workflowRunId,
      });
      if (run.state === "cancelled")
        throw new AgentStoreError(
          "followup_stopped",
          "The prior run was stopped. Its candidates and this instruction remain saved. Inspect the run's workspace, then cancel this queued follow-up if it is no longer needed.",
        );
      if (!["succeeded", "failed"].includes(run.state)) return item;
      if (
        runtimeHash(
          current.compiled.definition.request.addressedRecipients ?? [],
        ) !== runtimeHash(item.input.recipients) &&
        item.composition === null
      )
        throw new AgentStoreError(
          "followup_recipients_changed",
          "The recipient versions changed. This instruction is saved, but its revised collaboration graph needs review before it can use the existing shared budget.",
        );
      if (item.state === "queued")
        item = queue.bind(item, predecessor, run.controlVersion);
      if (item.controlVersion === null)
        throw new Error("Follow-up control version is missing");
      const controlVersion = item.controlVersion;
      if (!item.compiled) {
        const compiled = await compile(item, current);
        if (!compiled) return item;
        item = queue.seal(
          item,
          stabilizeAddressedRepairStages(
            compiled,
            addressedRepairIdentities(compiled, graph.teams),
          ),
        );
      }
      const retainedCompiled = item.compiled;
      if (
        !retainedCompiled ||
        (retainedCompiled.definition.schemaVersion !== 3 &&
          retainedCompiled.definition.schemaVersion !== 4)
      )
        throw new Error("Follow-up compilation is missing");
      const compiled =
        retainedCompiled.definition.schemaVersion === 3
          ? compiledOrchestratedRunSchema.parse(retainedCompiled)
          : compiledDirectoryRunSchema.parse(retainedCompiled);
      const key = {
        predecessorWorkflowRunId: current.summary.workflowRunId,
        operationId: item.input.operationId,
      };
      const { continuation } = await workflows.call(
        "reserveOwnedContinuation",
        {
          ...key,
          expectedControlVersion: controlVersion,
          successorOwnerRunId: item.successorRunId,
        },
      );
      if (continuation.state === "cancelled")
        return notify(queue.update(item, "cancelled"));
      if (continuation.state === "started" && continuation.successor) {
        store.submitted(
          item.successorRunId,
          continuation.successor.workflowRunId,
        );
        return notify(queue.update(item, "applied"));
      }
      if (continuation.state === "pausing") return item;
      const root = await environment(item, current);
      const source = compiled.definition.source;
      if (compiled.definition.schemaVersion === 3 && root.schemaVersion === 3) {
        const [original, actual] = await Promise.all([
          host.call(
            "inspectWorkspace",
            { path: root.source.path, expected: null },
            { hostId: compiled.definition.request.hostId },
          ),
          host.call(
            "inspectWorkspace",
            { path: source.path, expected: null },
            { hostId: compiled.definition.request.hostId },
          ),
        ]);
        const sealed = compiled.definition.source;
        if (
          !original.clean ||
          original.head !== root.source.head ||
          original.stateDigest !== root.source.stateHash ||
          original.commonGitDir !== root.source.commonGitDir ||
          !actual.clean ||
          actual.path !== sealed.path ||
          actual.head !== sealed.head ||
          actual.stateDigest !== sealed.stateHash ||
          actual.commonGitDir !== sealed.commonGitDir
        )
          throw new AgentStoreError(
            "followup_source_changed",
            "The original project or sealed follow-up candidate changed before admission. Its work remains retained; cancel this follow-up or restore the verified candidate before retrying.",
          );
      } else if (
        compiled.definition.schemaVersion === 4 &&
        root.schemaVersion === 4
      ) {
        const prefix = `${item.input.operationId}:admit:${item.updatedAt}`;
        const original = await scanDirectory(
          item,
          current,
          `${prefix}:origin`,
          root.source.path,
        );
        if (!original) return item;
        const actual = await scanDirectory(
          item,
          current,
          `${prefix}:candidate`,
          source.path,
        );
        if (!actual) return item;
        if (
          runtimeHash(original.source) !== runtimeHash(root.source) ||
          runtimeHash(actual.source) !== runtimeHash(source)
        )
          throw new AgentStoreError(
            "followup_source_changed",
            "The original folder or sealed follow-up candidate changed before admission. Its work remains retained; cancel this follow-up or restore the verified candidate before retrying.",
          );
      } else throw new Error("The sealed follow-up source kind changed");
      if (compiled.definition.schemaVersion === 4)
        store.directories.consumeSetup(
          compiled.definition.request,
          item.successorRunId,
          () => store.reserve(compiled),
        );
      else store.reserve(compiled);
      const { continuation: started } = await workflows.call(
        "startOwnedAddressedContinuation",
        {
          ...key,
          successor: compiled.workflow,
          authorization: {
            kind: "addressed",
            requestHash: runtimeHash({
              input: item.input,
              composition: item.composition,
            }),
            predecessorPlanHash: current.summary.planHash,
            repairStageMappings: [
              ...addressedRepairIdentities(current.compiled, graph.teams),
            ]
              .filter(([from, to]) => from !== to)
              .map(([fromStageId, toStageId]) => ({ fromStageId, toStageId })),
          },
        },
      );
      if (started.state === "started" && started.successor) {
        store.submitted(item.successorRunId, started.successor.workflowRunId);
        return notify(queue.update(item, "applied"));
      }
      return notify(item);
    } catch (error) {
      return notify(
        queue.update(
          item,
          "action-required",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  async function inThread<T>(
    projectId: string,
    threadId: string,
    action: () => Promise<T>,
  ) {
    const key = `${projectId}:${threadId}`;
    const prior = pending.get(key) ?? Promise.resolve();
    const next = prior.then(action);
    const tail = next.then(
      () => {},
      () => {},
    );
    pending.set(key, tail);
    try {
      return await next;
    } finally {
      if (pending.get(key) === tail) pending.delete(key);
    }
  }
  async function serialized(item: AddressedContinuation) {
    return inThread(item.input.projectId, item.input.threadId, () =>
      advance(item),
    );
  }
  function result(
    item: AddressedContinuation,
  ): ExperimentalAddressedDispatchResult {
    const runId =
      item.state === "applied"
        ? item.successorRunId
        : (item.predecessorRunId ?? item.rootRunId);
    return {
      runId,
      status: "continued",
      path: `/plugins/arc/workspace/${runId}`,
      summary:
        item.state === "applied"
          ? "Continued from the verified candidate with the same cumulative budget. One combined response will return here."
          : item.state === "cancelled"
            ? "This follow-up was cancelled. Its instruction and earlier work remain saved."
            : item.state === "action-required"
              ? `Follow-up saved; action required: ${item.error}`
              : "Follow-up queued after the current coordinated pass. It will continue from the verified candidate under the same shared budget.",
    };
  }
  async function tick() {
    try {
      for (const item of queue.pending()) {
        if (disposed) return;
        await serialized(item);
      }
    } catch (error) {
      bb.log.warn(
        `Addressed follow-up reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!disposed)
        timer = setTimeout(() => {
          void tick();
        }, 2000);
    }
  }
  const publicView = (item: AddressedContinuation) =>
    addressedFollowupSchema.parse({
      operationId: item.input.operationId,
      goal: item.input.goal,
      predecessorRunId: item.predecessorRunId,
      successorRunId: item.successorRunId,
      state: item.state,
      error: item.error,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  async function requireScope(input: { projectId: string; threadId: string }) {
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    if (
      thread.projectId !== input.projectId ||
      thread.parentThreadId ||
      thread.experimental_executionContextId
    )
      throw new AgentStoreError(
        "scope_denied",
        "Choose the main conversation for these follow-ups.",
      );
  }
  async function mutation(
    input: {
      projectId: string;
      threadId: string;
      operationId: string;
      expectedUpdatedAt: number;
    },
    cancel: boolean,
  ) {
    await requireScope(input);
    return inThread(input.projectId, input.threadId, async () => {
      let item = queue.find(input.projectId, input.operationId);
      if (!item || item.input.threadId !== input.threadId)
        throw new AgentStoreError(
          "followup_not_found",
          "This follow-up does not belong to the selected conversation.",
        );
      if (item.updatedAt !== input.expectedUpdatedAt)
        throw new AgentStoreError(
          "followup_changed",
          "The follow-up changed. Refresh its status before acting.",
        );
      if (item.state === "applied" || item.state === "cancelled")
        return publicView(item);
      if (cancel) {
        if (item.predecessorRunId) {
          const prior = store.get(item.predecessorRunId);
          if (!prior.summary.workflowRunId)
            throw new Error(
              "The earlier workflow identity is unavailable. Reconcile it before cancelling.",
            );
          const key = {
            predecessorWorkflowRunId: prior.summary.workflowRunId,
            operationId: item.input.operationId,
          };
          const { continuation } = await workflows.call(
            "inspectOwnedContinuation",
            key,
          );
          if (
            continuation?.state === "started" ||
            continuation?.state === "retiring"
          )
            throw new AgentStoreError(
              "followup_admitted",
              "This follow-up was admitted. Reconcile it and use its run's stop control.",
            );
          if (continuation && continuation.state !== "cancelled")
            await workflows.call("cancelOwnedContinuation", key);
          const local = store.findOperation(
            item.input.projectId,
            item.input.operationId,
          );
          if (local?.summary.workflowRunId)
            throw new AgentStoreError(
              "followup_admitted",
              "This follow-up already has a workflow. Reconcile it and use its run's stop control.",
            );
          if (local)
            store.submissionUncertain(
              local.summary.runId,
              "This follow-up was cancelled before workflow admission.",
            );
        }
        return publicView(notify(queue.update(item, "cancelled")));
      }
      if (item.state !== "action-required")
        return publicView(await advance(item));
      item = queue.update(
        item,
        item.compiled
          ? "starting"
          : item.predecessorRunId
            ? "checking"
            : "queued",
      );
      return publicView(await advance(item));
    });
  }
  return {
    async continue(
      input: AddressedContinuationInput,
      priorRunId: string,
      composition: AddressedComponent | null = null,
    ) {
      return result(
        await serialized(notify(queue.reserve(input, priorRunId, composition))),
      );
    },
    find: queue.find,
    list: queue.queue,
    handlers() {
      return {
        async getAddressedFollowups(input: {
          projectId: string;
          threadId: string;
        }) {
          await requireScope(input);
          return {
            followups: queue.publicQueue(input.projectId, input.threadId),
          };
        },
        retryAddressedFollowup: (input: {
          projectId: string;
          threadId: string;
          operationId: string;
          expectedUpdatedAt: number;
        }) => mutation(input, false),
        cancelAddressedFollowup: (input: {
          projectId: string;
          threadId: string;
          operationId: string;
          expectedUpdatedAt: number;
        }) => mutation(input, true),
      };
    },
    async resumeSuccessor(runId: string) {
      const item = queue.incoming(runId);
      if (!item) return false;
      await serialized(item);
      return true;
    },
    start() {
      if (timer !== null || disposed) return;
      timer = setTimeout(() => {
        void tick();
      }, 2000);
      bb.onDispose(() => {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
      });
    },
  };
}

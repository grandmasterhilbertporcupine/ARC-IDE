import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ownedWorkflowRpcContract,
  type OwnedRequirement,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError, type AgentStore } from "../data.js";
import { MAX_AGENT_DOCUMENT_CHARS } from "../contract.js";
import { parseAgentDocument } from "../document.js";
import { arcHostContract } from "../host-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import type { TeamStore } from "../teams/data.js";
import type { PolicyStore } from "../policy/data.js";
import type { PolicyService } from "../policy/service.js";
import type { AgentActor } from "../service.js";
import { runtimeNodeKey } from "./compiler.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { createDirectorySetupService } from "./directory-setup-service.js";
import type { ArcRunStore } from "./data.js";
import { runtimeHash } from "./hash.js";
import { compositionAllowedByPolicy } from "./composition-authorization.js";
import {
  arcInstructionUpdatesRpcContract,
  instructionUpdateApplicationSchema,
  type InstructionUpdatePreview,
} from "./instruction-update-contract.js";
import {
  ruleUpdateApplicationSchema,
  ruleUpdatePreviewResultSchema,
  runUpdateStateSchema,
  type RuleUpdateInput,
  type RuleUpdatePreview,
  type RuleReview,
  type RunUpdateApplication,
} from "./rule-update-contract.js";
import {
  compareRuleSelection,
  ruleBudgetBlockers,
} from "./rule-update-selection.js";
import {
  loadRunExecutionInheritance,
  resolveRunAgentSnapshot,
} from "./execution-snapshot.js";

type PreviewInput = z.infer<
  typeof arcInstructionUpdatesRpcContract.previewRunInstructionUpdate.input
>;
type ApplyInput = z.infer<
  typeof arcInstructionUpdatesRpcContract.applyRunInstructionUpdate.input
>;
type Key = { runId: string; operationId: string };

export function createInstructionUpdateService(
  bb: BbPluginApi,
  store: ArcRunStore,
  agents: AgentStore,
  graph: { teams: TeamStore; policies: PolicyStore; policy: PolicyService },
) {
  const updates = store.instructionUpdates;
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  const directories = createDirectorySetupService(bb, store);
  const pending = new Map<string, Promise<void>>();
  async function serialized<T>(
    key: Key,
    operation: () => Promise<T>,
  ): Promise<T> {
    const id = `${key.runId}:${key.operationId}`;
    const prior = pending.get(id) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending.set(id, next);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (pending.get(id) === next) pending.delete(id);
    }
  }
  function requireUser(actor: AgentActor) {
    if (actor.kind !== "user")
      throw new AgentStoreError(
        "approval_required",
        "Only the user can review and apply updates to active runs",
      );
  }
  function load(runId: string) {
    const current = store.get(runId);
    if (current.compiled.definition.schemaVersion === 1)
      throw new AgentStoreError(
        "instruction_update_unsupported",
        "This fixed run cannot apply instruction revisions. Use a published team run.",
      );
    if (!current.summary.workflowRunId)
      throw new AgentStoreError(
        "run_submission_uncertain",
        "Reconcile this saved run before reviewing updated instructions",
      );
    const definition = current.compiled.definition;
    if (
      !compositionAllowedByPolicy({
        projectId: definition.request.projectId,
        team: definition.team,
        members: definition.members,
        policy: definition.policy,
        ...(definition.compositionAuthorization === undefined
          ? {}
          : { compositionAuthorization: definition.compositionAuthorization }),
      })
    )
      throw new AgentStoreError(
        "team_restricted",
        "The retained team composition is outside its pinned allowed teams",
      );
    return {
      ...current,
      workflowRunId: current.summary.workflowRunId,
      definition: current.compiled.definition,
    };
  }
  function selection(input: PreviewInput) {
    const current = load(input.runId);
    const before = current.definition;
    const scope = {
      kind: "project",
      projectId: before.request.projectId,
    } as const;
    if (
      input.team.teamId !== before.team.teamId ||
      input.team.revision <= before.team.revision
    )
      throw new AgentStoreError(
        "instruction_revision_required",
        "Select a newer published revision of this run's project team",
      );
    if (
      graph.teams.getTeam({ scope, teamId: input.team.teamId }).archivedAt !==
      null
    )
      throw new AgentStoreError(
        "team_archived",
        "Restore this project team before applying its instructions",
      );
    const team = graph.teams.getRevision({ scope, ...input.team });
    const normalized = {
      ...team.definition,
      members: team.definition.members.map((member) => ({
        ...member,
        revision:
          before.team.definition.members.find((item) => item.id === member.id)
            ?.revision ?? 0,
      })),
    };
    if (runtimeHash(normalized) !== runtimeHash(before.team.definition))
      throw new AgentStoreError(
        "instruction_only_required",
        "This action only changes pinned agent instruction bodies. Team metadata, members, checks, graph, permissions and presentation must stay unchanged.",
      );
    const policy = graph.policies.resolve({
      projectId: before.request.projectId,
      threadId: before.request.originThreadId,
      expectedProjectPolicyVersion: before.request.expectedProjectPolicyVersion,
      expectedSessionPolicyVersion: before.request.expectedSessionPolicyVersion,
    });
    if (runtimeHash(policy) !== runtimeHash(before.policy))
      throw new AgentStoreError(
        "instruction_policy_conflict",
        "The run's operational policy changed. Review its configuration separately.",
      );
    graph.policy.validatePins(scope.projectId, policy);
    graph.policy.requireAllowed(policy, input.team);
    const members = { ...before.members };
    const changes: InstructionUpdatePreview["changes"] = [];
    for (const member of team.definition.members) {
      const prior = before.members[member.id];
      const target = { scope, agentId: member.agentId };
      if (agents.getAgent(target).archivedAt !== null)
        throw new AgentStoreError(
          "agent_archived",
          "Restore this team's project agents before applying instructions",
        );
      const definition = agents.getRevision({
        ...target,
        revision: member.revision,
      });
      if (
        definition.agentId !== prior.definition.agentId ||
        definition.revision < prior.definition.revision ||
        runtimeHash(definition.metadata) !==
          runtimeHash(prior.definition.metadata) ||
        runtimeHash(definition.attachments) !==
          runtimeHash(prior.definition.attachments)
      )
        throw new AgentStoreError(
          "instruction_only_required",
          "Agent identity, metadata, references and execution permissions cannot change through instruction application",
        );
      const previous = parseAgentDocument(prior.definition.document).body;
      const next = parseAgentDocument(definition.document).body;
      if (next.length > MAX_AGENT_DOCUMENT_CHARS - 1500)
        throw new AgentStoreError(
          "instructions_too_large",
          "Shorten this agent's instructions to leave room for pinned run context",
        );
      if (next !== previous)
        changes.push({
          memberId: member.id,
          agentId: member.agentId,
          name: definition.metadata.name,
          oldRevision: prior.definition.revision,
          newRevision: definition.revision,
          before: previous,
          after: next,
        });
      else if (definition.revision !== prior.definition.revision)
        throw new AgentStoreError(
          "instruction_noop_revision",
          "Every changed agent revision must contain an instruction body change",
        );
      members[member.id] = { definition, execution: prior.execution };
    }
    if (changes.length === 0)
      throw new AgentStoreError(
        "instruction_no_changes",
        "This published team has no changed agent instructions",
      );
    return { current, team, members, changes };
  }
  async function ruleSelection(input: RuleUpdateInput) {
    const current = load(input.runId);
    const before = current.definition;
    if (
      input.team.teamId !== before.team.teamId ||
      input.team.revision < before.team.revision
    )
      throw new AgentStoreError(
        "rule_team_required",
        "Select the current or a newer published revision of this same project Team",
      );
    const scope = {
      kind: "project",
      projectId: before.request.projectId,
    } as const;
    if (
      graph.teams.getTeam({ scope, teamId: input.team.teamId }).archivedAt !==
      null
    )
      throw new AgentStoreError(
        "team_archived",
        "Restore this Team before reviewing its rules",
      );
    const team = graph.teams.getRevision({ scope, ...input.team });
    const target = {
      projectId: scope.projectId,
      threadId: before.request.originThreadId,
      expectedProjectPolicyVersion: input.expectedProjectPolicyVersion,
      expectedSessionPolicyVersion: input.expectedSessionPolicyVersion,
    };
    const policy = graph.policies.resolve(target);
    graph.policy.validatePins(scope.projectId, policy);
    const inherited = await loadRunExecutionInheritance(
      bb,
      scope.projectId,
      before.request.originThreadId,
    );
    const members: typeof before.members = {};
    const resolutions: Record<
      string,
      (typeof before.members)[string]["execution"] | null
    > = {};
    for (const member of team.definition.members) {
      const agentTarget = { scope, agentId: member.agentId };
      if (agents.getAgent(agentTarget).archivedAt !== null)
        throw new AgentStoreError(
          "agent_archived",
          "Restore the selected Team's agents before applying rules",
        );
      const definition = agents.getRevision({
        ...agentTarget,
        revision: member.revision,
      });
      try {
        const snapshot = resolveRunAgentSnapshot(
          definition,
          inherited,
          member.modelOverride,
        );
        members[member.id] = snapshot;
        resolutions[member.id] = snapshot.execution;
      } catch (error) {
        if (
          !(error instanceof AgentStoreError) ||
          error.code !== "execution_configuration_missing"
        )
          throw error;
        resolutions[member.id] = null;
        const old = before.members[member.id];
        if (old) members[member.id] = { definition, execution: old.execution };
      }
    }
    const context = await workflows.call("inspectOwnedRuleContext", {
      workflowRunId: current.workflowRunId,
    });
    graph.policies.resolve(target);
    const compared = compareRuleSelection({
      before,
      team,
      members,
      resolutions,
      policy,
      context,
    });
    if (
      ["succeeded", "failed", "cancelled"].includes(context.run.state) ||
      context.run.desiredControl === "cancel"
    )
      compared.blockers.push({
        code: "run-not-active",
        message:
          "Choose an active or paused Team run for a reviewed rule update.",
        nodeIds: [],
        memberIds: [],
      });
    const review: RuleReview = {
      runId: input.runId,
      projectId: scope.projectId,
      planHash: current.summary.planHash,
      controlVersion: context.run.controlVersion,
      oldTeam: {
        teamId: before.team.teamId,
        revision: before.team.revision,
        name: before.team.definition.name,
      },
      newTeam: {
        teamId: team.teamId,
        revision: team.revision,
        name: team.definition.name,
      },
      oldPolicy: {
        projectVersion: before.request.expectedProjectPolicyVersion,
        sessionVersion: before.request.expectedSessionPolicyVersion,
        effective: before.policy,
      },
      newPolicy: {
        projectVersion: input.expectedProjectPolicyVersion,
        sessionVersion: input.expectedSessionPolicyVersion,
        effective: policy,
      },
      changes: compared.changes,
      affectedNodes: compared.affectedNodes,
      repairStages: compared.repairStages,
      usage: {
        checkedAt: Date.now(),
        agentCalls: context.run.agentCalls,
        chargedActiveMs: context.run.chargedActiveMs,
        repairRounds: context.run.repairRounds,
      },
      source: {
        kind: before.schemaVersion === 4 ? "directory" : "git",
        path: before.source.path,
        identityHash: runtimeHash(before.source),
      },
      createdAt: Date.now(),
    };
    if (
      "references" in current.compiled &&
      "mainCompletion" in current.compiled.references &&
      compared.changes.some((change) => change.impact !== "future-only")
    )
      review.affectedNodes.push({
        nodeId: current.compiled.references.mainCompletion.nodeId,
        label: "Main response",
        kind: "main-completion",
      });
    return {
      current,
      team,
      members,
      policy,
      review,
      blockers: compared.blockers,
    };
  }
  async function environment(runId: string) {
    const current = load(runId);
    const definition = current.definition;
    const request = definition.request;
    const [project, parent] = await Promise.all([
      bb.sdk.projects.get({ projectId: request.projectId }),
      bb.sdk.threads.get({ threadId: request.originThreadId }),
    ]);
    const source = project.sources.find(
      (item) => item.hostId === request.hostId,
    );
    if (
      project.kind === "personal" ||
      !source ||
      parent.projectId !== request.projectId ||
      parent.archivedAt != null ||
      parent.parentThreadId != null ||
      parent.experimental_executionContextId != null
    )
      throw new AgentStoreError(
        "instruction_scope_changed",
        "The original project, host or main conversation is no longer available",
      );
    if (definition.schemaVersion !== 2) {
      if (
        parent.environmentId !==
          definition.completion.environment.environmentId ||
        parent.providerId !== definition.completion.execution.providerId
      )
        throw new AgentStoreError(
          "instruction_environment_changed",
          "The main conversation changed its reviewed execution binding",
        );
      const actual = await bb.sdk.environments.get({
        environmentId: definition.completion.environment.environmentId,
      });
      if (
        actual.status !== "ready" ||
        actual.projectId !== request.projectId ||
        actual.hostId !== request.hostId ||
        actual.path !== definition.completion.environment.path
      )
        throw new AgentStoreError(
          "instruction_environment_changed",
          "The original main conversation environment changed",
        );
    }
    const selected = await host.call(
      "inspectProjectSource",
      { path: source.path },
      { hostId: request.hostId },
    );
    if (
      selected.kind !==
        (definition.schemaVersion === 4 ? "directory" : "git") ||
      selected.path !== definition.source.path
    )
      throw new AgentStoreError(
        "instruction_source_changed",
        "The registered original source changed. Cancel this update and review a fresh run.",
      );
    return current;
  }
  const requirements = (requirement: OwnedRequirement) =>
    requirement.kind === "receipt"
      ? [requirement.step]
      : requirement.kind === "selection"
        ? [requirement.decision]
        : [
            requirement.decision,
            ...requirement.branches.flatMap((branch) =>
              branch.receipts.map((receipt) => receipt.step),
            ),
          ];
  function affected(
    current: ReturnType<typeof load>,
    changes: InstructionUpdatePreview["changes"],
  ) {
    const compiled = current.compiled;
    if (!("references" in compiled)) return [];
    const members = new Set(changes.map((item) => item.memberId));
    const keys = new Set(
      Object.entries(compiled.references.origins)
        .filter(
          ([, origin]) =>
            origin.memberId !== null && members.has(origin.memberId),
        )
        .map(([key]) => key),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of compiled.workflow.steps)
        if (
          !keys.has(runtimeNodeKey(step)) &&
          step.requirements.some((requirement) =>
            requirements(requirement).some((ref) =>
              keys.has(runtimeNodeKey(ref)),
            ),
          )
        ) {
          keys.add(runtimeNodeKey(step));
          changed = true;
        }
    }
    if ("mainCompletion" in compiled.references)
      keys.add(runtimeNodeKey(compiled.references.mainCompletion));
    const nodes = new Map<
      string,
      InstructionUpdatePreview["affectedNodes"][number]
    >();
    for (const key of keys) {
      const graphId = compiled.references.origins[key]?.graphNodeId;
      const graphNode = current.definition.team.definition.graph.nodes.find(
        (node) => node.id === graphId,
      );
      const nodeId = graphNode?.id ?? key;
      nodes.set(nodeId, {
        nodeId,
        label:
          graphNode?.label ??
          (key.startsWith("arc:main-completion") ? "Main response" : key),
        kind: graphNode?.kind ?? compiled.nodes[key].kind,
      });
    }
    return [...nodes.values()];
  }
  function compileSuccessor(
    current: ReturnType<typeof load>,
    selected: {
      team: ReturnType<TeamStore["getRevision"]>;
      members: ReturnType<typeof load>["definition"]["members"];
      policy: ReturnType<typeof load>["definition"]["policy"];
      projectVersion: number;
      sessionVersion: number;
      kind: "instruction" | "rule";
    },
  ) {
    const before = current.definition;
    const {
      compositionAuthorization: _compositionAuthorization,
      ...previousDefinition
    } = before;
    const request = {
      ...before.request,
      operationId: `${selected.kind}_${randomUUID()}`,
      team: { teamId: selected.team.teamId, revision: selected.team.revision },
      expectedProjectPolicyVersion: selected.projectVersion,
      expectedSessionPolicyVersion: selected.sessionVersion,
    };
    const base = {
      ...previousDefinition,
      runId: `run_${randomUUID()}`,
      team: selected.team,
      members: selected.members,
      policy: selected.policy,
      createdAt: Date.now(),
    };
    if (before.schemaVersion === 4) {
      const setup = store.directories.reserveSetup({
        operationId: request.operationId,
        projectId: request.projectId,
        originThreadId: request.originThreadId,
        hostId: request.hostId,
        path: before.source.path,
        originEnvironment: before.completion.environment,
        providerId: before.completion.execution.providerId,
      });
      if (setup.job.operation.type !== "scan-directory")
        throw new AgentStoreError(
          "instruction_source_conflict",
          "The retained source inspection is invalid",
        );
      return compileArcDirectoryRun({
        ...base,
        schemaVersion: 4,
        source: before.source,
        completion: before.completion,
        request: {
          ...before.request,
          operationId: request.operationId,
          team: request.team,
          expectedProjectPolicyVersion: request.expectedProjectPolicyVersion,
          expectedSessionPolicyVersion: request.expectedSessionPolicyVersion,
          invocation: null,
          sourceInspectionId: setup.job.operation.validationId,
        },
      });
    }
    if (before.schemaVersion === 3)
      return compileArcOrchestratedRun({
        ...base,
        schemaVersion: 3,
        source: before.source,
        completion: before.completion,
        request: {
          ...before.request,
          operationId: request.operationId,
          team: request.team,
          expectedProjectPolicyVersion: request.expectedProjectPolicyVersion,
          expectedSessionPolicyVersion: request.expectedSessionPolicyVersion,
          invocation: null,
        },
      });
    return compileArcGraphRun({
      ...base,
      schemaVersion: 2,
      source: before.source,
      request: {
        ...before.request,
        operationId: request.operationId,
        team: request.team,
        expectedProjectPolicyVersion: request.expectedProjectPolicyVersion,
        expectedSessionPolicyVersion: request.expectedSessionPolicyVersion,
      },
    });
  }
  async function previewRules(input: RuleUpdateInput, actor: AgentActor) {
    requireUser(actor);
    updates.assertControllable(input.runId);
    const selected = await ruleSelection(input);
    if (selected.blockers.length)
      return ruleUpdatePreviewResultSchema.parse({
        disposition: "blocked",
        review: selected.review,
        blockers: selected.blockers,
      });
    if (
      selected.review.changes.every((change) => change.impact === "future-only")
    )
      return ruleUpdatePreviewResultSchema.parse({
        disposition: "no-running-change",
        review: selected.review,
        reason:
          "These settings affect future selection or presentation. The active run already has the same effective execution rules.",
      });
    await environment(input.runId);
    const current = await ruleSelection(input);
    if (
      current.review.controlVersion !== selected.review.controlVersion ||
      runtimeHash({
        team: current.team,
        members: current.members,
        policy: current.policy,
      }) !==
        runtimeHash({
          team: selected.team,
          members: selected.members,
          policy: selected.policy,
        })
    )
      throw new AgentStoreError(
        "rule_preview_stale",
        "The run or resolved configuration changed while preparing its rule review",
      );
    if (current.blockers.length)
      return ruleUpdatePreviewResultSchema.parse({
        disposition: "blocked",
        review: current.review,
        blockers: current.blockers,
      });
    const compiled = compileSuccessor(current.current, {
      ...current,
      projectVersion: input.expectedProjectPolicyVersion,
      sessionVersion: input.expectedSessionPolicyVersion,
      kind: "rule",
    });
    updates.assertControllable(input.runId);
    const details = {
      ...current.review,
      kind: "rules" as const,
      schemaVersion: 1 as const,
      previewId: `rule_preview_${randomUUID()}`,
      rerun: "entire-team-from-original" as const,
    };
    const preview: RuleUpdatePreview = {
      ...details,
      previewHash: runtimeHash({
        ...details,
        successorPlanHash: compiled.workflow.planHash,
      }),
    };
    updates.savePreview(preview, compiled);
    return ruleUpdatePreviewResultSchema.parse({
      disposition: "restart",
      preview,
    });
  }
  async function preview(input: PreviewInput, actor: AgentActor) {
    requireUser(actor);
    updates.assertControllable(input.runId);
    const selected = selection(input);
    const current = await environment(input.runId);
    const { run } = await workflows.call("inspectOwnedRun", {
      workflowRunId: current.workflowRunId,
    });
    if (
      ["succeeded", "failed", "cancelled"].includes(run.state) ||
      run.desiredControl === "cancel"
    )
      throw new AgentStoreError(
        "instruction_active_run_required",
        "Choose an active or paused team run for reviewed instruction updates",
      );
    const previewId = `instruction_preview_${randomUUID()}`;
    const before = current.definition;
    const compiled = compileSuccessor(current, {
      ...selected,
      policy: before.policy,
      projectVersion: before.request.expectedProjectPolicyVersion,
      sessionVersion: before.request.expectedSessionPolicyVersion,
      kind: "instruction",
    });
    selection(input);
    updates.assertControllable(input.runId);
    const details = {
      previewId,
      runId: input.runId,
      projectId: current.summary.projectId,
      planHash: current.summary.planHash,
      controlVersion: run.controlVersion,
      oldTeam: {
        teamId: before.team.teamId,
        revision: before.team.revision,
        name: before.team.definition.name,
      },
      newTeam: {
        teamId: selected.team.teamId,
        revision: selected.team.revision,
        name: selected.team.definition.name,
      },
      changes: selected.changes,
      affectedNodes: affected(current, selected.changes),
      rerun: "entire-team-from-original" as const,
      source: {
        kind:
          before.schemaVersion === 4
            ? ("directory" as const)
            : ("git" as const),
        path: before.source.path,
        identityHash: runtimeHash(before.source),
      },
      createdAt: Date.now(),
    };
    return updates.savePreview(
      {
        ...details,
        previewHash: runtimeHash({
          ...details,
          successorPlanHash: compiled.workflow.planHash,
        }),
      },
      compiled,
    );
  }
  async function validatePreview(
    application: Pick<RunUpdateApplication, "runId" | "preview">,
  ) {
    const retained = updates.preview(application.preview.previewId);
    const rule = "kind" in application.preview ? application.preview : null;
    const selected =
      rule === null
        ? selection({
            runId: application.runId,
            team: application.preview.newTeam,
          })
        : await ruleSelection({
            runId: application.runId,
            team: rule.newTeam,
            expectedProjectPolicyVersion: rule.newPolicy.projectVersion,
            expectedSessionPolicyVersion: rule.newPolicy.sessionVersion,
          });
    if ("blockers" in selected && selected.blockers.length)
      throw new AgentStoreError(
        "rule_update_blocked",
        selected.blockers
          .map((blocker) => `${blocker.code}: ${blocker.message}`)
          .join(" "),
      );
    if (
      rule !== null &&
      "policy" in selected &&
      (retained.compiled.definition.schemaVersion === 1 ||
        runtimeHash(selected.policy) !==
          runtimeHash(retained.compiled.definition.policy) ||
        runtimeHash(selected.review.repairStages) !==
          runtimeHash(rule.repairStages))
    )
      throw new AgentStoreError(
        "rule_preview_conflict",
        "The reviewed policy or retained repair ceilings changed. Cancel and review again.",
      );
    if (
      selected.current.summary.planHash !== application.preview.planHash ||
      runtimeHash(selected.current.definition.source) !==
        application.preview.source.identityHash ||
      runtimeHash(selected.team) !==
        runtimeHash(
          retained.compiled.definition.schemaVersion === 1
            ? null
            : retained.compiled.definition.team,
        ) ||
      runtimeHash(selected.members) !==
        runtimeHash(
          retained.compiled.definition.schemaVersion === 1
            ? null
            : retained.compiled.definition.members,
        )
    )
      throw new AgentStoreError(
        "instruction_preview_conflict",
        "The reviewed run or instruction revisions changed. Cancel this update and review again.",
      );
    return retained;
  }
  function notify(application: RunUpdateApplication) {
    bb.realtime.publish("runs:changed", {
      runId: application.runId,
      projectId: application.preview.projectId,
    });
    return application;
  }
  async function scan(application: RunUpdateApplication, operationId?: string) {
    const original = await environment(application.runId);
    const retained = updates.preview(application.preview.previewId);
    const definition = retained.compiled.definition;
    if (definition.schemaVersion === 4) {
      const request = definition.request;
      const inspection = await directories.inspect(
        {
          operationId: operationId ?? request.operationId,
          projectId: request.projectId,
          originThreadId: request.originThreadId,
          hostId: request.hostId,
        },
        { kind: "user" },
      );
      if (inspection.state === "pending") return false;
      if (
        inspection.state !== "ready" ||
        runtimeHash(inspection.source) !==
          runtimeHash(original.definition.source)
      )
        throw new AgentStoreError(
          "instruction_source_changed",
          "The original folder changed or could not be verified. Cancel this update and review the source again.",
        );
    } else {
      const actual = await host.call(
        "inspectWorkspace",
        { path: definition.source.path, expected: null },
        { hostId: definition.request.hostId },
      );
      const source = {
        path: actual.path,
        commonGitDir: actual.commonGitDir,
        head: actual.head,
        branch: actual.currentBranch,
        stateHash: actual.stateDigest,
      };
      if (
        !actual.clean ||
        runtimeHash(source) !== runtimeHash(original.definition.source)
      )
        throw new AgentStoreError(
          "instruction_source_changed",
          "The original Git checkout changed. Cancel this update and review the source again.",
        );
    }
    return true;
  }
  async function cancel(
    key: Key & { previewId: string; previewHash: string },
    actor: AgentActor,
  ) {
    requireUser(actor);
    const reviewed = updates.preview(key.previewId);
    if (reviewed.preview.runId !== key.runId)
      throw new AgentStoreError(
        "instruction_update_conflict",
        "This preview belongs to another run",
      );
    const existing = updates.find(key);
    let application = updates.reserve(key);
    if (!existing)
      return notify(updates.transition(key, ["pausing"], "cancelled"));
    if (application.state === "cancelled") return application;
    if (application.state === "applied") return application;
    application = updates.transition(
      key,
      ["pausing", "checking", "starting", "failed", "cancelling"],
      "cancelling",
    );
    const current = load(key.runId);
    const inspected = await workflows.call("inspectOwnedContinuation", {
      predecessorWorkflowRunId: current.workflowRunId,
      operationId: key.operationId,
    });
    if (
      inspected.continuation?.state === "started" &&
      inspected.continuation.successor
    ) {
      store.submitted(
        application.successorRunId,
        inspected.continuation.successor.workflowRunId,
      );
      return notify(updates.transition(key, ["cancelling"], "applied"));
    }
    if (
      inspected.continuation?.successorPlanHash !== null &&
      inspected.continuation !== null
    )
      return notify(updates.transition(key, ["cancelling"], "starting"));
    const retained = updates.preview(application.preview.previewId);
    if (retained.compiled.definition.schemaVersion === 4) {
      const request = retained.compiled.definition.request;
      const operations = [request.operationId, updates.sourceRetry(key)].filter(
        (value): value is string => value !== null,
      );
      for (const operationId of operations) {
        const setup = store.directories.getSetup({
          projectId: request.projectId,
          operationId,
        });
        if (setup && setup.record?.state !== "terminal") {
          const record = await host.call(
            "interruptDirectoryEffect",
            {
              runId: setup.job.runId,
              effectId: setup.job.effectId,
              requestHash: directoryEffectRequestHash(setup.job),
            },
            { hostId: request.hostId },
          );
          if (record)
            store.directories.recordSetupInspection({
              projectId: request.projectId,
              operationId,
              record,
            });
          if (record && record.state !== "terminal") return notify(application);
        }
      }
    }
    if (inspected.continuation === null)
      return notify(updates.transition(key, ["cancelling"], "cancelled"));
    const { continuation } = await workflows.call("cancelOwnedContinuation", {
      predecessorWorkflowRunId: current.workflowRunId,
      operationId: key.operationId,
    });
    if (continuation.state !== "cancelled") return notify(application);
    return notify(updates.transition(key, ["cancelling"], "cancelled"));
  }
  async function progress(
    key: Key,
    actor: AgentActor,
  ): Promise<RunUpdateApplication> {
    requireUser(actor);
    let application = updates.get(key);
    if (["applied", "cancelled", "failed"].includes(application.state))
      return application;
    if (application.state === "cancelling")
      return cancel(
        {
          ...key,
          previewId: application.preview.previewId,
          previewHash: application.preview.previewHash,
        },
        actor,
      );
    const current = load(key.runId);
    const { continuation } = await workflows.call("reserveOwnedContinuation", {
      predecessorWorkflowRunId: current.workflowRunId,
      operationId: key.operationId,
      expectedControlVersion: application.preview.controlVersion,
      successorOwnerRunId: application.successorRunId,
    });
    if (continuation.state === "started" && continuation.successor) {
      store.submitted(
        application.successorRunId,
        continuation.successor.workflowRunId,
      );
      return notify(
        updates.transition(key, ["pausing", "checking", "starting"], "applied"),
      );
    }
    if (continuation.state === "cancelled")
      return notify(
        updates.transition(
          key,
          ["pausing", "checking", "cancelling"],
          "cancelled",
        ),
      );
    if (continuation.state === "pausing") return notify(application);
    const retryingStart =
      application.state === "starting" && continuation.state === "ready";
    if (continuation.state !== "retiring") {
      application = updates.transition(
        key,
        ["pausing", "checking"],
        "checking",
      );
      if (application.state !== "checking" && application.state !== "starting")
        return application;
      if (application.state === "checking") {
        try {
          await validatePreview(application);
          if (!(await scan(application))) return notify(updates.get(key));
          await validatePreview(application);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          updates.transition(key, ["checking"], "checking", reason);
          throw error;
        }
        application = updates.transition(key, ["checking"], "starting");
        if (application.state !== "starting") return application;
      }
    }
    let retryOperationId: string | null = null;
    if (retryingStart) {
      await validatePreview(application);
      retryOperationId = updates.reserveSourceRetry(key);
      if (!(await scan(application, retryOperationId)))
        return notify(updates.get(key));
      await validatePreview(application);
      application = updates.get(key);
      if (application.state !== "starting") return application;
    }
    const retained = updates.preview(application.preview.previewId);
    const successor =
      retained.compiled.definition.schemaVersion === 4
        ? store.directories.consumeSetup(
            retained.compiled.definition.request,
            retained.compiled.definition.runId,
            () => store.reserve(retained.compiled),
          )
        : store.reserve(retained.compiled);
    if (retryOperationId !== null) {
      const operationId = retryOperationId;
      if (retained.compiled.definition.schemaVersion === 4) {
        const request = retained.compiled.definition.request;
        const proof = store.directories.getSetup({
          projectId: request.projectId,
          operationId,
        });
        if (!proof || proof.job.operation.type !== "scan-directory")
          throw new AgentStoreError(
            "instruction_source_conflict",
            "The supplemental source proof is missing",
          );
        store.directories.consumeSetup(
          {
            ...request,
            operationId,
            sourceInspectionId: proof.job.operation.validationId,
          },
          application.successorRunId,
          () => updates.consumeSourceRetry(key, operationId),
        );
      } else updates.consumeSourceRetry(key, operationId);
    }
    const successorInput = {
      predecessorWorkflowRunId: current.workflowRunId,
      operationId: key.operationId,
      successor: successor.compiled.workflow,
    };
    const rule = "kind" in application.preview ? application.preview : null;
    let started;
    if (rule !== null) {
      if (
        !("schemaVersion" in successor.compiled.workflow) ||
        successor.compiled.workflow.schemaVersion !== 2
      )
        throw new AgentStoreError(
          "rule_update_unsupported",
          "Operational rules require a Team workflow",
        );
      const context = await workflows.call("inspectOwnedRuleContext", {
        workflowRunId: current.workflowRunId,
      });
      if (continuation.state !== "retiring") {
        const blockers = ruleBudgetBlockers(
          rule.newPolicy.effective,
          rule.repairStages,
          context,
        );
        if (blockers.length)
          throw new AgentStoreError(
            "rule_update_blocked",
            blockers
              .map((blocker) => `${blocker.code}: ${blocker.message}`)
              .join(" "),
          );
        await validatePreview(application);
        if (updates.get(key).state !== "starting")
          return notify(updates.get(key));
      }
      ({ continuation: started } = await workflows.call(
        "startOwnedRuleContinuation",
        {
          ...successorInput,
          successor: successor.compiled.workflow,
          authorization: {
            schemaVersion: 1,
            reviewHash: rule.previewHash,
            repairStages: rule.repairStages.map(
              ({ stageId, beforeMaxRounds, afterMaxRounds }) => ({
                stageId,
                beforeMaxRounds,
                afterMaxRounds,
              }),
            ),
          },
        },
      ));
    } else
      ({ continuation: started } = await workflows.call(
        "startOwnedContinuation",
        successorInput,
      ));
    if (started.state === "started" && started.successor) {
      store.submitted(successor.summary.runId, started.successor.workflowRunId);
      application = updates.transition(key, ["starting"], "applied");
    }
    return notify(application);
  }
  function requireKind(
    preview: ReturnType<typeof updates.preview>["preview"],
    kind: "instructions" | "rules",
  ) {
    if (("kind" in preview ? "rules" : "instructions") !== kind)
      throw new AgentStoreError(
        "run_update_kind_mismatch",
        "Use the same update action that created this reviewed operation",
      );
  }
  function cancelRequest(
    key: Key & { previewId: string; previewHash: string },
    actor: AgentActor,
    kind: "instructions" | "rules",
  ) {
    requireUser(actor);
    const reviewed = updates.preview(key.previewId);
    requireKind(reviewed.preview, kind);
    if (reviewed.preview.runId !== key.runId)
      throw new AgentStoreError(
        "instruction_update_conflict",
        "This preview belongs to another run",
      );
    const existing = updates.find(key);
    const application = updates.reserve(key);
    if (!existing)
      return Promise.resolve(
        notify(updates.transition(key, ["pausing"], "cancelled")),
      );
    if (application.state === "applied") return Promise.resolve(application);
    updates.transition(
      key,
      ["pausing", "checking", "starting", "failed"],
      "cancelling",
    );
    return serialized(key, () => cancel(key, actor));
  }
  async function apply(
    input: ApplyInput,
    actor: AgentActor,
    kind: "instructions" | "rules",
  ) {
    requireUser(actor);
    const retained = updates.preview(input.previewId);
    requireKind(retained.preview, kind);
    const existing = updates.find({
      runId: retained.preview.runId,
      operationId: input.operationId,
    });
    if (!existing) {
      const selected =
        "kind" in retained.preview
          ? await ruleSelection({
              runId: retained.preview.runId,
              team: retained.preview.newTeam,
              expectedProjectPolicyVersion:
                retained.preview.newPolicy.projectVersion,
              expectedSessionPolicyVersion:
                retained.preview.newPolicy.sessionVersion,
            })
          : selection({
              runId: retained.preview.runId,
              team: retained.preview.newTeam,
            });
      if ("blockers" in selected && selected.blockers.length)
        throw new AgentStoreError(
          "rule_update_blocked",
          selected.blockers
            .map((blocker) => `${blocker.code}: ${blocker.message}`)
            .join(" "),
        );
      const { run } = await workflows.call("inspectOwnedRun", {
        workflowRunId: selected.current.workflowRunId,
      });
      if (
        run.controlVersion !== retained.preview.controlVersion ||
        selected.current.summary.planHash !== retained.preview.planHash ||
        ["succeeded", "failed", "cancelled"].includes(run.state)
      )
        throw new AgentStoreError(
          "instruction_preview_stale",
          "This run changed since preview. Review the instruction update again.",
        );
      await validatePreview({
        runId: retained.preview.runId,
        preview: retained.preview,
      });
    }
    const application = updates.reserve(input);
    return serialized(application, () => progress(application, actor));
  }
  function state(runId: string, actor: AgentActor) {
    const { summary } = store.get(runId);
    if (actor.kind === "agent" && actor.projectId !== summary.projectId)
      throw new AgentStoreError(
        "scope_denied",
        "This run belongs to another project",
      );
    return updates.lineage(runId);
  }
  const instruction = (application: RunUpdateApplication) =>
    instructionUpdateApplicationSchema.parse(application);
  const rules = (application: RunUpdateApplication) =>
    ruleUpdateApplicationSchema.parse(application);
  const entry = (application: RunUpdateApplication | null) =>
    application === null
      ? null
      : "kind" in application.preview
        ? { kind: "rules" as const, application: rules(application) }
        : {
            kind: "instructions" as const,
            application: instruction(application),
          };
  return {
    preview,
    previewRules,
    apply: (input: ApplyInput, actor: AgentActor) =>
      apply(input, actor, "instructions").then(instruction),
    applyRules: (input: ApplyInput, actor: AgentActor) =>
      apply(input, actor, "rules").then(rules),
    progress(key: Key, actor: AgentActor) {
      requireUser(actor);
      requireKind(updates.get(key).preview, "instructions");
      return serialized(key, () => progress(key, actor)).then(instruction);
    },
    progressRules(key: Key, actor: AgentActor) {
      requireUser(actor);
      requireKind(updates.get(key).preview, "rules");
      return serialized(key, () => progress(key, actor)).then(rules);
    },
    cancel: (
      key: Key & { previewId: string; previewHash: string },
      actor: AgentActor,
    ) => cancelRequest(key, actor, "instructions").then(instruction),
    cancelRules: (
      key: Key & { previewId: string; previewHash: string },
      actor: AgentActor,
    ) => cancelRequest(key, actor, "rules").then(rules),
    state(runId: string, actor: AgentActor) {
      const lineage = state(runId, actor);
      const legacy = (application: RunUpdateApplication | null) =>
        application !== null && !("kind" in application.preview)
          ? instruction(application)
          : null;
      return {
        incoming: legacy(lineage.incoming),
        outgoing: legacy(lineage.outgoing),
      };
    },
    unifiedState(runId: string, actor: AgentActor) {
      const lineage = state(runId, actor);
      return runUpdateStateSchema.parse({
        incoming: entry(lineage.incoming),
        outgoing: entry(lineage.outgoing),
      });
    },
    async resumeSuccessor(runId: string) {
      const incoming = updates.lineage(runId).incoming;
      if (!incoming) return false;
      await serialized(incoming, () => progress(incoming, { kind: "user" }));
      return true;
    },
  };
}

import type {
  BbPluginApi,
  ExperimentalAddressedDispatchContext,
  ExperimentalAddressedDispatchResult,
} from "@get-bb/plugin-sdk";
import { AgentStoreError, type AgentStore } from "../data.js";
import type { TeamStore } from "../teams/data.js";
import type { TeamDefinition, TeamNode } from "../teams/contract.js";
import { teamHashes } from "../teams/validation.js";
import type { PolicyStore } from "../policy/data.js";
import type { PolicyService } from "../policy/service.js";
import type { ArcTemplateService } from "../templates/service.js";
import { addressedRecipientScope } from "../addressing/mentions.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { ArcRunStore } from "./data.js";
import type { ArcRunService } from "./service.js";
import {
  addressedIdentity,
  composeAddressedTeams,
  type AddressedComponent,
} from "./addressed-composition.js";
import { addressedAttachmentSchema } from "./orchestrated-contract.js";
import {
  loadRunExecutionInheritance,
  resolveRunAgentSnapshot,
} from "./execution-snapshot.js";
import type { RunAgentSnapshot } from "./definition.js";
import { runtimeHash } from "./hash.js";
import { latestAddressedRun } from "./addressed-continuation.js";
import { sealCompositionAuthorization } from "./composition-authorization.js";
import type { CompositionOrigin } from "./composition-authorization-contract.js";

function standaloneComponent(
  agent: RunAgentSnapshot,
  reviewer: RunAgentSnapshot,
  check: Extract<TeamNode, { kind: "check" }>["command"],
  operationId: string,
): AddressedComponent {
  const candidate = { kind: "node" as const, nodeId: "build" };
  const definition: TeamDefinition = {
    schemaVersion: 2,
    name: agent.definition.metadata.name,
    description:
      "A directly addressed agent with project checks, bounded repair and independent review.",
    leaderMemberId: null,
    groups: [],
    members: [
      {
        id: "agent",
        agentId: agent.definition.agentId,
        revision: agent.definition.revision,
        groupId: null,
      },
      {
        id: "reviewer",
        agentId: reviewer.definition.agentId,
        revision: reviewer.definition.revision,
        groupId: null,
      },
    ],
    permissions: [
      {
        id: "review",
        fromMemberId: "reviewer",
        toMemberId: "agent",
        action: "review",
      },
    ],
    graph: {
      nodes: [
        {
          id: "build",
          label: "Assigned work",
          kind: "agent",
          memberId: "agent",
          task: "Complete your addressed assignment using the coordinator's scoped handoff and the user request. Preserve required checks and report concrete results.",
          access: "write",
          candidate: { kind: "source" },
        },
        {
          id: "check",
          label: "Required project check",
          kind: "check",
          command: check,
          candidate,
        },
        {
          id: "repair",
          label: "Bounded repair",
          kind: "repair",
          body: {
            memberId: "agent",
            task: "Repair the concrete check failure without weakening its definition.",
          },
          checkNodeId: "check",
          maxRounds: 2,
        },
        {
          id: "review",
          label: "Review passing candidate",
          kind: "review",
          memberId: "reviewer",
          task: "Independently review the exact checked candidate. Submit arc_run_review with actual findings.",
          candidate,
        },
        {
          id: "review-repair",
          label: "Review repaired candidate",
          kind: "review",
          memberId: "reviewer",
          task: "Independently review the exact repaired and rechecked candidate. Submit arc_run_review with actual findings.",
          candidate: { kind: "node", nodeId: "repair" },
        },
      ],
      edges: [
        {
          id: "build-check",
          source: "build",
          target: "check",
          sourceHandle: "next",
          requiredOutcome: "succeeded",
        },
        {
          id: "check-review",
          source: "check",
          target: "review",
          sourceHandle: "next",
          requiredOutcome: "succeeded",
        },
        {
          id: "check-repair",
          source: "check",
          target: "repair",
          sourceHandle: "next",
          requiredOutcome: "failed",
        },
        {
          id: "repair-review",
          source: "repair",
          target: "review-repair",
          sourceHandle: "repaired",
          requiredOutcome: "succeeded",
        },
      ],
      entryNodeIds: ["build"],
      requiredGates: [
        { id: "checked", mode: "any", nodeIds: ["check", "repair"] },
        { id: "reviewed", mode: "any", nodeIds: ["review", "review-repair"] },
      ],
    },
    presentation: { nodes: [], members: [], groups: [] },
  };
  return {
    revision: {
      teamId: addressedIdentity(operationId, "team"),
      revision: 1,
      ...teamHashes(definition),
      createdAt: Date.now(),
    },
    members: { agent, reviewer },
  };
}

export function createAddressedDispatch(
  bb: BbPluginApi,
  agents: AgentStore,
  teams: TeamStore,
  store: ArcRunStore,
  runs: ArcRunService,
  policies: PolicyStore,
  policy: PolicyService,
  templates: ArcTemplateService,
) {
  return async (
    context: ExperimentalAddressedDispatchContext,
  ): Promise<ExperimentalAddressedDispatchResult> => {
    if (
      context.recipients.length === 0 ||
      context.recipients.length > 12 ||
      context.recipients.some((recipient) => recipient.pluginId !== bb.pluginId)
    )
      throw new AgentStoreError(
        "recipients_invalid",
        "Choose between one and twelve ARC recipients",
      );
    const recipients = context.recipients.map(
      ({ kind, entityId, versionId, scopeKey }) => ({
        kind,
        entityId,
        versionId,
        scopeKey,
      }),
    );
    if (
      new Set(
        recipients.map(
          (item) => `${item.kind}:${item.scopeKey}:${item.entityId}`,
        ),
      ).size !== recipients.length
    )
      throw new AgentStoreError(
        "duplicate_recipient",
        "Choose each recipient once, at one published version",
      );
    const text = context.prompt
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n\n")
      .trim();
    const goal =
      text ||
      "Inspect the attached material and complete the addressed request.";
    if (goal.length > 16_384)
      throw new AgentStoreError(
        "request_too_large",
        "Keep the request within 16,384 characters and attach larger source material as a file",
      );
    const attachments = context.prompt
      .filter((item) => item.type !== "text")
      .map((item) => {
        const { visibility: _visibility, ...attachment } = item;
        return addressedAttachmentSchema.parse(attachment);
      });
    if (
      attachments.length > 16 ||
      JSON.stringify(attachments).length > 16 * 1024 * 1024
    )
      throw new AgentStoreError(
        "attachments_too_large",
        "Use at most sixteen attachments and sixteen MiB of attachment references",
      );
    const existing = store.findOperation(
      context.projectId,
      context.operationId,
    );
    const continuation = runs.addressedContinuations.find(
      context.projectId,
      context.operationId,
    );
    if (continuation)
      return runs.continueAddressedRun(
        {
          projectId: context.projectId,
          threadId: context.threadId,
          operationId: context.operationId,
          goal,
          recipients,
          attachments,
        },
        continuation.rootRunId,
      );
    if (existing) {
      const request = existing.compiled.definition.request;
      if (
        !("addressedRecipients" in request) ||
        request.originThreadId !== context.threadId ||
        request.goal !== goal ||
        runtimeHash(request.addressedRecipients ?? []) !==
          runtimeHash(recipients) ||
        runtimeHash(request.addressedAttachments ?? []) !==
          runtimeHash(attachments)
      )
        throw new AgentStoreError(
          "run_conflict",
          "This Send operation already identifies a different addressed request",
        );
      const run = await runs.reconcileOrchestratedRun(existing.summary.runId);
      return {
        runId: run.summary.runId,
        status: "started",
        path: `/plugins/arc/workspace/${run.summary.runId}`,
        summary: `Addressed work is ${run.workflow?.state ?? "awaiting admission"}. Open its workspace to inspect assignments, checks and results.`,
      };
    }
    const prior = latestAddressedRun(
      store,
      context.projectId,
      context.threadId,
    );
    if (
      prior &&
      (prior.compiled.definition.schemaVersion === 3 ||
        prior.compiled.definition.schemaVersion === 4) &&
      runtimeHash(
        prior.compiled.definition.request.addressedRecipients ?? [],
      ) === runtimeHash(recipients)
    )
      return runs.continueAddressedRun(
        {
          projectId: context.projectId,
          threadId: context.threadId,
          operationId: context.operationId,
          goal,
          recipients,
          attachments,
        },
        prior.summary.runId,
        {
          revision: prior.compiled.definition.team,
          members: prior.compiled.definition.members,
          ...(prior.compiled.definition.compositionAuthorization === undefined
            ? {}
            : {
                compositionAuthorization:
                  prior.compiled.definition.compositionAuthorization,
              }),
        },
      );
    const parent = await bb.sdk.threads.get({ threadId: context.threadId });
    if (
      parent.projectId !== context.projectId ||
      parent.parentThreadId ||
      parent.experimental_executionContextId ||
      !parent.environmentId
    )
      throw new AgentStoreError(
        "origin_not_ready",
        "Open a ready main project conversation before sending addressed work",
      );
    const environment = await bb.sdk.environments.get({
      environmentId: parent.environmentId,
    });
    if (environment.status !== "ready")
      throw new AgentStoreError(
        "origin_not_ready",
        "Wait for the project environment to become ready, then retry this Send",
      );
    const setup = await runs.handlers().getProjectRunSetup({
      projectId: context.projectId,
      hostId: environment.hostId,
    });
    const settings = policies.view({
      projectId: context.projectId,
      threadId: context.threadId,
    });
    if (!settings.effective)
      throw new AgentStoreError("policy_conflict", settings.errors.join("; "));
    policy.validatePins(context.projectId, settings.effective);
    const inherited = await loadRunExecutionInheritance(
      bb,
      context.projectId,
      context.threadId,
    );
    const snapshot = (
      definition: RunAgentSnapshot["definition"],
      modelOverride?: Parameters<typeof resolveRunAgentSnapshot>[2],
    ) => {
      agents.assignedSkills.resolve(definition.metadata.skills ?? []);
      return resolveRunAgentSnapshot(definition, inherited, modelOverride);
    };
    const components: AddressedComponent[] = [];
    const standalone: RunAgentSnapshot[] = [];
    const origins: CompositionOrigin[] = [];
    for (const recipient of recipients) {
      const scope = addressedRecipientScope(
        recipient.scopeKey,
        context.projectId,
      );
      if (recipient.kind === "team") {
        const target = { scope, teamId: recipient.entityId };
        if (teams.getTeam(target).archivedAt !== null)
          throw new AgentStoreError(
            "team_archived",
            "Restore this team before addressing it",
          );
        const revision = teams.getRevision({
          ...target,
          revision: recipient.versionId,
        });
        policy.requireAllowed(settings.effective, {
          teamId: revision.teamId,
          revision: revision.revision,
        });
        origins.push({
          kind: "team",
          scope,
          entityId: revision.teamId,
          revision: revision.revision,
          contentHash: revision.contentHash,
        });
        const members = Object.fromEntries(
          revision.definition.members.map((member) => {
            const target = { scope, agentId: member.agentId };
            if (agents.getAgent(target).archivedAt !== null)
              throw new AgentStoreError(
                "agent_archived",
                "Restore every selected team member before sending",
              );
            agents.assignedSkills.resolve(member.skills ?? []);
            return [
              member.id,
              snapshot(
                agents.getRevision({ ...target, revision: member.revision }),
                member.modelOverride,
              ),
            ];
          }),
        );
        components.push({ revision, members });
      } else {
        if (settings.effective.restrictedTeams !== null)
          throw new AgentStoreError(
            "recipient_restricted",
            "This project restricts execution to specific teams. Add the agent to an allowed team before addressing it",
          );
        const target = { scope, agentId: recipient.entityId };
        if (agents.getAgent(target).archivedAt !== null)
          throw new AgentStoreError(
            "agent_archived",
            "Restore this agent before addressing it",
          );
        const revision = agents.getRevision({
          ...target,
          revision: recipient.versionId,
        });
        origins.push({
          kind: "agent",
          scope,
          entityId: revision.agentId,
          revision: revision.revision,
          contentHash: revision.contentHash,
        });
        standalone.push(snapshot(revision));
      }
    }
    let composition: AddressedComponent;
    if (components.length === 1 && standalone.length === 0)
      composition = components[0];
    else {
      const defaults = await templates.handlers().getTeamTemplateSetup({
        projectId: context.projectId,
        templateId: "efficient-build",
        version: 1,
      });
      if (!defaults.configuration)
        throw new AgentStoreError(
          "addressed_setup_required",
          "Use Efficient Build setup in Teams to save a project verification command and reviewer model before coordinating multiple recipients or a standalone agent",
        );
      const bundled = templates.ensureBundledAgents();
      const reviewerPin = bundled.get("reviewer")!;
      const reviewerDefinition = agents.getRevision({
        scope: { kind: "library" },
        ...reviewerPin,
      });
      const reviewer = resolveRunAgentSnapshot(reviewerDefinition, {
        ...defaults.configuration.roles.reviewer,
        providerId: defaults.configuration.roles.reviewer.providerId!,
        model: defaults.configuration.roles.reviewer.model!,
      });
      const leadMetadata = {
        ...defaultAgentMetadata("Main coordinator"),
        role: "Lead",
      };
      const leadDocument = serializeAgentDocument(
        leadMetadata,
        "Coordinate the addressed recipients through bounded source-linked reports. Preserve each recipient's restrictions and required checks. Never create unadmitted workers or silently broaden assignments.",
      );
      const lead = snapshot({
        agentId: addressedIdentity(context.threadId, "agent"),
        revision: 1,
        document: leadDocument,
        metadata: leadMetadata,
        attachments: [],
        contentHash: runtimeHash(leadDocument),
        createdAt: Date.now(),
      });
      for (const [index, agent] of standalone.entries())
        components.push(
          standaloneComponent(
            agent,
            reviewer,
            defaults.configuration.check,
            `${context.operationId}:agent:${index}`,
          ),
        );
      composition =
        components.length === 1
          ? components[0]
          : composeAddressedTeams({
              operationId: context.operationId,
              components,
              lead,
              reviewer,
              check: defaults.configuration.check,
              sourceKind: setup.selected.kind,
              createdAt: Date.now(),
            });
    }
    composition = {
      ...composition,
      compositionAuthorization: sealCompositionAuthorization(
        context.projectId,
        { team: composition.revision, members: composition.members },
        origins,
      ),
    };
    if (prior)
      return runs.continueAddressedRun(
        {
          projectId: context.projectId,
          threadId: context.threadId,
          operationId: context.operationId,
          goal,
          recipients,
          attachments,
        },
        prior.summary.runId,
        composition,
      );
    const common = {
      operationId: context.operationId,
      projectId: context.projectId,
      originThreadId: context.threadId,
      hostId: setup.selected.hostId,
      path: setup.selected.path,
      goal,
      team: {
        teamId: composition.revision.teamId,
        revision: composition.revision.revision,
      },
      expectedProjectPolicyVersion: settings.project.version,
      expectedSessionPolicyVersion: settings.session?.version ?? 0,
      invocation: null,
      addressedRecipients: recipients,
      addressedAttachments: attachments,
    };
    const run =
      setup.selected.kind === "git"
        ? await runs.startAddressedRun(
            { ...common, expectedHead: setup.selected.head },
            composition,
          )
        : await (async () => {
            const inspection = await runs.inspectDirectory(
              {
                operationId: context.operationId,
                projectId: context.projectId,
                originThreadId: context.threadId,
                hostId: setup.selected.hostId,
              },
              { kind: "user" },
            );
            if (inspection.state !== "ready")
              throw new AgentStoreError(
                "directory_inspection_pending",
                inspection.state === "failed"
                  ? inspection.reason
                  : "ARC is verifying this folder. Retry the same Send when its source inspection is ready",
              );
            return runs.startAddressedRun(
              {
                ...common,
                sourceInspectionId: inspection.sourceInspectionId,
                expectedSource: {
                  rootIdentity: inspection.source.rootIdentity,
                  manifestDigest: inspection.source.manifestDigest,
                },
              },
              composition,
            );
          })();
    return {
      runId: run.summary.runId,
      status: "started",
      path: `/plugins/arc/workspace/${run.summary.runId}`,
      summary: `Started one coordinated run for ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}. Open its workspace to watch assignments and required verification.`,
    };
  };
}

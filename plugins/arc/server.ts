import type {
  BbPluginApi,
  PluginAgentToolResult,
  PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  arcAgentsRpcContract,
  agentTargetSchema,
  type AgentSkillReference,
} from "./contract.js";
import { AgentStoreError, createAgentStore, migrations } from "./data.js";
import { createArcAgentService } from "./service.js";
import {
  registerSkillAuthoringTools,
  skillAuthoringMigrations,
} from "./skill-authoring-tools.js";
import { arcContextRpcContract } from "./context/contract.js";
import { contextMigrations, createContextStore } from "./context/data.js";
import { createArcContextService } from "./context/service.js";
import { arcHostContract } from "./host-contract.js";
import { registerArcCli } from "./cli.js";
import { createArcRunStore, runtimeMigrations } from "./runtime/data.js";
import { createArcRunService } from "./runtime/service.js";
import { directoryValidationMigrations } from "./runtime/directory-validation.js";
import { instructionUpdateMigrations } from "./runtime/instruction-update-data.js";
import { controlMigrations } from "./runtime/control-data.js";
import { arcRunsRpcContract, type ArcRunView } from "./runtime/contract.js";
import { arcPolicyRpcContract } from "./policy/contract.js";
import { createPolicyStore, policyMigrations } from "./policy/data.js";
import { createPolicyService } from "./policy/service.js";
import { createOrchestratorService } from "./orchestrator/service.js";
import {
  arcOrchestratorRpcContract,
  orchestratorToolRequestSchema,
  orchestratorToolContextSchema,
  directoryToolRequestSchema,
  directoryToolInspectionSchema,
} from "./orchestrator/contract.js";
import { arcWorkspaceRpcContract } from "./workspace/contract.js";
import { createArcWorkspaceService } from "./workspace/service.js";
import { threadBrowserMigrations } from "./threads/data.js";
import {
  assignedSkillConfiguration,
  assignedSkillMigrations,
} from "./assigned-skills.js";
import { collaborationMigrations } from "./runtime/collaboration-data.js";
import { addressedContinuationMigrations } from "./runtime/addressed-continuation-data.js";
import { arcTemplatesRpcContract } from "./templates/contract.js";
import {
  createArcTemplateService,
  templateMigrations,
} from "./templates/service.js";
import { registerArcAddressingMentions } from "./addressing/mentions.js";
import { createAddressedDispatch } from "./runtime/addressed-service.js";
import {
  arcTeamsRpcContract,
  arcTeamAssistantRpcContract,
  teamTargetSchema,
} from "./teams/contract.js";
import { createTeamStore, teamMigrations } from "./teams/data.js";
import { createArcTeamService } from "./teams/service.js";
import {
  createTeamAssistantStore,
  createTeamAssistantService,
  teamAssistantMigrations,
} from "./teams/assistant.js";
import {
  createAgentExecutionStore,
  executionInstructions,
} from "./execution.js";

function toolError(error: unknown): PluginAgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    ...migrations,
    ...runtimeMigrations,
    ...teamMigrations,
    ...teamAssistantMigrations,
    ...policyMigrations,
    ...controlMigrations,
    ...directoryValidationMigrations,
    ...instructionUpdateMigrations,
    ...contextMigrations,
    ...threadBrowserMigrations,
    ...assignedSkillMigrations,
    ...collaborationMigrations,
    ...templateMigrations,
    ...addressedContinuationMigrations,
    ...skillAuthoringMigrations,
  ]);
  const store = createAgentStore(db);
  const contextService = createArcContextService(createContextStore(db), {
    project: (projectId) => bb.sdk.projects.get({ projectId }),
    environment: (environmentId) => bb.sdk.environments.get({ environmentId }),
    host: bb.hosts.experimental_client({ contract: arcHostContract }),
    changed: (projectId) =>
      bb.realtime.publish("context:changed", { projectId }),
  });
  bb.rpc.register(arcContextRpcContract, contextService.handlers());
  const executions = createAgentExecutionStore(db, store);
  const runStore = createArcRunStore(db);
  const teamStore = createTeamStore(db, store);
  const policyStore = createPolicyStore(db);
  const policy = createPolicyService(policyStore, teamStore, {
    async listThreads(input) {
      return (
        await bb.sdk.threads.list({
          ...input,
          hasParent: false,
          includeHidden: false,
        })
      ).map(({ id, title }) => ({
        id,
        title: title ?? "Untitled conversation",
      }));
    },
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    async threadProject(threadId) {
      return (await bb.sdk.threads.get({ threadId })).projectId;
    },
    changed(target) {
      bb.realtime.publish("policy:changed", target);
    },
  });
  bb.rpc.register(arcPolicyRpcContract, policy.handlers());
  const runs = createArcRunService(bb, runStore, store, {
    teams: teamStore,
    policies: policyStore,
    policy,
  });
  const templates = createArcTemplateService(db, store, teamStore, {
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    async projectSource(projectId) {
      return (
        await runs.handlers().getProjectRunSetup({ projectId, hostId: null })
      ).selected;
    },
    async validateExecution(projectId, execution) {
      if (execution.providerId === null || execution.model === null)
        throw new Error("Choose a connected provider and model");
      const { selected } = await runs
        .handlers()
        .getProjectRunSetup({ projectId, hostId: null });
      const options = await bb.sdk.system.executionOptions({
        hostId: selected.hostId,
        providerId: execution.providerId,
      });
      const provider = options.providers.find(
        (value) => value.id === execution.providerId,
      );
      if (!provider?.available)
        throw new Error(
          "Install or authenticate this provider on the project's host, then refresh setup",
        );
      const model = options.models.find(
        (value) =>
          value.model === execution.model || value.id === execution.model,
      );
      if (!model)
        throw new Error(
          `The selected model is unavailable${options.modelLoadError ? ` (${options.modelLoadError.code})` : ""}. Refresh models or choose another connected model`,
        );
      if (
        execution.reasoningLevel !== null &&
        !model.supportedReasoningEfforts.some(
          (value) => value.reasoningEffort === execution.reasoningLevel,
        )
      )
        throw new Error("Choose a reasoning level supported by this model");
    },
    changed(team, copiedAgentIds) {
      bb.realtime.publish("teams:changed", {
        teamId: team.id,
        scope: team.scope,
      });
      for (const agentId of copiedAgentIds)
        bb.realtime.publish("agents:changed", { agentId, scope: team.scope });
    },
  });
  templates.ensureBundledAgents();
  registerArcAddressingMentions(bb, store, teamStore);
  bb.ui.experimental_registerAddressedDispatch(
    createAddressedDispatch(
      bb,
      store,
      teamStore,
      runStore,
      runs,
      policyStore,
      policy,
      templates,
    ),
  );
  bb.rpc.register(arcTemplatesRpcContract, templates.handlers());
  const workspace = createArcWorkspaceService(bb, runStore, runs);
  bb.rpc.register(arcRunsRpcContract, runs.handlers());
  runs.startAddressedContinuations();
  const orchestrator = createOrchestratorService(
    bb,
    store,
    teamStore,
    policy,
    runs,
  );
  bb.rpc.register(arcOrchestratorRpcContract, orchestrator.handlers());
  bb.rpc.register(arcWorkspaceRpcContract, workspace.handlers());
  const teamSessions = createTeamAssistantStore(db, teamStore);
  const teamAssistants = createTeamAssistantService(teamSessions, {
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    changed(event) {
      bb.realtime.publish("teams:changed", event);
    },
    async spawn(snapshot, prompt) {
      const project = await bb.sdk.projects.get({
        projectId: snapshot.projectId,
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: snapshot.projectId,
        environment:
          project.kind === "personal"
            ? { type: "host", workspace: { type: "personal" } }
            : { type: "project-default" },
        experimental_executionContextId: snapshot.executionContextId,
        title: `${snapshot.definition.name || "Untitled team"} · Team assistant`,
        prompt,
      });
      return { threadId: thread.id };
    },
  });
  const teams = createArcTeamService(teamStore, {
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    async authoringTeam(threadId, projectId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        thread.originPluginId !== bb.pluginId ||
        thread.projectId !== projectId ||
        !thread.experimental_executionContextId?.startsWith("team-execution_")
      )
        return null;
      return teamAssistants.authoringTeam(threadId, projectId);
    },
    changed(event) {
      bb.realtime.publish("teams:changed", event);
      for (const agentId of event.copiedAgentIds) {
        bb.realtime.publish("agents:changed", { agentId, scope: event.scope });
      }
    },
  });
  bb.rpc.register(arcTeamsRpcContract, teams.handlers());
  bb.rpc.register(arcTeamAssistantRpcContract, teamAssistants.handlers());

  async function teamSnapshot(threadId: string, projectId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (
      thread.originPluginId !== bb.pluginId ||
      thread.projectId !== projectId ||
      !thread.experimental_executionContextId?.startsWith("team-execution_")
    )
      throw new AgentStoreError(
        "execution_context_missing",
        "This tool requires this team's bound ARC authoring conversation",
      );
    return teamAssistants.snapshot(
      thread.experimental_executionContextId,
      projectId,
      threadId,
    );
  }

  async function threadSnapshot(threadId: string, projectId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (
      thread.originPluginId !== bb.pluginId ||
      thread.projectId !== projectId ||
      !thread.experimental_executionContextId
    )
      throw new AgentStoreError(
        "execution_context_missing",
        "This tool requires a bound ARC task in its current project",
      );
    return executions.bind(
      thread.experimental_executionContextId,
      projectId,
      threadId,
    );
  }

  registerSkillAuthoringTools(bb, db, store, async (context) => {
    const thread = await bb.sdk.threads.get({ threadId: context.threadId });
    if (thread.experimental_executionContextId?.startsWith("team-execution_")) {
      const snapshot = await teamSnapshot(context.threadId, context.projectId);
      const current = teamStore.getTeam({
        teamId: snapshot.teamId,
        scope: snapshot.scope,
      });
      const definitions = [snapshot.definition, current.draft.definition];
      return {
        executionContextId: snapshot.executionContextId,
        skills: definitions.flatMap((definition) =>
          definition.members.flatMap((member) => {
            let inherited: AgentSkillReference[] = [];
            try {
              inherited =
                store.getRevision({
                  scope: snapshot.scope,
                  agentId: member.agentId,
                  revision: member.revision,
                }).metadata.skills ?? [];
            } catch {}
            return [...(member.skills ?? []), ...inherited];
          }),
        ),
      };
    }
    const snapshot = await threadSnapshot(context.threadId, context.projectId);
    if (snapshot.purpose !== "assistant")
      throw new AgentStoreError(
        "scope_denied",
        "Skill authoring requires a bound agent or team assistant",
      );
    const current = store.getAgent({
      agentId: snapshot.agentId,
      scope: snapshot.scope,
    });
    return {
      executionContextId: snapshot.executionContextId,
      skills: [
        ...(snapshot.metadata.skills ?? []),
        ...(current.draft.metadata.skills ?? []),
      ],
    };
  });

  const service = createArcAgentService(store, {
    executions,
    skills: bb.sdk.skills,
    async spawn(snapshot, prompt) {
      const selected = snapshot.metadata.execution;
      const project = await bb.sdk.projects.get({
        projectId: snapshot.projectId,
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: snapshot.projectId,
        environment:
          project.kind === "personal"
            ? { type: "host", workspace: { type: "personal" } }
            : { type: "project-default" },
        experimental_executionContextId: snapshot.executionContextId,
        title: `${snapshot.metadata.name} · ${snapshot.purpose === "assistant" ? "Agent assistant" : `Test revision ${snapshot.revision}`}`,
        prompt,
        ...(selected.providerId === null
          ? {}
          : { providerId: selected.providerId }),
        ...(selected.model === null ? {} : { model: selected.model }),
        ...(selected.reasoningLevel === null
          ? {}
          : { reasoningLevel: selected.reasoningLevel }),
        ...(selected.serviceTier === null
          ? {}
          : { serviceTier: selected.serviceTier }),
        ...(selected.permissionMode === null
          ? {}
          : { permissionMode: selected.permissionMode }),
        executionInputSources: {
          ...(selected.providerId === null ? {} : { providerId: "explicit" }),
          ...(selected.model === null ? {} : { model: "explicit" }),
          ...(selected.reasoningLevel === null
            ? {}
            : { reasoningLevel: "explicit" }),
          ...(selected.serviceTier === null ? {} : { serviceTier: "explicit" }),
          ...(selected.permissionMode === null
            ? {}
            : { permissionMode: "explicit" }),
        },
      });
      return { threadId: thread.id };
    },
    async authoringAgent(threadId, projectId) {
      const snapshot = await threadSnapshot(threadId, projectId);
      return snapshot.purpose === "assistant" ? snapshot.agentId : null;
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects
          .filter((project) => project.kind !== "personal")
          .map(({ id, name }) => ({ id, name })),
        personalProjectId:
          projects.find((project) => project.kind === "personal")?.id ?? null,
      };
    },
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    changed(event) {
      bb.realtime.publish("agents:changed", event);
    },
  });
  bb.rpc.register(arcAgentsRpcContract, service.handlers());
  registerArcCli(
    bb,
    service,
    runs,
    workspace,
    teams,
    teamAssistants,
    policy,
    orchestrator,
    contextService,
    templates,
  );

  bb.agents.configure((ctx) => {
    const turnContext = ctx.experimental_turnContext;
    if (turnContext) {
      if (turnContext.ownerPluginId !== bb.pluginId)
        throw new AgentStoreError(
          "scope_denied",
          "Only ARC can configure its admitted main response",
        );
      return runs.completionConfiguration(
        turnContext.executionContextId,
        ctx.project.id,
        ctx.thread.id,
        turnContext.operationId,
      );
    }
    const executionContextId = ctx.thread.experimental_executionContextId;
    if (!executionContextId)
      return {
        tools: [
          "arc_agents_list",
          "arc_agent_read",
          "arc_agent_propose",
          "arc_teams_list",
          "arc_team_read",
          "arc_team_propose",
          ...(ctx.project.kind === "standard" &&
          ctx.thread.parentThreadId === null
            ? [
                "arc_orchestration_context",
                "arc_team_run_request",
                "arc_directory_source_inspect",
                "arc_directory_team_run_request",
              ]
            : []),
        ],
        skills: [],
      };
    if (ctx.origin.pluginId !== bb.pluginId)
      throw new AgentStoreError(
        "scope_denied",
        "ARC execution context requires its owning plugin",
      );
    if (executionContextId.startsWith("run-execution_"))
      return runs.configuration(
        executionContextId,
        ctx.project.id,
        ctx.thread.id,
      );
    if (executionContextId.startsWith("team-execution_"))
      return teamAssistants.configuration(
        executionContextId,
        ctx.project.id,
        ctx.thread.id,
      );
    const snapshot = executions.bind(
      executionContextId,
      ctx.project.id,
      ctx.thread.id,
    );
    return {
      tools:
        snapshot.purpose === "assistant"
          ? [
              "arc_agent_read",
              "arc_agent_propose",
              "arc_agent_snapshot",
              "arc_agent_reference_read",
              "arc_skill_bundle_create",
              "arc_skill_bundle_read",
            ]
          : ["arc_agent_snapshot", "arc_agent_reference_read"],
      skills: [],
      instructions: executionInstructions(snapshot),
      ...(snapshot.purpose === "test"
        ? assignedSkillConfiguration(store, snapshot.metadata.skills ?? [])
        : {}),
    };
  });

  bb.agents.registerTool({
    name: "arc_orchestration_context",
    description:
      "Read this main conversation's effective autonomy, exact policy versions, eligible published teams, preferred versions, project source and retained runs. Discovery never starts work.",
    parameters: orchestratorToolContextSchema,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await orchestrator.call(
            "getOrchestratorContext",
            { ...input, projectId: ctx.projectId, threadId: ctx.threadId },
            { kind: "agent", projectId: ctx.projectId, threadId: ctx.threadId },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
  async function teamRunResult(run: ArcRunView, ctx: PluginAgentToolContext) {
    if (
      run.definition.schemaVersion !== 3 &&
      run.definition.schemaVersion !== 4
    )
      throw new AgentStoreError(
        "run_conflict",
        "This request did not resolve to an admitted main-conversation run",
      );
    return JSON.stringify({
      summary: run.summary,
      team: {
        teamId: run.definition.team.teamId,
        revision: run.definition.team.revision,
        name: run.definition.team.definition.name,
      },
      policy: run.definition.policy,
      workflowState: run.workflow?.state ?? null,
      controls: await runs
        .handlers({
          kind: "agent",
          projectId: ctx.projectId,
          threadId: ctx.threadId,
        })
        .listRunControls({ runId: run.summary.runId, limit: 10, offset: 0 }),
      next: "Open this run in Workspace to inspect actual work and required approvals. Finish this turn; one completion response will be admitted in this chat within the same limits after the team settles. Budget exhaustion, cancellation or uncertain work cannot trigger an extra response.",
    });
  }
  bb.agents.registerTool({
    name: "arc_directory_source_inspect",
    description:
      "Inspect the full contents of this main conversation's non-Git project folder. This read-only operation creates no candidate and starts no agent.",
    instructions:
      "Use only when arc_orchestration_context reports a directory source. Start with operationId:null, then poll using the exact returned operationId while state is pending. A ready result supplies sourceInspectionId and exact expectedSource for arc_directory_team_run_request. A failed inspection explains the unsupported file or host error; do not silently exclude files or initialize Git. Refresh with operationId:null only after the old scan is settled or explicitly failed.",
    parameters: directoryToolInspectionSchema,
    presentation: {
      label: {
        pending: "Inspecting project folder",
        completed: "Folder inspection recorded",
      },
    },
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await orchestrator.inspectDirectoryFromTool(input, ctx),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_directory_team_run_request",
    description:
      "Request a serial published team for an inspected non-Git project. ARC runs in retained folder copies, preserves the original, obtains configured approvals and counts workers plus one main response within the same limits.",
    instructions:
      "Read arc_orchestration_context and finish arc_directory_source_inspect first. Supply the exact sourceInspectionId, rootIdentity, manifestDigest, host/path, published team and policy versions. The selected graph must preserve one serial candidate through checks, repair and review. After this returns, report the saved run and finish this turn so its admitted completion can arrive. Do not start another run to recover response loss; the user can reconcile the retained runId.",
    parameters: directoryToolRequestSchema,
    presentation: {
      label: {
        pending: "Requesting serial team work",
        completed: "Serial team work recorded",
      },
    },
    async execute(input, ctx) {
      try {
        return await teamRunResult(
          await orchestrator.requestDirectoryFromTool(input, ctx),
          ctx,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_team_run_request",
    description:
      "Request a published team from the main composer under the exact source and policy versions returned by arc_orchestration_context. ARC saves the run and obtains configured approvals. Its workers and one automatic main response share this run's limits. This does not authorize merge or deployment.",
    instructions:
      "For team work, first use arc_orchestration_context. Prefer the user's exact preferred versions when suitable; restrictions are mandatory and no preference leaves selection open. Choose one published team for the requested work and supply its exact revision, source and policy versions. Describe why it fits. After arc_team_run_request returns, report the retained run and any required approval, then finish this turn so the team can complete and its admitted main response can arrive. Do not poll, send extra worker messages, or use another operation to bypass a retained run. An automatic completion response may suggest follow-up work but cannot start a fresh run.",
    parameters: orchestratorToolRequestSchema,
    presentation: {
      label: {
        pending: "Requesting team work",
        completed: "Team work recorded",
      },
    },
    async execute(input, ctx) {
      try {
        return await teamRunResult(
          await orchestrator.requestFromTool(input, ctx),
          ctx,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_team_snapshot",
    description:
      "Read this team assistant's pinned authoring draft and exact version. Team definitions are editing material, not new operational authority.",
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      try {
        return JSON.stringify(await teamSnapshot(ctx.threadId, ctx.projectId));
      } catch (error) {
        return toolError(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_teams_list",
    description:
      "List saved ARC teams in the personal library or current project.",
    parameters: arcTeamsRpcContract.listTeams.input,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await teams.call("listTeams", input, {
            kind: "agent",
            threadId: ctx.threadId,
            projectId: ctx.projectId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_team_read",
    description:
      "Read an ARC team's latest draft, pinned members, structural diagnostics and execution availability.",
    parameters: teamTargetSchema,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await teams.call("getTeam", input, {
            kind: "agent",
            threadId: ctx.threadId,
            projectId: ctx.projectId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_team_propose",
    description:
      "Propose an exact-version team draft change for the user to inspect. This never applies, publishes or runs the definition. Personal-library changes require that team's bound assistant.",
    parameters: arcTeamsRpcContract.proposeTeamDraft.input,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await teams.call("proposeTeamDraft", input, {
            kind: "agent",
            threadId: ctx.threadId,
            projectId: ctx.projectId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_run_reference_read",
    description:
      "Read a page of UTF-8 source material from a reference pinned to this admitted worker's published agent revision.",
    parameters: z
      .object({
        attachmentId: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(32_000).default(16_000),
      })
      .strict(),
    async execute(input, ctx) {
      try {
        const item = await runs.toolContext(ctx.threadId, ctx.projectId);
        const definition = item.node.agent.definition;
        const file = definition.attachments.find(
          (value) => value.id === input.attachmentId,
        );
        if (!file)
          throw new AgentStoreError(
            "attachment_not_found",
            "This reference is not pinned to the admitted worker",
          );
        const { content } = store.readAttachment({
          agentId: definition.agentId,
          scope: { kind: "project", projectId: ctx.projectId },
          attachmentId: file.id,
        });
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (text.includes("\0"))
          throw new AgentStoreError(
            "binary_reference",
            "This reference is not plain UTF-8 text",
          );
        return JSON.stringify({
          attachment: file,
          offset: input.offset,
          content: text.slice(input.offset, input.offset + input.limit),
          totalCharacters: text.length,
          nextOffset:
            input.offset + input.limit < text.length
              ? input.offset + input.limit
              : null,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_agent_snapshot",
    description:
      "Read this ARC session's pinned agent definition, revision or draft version, and reference-file manifest. The execution context is resolved from the actual task.",
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      try {
        return JSON.stringify(
          await threadSnapshot(ctx.threadId, ctx.projectId),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_agent_reference_read",
    description:
      "Read a page of UTF-8 text from a reference file pinned to this ARC session. Binary PDF and Office files are retained for download; this tool does not extract them or execute their content.",
    parameters: z
      .object({
        attachmentId: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(32_000).default(16_000),
      })
      .strict(),
    async execute(input, ctx) {
      try {
        const snapshot = await threadSnapshot(ctx.threadId, ctx.projectId);
        const file = snapshot.attachments.find(
          (attachment) => attachment.id === input.attachmentId,
        );
        if (!file)
          throw new AgentStoreError(
            "attachment_not_found",
            "This reference file is not pinned to the current session",
          );
        if (
          !file.mimeType.startsWith("text/") &&
          !/\.(?:md|txt|json|jsonl|yaml|yml|csv|tsv|xml|html|css|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|toml|ini|sql)$/iu.test(
            file.name,
          )
        )
          throw new AgentStoreError(
            "binary_reference",
            "This file is available for download in Agent Studio. Text extraction for this format is not available in the current Agent Studio slice",
          );
        const { content } = store.readAttachment({
          agentId: snapshot.agentId,
          scope: snapshot.scope,
          attachmentId: file.id,
        });
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        if (text.includes("\0"))
          throw new AgentStoreError(
            "binary_reference",
            "Reference content is not plain UTF-8 text",
          );
        return JSON.stringify({
          attachment: file,
          offset: input.offset,
          content: text.slice(input.offset, input.offset + input.limit),
          totalCharacters: text.length,
          nextOffset:
            input.offset + input.limit < text.length
              ? input.offset + input.limit
              : null,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_agents_list",
    description:
      "List saved agent definitions in the personal library or this task's current project. This reads definitions; it does not create or run agents.",
    parameters: z
      .object({
        library: z.boolean().default(false),
        search: z.string().max(200).default(""),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await service.call(
            "listAgents",
            {
              scope: input.library
                ? { kind: "library" }
                : { kind: "project", projectId: ctx.projectId },
              search: input.search,
              offset: input.offset,
            },
            { kind: "agent", threadId: ctx.threadId, projectId: ctx.projectId },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_agent_read",
    description:
      "Read a saved ARC agent definition and its current draft version, metadata, and reference-file manifest. Project scope must match this task's project.",
    parameters: agentTargetSchema,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await service.call("getAgent", input, {
            kind: "agent",
            threadId: ctx.threadId,
            projectId: ctx.projectId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "arc_agent_propose",
    description:
      "Propose an edit to a project agent's canonical Markdown document against its exact draft version. The proposal is stored for review; it does not change the draft or operational permissions.",
    parameters: arcAgentsRpcContract.proposeAgentDraft.input,
    async execute(input, ctx) {
      try {
        return JSON.stringify(
          await service.call("proposeAgentDraft", input, {
            kind: "agent",
            threadId: ctx.threadId,
            projectId: ctx.projectId,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });
}

import type { PluginRpcHandlers, BbPluginApi } from "@get-bb/plugin-sdk";
import {
  arcAgentsRpcContract as contract,
  MAX_AGENT_ATTACHMENT_BYTES,
  type AgentDetail,
  type AgentScope,
  type ArcAgentsRpcContract,
} from "./contract.js";
import { AgentStoreError, type AgentStore } from "./data.js";
import type {
  AgentExecutionSnapshot,
  AgentExecutionStore,
} from "./execution.js";
import { parseSkillMarkdown, renderSkillMarkdown } from "./skill-authoring.js";

export type AgentActor =
  | { kind: "user" }
  | { kind: "agent"; threadId: string; projectId: string };

interface AgentServiceDependencies {
  skills?: BbPluginApi["sdk"]["skills"];
  executions: AgentExecutionStore;
  spawn(
    snapshot: AgentExecutionSnapshot,
    prompt: string,
  ): Promise<{ threadId: string }>;
  authoringAgent(threadId: string, projectId: string): Promise<string | null>;
  listProjects(): Promise<{
    projects: Array<{ id: string; name: string }>;
    personalProjectId: string | null;
  }>;
  requireProject(projectId: string): Promise<void>;
  changed(event: {
    agentId: string;
    scope: AgentScope;
    draftVersion: number;
    currentRevision: number | null;
  }): void;
}

export function decodeAttachmentBase64(content: string): Uint8Array {
  if (
    content.length > Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4 ||
    content.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(content)
  ) {
    throw new AgentStoreError(
      "invalid_attachment",
      "Reference file must be valid base64 within the 25 MB limit",
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (
    bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES ||
    bytes.toString("base64") !== content
  )
    throw new AgentStoreError(
      "invalid_attachment",
      "Reference file encoding is invalid or too large",
    );
  return bytes;
}

export function createArcAgentService(
  store: AgentStore,
  deps: AgentServiceDependencies,
) {
  async function scope(scope: AgentScope, actor: AgentActor): Promise<void> {
    if (scope.kind === "project") {
      if (actor.kind === "agent" && actor.projectId !== scope.projectId)
        throw new AgentStoreError(
          "scope_denied",
          "An agent can only access its current project",
        );
      await deps.requireProject(scope.projectId);
    }
  }

  function requireUser(actor: AgentActor): void {
    if (actor.kind !== "user")
      throw new AgentStoreError(
        "proposal_required",
        "Agents must propose definition edits for review; direct library and operational changes are user controlled",
      );
  }

  function result(agent: AgentDetail): { agent: AgentDetail } {
    deps.changed({
      agentId: agent.id,
      scope: agent.scope,
      draftVersion: agent.draft.version,
      currentRevision: agent.currentRevision,
    });
    return { agent };
  }

  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<ArcAgentsRpcContract> {
    return {
      async parseAgentSkillMarkdown(input) {
        requireUser(actor);
        const args = contract.parseAgentSkillMarkdown.input.parse(input);
        return { fields: parseSkillMarkdown(args.markdown) };
      },
      async renderAgentSkillMarkdown(input) {
        requireUser(actor);
        const args = contract.renderAgentSkillMarkdown.input.parse(input);
        return { markdown: renderSkillMarkdown(args.markdown, args.fields) };
      },
      async saveAgentSkillBundle(input) {
        requireUser(actor);
        return {
          skill: store.assignedSkills.save(
            contract.saveAgentSkillBundle.input.parse(input).files,
          ),
        };
      },
      async readAgentSkillBundle(input) {
        requireUser(actor);
        return {
          skill: store.assignedSkills.read(
            contract.readAgentSkillBundle.input.parse(input).id,
          ),
        };
      },
      async listAssignedSkillCatalog(input) {
        requireUser(actor);
        const args = contract.listAssignedSkillCatalog.input.parse(input);
        await deps.requireProject(args.projectId);
        if (!deps.skills)
          throw new Error(
            "skill_catalog_unavailable: Installed skills cannot be read on this server",
          );
        const result = await deps.skills.list(args);
        return {
          skills: result.skills.map(
            ({ id, name, description, scope, provider }) => ({
              id,
              name,
              description,
              scope,
              provider,
            }),
          ),
        };
      },
      async importInstalledAgentSkill(input) {
        requireUser(actor);
        const args = contract.importInstalledAgentSkill.input.parse(input);
        await deps.requireProject(args.projectId);
        if (!deps.skills)
          throw new Error(
            "skill_catalog_unavailable: Installed skills cannot be read on this server",
          );
        const listing = await deps.skills.listFiles(args);
        if (listing.truncated || listing.files.length > 128)
          throw new Error(
            "skill_files_truncated: Import the complete skill directory with at most 128 files",
          );
        const files = [];
        const revisions = new Map<string, string>();
        let bytes = 0;
        for (const path of listing.files) {
          const value = await deps.skills.getContent({ ...args, path });
          revisions.set(path, value.revision);
          bytes += Buffer.byteLength(value.content);
          if (bytes > 1024 * 1024)
            throw new Error(
              "skill_too_large: A skill directory cannot exceed 1 MiB",
            );
          if (value.content.includes("\uFFFD") || value.content.includes("\0"))
            throw new Error(
              "skill_binary_file: Import this skill directory directly to preserve binary support files",
            );
          files.push({
            path,
            contentBase64: Buffer.from(value.content).toString("base64"),
            executable: /\.(sh|py|mjs|js)$/iu.test(path),
          });
        }
        const current = await deps.skills.listFiles(args);
        if (
          current.truncated ||
          JSON.stringify([...current.files].sort()) !==
            JSON.stringify([...listing.files].sort())
        )
          throw new Error(
            "skill_changed: The installed skill changed during import; try again",
          );
        for (const path of listing.files) {
          const latest = await deps.skills.getContent({ ...args, path });
          if (latest.revision !== revisions.get(path))
            throw new Error(
              "skill_changed: The installed skill changed during import; try again",
            );
        }
        return { skill: store.assignedSkills.save(files) };
      },
      async startAgentAssistant(input) {
        requireUser(actor);
        const args = contract.startAgentAssistant.input.parse(input);
        await scope(args.scope, actor);
        await deps.requireProject(args.projectId);
        const snapshot = deps.executions.create({
          ...args,
          purpose: "assistant",
        });
        const { threadId } = await deps.spawn(snapshot, args.prompt);
        deps.executions.bind(
          snapshot.executionContextId,
          args.projectId,
          threadId,
        );
        result(store.getAgent(args));
        return { threadId, executionContextId: snapshot.executionContextId };
      },
      async startAgentTest(input) {
        requireUser(actor);
        const args = contract.startAgentTest.input.parse(input);
        await scope(args.scope, actor);
        await deps.requireProject(args.projectId);
        const snapshot = deps.executions.create({ ...args, purpose: "test" });
        const { threadId } = await deps.spawn(snapshot, args.prompt);
        deps.executions.bind(
          snapshot.executionContextId,
          args.projectId,
          threadId,
        );
        result(store.getAgent(args));
        return { threadId, executionContextId: snapshot.executionContextId };
      },
      async listAgentSessions(input) {
        const args = contract.listAgentSessions.input.parse(input);
        await scope(args.scope, actor);
        requireUser(actor);
        return deps.executions.list(args);
      },
      async listStudioProjects() {
        const { projects, personalProjectId } = await deps.listProjects();
        return {
          projects:
            actor.kind === "agent"
              ? projects.filter((project) => project.id === actor.projectId)
              : projects,
          personalProjectId:
            actor.kind === "agent" && actor.projectId !== personalProjectId
              ? null
              : personalProjectId,
        };
      },
      async listAgents(input) {
        const args = contract.listAgents.input.parse(input);
        await scope(args.scope, actor);
        return store.listAgents(args);
      },
      async getAgent(input) {
        const args = contract.getAgent.input.parse(input);
        await scope(args.scope, actor);
        return { agent: store.getAgent(args) };
      },
      async createAgent(input) {
        requireUser(actor);
        const args = contract.createAgent.input.parse(input);
        await scope(args.scope, actor);
        return result(store.createAgent(args));
      },
      async saveAgentDraft(input) {
        requireUser(actor);
        const args = contract.saveAgentDraft.input.parse(input);
        await scope(args.scope, actor);
        return result(store.saveDraft(args));
      },
      async publishAgentRevision(input) {
        requireUser(actor);
        const args = contract.publishAgentRevision.input.parse(input);
        await scope(args.scope, actor);
        return result(store.publish(args));
      },
      async restoreAgentRevision(input) {
        requireUser(actor);
        const args = contract.restoreAgentRevision.input.parse(input);
        await scope(args.scope, actor);
        return result(store.restore(args));
      },
      async copyAgentToProject(input) {
        requireUser(actor);
        const args = contract.copyAgentToProject.input.parse(input);
        await scope(args.scope, actor);
        await deps.requireProject(args.projectId);
        return result(store.copyToProject(args));
      },
      async setAgentArchived(input) {
        requireUser(actor);
        const args = contract.setAgentArchived.input.parse(input);
        await scope(args.scope, actor);
        return result(store.setArchived(args));
      },
      async listAgentRevisions(input) {
        const args = contract.listAgentRevisions.input.parse(input);
        await scope(args.scope, actor);
        return store.listRevisions(args);
      },
      async getAgentRevision(input) {
        const args = contract.getAgentRevision.input.parse(input);
        await scope(args.scope, actor);
        return { revision: store.getRevision(args) };
      },
      async addAgentAttachment(input) {
        requireUser(actor);
        const args = contract.addAgentAttachment.input.parse(input);
        await scope(args.scope, actor);
        return result(
          store.addAttachment({
            ...args,
            content: decodeAttachmentBase64(args.contentBase64),
          }),
        );
      },
      async readAgentAttachment(input) {
        const args = contract.readAgentAttachment.input.parse(input);
        await scope(args.scope, actor);
        const { attachment, content } = store.readAttachment(args);
        return {
          attachment,
          contentBase64: Buffer.from(content).toString("base64"),
        };
      },
      async proposeAgentDraft(input) {
        const args = contract.proposeAgentDraft.input.parse(input);
        await scope(args.scope, actor);
        if (
          actor.kind === "agent" &&
          args.scope.kind === "library" &&
          (await deps.authoringAgent(actor.threadId, actor.projectId)) !==
            args.agentId
        )
          throw new AgentStoreError(
            "scope_denied",
            "Only this library agent's bound authoring assistant can propose library edits",
          );
        const proposal = store.propose({
          ...args,
          authorThreadId: actor.kind === "agent" ? actor.threadId : null,
        });
        result(store.getAgent(args));
        return { proposal };
      },
      async listAgentProposals(input) {
        const args = contract.listAgentProposals.input.parse(input);
        await scope(args.scope, actor);
        return store.listProposals(args);
      },
      async getAgentProposal(input) {
        const args = contract.getAgentProposal.input.parse(input);
        await scope(args.scope, actor);
        return { proposal: store.getProposal(args) };
      },
      async applyAgentProposal(input) {
        requireUser(actor);
        const args = contract.applyAgentProposal.input.parse(input);
        await scope(args.scope, actor);
        return result(store.applyProposal(args));
      },
      async rejectAgentProposal(input) {
        requireUser(actor);
        const args = contract.rejectAgentProposal.input.parse(input);
        await scope(args.scope, actor);
        const proposal = store.rejectProposal(args);
        result(store.getAgent(args));
        return { proposal };
      },
    };
  }

  async function call(
    method: string,
    input: unknown,
    actor: AgentActor = { kind: "user" },
  ): Promise<unknown> {
    const api = handlers(actor);
    switch (method) {
      case "parseAgentSkillMarkdown":
        return api.parseAgentSkillMarkdown(
          contract.parseAgentSkillMarkdown.input.parse(input),
        );
      case "renderAgentSkillMarkdown":
        return api.renderAgentSkillMarkdown(
          contract.renderAgentSkillMarkdown.input.parse(input),
        );
      case "saveAgentSkillBundle":
        return api.saveAgentSkillBundle(
          contract.saveAgentSkillBundle.input.parse(input),
        );
      case "readAgentSkillBundle":
        return api.readAgentSkillBundle(
          contract.readAgentSkillBundle.input.parse(input),
        );
      case "listAssignedSkillCatalog":
        return api.listAssignedSkillCatalog(
          contract.listAssignedSkillCatalog.input.parse(input),
        );
      case "importInstalledAgentSkill":
        return api.importInstalledAgentSkill(
          contract.importInstalledAgentSkill.input.parse(input),
        );
      case "startAgentAssistant":
        return api.startAgentAssistant(
          contract.startAgentAssistant.input.parse(input),
        );
      case "startAgentTest":
        return api.startAgentTest(contract.startAgentTest.input.parse(input));
      case "listAgentSessions":
        return api.listAgentSessions(
          contract.listAgentSessions.input.parse(input),
        );
      case "listStudioProjects":
        return api.listStudioProjects(
          contract.listStudioProjects.input.parse(input),
        );
      case "listAgents":
        return api.listAgents(contract.listAgents.input.parse(input));
      case "getAgent":
        return api.getAgent(contract.getAgent.input.parse(input));
      case "createAgent":
        return api.createAgent(contract.createAgent.input.parse(input));
      case "saveAgentDraft":
        return api.saveAgentDraft(contract.saveAgentDraft.input.parse(input));
      case "publishAgentRevision":
        return api.publishAgentRevision(
          contract.publishAgentRevision.input.parse(input),
        );
      case "restoreAgentRevision":
        return api.restoreAgentRevision(
          contract.restoreAgentRevision.input.parse(input),
        );
      case "copyAgentToProject":
        return api.copyAgentToProject(
          contract.copyAgentToProject.input.parse(input),
        );
      case "setAgentArchived":
        return api.setAgentArchived(
          contract.setAgentArchived.input.parse(input),
        );
      case "listAgentRevisions":
        return api.listAgentRevisions(
          contract.listAgentRevisions.input.parse(input),
        );
      case "getAgentRevision":
        return api.getAgentRevision(
          contract.getAgentRevision.input.parse(input),
        );
      case "addAgentAttachment":
        return api.addAgentAttachment(
          contract.addAgentAttachment.input.parse(input),
        );
      case "readAgentAttachment":
        return api.readAgentAttachment(
          contract.readAgentAttachment.input.parse(input),
        );
      case "proposeAgentDraft":
        return api.proposeAgentDraft(
          contract.proposeAgentDraft.input.parse(input),
        );
      case "listAgentProposals":
        return api.listAgentProposals(
          contract.listAgentProposals.input.parse(input),
        );
      case "getAgentProposal":
        return api.getAgentProposal(
          contract.getAgentProposal.input.parse(input),
        );
      case "applyAgentProposal":
        return api.applyAgentProposal(
          contract.applyAgentProposal.input.parse(input),
        );
      case "rejectAgentProposal":
        return api.rejectAgentProposal(
          contract.rejectAgentProposal.input.parse(input),
        );
      default:
        throw new AgentStoreError(
          "unknown_method",
          `Unknown ARC Agent Studio method: ${method}`,
        );
    }
  }

  return { handlers, call };
}

export type ArcAgentService = ReturnType<typeof createArcAgentService>;

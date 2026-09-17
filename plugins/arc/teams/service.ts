import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { AgentScope } from "../contract.js";
import type { AgentActor } from "../service.js";
import {
  arcTeamsRpcContract as contract,
  type ArcTeamsRpcContract,
  type TeamDetail,
} from "./contract.js";
import { TeamStoreError, type TeamStore } from "./data.js";

interface TeamServiceDependencies {
  requireProject(projectId: string): Promise<void>;
  authoringTeam(threadId: string, projectId: string): Promise<string | null>;
  changed(event: {
    teamId: string;
    scope: AgentScope;
    draftVersion: number;
    currentRevision: number | null;
    copiedAgentIds: string[];
  }): void;
}

export function createArcTeamService(
  store: TeamStore,
  deps: TeamServiceDependencies,
) {
  async function scope(value: AgentScope, actor: AgentActor) {
    if (value.kind === "project") {
      if (actor.kind === "agent" && actor.projectId !== value.projectId)
        throw new TeamStoreError(
          "scope_denied",
          "An agent can only access its current project",
        );
      await deps.requireProject(value.projectId);
    }
  }
  function requireUser(actor: AgentActor) {
    if (actor.kind !== "user")
      throw new TeamStoreError(
        "proposal_required",
        "Agents must propose team edits for user review; publishing and operational changes are user controlled",
      );
  }
  function result(team: TeamDetail, copiedAgentIds: string[] = []) {
    deps.changed({
      teamId: team.id,
      scope: team.scope,
      draftVersion: team.draft.version,
      currentRevision: team.currentRevision,
      copiedAgentIds,
    });
    return { team };
  }
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<ArcTeamsRpcContract> {
    return {
      async listTeams(input) {
        const args = contract.listTeams.input.parse(input);
        await scope(args.scope, actor);
        return store.listTeams(args);
      },
      async getTeam(input) {
        const args = contract.getTeam.input.parse(input);
        await scope(args.scope, actor);
        return { team: store.getTeam(args) };
      },
      async createTeam(input) {
        requireUser(actor);
        const args = contract.createTeam.input.parse(input);
        await scope(args.scope, actor);
        return result(store.createTeam(args));
      },
      async saveTeamDraft(input) {
        requireUser(actor);
        const args = contract.saveTeamDraft.input.parse(input);
        await scope(args.scope, actor);
        return result(store.saveDraft(args));
      },
      async validateTeamDraft(input) {
        const args = contract.validateTeamDraft.input.parse(input);
        await scope(args.scope, actor);
        return store.getTeam(args).validation;
      },
      async publishTeamRevision(input) {
        requireUser(actor);
        const args = contract.publishTeamRevision.input.parse(input);
        await scope(args.scope, actor);
        return result(store.publish(args));
      },
      async restoreTeamRevision(input) {
        requireUser(actor);
        const args = contract.restoreTeamRevision.input.parse(input);
        await scope(args.scope, actor);
        return result(store.restore(args));
      },
      async copyTeamToProject(input) {
        requireUser(actor);
        const args = contract.copyTeamToProject.input.parse(input);
        await scope(args.scope, actor);
        await deps.requireProject(args.projectId);
        const team = store.copyToProject(args);
        return result(team, [
          ...new Set(
            team.draft.definition.members.map((member) => member.agentId),
          ),
        ]);
      },
      async setTeamArchived(input) {
        requireUser(actor);
        const args = contract.setTeamArchived.input.parse(input);
        await scope(args.scope, actor);
        return result(store.setArchived(args));
      },
      async listTeamRevisions(input) {
        const args = contract.listTeamRevisions.input.parse(input);
        await scope(args.scope, actor);
        return store.listRevisions(args);
      },
      async getTeamRevision(input) {
        const args = contract.getTeamRevision.input.parse(input);
        await scope(args.scope, actor);
        return { revision: store.getRevision(args) };
      },
      async proposeTeamDraft(input) {
        const args = contract.proposeTeamDraft.input.parse(input);
        await scope(args.scope, actor);
        if (
          actor.kind === "agent" &&
          args.scope.kind === "library" &&
          (await deps.authoringTeam(actor.threadId, actor.projectId)) !==
            args.teamId
        )
          throw new TeamStoreError(
            "scope_denied",
            "Only this library team's bound authoring assistant can propose library edits",
          );
        const proposal = store.propose({
          ...args,
          authorThreadId: actor.kind === "agent" ? actor.threadId : null,
        });
        result(store.getTeam(args));
        return { proposal };
      },
      async listTeamProposals(input) {
        const args = contract.listTeamProposals.input.parse(input);
        await scope(args.scope, actor);
        return store.listProposals(args);
      },
      async getTeamProposal(input) {
        const args = contract.getTeamProposal.input.parse(input);
        await scope(args.scope, actor);
        return { proposal: store.getProposal(args) };
      },
      async applyTeamProposal(input) {
        requireUser(actor);
        const args = contract.applyTeamProposal.input.parse(input);
        await scope(args.scope, actor);
        return result(store.applyProposal(args));
      },
      async rejectTeamProposal(input) {
        requireUser(actor);
        const args = contract.rejectTeamProposal.input.parse(input);
        await scope(args.scope, actor);
        const proposal = store.rejectProposal(args);
        result(store.getTeam(args));
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
      case "listTeams":
        return api.listTeams(contract.listTeams.input.parse(input));
      case "getTeam":
        return api.getTeam(contract.getTeam.input.parse(input));
      case "createTeam":
        return api.createTeam(contract.createTeam.input.parse(input));
      case "saveTeamDraft":
        return api.saveTeamDraft(contract.saveTeamDraft.input.parse(input));
      case "validateTeamDraft":
        return api.validateTeamDraft(
          contract.validateTeamDraft.input.parse(input),
        );
      case "publishTeamRevision":
        return api.publishTeamRevision(
          contract.publishTeamRevision.input.parse(input),
        );
      case "restoreTeamRevision":
        return api.restoreTeamRevision(
          contract.restoreTeamRevision.input.parse(input),
        );
      case "copyTeamToProject":
        return api.copyTeamToProject(
          contract.copyTeamToProject.input.parse(input),
        );
      case "setTeamArchived":
        return api.setTeamArchived(contract.setTeamArchived.input.parse(input));
      case "listTeamRevisions":
        return api.listTeamRevisions(
          contract.listTeamRevisions.input.parse(input),
        );
      case "getTeamRevision":
        return api.getTeamRevision(contract.getTeamRevision.input.parse(input));
      case "proposeTeamDraft":
        return api.proposeTeamDraft(
          contract.proposeTeamDraft.input.parse(input),
        );
      case "listTeamProposals":
        return api.listTeamProposals(
          contract.listTeamProposals.input.parse(input),
        );
      case "getTeamProposal":
        return api.getTeamProposal(contract.getTeamProposal.input.parse(input));
      case "applyTeamProposal":
        return api.applyTeamProposal(
          contract.applyTeamProposal.input.parse(input),
        );
      case "rejectTeamProposal":
        return api.rejectTeamProposal(
          contract.rejectTeamProposal.input.parse(input),
        );
      default:
        throw new TeamStoreError(
          "unknown_method",
          `Unknown ARC Team Builder method: ${method}`,
        );
    }
  }
  return { handlers, call };
}

export type ArcTeamService = ReturnType<typeof createArcTeamService>;

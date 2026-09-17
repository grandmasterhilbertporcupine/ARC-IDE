import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentStoreError, type AgentStore } from "../data.js";
import type { AgentActor } from "../service.js";
import type { PolicyService } from "../policy/service.js";
import type { ArcRunService } from "../runtime/service.js";
import type { TeamStore } from "../teams/data.js";
import { validateTeamDefinition } from "../teams/validation.js";
import { validateDirectoryTeamGraph } from "../runtime/directory-graph-validation.js";
import {
  arcOrchestratorRpcContract,
  orchestratorContextRequestSchema,
  type OrchestratorContext,
} from "./contract.js";

export function createOrchestratorContext(
  bb: BbPluginApi,
  agents: AgentStore,
  teams: TeamStore,
  policy: PolicyService,
  runs: ArcRunService,
) {
  return async function context(
    input: unknown,
    actor: AgentActor,
  ): Promise<OrchestratorContext> {
    const args = orchestratorContextRequestSchema.parse(input);
    if (
      actor.kind === "agent" &&
      (actor.projectId !== args.projectId || actor.threadId !== args.threadId)
    )
      throw new AgentStoreError(
        "scope_denied",
        "Read orchestration context from the current main conversation",
      );
    const [project, thread] = await Promise.all([
      bb.sdk.projects.get({ projectId: args.projectId }),
      bb.sdk.threads.get({ threadId: args.threadId }),
    ]);
    if (
      project.kind === "personal" ||
      thread.projectId !== project.id ||
      thread.parentThreadId != null ||
      thread.experimental_executionContextId != null ||
      thread.archivedAt != null
    )
      throw new AgentStoreError(
        "scope_denied",
        "Choose an active main conversation in this project",
      );
    async function source(): Promise<OrchestratorContext["source"]> {
      try {
        if (!thread.environmentId)
          throw new Error(
            "Open the main conversation in a ready project environment to select its source",
          );
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (
          environment.projectId !== args.projectId ||
          environment.status !== "ready"
        )
          throw new Error(
            "The main conversation's project environment is not ready",
          );
        const value = await runs.handlers(actor).getProjectRunSetup({
          projectId: args.projectId,
          hostId: environment.hostId,
        });
        return value.selected.kind === "directory"
          ? {
              state: "directory",
              hostId: value.selected.hostId,
              path: value.selected.path,
            }
          : {
              state: "ready",
              hostId: value.selected.hostId,
              path: value.selected.path,
              head: value.selected.head,
              clean: value.selected.clean,
            };
      } catch (error) {
        return {
          state: "unavailable",
          reason:
            error instanceof Error
              ? error.message
              : "The registered project source is unavailable",
        };
      }
    }
    const [settings, retainedRuns, setup] = await Promise.all([
      policy.handlers(actor).getOrchestrationPolicy({
        projectId: args.projectId,
        threadId: args.threadId,
      }),
      runs
        .handlers(actor)
        .listRuns({ projectId: args.projectId, limit: 10, offset: 0 }),
      source(),
    ]);
    const candidates =
      settings.effective === null
        ? { versions: [], total: 0 }
        : teams.listRunCandidates({
            projectId: args.projectId,
            preferredTeams: settings.effective.preferredTeams,
            restrictedTeams: settings.effective.restrictedTeams,
            search: args.search,
            limit: args.limit,
            offset: args.offset,
          });
    const scope = { kind: "project", projectId: args.projectId } as const;
    return arcOrchestratorRpcContract.getOrchestratorContext.output.parse({
      projectId: args.projectId,
      threadId: args.threadId,
      policy: settings,
      source: setup,
      teams: {
        total: candidates.total,
        versions: candidates.versions.map(
          ({ snapshot, latestRevision, preferred }) => {
            const roles = new Set<string>();
            const availableMembers = new Set<string>();
            const blockers: string[] = [];
            for (const member of snapshot.definition.members) {
              try {
                const target = { scope, agentId: member.agentId };
                const agent = agents.getAgent(target);
                const revision = agents.getRevision({
                  ...target,
                  revision: member.revision,
                });
                if (revision.metadata.role !== "")
                  roles.add(revision.metadata.role);
                if (agent.archivedAt === null)
                  availableMembers.add(`${member.agentId}:${member.revision}`);
                else
                  blockers.push(
                    `Restore ${revision.metadata.name} before starting this team`,
                  );
              } catch (error) {
                if (!(error instanceof AgentStoreError)) throw error;
                blockers.push(error.message);
              }
            }
            const validation = validateTeamDefinition(
              snapshot.definition,
              (agentId, revision) =>
                availableMembers.has(`${agentId}:${revision}`),
            );
            blockers.push(
              ...validation.diagnostics.map((item) => item.message),
              ...validation.execution.blockers.map((item) => item.message),
            );
            if (setup.state === "directory")
              blockers.push(
                ...validateDirectoryTeamGraph(
                  snapshot.definition,
                ).diagnostics.map((item) => item.message),
              );
            return {
              teamId: snapshot.teamId,
              revision: snapshot.revision,
              latestRevision,
              preferred,
              name: snapshot.definition.name,
              description: snapshot.definition.description,
              roles: [...roles],
              memberCount: snapshot.definition.members.length,
              execution: {
                available:
                  validation.execution.available && blockers.length === 0,
                blockers: [...new Set(blockers)],
              },
            };
          },
        ),
      },
      runs: retainedRuns,
    });
  };
}

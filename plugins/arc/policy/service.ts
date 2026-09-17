import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import type { AgentActor } from "../service.js";
import type { TeamStore } from "../teams/data.js";
import {
  arcPolicyRpcContract,
  resolveRunPolicy,
  type PolicyTarget,
  type ResolvedRunPolicy,
  type TeamPin,
} from "./contract.js";
import type { PolicyStore } from "./data.js";

interface PolicyDependencies {
  listThreads(input: {
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<Array<{ id: string; title: string }>>;
  requireProject(projectId: string): Promise<void>;
  threadProject(threadId: string): Promise<string>;
  changed(target: PolicyTarget): void;
}

export function createPolicyService(
  store: PolicyStore,
  teams: TeamStore,
  deps: PolicyDependencies,
) {
  async function scope(target: PolicyTarget, actor: AgentActor) {
    if (actor.kind === "agent" && actor.projectId !== target.projectId)
      throw new AgentStoreError(
        "scope_denied",
        "Choose orchestration settings in the current project",
      );
    await deps.requireProject(target.projectId);
    if (
      target.threadId !== null &&
      (await deps.threadProject(target.threadId)) !== target.projectId
    )
      throw new AgentStoreError(
        "scope_denied",
        "This conversation does not belong to the selected project",
      );
  }
  function requireUser(actor: AgentActor) {
    if (actor.kind !== "user")
      throw new AgentStoreError(
        "approval_required",
        "Only the user can change orchestration authority, team restrictions and execution limits",
      );
  }
  function validatePins(projectId: string, policy: ResolvedRunPolicy) {
    const pins = new Map(
      [...policy.preferredTeams, ...(policy.restrictedTeams ?? [])].map(
        (pin) => [`${pin.teamId}:${pin.revision}`, pin],
      ),
    );
    for (const pin of pins.values()) {
      const target = {
        teamId: pin.teamId,
        scope: { kind: "project", projectId } as const,
      };
      const team = teams.getTeam(target);
      if (team.archivedAt !== null)
        throw new AgentStoreError(
          "team_archived",
          "Restore the configured team or remove it from these settings",
        );
      teams.getRevision({ ...target, revision: pin.revision });
    }
  }
  function requireAllowed(policy: ResolvedRunPolicy, team: TeamPin) {
    if (
      policy.restrictedTeams !== null &&
      !policy.restrictedTeams.some(
        (pin) => pin.teamId === team.teamId && pin.revision === team.revision,
      )
    )
      throw new AgentStoreError(
        "team_restricted",
        "This exact team version is outside the configured allowed teams",
      );
  }
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<typeof arcPolicyRpcContract> {
    return {
      async listPolicySessions(input) {
        const args = arcPolicyRpcContract.listPolicySessions.input.parse(input);
        await scope({ projectId: args.projectId, threadId: null }, actor);
        const threads = await deps.listThreads({
          ...args,
          limit: args.limit + 1,
        });
        return {
          threads: threads.slice(0, args.limit),
          hasMore: threads.length > args.limit,
        };
      },
      async getOrchestrationPolicy(input) {
        const target =
          arcPolicyRpcContract.getOrchestrationPolicy.input.parse(input);
        await scope(target, actor);
        const value = store.view(target);
        if (value.effective !== null) {
          try {
            validatePins(target.projectId, value.effective);
          } catch (error) {
            return {
              ...value,
              effective: null,
              errors: [error instanceof Error ? error.message : String(error)],
            };
          }
        }
        return value;
      },
      async saveProjectPolicy(input) {
        requireUser(actor);
        const args = arcPolicyRpcContract.saveProjectPolicy.input.parse(input);
        const target = { projectId: args.projectId, threadId: null };
        await scope(target, actor);
        validatePins(args.projectId, args.policy);
        const value = store.saveProject(args);
        deps.changed(target);
        return value;
      },
      async saveSessionPolicy(input) {
        requireUser(actor);
        const args = arcPolicyRpcContract.saveSessionPolicy.input.parse(input);
        await scope(args, actor);
        const current = store.project(args.projectId);
        validatePins(
          args.projectId,
          resolveRunPolicy(current.policy, args.overrides),
        );
        const value = store.saveSession(args);
        deps.changed({ projectId: args.projectId, threadId: args.threadId });
        return value;
      },
      async listPolicyRevisions(input) {
        const args =
          arcPolicyRpcContract.listPolicyRevisions.input.parse(input);
        await scope(args, actor);
        return store.history(args);
      },
    };
  }
  return {
    handlers,
    validatePins,
    requireAllowed,
    async call(method: string, input: unknown, actor: AgentActor) {
      const methods = handlers(actor);
      switch (method) {
        case "listPolicySessions":
          return methods.listPolicySessions(
            arcPolicyRpcContract.listPolicySessions.input.parse(input),
          );
        case "getOrchestrationPolicy":
          return methods.getOrchestrationPolicy(
            arcPolicyRpcContract.getOrchestrationPolicy.input.parse(input),
          );
        case "saveProjectPolicy":
          return methods.saveProjectPolicy(
            arcPolicyRpcContract.saveProjectPolicy.input.parse(input),
          );
        case "saveSessionPolicy":
          return methods.saveSessionPolicy(
            arcPolicyRpcContract.saveSessionPolicy.input.parse(input),
          );
        case "listPolicyRevisions":
          return methods.listPolicyRevisions(
            arcPolicyRpcContract.listPolicyRevisions.input.parse(input),
          );
        default:
          throw new AgentStoreError(
            "method_not_found",
            "Unknown orchestration policy method",
          );
      }
    },
  };
}
export type PolicyService = ReturnType<typeof createPolicyService>;

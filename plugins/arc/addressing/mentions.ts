import type {
  BbPluginApi,
  PluginMentionProviderRegistration,
} from "@get-bb/plugin-sdk";
import { agentScopeSchema, type AgentScope } from "../contract.js";
import type { AgentStore } from "../data.js";
import type { createTeamStore } from "../teams/data.js";

export function registerArcAddressingMentions(
  bb: Pick<BbPluginApi, "ui">,
  agents: AgentStore,
  teams: ReturnType<typeof createTeamStore>,
) {
  for (const kind of ["agent", "team"] as const) {
    const provider: PluginMentionProviderRegistration = {
      id: kind === "agent" ? "agents" : "teams",
      label: kind === "agent" ? "Agents" : "Teams",
      search({ query, projectId }) {
        const scopes: AgentScope[] = projectId
          ? [{ kind: "project", projectId }, { kind: "library" }]
          : [{ kind: "library" }];
        return scopes.flatMap((scope) => {
          const input = {
            scope,
            search: query,
            includeArchived: false,
            limit: 12,
            offset: 0,
          };
          const rows =
            kind === "agent"
              ? agents.listAgents(input).agents
              : teams.listTeams(input).teams;
          return rows.flatMap((row) => {
            if (row.currentRevision === null) return [];
            const scopeKey =
              scope.kind === "library"
                ? "library"
                : `project:${scope.projectId}`;
            const identity = {
              kind,
              entityId: row.id,
              versionId: row.currentRevision,
              scopeKey,
            };
            const title =
              kind === "agent"
                ? agents.getRevision({
                    scope,
                    agentId: row.id,
                    revision: row.currentRevision,
                  }).metadata.name
                : teams.getRevision({
                    scope,
                    teamId: row.id,
                    revision: row.currentRevision,
                  }).definition.name;
            return [
              {
                id: encodeURIComponent(JSON.stringify(identity)),
                title,
                subtitle: `${scope.kind === "library" ? "Library" : "This project"} · v${row.currentRevision} · Send work`,
                experimental_recipient: identity,
              },
            ];
          });
        });
      },
      resolve() {
        throw new Error(
          "Use Send with the selected recipient chip to address work to this agent or team.",
        );
      },
    };
    bb.ui.registerMentionProvider(provider);
  }
}

export function addressedRecipientScope(
  scopeKey: string,
  projectId: string,
): AgentScope {
  if (scopeKey === "library")
    return agentScopeSchema.parse({ kind: "library" });
  if (scopeKey === `project:${projectId}`)
    return agentScopeSchema.parse({ kind: "project", projectId });
  throw new Error(
    "This recipient belongs to another project. Choose a recipient available in this project.",
  );
}

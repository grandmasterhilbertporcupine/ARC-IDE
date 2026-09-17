import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { AgentMetadata } from "../contract.js";
import type { AgentStore } from "../data.js";
import type { AgentActor } from "../service.js";
import { TeamStoreError, type TeamStore } from "../teams/data.js";
import type { TeamDetail } from "../teams/contract.js";
import {
  arcTemplatesRpcContract as contract,
  templateConfigurationSchema,
  templateRoleConfigurationSchema,
  templateRoles,
  type ArcTemplatesRpcContract,
  type TemplateRole,
} from "./contract.js";
import {
  efficientBuildDefinition,
  efficientBuildTemplate,
  templateAgentDocument,
  templateSkill,
} from "./catalog.js";

export const templateMigrations = [
  "CREATE TABLE arc_template_agents (template_id TEXT NOT NULL, template_version INTEGER NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (template_id, template_version, role))",
  "CREATE TABLE arc_template_defaults (template_id TEXT NOT NULL, template_version INTEGER NOT NULL, project_id TEXT NOT NULL, configuration_json TEXT NOT NULL, PRIMARY KEY (template_id, template_version, project_id))",
  "CREATE TABLE arc_template_installations (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, template_id TEXT NOT NULL, template_version INTEGER NOT NULL, project_id TEXT NOT NULL, team_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE arc_template_global_defaults (template_id TEXT NOT NULL, template_version INTEGER NOT NULL, roles_json TEXT NOT NULL, PRIMARY KEY (template_id, template_version))",
];

export function createArcTemplateService(
  db: Database.Database,
  agents: AgentStore,
  teams: TeamStore,
  deps: {
    requireProject(projectId: string): Promise<void>;
    projectSource(
      projectId: string,
    ): Promise<{ hostId: string; kind: "git" | "directory" }>;
    validateExecution(
      projectId: string,
      execution: AgentMetadata["execution"],
    ): Promise<void>;
    changed(team: TeamDetail, copiedAgentIds: string[]): void;
  },
) {
  const template = efficientBuildTemplate;
  function ensureBundledAgents() {
    return db.transaction(() => {
      const references = new Map<
        TemplateRole,
        { agentId: string; revision: number }
      >();
      for (const role of templateRoles) {
        let entry = db
          .prepare<
            [string, number, string],
            { agentId: string; revision: number }
          >(
            "SELECT agent_id AS agentId, revision FROM arc_template_agents WHERE template_id = ? AND template_version = ? AND role = ?",
          )
          .get(template.id, template.version, role);
        if (!entry) {
          const skill = agents.assignedSkills.save(templateSkill(role));
          const created = agents.createAgent({
            scope: { kind: "library" },
            document: templateAgentDocument(role, {
              id: skill.id,
              name: skill.name,
            }),
          });
          const published = agents.publish({
            scope: created.scope,
            agentId: created.id,
            expectedDraftVersion: created.draft.version,
          });
          if (published.currentRevision === null)
            throw new Error("Bundled agent did not publish");
          entry = {
            agentId: published.id,
            revision: published.currentRevision,
          };
          db.prepare(
            "INSERT INTO arc_template_agents (template_id, template_version, role, agent_id, revision) VALUES (?, ?, ?, ?, ?)",
          ).run(
            template.id,
            template.version,
            role,
            entry.agentId,
            entry.revision,
          );
        }
        references.set(role, entry);
      }
      return references;
    })();
  }
  async function project(projectId: string, actor: AgentActor) {
    if (actor.kind === "agent" && actor.projectId !== projectId)
      throw new TeamStoreError(
        "scope_denied",
        "Use templates only in your current project",
      );
    await deps.requireProject(projectId);
  }
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<ArcTemplatesRpcContract> {
    return {
      async listTeamTemplates() {
        return { templates: [template] };
      },
      async getTeamTemplateSetup(input) {
        const args = contract.getTeamTemplateSetup.input.parse(input);
        await project(args.projectId, actor);
        const source = await deps.projectSource(args.projectId);
        const row = db
          .prepare<[string, number, string], { configuration: string }>(
            "SELECT configuration_json AS configuration FROM arc_template_defaults WHERE template_id = ? AND template_version = ? AND project_id = ?",
          )
          .get(args.templateId, args.version, args.projectId);
        const global = db
          .prepare<[string, number], { roles: string }>(
            "SELECT roles_json AS roles FROM arc_template_global_defaults WHERE template_id = ? AND template_version = ?",
          )
          .get(args.templateId, args.version);
        const configuration = row
          ? templateConfigurationSchema.parse(JSON.parse(row.configuration))
          : null;
        return {
          configuration,
          defaultRoles:
            configuration?.roles ??
            (global
              ? templateRoleConfigurationSchema.parse(JSON.parse(global.roles))
              : null),
          defaultsSource: row ? "project" : global ? "global" : "none",
          hostId: source.hostId,
          blockers: [],
        };
      },
      async instantiateTeamTemplate(input) {
        if (actor.kind !== "user")
          throw new TeamStoreError(
            "proposal_required",
            "A user must choose role models and create a team from this template",
          );
        const args = contract.instantiateTeamTemplate.input.parse(input);
        await project(args.projectId, actor);
        const requestHash = createHash("sha256")
          .update(JSON.stringify(args))
          .digest("hex");
        const existing = db
          .prepare<[string], { requestHash: string; teamId: string }>(
            "SELECT request_hash AS requestHash, team_id AS teamId FROM arc_template_installations WHERE operation_id = ?",
          )
          .get(args.operationId);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new TeamStoreError(
              "operation_conflict",
              "This template operation already created a different configuration. Start a new copy to change it.",
            );
          return {
            team: teams.getTeam({
              teamId: existing.teamId,
              scope: { kind: "project", projectId: args.projectId },
            }),
            reused: true,
          };
        }
        const source = await deps.projectSource(args.projectId);
        for (const role of templateRoles) {
          try {
            await deps.validateExecution(
              args.projectId,
              args.configuration.roles[role],
            );
          } catch (error) {
            throw new TeamStoreError(
              "model_unavailable",
              `${template.roles.find((item) => item.id === role)!.name}: ${error instanceof Error ? error.message : "Choose an available model in provider setup"}`,
            );
          }
        }
        const created = db.transaction(() => {
          const retained = db
            .prepare<[string], { requestHash: string; teamId: string }>(
              "SELECT request_hash AS requestHash, team_id AS teamId FROM arc_template_installations WHERE operation_id = ?",
            )
            .get(args.operationId);
          if (retained) {
            if (retained.requestHash !== requestHash)
              throw new TeamStoreError(
                "operation_conflict",
                "This template operation already created a different configuration",
              );
            return {
              team: teams.getTeam({
                teamId: retained.teamId,
                scope: { kind: "project", projectId: args.projectId },
              }),
              copiedAgentIds: [],
              reused: true,
            };
          }
          const bundled = ensureBundledAgents();
          const scope = { kind: "project" as const, projectId: args.projectId };
          const members = new Map<
            TemplateRole,
            { agentId: string; revision: number }
          >();
          for (const role of templateRoles) {
            const source = bundled.get(role)!;
            const revision = agents.getRevision({
              scope: { kind: "library" },
              agentId: source.agentId,
              revision: source.revision,
            });
            const skill = revision.metadata.skills?.[0];
            if (!skill) throw new Error("Bundled role skill is missing");
            const agent = agents.createAgent({
              scope,
              sourceAgentId: source.agentId,
              sourceRevision: source.revision,
              document: templateAgentDocument(
                role,
                skill,
                args.configuration.roles[role],
              ),
            });
            const published = agents.publish({
              scope,
              agentId: agent.id,
              expectedDraftVersion: agent.draft.version,
            });
            if (published.currentRevision === null)
              throw new Error("Project role did not publish");
            members.set(role, {
              agentId: agent.id,
              revision: published.currentRevision,
            });
          }
          const definition = efficientBuildDefinition(
            {
              lead: members.get("lead")!,
              reader: members.get("reader")!,
              builder: members.get("builder")!,
              reviewer: members.get("reviewer")!,
            },
            args.configuration,
            source.kind,
          );
          const draft = teams.createTeam({ scope, definition });
          const team = teams.publish({
            scope,
            teamId: draft.id,
            expectedDraftVersion: draft.draft.version,
          });
          db.prepare(
            "INSERT INTO arc_template_defaults (template_id, template_version, project_id, configuration_json) VALUES (?, ?, ?, ?) ON CONFLICT(template_id, template_version, project_id) DO UPDATE SET configuration_json = excluded.configuration_json",
          ).run(
            args.templateId,
            args.version,
            args.projectId,
            JSON.stringify(args.configuration),
          );
          db.prepare(
            "INSERT INTO arc_template_global_defaults (template_id, template_version, roles_json) VALUES (?, ?, ?) ON CONFLICT(template_id, template_version) DO UPDATE SET roles_json = excluded.roles_json",
          ).run(
            args.templateId,
            args.version,
            JSON.stringify(args.configuration.roles),
          );
          db.prepare(
            "INSERT INTO arc_template_installations (operation_id, request_hash, template_id, template_version, project_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            args.operationId,
            requestHash,
            args.templateId,
            args.version,
            args.projectId,
            team.id,
            Date.now(),
          );
          return {
            team,
            copiedAgentIds: [...members.values()].map(
              (member) => member.agentId,
            ),
            reused: false,
          };
        })();
        if (!created.reused) deps.changed(created.team, created.copiedAgentIds);
        return { team: created.team, reused: created.reused };
      },
    };
  }
  return {
    ensureBundledAgents,
    handlers,
    async call(
      method: string,
      input: unknown,
      actor: AgentActor = { kind: "user" },
    ) {
      const api = handlers(actor);
      switch (method) {
        case "listTeamTemplates":
          return api.listTeamTemplates(
            contract.listTeamTemplates.input.parse(input),
          );
        case "getTeamTemplateSetup":
          return api.getTeamTemplateSetup(
            contract.getTeamTemplateSetup.input.parse(input),
          );
        case "instantiateTeamTemplate":
          return api.instantiateTeamTemplate(
            contract.instantiateTeamTemplate.input.parse(input),
          );
        default:
          throw new TeamStoreError(
            "unknown_method",
            `Unknown template method: ${method}`,
          );
      }
    },
  };
}
export type ArcTemplateService = ReturnType<typeof createArcTemplateService>;

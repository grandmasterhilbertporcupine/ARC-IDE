import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignedSkillMigrations } from "../assigned-skills.js";
import { createAgentStore, migrations, type AgentStore } from "../data.js";
import {
  createTeamStore,
  teamMigrations,
  type TeamStore,
} from "../teams/data.js";
import type { TeamDefinition } from "../teams/contract.js";
import { graphRunDefinitionFixture } from "../runtime/graph-testing.js";
import { directoryDefinitionFixture } from "../runtime/directory-testing.js";
import { compileArcGraphRun } from "../runtime/graph-compiler.js";
import { compileArcDirectoryRun } from "../runtime/directory-compiler.js";
import { efficientBuildDefinition } from "./catalog.js";
import { templateRoles, type TemplateConfiguration } from "./contract.js";
import {
  createArcTemplateService,
  templateMigrations,
  type ArcTemplateService,
} from "./service.js";

const execution = {
  providerId: "codex",
  model: "available-model",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  serviceTier: "default",
} as const;
const configuration: TemplateConfiguration = {
  roles: {
    lead: execution,
    reader: execution,
    builder: execution,
    reviewer: execution,
  },
  check: { executable: "node", args: ["--test"], timeoutMs: 120000 },
};
const request = {
  templateId: "efficient-build",
  version: 1,
  projectId: "project-1",
  operationId: "create-1",
  configuration,
} as const;
let db: Database.Database;
let agents: AgentStore;
let teams: TeamStore;
let service: ArcTemplateService;
let sourceKind: "git" | "directory";
const validateExecution = vi.fn(async () => {});
const changed = vi.fn();
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    [
      ...migrations,
      ...assignedSkillMigrations,
      ...teamMigrations,
      ...templateMigrations,
    ].join(";\n"),
  );
  agents = createAgentStore(db);
  teams = createTeamStore(db, agents);
  sourceKind = "git";
  validateExecution.mockReset().mockResolvedValue();
  changed.mockReset();
  service = createArcTemplateService(db, agents, teams, {
    requireProject: async () => {},
    projectSource: async () => ({ hostId: "host-project", kind: sourceKind }),
    validateExecution,
    changed,
  });
});
afterEach(() => db.close());
const count = () =>
  db
    .prepare<[], { total: number }>(
      "SELECT count(*) AS total FROM agents WHERE scope_kind = 'project'",
    )
    .get()!.total;

describe("bundled Efficient Build template", () => {
  it("lists without providers and bootstraps four immutable library agents exactly once", async () => {
    expect(
      (await service.handlers().listTeamTemplates(null)).templates[0].roles,
    ).toHaveLength(4);
    expect(validateExecution).not.toHaveBeenCalled();
    const first = service.ensureBundledAgents();
    expect(service.ensureBundledAgents()).toEqual(first);
    expect(first.size).toBe(4);
    for (const [role, reference] of first) {
      const revision = agents.getRevision({
        scope: { kind: "library" },
        ...reference,
      });
      expect(revision.metadata.execution.providerId).toBeNull();
      expect(revision.metadata.skills?.[0].name).toBe(`arc-efficient-${role}`);
      expect(
        agents.assignedSkills.resolve(revision.metadata.skills ?? []),
      ).toHaveLength(1);
    }
  });

  it("creates a published editable project copy with checked branches, exact models and saved project defaults", async () => {
    const result = await service.handlers().instantiateTeamTemplate(request);
    expect(result.reused).toBe(false);
    expect(result.team.currentRevision).toBe(1);
    expect(result.team.validation).toMatchObject({
      valid: true,
      execution: { available: true },
    });
    expect(result.team.draft.definition.members).toHaveLength(4);
    for (const member of result.team.draft.definition.members) {
      const detail = agents.getAgent({
        scope: result.team.scope,
        agentId: member.agentId,
      });
      expect(detail.sourceAgentId).not.toBeNull();
      expect(detail.draft.metadata.execution).toEqual(execution);
    }
    expect(
      (
        await service.handlers().getTeamTemplateSetup({
          projectId: "project-1",
          templateId: "efficient-build",
          version: 1,
        })
      ).configuration,
    ).toEqual(configuration);
    expect(validateExecution).toHaveBeenCalledTimes(4);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("reuses a retried or concurrent operation and refuses a changed request under the same identity", async () => {
    const [first, duplicate] = await Promise.all([
      service.handlers().instantiateTeamTemplate(request),
      service.handlers().instantiateTeamTemplate(request),
    ]);
    expect(first.team.id).toBe(duplicate.team.id);
    expect([first.reused, duplicate.reused].sort()).toEqual([false, true]);
    expect(count()).toBe(4);
    await expect(
      service.handlers().instantiateTeamTemplate({
        ...request,
        configuration: {
          ...configuration,
          check: { ...configuration.check, args: ["other"] },
        },
      }),
    ).rejects.toThrow("operation_conflict");
    expect(count()).toBe(4);
  });

  it("inherits global role choices while keeping verification commands and saved overrides project-specific", async () => {
    await service.handlers().instantiateTeamTemplate(request);
    const inherited = await service.handlers().getTeamTemplateSetup({
      templateId: "efficient-build",
      version: 1,
      projectId: "project-2",
    });
    expect(inherited).toMatchObject({
      configuration: null,
      defaultsSource: "global",
      defaultRoles: configuration.roles,
    });
    const updated = {
      ...configuration,
      roles: {
        ...configuration.roles,
        reader: { ...execution, model: "another-model" },
      },
      check: { ...configuration.check, args: ["--test", "second-project"] },
    };
    await service.handlers().instantiateTeamTemplate({
      ...request,
      projectId: "project-2",
      operationId: "create-2",
      configuration: updated,
    });
    const original = await service.handlers().getTeamTemplateSetup({
      templateId: "efficient-build",
      version: 1,
      projectId: "project-1",
    });
    expect(original).toMatchObject({
      defaultsSource: "project",
      configuration,
    });
    expect(
      (
        await service.handlers().getTeamTemplateSetup({
          templateId: "efficient-build",
          version: 1,
          projectId: "project-3",
        })
      ).defaultRoles?.reader.model,
    ).toBe("another-model");
  });

  it("keeps edited copies intact and creates independent agents for an explicit new copy", async () => {
    const first = await service.handlers().instantiateTeamTemplate(request);
    teams.saveDraft({
      teamId: first.team.id,
      scope: first.team.scope,
      expectedDraftVersion: first.team.draft.version,
      definition: {
        ...first.team.draft.definition,
        name: "My customized team",
      },
    });
    const second = await service
      .handlers()
      .instantiateTeamTemplate({ ...request, operationId: "create-2" });
    expect(second.team.id).not.toBe(first.team.id);
    expect(
      teams.getTeam({ teamId: first.team.id, scope: first.team.scope }).name,
    ).toBe("My customized team");
    expect(count()).toBe(8);
    expect(
      second.team.draft.definition.members.every(
        (member) =>
          !first.team.draft.definition.members.some(
            (previous) => previous.agentId === member.agentId,
          ),
      ),
    ).toBe(true);
  });

  it("rejects unavailable models before creating project agents and rolls back all project records on storage failure", async () => {
    validateExecution.mockRejectedValueOnce(
      new Error("Install and authenticate the selected provider"),
    );
    await expect(
      service.handlers().instantiateTeamTemplate(request),
    ).rejects.toThrow("Lead: Install and authenticate");
    expect(count()).toBe(0);
    service.ensureBundledAgents();
    db.exec(
      "CREATE TRIGGER reject_template_team BEFORE INSERT ON teams BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END",
    );
    await expect(
      service.handlers().instantiateTeamTemplate(request),
    ).rejects.toThrow("test storage unavailable");
    expect(count()).toBe(0);
    expect(
      (
        await service.handlers().getTeamTemplateSetup({
          projectId: "project-1",
          templateId: "efficient-build",
          version: 1,
        })
      ).configuration,
    ).toBeNull();
  });

  it("keeps installation user-controlled and refuses cross-project setup reads from agents", async () => {
    const actor = {
      kind: "agent",
      projectId: "project-other",
      threadId: "thread-other",
    } as const;
    await expect(
      service.handlers(actor).instantiateTeamTemplate(request),
    ).rejects.toThrow("proposal_required");
    await expect(
      service.handlers(actor).getTeamTemplateSetup({
        projectId: "project-1",
        templateId: "efficient-build",
        version: 1,
      }),
    ).rejects.toThrow("scope_denied");
    expect(count()).toBe(0);
  });

  it.each(["git", "directory"] as const)(
    "compiles the %s template to the existing runtime with passing and repaired final verification",
    async (kind) => {
      sourceKind = kind;
      const result = await service.handlers().instantiateTeamTemplate(request);
      const update = (team: TeamDefinition) => {
        const id = team.members[0]!.agentId;
        const members = {
          lead: { agentId: id, revision: 1 },
          reader: { agentId: id, revision: 1 },
          builder: { agentId: id, revision: 1 },
          reviewer: { agentId: id, revision: 1 },
        };
        Object.assign(
          team,
          efficientBuildDefinition(members, configuration, kind),
        );
      };
      const compiled =
        kind === "git"
          ? compileArcGraphRun(graphRunDefinitionFixture(update))
          : compileArcDirectoryRun(directoryDefinitionFixture(update));
      expect(compiled.references.finalGates).toHaveLength(2);
      expect(
        compiled.workflow.requiredGates.some(
          (gate) => gate.gateId === "arc:final-candidate",
        ),
      ).toBe(true);
      expect(templateRoles).toHaveLength(
        result.team.draft.definition.members.length,
      );
      if (kind === "directory")
        expect(
          result.team.draft.definition.graph.nodes.some(
            (node) => node.kind === "integration",
          ),
        ).toBe(false);
    },
  );
});

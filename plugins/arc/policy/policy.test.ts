import { afterEach, describe, expect, it } from "vitest";
import {
  createTeamTestStore,
  teamDefinitionFixture,
  teamTarget,
} from "../teams/testing.js";
import { createPolicyStore, policyMigrations } from "./data.js";
import { createPolicyService } from "./service.js";
import {
  defaultRunPolicy,
  defaultSessionOverrides,
  resolveRunPolicy,
} from "./contract.js";

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});
function setup() {
  const fixture = createTeamTestStore({
    kind: "project",
    projectId: "project-a",
  });
  open.push(() => fixture.db.close());
  fixture.db.exec(policyMigrations.join(";\n"));
  const store = createPolicyStore(fixture.db);
  const service = createPolicyService(store, fixture.store, {
    async listThreads() {
      return [{ id: "thread-a", title: "Main conversation" }];
    },
    async requireProject(projectId) {
      if (!["project-a", "project-b"].includes(projectId))
        throw new Error("Project not found");
    },
    async threadProject(threadId) {
      return threadId === "thread-a" ? "project-a" : "project-b";
    },
    changed() {},
  });
  return { ...fixture, teams: fixture.store, store, service };
}

describe("versioned orchestration policy", () => {
  it("distinguishes inherited preference from explicit no preference without mutating project defaults", () => {
    const { store } = setup();
    const pin = {
      teamId: "team_00000000-0000-0000-0000-000000000001",
      revision: 2,
    };
    const project = store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: { ...defaultRunPolicy(), preferredTeams: [pin] },
    });
    expect(
      store.view({ projectId: "project-a", threadId: "thread-a" }).effective
        ?.preferredTeams,
    ).toEqual([pin]);
    const value = store.saveSession({
      projectId: "project-a",
      threadId: "thread-a",
      expectedVersion: 0,
      overrides: {
        ...defaultSessionOverrides(),
        preferredTeams: { kind: "none" },
      },
    });
    expect(value.effective?.preferredTeams).toEqual([]);
    expect(store.project("project-a")).toEqual(project);
    expect(
      store.resolve({
        projectId: "project-a",
        threadId: "thread-a",
        expectedProjectPolicyVersion: 1,
        expectedSessionPolicyVersion: 1,
      }),
    ).toEqual(value.effective);
    expect(() =>
      store.resolve({
        projectId: "project-a",
        threadId: "thread-a",
        expectedProjectPolicyVersion: 0,
        expectedSessionPolicyVersion: 1,
      }),
    ).toThrow(/changed/);
  });
  it("keeps immutable settings history and rejects stale writes across a reopened store", () => {
    const { store, db } = setup();
    const first = store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: defaultRunPolicy(),
    });
    const reopened = createPolicyStore(db);
    reopened.saveProject({
      projectId: "project-a",
      expectedVersion: 1,
      policy: {
        ...defaultRunPolicy(),
        autonomy: "guided",
        limits: { ...defaultRunPolicy().limits, maxAgentCalls: 8 },
      },
    });
    expect(() =>
      store.saveProject({
        projectId: "project-a",
        expectedVersion: 1,
        policy: defaultRunPolicy(),
      }),
    ).toThrow(/changed elsewhere/);
    const history = reopened.history({
      projectId: "project-a",
      threadId: null,
      limit: 1,
      offset: 1,
    });
    expect(history.total).toBe(2);
    expect(history.revisions[0].value).toEqual(first.policy);
    expect(reopened.project("project-b").version).toBe(0);
  });
  it("blocks a session made inconsistent by later project restrictions until explicitly corrected", () => {
    const { store } = setup();
    const pin = {
      teamId: "team_00000000-0000-0000-0000-000000000001",
      revision: 1,
    };
    store.saveSession({
      projectId: "project-a",
      threadId: "thread-a",
      expectedVersion: 0,
      overrides: {
        ...defaultSessionOverrides(),
        preferredTeams: { kind: "teams", teams: [pin] },
      },
    });
    store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: { ...defaultRunPolicy(), restrictedTeams: [] },
    });
    const target = { projectId: "project-a", threadId: "thread-a" };
    expect(store.view(target).effective).toBeNull();
    expect(() =>
      store.resolve({
        ...target,
        expectedProjectPolicyVersion: 1,
        expectedSessionPolicyVersion: 1,
      }),
    ).toThrow(/restriction/);
    const fixed = store.saveSession({
      ...target,
      expectedVersion: 1,
      overrides: {
        ...defaultSessionOverrides(),
        preferredTeams: { kind: "none" },
      },
    });
    expect(fixed.effective?.restrictedTeams).toEqual([]);
    expect(fixed.effective?.preferredTeams).toEqual([]);
  });
  it("prevents agent authority changes and cross-project session access through service calls", async () => {
    const { service } = setup();
    const actor = {
      kind: "agent",
      projectId: "project-a",
      threadId: "thread-a",
    } as const;
    await expect(
      service.call(
        "saveProjectPolicy",
        {
          projectId: "project-a",
          expectedVersion: 0,
          policy: defaultRunPolicy(),
        },
        actor,
      ),
    ).rejects.toThrow(/Only the user/);
    await expect(
      service.call(
        "saveSessionPolicy",
        {
          projectId: "project-a",
          threadId: "thread-a",
          expectedVersion: 0,
          overrides: defaultSessionOverrides(),
        },
        actor,
      ),
    ).rejects.toThrow(/Only the user/);
    await expect(
      service.handlers().getOrchestrationPolicy({
        projectId: "project-a",
        threadId: "thread-b",
      }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      service.handlers(actor).listPolicyRevisions({
        projectId: "project-b",
        threadId: null,
        limit: 10,
        offset: 0,
      }),
    ).rejects.toThrow(/current project/);
  });
  it("validates exact project team versions and applies restrictions regardless of autonomy", async () => {
    const { service, teams, agent } = setup();
    let team = teams.createTeam({
      scope: { kind: "project", projectId: "project-a" },
      definition: { ...teamDefinitionFixture(agent.id), name: "Allowed team" },
    });
    team = teams.saveDraft({
      ...teamTarget(team),
      definition: teamDefinitionFixture(agent.id),
    });
    team = teams.publish(teamTarget(team));
    const pin = { teamId: team.id, revision: 1 };
    const policy = {
      ...defaultRunPolicy(),
      autonomy: "autonomous" as const,
      preferredTeams: [pin],
      restrictedTeams: [pin],
    };
    await expect(
      service.handlers().saveProjectPolicy({
        projectId: "project-a",
        expectedVersion: 0,
        policy,
      }),
    ).resolves.toMatchObject({ version: 1 });
    expect(() =>
      service.requireAllowed(policy, { ...pin, revision: 2 }),
    ).toThrow(/exact team version/);
    await expect(
      service.handlers().saveProjectPolicy({
        projectId: "project-b",
        expectedVersion: 0,
        policy,
      }),
    ).rejects.toThrow();
    await expect(
      service.handlers().saveProjectPolicy({
        projectId: "project-a",
        expectedVersion: 1,
        policy: {
          ...policy,
          preferredTeams: [{ ...pin, revision: 2 }],
          restrictedTeams: null,
        },
      }),
    ).rejects.toThrow();
  });
  it("resolves explicit authority and limit overrides while leaving omitted settings inherited", () => {
    const project = { ...defaultRunPolicy(), autonomy: "guided" as const };
    const overrides = {
      ...defaultSessionOverrides(),
      limits: { ...project.limits, maxAgentCalls: 12 },
    };
    const result = resolveRunPolicy(project, overrides);
    expect(result.autonomy).toBe("guided");
    expect(result.limits.maxAgentCalls).toBe(12);
    expect(project.limits.maxAgentCalls).toBe(100);
    expect(() =>
      resolveRunPolicy(project, {
        ...overrides,
        limits: { ...result.limits, maxAgentCalls: 0 },
      }),
    ).toThrow();
  });
});

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { createAgentStore, migrations } from "../data.js";
import type { AgentScope } from "../contract.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import { defaultRunPolicy } from "../policy/contract.js";
import { createArcRunStore, runtimeMigrations } from "../runtime/data.js";
import { createArcRunService } from "../runtime/service.js";
import { graphServicesFixture } from "../runtime/testing.js";
import { teamDefinitionFixture, teamTarget } from "../teams/testing.js";
import { createOrchestratorContext } from "./context.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function setup(sourceKind: "git" | "directory" = "git") {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const agents = createAgentStore(db);
  const source = { hostId: "host-a", path: "C:/Project 東京" };
  const target = { projectId: "project-a", threadId: "thread-main" };
  const actor = { kind: "agent", ...target } as const;
  const scope = { kind: "project", projectId: target.projectId } as const;
  const thread = {
    id: target.threadId,
    projectId: target.projectId,
    providerId: "codex",
    environmentId: "environment-main",
    parentThreadId: null,
    experimental_executionContextId: null,
    archivedAt: null,
  };
  let sourceAvailable = true;
  const calls: string[] = [];
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: target.projectId,
          kind: "standard",
          sources: [source],
        }),
      },
      threads: { get: () => thread, list: () => [] },
      environments: {
        get: () => ({
          id: "environment-main",
          projectId: target.projectId,
          hostId: source.hostId,
          path: `${source.path}/main-worktree`,
          status: "ready",
        }),
      },
    },
    async experimental_callHostRpc(call) {
      calls.push(call.method);
      if (!sourceAvailable) throw new Error("Host is offline");
      if (call.method === "inspectProjectSource")
        return { kind: sourceKind, path: source.path };
      if (call.method !== "inspectWorkspace")
        throw new Error("Discovery must not execute work");
      return {
        path: source.path,
        topLevel: source.path,
        gitDir: `${source.path}/.git`,
        commonGitDir: `${source.path}/.git`,
        head: "a".repeat(40),
        currentBranch: "main",
        clean: true,
        trackedDigest: "b".repeat(64),
        untrackedDigest: "b".repeat(64),
        contentDigest: "b".repeat(64),
        stateDigest: "b".repeat(64),
      };
    },
    async experimental_internalRpc() {
      throw new Error("Discovery must not admit workflow work");
    },
  });
  hosts.push(host);
  const graph = graphServicesFixture(db, agents, host.bb);
  const runs = createArcRunService(
    host.bb,
    createArcRunStore(db),
    agents,
    graph,
  );
  const context = createOrchestratorContext(
    host.bb,
    agents,
    graph.teams,
    graph.policy,
    runs,
  );
  function publishedAgent(agentScope: AgentScope = scope) {
    const metadata = {
      ...defaultAgentMetadata("Backend builder"),
      role: "Backend",
    };
    const agent = agents.createAgent({
      scope: agentScope,
      document: serializeAgentDocument(metadata, "Build the assigned backend."),
    });
    return agents.publish({
      scope: agentScope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
    });
  }
  const agent = publishedAgent();
  function publishTeam(name: string, teamScope: AgentScope = scope) {
    const member = teamScope === scope ? agent : publishedAgent(teamScope);
    const team = graph.teams.createTeam({
      scope: teamScope,
      definition: { ...teamDefinitionFixture(member.id), name },
    });
    return graph.teams.publish(teamTarget(team));
  }
  return {
    db,
    host,
    agents,
    agent,
    graph,
    context,
    calls,
    target,
    actor,
    scope,
    thread,
    publishTeam,
    offline() {
      sourceAvailable = false;
    },
    savePolicy(policy: ReturnType<typeof defaultRunPolicy>) {
      return graph.policies.saveProject({
        projectId: target.projectId,
        expectedVersion: graph.policies.project(target.projectId).version,
        policy,
      });
    },
  };
}

describe("main orchestrator context from actual published project records", () => {
  it("discovers a plain project folder without inventing a commit or starting its full inventory", async () => {
    const state = setup("directory");
    const result = await state.context(state.target, state.actor);
    expect(result.source).toEqual({
      state: "directory",
      hostId: "host-a",
      path: "C:/Project 東京",
    });
    expect(state.calls).toEqual(["inspectProjectSource"]);
    expect(
      state.db.prepare("SELECT COUNT(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 0 });
  });
  it("uses the main conversation's enrolled host instead of a different default source", async () => {
    const state = setup();
    state.host.harness.sdk.stub("projects.get", () => ({
      id: state.target.projectId,
      kind: "standard",
      sources: [
        { hostId: "other-default", path: "D:/Wrong default", isDefault: true },
        { hostId: "host-a", path: "C:/Project 東京", isDefault: false },
      ],
    }));
    expect(
      (await state.context(state.target, state.actor)).source,
    ).toMatchObject({
      state: "ready",
      hostId: "host-a",
      path: "C:/Project 東京",
    });
  });
  it("orders exact preferred versions first and reads their published names and member roles", async () => {
    const state = setup();
    let preferred = state.publishTeam("Original preferred name");
    preferred = state.graph.teams.saveDraft({
      ...teamTarget(preferred),
      definition: {
        ...preferred.draft.definition,
        name: "Renamed latest team",
      },
    });
    preferred = state.graph.teams.publish(teamTarget(preferred));
    state.publishTeam("Unpreferred team");
    state.savePolicy({
      ...defaultRunPolicy(),
      preferredTeams: [{ teamId: preferred.id, revision: 1 }],
    });
    const result = await state.context(state.target, state.actor);
    expect(result.teams.total).toBe(2);
    expect(result.teams.versions[0]).toMatchObject({
      teamId: preferred.id,
      revision: 1,
      latestRevision: 2,
      name: "Original preferred name",
      preferred: true,
      roles: ["Backend"],
      execution: { available: true },
    });
    expect(result.teams.versions[1].preferred).toBe(false);
    expect(result.source).toMatchObject({
      state: "ready",
      clean: true,
      head: "a".repeat(40),
    });
    expect(result.runs).toEqual({ runs: [], total: 0 });
    expect(state.calls).toEqual(["inspectProjectSource", "inspectWorkspace"]);
  });

  it("pages only published unarchived project versions and searches the published literal name", async () => {
    const state = setup();
    const literal = state.publishTeam("100% accepted_team");
    state.publishTeam("Ordinary team");
    state.publishTeam("Other project", {
      kind: "project",
      projectId: "other-project",
    });
    state.publishTeam("Library", { kind: "library" });
    const archived = state.publishTeam("Archived");
    state.graph.teams.setArchived({ ...teamTarget(archived), archived: true });
    state.graph.teams.createTeam({
      scope: state.scope,
      definition: teamDefinitionFixture(state.agent.id),
    });
    const first = await state.context(
      { ...state.target, limit: 1, offset: 0 },
      state.actor,
    );
    const second = await state.context(
      { ...state.target, limit: 1, offset: 1 },
      state.actor,
    );
    expect(first.teams.total).toBe(2);
    expect(second.teams.total).toBe(2);
    expect(first.teams.versions[0].teamId).not.toBe(
      second.teams.versions[0].teamId,
    );
    const search = await state.context(
      { ...state.target, search: "% accepted_" },
      state.actor,
    );
    expect(search.teams.versions.map((item) => item.teamId)).toEqual([
      literal.id,
    ]);
  });

  it("honors empty restrictions and exact allowed revisions even when a newer revision exists", async () => {
    const state = setup();
    let team = state.publishTeam("Allowed v1");
    team = state.graph.teams.saveDraft({
      ...teamTarget(team),
      definition: { ...team.draft.definition, name: "Latest v2" },
    });
    team = state.graph.teams.publish(teamTarget(team));
    state.publishTeam("Another available team");
    state.savePolicy({ ...defaultRunPolicy(), restrictedTeams: [] });
    expect((await state.context(state.target, state.actor)).teams).toEqual({
      versions: [],
      total: 0,
    });
    state.savePolicy({
      ...defaultRunPolicy(),
      restrictedTeams: [{ teamId: team.id, revision: 1 }],
    });
    const result = await state.context(state.target, state.actor);
    expect(result.teams.total).toBe(1);
    expect(result.teams.versions[0]).toMatchObject({
      teamId: team.id,
      revision: 1,
      latestRevision: 2,
      preferred: false,
    });
  });

  it("reports archived members and unavailable sources without admitting work", async () => {
    const state = setup();
    state.publishTeam("Backend team");
    state.agents.setArchived({
      scope: state.scope,
      agentId: state.agent.id,
      expectedDraftVersion: state.agent.draft.version,
      archived: true,
    });
    state.offline();
    const result = await state.context(state.target, state.actor);
    expect(result.teams.versions[0].execution.available).toBe(false);
    expect(result.teams.versions[0].execution.blockers.join(" ")).toContain(
      "Restore Backend builder",
    );
    expect(result.source).toEqual({
      state: "unavailable",
      reason: "Host is offline",
    });
    expect(result.runs.total).toBe(0);
  });

  it("returns a blocked policy instead of silently dropping an unavailable preferred pin", async () => {
    const state = setup();
    const team = state.publishTeam("Preferred");
    state.savePolicy({
      ...defaultRunPolicy(),
      preferredTeams: [{ teamId: team.id, revision: 1 }],
    });
    state.graph.teams.setArchived({ ...teamTarget(team), archived: true });
    const result = await state.context(state.target, state.actor);
    expect(result.policy.effective).toBeNull();
    expect(result.policy.errors.join(" ")).toContain("Restore");
    expect(result.teams).toEqual({ versions: [], total: 0 });
  });

  it.each([
    {
      parentThreadId: "parent",
      experimental_executionContextId: null,
      archivedAt: null,
    },
    {
      parentThreadId: null,
      experimental_executionContextId: "team-execution_assistant",
      archivedAt: null,
    },
    {
      parentThreadId: null,
      experimental_executionContextId: null,
      archivedAt: 1,
    },
  ])(
    "rejects a non-main or archived conversation before source access: %j",
    async (binding) => {
      const state = setup();
      state.host.harness.sdk.stub("threads.get", () => ({
        ...state.thread,
        ...binding,
      }));
      await expect(
        state.context(state.target, state.actor),
      ).rejects.toMatchObject({ code: "scope_denied" });
      expect(state.calls).toEqual([]);
    },
  );

  it("binds agent context to its actual thread and rejects malformed paging", async () => {
    const state = setup();
    await expect(
      state.context({ ...state.target, threadId: "another-main" }, state.actor),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      state.context(
        { ...state.target, projectId: "another-project" },
        state.actor,
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      state.context({ ...state.target, limit: 1000 }, state.actor),
    ).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
});

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  ownedRunStartSchema,
  type OwnedRunView,
} from "bb-plugin-workflows/owned-contract";
import { createAgentStore, migrations } from "../data.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { HostWorkspaceState } from "../host-contract.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { createArcRunService } from "./service.js";
import { runDefinitionFixture, graphServicesFixture } from "./testing.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function setup(source: "parent" | "project" | "missing") {
  const definition = runDefinitionFixture();
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const agents = createAgentStore(db);
  const metadata = defaultAgentMetadata("Inherited builder");
  if (source === "project") metadata.execution.permissionMode = "full";
  let agent = agents.createAgent({
    scope: { kind: "project", projectId: definition.request.projectId },
    document: serializeAgentDocument(metadata, "Implement the assigned task."),
  });
  agent = agents.publish({
    agentId: agent.id,
    scope: agent.scope,
    expectedDraftVersion: agent.draft.version,
  });
  const selection = { agentId: agent.id, revision: 1 };
  const request = {
    ...definition.request,
    writers: definition.request.writers.map((writer) => ({
      ...writer,
      agent: selection,
    })),
    reviewer: selection,
    repairer: selection,
  };
  const parentExecution = {
    model: "parent-model",
    reasoningLevel: "high",
    permissionMode: "accept-edits",
    serviceTier: "default",
  } as const;
  const projectExecution = {
    ...parentExecution,
    providerId: "codex",
    model: "project-model",
  };
  const workspace: HostWorkspaceState = {
    path: request.path,
    topLevel: request.path,
    gitDir: `${request.path}/.git`,
    commonGitDir: definition.source.commonGitDir,
    head: request.expectedHead,
    currentBranch: "main",
    clean: true,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
    stateDigest: definition.source.stateHash,
  };
  let run: OwnedRunView | null = null;
  let submissions = 0;
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: request.projectId,
          kind: "standard",
          sources: [{ hostId: request.hostId, path: request.path }],
        }),
        defaultExecutionOptions: () =>
          source === "project" ? projectExecution : null,
      },
      threads: {
        get: () => ({
          id: request.originThreadId,
          projectId: request.projectId,
          providerId: "claude-code",
          originPluginId: "sdk-owner",
        }),
        defaultExecutionOptions: () =>
          source === "missing" ? null : parentExecution,
      },
    },
    experimental_callHostRpc(call) {
      if (call.method !== "inspectWorkspace")
        throw new Error("Unexpected native effect during run configuration");
      return workspace;
    },
    experimental_internalRpc: async ({ pluginId, method, input }) => {
      if (pluginId !== "workflows") throw new Error("Unexpected plugin");
      if (method === "startOwnedRun") {
        const started = ownedRunStartSchema.parse(input);
        submissions += 1;
        run = {
          workflowRunId: "workflow-test",
          ownerRunId: started.ownerRunId,
          projectId: started.projectId,
          originThreadId: started.originThreadId,
          planHash: started.planHash,
          state: "running",
          desiredControl: "run",
          controlVersion: 0,
          dispatchGeneration: 1,
          limits: started.limits,
          agentCalls: 0,
          activeAgents: 0,
          chargedActiveMs: 0,
          repairRounds: [],
          result: { available: false },
          error: null,
        };
      } else if (method !== "inspectOwnedRun") {
        throw new Error("Unexpected runtime operation");
      }
      if (run === null) throw new Error("Run was not submitted");
      return { run };
    },
  });
  hosts.push(host);
  const store = createArcRunStore(db);
  const service = createArcRunService(
    host.bb,
    store,
    agents,
    graphServicesFixture(db, agents, host.bb),
  );
  return {
    host,
    store,
    request,
    parentExecution,
    projectExecution,
    handlers: service.handlers(),
    submissions: () => submissions,
  };
}

describe("ARC run execution inheritance", () => {
  it("pins an SDK-created parent's tuple without project defaults and observes identical retries", async () => {
    const state = setup("parent");
    const first = await state.handlers.startRun(state.request);
    if (first.definition.schemaVersion !== 1)
      throw new Error("Expected a legacy run");
    const expected = {
      ...state.parentExecution,
      providerId: "claude-code",
    };
    expect(first.definition.writers.map((agent) => agent.execution)).toEqual([
      expected,
      expected,
    ]);
    expect(first.definition.reviewer.execution).toEqual(expected);
    expect(first.definition.repairer.execution).toEqual(expected);
    state.host.harness.sdk.stub("projects.defaultExecutionOptions", () => {
      throw new Error("A retained run must not resolve new defaults");
    });
    state.host.harness.sdk.stub("threads.defaultExecutionOptions", () => {
      throw new Error("A retained run must not resolve the parent again");
    });
    const repeated = await state.handlers.startRun(state.request);
    expect(repeated.definition).toEqual(first.definition);
    expect(repeated.summary.runId).toBe(first.summary.runId);
    expect(state.submissions()).toBe(1);
    expect(
      state.host.harness.sdk.callsTo("threads.defaultExecutionOptions"),
    ).toEqual([[{ threadId: state.request.originThreadId }]]);
  });

  it("uses saved project defaults before the parent and preserves explicit agent settings", async () => {
    const state = setup("project");
    const result = await state.handlers.startRun(state.request);
    if (result.definition.schemaVersion !== 1)
      throw new Error("Expected a legacy run");
    expect(result.definition.writers[0].execution).toEqual({
      ...state.projectExecution,
      permissionMode: "full",
    });
    expect(
      state.host.harness.sdk.callsTo("threads.defaultExecutionOptions"),
    ).toEqual([]);
  });

  it("rejects unresolved inheritance with an actionable error before reserving or submitting", async () => {
    const state = setup("missing");
    await expect(state.handlers.startRun(state.request)).rejects.toMatchObject({
      code: "execution_configuration_missing",
    });
    expect(state.store.findRequest(state.request)).toBeNull();
    expect(state.submissions()).toBe(0);
  });
});

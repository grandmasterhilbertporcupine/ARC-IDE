import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";
import {
  createOwnedRun,
  findActiveOwnedThreadRuns,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import { createArcRunStore, runtimeMigrations } from "../runtime/data.js";
import { compileArcRun, runtimeNodeKey } from "../runtime/compiler.js";
import { compileArcGraphRun } from "../runtime/graph-compiler.js";
import { compileArcOrchestratedRun } from "../runtime/orchestrated-compiler.js";
import { compileArcDirectoryRun } from "../runtime/directory-compiler.js";
import type { RetainedCompiledRun } from "../runtime/compiled.js";
import { instructionUpdateMigrations } from "../runtime/instruction-update-data.js";
import { graphRunDefinitionFixture } from "../runtime/graph-testing.js";
import { orchestratedDefinitionFixture } from "../runtime/orchestrated-testing.js";
import { directoryDefinitionFixture } from "../runtime/directory-testing.js";
import { runDefinitionFixture } from "../runtime/testing.js";
import { runtimeHash } from "../runtime/hash.js";
import { threadBrowserMigrations } from "./data.js";
import { arcThreadBrowserRpcContract } from "./contract.js";
import { createArcThreadBrowserService } from "./service.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    [
      ...runtimeMigrations,
      ...instructionUpdateMigrations,
      ...threadBrowserMigrations,
      ...workflowMigrations,
    ].join(";\n"),
  );
  const store = createArcRunStore(db);
  let offline = false;
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: { get: ({ projectId }) => ({ id: projectId }) },
      threads: {
        get: () => {
          throw new Error("The batch must not load individual threads");
        },
      },
    },
    experimental_internalRpc: async ({ method, input }) => {
      if (offline) throw new Error("Workflow service unavailable");
      if (method === "findActiveOwnedThreadRuns")
        return {
          runs: findActiveOwnedThreadRuns(
            db,
            "arc",
            ownedWorkflowRpcContract.findActiveOwnedThreadRuns.input.parse(
              input,
            ),
          ),
        };
      if (method === "inspectOwnedRun") {
        if (
          !input ||
          typeof input !== "object" ||
          !("workflowRunId" in input) ||
          typeof input.workflowRunId !== "string"
        )
          throw new Error("Invalid workflow read");
        return { run: viewOwnedRun(db, input.workflowRunId) };
      }
      throw new Error("Browser reads must not mutate workflows");
    },
    experimental_callHostRpc: () => {
      throw new Error("Browser reads must not run native work");
    },
  });
  hosts.push(host);
  const service = createArcThreadBrowserService(host.bb, store);
  const add = (compiled: RetainedCompiledRun, state = "running") => {
    store.reserve(compiled);
    const run = createOwnedRun(
      db,
      "arc",
      compiled.workflow,
      compiled.definition.createdAt,
    );
    store.submitted(compiled.definition.runId, run.workflowRunId);
    db.prepare("UPDATE workflow_owned_runs SET state = ? WHERE id = ?").run(
      state,
      run.workflowRunId,
    );
    return run;
  };
  const read = (threadIds = ["thread-parent"], runLimit = 1, runOffset = 0) =>
    service.handlers().listThreadBindings({
      projectId: "project-a",
      threadIds,
      runLimit,
      runOffset,
    });
  return {
    db,
    store,
    host,
    service,
    add,
    read,
    offline: () => {
      offline = true;
    },
  };
}

describe("ARC thread bindings", () => {
  it("retains the exact predecessor and successor linkage independently of history pagination", async () => {
    const f = fixture();
    const old = compileArcRun(runDefinitionFixture());
    const nextDefinition = runDefinitionFixture();
    nextDefinition.createdAt = 11;
    const next = compileArcRun(nextDefinition);
    f.add(old, "cancelled");
    f.add(next);
    f.db
      .prepare(
        "INSERT INTO arc_instruction_update_previews(preview_id,run_id,preview_json,compiled_json) VALUES (?,?,?,?)",
      )
      .run("preview", old.definition.runId, "{}", JSON.stringify(next));
    f.db
      .prepare(
        "INSERT INTO arc_instruction_updates(run_id,operation_id,successor_run_id,preview_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        old.definition.runId,
        "update",
        next.definition.runId,
        "preview",
        "applied",
        12,
        12,
      );
    const result = await f.read(["thread-parent"], 2);
    expect(result.origins[0].runs[0]).toMatchObject({
      runId: next.definition.runId,
      predecessorRunId: old.definition.runId,
      successor: null,
    });
    expect(result.origins[0].runs[1]).toMatchObject({
      runId: old.definition.runId,
      predecessorRunId: null,
      successor: { runId: next.definition.runId, state: "applied" },
    });
    f.db
      .prepare("UPDATE arc_instruction_updates SET state = 'cancelled'")
      .run();
    const cancelled = await f.read(["thread-parent"], 2);
    expect(
      cancelled.origins[0].runs.every(
        (run) => run.predecessorRunId === null && run.successor === null,
      ),
    ).toBe(true);
  });
  it("selects an older active run beyond the page, retains exact totals and pages history", async () => {
    const f = fixture();
    const active = compileArcRun(runDefinitionFixture());
    f.add(active);
    for (let index = 0; index < 24; index += 1) {
      const definition = runDefinitionFixture();
      definition.createdAt = 20 + index;
      f.add(compileArcRun(definition), "succeeded");
    }
    const result = await f.read(["thread-parent", "unrelated"]);
    expect(result.origins[0]).toMatchObject({
      runsTotal: 25,
      activeLookup: "available",
      defaultRun: { runId: active.definition.runId, state: "running" },
      nextOffset: 1,
    });
    expect(result.origins[0].runs[0].runId).not.toBe(active.definition.runId);
    expect(result.origins[1]).toMatchObject({
      runs: [],
      runsTotal: 0,
      defaultRun: null,
      nextOffset: null,
    });
    const last = await f.read(["thread-parent"], 20, 20);
    expect(last.origins[0].runs).toHaveLength(5);
    expect(last.origins[0].nextOffset).toBeNull();
  });

  it.each([2, 3, 4] as const)(
    "projects V%s workers only through admitted effects and immutable member/model pins",
    async (version) => {
      const f = fixture();
      const compiled =
        version === 2
          ? compileArcGraphRun(graphRunDefinitionFixture())
          : version === 3
            ? compileArcOrchestratedRun(orchestratedDefinitionFixture())
            : compileArcDirectoryRun(directoryDefinitionFixture());
      const workflow = f.add(compiled);
      const step = compiled.workflow.steps.find(
        (value) => compiled.nodes[runtimeNodeKey(value)].kind === "agent",
      );
      if (!step) throw new Error("Fixture has no worker");
      const node = compiled.nodes[runtimeNodeKey(step)];
      if (node.kind !== "agent") throw new Error("Fixture is not a worker");
      const effectId = `effect-${randomUUID()}`;
      const request = {
        schemaVersion: 2,
        workflowRunId: workflow.workflowRunId,
        ownerRunId: compiled.definition.runId,
        nodeId: step.nodeId,
        iteration: step.iteration,
        attempt: 1,
        effectId,
        requestHash: runtimeHash("request"),
        dispatchGeneration: 0,
        definitionHash: step.definitionHash,
        dependencyReceipts: [],
        lane: null,
        input: null,
      };
      f.db
        .prepare(
          "INSERT INTO arc_run_effects(effect_id,run_id,node_id,iteration,attempt,request_hash,request_json,generation,thread_id,execution_context_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          effectId,
          compiled.definition.runId,
          step.nodeId,
          step.iteration,
          1,
          request.requestHash,
          JSON.stringify(request),
          0,
          "actual-worker",
          "execution-worker",
          11,
        );
      const result = await f.read([
        "thread-parent",
        "actual-worker",
        "unrelated-child",
      ]);
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0]).toMatchObject({
        threadId: "actual-worker",
        runId: compiled.definition.runId,
        originThreadId: "thread-parent",
        name: node.agent.definition.metadata.name,
        revision: node.agent.definition.revision,
        model: node.agent.execution.model,
        team: { teamId: compiled.definition.team.teamId },
      });
      expect(result.origins[0].defaultRun?.workerThreadsTotal).toBe(1);
      expect(result.origins[2].defaultRun).toBeNull();
      const foreign = await f.service.handlers().listThreadBindings({
        projectId: "different",
        threadIds: ["actual-worker"],
        runLimit: 1,
        runOffset: 0,
      });
      expect(foreign.workers).toEqual([]);
    },
  );

  it("keeps workflow lookup failures explicit and refuses foreign agent scope", async () => {
    const f = fixture();
    const compiled = compileArcRun(runDefinitionFixture());
    f.add(compiled);
    f.offline();
    expect((await f.read()).origins[0]).toMatchObject({
      activeLookup: "unavailable",
      defaultRun: { runId: compiled.definition.runId, state: null },
    });
    await expect(
      f.service
        .handlers({ kind: "agent", projectId: "other", threadId: "agent" })
        .listThreadBindings({
          projectId: "project-a",
          threadIds: ["thread-parent"],
          runLimit: 1,
          runOffset: 0,
        }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(
      arcThreadBrowserRpcContract.listThreadBindings.input.safeParse({
        projectId: "p",
        threadIds: Array.from({ length: 6 }, (_, i) => `t${i}`),
        runLimit: 20,
      }).success,
    ).toBe(false);
  });
});

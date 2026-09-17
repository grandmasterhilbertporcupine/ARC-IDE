import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BbPluginApi,
  ExperimentalThreadPreparation,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  ownedStepObservationSchema,
  type OwnedRunView,
  type OwnedStepRequest,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { terminalReceipt } from "../../workflows/src/owned-test-fixtures.js";
import { createAgentStore, migrations } from "../data.js";
import type { HostWorkspaceState } from "../host-contract.js";
import { createPolicyStore, policyMigrations } from "../policy/data.js";
import { createPolicyService } from "../policy/service.js";
import { createTeamStore, teamMigrations } from "../teams/data.js";
import { compileArcRun, runtimeNodeKey } from "../runtime/compiler.js";
import type { RetainedCompiledRun } from "../runtime/compiled.js";
import { controlMigrations } from "../runtime/control-data.js";
import { createArcRunStore, runtimeMigrations } from "../runtime/data.js";
import { compileArcDirectoryRun } from "../runtime/directory-compiler.js";
import { createDirectoryRuntimeFixture } from "../runtime/directory-runtime-testing.js";
import { directoryDefinitionFixture } from "../runtime/directory-testing.js";
import { compileArcGraphRun } from "../runtime/graph-compiler.js";
import { graphRunDefinitionFixture } from "../runtime/graph-testing.js";
import { runtimeHash } from "../runtime/hash.js";
import { instructionUpdateMigrations } from "../runtime/instruction-update-data.js";
import { compileArcOrchestratedRun } from "../runtime/orchestrated-compiler.js";
import { orchestratedDefinitionFixture } from "../runtime/orchestrated-testing.js";
import type { RuntimeReceipt } from "../runtime/receipt.js";
import { createArcRunService } from "../runtime/service.js";
import {
  runDefinitionFixture,
  graphServicesFixture,
} from "../runtime/testing.js";
import {
  arcWorkspaceRpcContract,
  type ArcWorkspaceCursor,
} from "./contract.js";
import { createArcWorkspaceService } from "./service.js";

type EventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
const directoryFixtures: ReturnType<typeof createDirectoryRuntimeFixture>[] =
  [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const fixture of directoryFixtures.splice(0)) await fixture.close();
  for (const db of databases.splice(0)) db.close();
});

function graphWorkspace(
  db: Database.Database,
  store: ReturnType<typeof createArcRunStore>,
  compiled: RetainedCompiledRun,
  workflowRunId: string,
) {
  db.exec(
    [
      ...teamMigrations,
      ...policyMigrations,
      ...instructionUpdateMigrations,
    ].join(";\n"),
  );
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      threads: {
        get: ({ threadId }) => ({
          id: threadId,
          projectId: compiled.definition.request.projectId,
          title: "Actual graph parent",
          providerId: "codex",
        }),
        events: { list: () => [] },
      },
    },
    experimental_internalRpc: async ({ pluginId, method }) => {
      if (pluginId !== "workflows" || method !== "inspectOwnedRun")
        throw new Error("Workspace reads must not dispatch workflow effects");
      return { run: viewOwnedRun(db, workflowRunId) };
    },
    experimental_callHostRpc() {
      throw new Error("Workspace projection must not start native effects");
    },
  });
  hosts.push(host);
  const agents = createAgentStore(db);
  const teams = createTeamStore(db, agents);
  const policies = createPolicyStore(db);
  const policy = createPolicyService(policies, teams, {
    async requireProject() {
      throw new Error("Workspace projection must not change policy");
    },
    async threadProject(threadId) {
      return (await host.bb.sdk.threads.get({ threadId })).projectId;
    },
    async listThreads() {
      throw new Error("Workspace projection must not enumerate conversations");
    },
    changed() {
      throw new Error("Workspace projection must not change policy");
    },
  });
  const runs = createArcRunService(host.bb, store, agents, {
    teams,
    policies,
    policy,
  });
  const service = createArcWorkspaceService(host.bb, store, runs);
  return () =>
    service.handlers().getWorkspace({
      runId: compiled.definition.runId,
      cursor: null,
      eventLimit: 50,
    });
}

function admittedGraphWorker(version: 2 | 3 | 4) {
  const graphDefinition = graphRunDefinitionFixture();
  graphDefinition.policy.autonomy = "autonomous";
  const compiled =
    version === 2
      ? compileArcGraphRun(graphDefinition)
      : version === 3
        ? compileArcOrchestratedRun(orchestratedDefinitionFixture())
        : compileArcDirectoryRun(directoryDefinitionFixture());
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...controlMigrations,
      ...workflowMigrations,
    ].join(";\n"),
  );
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  if (!claimOwnedRun(db, 4)) throw new Error("Graph run was not claimed");
  store.submitted(compiled.definition.runId, workflow.workflowRunId);
  const read = graphWorkspace(db, store, compiled, workflow.workflowRunId);
  for (const step of compiled.workflow.steps) {
    const attempt = admitOwnedStep(
      db,
      workflow.workflowRunId,
      { nodeId: step.nodeId, iteration: step.iteration },
      null,
      viewOwnedRun(db, workflow.workflowRunId).dispatchGeneration,
    );
    if (!attempt) throw new Error("Graph prerequisite was not admitted");
    const effect = store.reserveEffect(attempt.request);
    if (compiled.nodes[runtimeNodeKey(step)].kind === "agent")
      return { db, store, compiled, effect, read };
    if (step.kind !== "host-effect")
      throw new Error("Unexpected graph prerequisite");
    const observation = terminalReceipt(
      attempt.request,
      "succeeded",
      { fixture: "native graph prerequisite" },
      "host-effect",
    );
    store.recordObservation(effect.effectId, observation);
    if (
      !recordOwnedObservation(
        db,
        effect.effectId,
        attempt.request.dispatchGeneration,
        observation,
      )
    )
      throw new Error("Graph prerequisite receipt was not accepted");
  }
  throw new Error("Graph did not admit a worker");
}

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const store = createArcRunStore(db);
  const definition = runDefinitionFixture();
  definition.writers[0].definition.metadata.role = "Frontend engineer";
  const compiled = compileArcRun(definition);
  store.reserve(compiled);
  const run: OwnedRunView = {
    workflowRunId: "workflow-workspace",
    ownerRunId: definition.runId,
    projectId: definition.request.projectId,
    originThreadId: definition.request.originThreadId,
    planHash: compiled.workflow.planHash,
    state: "running",
    desiredControl: "run",
    controlVersion: 0,
    dispatchGeneration: 1,
    limits: compiled.workflow.limits,
    agentCalls: 0,
    activeAgents: 0,
    chargedActiveMs: 0,
    repairRounds: [],
    result: { available: false },
    error: null,
  };
  store.submitted(definition.runId, run.workflowRunId);
  const preparations = new Map<string, ExperimentalThreadPreparation>();
  const events: EventRow[] = [];
  const unavailable = new Set<string>();
  const preparationReads: string[] = [];
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      threads: {
        get: ({ threadId }) => ({
          id: threadId,
          projectId: definition.request.projectId,
          title: "Actual parent",
          providerId: "claude-code",
        }),
        events: { list: () => events },
      },
    },
    experimental_internalRpc: async ({ pluginId, method }) => {
      if (pluginId !== "workflows" || method !== "inspectOwnedRun")
        throw new Error("Workspace reads must not dispatch workflow effects");
      return { run };
    },
    experimental_preparedThreads: {
      async getPreparation({ operationId }) {
        preparationReads.push(operationId);
        if (unavailable.has(operationId))
          throw new Error("Core temporarily unavailable");
        return preparations.get(operationId) ?? null;
      },
      async prepare() {
        throw new Error("Workspace must not prepare workers");
      },
      async startPrepared() {
        throw new Error("Workspace must not release workers");
      },
    },
    experimental_callHostRpc() {
      throw new Error("Workspace fixture must not run native effects");
    },
  });
  hosts.push(host);
  const agents = createAgentStore(db);
  const runs = createArcRunService(
    host.bb,
    store,
    agents,
    graphServicesFixture(db, agents, host.bb),
  );
  const service = createArcWorkspaceService(host.bb, store, runs);
  const read = (cursor: ArcWorkspaceCursor | null = null, eventLimit = 50) =>
    service
      .handlers()
      .getWorkspace({ runId: definition.runId, cursor, eventLimit });
  const workspace: HostWorkspaceState = {
    path: "C:/Project 東京/worktree",
    topLevel: "C:/Project 東京/worktree",
    gitDir: "C:/Project 東京/.git/worktrees/worker",
    commonGitDir: definition.source.commonGitDir,
    head: definition.source.head,
    currentBranch: null,
    clean: true,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
    stateDigest: "b".repeat(64),
  };
  function admit(nodeId: string, attempt = 1) {
    const step = compiled.workflow.steps.find(
      (step) => step.nodeId === nodeId && step.iteration === 0,
    );
    if (!step) throw new Error("Missing fixture step");
    const dependencyReceipts = step.dependencies
      .map((ref) => {
        const previous = store.effectForNode(definition.runId, ref);
        if (
          previous.observation === null ||
          !("receiptHash" in previous.observation)
        )
          throw new Error("Fixture dependency must be terminal");
        return {
          ...ref,
          effectId: previous.effectId,
          outcome: ref.requiredOutcome,
          receiptHash: previous.observation.receiptHash,
        };
      })
      .map(({ requiredOutcome: _requiredOutcome, ...receipt }) => receipt);
    const request: OwnedStepRequest = {
      workflowRunId: run.workflowRunId,
      ownerRunId: definition.runId,
      nodeId,
      iteration: 0,
      attempt,
      effectId: `effect-${nodeId}-${String(attempt).padStart(3, "0")}`,
      requestHash: "d".repeat(64),
      dispatchGeneration: 1,
      definitionHash: step.definitionHash,
      dependencyReceipts,
      lane:
        step.lane === null
          ? null
          : { key: runtimeHash(step.lane), fence: attempt },
      input: null,
    };
    const {
      requestHash: _hash,
      dispatchGeneration: _generation,
      ...immutable
    } = request;
    request.requestHash = runtimeHash({ owner: "arc", ...immutable });
    const effect = store.reserveEffect(request);
    db.prepare(
      "UPDATE arc_run_effects SET created_at = ? WHERE effect_id = ?",
    ).run(attempt, effect.effectId);
    return store.effect(effect.effectId);
  }
  function writer(index = 0, attempt = 1) {
    const nodeId = `writer-${index}`;
    const workspaceId = `effect-${nodeId}-workspace-001`;
    if (store.findEffect(workspaceId) === null) {
      const effect = admit(`${nodeId}-workspace`);
      const receipt = { fixture: "native workspace dependency" };
      store.recordObservation(effect.effectId, {
        state: "succeeded",
        resource: {
          kind: "host-effect",
          hostId: "host-a",
          effectId: effect.effectId,
        },
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: {
          state: "current",
          identityHash: compiled.workflow.planHash,
        },
      });
    }
    return admit(nodeId, attempt);
  }
  function prepare(effect: ReturnType<typeof writer>, started = false) {
    const threadId = `thread-${effect.effectId}`;
    store.bindThread(effect.effectId, threadId);
    store.sealWorker(effect.effectId, {
      workspace,
      prompt: "Sealed worker prompt",
    });
    const identity = {
      operationId: effect.effectId,
      requestHash: effect.requestHash,
      threadId,
      revision: 1,
      environment: {
        hostId: "host-a",
        environmentId: `env-${effect.effectId}`,
        path: workspace.path,
      },
      reason: null,
    } as const;
    const value: ExperimentalThreadPreparation = started
      ? {
          ...identity,
          state: "started",
          dispatch: {
            acceptedRevision: 1,
            queuedMessageId: `queued-${effect.effectId}`,
            clientTurnRequestId: "creq_2222222222",
          },
        }
      : { ...identity, state: "prepared", dispatch: null };
    preparations.set(effect.effectId, value);
    return value;
  }
  function accept(effect: ReturnType<typeof writer>) {
    const preparation = preparations.get(effect.effectId);
    if (!preparation?.dispatch?.clientTurnRequestId)
      throw new Error("Fixture worker must be released first");
    const event: EventRow = {
      id: `accepted-${effect.effectId}`,
      threadId: preparation.threadId,
      seq: 3,
      createdAt: 3,
      scope: { kind: "turn", turnId: `turn-${effect.effectId}` },
      type: "turn/input/accepted",
      data: {
        providerThreadId: `native-${effect.effectId}`,
        clientRequestId: preparation.dispatch.clientTurnRequestId,
      },
    };
    events.push(event);
    return event;
  }
  function finish(
    effect: ReturnType<typeof writer>,
    status: "completed" | "interrupted",
  ) {
    const preparation = prepare(effect, true);
    const accepted = accept(effect);
    const receipt: RuntimeReceipt = {
      kind: "agent",
      threadId: preparation.threadId,
      executionContextId: effect.executionContextId,
      turnRequestId: "creq_2222222222",
      terminalEventId: `terminal-${effect.effectId}`,
      terminalStatus: status,
      workspace,
      review: null,
      definitionHash: effect.request.definitionHash,
    };
    store.recordObservation(
      effect.effectId,
      ownedStepObservationSchema.parse({
        state: status === "completed" ? "succeeded" : "interrupted",
        resource: {
          kind: "agent",
          threadId: preparation.threadId,
          executionContextId: effect.executionContextId,
          environmentId: preparation.environment?.environmentId ?? null,
          turnRequestId:
            accepted.type === "turn/input/accepted"
              ? accepted.data.clientRequestId
              : null,
        },
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: {
          state: "current",
          identityHash: compiled.workflow.planHash,
        },
      }),
    );
  }
  return {
    db,
    store,
    compiled,
    definition,
    run,
    host,
    service,
    runs,
    read,
    writer,
    prepare,
    accept,
    finish,
    preparations,
    events,
    unavailable,
    preparationReads,
  };
}

describe("ARC live Workspace projection", () => {
  it("retains attempts and sealed agent identity without replaying historical handoffs", async () => {
    const state = setup();
    const first = state.writer();
    state.finish(first, "interrupted");
    const second = state.writer(0, 2);
    state.finish(second, "completed");
    state.definition.writers[0].definition.metadata.name =
      "Changed library name";
    const view = await state.read();
    expect(
      view.workers.map(({ attempt, state }) => ({ attempt, state })),
    ).toEqual([
      { attempt: 2, state: "succeeded" },
      { attempt: 1, state: "interrupted" },
    ]);
    expect(view.workers[0]).toMatchObject({
      graphNodeId: null,
      name: "Builder",
      role: "Frontend engineer",
      purpose: "writer",
      task: "Build the frontend",
      group: null,
      execution: { providerId: "codex", model: "test-model" },
      revision: 1,
    });
    expect(view.origin).toEqual({
      threadId: "thread-parent",
      title: "Actual parent",
      providerId: "claude-code",
      model: null,
    });
    expect(view.events).toEqual([]);
    expect(view.cursor.seenKeys).toHaveLength(6);
    expect(view.workers.every((worker) => worker.dispatchKey !== null)).toBe(
      true,
    );
    expect(state.preparationReads).toEqual([]);
    const reopened = createArcWorkspaceService(
      state.host.bb,
      createArcRunStore(state.db),
      state.runs,
    );
    expect(
      (
        await reopened.handlers().getWorkspace({
          runId: state.definition.runId,
          cursor: view.cursor,
          eventLimit: 1,
        })
      ).events,
    ).toEqual([]);
  });

  it.each([2, 3, 4] as const)(
    "projects V%s workers from the stored graph origin after the source compilation changes",
    async (version) => {
      const state = admittedGraphWorker(version);
      const key = runtimeNodeKey(state.effect.request);
      expect(state.compiled.references.origins[key].graphNodeId).toBe("write");
      state.compiled.references.origins[key].graphNodeId = "review";
      const view = await state.read();
      expect(view.workers).toHaveLength(1);
      expect(view.workers[0]).toMatchObject({
        effectId: state.effect.effectId,
        nodeId: state.effect.request.nodeId,
        graphNodeId: "write",
        iteration: 0,
        attempt: 1,
        state: "admitted",
      });
      expect(view.workers[0].nodeId).not.toBe(view.workers[0].graphNodeId);
      expect(view.run.definition.schemaVersion).toBe(version);
    },
  );

  it("leaves an absent retained graph origin unlinked instead of inferring it from the runtime identifier", async () => {
    const state = admittedGraphWorker(3);
    delete state.compiled.references.origins[
      runtimeNodeKey(state.effect.request)
    ];
    state.db
      .prepare("UPDATE arc_runs SET compiled_json = ? WHERE id = ?")
      .run(JSON.stringify(state.compiled), state.compiled.definition.runId);
    const view = await state.read();
    expect(view.workers[0]).toMatchObject({
      effectId: state.effect.effectId,
      nodeId: state.effect.request.nodeId,
      graphNodeId: null,
    });
  });

  it("links a completed repair attempt to its declared repair stage and retains one main composer", async () => {
    const state = createDirectoryRuntimeFixture({ repair: true });
    directoryFixtures.push(state);
    await state.execute();
    const read = graphWorkspace(
      state.db,
      state.store,
      state.compiled,
      state.workflow.workflowRunId,
    );
    const before = { ...state.calls };
    const view = await read();
    expect(view.workers).toHaveLength(3);
    expect(
      view.workers.find((worker) => worker.graphNodeId === "repair"),
    ).toMatchObject({
      iteration: 1,
      attempt: 1,
      state: "succeeded",
    });
    expect(view.workers.map((worker) => worker.graphNodeId).sort()).toEqual([
      "repair",
      "review",
      "write",
    ]);
    expect(view.origin.threadId).toBe(
      state.compiled.definition.request.originThreadId,
    );
    expect(
      view.workers.some((worker) => worker.threadId === view.origin.threadId),
    ).toBe(false);
    expect(state.calls).toEqual(before);
  });

  it("links the delegation requester and both independently admitted children to one declared stage", async () => {
    const state = createDirectoryRuntimeFixture({
      assignments: ["alice", "bob"],
      update(team) {
        for (const id of ["alice", "bob"]) {
          team.members.push({ ...team.members[0], id });
          team.permissions.push({
            id: `delegate-${id}`,
            action: "delegate",
            fromMemberId: "builder",
            toMemberId: id,
          });
          team.permissions.push({
            id: `review-${id}`,
            action: "review",
            fromMemberId: "builder",
            toMemberId: id,
          });
        }
        team.graph.nodes = team.graph.nodes.filter(
          (node) => node.id !== "write",
        );
        team.graph.nodes.push({
          id: "write",
          label: "Delegate work",
          kind: "delegation",
          requesterMemberId: "builder",
          candidateMemberIds: ["alice", "bob"],
          maxChildCalls: 2,
          task: "Build the requested app",
          access: "write",
          candidate: { kind: "source" },
        });
      },
    });
    directoryFixtures.push(state);
    await state.execute();
    const read = graphWorkspace(
      state.db,
      state.store,
      state.compiled,
      state.workflow.workflowRunId,
    );
    const before = { ...state.calls };
    const view = await read();
    const delegated = view.workers.filter(
      (worker) => worker.graphNodeId === "write",
    );
    expect(view.workers).toHaveLength(4);
    expect(delegated).toHaveLength(3);
    expect(new Set(delegated.map((worker) => worker.nodeId)).size).toBe(3);
    expect(new Set(delegated.map((worker) => worker.threadId)).size).toBe(3);
    expect(
      new Set(
        delegated.map(
          (worker) =>
            state.compiled.references.origins[runtimeNodeKey(worker)].memberId,
        ),
      ),
    ).toEqual(new Set(["builder", "alice", "bob"]));
    expect(view.workers.every((worker) => worker.state === "succeeded")).toBe(
      true,
    );
    expect(state.calls).toEqual(before);
  });

  it("separates released request allocation from native acceptance and rejects unrelated scopes", async () => {
    const state = setup();
    const worker = state.writer();
    const baseline = await state.read();
    const preparation = state.prepare(worker, true);
    state.events.push(
      {
        id: "wrong-thread",
        threadId: "unrelated-thread",
        seq: 1,
        createdAt: 1,
        scope: { kind: "turn", turnId: "wrong-turn" },
        type: "turn/input/accepted",
        data: {
          providerThreadId: "wrong-native",
          clientRequestId: "creq_2222222222",
        },
      },
      {
        id: "wrong-request",
        threadId: preparation.threadId,
        seq: 2,
        createdAt: 2,
        scope: { kind: "turn", turnId: "wrong-request-turn" },
        type: "turn/input/accepted",
        data: {
          providerThreadId: "wrong-native",
          clientRequestId: "creq_3333333333",
        },
      },
    );
    const released = await state.read(baseline.cursor);
    expect(released.workers[0]).toMatchObject({
      state: "dispatch-requested",
      turnRequestId: "creq_2222222222",
      dispatchKey: null,
    });
    expect(released.events.map((event) => event.milestone)).toEqual([
      "prepared",
    ]);
    state.accept(worker);
    const accepted = await state.read(released.cursor);
    expect(accepted.workers[0].state).toBe("native-accepted");
    expect(accepted.events.map((event) => event.milestone)).toEqual([
      "native-accepted",
    ]);
    expect((await state.read(accepted.cursor)).events).toEqual([]);
  });

  it("pages only delivered milestones and includes late updates to older attempts", async () => {
    const state = setup();
    const older = state.writer();
    const baseline = await state.read();
    const newer = state.writer(1, 2);
    state.prepare(older, true);
    state.accept(older);
    state.prepare(newer, true);
    state.accept(newer);
    let cursor = baseline.cursor;
    const keys: string[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await state.read(cursor, 1);
      expect(result.events).toHaveLength(1);
      expect(result.hasMoreEvents).toBe(page < 4);
      keys.push(result.events[0].key);
      cursor = result.cursor;
    }
    expect(new Set(keys).size).toBe(5);
    expect(keys).toContain(`${older.effectId}:native-accepted:creq_2222222222`);
    expect((await state.read(cursor)).events).toEqual([]);
    expect((await state.read(null)).events).toEqual([]);
  });

  it("preserves seen acceptance through temporary preparation read failure", async () => {
    const state = setup();
    const worker = state.writer();
    state.prepare(worker, true);
    state.accept(worker);
    const accepted = await state.read();
    expect(accepted.workers[0].dispatchKey).not.toBeNull();
    state.unavailable.add(worker.effectId);
    const unavailable = await state.read(accepted.cursor);
    expect(unavailable.workers[0]).toMatchObject({
      state: "unavailable",
      turnRequestId: null,
      dispatchKey: null,
    });
    expect(unavailable.cursor.seenKeys).toEqual(accepted.cursor.seenKeys);
    state.unavailable.clear();
    const restored = await state.read(unavailable.cursor);
    expect(restored.workers[0].dispatchKey).toBe(
      accepted.workers[0].dispatchKey,
    );
    expect(restored.events).toEqual([]);
  });

  it("denies other projects and incompatible cursors before inspecting worker or parent state", async () => {
    const state = setup();
    const worker = state.writer();
    state.prepare(worker, true);
    await expect(
      state.service
        .handlers({
          kind: "agent",
          threadId: "foreign-agent",
          projectId: "project-b",
        })
        .getWorkspace({
          runId: state.definition.runId,
          cursor: null,
          eventLimit: 50,
        }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    const wrong = {
      runId: state.definition.runId,
      planHash: "c".repeat(64),
      seenKeys: [],
    };
    await expect(state.read(wrong)).rejects.toMatchObject({
      code: "cursor_mismatch",
    });
    expect(state.preparationReads).toEqual([]);
    expect(state.host.harness.sdk.callsTo("threads.get")).toEqual([]);
    await expect(
      state.service.call(
        "getWorkspace",
        { runId: state.definition.runId },
        { kind: "agent", threadId: "foreign-agent", projectId: "project-b" },
      ),
    ).rejects.toMatchObject({ code: "scope_denied" });
    const allowed = await state.service
      .handlers({
        kind: "agent",
        threadId: "project-agent",
        projectId: "project-a",
      })
      .getWorkspace({
        runId: state.definition.runId,
        cursor: null,
        eventLimit: 50,
      });
    expect(allowed.workers).toHaveLength(1);
  });

  it("bounds worker and effect reads while reporting older retained attempts", async () => {
    const state = setup();
    for (let attempt = 1; attempt <= 101; attempt++) state.writer(0, attempt);
    const foreign = runDefinitionFixture();
    foreign.request.projectId = "project-b";
    state.store.reserve(compileArcRun(foreign));
    const view = await state.read();
    expect(view.workersTotal).toBe(101);
    expect(view.workersTruncated).toBe(true);
    expect(view.workers).toHaveLength(100);
    expect(view.workers[0].attempt).toBe(101);
    expect(view.workers.at(-1)?.attempt).toBe(2);
    expect(view.effectsTotal).toBe(102);
    expect(view.effects).toHaveLength(100);
    expect(view.cursor.seenKeys).toHaveLength(100);
    expect(state.preparationReads).toEqual([]);
  });

  it("reports missing native preparation without fabricating acceptance and rejects malformed CLI input", async () => {
    const state = setup();
    const worker = state.writer();
    state.store.bindThread(worker.effectId, "missing-preparation-thread");
    const view = await state.read();
    expect(view.workers[0]).toMatchObject({
      state: "needs-reconciliation",
      dispatchKey: null,
    });
    expect(view.cursor.seenKeys).toEqual([`${worker.effectId}:admitted`]);
    await expect(
      state.service.call(
        "getWorkspace",
        { runId: state.definition.runId, eventLimit: 0 },
        { kind: "user" },
      ),
    ).rejects.toThrow();
    expect(
      arcWorkspaceRpcContract.getWorkspace.input.safeParse({
        runId: state.definition.runId,
        cursor: {
          ...view.cursor,
          seenKeys: Array.from({ length: 301 }, () => "key"),
        },
      }).success,
    ).toBe(false);
  });

  it("shows confirmed pre-dispatch failure or cancellation before the adapter records terminal observation", async () => {
    const state = setup();
    const worker = state.writer();
    const prepared = state.prepare(worker);
    state.store.recordObservation(worker.effectId, {
      state: "needs-reconciliation",
      reason: "Prior observation was uncertain",
    });
    state.preparations.set(worker.effectId, {
      ...prepared,
      state: "cancelled",
      dispatch: {
        acceptedRevision: 1,
        queuedMessageId: "allocated-queue",
        clientTurnRequestId: null,
      },
      reason: "Cancelled before release",
    });
    const cancelled = await state.read();
    expect(cancelled.workers[0]).toMatchObject({
      state: "interrupted",
      dispatchKey: null,
      turnRequestId: null,
    });
    state.preparations.set(worker.effectId, {
      ...prepared,
      state: "failed",
      dispatch: null,
      reason: "Provisioning failed",
    });
    expect((await state.read()).workers[0]).toMatchObject({
      state: "failed",
      dispatchKey: null,
    });
    expect(state.host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
  });

  it("rejects mismatched prepared identities and parent project bindings", async () => {
    const state = setup();
    const worker = state.writer();
    const prepared = state.prepare(worker);
    state.preparations.set(worker.effectId, {
      ...prepared,
      operationId: "other-operation",
    });
    await expect(state.read()).rejects.toMatchObject({ code: "scope_denied" });
    state.preparations.set(worker.effectId, prepared);
    state.host.harness.sdk.stub("threads.get", ({ threadId }) => ({
      id: threadId,
      projectId: "project-b",
      title: "Private title",
      providerId: "other-provider",
    }));
    await expect(state.read()).rejects.toMatchObject({ code: "scope_denied" });
  });
});

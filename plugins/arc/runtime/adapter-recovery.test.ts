import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  BbPluginApi,
  ExperimentalPreparedThreads,
  ExperimentalPrepareThreadRequest,
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
import { migrations } from "../data.js";
import {
  arcHostContract,
  type HostEffectRecord,
  type HostEffectRequest,
  type HostWorkspaceState,
} from "../host-contract.js";
import { hostEffectRequestHash } from "../host/hash.js";
import { createArcRuntimeAdapter } from "./adapter.js";
import { compileArcRun, runtimeNodeKey } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { runtimeHash } from "./hash.js";
import type { RuntimeReceipt } from "./receipt.js";
import { runDefinitionFixture } from "./testing.js";

type EventRow = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
const clientRequestId = "creq_2222222222";
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function workspace(path = "C:/Project 東京"): HostWorkspaceState {
  return {
    path,
    topLevel: path,
    gitDir: `${path}/.git`,
    commonGitDir: "C:/Project 東京/.git",
    head: "a".repeat(40),
    currentBranch: path.includes("worktree") ? null : "main",
    clean: true,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
    stateDigest: "b".repeat(64),
  };
}

function accepted(
  threadId: string,
  turnId: string,
  requestId = clientRequestId,
): EventRow {
  return {
    id: `accepted-${turnId}`,
    threadId,
    seq: 1,
    createdAt: 1,
    scope: { kind: "turn", turnId },
    type: "turn/input/accepted",
    data: {
      providerThreadId: "native-provider-thread",
      clientRequestId: requestId,
    },
  };
}

function completed(threadId: string, turnId: string): EventRow {
  return {
    id: `completed-${turnId}`,
    threadId,
    seq: 2,
    createdAt: 2,
    scope: { kind: "turn", turnId },
    type: "turn/completed",
    data: { providerThreadId: "native-provider-thread", status: "completed" },
  };
}

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const store = createArcRunStore(db);
  const compiled = compileArcRun(runDefinitionFixture());
  store.reserve(compiled);
  const run: OwnedRunView = {
    workflowRunId: "workflow-recovery",
    ownerRunId: compiled.definition.runId,
    projectId: compiled.definition.request.projectId,
    originThreadId: compiled.definition.request.originThreadId,
    planHash: compiled.workflow.planHash,
    state: "running",
    desiredControl: "run",
    controlVersion: 0,
    dispatchGeneration: 1,
    limits: compiled.workflow.limits,
    agentCalls: 1,
    activeAgents: 1,
    chargedActiveMs: 10,
    repairRounds: [],
    result: { available: false },
    error: null,
  };
  const preparations = new Map<string, ExperimentalThreadPreparation>();
  const events: EventRow[] = [];
  const prepareCalls: ExperimentalPrepareThreadRequest[] = [];
  const startCalls: Parameters<
    ExperimentalPreparedThreads["startPrepared"]
  >[0][] = [];
  const nativeStarts: HostEffectRequest[] = [];
  const currentWorkspaces = new Map<string, HostWorkspaceState>();
  const laneFences = new Map<string, number>();
  const behavior = { prepareReady: false, allowStart: false };
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_internalRpc: async ({ pluginId, method }) => {
      if (pluginId !== "workflows" || method !== "inspectOwnedRun")
        throw new Error("Unexpected internal RPC");
      return { run };
    },
    experimental_preparedThreads: {
      async getPreparation(input) {
        return preparations.get(input.operationId) ?? null;
      },
      async prepare(input) {
        prepareCalls.push(input);
        if (
          input.environment.type !== "host" ||
          input.environment.workspace.type !== "unmanaged" ||
          typeof input.environment.workspace.path !== "string"
        )
          throw new Error("Expected an existing run-owned host workspace");
        const identity = {
          operationId: input.operationId,
          requestHash: runtimeHash(z.json().parse(input)),
          threadId: `thread-${input.operationId}`,
          revision: 1,
          dispatch: null,
          reason: null,
        } as const;
        const preparation: ExperimentalThreadPreparation = behavior.prepareReady
          ? {
              ...identity,
              state: "prepared",
              environment: {
                hostId: input.environment.hostId,
                environmentId: "environment-worker",
                path: input.environment.workspace.path,
              },
            }
          : { ...identity, state: "reserved", environment: null };
        preparations.set(input.operationId, preparation);
        return preparation;
      },
      async startPrepared(input) {
        startCalls.push(input);
        if (!behavior.allowStart)
          throw new Error("Recovery must not release another provider turn");
        const existing = preparations.get(input.operationId);
        if (existing?.state !== "prepared")
          throw new Error("Expected prepared worker");
        const preparation: ExperimentalThreadPreparation = {
          ...existing,
          revision: existing.revision + 1,
          state: "started",
          dispatch: {
            acceptedRevision: input.expectedRevision,
            queuedMessageId: "queued-new-worker",
            clientTurnRequestId: clientRequestId,
          },
        };
        preparations.set(input.operationId, preparation);
        return preparation;
      },
    },
    sdk: {
      threads: {
        events: {
          list: ({ threadId }) =>
            events.filter((event) => event.threadId === threadId),
        },
      },
    },
    experimental_callHostRpc(call) {
      if (call.method === "inspectWorkspace") {
        const input = arcHostContract.inspectWorkspace.input.parse(call.input);
        return input.path === compiled.definition.source.path
          ? workspace()
          : (currentWorkspaces.get(input.path) ?? workspace(input.path));
      }
      if (call.method === "observeEffect") return null;
      if (call.method === "startEffect") {
        const input = arcHostContract.startEffect.input.parse(call.input);
        nativeStarts.push(input);
        return {
          runId: input.runId,
          effectId: input.effectId,
          requestHash: hostEffectRequestHash(input),
          state: "running",
          startedAt: "2026-09-10T06:00:00Z",
          finishedAt: null,
          receipt: null,
          receiptValidity: null,
        } satisfies HostEffectRecord;
      }
      throw new Error("Unexpected host RPC");
    },
  });
  hosts.push(host);
  createArcRuntimeAdapter(host.bb, store);

  function admit(
    nodeId: string,
    dependencies: OwnedStepRequest[] = [],
    attempt = 1,
    iteration = 0,
  ) {
    const ref = { nodeId, iteration };
    const step = compiled.workflow.steps.find(
      (value) => runtimeNodeKey(value) === runtimeNodeKey(ref),
    );
    if (!step) throw new Error("Fixture step missing");
    const laneKey = step.lane === null ? null : runtimeHash(step.lane);
    const fence = laneKey === null ? 0 : (laneFences.get(laneKey) ?? 0) + 1;
    if (laneKey !== null) laneFences.set(laneKey, fence);
    const immutable = {
      workflowRunId: run.workflowRunId,
      ownerRunId: run.ownerRunId,
      ...ref,
      attempt,
      effectId: `effect-${nodeId}-${iteration}-${attempt}`,
      definitionHash: step.definitionHash,
      dependencyReceipts: dependencies.map((dependency) => {
        const observation = store.effect(dependency.effectId).observation;
        if (
          observation === null ||
          !("receiptHash" in observation) ||
          observation.state === "interrupted"
        )
          throw new Error("Dependency receipt missing");
        return {
          nodeId: dependency.nodeId,
          iteration: dependency.iteration,
          effectId: dependency.effectId,
          receiptHash: observation.receiptHash,
          outcome: observation.state,
        };
      }),
      lane: laneKey === null ? null : { key: laneKey, fence },
      input: null,
    };
    const request: OwnedStepRequest = {
      ...immutable,
      requestHash: runtimeHash({ owner: "arc", ...immutable }),
      dispatchGeneration: run.dispatchGeneration,
    };
    store.reserveEffect(request);
    return request;
  }

  function record(
    request: OwnedStepRequest,
    receipt: RuntimeReceipt,
    state: "succeeded" | "failed" | "interrupted" = "succeeded",
  ) {
    if (receipt.kind === "preparation")
      throw new Error("Expected native execution evidence");
    return store.recordObservation(
      request.effectId,
      ownedStepObservationSchema.parse({
        state,
        resource:
          receipt.kind === "native"
            ? {
                kind: "host-effect",
                hostId: "host-a",
                effectId: request.effectId,
              }
            : {
                kind: "agent",
                threadId: receipt.threadId,
                executionContextId: receipt.executionContextId,
                environmentId: "environment-worker",
                turnRequestId: receipt.turnRequestId,
              },
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: { state: "current", identityHash: request.definitionHash },
      }),
    );
  }

  function preparedWorkspace() {
    const request = admit("writer-0-workspace");
    const candidate = workspace("C:/run-worktree/white");
    record(request, {
      kind: "native",
      request: {
        runId: run.ownerRunId,
        effectId: request.effectId,
        lane: null,
        workspace: {
          path: compiled.definition.source.path,
          originalPath: compiled.definition.source.path,
          commonGitDir: compiled.definition.source.commonGitDir,
          expectedHead: candidate.head,
          expectedStateDigest: candidate.stateDigest,
        },
        operation: { type: "prepare-worktree", workspaceId: "writer-0" },
      },
      receipt: {
        outcome: "succeeded",
        reason: null,
        before: workspace(),
        after: candidate,
        source: null,
        processes: [],
        artifact: {
          workspacePath: candidate.path,
          commitSha: candidate.head,
          treeSha: "d".repeat(40),
        },
        finishedAt: "2026-09-10T06:00:00Z",
      },
    });
    return { request, candidate };
  }

  function nativeReceipt(
    request: OwnedStepRequest,
    before: HostWorkspaceState,
    after: HostWorkspaceState,
    operation: HostEffectRequest["operation"],
    outcome: "succeeded" | "failed" = "succeeded",
  ): RuntimeReceipt {
    return {
      kind: "native",
      request: {
        runId: run.ownerRunId,
        effectId: request.effectId,
        lane: request.lane,
        workspace: {
          path: before.path,
          commonGitDir: before.commonGitDir,
          originalPath: compiled.definition.source.path,
          expectedHead: before.head,
          expectedStateDigest: before.stateDigest,
        },
        operation,
      },
      receipt: {
        outcome,
        reason: outcome === "failed" ? "Required check failed" : null,
        before,
        after,
        source: null,
        processes: [],
        artifact: {
          workspacePath: after.path,
          commitSha: after.head,
          treeSha: "d".repeat(40),
        },
        finishedAt: "2026-09-10T06:00:00Z",
      },
    };
  }

  function checkedCandidate(outcome: "succeeded" | "failed") {
    const writers = [0, 1].map((index) => {
      const prepared = admit(`writer-${index}-workspace`);
      const candidate = workspace(`C:/run-worktree/writer-${index}`);
      record(
        prepared,
        nativeReceipt(prepared, workspace(), candidate, {
          type: "prepare-worktree",
          workspaceId: `writer-${index}`,
        }),
      );
      const worker = admit(`writer-${index}`, [prepared]);
      record(worker, agentReceipt(worker, candidate));
      const commit = admit(`writer-${index}-commit`, [worker]);
      const symbol = index === 0 ? "c" : "d";
      const committed = {
        ...candidate,
        head: symbol.repeat(40),
        stateDigest: symbol.repeat(64),
      };
      record(
        commit,
        nativeReceipt(commit, candidate, committed, {
          type: "commit",
          message: `Writer ${index}`,
        }),
      );
      return { commit, candidate: committed };
    });
    let dependency = admit(
      "integration-workspace",
      writers.map((value) => value.commit),
    );
    let candidate = workspace("C:/run-worktree/integration");
    record(
      dependency,
      nativeReceipt(dependency, workspace(), candidate, {
        type: "prepare-worktree",
        workspaceId: "integration",
      }),
    );
    for (const [index, writer] of writers.entries()) {
      const integrate = admit(`integrate-${index}`, [
        dependency,
        writer.commit,
      ]);
      const symbol = index === 0 ? "e" : "f";
      const integrated = {
        ...candidate,
        head: symbol.repeat(40),
        stateDigest: symbol.repeat(64),
      };
      record(
        integrate,
        nativeReceipt(integrate, candidate, integrated, {
          type: "integrate",
          source: {
            path: writer.candidate.path,
            commonGitDir: writer.candidate.commonGitDir,
            originalPath: compiled.definition.source.path,
            expectedHead: writer.candidate.head,
            expectedStateDigest: writer.candidate.stateDigest,
          },
        }),
      );
      candidate = integrated;
      dependency = integrate;
    }
    const request = admit("check", [dependency]);
    const receipt = nativeReceipt(
      request,
      candidate,
      candidate,
      { type: "check", ...compiled.definition.request.check },
      outcome,
    );
    const observation = record(request, receipt, outcome);
    return { request, candidate, receipt, observation };
  }

  function agentReceipt(
    request: OwnedStepRequest,
    candidate: HostWorkspaceState,
    terminalStatus: "completed" | "interrupted" = "completed",
  ): RuntimeReceipt {
    return {
      kind: "agent",
      threadId: `thread-${request.effectId}`,
      executionContextId: store.effect(request.effectId).executionContextId,
      turnRequestId: clientRequestId,
      terminalEventId: `terminal-${request.effectId}`,
      terminalStatus,
      workspace: candidate,
      review: null,
      definitionHash: request.definitionHash,
    };
  }

  function bind(
    request: OwnedStepRequest,
    candidate: HostWorkspaceState,
    state: "needs-reconciliation" | "cancelled",
  ) {
    store.sealWorker(request.effectId, {
      workspace: candidate,
      prompt: "Continue the admitted task",
    });
    const preparation: ExperimentalThreadPreparation = {
      operationId: request.effectId,
      requestHash: "f".repeat(64),
      threadId: `thread-${request.effectId}`,
      revision: 3,
      state,
      environment: {
        hostId: "host-a",
        environmentId: "environment-worker",
        path: candidate.path,
      },
      dispatch:
        state === "cancelled"
          ? null
          : {
              acceptedRevision: 1,
              queuedMessageId: "queued-original",
              clientTurnRequestId: clientRequestId,
            },
      reason:
        state === "cancelled"
          ? "Stopped before release"
          : "Owner reloaded after dispatch",
    };
    preparations.set(request.effectId, preparation);
    return preparation;
  }

  async function call(
    method: "executeStep" | "observeStep",
    request: OwnedStepRequest,
  ) {
    const {
      definitionHash: _definition,
      dependencyReceipts: _dependencies,
      lane: _lane,
      input: _input,
      ...lookup
    } = request;
    return ownedStepObservationSchema.parse(
      await host.harness.experimental_callInternalRpc(
        method,
        method === "executeStep" ? request : lookup,
        { callerPluginId: "workflows", signal: new AbortController().signal },
      ),
    );
  }

  return {
    host,
    store,
    run,
    events,
    preparations,
    prepareCalls,
    startCalls,
    nativeStarts,
    behavior,
    currentWorkspaces,
    admit,
    record,
    preparedWorkspace,
    checkedCandidate,
    agentReceipt,
    bind,
    call,
  };
}

describe("ARC prepared worker and dependency recovery", () => {
  it("recovers the exact accepted native completion after preparation became uncertain without restarting", async () => {
    const test = setup();
    const prepared = test.preparedWorkspace();
    const request = test.admit("writer-0", [prepared.request]);
    const preparation = test.bind(
      request,
      prepared.candidate,
      "needs-reconciliation",
    );
    test.run.state = "needs-reconciliation";
    test.run.desiredControl = "pause";
    test.events.push(
      ...[
        accepted(preparation.threadId, "old-turn", "creq_3333333333"),
        completed(preparation.threadId, "old-turn"),
        accepted(preparation.threadId, "admitted-turn"),
        completed(preparation.threadId, "admitted-turn"),
      ].map((value, index) => ({
        ...value,
        seq: index + 1,
        createdAt: index + 1,
      })),
    );
    const result = await test.call("observeStep", request);
    expect(result).toMatchObject({
      state: "succeeded",
      validity: { state: "current" },
      receipt: {
        kind: "agent",
        turnRequestId: clientRequestId,
        terminalEventId: "completed-admitted-turn",
        terminalStatus: "completed",
      },
    });
    expect(test.store.effect(request.effectId).observation).toEqual(result);
    expect(await test.call("observeStep", request)).toEqual(result);
    expect(test.host.harness.sdk.callsTo("threads.events.list")).toHaveLength(
      1,
    );
    expect(test.prepareCalls).toEqual([]);
    expect(test.startCalls).toEqual([]);
  });

  it.each(["different-client", "different-turn"] as const)(
    "does not complete from a %s event",
    async (mismatch) => {
      const test = setup();
      const prepared = test.preparedWorkspace();
      const request = test.admit("writer-0", [prepared.request]);
      const preparation = test.bind(
        request,
        prepared.candidate,
        "needs-reconciliation",
      );
      test.events.push(
        accepted(
          preparation.threadId,
          "admitted-turn",
          mismatch === "different-client" ? "creq_3333333333" : clientRequestId,
        ),
        completed(
          preparation.threadId,
          mismatch === "different-turn" ? "other-turn" : "admitted-turn",
        ),
      );
      const result = await test.call("observeStep", request);
      expect(result).toEqual({
        state: "needs-reconciliation",
        reason: "Owner reloaded after dispatch",
      });
      expect(
        test.store.effect(request.effectId).observation,
      ).not.toHaveProperty("receipt");
      expect(test.prepareCalls).toEqual([]);
      expect(test.startCalls).toEqual([]);
    },
  );

  it("retains confirmed cancellation before release as interrupted without inventing a native turn", async () => {
    const test = setup();
    const prepared = test.preparedWorkspace();
    const request = test.admit("writer-0", [prepared.request]);
    test.bind(request, prepared.candidate, "cancelled");
    test.run.desiredControl = "pause";
    test.run.state = "pausing";
    const result = await test.call("observeStep", request);
    expect(result).toMatchObject({
      state: "interrupted",
      receipt: {
        kind: "preparation",
        operationId: request.effectId,
        state: "cancelled",
        reason: "Stopped before release",
      },
      resource: { turnRequestId: null },
    });
    const retained = await test.call("observeStep", request);
    if (!("receipt" in result))
      throw new Error("Expected cancellation receipt");
    expect(retained).toMatchObject({
      state: "interrupted",
      receipt: result.receipt,
      receiptHash: result.receiptHash,
      validity: { state: "current" },
    });
    expect(test.host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
    expect(test.prepareCalls).toEqual([]);
    expect(test.startCalls).toEqual([]);
  });

  it("retains cancellation after queue admission but before client request allocation without restarting", async () => {
    const test = setup();
    const prepared = test.preparedWorkspace();
    const request = test.admit("writer-0", [prepared.request]);
    const preparation = test.bind(request, prepared.candidate, "cancelled");
    test.preparations.set(request.effectId, {
      ...preparation,
      state: "cancelled",
      reason: "Stopped queued first message",
      dispatch: {
        acceptedRevision: 1,
        queuedMessageId: "queued-held",
        clientTurnRequestId: null,
      },
    });
    test.run.state = "pausing";
    test.run.desiredControl = "pause";
    expect(await test.call("observeStep", request)).toMatchObject({
      state: "interrupted",
      receipt: {
        kind: "preparation",
        state: "cancelled",
        reason: "Stopped queued first message",
      },
      resource: { turnRequestId: null },
    });
    expect(test.host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
    expect(test.prepareCalls).toEqual([]);
    expect(test.startCalls).toEqual([]);
  });

  it("invalidates a changed failed-check candidate before its bound repair turn is actually accepted", async () => {
    const test = setup();
    const checked = test.checkedCandidate("failed");
    const repair = test.admit("repair", [checked.request], 1, 1);
    const preparation = test.bind(
      repair,
      checked.candidate,
      "needs-reconciliation",
    );
    test.store.bindThread(repair.effectId, preparation.threadId);
    test.events.push(
      accepted(preparation.threadId, "unrelated-repair", "creq_3333333333"),
    );
    test.currentWorkspaces.set(checked.candidate.path, {
      ...checked.candidate,
      clean: false,
      stateDigest: "9".repeat(64),
      contentDigest: "9".repeat(64),
    });
    expect(await test.call("observeStep", checked.request)).toMatchObject({
      state: "failed",
      validity: { state: "stale" },
      receipt: checked.receipt,
    });
    expect(test.startCalls).toEqual([]);
  });

  it("retains consumed failed-check history only after the exact bound repair accepts its request", async () => {
    const test = setup();
    const checked = test.checkedCandidate("failed");
    const repair = test.admit("repair", [checked.request], 1, 1);
    const preparation = test.bind(
      repair,
      checked.candidate,
      "needs-reconciliation",
    );
    test.store.bindThread(repair.effectId, preparation.threadId);
    test.currentWorkspaces.set(checked.candidate.path, {
      ...checked.candidate,
      head: "8".repeat(40),
      stateDigest: "8".repeat(64),
    });
    test.preparations.set(repair.effectId, {
      ...preparation,
      threadId: "wrong-prepared-thread",
    });
    test.events.push(accepted("wrong-prepared-thread", "wrong-thread-request"));
    expect(await test.call("observeStep", checked.request)).toMatchObject({
      state: "failed",
      validity: { state: "stale" },
    });
    test.preparations.set(repair.effectId, preparation);
    test.events.push(accepted(preparation.threadId, "actual-repair-request"));
    const consumed = await test.call("observeStep", checked.request);
    expect(consumed).toMatchObject({
      state: "failed",
      validity: { state: "current" },
      receipt: checked.receipt,
    });
    if (!("receiptHash" in consumed) || !("receiptHash" in checked.observation))
      throw new Error("Expected native check receipts");
    expect(consumed.receiptHash).toBe(checked.observation.receiptHash);
    expect(test.store.effect(repair.effectId).workerBinding?.workspace).toEqual(
      checked.candidate,
    );
    expect(repair.dependencyReceipts).toEqual([
      {
        nodeId: "check",
        iteration: 0,
        effectId: checked.request.effectId,
        receiptHash: checked.observation.receiptHash,
        outcome: "failed",
      },
    ]);
    expect(test.startCalls).toEqual([]);
  });

  it("never treats a changed successful check as reusable historical failure evidence", async () => {
    const test = setup();
    const checked = test.checkedCandidate("succeeded");
    test.currentWorkspaces.set(checked.candidate.path, {
      ...checked.candidate,
      head: "8".repeat(40),
      stateDigest: "8".repeat(64),
    });
    expect(await test.call("observeStep", checked.request)).toMatchObject({
      state: "succeeded",
      validity: { state: "stale" },
      receipt: checked.receipt,
    });
    expect(test.host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
    expect(test.startCalls).toEqual([]);
  });

  it("uses the sealed dependency effect and receipt hash when a later attempt exists", async () => {
    const test = setup();
    const prepared = test.preparedWorkspace();
    const first = test.admit("writer-0", [prepared.request]);
    const firstWorkspace = {
      ...prepared.candidate,
      clean: false,
      stateDigest: "c".repeat(64),
      contentDigest: "c".repeat(64),
    };
    const firstObservation = test.record(
      first,
      test.agentReceipt(first, firstWorkspace),
    );
    const commit = test.admit("writer-0-commit", [first]);
    const later = test.admit("writer-0", [prepared.request], 2);
    test.record(
      later,
      test.agentReceipt(later, {
        ...prepared.candidate,
        clean: false,
        stateDigest: "d".repeat(64),
        contentDigest: "d".repeat(64),
      }),
    );
    expect(await test.call("executeStep", commit)).toMatchObject({
      state: "running",
    });
    expect(test.nativeStarts).toHaveLength(1);
    expect(test.nativeStarts[0].workspace.expectedStateDigest).toBe(
      firstWorkspace.stateDigest,
    );
    expect(
      test.store.effect(commit.effectId).request.dependencyReceipts,
    ).toEqual([
      {
        nodeId: first.nodeId,
        iteration: 0,
        effectId: first.effectId,
        receiptHash:
          "receiptHash" in firstObservation
            ? firstObservation.receiptHash
            : null,
        outcome: "succeeded",
      },
    ]);
    expect(test.store.effect(commit.effectId).nativeRequest).toEqual(
      test.nativeStarts[0],
    );
  });

  it("prepares a resumed worker against its interrupted predecessor's retained partial workspace", async () => {
    const test = setup();
    const prepared = test.preparedWorkspace();
    const first = test.admit("writer-0", [prepared.request]);
    const partial = {
      ...prepared.candidate,
      clean: false,
      stateDigest: "e".repeat(64),
      contentDigest: "e".repeat(64),
    };
    test.record(
      first,
      test.agentReceipt(first, partial, "interrupted"),
      "interrupted",
    );
    const resumed = test.admit("writer-0", [prepared.request], 2);
    test.currentWorkspaces.set(partial.path, partial);
    test.behavior.prepareReady = true;
    test.behavior.allowStart = true;
    expect(await test.call("executeStep", resumed)).toMatchObject({
      state: "running",
    });
    expect(
      test.store.effect(resumed.effectId).workerBinding?.workspace,
    ).toEqual(partial);
    expect(test.prepareCalls).toHaveLength(1);
    expect(test.prepareCalls[0]).toMatchObject({
      parentNotification: "owner-controlled",
      operationId: resumed.effectId,
      turnPolicy: "single",
      environment: {
        type: "host",
        workspace: { type: "unmanaged", path: partial.path },
      },
    });
    expect(test.startCalls).toHaveLength(1);
    expect(
      test.host.harness.experimental_hostRpcCalls
        .filter((call) => call.method === "inspectWorkspace")
        .map((call) =>
          arcHostContract.inspectWorkspace.input.parse(call.input),
        ),
    ).toContainEqual({
      path: partial.path,
      expected: {
        path: partial.path,
        commonGitDir: partial.commonGitDir,
        originalPath: "C:/Project 東京",
        expectedHead: partial.head,
        expectedStateDigest: partial.stateDigest,
      },
    });
  });
});

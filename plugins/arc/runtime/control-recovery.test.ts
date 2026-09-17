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
  ownedStepObservationV2Schema,
  type OwnedStepRequestInput,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  controlOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  reconcileOwnedRunState,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { migrations } from "../data.js";
import {
  arcHostContract,
  type HostWorkspaceState,
  type HostEffectRequest,
} from "../host-contract.js";
import { createArcRuntimeAdapter } from "./adapter.js";
import { runtimeNodeKey } from "./compiler.js";
import { controlMigrations, createRunControlStore } from "./control-data.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { graphRuntimeReceiptSchema } from "./graph-receipt.js";
import { graphReceiptWorkspace } from "./control-driver.js";
import { runtimeHash } from "./hash.js";
import type { RuntimeReceipt } from "./receipt.js";

type Event = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function setup(autonomy: "guided" | "collaborative" = "collaborative") {
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
  const definition = graphRunDefinitionFixture();
  definition.policy.autonomy = autonomy;
  const compiled = compileArcGraphRun(definition);
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  if (!claimOwnedRun(db, 4)) throw new Error("Fixture run was not claimed");
  const source: HostWorkspaceState = {
    path: definition.source.path,
    topLevel: definition.source.path,
    gitDir: definition.source.commonGitDir,
    commonGitDir: definition.source.commonGitDir,
    head: definition.source.head,
    currentBranch: "main",
    clean: true,
    stateDigest: definition.source.stateHash,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
  };
  const workspaces = new Map([[source.path, source]]);
  const preparations = new Map<string, ExperimentalThreadPreparation>();
  const events: Event[] = [];
  let unavailable = false;
  const makeHost = () => {
    const host = createFakePluginHost({
      pluginId: "arc",
      experimental_internalRpc: async ({ pluginId, method }) => {
        if (pluginId !== "workflows" || method !== "inspectOwnedRun")
          throw new Error("Unexpected internal RPC");
        return { run: viewOwnedRun(db, workflow.workflowRunId) };
      },
      experimental_preparedThreads: {
        async prepare() {
          throw new Error("Control recovery must not prepare a provider turn");
        },
        async startPrepared() {
          throw new Error("Control recovery must not dispatch a provider turn");
        },
        async getPreparation({ operationId }) {
          return preparations.get(operationId) ?? null;
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
        if (call.method !== "inspectWorkspace")
          throw new Error("Recovery must not create a native side effect");
        const { path } = arcHostContract.inspectWorkspace.input.parse(
          call.input,
        );
        if (path === source.path && unavailable)
          throw new Error("Host unavailable");
        const value = workspaces.get(path);
        if (!value) throw new Error("Unknown workspace");
        return value;
      },
    });
    hosts.push(host);
    const adapter = createArcRuntimeAdapter(host.bb, createArcRunStore(db));
    return { host, adapter };
  };
  let current = makeHost();
  function admit(ref: OwnedStepRef) {
    const run = viewOwnedRun(db, workflow.workflowRunId);
    const attempt = admitOwnedStep(
      db,
      workflow.workflowRunId,
      { nodeId: ref.nodeId, iteration: ref.iteration },
      null,
      run.dispatchGeneration,
    );
    if (!attempt) throw new Error(`Step not admitted: ${runtimeNodeKey(ref)}`);
    store.reserveEffect(attempt.request);
    return attempt.request;
  }
  function record(request: OwnedStepRequestInput, receipt: RuntimeReceipt) {
    const observation = ownedStepObservationV2Schema.parse({
      state: "succeeded",
      resource: {
        kind: "host-effect",
        hostId: definition.request.hostId,
        effectId: request.effectId,
      },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: compiled.workflow.planHash },
    });
    store.recordObservation(request.effectId, observation);
    recordOwnedObservation(
      db,
      request.effectId,
      request.dispatchGeneration,
      observation,
    );
  }
  function native(ref: OwnedStepRef) {
    const request = admit(ref);
    const node = compiled.nodes[runtimeNodeKey(ref)];
    if (node.kind !== "prepare-worktree" && node.kind !== "fork-worktree")
      throw new Error("Expected workspace prerequisite");
    const dependency = request.dependencyReceipts.at(-1);
    const observed = dependency
      ? store.effect(dependency.effectId).observation
      : null;
    const before =
      observed && "receipt" in observed
        ? graphReceiptWorkspace(
            graphRuntimeReceiptSchema.parse(observed.receipt),
          )
        : source;
    const path = `C:/worktree/${node.workspaceKey}`;
    const after = {
      ...before,
      path,
      topLevel: path,
      gitDir: `${source.commonGitDir}/worktrees/${node.workspaceKey}`,
      currentBranch: null,
    };
    workspaces.set(path, after);
    const nativeRequest: HostEffectRequest = {
      runId: definition.runId,
      effectId: request.effectId,
      lane: request.lane,
      workspace: {
        path: before.path,
        commonGitDir: before.commonGitDir,
        originalPath: source.path,
        expectedHead: before.head,
        expectedStateDigest: before.stateDigest,
      },
      operation: { type: node.kind, workspaceId: node.workspaceKey },
    };
    store.sealNative(request.effectId, nativeRequest);
    record(request, {
      kind: "native",
      request: nativeRequest,
      receipt: {
        outcome: "succeeded",
        reason: null,
        before,
        after,
        source: node.kind === "fork-worktree" ? before : null,
        processes: [],
        artifact: {
          workspacePath: path,
          commitSha: after.head,
          treeSha: "c".repeat(40),
        },
        finishedAt: "2026-09-10T10:30:00Z",
      },
    });
  }
  async function invoke(
    method: "executeStep" | "observeStep" | "interruptStep",
    request: OwnedStepRequestInput,
  ) {
    const run = viewOwnedRun(db, workflow.workflowRunId);
    const lookup = {
      schemaVersion: 2,
      workflowRunId: request.workflowRunId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      iteration: request.iteration,
      attempt: request.attempt,
      effectId: request.effectId,
      requestHash: request.requestHash,
      dispatchGeneration: run.dispatchGeneration,
    };
    const observation = ownedStepObservationV2Schema.parse(
      await current.host.harness.experimental_callInternalRpc(
        method,
        method === "executeStep" ? request : lookup,
        { callerPluginId: "workflows", signal: new AbortController().signal },
      ),
    );
    recordOwnedObservation(
      db,
      request.effectId,
      run.dispatchGeneration,
      observation,
    );
    return observation;
  }
  async function waitingApproval() {
    for (const step of compiled.workflow.steps) {
      const node = compiled.nodes[runtimeNodeKey(step)];
      if (node.kind === "control" && node.operation.type === "approval") {
        const request = admit(step);
        expect(await invoke("executeStep", request)).toMatchObject({
          state: "waiting",
          revision: 1,
          waitReason: "user",
        });
        return {
          request,
          control: store.controls.get(definition.runId, request.effectId),
        };
      }
      native(step);
    }
    throw new Error("Expected an approval");
  }
  return {
    db,
    store,
    compiled,
    source,
    workspaces,
    preparations,
    events,
    admit,
    invoke,
    waitingApproval,
    get adapter() {
      return current.adapter;
    },
    get host() {
      return current.host;
    },
    run: () => viewOwnedRun(db, workflow.workflowRunId),
    restart() {
      current = makeHost();
    },
    makeUnavailable() {
      unavailable = true;
    },
    control(action: "pause" | "cancel" | "resume") {
      const run = viewOwnedRun(db, workflow.workflowRunId);
      return controlOwnedRun(db, "arc", {
        workflowRunId: workflow.workflowRunId,
        action,
        expectedVersion: run.controlVersion,
        operationId: `control-${action}-${run.controlVersion}`,
      });
    },
  };
}

describe("ARC graph control recovery across real ledgers", () => {
  it("retains the exact plan decision across pause/reload, rejects stale responses and retries a confirmed resolution", async () => {
    const state = setup();
    const { request, control } = await state.waitingApproval();
    expect(state.run().agentCalls).toBe(0);
    state.control("pause");
    expect(await state.invoke("interruptStep", request)).toMatchObject({
      state: "waiting",
      revision: 1,
    });
    expect(state.run().state).toBe("paused");
    state.restart();
    const reloaded = createRunControlStore(state.db);
    expect(reloaded.get(control.runId, control.controlId)).toEqual(control);
    const response = {
      runId: control.runId,
      controlId: control.controlId,
      operationId: "approve-plan",
      expectedRevision: 1,
      contextHash: control.contextHash,
      decision: "approved" as const,
    };
    expect(() =>
      reloaded.resolve({ ...response, contextHash: "0".repeat(64) }),
    ).toThrow("control_conflict");
    expect(() =>
      reloaded.reserve({ ...control.context, policyHash: "0".repeat(64) }),
    ).toThrow("control_conflict");
    await state.adapter.validateDecision(control, new AbortController().signal);
    const resolved = reloaded.resolve(response);
    expect(resolved.revision).toBe(2);
    expect(reloaded.resolve(response)).toEqual(resolved);
    expect(() =>
      reloaded.resolve({ ...response, decision: "rejected" }),
    ).toThrow("control_conflict");
    const observed = await state.invoke("observeStep", request);
    expect(observed).toMatchObject({
      state: "succeeded",
      receipt: { revision: 2, selectedOutputs: ["approved"] },
    });
    expect(state.store.listEffectIds(control.runId, 100, 0).total).toBe(1);
    expect(state.run().agentCalls).toBe(0);
  });

  it.each(["changed", "unavailable"] as const)(
    "cancels a waiting approval with %s original source without provider or host effects",
    async (sourceState) => {
      const state = setup();
      const { request, control } = await state.waitingApproval();
      if (sourceState === "unavailable") state.makeUnavailable();
      else
        state.workspaces.set(state.source.path, {
          ...state.source,
          head: "e".repeat(40),
        });
      await expect(
        state.adapter.validateDecision(control, new AbortController().signal),
      ).rejects.toMatchObject({ code: "candidate_changed" });
      state.control("cancel");
      expect(await state.invoke("interruptStep", request)).toMatchObject({
        state: "interrupted",
        resource: { kind: "owner-control", controlId: control.controlId },
      });
      reconcileOwnedRunState(state.db, request.workflowRunId, false);
      expect(state.run()).toMatchObject({ state: "cancelled", agentCalls: 0 });
      expect(
        state.store.controls.get(control.runId, control.controlId).state,
      ).toBe("cancelled");
      expect(
        state.host.harness.experimental_hostRpcCalls.every(
          (call) => call.method === "inspectWorkspace",
        ),
      ).toBe(true);
    },
  );

  it("retains a rejected plan and denies source preparation", async () => {
    const state = setup();
    const { request, control } = await state.waitingApproval();
    state.store.controls.resolve({
      runId: control.runId,
      controlId: control.controlId,
      operationId: "reject-plan",
      expectedRevision: 1,
      contextHash: control.contextHash,
      decision: "rejected",
    });
    expect(await state.invoke("observeStep", request)).toMatchObject({
      state: "failed",
      receipt: { selectedOutputs: ["rejected"] },
    });
    const sourceStep = state.compiled.workflow.steps.find(
      (step) =>
        state.compiled.nodes[runtimeNodeKey(step)].kind === "prepare-worktree",
    );
    if (!sourceStep) throw new Error("Missing source preparation");
    expect(() => state.admit(sourceStep)).toThrow();
    expect(state.store.listEffectIds(control.runId, 100, 0).total).toBe(1);
    expect(state.run().agentCalls).toBe(0);
  });

  it.each(["accepted", "unaccepted", "other-request"] as const)(
    "replays a consumed Guided approval only for its exact %s writer",
    async (acceptance) => {
      const state = setup("guided");
      const { request, control } = await state.waitingApproval();
      state.store.controls.resolve({
        runId: control.runId,
        controlId: control.controlId,
        operationId: "approve-writer",
        expectedRevision: 1,
        contextHash: control.contextHash,
        decision: "approved",
      });
      const approved = await state.invoke("observeStep", request);
      const workerStep = state.compiled.workflow.steps.find(
        (step) => state.compiled.nodes[runtimeNodeKey(step)].kind === "agent",
      );
      if (
        !workerStep ||
        control.context.schemaVersion !== 1 ||
        control.context.candidate === null
      )
        throw new Error("Expected a Guided writer candidate");
      const worker = state.admit(workerStep);
      const effect = state.store.effect(worker.effectId);
      const candidate = control.context.candidate;
      const threadId = "thread-guided-writer";
      state.store.sealWorker(effect.effectId, {
        workspace: candidate,
        prompt: "The immutable assigned task",
      });
      state.store.bindThread(effect.effectId, threadId);
      state.preparations.set(effect.effectId, {
        operationId: effect.effectId,
        requestHash: runtimeHash({ operation: effect.effectId }),
        threadId,
        revision: 2,
        state: "started",
        reason: null,
        environment: {
          hostId: "host-a",
          environmentId: "worker-environment",
          path: candidate.path,
        },
        dispatch: {
          acceptedRevision: 1,
          queuedMessageId: "queued-guided",
          clientTurnRequestId: "creq_guided",
        },
      });
      if (acceptance !== "unaccepted")
        state.events.push({
          id: "accepted-guided",
          threadId,
          seq: 1,
          createdAt: 1,
          type: "turn/input/accepted",
          scope: { kind: "turn", turnId: "guided-turn" },
          data: {
            providerThreadId: "provider-thread",
            clientRequestId:
              acceptance === "accepted" ? "creq_guided" : "creq_other",
          },
        });
      state.workspaces.set(candidate.path, {
        ...candidate,
        clean: false,
        stateDigest: "e".repeat(64),
      });
      state.control("pause");
      state.restart();
      const replay = await state.invoke("observeStep", request);
      expect(replay).toMatchObject({
        state: "succeeded",
        validity: { state: acceptance === "accepted" ? "current" : "stale" },
      });
      if (!("receiptHash" in replay) || !("receiptHash" in approved))
        throw new Error("Expected immutable terminal proofs");
      expect(replay.receiptHash).toBe(approved.receiptHash);
      expect(
        state.store.controls.get(control.runId, control.controlId).revision,
      ).toBe(2);
      expect(state.run().agentCalls).toBe(1);
    },
  );
});

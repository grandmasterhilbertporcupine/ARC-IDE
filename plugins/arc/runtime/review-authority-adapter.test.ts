import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { ExperimentalThreadPreparation } from "@get-bb/plugin-sdk";
import {
  ownedStepObservationSchema,
  type OwnedRunView,
  type OwnedStepRequest,
} from "bb-plugin-workflows/owned-contract";
import { migrations } from "../data.js";
import { arcHostContract, type HostWorkspaceState } from "../host-contract.js";
import { createArcRuntimeAdapter } from "./adapter.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { controlMigrations } from "./control-data.js";
import { collaborationMigrations } from "./collaboration-data.js";
import { runtimeNodeKey } from "./compiler.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import type { TeamDefinition } from "../teams/contract.js";
import { runtimeHash } from "./hash.js";

const resources: { db: Database.Database; host: FakePluginHost }[] = [];
afterEach(async () => {
  for (const { db, host } of resources.splice(0)) {
    await host.harness.dispose();
    db.close();
  }
});
function setup(version: number) {
  const update = (team: TeamDefinition) => {
    team.members.push({ ...team.members[0], id: "reviewer" });
    team.graph.nodes.find((node) => node.kind === "review")!.memberId =
      "reviewer";
    team.permissions.push({
      id: "review",
      action: "review",
      fromMemberId: "reviewer",
      toMemberId: "builder",
    });
  };
  const compiled =
    version === 2
      ? compileArcGraphRun(graphRunDefinitionFixture(update))
      : compileArcOrchestratedRun(orchestratedDefinitionFixture(update));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...controlMigrations,
      ...collaborationMigrations,
    ].join(";\n"),
  );
  const store = createArcRunStore(db);
  for (const step of compiled.workflow.steps) {
    const node = compiled.nodes[runtimeNodeKey(step)];
    if (
      node.kind === "verify" ||
      (node.kind === "agent" && node.purpose === "review")
    )
      step.requirements = [];
  }
  store.reserve(compiled);
  const run: OwnedRunView = {
    workflowRunId: "workflow-review",
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
    chargedActiveMs: 0,
    repairRounds: [],
    result: { available: false },
    error: null,
  };
  const workspace: HostWorkspaceState = {
    path: compiled.definition.source.path,
    topLevel: compiled.definition.source.path,
    gitDir: compiled.definition.source.commonGitDir,
    commonGitDir: compiled.definition.source.commonGitDir,
    head: compiled.definition.source.head,
    currentBranch: "main",
    clean: true,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
    stateDigest: compiled.definition.source.stateHash,
  };
  const calls = { prepare: 0, start: 0, inspect: 0, native: 0 };
  let preparation: ExperimentalThreadPreparation | null = null;
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_internalRpc: async ({ pluginId, method }) => {
      if (pluginId !== "workflows" || method !== "inspectOwnedRun")
        throw new Error("Unexpected workflow call");
      return { run };
    },
    experimental_preparedThreads: {
      getPreparation: async () => preparation,
      prepare: async () => {
        calls.prepare++;
        throw new Error("Unauthorized preparation");
      },
      startPrepared: async () => {
        calls.start++;
        throw new Error("Unauthorized native turn");
      },
    },
    experimental_callHostRpc(call) {
      if (call.method === "inspectWorkspace") {
        calls.inspect++;
        const { path } = arcHostContract.inspectWorkspace.input.parse(
          call.input,
        );
        return { ...workspace, path, topLevel: path };
      }
      if (call.method === "observeEffect") return null;
      calls.native++;
      throw new Error("Unauthorized native action");
    },
  });
  resources.push({ db, host });
  const adapter = createArcRuntimeAdapter(host.bb, store);
  function admit(ref = compiled.references.outputs.review.outcome) {
    const step = compiled.workflow.steps.find(
      (step) => runtimeNodeKey(step) === runtimeNodeKey(ref),
    )!;
    const identity = {
      schemaVersion: 2 as const,
      workflowRunId: run.workflowRunId,
      ownerRunId: run.ownerRunId,
      ...ref,
      attempt: 1,
      effectId: `effect-${ref.nodeId}`,
      definitionHash: step.definitionHash,
      dependencyReceipts: [],
      lane:
        step.lane === null ? null : { key: runtimeHash(step.lane), fence: 1 },
      input: null,
    };
    const request: OwnedStepRequest = {
      ...identity,
      requestHash: runtimeHash({ owner: "arc", ...identity }),
      dispatchGeneration: 1,
    };
    store.reserveEffect(request);
    return request;
  }
  function revoke() {
    const retained = structuredClone(compiled);
    retained.definition.team.definition.permissions = [];
    db.prepare("UPDATE arc_runs SET compiled_json = ? WHERE id = ?").run(
      JSON.stringify(retained),
      run.ownerRunId,
    );
  }
  return {
    store,
    compiled,
    run,
    calls,
    workspace,
    adapter,
    revoke,
    admit,
    bind(request: OwnedStepRequest, state: "prepared" | "cancelled") {
      store.sealWorker(request.effectId, {
        workspace,
        prompt: "Retained review",
      });
      const identity = {
        operationId: request.effectId,
        requestHash: "f".repeat(64),
        threadId: "retained-review",
        revision: 1,
        environment: {
          hostId: compiled.definition.request.hostId,
          environmentId: "review-env",
          path: workspace.path,
        },
      };
      const current: ExperimentalThreadPreparation =
        state === "prepared"
          ? { ...identity, state: "prepared", dispatch: null, reason: null }
          : {
              ...identity,
              state: "cancelled",
              dispatch: null,
              reason: "Stopped before release",
            };
      preparation = current;
      return current;
    },
    async execute(request: OwnedStepRequest, observe = false) {
      const lookup = {
        workflowRunId: request.workflowRunId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        iteration: request.iteration,
        attempt: request.attempt,
        effectId: request.effectId,
        requestHash: request.requestHash,
        dispatchGeneration: request.dispatchGeneration,
      };
      return ownedStepObservationSchema.parse(
        await host.harness.experimental_callInternalRpc(
          observe ? "observeStep" : "executeStep",
          observe ? lookup : request,
          { callerPluginId: "workflows", signal: new AbortController().signal },
        ),
      );
    },
  };
}
describe.each([2, 3])(
  "V%s review recovery with real migrated SQLite",
  (version) => {
    it("refuses missing grants before first preparation", async () => {
      const test = setup(version);
      const request = test.admit();
      test.revoke();
      await expect(test.execute(request)).rejects.toThrow(
        /review work by builder/,
      );
      expect(test.calls).toEqual({
        prepare: 0,
        start: 0,
        inspect: 0,
        native: 0,
      });
    });
    it("preserves a recovered prepared worker without dispatching it", async () => {
      const test = setup(version);
      const request = test.admit();
      const preparation = test.bind(request, "prepared");
      test.revoke();
      expect(await test.execute(request)).toMatchObject({
        state: "needs-reconciliation",
        reason: expect.stringContaining("review work by builder"),
      });
      expect(test.calls.start).toBe(0);
      expect(test.calls.prepare).toBe(0);
      expect(test.store.effect(request.effectId).threadId).toBe(
        preparation.threadId,
      );
    });
    it("settles confirmed pre-release cancellation despite missing grants", async () => {
      const test = setup(version);
      const request = test.admit();
      test.bind(request, "cancelled");
      test.revoke();
      test.run.desiredControl = "pause";
      test.run.state = "paused";
      expect(await test.execute(request, true)).toMatchObject({
        state: "interrupted",
        receipt: { kind: "preparation", state: "cancelled" },
      });
      expect(test.calls.start).toBe(0);
    });
    it("keeps exact historical receipt bytes and physically scans while marking authority stale", async () => {
      const test = setup(version);
      const request = test.admit();
      const receipt = {
        kind: "agent",
        threadId: "retained-review",
        executionContextId: test.store.effect(request.effectId)
          .executionContextId,
        turnRequestId: "creq_review",
        terminalEventId: "evt_review",
        terminalStatus: "completed",
        workspace: test.workspace,
        review: {
          candidateHead: test.workspace.head,
          outcome: "approved",
          summary: "Old review",
          findings: [],
        },
        definitionHash: request.definitionHash,
      };
      const before = test.store.recordObservation(
        request.effectId,
        ownedStepObservationSchema.parse({
          state: "succeeded",
          resource: {
            kind: "agent",
            threadId: receipt.threadId,
            executionContextId: receipt.executionContextId,
            environmentId: "review-env",
            turnRequestId: receipt.turnRequestId,
          },
          receipt,
          receiptHash: runtimeHash(receipt),
          validity: { state: "current", identityHash: request.definitionHash },
        }),
      );
      test.revoke();
      const after = await test.adapter.revalidateTerminal(
        request.effectId,
        new AbortController().signal,
      );
      expect(after).toMatchObject({
        state: "succeeded",
        receipt,
        receiptHash: "receiptHash" in before ? before.receiptHash : null,
        validity: {
          state: "stale",
          reason: expect.stringContaining("review work by builder"),
        },
      });
      expect(test.calls.inspect).toBeGreaterThan(0);
      expect(test.calls.start).toBe(0);
    });
    it("blocks new final native verification before a host request is sealed", async () => {
      const test = setup(version);
      const request = test.admit(test.compiled.references.finalGates[0].verify);
      test.revoke();
      await expect(test.execute(request)).rejects.toThrow(
        /review work by builder/,
      );
      expect(test.store.effect(request.effectId).nativeRequest).toBeNull();
      expect(test.calls.native).toBe(0);
    });
  },
);

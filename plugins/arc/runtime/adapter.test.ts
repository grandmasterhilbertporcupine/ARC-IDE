import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
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
import { runDefinitionFixture } from "./testing.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
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

function setup(status: "current" | "stale" | "unavailable") {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const store = createArcRunStore(db);
  const compiled = compileArcRun(runDefinitionFixture());
  const ref = { nodeId: "check", iteration: 0 };
  const node = compiled.nodes[runtimeNodeKey(ref)];
  const step = compiled.workflow.steps.find(
    (value) => runtimeNodeKey(value) === runtimeNodeKey(ref),
  )!;
  compiled.workflow.steps = [{ ...step, dependencies: [], lane: null }];
  compiled.workflow.requiredGates = [
    { gateId: "check", mode: "all", steps: [ref] },
  ];
  store.reserve(compiled);
  const request: OwnedStepRequest = {
    workflowRunId: "workflow-a",
    ownerRunId: compiled.definition.runId,
    ...ref,
    attempt: 1,
    effectId: "effect-check",
    requestHash: "c".repeat(64),
    dispatchGeneration: 1,
    definitionHash: runtimeHash(node),
    dependencyReceipts: [],
    lane: null,
    input: null,
  };
  const {
    requestHash: _hash,
    dispatchGeneration: _generation,
    ...immutable
  } = request;
  request.requestHash = runtimeHash({ owner: "arc", ...immutable });
  store.reserveEffect(request);
  const nativeRequest: HostEffectRequest = {
    runId: request.ownerRunId,
    effectId: request.effectId,
    lane: null,
    workspace: {
      path: "C:/worktree",
      commonGitDir: "C:/Project 東京/.git",
      originalPath: "C:/Project 東京",
      expectedHead: "a".repeat(40),
      expectedStateDigest: "b".repeat(64),
    },
    operation: {
      type: "check",
      executable: "node",
      args: ["check.mjs"],
      timeoutMs: 30_000,
    },
  };
  store.sealNative(request.effectId, nativeRequest);
  const record: HostEffectRecord = {
    runId: request.ownerRunId,
    effectId: request.effectId,
    requestHash: hostEffectRequestHash(nativeRequest),
    state: "terminal",
    startedAt: "2026-09-10T06:00:00Z",
    finishedAt: "2026-09-10T06:00:01Z",
    receipt: {
      outcome: "succeeded",
      reason: null,
      before: workspace("C:/worktree"),
      after: workspace("C:/worktree"),
      source: null,
      processes: [],
      artifact: {
        workspacePath: "C:/worktree",
        commitSha: "a".repeat(40),
        treeSha: "d".repeat(40),
      },
      finishedAt: "2026-09-10T06:00:01Z",
    },
    receiptValidity: {
      status,
      reason:
        status === "current"
          ? null
          : "Candidate moved before the receipt was observed",
      checkedAt: "2026-09-10T06:00:02Z",
      currentState: workspace("C:/worktree"),
    },
  };
  const run: OwnedRunView = {
    workflowRunId: request.workflowRunId,
    ownerRunId: request.ownerRunId,
    projectId: "project-a",
    originThreadId: "thread-parent",
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
  let redirected = false;
  let originalChanged = false;
  let sourceRedirected = false;
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_internalRpc: async ({ pluginId, method }) => {
      if (pluginId !== "workflows" || method !== "inspectOwnedRun")
        throw new Error("Unexpected internal call");
      return { run };
    },
    experimental_callHostRpc(call) {
      if (call.method === "observeEffect") return record;
      if (call.method === "inspectWorkspace") {
        const input = arcHostContract.inspectWorkspace.input.parse(call.input);
        if (input.path === "C:/Project 東京")
          return {
            ...workspace(),
            ...(sourceRedirected
              ? {
                  path: "C:/redirected-source",
                  topLevel: "C:/redirected-source",
                  gitDir: "C:/Project 東京/.git/worktrees/redirected-source",
                }
              : {}),
            head: originalChanged ? "e".repeat(40) : workspace().head,
          };
        return redirected
          ? {
              ...workspace("C:/worktree"),
              path: "C:/other-worktree",
              topLevel: "C:/other-worktree",
              gitDir: "C:/other-worktree/.git",
            }
          : workspace("C:/worktree");
      }
      throw new Error("The retained native effect must never run again");
    },
  });
  hosts.push(host);
  createArcRuntimeAdapter(host.bb, store);
  return {
    host,
    store,
    request,
    redirect() {
      redirected = true;
    },
    moveOriginal() {
      originalChanged = true;
    },
    redirectSource() {
      sourceRedirected = true;
    },
  };
}

describe("ARC native receipt admission", () => {
  it("invalidates retained success when only the canonical original path redirects within the same repository", async () => {
    const state = setup("current");
    const context = {
      callerPluginId: "workflows",
      signal: new AbortController().signal,
    };
    const before = ownedStepObservationSchema.parse(
      await state.host.harness.experimental_callInternalRpc(
        "executeStep",
        state.request,
        context,
      ),
    );
    expect(before).toMatchObject({
      state: "succeeded",
      validity: { state: "current" },
    });
    state.redirectSource();
    const {
      definitionHash: _definition,
      dependencyReceipts: _dependencies,
      lane: _lane,
      input: _input,
      ...lookup
    } = state.request;
    const after = ownedStepObservationSchema.parse(
      await state.host.harness.experimental_callInternalRpc(
        "observeStep",
        lookup,
        context,
      ),
    );
    expect(after).toMatchObject({
      state: "succeeded",
      validity: {
        state: "stale",
        reason: "The original project changed after this run was started",
      },
    });
    if (!("receiptHash" in before) || !("receiptHash" in after))
      throw new Error("Expected retained native receipts");
    expect(after.receiptHash).toBe(before.receiptHash);
    expect(state.store.effect(state.request.effectId).observation).toEqual(
      after,
    );
    expect(
      state.host.harness.experimental_hostRpcCalls.some(
        (call) => call.method === "startEffect",
      ),
    ).toBe(false);
  });
  it.each(["stale", "unavailable"] as const)(
    "does not promote a first terminal receipt already known to be %s",
    async (status) => {
      const { host, request, store } = setup(status);
      const result = ownedStepObservationSchema.parse(
        await host.harness.experimental_callInternalRpc(
          "executeStep",
          request,
          { callerPluginId: "workflows", signal: new AbortController().signal },
        ),
      );
      expect(result).toMatchObject({
        state: "succeeded",
        validity: { state: "stale" },
      });
      expect(store.effect(request.effectId).observation).toEqual(result);
      expect(
        host.harness.experimental_hostRpcCalls.some(
          (call) => call.method === "startEffect",
        ),
      ).toBe(false);
    },
  );

  it("invalidates an unchanged commit and file digest when the worktree identity was redirected", async () => {
    const state = setup("current");
    const context = {
      callerPluginId: "workflows",
      signal: new AbortController().signal,
    };
    const before = ownedStepObservationSchema.parse(
      await state.host.harness.experimental_callInternalRpc(
        "executeStep",
        state.request,
        context,
      ),
    );
    expect(before).toMatchObject({
      state: "succeeded",
      validity: { state: "current" },
    });
    state.redirect();
    const {
      definitionHash: _definition,
      dependencyReceipts: _dependencies,
      lane: _lane,
      input: _input,
      ...lookup
    } = state.request;
    const after = ownedStepObservationSchema.parse(
      await state.host.harness.experimental_callInternalRpc(
        "observeStep",
        lookup,
        context,
      ),
    );
    expect(after).toMatchObject({
      state: "succeeded",
      validity: { state: "stale" },
    });
    if (!("receiptHash" in before) || !("receiptHash" in after))
      throw new Error("Expected native receipts");
    expect(after.receiptHash).toBe(before.receiptHash);
  });

  it("checks original source identity before admitting terminal success and rejects non-owner callbacks", async () => {
    const state = setup("current");
    state.moveOriginal();
    await expect(
      state.host.harness.experimental_callInternalRpc(
        "executeStep",
        state.request,
        { callerPluginId: "other", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Only Workflows");
    const result = await state.host.harness.experimental_callInternalRpc(
      "executeStep",
      state.request,
      { callerPluginId: "workflows", signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      state: "succeeded",
      validity: {
        state: "stale",
        reason: "The original project changed after this run was started",
      },
    });
  });
});

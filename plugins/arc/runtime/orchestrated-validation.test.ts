import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { ExperimentalTurnPreparation } from "@get-bb/plugin-sdk";
import { ownedStepObservationV2Schema } from "bb-plugin-workflows/owned-contract";
import { arcHostContract, type HostWorkspaceState } from "../host-contract.js";
import { teamEdge } from "../teams/testing.js";
import { createArcRuntimeAdapter } from "./adapter.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";
import { runtimeReceiptSchema } from "./receipt.js";
import {
  createOrchestratedTestRun,
  orchestratedDefinitionFixture,
} from "./orchestrated-testing.js";

const runs: ReturnType<typeof createOrchestratedTestRun>[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const run of runs.splice(0)) run.db.close();
});

async function setup() {
  const run = createOrchestratedTestRun(
    orchestratedDefinitionFixture((team) => {
      for (let index = 0; index < 18; index++) {
        const id = `extra-read-${index}`;
        team.graph.nodes.push({
          id,
          label: id,
          kind: "agent",
          memberId: "builder",
          task: "Inspect the candidate without edits",
          access: "read",
          candidate: { kind: "node", nodeId: "write" },
        });
        team.graph.edges.push(
          teamEdge(index === 0 ? "check" : `extra-read-${index - 1}`, id),
        );
        if (index === 17) team.graph.edges.push(teamEdge(id, "review"));
      }
    }),
  );
  runs.push(run);
  const source = run.compiled.definition.source;
  const candidatePath = "C:/retained-worktree";
  function workspace(path: string): HostWorkspaceState {
    return {
      path,
      topLevel: path,
      gitDir: `${path}/.git`,
      commonGitDir: source.commonGitDir,
      head: source.head,
      currentBranch: path === source.path ? "main" : null,
      clean: true,
      trackedDigest: source.stateHash,
      untrackedDigest: source.stateHash,
      contentDigest: source.stateHash,
      stateDigest: source.stateHash,
    };
  }
  await expect(
    run.execute({
      main: async () => {
        throw new Error("Hold main response");
      },
      native(effect) {
        const node = run.compiled.nodes[runtimeNodeKey(effect.request)];
        const state = workspace(candidatePath);
        const receipt = runtimeReceiptSchema.parse(
          node.kind === "agent"
            ? {
                kind: "agent",
                threadId: `thread-${effect.effectId}`,
                executionContextId: effect.executionContextId,
                turnRequestId: `request-${effect.effectId}`,
                terminalEventId: `terminal-${effect.effectId}`,
                terminalStatus: "completed",
                workspace: state,
                review: null,
                definitionHash: effect.request.definitionHash,
              }
            : {
                kind: "native",
                request: {
                  runId: effect.runId,
                  effectId: effect.effectId,
                  lane: null,
                  workspace: {
                    path: state.path,
                    commonGitDir: source.commonGitDir,
                    originalPath: source.path,
                    expectedHead: state.head,
                    expectedStateDigest: state.stateDigest,
                  },
                  operation:
                    node.kind === "check"
                      ? { type: "check", ...node.command }
                      : { type: "snapshot" },
                },
                receipt: {
                  outcome: "succeeded",
                  reason: null,
                  before: state,
                  after: state,
                  source: null,
                  processes: [],
                  artifact: {
                    workspacePath: state.path,
                    commitSha: state.head,
                    treeSha: "d".repeat(40),
                  },
                  finishedAt: "2026-09-10T12:00:00Z",
                },
              },
        );
        return {
          state: "succeeded",
          resource:
            node.kind === "agent"
              ? {
                  kind: "agent",
                  threadId: `thread-${effect.effectId}`,
                  executionContextId: effect.executionContextId,
                  environmentId: `environment-${effect.effectId}`,
                  turnRequestId: `request-${effect.effectId}`,
                }
              : {
                  kind: "host-effect",
                  hostId: run.compiled.definition.request.hostId,
                  effectId: effect.effectId,
                },
          receipt,
          receiptHash: runtimeHash(receipt),
          validity: {
            state: "current",
            identityHash: effect.request.definitionHash,
          },
        };
      },
    }),
  ).rejects.toThrow("Hold main response");
  let preparation: ExperimentalTurnPreparation | null = null;
  let prepares = 0;
  let starts = 0;
  let latency = 0;
  let candidateChanged = false;
  let sourceChanged = false;
  let busy = false;
  let moveOnPrepare = false;
  let abortPath: string | null = null;
  let controller = new AbortController();
  const inspections: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_internalRpc: async ({ method }) => {
      if (method !== "inspectOwnedRun")
        throw new Error("Unexpected Workflows mutation");
      return { run: run.view() };
    },
    async experimental_callHostRpc(call) {
      if (call.method !== "inspectWorkspace")
        throw new Error("Validation cannot write the host");
      const input = arcHostContract.inspectWorkspace.input.parse(call.input);
      inspections.push(input.path);
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        await delay(latency, undefined, { signal: controller.signal });
        const state = workspace(input.path);
        if (
          (input.path === source.path && sourceChanged) ||
          (input.path === candidatePath && candidateChanged)
        )
          state.head = "e".repeat(40);
        if (input.path === abortPath)
          controller.abort(new Error("Stopped after inspection"));
        return state;
      } finally {
        active--;
      }
    },
    experimental_preparedTurns: {
      async getPreparation() {
        return preparation;
      },
      async prepare(request) {
        prepares++;
        preparation = {
          operationId: request.operationId,
          requestHash: "a".repeat(64),
          threadId: request.threadId,
          executionContextId: request.executionContextId,
          revision: 0,
          state: "prepared",
          environment: request.environment,
          dispatch: null,
          turn: null,
          reason: null,
        };
        if (moveOnPrepare) sourceChanged = true;
        return preparation;
      },
      async startPrepared() {
        if (busy)
          throw Object.assign(new Error("Busy main conversation"), {
            status: 409,
            body: { code: "prepared_turn_busy", retryable: true },
          });
        if (!preparation) throw new Error("No preparation");
        starts++;
        preparation.state = "start-requested";
        preparation.dispatch = {
          acceptedRevision: 0,
          queuedMessageId: "queue-main",
          clientTurnRequestId: null,
        };
        return preparation;
      },
      async interrupt() {
        throw new Error("No interruption requested");
      },
    },
  });
  hosts.push(host);
  createArcRuntimeAdapter(host.bb, run.store);
  return {
    run,
    source,
    candidatePath,
    inspections,
    counts: () => ({ prepares, starts, maximumActive }),
    latency: (value: number) => {
      latency = value;
    },
    busy: () => {
      busy = true;
    },
    moveOnPrepare: () => {
      moveOnPrepare = true;
    },
    changeCandidate: () => {
      candidateChanged = true;
    },
    abortAfterInspect: (path: string) => {
      abortPath = path;
    },
    async execute(signal?: AbortSignal) {
      controller = new AbortController();
      const combined = AbortSignal.any([
        controller.signal,
        ...(signal ? [signal] : []),
      ]);
      return ownedStepObservationV2Schema.parse(
        await host.harness.experimental_callInternalRpc(
          "executeStep",
          run.mainEffect().request,
          { callerPluginId: "workflows", signal: combined },
        ),
      );
    },
  };
}

describe("fresh retained graph validation before main response", () => {
  it("coalesces repeated native evidence within the real ten-second callback budget", async () => {
    const fixture = await setup();
    fixture.latency(450);
    const before = performance.now();
    expect(await fixture.execute(AbortSignal.timeout(10_000))).toMatchObject({
      state: "running",
    });
    expect(performance.now() - before).toBeLessThan(5_000);
    expect(
      fixture.run.store.completionEffects(fixture.run.compiled.definition.runId)
        .length,
    ).toBeGreaterThan(25);
    expect(
      fixture.inspections.filter((path) => path === fixture.source.path),
    ).toHaveLength(2);
    expect(
      fixture.inspections.filter((path) => path === fixture.candidatePath),
    ).toHaveLength(1);
    expect(fixture.counts()).toMatchObject({ prepares: 1, starts: 1 });
    expect(fixture.counts().maximumActive).toBeLessThanOrEqual(4);
  }, 15_000);

  it.each(["source", "candidate"] as const)(
    "does not persist cancellation as stale %s evidence",
    async (target) => {
      const fixture = await setup();
      const before = fixture.run.store.completionEffects(
        fixture.run.compiled.definition.runId,
      );
      fixture.abortAfterInspect(
        target === "source" ? fixture.source.path : fixture.candidatePath,
      );
      await expect(fixture.execute()).rejects.toThrow(
        "Stopped after inspection",
      );
      const after = fixture.run.store.completionEffects(
        fixture.run.compiled.definition.runId,
      );
      for (const previous of before) {
        const current = after.find(
          (effect) => effect.effectId === previous.effectId,
        )!;
        const node =
          fixture.run.compiled.nodes[runtimeNodeKey(previous.request)];
        if (
          target === "source" ||
          node.kind === "check" ||
          node.kind === "verify" ||
          (node.kind === "agent" && node.purpose === "review")
        )
          expect(current.observation).toEqual(previous.observation);
        else if (previous.observation && "receiptHash" in previous.observation)
          expect(current.observation).toMatchObject({
            state: previous.observation.state,
            receiptHash: previous.observation.receiptHash,
            validity: { state: "current" },
          });
      }
      expect(fixture.counts()).toMatchObject({ prepares: 0, starts: 0 });
    },
  );

  it("freshly checks the original after preparing and refuses a moved source before release", async () => {
    const fixture = await setup();
    fixture.moveOnPrepare();
    expect(await fixture.execute()).toMatchObject({
      state: "needs-reconciliation",
      reason: "The original project changed after this run was started",
    });
    expect(fixture.counts()).toMatchObject({ prepares: 1, starts: 0 });
  });

  it("does not carry a successful validation pass across a busy callback", async () => {
    const fixture = await setup();
    fixture.busy();
    expect(await fixture.execute()).toMatchObject({ state: "running" });
    fixture.changeCandidate();
    expect(await fixture.execute()).toMatchObject({
      state: "needs-reconciliation",
    });
    expect(
      fixture.inspections.filter((path) => path === fixture.candidatePath),
    ).toHaveLength(2);
    expect(fixture.counts()).toMatchObject({ prepares: 1, starts: 0 });
    expect(
      fixture.run.store
        .completionEffects(fixture.run.compiled.definition.runId)
        .some(
          (effect) =>
            effect.observation &&
            "validity" in effect.observation &&
            effect.observation.validity.state === "stale",
        ),
    ).toBe(true);
  });
});

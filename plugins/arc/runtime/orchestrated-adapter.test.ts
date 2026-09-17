import { afterEach, describe, expect, it } from "vitest";
import type {
  ExperimentalPrepareTurnRequest,
  ExperimentalTurnPreparation,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  admitOwnedStep,
  recordOwnedObservation,
} from "../../workflows/src/owned-data.js";
import { createOrchestratorTurnDriver } from "./orchestrated-adapter.js";
import { createOrchestratedTestRun } from "./orchestrated-testing.js";
import type { ArcRunEffect } from "./data.js";

const runs: ReturnType<typeof createOrchestratedTestRun>[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const run of runs.splice(0)) run.db.close();
});

async function setup() {
  const run = createOrchestratedTestRun();
  runs.push(run);
  await expect(
    run.execute({
      main: async () => {
        throw new Error("Hold admitted main turn");
      },
    }),
  ).rejects.toThrow("Hold admitted main turn");
  const preparations = new Map<string, ExperimentalTurnPreparation>();
  const requests: ExperimentalPrepareTurnRequest[] = [];
  let starts = 0;
  let allowed = true;
  let losePrepare = false;
  let loseStart = false;
  let pauseAfterPrepare = false;
  let busy: "prepare" | "start" | null = null;
  const busyError = () =>
    Object.assign(new Error("The main conversation is busy"), {
      status: 409,
      body: { code: "prepared_turn_busy", retryable: true },
    });
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_preparedTurns: {
      async getPreparation({ operationId }) {
        return preparations.get(operationId) ?? null;
      },
      async prepare(request) {
        if (busy === "prepare") throw busyError();
        requests.push(request);
        const preparation: ExperimentalTurnPreparation = {
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
        preparations.set(request.operationId, preparation);
        if (pauseAfterPrepare) allowed = false;
        if (losePrepare) {
          losePrepare = false;
          throw new Error("Lost prepare response");
        }
        return preparation;
      },
      async startPrepared({ operationId, expectedRevision }) {
        if (busy === "start") throw busyError();
        const preparation = preparations.get(operationId);
        if (!preparation || preparation.revision !== expectedRevision)
          throw new Error("Revision mismatch");
        if (
          preparation.state !== "prepared" &&
          preparation.state !== "needs-reconciliation"
        )
          throw new Error("Terminal operation cannot restart");
        starts++;
        preparation.revision++;
        preparation.state = "start-requested";
        preparation.dispatch = {
          acceptedRevision: expectedRevision,
          queuedMessageId: `queue-${operationId}`,
          clientTurnRequestId: null,
        };
        if (loseStart) {
          loseStart = false;
          throw new Error("Lost start response");
        }
        return preparation;
      },
      async interrupt({ operationId, expectedRevision }) {
        const preparation = preparations.get(operationId);
        if (!preparation || preparation.revision !== expectedRevision)
          throw new Error("Revision mismatch");
        if (preparation.dispatch?.clientTurnRequestId)
          throw new Error("Fixture expects pre-native cancellation");
        preparation.revision++;
        preparation.state = "cancelled";
        preparation.reason = "Owner paused this admitted response";
        return preparation;
      },
    },
  });
  hosts.push(host);
  const driver = createOrchestratorTurnDriver({
    bb: host.bb,
    store: run.store,
    canAdvance: async () => allowed,
    originValidity: async () => ({
      state: "current",
      identityHash: run.compiled.workflow.planHash,
    }),
    validateGraph: async (_effect, effects) => ({
      origin: {
        state: "current",
        identityHash: run.compiled.workflow.planHash,
      },
      observations: effects.map((effect) => {
        if (!effect.observation) throw new Error("Missing retained evidence");
        return effect.observation;
      }),
    }),
  });
  const node =
    run.compiled.nodes[`${run.compiled.references.mainCompletion.nodeId}:0`];
  if (node.kind !== "orchestrator")
    throw new Error("Missing main completion node");
  return {
    run,
    driver,
    node,
    requests,
    preparations,
    starts: () => starts,
    allow: (value: boolean) => {
      allowed = value;
    },
    losePrepare: () => {
      losePrepare = true;
    },
    loseStart: () => {
      loseStart = true;
    },
    pauseAfterPrepare: () => {
      pauseAfterPrepare = true;
    },
    busy: (phase: "prepare" | "start" | null) => {
      busy = phase;
    },
    async drive(execute = true, effect: ArcRunEffect = run.mainEffect()) {
      const observation = await driver.drive(
        effect,
        node,
        effect.request,
        new AbortController().signal,
        execute,
      );
      run.store.recordObservation(effect.effectId, observation);
      recordOwnedObservation(
        run.db,
        effect.effectId,
        run.generation,
        observation,
      );
      return observation;
    },
    complete(effect = run.mainEffect()) {
      const preparation = preparations.get(effect.effectId);
      if (!preparation?.dispatch)
        throw new Error("The main turn was not requested");
      preparation.state = "completed";
      preparation.dispatch.clientTurnRequestId = `request-${effect.effectId}`;
      preparation.turn = {
        providerThreadId: "provider-existing-main",
        turnId: "native-completion",
        acceptedEventId: "accepted-completion",
        terminalEventId: "terminal-completion",
        terminalStatus: "completed",
      };
    },
  };
}

describe("admitted existing main conversation response", () => {
  it.each(["prepare", "start"] as const)(
    "waits for a busy %s boundary without a new call admission",
    async (phase) => {
      const fixture = await setup();
      fixture.busy(phase);
      expect(await fixture.drive()).toMatchObject({
        state: phase === "prepare" ? "not-started" : "running",
      });
      expect(fixture.starts()).toBe(0);
      expect(fixture.run.view().agentCalls).toBe(3);
      fixture.busy(null);
      expect(await fixture.drive()).toMatchObject({ state: "running" });
      expect(fixture.starts()).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.run.view().agentCalls).toBe(3);
    },
  );
  it("preserves the exact main binding and waits for matching native acceptance and completion", async () => {
    const fixture = await setup();
    expect(await fixture.drive()).toMatchObject({
      state: "running",
      resource: {
        threadId: fixture.node.completion.threadId,
        turnRequestId: null,
      },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      threadId: fixture.node.completion.threadId,
      environment: fixture.node.completion.environment,
      execution: fixture.node.completion.execution,
    });
    expect(JSON.stringify(fixture.requests[0].input)).toContain(
      "same run budget",
    );
    expect(fixture.run.view().agentCalls).toBe(3);
    expect(await fixture.drive(false)).toMatchObject({ state: "running" });
    fixture.complete();
    expect(await fixture.drive(false)).toMatchObject({
      state: "succeeded",
      receipt: {
        kind: "orchestrator",
        acceptedEventId: "accepted-completion",
        terminalEventId: "terminal-completion",
      },
    });
    expect(fixture.starts()).toBe(1);
  });
  it.each(["prepare", "start"] as const)(
    "recovers a lost %s response without dispatching a second turn",
    async (phase) => {
      const fixture = await setup();
      if (phase === "prepare") fixture.losePrepare();
      else fixture.loseStart();
      await expect(fixture.drive()).rejects.toThrow(`Lost ${phase} response`);
      expect(await fixture.drive()).toMatchObject({ state: "running" });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.starts()).toBe(1);
      expect(fixture.run.view().agentCalls).toBe(3);
    },
  );
  it("requires a new charged admission after a pre-native pause cancellation", async () => {
    const fixture = await setup();
    fixture.pauseAfterPrepare();
    expect(await fixture.drive()).toMatchObject({
      state: "running",
      resource: { turnRequestId: null },
    });
    const effect = fixture.run.mainEffect();
    const interrupted = await fixture.driver.interrupt(
      effect,
      fixture.node,
      effect.request,
      new AbortController().signal,
    );
    expect(interrupted).toMatchObject({
      state: "interrupted",
      receipt: { kind: "orchestrator-preparation", state: "cancelled" },
    });
    fixture.run.store.recordObservation(effect.effectId, interrupted);
    recordOwnedObservation(
      fixture.run.db,
      effect.effectId,
      fixture.run.generation,
      interrupted,
    );
    fixture.allow(true);
    expect(await fixture.drive()).toMatchObject({ state: "interrupted" });
    expect(fixture.starts()).toBe(0);
    const attempt = admitOwnedStep(
      fixture.run.db,
      fixture.run.workflow.workflowRunId,
      fixture.run.compiled.references.mainCompletion,
      null,
      fixture.run.generation,
    );
    if (!attempt) throw new Error("New response attempt was not admitted");
    expect(attempt.row.effect_id).not.toBe(effect.effectId);
    expect(fixture.run.view().agentCalls).toBe(4);
  });
  it("keeps owner-only main context separate from child thread identity", async () => {
    const fixture = await setup();
    const effect = fixture.run.mainEffect();
    const projectId = fixture.run.compiled.definition.request.projectId;
    expect(
      fixture.run.store.fromTurnContext(
        effect.executionContextId,
        projectId,
        fixture.node.completion.threadId,
      ).node.kind,
    ).toBe("orchestrator");
    expect(() =>
      fixture.run.store.fromTurnContext(
        effect.executionContextId,
        projectId,
        "other-thread",
      ),
    ).toThrow("another project or conversation");
    expect(() =>
      fixture.run.store.fromContext(
        effect.executionContextId,
        projectId,
        fixture.node.completion.threadId,
      ),
    ).toThrow();
    expect(effect.threadId).toBeNull();
  });
  it("does not prepare a main turn when required retained graph evidence is missing", async () => {
    const fixture = await setup();
    const effect = fixture.run.store
      .completionEffects(fixture.run.compiled.definition.runId)
      .find(
        (item) =>
          fixture.run.compiled.nodes[
            `${item.request.nodeId}:${item.request.iteration}`
          ].kind === "check",
      );
    if (!effect) throw new Error("Fixture check is missing");
    fixture.run.db
      .prepare("DELETE FROM arc_run_effects WHERE effect_id = ?")
      .run(effect.effectId);
    expect(await fixture.drive()).toMatchObject({
      state: "needs-reconciliation",
    });
    expect(fixture.requests).toHaveLength(0);
  });
  it("marks replaced native terminal identity stale on recovery", async () => {
    const fixture = await setup();
    await fixture.drive();
    fixture.complete();
    await fixture.drive(false);
    const effect = fixture.run.mainEffect();
    const preparation = fixture.preparations.get(effect.effectId);
    if (!preparation?.turn) throw new Error("Missing native turn");
    preparation.turn.terminalEventId = "unrelated-native-terminal";
    expect(
      await fixture.driver.validate(effect, new AbortController().signal),
    ).toMatchObject({ validity: { state: "stale" } });
  });
  it("fails closed when a retained prepared response changes environment", async () => {
    const fixture = await setup();
    await fixture.drive();
    const preparation = fixture.preparations.get(
      fixture.run.mainEffect().effectId,
    );
    if (!preparation) throw new Error("Missing main preparation");
    preparation.environment = {
      ...preparation.environment,
      environmentId: "other-environment",
    };
    await expect(fixture.drive(false)).rejects.toThrow(
      "another conversation or environment",
    );
    expect(fixture.starts()).toBe(1);
  });
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ownedAdapterRpcContract,
  ownedWorkflowRpcContract,
  type OwnedStepLookup,
  type OwnedStepObservation,
  type OwnedStepObservationV2,
  type OwnedStepRequest,
  type OwnedRunStartV2,
} from "./owned-contract.js";
import {
  admittedStep,
  ownedRunInput,
  terminalReceipt,
} from "./owned-test-fixtures.js";
import plugin from "./server.js";
import { hashOwnedValue } from "./owned-data.js";
import {
  branchInput,
  controlReceipt,
  waitingControl,
  decisionStep,
  v2Input,
  v2Step,
} from "./owned-v2-test-fixtures.js";

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("owned execution in the existing workflow worker", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
  });

  async function setup(behavior: {
    execute(
      request: OwnedStepRequest,
      signal: AbortSignal,
    ): Promise<OwnedStepObservationV2>;
    observe(
      request: OwnedStepLookup,
      signal: AbortSignal,
    ): Promise<OwnedStepObservationV2>;
    interrupt(
      request: OwnedStepLookup,
      signal: AbortSignal,
    ): Promise<OwnedStepObservationV2>;
  }) {
    let workflows: ReturnType<typeof createFakePluginHost>;
    const arc = createFakePluginHost({
      pluginId: "arc",
      experimental_internalRpc: (args) =>
        workflows.harness.behavior.experimental_callInternalRpc(
          args.method,
          args.input,
          args.context,
        ),
    });
    workflows = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
      experimental_internalRpc: (args) =>
        arc.harness.behavior.experimental_callInternalRpc(
          args.method,
          args.input,
          args.context,
        ),
    });
    cleanups.push(
      () => arc.harness.dispose(),
      () => workflows.harness.dispose(),
    );
    arc.bb.rpc.experimental_registerInternal(ownedAdapterRpcContract, {
      executeStep(input, context) {
        expect(context.callerPluginId).toBe("workflows");
        return behavior.execute(input, context.signal);
      },
      observeStep(input, context) {
        return behavior.observe(input, context.signal);
      },
      interruptStep(input, context) {
        return behavior.interrupt(input, context.signal);
      },
    });
    await plugin(workflows.bb);
    expect(
      workflows.harness.registrations.services.map((service) => service.name),
    ).toEqual(["workflow-worker"]);
    const client = arc.bb.rpc.experimental_client({
      pluginId: "workflows",
      contract: ownedWorkflowRpcContract,
    });
    let activeWorker: ReturnType<typeof workflows.harness.runService> | null =
      null;
    return {
      client,
      workflows,
      arc,
      startWorker() {
        const worker = workflows.harness.runService("workflow-worker");
        activeWorker = worker;
        cleanups.push(async () => {
          worker.controller.abort();
          await worker.done;
        });
      },
      async reloadWorkflows() {
        activeWorker?.controller.abort();
        await activeWorker?.done;
        workflows = await workflows.harness.reload(plugin);
        activeWorker = null;
      },
    };
  }

  it.each(["ordinary", "rules"] as const)(
    "recovers a consumed %s continuation after reload and waits for real owner-control interruption before successor execution",
    async (mode) => {
      const requests: OwnedStepRequest[] = [];
      const observations = new Map<string, OwnedStepObservationV2>();
      let permitRetirement = false;
      const context = await setup({
        async execute(request) {
          requests.push(request);
          const observation =
            request.nodeId === "choice"
              ? request.ownerRunId === "original"
                ? waitingControl(request, 2)
                : controlReceipt(request)
              : terminalReceipt(
                  request,
                  "succeeded",
                  { value: "replacement" },
                  "agent",
                );
          observations.set(request.effectId, observation);
          return observation;
        },
        async observe(request) {
          const observation = observations.get(request.effectId);
          if (observation === undefined)
            throw new Error("Unknown native request");
          return observation;
        },
        async interrupt(request) {
          const observation = observations.get(request.effectId);
          if (observation === undefined)
            throw new Error("Unknown native request");
          if (observation.state !== "waiting" || !permitRetirement)
            return observation;
          const interrupted: OwnedStepObservationV2 = {
            state: "interrupted",
            resource: observation.resource,
            receipt: { retired: true },
            receiptHash: hashOwnedValue({ retired: true }),
            validity: { state: "current", identityHash: "b".repeat(64) },
          };
          observations.set(request.effectId, interrupted);
          return interrupted;
        },
      });
      const input = v2Input({
        ownerRunId: "original",
        steps: [decisionStep(), v2Step("check", { kind: "agent" })],
        source: `export const meta = {name: "continuation", description: "Reviewed replacement"}; await step("choice", 0, null); return await step("check", 0, null);`,
      });
      const { run } = await context.client.call("startOwnedRun", input);
      context.startWorker();
      await eventually(() => expect(requests).toHaveLength(1));
      await eventually(() =>
        expect(observations.get(requests[0]!.effectId)?.state).toBe("waiting"),
      );
      const reservation = {
        predecessorWorkflowRunId: run.workflowRunId,
        operationId: "apply",
        expectedControlVersion: run.controlVersion,
        successorOwnerRunId: "replacement",
      };
      await context.client.call("reserveOwnedContinuation", reservation);
      const key = {
        predecessorWorkflowRunId: run.workflowRunId,
        operationId: "apply",
      };
      await eventually(async () =>
        expect(
          (await context.client.call("inspectOwnedContinuation", key))
            .continuation?.state,
        ).toBe("ready"),
      );
      const successor = {
        ...input,
        ownerRunId: "replacement",
        planHash: "c".repeat(64),
      };
      const startReplacement = (value: OwnedRunStartV2) =>
        mode === "ordinary"
          ? context.client.call("startOwnedContinuation", {
              ...key,
              successor: value,
            })
          : context.client.call("startOwnedRuleContinuation", {
              ...key,
              successor: value,
              authorization: {
                schemaVersion: 1,
                reviewHash: hashOwnedValue("review"),
                repairStages: [],
              },
            });
      await expect(
        startReplacement({
          ...successor,
          source: "export const meta = {name: 'invalid'}; await step(",
        }),
      ).rejects.toThrow();
      expect(
        (await context.client.call("inspectOwnedContinuation", key))
          .continuation?.successorPlanHash,
      ).toBeNull();
      expect(
        (
          await context.client.call("inspectOwnedRuleContext", {
            workflowRunId: run.workflowRunId,
          })
        ).repairCatalog,
      ).toEqual({ source: "manifest", stages: [] });
      expect((await startReplacement(successor)).continuation.state).toBe(
        "retiring",
      );
      expect(requests).toHaveLength(1);
      await context.reloadWorkflows();
      expect(
        (await context.client.call("inspectOwnedContinuation", key))
          .continuation?.state,
      ).toBe("retiring");
      permitRetirement = true;
      context.startWorker();
      await eventually(async () => {
        const { continuation } = await context.client.call(
          "inspectOwnedContinuation",
          key,
        );
        expect(continuation).toMatchObject({
          state: "started",
          predecessor: { state: "cancelled" },
          successor: { state: "succeeded", agentCalls: 1 },
        });
      });
      expect(
        requests.map((request) => [request.ownerRunId, request.nodeId]),
      ).toEqual([
        ["original", "choice"],
        ["replacement", "choice"],
        ["replacement", "check"],
      ]);
      const first = (await startReplacement(successor)).continuation;
      expect(
        (await startReplacement(successor)).continuation.successor
          ?.workflowRunId,
      ).toBe(first.successor?.workflowRunId);
      if (first.successor === null) throw new Error("Missing successor");
      expect(
        (
          await context.client.call("inspectOwnedRuleContext", {
            workflowRunId: first.successor.workflowRunId,
          })
        ).repairCatalog,
      ).toEqual({
        source: mode === "rules" ? "stored" : "manifest",
        stages: [],
      });
      await expect(
        context.client.call("startOwnedRun", successor),
      ).rejects.toThrow("continuation admission");
    },
  );

  it("executes only the selected V2 branch and its join through the existing QuickJS worker", async () => {
    const requests: OwnedStepRequest[] = [];
    const receipts = new Map<string, OwnedStepObservationV2>();
    const { client, startWorker } = await setup({
      async execute(request) {
        expect(request).toHaveProperty("schemaVersion", 2);
        requests.push(request);
        const receipt =
          request.nodeId === "choice"
            ? controlReceipt(request)
            : terminalReceipt(
                request,
                "succeeded",
                null,
                request.nodeId === "left" ? "agent" : "host-effect",
              );
        receipts.set(request.effectId, receipt);
        return receipt;
      },
      async observe(lookup) {
        expect(lookup).toHaveProperty("schemaVersion", 2);
        const receipt = receipts.get(lookup.effectId);
        if (receipt === undefined)
          throw new Error("Observation has no admitted effect");
        return receipt;
      },
      async interrupt() {
        throw new Error("Completed graph should not interrupt work");
      },
    });
    const input = branchInput();
    input.source = `export const meta = {name: "selected", description: "Selected graph"};
      const decision = await step("choice", 0, null);
      await step(decision.selectedOutputs.includes("true") ? "left" : "right", 0, null);
      return await step("check", 0, null);`;
    const { run } = await client.call("startOwnedRun", input);
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "succeeded",
        agentCalls: 1,
        result: { available: true, value: null },
      }),
    );
    expect(requests.map((request) => request.nodeId)).toEqual([
      "choice",
      "left",
      "check",
    ]);
    expect(
      requests[2]?.dependencyReceipts.map((receipt) => receipt.nodeId),
    ).toEqual(["choice", "left"]);
  });

  it("keeps an approval waiting across pause and plugin reload without another control admission or agent slot", async () => {
    let approved = false;
    let observedWaiting = 0;
    const requests = new Map<string, OwnedStepRequest>();
    const executions: string[] = [];
    const { client, startWorker, reloadWorkflows } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        executions.push(request.nodeId);
        return request.nodeId === "choice"
          ? waitingControl(request)
          : terminalReceipt(
              request,
              "succeeded",
              null,
              request.nodeId === "left" ? "agent" : "host-effect",
            );
      },
      async observe(lookup) {
        const request = requests.get(lookup.effectId);
        if (request === undefined) throw new Error("Unknown admitted effect");
        if (request.nodeId !== "choice")
          return terminalReceipt(
            request,
            "succeeded",
            null,
            request.nodeId === "left" ? "agent" : "host-effect",
          );
        if (approved) return controlReceipt(request);
        observedWaiting += 1;
        return waitingControl(request);
      },
      async interrupt(lookup) {
        const request = requests.get(lookup.effectId);
        if (request === undefined || request.nodeId !== "choice")
          throw new Error("Only the waiting approval should be paused");
        return waitingControl(request);
      },
    });
    const input = branchInput();
    input.source = `export const meta = {name: "approval", description: "Durable approval"};
      const decision = await step("choice", 0, null);
      await step(decision.selectedOutputs.includes("true") ? "left" : "right", 0, null);
      return await step("check", 0, null);`;
    const { run } = await client.call("startOwnedRun", input);
    startWorker();
    await eventually(() => expect(observedWaiting).toBeGreaterThan(0));
    const waiting = (
      await client.call("inspectOwnedRun", { workflowRunId: run.workflowRunId })
    ).run;
    expect(waiting).toMatchObject({
      state: "running",
      agentCalls: 0,
      activeAgents: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      (
        await client.call("inspectOwnedRun", {
          workflowRunId: run.workflowRunId,
        })
      ).run.chargedActiveMs,
    ).toBe(waiting.chargedActiveMs);
    const paused = (
      await client.call("controlOwnedRun", {
        workflowRunId: run.workflowRunId,
        expectedVersion: waiting.controlVersion,
        operationId: "pause-approval",
        action: "pause",
      })
    ).run;
    expect(paused.state).toBe("paused");
    await reloadWorkflows();
    startWorker();
    const recovered = (
      await client.call("inspectOwnedRun", { workflowRunId: run.workflowRunId })
    ).run;
    expect(recovered).toMatchObject({
      state: "paused",
      agentCalls: 0,
      activeAgents: 0,
    });
    await client.call("controlOwnedRun", {
      workflowRunId: run.workflowRunId,
      expectedVersion: recovered.controlVersion,
      operationId: "resume-approval",
      action: "resume",
    });
    approved = true;
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({ state: "succeeded", agentCalls: 1 }),
    );
    expect(executions).toEqual(["choice", "left", "check"]);
    expect(requests.size).toBe(3);
  });

  it("executes parallel admitted work, fixed joins and null results through internal RPC", async () => {
    const requests = new Map<string, OwnedStepRequest>();
    const order: string[] = [];
    const { client, workflows, startWorker } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        order.push(request.nodeId);
        return terminalReceipt(request);
      },
      async observe(lookup) {
        return terminalReceipt(requests.get(lookup.effectId)!);
      },
      async interrupt(lookup) {
        return terminalReceipt(requests.get(lookup.effectId)!, "interrupted");
      },
    });
    const input = ownedRunInput({
      source: `export const meta = {name: "joined", description: "Parallel writers"}; await Promise.all([step("left",0,null),step("right",0,null)]); return await step("check",0,null);`,
      steps: [
        admittedStep("left"),
        admittedStep("right"),
        admittedStep("check", {
          dependencies: [
            { nodeId: "left", iteration: 0, requiredOutcome: "succeeded" },
            { nodeId: "right", iteration: 0, requiredOutcome: "succeeded" },
          ],
        }),
      ],
    });
    const { run } = await client.call("startOwnedRun", input);
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "succeeded",
        result: { available: true, value: null },
      }),
    );
    expect(order).toEqual(["left", "right", "check"]);
    expect(
      [...requests.values()].find((request) => request.nodeId === "check")
        ?.dependencyReceipts,
    ).toHaveLength(2);
    await expect(
      workflows.harness.callRpc("startOwnedRun", input),
    ).rejects.toThrow();
    await expect(
      workflows.harness.behavior.experimental_callInternalRpc(
        "inspectOwnedRun",
        { workflowRunId: run.workflowRunId },
        { callerPluginId: "foreign", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("another owner");
  });

  it("returns real failure receipts to QuickJS and permits only admitted repair rounds", async () => {
    const requests = new Map<string, OwnedStepRequest>();
    const observation = (request: OwnedStepRequest) =>
      terminalReceipt(
        request,
        request.nodeId === "check" && request.iteration === 0
          ? "failed"
          : "succeeded",
        request.nodeId === "check" ? { passed: request.iteration > 0 } : null,
        request.nodeId === "repair" ? "agent" : "host-effect",
      );
    const { client, workflows, startWorker } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        return observation(request);
      },
      async observe(lookup) {
        return observation(requests.get(lookup.effectId)!);
      },
      async interrupt(lookup) {
        return terminalReceipt(requests.get(lookup.effectId)!, "interrupted");
      },
    });
    const input = ownedRunInput({
      source: `export const meta = {name: "repair", description: "Bounded repair"}; try { await step("check",0,null); } catch (error) { if(error.stepFailure.state !== "failed" || error.stepFailure.receipt.passed !== false) throw error; } await step("repair",1,null); return await step("check",1,null);`,
      steps: [
        admittedStep("check"),
        admittedStep("repair", {
          iteration: 1,
          kind: "agent",
          repair: { stageId: "checks", round: 1 },
          dependencies: [
            { nodeId: "check", iteration: 0, requiredOutcome: "failed" },
          ],
        }),
        admittedStep("check", {
          iteration: 1,
          dependencies: [
            { nodeId: "repair", iteration: 1, requiredOutcome: "succeeded" },
          ],
        }),
      ],
      requiredGates: [
        {
          gateId: "verified",
          mode: "any",
          steps: [
            { nodeId: "check", iteration: 0 },
            { nodeId: "check", iteration: 1 },
          ],
        },
      ],
    });
    const { run } = await client.call("startOwnedRun", input);
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "succeeded",
        agentCalls: 1,
        repairRounds: [{ stageId: "checks", rounds: 1 }],
        result: { available: true, value: { passed: true } },
      }),
    );
  });

  it("observes prepared work, interrupts before pause completes, and resumes with a new attempt", async () => {
    const requests = new Map<string, OwnedStepRequest>();
    const interrupted = new Set<string>();
    let stopAllowed = false;
    let observed = 0;
    const running = (request: OwnedStepRequest): OwnedStepObservation => ({
      state: "running",
      resource: {
        kind: "agent",
        threadId: `thread-${request.effectId}`,
        executionContextId: `context-${request.effectId}`,
        environmentId: null,
        turnRequestId: null,
      },
    });
    const { client, workflows, startWorker } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        return request.attempt === 1
          ? running(request)
          : terminalReceipt(request, "succeeded", null, "agent");
      },
      async observe(lookup) {
        observed++;
        const request = requests.get(lookup.effectId)!;
        return interrupted.has(lookup.effectId)
          ? terminalReceipt(request, "interrupted", null, "agent")
          : request.attempt === 1
            ? running(request)
            : terminalReceipt(request, "succeeded", null, "agent");
      },
      async interrupt(lookup) {
        if (!stopAllowed)
          return {
            state: "needs-reconciliation",
            reason: "Native stop is still pending",
          };
        interrupted.add(lookup.effectId);
        return terminalReceipt(
          requests.get(lookup.effectId)!,
          "interrupted",
          null,
          "agent",
        );
      },
    });
    const { run } = await client.call(
      "startOwnedRun",
      ownedRunInput({ steps: [admittedStep("check", { kind: "agent" })] }),
    );
    startWorker();
    await eventually(() => expect(requests.size).toBe(1));
    await eventually(() => expect(observed).toBeGreaterThan(0));
    const paused = await client.call("controlOwnedRun", {
      workflowRunId: run.workflowRunId,
      operationId: "pause",
      expectedVersion: 0,
      action: "pause",
    });
    expect(paused.run.state).toBe("pausing");
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run.state,
      ).toBe("needs-reconciliation"),
    );
    expect(requests.size).toBe(1);
    await expect(
      client.call("controlOwnedRun", {
        workflowRunId: run.workflowRunId,
        operationId: "early-resume",
        expectedVersion: 1,
        action: "resume",
      }),
    ).rejects.toThrow("Reconcile");
    stopAllowed = true;
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run.state,
      ).toBe("paused"),
    );
    await client.call("controlOwnedRun", {
      workflowRunId: run.workflowRunId,
      operationId: "resume",
      expectedVersion: 1,
      action: "resume",
    });
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({ state: "succeeded", agentCalls: 2 }),
    );
    expect([...requests.values()].map((request) => request.attempt)).toEqual([
      1, 2,
    ]);
  });

  it("holds a run when a terminal receipt cannot be revalidated instead of accepting historical success", async () => {
    let executions = 0;
    const { client, workflows, startWorker } = await setup({
      async execute(request) {
        executions++;
        return terminalReceipt(request);
      },
      async observe() {
        throw new Error("Host disconnected before final validity check");
      },
      async interrupt() {
        return { state: "needs-reconciliation", reason: "Host disconnected" };
      },
    });
    const { run } = await client.call("startOwnedRun", ownedRunInput());
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "needs-reconciliation",
        desiredControl: "pause",
        result: { available: false },
      }),
    );
    expect(executions).toBe(1);
  });

  it("aborts advancing observations on pause and does not replay an old pause into a resumed generation", async () => {
    const requests = new Map<string, OwnedStepRequest>();
    const interrupted = new Set<string>();
    let releasePreflight = () => {};
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let observing = false;
    let releasedFirstTurns = 0;
    let completeSecond = false;
    const running = (request: OwnedStepRequest): OwnedStepObservation => ({
      state: "running",
      resource: {
        kind: "agent",
        threadId: `thread-${request.effectId}`,
        executionContextId: `context-${request.effectId}`,
        environmentId: null,
        turnRequestId: null,
      },
    });
    const { client, startWorker } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        return running(request);
      },
      async observe(lookup, signal) {
        const request = requests.get(lookup.effectId)!;
        if (interrupted.has(lookup.effectId))
          return terminalReceipt(request, "interrupted", null, "agent");
        if (request.attempt === 1) {
          observing = true;
          await preflight;
          signal.throwIfAborted();
          releasedFirstTurns++;
        }
        return completeSecond && request.attempt > 1
          ? terminalReceipt(request, "succeeded", null, "agent")
          : running(request);
      },
      async interrupt(lookup) {
        interrupted.add(lookup.effectId);
        return terminalReceipt(
          requests.get(lookup.effectId)!,
          "interrupted",
          null,
          "agent",
        );
      },
    });
    const { run } = await client.call(
      "startOwnedRun",
      ownedRunInput({ steps: [admittedStep("check", { kind: "agent" })] }),
    );
    startWorker();
    await eventually(() => expect(observing).toBe(true));
    const pause = {
      workflowRunId: run.workflowRunId,
      operationId: "pause-preflight",
      expectedVersion: 0,
      action: "pause" as const,
    };
    const pauseReceipt = await client.call("controlOwnedRun", pause);
    releasePreflight();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run.state,
      ).toBe("paused"),
    );
    expect(releasedFirstTurns).toBe(0);
    await client.call("controlOwnedRun", {
      workflowRunId: run.workflowRunId,
      operationId: "resume-preflight",
      expectedVersion: 1,
      action: "resume",
    });
    await eventually(() => expect(requests.size).toBe(2));
    expect(await client.call("controlOwnedRun", pause)).toEqual(pauseReceipt);
    expect(
      (
        await client.call("inspectOwnedRun", {
          workflowRunId: run.workflowRunId,
        })
      ).run.desiredControl,
    ).toBe("run");
    completeSecond = true;
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run.state,
      ).toBe("succeeded"),
    );
    expect(interrupted.size).toBe(1);
  });

  it("does not allow scripts to skip the required final gate or bypass step admission", async () => {
    let executions = 0;
    const { client, workflows, startWorker } = await setup({
      async execute(request) {
        executions++;
        return terminalReceipt(request);
      },
      async observe() {
        throw new Error("No effect exists");
      },
      async interrupt() {
        return { state: "not-started", reason: null };
      },
    });
    const skipped = await client.call(
      "startOwnedRun",
      ownedRunInput({
        source: `export const meta={name:"skip",description:"Invalid return"};return null;`,
      }),
    );
    const bypass = await client.call(
      "startOwnedRun",
      ownedRunInput({
        ownerRunId: "bypass",
        source: `export const meta={name:"bypass",description:"Invalid call"};return await agent("write anything");`,
      }),
    );
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: skipped.run.workflowRunId,
          })
        ).run,
      ).toMatchObject({ state: "failed", result: { available: false } }),
    );
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: bypass.run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "failed",
        error: expect.stringContaining("admitted step"),
      }),
    );
    expect(executions).toBe(0);
  });

  it("reopens the real ledger after reload and observes the existing native attempt before replay", async () => {
    const requests = new Map<string, OwnedStepRequest>();
    let completed = false;
    let observations = 0;
    const { client, startWorker, reloadWorkflows } = await setup({
      async execute(request) {
        requests.set(request.effectId, request);
        return {
          state: "running",
          resource: {
            kind: "agent",
            threadId: `thread-${request.effectId}`,
            executionContextId: `context-${request.effectId}`,
            environmentId: "environment-1",
            turnRequestId: `turn-${request.effectId}`,
          },
        };
      },
      async observe(lookup) {
        observations++;
        const request = requests.get(lookup.effectId)!;
        return completed
          ? terminalReceipt(request, "succeeded", null, "agent")
          : {
              state: "running",
              resource: {
                kind: "agent",
                threadId: `thread-${request.effectId}`,
                executionContextId: `context-${request.effectId}`,
                environmentId: "environment-1",
                turnRequestId: `turn-${request.effectId}`,
              },
            };
      },
      async interrupt() {
        return {
          state: "needs-reconciliation",
          reason: "Not requested by this run",
        };
      },
    });
    const { run } = await client.call(
      "startOwnedRun",
      ownedRunInput({ steps: [admittedStep("check", { kind: "agent" })] }),
    );
    startWorker();
    await eventually(() => expect(requests.size).toBe(1));
    const initial = (
      await client.call("inspectOwnedRun", { workflowRunId: run.workflowRunId })
    ).run;
    await reloadWorkflows();
    const recovered = (
      await client.call("inspectOwnedRun", { workflowRunId: run.workflowRunId })
    ).run;
    expect(recovered).toMatchObject({
      state: "needs-reconciliation",
      agentCalls: 1,
    });
    expect(recovered.dispatchGeneration).toBeGreaterThan(
      initial.dispatchGeneration,
    );
    completed = true;
    startWorker();
    await eventually(async () =>
      expect(
        (
          await client.call("inspectOwnedRun", {
            workflowRunId: run.workflowRunId,
          })
        ).run,
      ).toMatchObject({
        state: "succeeded",
        agentCalls: 1,
        result: { available: true, value: null },
      }),
    );
    expect(requests.size).toBe(1);
    expect(observations).toBeGreaterThan(0);
  });
});

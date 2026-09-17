import { describe, expect, it } from "vitest";
import { compileArcRun, runtimeNodeKey } from "./compiler.js";
import { runDefinitionFixture } from "./testing.js";
import { runtimeHash } from "./hash.js";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";

describe("ARC immutable run compilation", () => {
  async function executePlan(options: {
    failedChecks: number;
    failedWriter?: boolean;
    rejectReview?: boolean;
    interruptedCheck?: boolean;
  }) {
    const compiled = compileArcRun(runDefinitionFixture());
    const dispatched: string[] = [];
    const result = executeWorkflowScript({
      args: compiled.workflow.args,
      body: parseWorkflowSource(compiled.workflow.source).body,
      capabilities: {
        agent: async () => {
          throw new Error("Unadmitted agent bypass");
        },
        async step(nodeId, iteration) {
          dispatched.push(`${nodeId}:${iteration}`);
          if (options.failedWriter && nodeId === "writer-1")
            throw new Error("Writer failed");
          if (nodeId === "check" && iteration < options.failedChecks) {
            const failure = {
              workflowRunId: "workflow-a",
              ownerRunId: compiled.definition.runId,
              nodeId,
              iteration,
              attempt: 1,
              effectId: `check-${iteration}`,
              requestHash: "a".repeat(64),
              state: options.interruptedCheck ? "interrupted" : "failed",
              receipt: { exitCode: 1 },
              receiptHash: "b".repeat(64),
            };
            throw Object.assign(new Error("Required check failed"), {
              stepFailure: failure,
            });
          }
          if (nodeId === "review" && options.rejectReview)
            throw new Error("Review rejected");
          return null;
        },
        log() {},
        phase() {},
      },
    });
    return { result, dispatched };
  }

  it("runs the actual compiled QuickJS program through check repair and accepts successful null", async () => {
    const { result, dispatched } = await executePlan({ failedChecks: 2 });
    await expect(result).resolves.toBeNull();
    expect(dispatched.filter((key) => key.startsWith("repair:"))).toEqual([
      "repair:1",
      "repair:2",
    ]);
    expect(dispatched).toContain("verify:2");
    expect(dispatched).not.toContain("check:3");
    expect(dispatched.indexOf("integrate-1:0")).toBeGreaterThan(
      dispatched.indexOf("writer-1-commit:0"),
    );
  });

  it("stops the compiled program after its third repair without dispatching review", async () => {
    const { result, dispatched } = await executePlan({ failedChecks: 4 });
    await expect(result).rejects.toThrow();
    expect(dispatched.filter((key) => key.startsWith("repair:"))).toEqual([
      "repair:1",
      "repair:2",
      "repair:3",
    ]);
    expect(
      dispatched.some(
        (key) => key.startsWith("review:") || key.startsWith("verify:"),
      ),
    ).toBe(false);
  });

  it("does not integrate a failed writer or treat interruption and rejected review as check repair", async () => {
    for (const options of [
      { failedChecks: 0, failedWriter: true },
      { failedChecks: 1, interruptedCheck: true },
      { failedChecks: 0, rejectReview: true },
    ]) {
      const { result, dispatched } = await executePlan(options);
      await expect(result).rejects.toThrow();
      expect(
        dispatched.some(
          (key) => key.startsWith("repair:") || key.startsWith("verify:"),
        ),
      ).toBe(false);
      if ("failedWriter" in options)
        expect(dispatched).not.toContain("integration-workspace:0");
    }
  });
  it("requires every writer and serial integration before any final verification", () => {
    const compiled = compileArcRun(runDefinitionFixture());
    const steps = compiled.workflow.steps;
    const join = steps.find((step) => step.nodeId === "integration-workspace")!;
    expect(join.dependencies).toEqual([
      { nodeId: "writer-0-commit", iteration: 0, requiredOutcome: "succeeded" },
      { nodeId: "writer-1-commit", iteration: 0, requiredOutcome: "succeeded" },
    ]);
    expect(
      steps.find((step) => step.nodeId === "integrate-1")!.dependencies,
    ).toContainEqual({
      nodeId: "integrate-0",
      iteration: 0,
      requiredOutcome: "succeeded",
    });
    expect(
      steps.find((step) => step.nodeId === "check" && step.iteration === 0)!
        .dependencies,
    ).toEqual([
      { nodeId: "integrate-1", iteration: 0, requiredOutcome: "succeeded" },
    ]);
    for (const gate of compiled.workflow.requiredGates[0].steps) {
      const verify = steps.find(
        (step) => runtimeNodeKey(step) === runtimeNodeKey(gate),
      )!;
      expect(verify.dependencies).toEqual([
        {
          nodeId: "check",
          iteration: gate.iteration,
          requiredOutcome: "succeeded",
        },
        {
          nodeId: "review",
          iteration: gate.iteration,
          requiredOutcome: "succeeded",
        },
      ]);
    }
  });

  it("unfolds exactly three failure-admitted repairs with one integration lane", () => {
    const { workflow } = compileArcRun(runDefinitionFixture());
    const repairs = workflow.steps.filter((step) => step.nodeId === "repair");
    expect(repairs.map((step) => step.iteration)).toEqual([1, 2, 3]);
    expect(
      repairs.every(
        (step) => step.dependencies[0].requiredOutcome === "failed",
      ),
    ).toBe(true);
    expect(repairs.map((step) => step.repair)).toEqual(
      [1, 2, 3].map((round) => ({ stageId: "integrated-check", round })),
    );
    const lanes = workflow.steps
      .filter((step) =>
        [
          "integrate-0",
          "integrate-1",
          "repair-commit",
          "check",
          "verify",
        ].includes(step.nodeId),
      )
      .map((step) => JSON.stringify(step.lane));
    expect(new Set(lanes).size).toBe(1);
    expect(workflow.limits).toEqual({
      maxConcurrentAgents: 4,
      maxAgentCalls: 100,
      maxRepairRounds: 3,
      maxActiveMs: 7_200_000,
    });
  });

  it("keeps user text out of executable source and pins operational identities in node hashes", () => {
    const definition = runDefinitionFixture();
    definition.request.writers[0].task = '"}); malicious(); //';
    const before = compileArcRun(definition);
    expect(before.workflow.source).not.toContain("malicious");
    const after = compileArcRun({
      ...definition,
      request: {
        ...definition.request,
        check: { ...definition.request.check, args: ["weakened-check.mjs"] },
      },
    });
    expect(before.workflow.planHash).not.toBe(after.workflow.planHash);
    const check = before.workflow.steps.find(
      (step) => step.nodeId === "check",
    )!;
    expect(check.definitionHash).toBe(
      runtimeHash(before.nodes[runtimeNodeKey(check)]),
    );
    expect(check.definitionHash).not.toBe(
      after.workflow.steps.find((step) => step.nodeId === "check")!
        .definitionHash,
    );
  });
});

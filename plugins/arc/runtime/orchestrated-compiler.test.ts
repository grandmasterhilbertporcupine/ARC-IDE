import { afterEach, describe, expect, it } from "vitest";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import {
  createOrchestratedTestRun,
  orchestratedDefinitionFixture,
} from "./orchestrated-testing.js";
import { orchestratedGraphOutcome } from "./orchestrated-outcome.js";
import { teamEdge } from "../teams/testing.js";

const runs: ReturnType<typeof createOrchestratedTestRun>[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.db.close();
});
function setup(definition = orchestratedDefinitionFixture()) {
  const run = createOrchestratedTestRun(definition);
  runs.push(run);
  return run;
}

describe("admitted main response compiler", () => {
  it.each([false, true])(
    "settles the selected branch and join before reporting (failed check: %s)",
    async (failedCheck) => {
      const definition = orchestratedDefinitionFixture((team) => {
        team.graph.nodes.push(
          {
            id: "condition",
            label: "Check outcome",
            kind: "condition",
            predicate: {
              kind: "check-exit",
              sourceNodeId: "check",
              operator: "eq",
              value: 0,
            },
          },
          ...["yes", "no"].map((id) => ({
            id,
            label: id,
            kind: "agent" as const,
            memberId: "builder",
            task: "Inspect selected evidence",
            access: "read" as const,
            candidate: { kind: "node" as const, nodeId: "write" },
          })),
          {
            id: "selected",
            label: "Selected path",
            kind: "join",
            mode: "selected",
            decisionNodeId: "condition",
          },
        );
        team.graph.edges = [
          teamEdge("write", "check"),
          teamEdge("check", "condition", "completed"),
          teamEdge("condition", "yes", "succeeded", "true"),
          teamEdge("condition", "no", "succeeded", "false"),
          teamEdge("yes", "selected"),
          teamEdge("no", "selected"),
          teamEdge("selected", "review"),
        ];
      });
      const run = setup(definition);
      if (failedCheck)
        await expect(run.execute({ failedCheck })).rejects.toThrow(
          "Required gate did not succeed",
        );
      else await run.execute();
      const effects = run.store.completionEffects(definition.runId);
      const activeReaders = effects.filter((effect) => {
        const node =
          run.compiled.nodes[
            `${effect.request.nodeId}:${effect.request.iteration}`
          ];
        return node.kind === "agent" && node.purpose === "reader";
      });
      expect(activeReaders).toHaveLength(1);
      expect(run.view().agentCalls).toBe(4);
      expect(orchestratedGraphOutcome(run.compiled, effects)).toMatchObject({
        state: "settled",
        outcome: failedCheck ? "failed" : "succeeded",
      });
    },
  );
  it("preserves V2 graph bytes and adds exactly one counted final turn", async () => {
    const definition = orchestratedDefinitionFixture();
    const { completion: _completion, ...base } = definition;
    const { invocation: _invocation, ...request } = definition.request;
    const graph = { ...base, schemaVersion: 2 as const, request };
    const before = JSON.stringify(compileArcGraphRun(graph));
    const run = setup(definition);
    expect(JSON.stringify(compileArcGraphRun(graph))).toBe(before);
    expect(
      run.compiled.workflow.steps.filter((step) => step.kind === "agent"),
    ).toHaveLength(3);
    expect(run.compiled.workflow.limits).toEqual(definition.policy.limits);
    await run.execute();
    expect(run.dispatched.at(-1)).toBe("orchestrator");
    expect(
      run.dispatched.filter((kind) => kind === "orchestrator"),
    ).toHaveLength(1);
    expect(run.view().agentCalls).toBe(3);
    expect(
      orchestratedGraphOutcome(
        run.compiled,
        run.store.completionEffects(definition.runId),
      ),
    ).toMatchObject({ state: "settled", outcome: "succeeded" });
  });
  it("waits for the actual required work before admitting the response", async () => {
    const run = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const reachedCheck = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const executing = run.execute({
      before: async (kind) => {
        if (kind === "check") {
          reached();
          await held;
        }
      },
    });
    await reachedCheck;
    expect(run.dispatched).not.toContain("orchestrator");
    expect(
      orchestratedGraphOutcome(
        run.compiled,
        run.store.completionEffects(run.compiled.definition.runId),
      ).state,
    ).toBe("pending");
    release();
    await executing;
    expect(run.dispatched.at(-1)).toBe("orchestrator");
  });
  it("reports a settled failed check once while preserving the failed run result", async () => {
    const run = setup();
    await expect(run.execute({ failedCheck: true })).rejects.toThrow(
      "Required gate did not succeed",
    );
    expect(
      run.dispatched.filter((kind) => kind === "orchestrator"),
    ).toHaveLength(1);
    expect(run.view().agentCalls).toBe(2);
    expect(
      orchestratedGraphOutcome(
        run.compiled,
        run.store.completionEffects(run.compiled.definition.runId),
      ),
    ).toMatchObject({ state: "settled", outcome: "failed" });
  });
  it("reports a declined plan without dispatching the team workers", async () => {
    const definition = orchestratedDefinitionFixture();
    definition.policy.autonomy = "collaborative";
    const run = setup(definition);
    await expect(run.execute({ rejectApproval: true })).rejects.toThrow(
      "Required gate did not succeed",
    );
    expect(run.dispatched).not.toContain("agent");
    expect(
      run.dispatched.filter((kind) => kind === "orchestrator"),
    ).toHaveLength(1);
    expect(run.view().agentCalls).toBe(1);
  });
  it("does not turn interruption into an automatic response", async () => {
    const run = setup();
    await expect(run.execute({ interruptedCheck: true })).rejects.toThrow();
    expect(run.dispatched).not.toContain("orchestrator");
    expect(
      orchestratedGraphOutcome(
        run.compiled,
        run.store.completionEffects(run.compiled.definition.runId),
      ).state,
    ).toBe("unavailable");
  });
  it("does not reset the run budget to deliver the main response", async () => {
    const definition = orchestratedDefinitionFixture();
    definition.policy.limits.maxAgentCalls = 2;
    const run = setup(definition);
    await expect(run.execute()).rejects.toThrow("agent-call limit exhausted");
    expect(run.dispatched).not.toContain("orchestrator");
    expect(run.view().agentCalls).toBe(2);
  });
  it("retains a distinct actual main directory but rejects another conversation or host", () => {
    const definition = orchestratedDefinitionFixture();
    definition.completion.environment.path += "/parent-worktree";
    expect(
      compileArcOrchestratedRun(definition).definition.completion.environment
        .path,
    ).toBe(definition.completion.environment.path);
    definition.completion.threadId = "other-main";
    expect(() => compileArcOrchestratedRun(definition)).toThrow(
      "originating conversation",
    );
    definition.completion.threadId = definition.request.originThreadId;
    definition.completion.environment.hostId = "other-host";
    expect(() => compileArcOrchestratedRun(definition)).toThrow(
      "originating conversation",
    );
  });
});

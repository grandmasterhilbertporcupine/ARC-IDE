import { describe, expect, it, vi } from "vitest";
import type { OwnedStepRef } from "bb-plugin-workflows/owned-contract";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";
import type { TeamDefinition } from "../teams/contract.js";
import { teamEdge } from "../teams/testing.js";
import { teamHashes } from "../teams/validation.js";
import { compileArcRun, runtimeNodeKey } from "./compiler.js";
import { compileArcGraphRun, type CompiledGraphRun } from "./graph-compiler.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import {
  graphRuntimeNodeSchema,
  type GraphRuntimeNode,
} from "./graph-contract.js";
import { runtimeHash } from "./hash.js";
import { runDefinitionFixture } from "./testing.js";

type Result = { state: "succeeded" | "failed"; selectedOutputs: string[] };

function executeGraph(
  compiled: CompiledGraphRun,
  options: {
    failedChecks?: number;
    interruptedCheck?: boolean;
    rejectApproval?: boolean;
    assignments?: string[];
    before?: (node: GraphRuntimeNode) => Promise<void>;
  } = {},
) {
  const dispatched: Array<{ key: string; node: GraphRuntimeNode }> = [];
  const results = new Map<string, Result>();
  let checkCount = 0;
  const get = (ref: OwnedStepRef) => {
    const result = results.get(runtimeNodeKey(ref));
    if (!result)
      throw new Error(`Unadmitted dependency ${runtimeNodeKey(ref)}`);
    return result;
  };
  const result = executeWorkflowScript({
    args: compiled.workflow.args,
    body: parseWorkflowSource(compiled.workflow.source).body,
    capabilities: {
      agent: async () => {
        throw new Error("Unadmitted provider dispatch");
      },
      async step(nodeId, iteration) {
        const key = runtimeNodeKey({ nodeId, iteration });
        const node = compiled.nodes[key];
        if (!node) throw new Error(`Unknown admitted node ${key}`);
        dispatched.push({ key, node });
        await options.before?.(node);
        let state: Result["state"] = "succeeded";
        let selectedOutputs: string[] = [];
        if (node.kind === "check") {
          if (checkCount++ < (options.failedChecks ?? 0)) state = "failed";
        } else if (node.kind === "control") {
          const operation = node.operation;
          switch (operation.type) {
            case "barrier":
              selectedOutputs = ["next"];
              break;
            case "approval":
              state = options.rejectApproval ? "failed" : "succeeded";
              selectedOutputs = [
                options.rejectApproval ? "rejected" : "approved",
              ];
              break;
            case "condition": {
              const predicate = operation.predicate;
              const source = get(predicate.source);
              const value =
                predicate.kind === "outcome"
                  ? source.state === predicate.equals
                  : predicate.kind === "check-exit"
                    ? (predicate.operator === "eq") ===
                      ((source.state === "succeeded" ? 0 : 1) ===
                        predicate.value)
                    : predicate.kind === "approval"
                      ? source.selectedOutputs.includes(predicate.equals)
                      : source.state ===
                        (predicate.equals === "approved"
                          ? "succeeded"
                          : "failed");
              selectedOutputs = [String(value)];
              break;
            }
            case "repair-result": {
              const current = get(operation.check);
              state =
                current.state === "succeeded"
                  ? "succeeded"
                  : operation.next === null
                    ? "failed"
                    : get(operation.next).state;
              selectedOutputs = [
                state === "succeeded" ? "repaired" : "exhausted",
              ];
              break;
            }
            case "delegation":
              selectedOutputs = ["next"];
              break;
            case "delegation-slot":
              selectedOutputs = [
                options.assignments?.[operation.slot]
                  ? `member:${options.assignments[operation.slot]}`
                  : "skip",
              ];
              break;
            case "candidate-choice": {
              const selected = get(operation.decision).selectedOutputs;
              const branch = operation.branches.find((branch) =>
                selected.includes(branch.output),
              );
              if (!branch) throw new Error("No selected candidate");
              get(branch.candidate);
              selectedOutputs = ["next"];
              break;
            }
          }
        }
        results.set(key, { state, selectedOutputs });
        const receipt =
          node.kind === "control"
            ? { revision: 0, selectedOutputs, data: null }
            : null;
        if (state === "failed")
          throw Object.assign(new Error("Recorded step failed"), {
            stepFailure: {
              workflowRunId: "workflow-test",
              ownerRunId: compiled.definition.runId,
              nodeId,
              iteration,
              attempt: 1,
              effectId: key,
              requestHash: "a".repeat(64),
              state:
                options.interruptedCheck && node.kind === "check"
                  ? "interrupted"
                  : "failed",
              receipt,
              receiptHash: runtimeHash(receipt),
            },
          });
        return receipt;
      },
      log() {},
      phase() {},
    },
  });
  return { result, dispatched, results };
}

function conditionalTeam(team: TeamDefinition) {
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
      task: "Inspect the selected check outcome",
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
}

function repairTeam(team: TeamDefinition) {
  const review = team.graph.nodes.find((node) => node.kind === "review");
  if (review?.kind !== "review") throw new Error("Missing fixture review");
  review.candidate = { kind: "node", nodeId: "repair" };
  team.graph.nodes.push({
    id: "repair",
    label: "Repair failed check",
    kind: "repair",
    body: { memberId: "builder", task: "Repair the failing check" },
    checkNodeId: "check",
    maxRounds: 3,
  });
  team.graph.edges = [
    teamEdge("write", "check"),
    teamEdge("check", "repair", "failed"),
    teamEdge("repair", "review", "succeeded", "repaired"),
  ];
  team.graph.requiredGates = [
    { id: "verified", mode: "all", nodeIds: ["repair", "review"] },
  ];
}

describe("ARC published graph compilation", () => {
  it("holds all work behind the Collaborative plan decision and dispatches each admitted step only once", async () => {
    const compiled = compileArcGraphRun(graphRunDefinitionFixture());
    let approve: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const run = executeGraph(compiled, {
      before: async (node) => {
        if (node.kind === "control" && node.operation.type === "approval")
          await wait;
      },
    });
    await vi.waitFor(() => expect(run.dispatched).toHaveLength(1));
    expect(run.dispatched[0].node).toMatchObject({
      kind: "control",
      operation: { type: "approval", candidate: null },
    });
    approve();
    await expect(run.result).resolves.toEqual({
      requiredGates: ["team:verification", "arc:final-candidate"],
    });
    expect(new Set(run.dispatched.map(({ key }) => key)).size).toBe(
      run.dispatched.length,
    );
    expect(
      run.dispatched.filter(({ node }) => node.kind === "agent"),
    ).toHaveLength(2);
    expect(run.dispatched.at(-1)?.node.kind).toBe("verify");
  });

  it("honors Guided refusal without dispatching a worker and adds no implicit autonomous approvals", async () => {
    const definition = graphRunDefinitionFixture();
    definition.policy.autonomy = "guided";
    const compiled = compileArcGraphRun(definition);
    const run = executeGraph(compiled, { rejectApproval: true });
    await expect(run.result).rejects.toThrow();
    expect(run.dispatched.some(({ node }) => node.kind === "agent")).toBe(
      false,
    );
    expect(
      Object.values(compiled.nodes).filter(
        (node) => node.kind === "control" && node.operation.type === "approval",
      ),
    ).toHaveLength(2);
    definition.policy.autonomy = "autonomous";
    expect(
      Object.values(compileArcGraphRun(definition).nodes).some(
        (node) => node.kind === "control",
      ),
    ).toBe(false);
  });

  it.each([0, 1])(
    "dispatches only the selected condition path and reconciles its join for comparison %s",
    async (value) => {
      const definition = graphRunDefinitionFixture(conditionalTeam);
      const condition = definition.team.definition.graph.nodes.find(
        (node) => node.kind === "condition",
      );
      if (
        condition?.kind !== "condition" ||
        condition.predicate.kind !== "check-exit"
      )
        throw new Error("Missing fixture condition");
      condition.predicate.value = value;
      Object.assign(definition.team, teamHashes(definition.team.definition));
      const compiled = compileArcGraphRun(definition);
      const run = executeGraph(compiled);
      await expect(run.result).resolves.toBeDefined();
      const origins = run.dispatched.map(
        ({ key }) => compiled.references.origins[key].graphNodeId,
      );
      expect(origins).toContain(value === 0 ? "yes" : "no");
      expect(origins).not.toContain(value === 0 ? "no" : "yes");
      expect(origins.indexOf("selected")).toBeGreaterThan(
        origins.lastIndexOf(value === 0 ? "yes" : "no"),
      );
      expect(origins).toContain("review");
    },
  );

  it("unfolds failure-admitted repair and forwards only the repaired exact candidate to final verification", async () => {
    const compiled = compileArcGraphRun(graphRunDefinitionFixture(repairTeam));
    const run = executeGraph(compiled, { failedChecks: 2 });
    await expect(run.result).resolves.toBeDefined();
    const repairs = run.dispatched.filter(
      ({ node }) => node.kind === "agent" && node.purpose === "repair",
    );
    expect(repairs).toHaveLength(2);
    for (const { node } of repairs) {
      if (node.kind !== "agent") throw new Error("Missing repair worker");
      expect(node.workspace).toEqual(node.candidate);
      expect(compiled.nodes[runtimeNodeKey(node.candidate)].kind).toBe(
        "fork-worktree",
      );
    }
    expect(
      run.dispatched.filter(({ node }) => node.kind === "check"),
    ).toHaveLength(3);
    const final = compiled.references.finalGates[0];
    expect(final.candidate).toEqual(
      compiled.references.outputs.repair.candidate,
    );
    expect(final.check).toEqual(compiled.references.outputs.repair.outcome);
    expect(run.dispatched.at(-1)?.node.kind).toBe("verify");
  });

  it.each([0, 3])(
    "stops exhausted repair at the resolved %s round budget",
    async (limit) => {
      const definition = graphRunDefinitionFixture(repairTeam);
      definition.policy.limits.maxRepairRounds = limit;
      const compiled = compileArcGraphRun(definition);
      const run = executeGraph(compiled, { failedChecks: 10 });
      await expect(run.result).rejects.toThrow();
      expect(
        run.dispatched.filter(
          ({ node }) => node.kind === "agent" && node.purpose === "repair",
        ),
      ).toHaveLength(limit);
      expect(
        run.dispatched.some(
          ({ node }) =>
            node.kind === "verify" ||
            (node.kind === "agent" && node.purpose === "review"),
        ),
      ).toBe(false);
    },
  );

  it("never treats an interrupted check as a repairable failure", async () => {
    const compiled = compileArcGraphRun(graphRunDefinitionFixture(repairTeam));
    const run = executeGraph(compiled, {
      failedChecks: 1,
      interruptedCheck: true,
    });
    await expect(run.result).rejects.toThrow();
    expect(
      run.dispatched.some(
        ({ node }) => node.kind === "agent" && node.purpose === "repair",
      ),
    ).toBe(false);
  });

  it.each([0, 1])(
    "keeps the original-versus-repaired final candidate alternative valid after %s failed checks",
    async (failedChecks) => {
      const definition = graphRunDefinitionFixture((team) => {
        repairTeam(team);
        team.graph.nodes.push({
          id: "original-review",
          label: "Review original successful candidate",
          kind: "review",
          memberId: "builder",
          task: "Review the original candidate only after its check succeeds",
          candidate: { kind: "node", nodeId: "write" },
        });
        team.graph.edges.push(teamEdge("check", "original-review"));
        team.graph.requiredGates = [
          {
            id: "reviewed",
            mode: "any",
            nodeIds: ["review", "original-review"],
          },
        ];
      });
      const compiled = compileArcGraphRun(definition);
      expect(compiled.references.finalGates).toHaveLength(2);
      const run = executeGraph(compiled, { failedChecks });
      await expect(run.result).resolves.toBeDefined();
      const verifies = run.dispatched.filter(
        ({ node }) => node.kind === "verify",
      );
      expect(verifies).toHaveLength(1);
      expect(compiled.references.origins[verifies[0].key].graphNodeId).toBe(
        failedChecks === 0 ? "original-review" : "review",
      );
    },
  );

  it("rejects final verification of a candidate that omits an active repaired descendant", () => {
    const definition = graphRunDefinitionFixture((team) => {
      repairTeam(team);
      const review = team.graph.nodes.find((node) => node.kind === "review");
      if (review?.kind !== "review") throw new Error("Missing review");
      review.candidate = { kind: "node", nodeId: "write" };
      team.graph.nodes.push({
        id: "old-check",
        label: "Check old candidate again",
        kind: "check",
        candidate: { kind: "node", nodeId: "write" },
        command: {
          executable: "node",
          args: ["other-check.mjs"],
          timeoutMs: 60000,
        },
      });
      team.graph.edges = [
        teamEdge("write", "check"),
        teamEdge("check", "repair", "failed"),
        teamEdge("repair", "old-check", "succeeded", "repaired"),
        teamEdge("old-check", "review"),
      ];
      team.graph.requiredGates = [
        { id: "reviewed", mode: "all", nodeIds: ["old-check", "review"] },
      ];
    });
    expect(() => compileArcGraphRun(definition)).toThrow(
      "final candidate containing every selected writing stage",
    );
  });

  it("admits both independent writers before serial integration with preserved candidate workspaces", async () => {
    const definition = graphRunDefinitionFixture((team) => {
      team.graph.nodes.push(
        {
          id: "second",
          label: "Second writer",
          kind: "agent",
          memberId: "builder",
          task: "Build a separate component",
          access: "write",
          candidate: { kind: "source" },
        },
        {
          id: "integrate",
          label: "Integrate",
          kind: "integration",
          writerNodeIds: ["write", "second"],
          baseCandidate: { kind: "source" },
        },
      );
      for (const node of team.graph.nodes)
        if (node.kind === "review" || node.kind === "check")
          node.candidate = { kind: "node", nodeId: "integrate" };
      team.graph.entryNodeIds = ["write", "second"];
      team.graph.edges = [
        teamEdge("write", "integrate"),
        teamEdge("second", "integrate"),
        teamEdge("integrate", "check"),
        teamEdge("check", "review"),
      ];
    });
    const compiled = compileArcGraphRun(definition);
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = executeGraph(compiled, {
      before: async (node) => {
        if (node.kind === "agent" && node.purpose === "writer") await wait;
      },
    });
    await vi.waitFor(() =>
      expect(
        run.dispatched.filter(({ node }) => node.kind === "agent"),
      ).toHaveLength(2),
    );
    expect(run.dispatched.some(({ node }) => node.kind === "integrate")).toBe(
      false,
    );
    release();
    await expect(run.result).resolves.toBeDefined();
    const merges = run.dispatched.filter(
      ({ node }) => node.kind === "integrate",
    );
    expect(merges).toHaveLength(2);
    const [first, second] = merges.map(({ node }) => node);
    if (first.kind !== "integrate" || second.kind !== "integrate")
      throw new Error("Missing integration");
    expect(first.workspace).not.toEqual(second.workspace);
    expect(compiled.nodes[runtimeNodeKey(second.workspace)]).toMatchObject({
      kind: "fork-worktree",
      candidate: { nodeId: merges[0].key.split(":")[0], iteration: 0 },
    });
  });

  it("counts the delegation requester and dispatches only assigned members and slots", async () => {
    const definition = graphRunDefinitionFixture((team) => {
      for (const id of ["alice", "bob"]) {
        team.members.push({ ...team.members[0], id });
        team.permissions.push({
          id: `grant-${id}`,
          action: "delegate",
          fromMemberId: "builder",
          toMemberId: id,
        });
      }
      team.graph.nodes = team.graph.nodes.filter((node) => node.id !== "write");
      team.graph.nodes.push({
        id: "write",
        label: "Delegate work",
        kind: "delegation",
        requesterMemberId: "builder",
        candidateMemberIds: ["alice", "bob"],
        maxChildCalls: 3,
        task: "Implement the requested change",
        access: "write",
        candidate: { kind: "source" },
      });
    });
    expect(() => compileArcGraphRun(definition)).toThrow(/review work by/);
    for (const id of ["alice", "bob"])
      definition.team.definition.permissions.push({
        id: `review-${id}`,
        action: "review",
        fromMemberId: "builder",
        toMemberId: id,
      });
    Object.assign(definition.team, teamHashes(definition.team.definition));
    const compiled = compileArcGraphRun(definition);
    const run = executeGraph(compiled, { assignments: ["bob"] });
    await expect(run.result).resolves.toBeDefined();
    const agents = run.dispatched.flatMap(({ node }) =>
      node.kind === "agent" ? [node] : [],
    );
    expect(agents.map((node) => [node.purpose, node.memberId])).toEqual([
      ["delegation", "builder"],
      ["writer", "bob"],
      ["review", "builder"],
    ]);
    const requester = agents[0];
    expect(requester.access).toBe("read");
    expect(requester.delegationPoint).toBe("write");
    expect(
      compiled.workflow.steps.find(
        (step) => compiled.nodes[runtimeNodeKey(step)] === requester,
      )?.kind,
    ).toBe("agent");
  });

  it("seals a full candidate merge when an integrated writer inherits earlier authored commits", async () => {
    const definition = graphRunDefinitionFixture((team) => {
      team.graph.nodes.push(
        {
          id: "second",
          label: "Build on the first writer",
          kind: "agent",
          memberId: "builder",
          task: "Add a second component while preserving the first",
          access: "write",
          candidate: { kind: "node", nodeId: "write" },
        },
        {
          id: "integrate",
          label: "Integrate the complete candidate",
          kind: "integration",
          writerNodeIds: ["second"],
          baseCandidate: { kind: "source" },
        },
      );
      for (const node of team.graph.nodes)
        if (node.kind === "check" || node.kind === "review")
          node.candidate = { kind: "node", nodeId: "integrate" };
      team.graph.edges = [
        teamEdge("write", "second"),
        teamEdge("second", "integrate"),
        teamEdge("integrate", "check"),
        teamEdge("check", "review"),
      ];
    });
    const compiled = compileArcGraphRun(definition);
    const merges = Object.values(compiled.nodes).filter(
      (node) => node.kind === "integrate",
    );
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({
      strategy: "merge-candidate",
      commit: compiled.references.outputs.second.candidate,
    });
    expect(compiled.references.finalGates).toHaveLength(1);
    if (merges[0].kind !== "integrate") throw new Error("Missing integration");
    const { strategy, ...legacyShape } = merges[0];
    expect(strategy).toBe("merge-candidate");
    expect(graphRuntimeNodeSchema.safeParse(legacyShape).success).toBe(false);
    const run = executeGraph(compiled);
    await expect(run.result).resolves.toBeDefined();
    expect(
      run.dispatched.filter(
        ({ node }) => node.kind === "agent" && node.purpose === "writer",
      ),
    ).toHaveLength(2);
  });

  it("requires a successful final candidate alternative while allowing an unselected required-gate alternative", async () => {
    const definition = graphRunDefinitionFixture(conditionalTeam);
    const team = definition.team.definition;
    team.graph.nodes = team.graph.nodes.filter(
      (node) => !["yes", "no", "selected", "review"].includes(node.id),
    );
    for (const id of ["yes", "no"])
      team.graph.nodes.push({
        id,
        label: id,
        kind: "review",
        memberId: "builder",
        task: "Review this candidate",
        candidate: { kind: "node", nodeId: "write" },
      });
    team.graph.edges = [
      teamEdge("write", "check"),
      teamEdge("check", "condition"),
      teamEdge("condition", "yes", "succeeded", "true"),
      teamEdge("condition", "no", "succeeded", "false"),
    ];
    team.presentation.nodes = [];
    team.graph.requiredGates = [
      { id: "review", mode: "any", nodeIds: ["yes", "no"] },
    ];
    Object.assign(definition.team, teamHashes(team));
    const compiled = compileArcGraphRun(definition);
    expect(compiled.references.finalGates).toHaveLength(2);
    const run = executeGraph(compiled);
    await expect(run.result).resolves.toBeDefined();
    expect(
      run.dispatched.filter(({ node }) => node.kind === "verify"),
    ).toHaveLength(1);
  });

  it("rejects model snapshots that differ from the team's pinned override", () => {
    const override = {
      providerId: "codex",
      model: "team-model",
      reasoningLevel: "high",
      serviceTier: "default",
    } as const;
    const definition = graphRunDefinitionFixture((team) => {
      team.members[0]!.modelOverride = override;
    });
    expect(() => compileArcGraphRun(definition)).toThrow(
      "does not match its pinned team model selection",
    );
    definition.members.builder.execution = {
      ...definition.members.builder.execution,
      ...override,
    };
    const compiled = compileArcGraphRun(definition);
    expect(compiled.definition.members.builder.execution).toMatchObject(
      override,
    );
  });

  it("rejects a stale team pin, changed snapshot and unchecked final candidate without weakening legacy compilation", () => {
    const legacy = runDefinitionFixture();
    const before = JSON.stringify(compileArcRun(legacy));
    const definition = graphRunDefinitionFixture();
    definition.request.team.revision += 1;
    expect(() => compileArcGraphRun(definition)).toThrow(
      "exact published team revision",
    );
    definition.request.team.revision -= 1;
    definition.members.builder.definition.revision += 1;
    expect(() => compileArcGraphRun(definition)).toThrow(
      "published agent revision",
    );
    const unchecked = graphRunDefinitionFixture((team) => {
      const review = team.graph.nodes.find((node) => node.kind === "review");
      if (review?.kind === "review") review.candidate = { kind: "source" };
    });
    expect(() => compileArcGraphRun(unchecked)).toThrow(
      "native check and review",
    );
    expect(JSON.stringify(compileArcRun(legacy))).toBe(before);
  });

  it("keeps user material out of executable source, preserves one-hour native checks and refuses unavailable release", () => {
    const definition = graphRunDefinitionFixture((team) => {
      const writer = team.graph.nodes.find((node) => node.kind === "agent");
      if (writer?.kind === "agent")
        writer.task = '\"); unauthorizedScript(); //';
      const check = team.graph.nodes.find((node) => node.kind === "check");
      if (check?.kind === "check") check.command.timeoutMs = 3_600_000;
    });
    const compiled = compileArcGraphRun(definition);
    expect(compiled.workflow.source).not.toContain("unauthorizedScript");
    expect(
      Object.values(compiled.nodes).find((node) => node.kind === "check"),
    ).toMatchObject({ command: { timeoutMs: 3_600_000 } });
    const team = definition.team.definition;
    team.graph.nodes.push({
      id: "release",
      label: "Release",
      kind: "release",
      target: "pull-request",
      configurationRef: null,
      candidate: { kind: "node", nodeId: "write" },
    });
    team.graph.edges.push(teamEdge("review", "release"));
    Object.assign(definition.team, teamHashes(team));
    expect(() => compileArcGraphRun(definition)).toThrow("Phase 6");
  });
});

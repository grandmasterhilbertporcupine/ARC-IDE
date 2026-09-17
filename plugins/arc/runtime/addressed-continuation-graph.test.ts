import { describe, expect, it } from "vitest";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { composeAddressedTeams } from "./addressed-composition.js";
import { preserveAddressedVerification } from "./addressed-continuation-graph.js";
import { runtimeHash } from "./hash.js";
import { runtimeNodeKey } from "./compiler.js";
import { teamEdge } from "../teams/testing.js";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";

function finalGateNodes(compiled: ReturnType<typeof compileArcGraphRun>) {
  return compiled.references.finalGates.map((gate) => {
    const checkNodeId =
      compiled.references.origins[runtimeNodeKey(gate.check)].graphNodeId;
    const reviewNodeId =
      compiled.references.origins[runtimeNodeKey(gate.review)].graphNodeId;
    if (!checkNodeId || !reviewNodeId)
      throw new Error("Missing final verification origin");
    return { checkNodeId, reviewNodeId };
  });
}

function executeChecks(
  compiled: ReturnType<typeof compileArcGraphRun>,
  failed: ReadonlySet<string>,
) {
  const commands: string[] = [];
  const outcomes = new Map<
    string,
    { state: "succeeded" | "failed"; selectedOutputs: string[] }
  >();
  const result = executeWorkflowScript({
    args: compiled.workflow.args,
    body: parseWorkflowSource(compiled.workflow.source).body,
    capabilities: {
      agent: async () => {
        throw new Error("Unadmitted agent");
      },
      async step(nodeId, iteration) {
        const key = runtimeNodeKey({ nodeId, iteration });
        const node = compiled.nodes[key];
        let state: "succeeded" | "failed" = "succeeded";
        let selectedOutputs: string[] = [];
        if (node.kind === "check") {
          const command = node.command.args[0];
          commands.push(command);
          if (failed.has(command)) state = "failed";
        }
        if (node.kind === "control") {
          const operation = node.operation;
          if (operation.type === "condition") {
            const source = outcomes.get(
              runtimeNodeKey(operation.predicate.source),
            )!;
            const predicate = operation.predicate;
            const selected =
              predicate.kind === "outcome"
                ? source.state === predicate.equals
                : predicate.kind === "check-exit"
                  ? ((source.state === "succeeded" ? 0 : 1) ===
                      predicate.value) ===
                    (predicate.operator === "eq")
                  : false;
            selectedOutputs = [String(selected)];
          } else
            selectedOutputs = [
              operation.type === "message-response" ||
              operation.type === "delegation-slot"
                ? "skip"
                : "next",
            ];
        }
        outcomes.set(key, { state, selectedOutputs });
        const receipt =
          node.kind === "control"
            ? { revision: 0, selectedOutputs, data: null }
            : null;
        if (state === "failed")
          throw Object.assign(new Error("Recorded check failure"), {
            stepFailure: {
              workflowRunId: "retained-check-test",
              ownerRunId: compiled.definition.runId,
              nodeId,
              iteration,
              attempt: 1,
              effectId: key,
              requestHash: "a".repeat(64),
              state,
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
  return { result, commands };
}

describe("addressed recipient changes", () => {
  it("replays the selected required check without making discovery or the unselected alternative mandatory", async () => {
    const previous = graphRunDefinitionFixture((team) => {
      team.schemaVersion = 2;
      const write = team.graph.nodes.find((node) => node.id === "write")!;
      const review = team.graph.nodes.find((node) => node.id === "review")!;
      const check = (id: string) => ({
        id,
        label: id,
        kind: "check" as const,
        command: { executable: "node", args: [id], timeoutMs: 60000 },
        candidate: { kind: "node" as const, nodeId: "write" },
      });
      team.graph.nodes = [
        write,
        check("platform-probe"),
        check("windows-check"),
        check("posix-check"),
        check("optional-discovery"),
        {
          id: "platform",
          label: "Choose platform",
          kind: "condition",
          predicate: {
            kind: "check-exit",
            sourceNodeId: "platform-probe",
            operator: "eq",
            value: 0,
          },
        },
        {
          id: "selected-check",
          label: "Selected verification",
          kind: "join",
          mode: "selected",
          decisionNodeId: "platform",
        },
        review,
      ];
      team.graph.edges = [
        teamEdge("write", "platform-probe"),
        teamEdge("write", "optional-discovery"),
        teamEdge("platform-probe", "platform", "completed"),
        teamEdge("platform", "windows-check", "succeeded", "true"),
        teamEdge("platform", "posix-check", "succeeded", "false"),
        teamEdge("windows-check", "selected-check"),
        teamEdge("posix-check", "selected-check"),
        teamEdge("selected-check", "review"),
      ];
      team.graph.requiredGates = [
        {
          id: "platform-verification",
          mode: "any",
          nodeIds: ["windows-check", "posix-check"],
        },
        { id: "reviewed", mode: "all", nodeIds: ["review"] },
      ];
      team.presentation.nodes = team.presentation.nodes.filter((position) =>
        team.graph.nodes.some((node) => node.id === position.nodeId),
      );
    });
    const next = graphRunDefinitionFixture((team) => {
      const check = team.graph.nodes.find((node) => node.kind === "check");
      if (check?.kind === "check") check.command.args = ["new-check"];
    });
    const previousFinalGates = finalGateNodes(compileArcGraphRun(previous));
    const retained = preserveAddressedVerification(
      previous.team,
      {
        revision: next.team,
        members: next.members,
      },
      ["review"],
      previousFinalGates,
    );
    const compiled = compileArcGraphRun({
      ...next,
      team: retained.revision,
      members: retained.members,
    });
    const windows = executeChecks(
      compiled,
      new Set(["posix-check", "optional-discovery"]),
    );
    await expect(windows.result).resolves.toBeDefined();
    expect(windows.commands).toContain("windows-check");
    expect(windows.commands).not.toContain("posix-check");
    expect(windows.commands).not.toContain("optional-discovery");
    const posix = executeChecks(
      compiled,
      new Set(["platform-probe", "windows-check"]),
    );
    await expect(posix.result).resolves.toBeDefined();
    expect(posix.commands).toContain("posix-check");
    expect(posix.commands).not.toContain("windows-check");
    const failed = executeChecks(compiled, new Set(["windows-check"]));
    await expect(failed.result).rejects.toThrow(
      "Required gate did not succeed",
    );
    expect(
      runtimeHash(
        preserveAddressedVerification(
          previous.team,
          retained,
          ["review"],
          previousFinalGates,
        ),
      ),
    ).toBe(runtimeHash(retained));
  });

  it("retains the native final check when only its completed outcome precedes review", async () => {
    const previous = graphRunDefinitionFixture((team) => {
      const check = team.graph.nodes.find((node) => node.kind === "check");
      if (check?.kind === "check")
        check.command.args = ["required-final-check"];
      team.graph.edges = [
        teamEdge("write", "check"),
        teamEdge("check", "review", "completed"),
      ];
      team.graph.requiredGates = [
        { id: "reviewed", mode: "all", nodeIds: ["review"] },
      ];
    });
    const previousFinalGates = finalGateNodes(compileArcGraphRun(previous));
    expect(previousFinalGates).toEqual([
      { checkNodeId: "check", reviewNodeId: "review" },
    ]);
    const next = graphRunDefinitionFixture();
    const retained = preserveAddressedVerification(
      previous.team,
      { revision: next.team, members: next.members },
      ["review"],
      previousFinalGates,
    );
    const compiled = compileArcGraphRun({
      ...next,
      team: retained.revision,
      members: retained.members,
    });
    const passed = executeChecks(compiled, new Set());
    await expect(passed.result).resolves.toBeDefined();
    expect(passed.commands).toContain("required-final-check");
    const failed = executeChecks(compiled, new Set(["required-final-check"]));
    await expect(failed.result).rejects.toThrow(
      "Required gate did not succeed",
    );
  });

  it("keeps the original verification commands and final review when two newly addressed teams replace old assignments", () => {
    const previous = graphRunDefinitionFixture((team) => {
      const check = team.graph.nodes.find((node) => node.kind === "check");
      if (check?.kind === "check")
        check.command.args = ["--test", "original-critical-behavior"];
    });
    const first = graphRunDefinitionFixture();
    const previousFinalGates = finalGateNodes(compileArcGraphRun(previous));
    const second = graphRunDefinitionFixture();
    const composed = composeAddressedTeams({
      operationId: "changed-addresses",
      components: [
        { revision: first.team, members: first.members },
        { revision: second.team, members: second.members },
      ],
      lead: first.members.builder,
      reviewer: first.members.builder,
      check: {
        executable: "node",
        args: ["--test", "combined"],
        timeoutMs: 120000,
      },
      sourceKind: "git",
      createdAt: 1,
    });
    const original = runtimeHash(composed);
    const projected = compileArcGraphRun({
      ...first,
      team: composed.revision,
      members: composed.members,
      request: {
        ...first.request,
        team: {
          teamId: composed.revision.teamId,
          revision: composed.revision.revision,
        },
      },
    });
    const finalReviewIds = [
      ...new Set(
        projected.references.finalGates
          .map(
            (gate) =>
              projected.references.origins[runtimeNodeKey(gate.verify)]
                .graphNodeId,
          )
          .filter((id): id is string => id !== null),
      ),
    ];
    const retained = preserveAddressedVerification(
      previous.team,
      composed,
      finalReviewIds,
      previousFinalGates,
    );
    expect(runtimeHash(composed)).toBe(original);
    expect(
      retained.revision.definition.graph.nodes.filter(
        (node) => node.kind === "agent",
      ),
    ).toEqual(
      composed.revision.definition.graph.nodes.filter(
        (node) => node.kind === "agent",
      ),
    );
    const previousCheck = previous.team.definition.graph.nodes.find(
      (node) => node.kind === "check",
    );
    expect(previousCheck?.kind).toBe("check");
    const retainedChecks = retained.revision.definition.graph.nodes.filter(
      (node) =>
        node.kind === "check" &&
        runtimeHash(node.command) ===
          runtimeHash(
            previousCheck?.kind === "check" ? previousCheck.command : null,
          ),
    );
    expect(retainedChecks.length).toBeGreaterThan(0);
    for (const check of retainedChecks)
      expect(
        retained.revision.definition.graph.edges.some(
          (edge) =>
            edge.source === check.id &&
            retained.revision.definition.graph.nodes.some(
              (node) => node.id === edge.target && node.kind === "review",
            ) &&
            edge.requiredOutcome === "completed",
        ),
      ).toBe(true);
    const partialReviews = composed.revision.definition.graph.nodes.filter(
      (node) => node.kind === "review" && !finalReviewIds.includes(node.id),
    );
    expect(partialReviews.length).toBeGreaterThan(0);
    for (const review of partialReviews)
      expect(
        retained.revision.definition.graph.edges.filter(
          (edge) => edge.target === review.id,
        ),
      ).toEqual(
        composed.revision.definition.graph.edges.filter(
          (edge) => edge.target === review.id,
        ),
      );
    const compiled = compileArcGraphRun({
      ...first,
      team: retained.revision,
      members: retained.members,
      request: {
        ...first.request,
        team: {
          teamId: retained.revision.teamId,
          revision: retained.revision.revision,
        },
      },
    });
    expect(compiled.references.finalGates.length).toBeGreaterThan(0);
    expect(
      compiled.workflow.requiredGates.some((gate) =>
        gate.gateId.includes("prior-check"),
      ),
    ).toBe(true);
    expect(
      runtimeHash(
        preserveAddressedVerification(
          previous.team,
          retained,
          finalReviewIds,
          previousFinalGates,
        ),
      ),
    ).toBe(runtimeHash(retained));
    const weakened = structuredClone(retained);
    const preservedNode = weakened.revision.definition.graph.nodes.find(
      (node) => node.id.startsWith("prior-check") && node.kind === "check",
    );
    if (preservedNode?.kind !== "check")
      throw new Error("Retained check is missing");
    preservedNode.command.args = ["--version"];
    expect(() =>
      preserveAddressedVerification(
        previous.team,
        weakened,
        finalReviewIds,
        previousFinalGates,
      ),
    ).toThrow("conflicts with retained verification");
    const missingDependency = structuredClone(retained);
    missingDependency.revision.definition.graph.edges =
      missingDependency.revision.definition.graph.edges.filter(
        (edge) => edge.source !== preservedNode.id,
      );
    expect(() =>
      preserveAddressedVerification(
        previous.team,
        missingDependency,
        finalReviewIds,
        previousFinalGates,
      ),
    ).toThrow("conflicts with retained verification");
    const weakenedGate = structuredClone(retained);
    const gate = weakenedGate.revision.definition.graph.requiredGates.find(
      (entry) => entry.id.startsWith("prior-check"),
    );
    if (!gate) throw new Error("Retained check gate is missing");
    gate.nodeIds = [weakenedGate.revision.definition.graph.entryNodeIds[0]];
    expect(() =>
      preserveAddressedVerification(
        previous.team,
        weakenedGate,
        finalReviewIds,
        previousFinalGates,
      ),
    ).toThrow("conflicts with retained verification");
  });
});

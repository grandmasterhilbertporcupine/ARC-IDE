import { describe, expect, it } from "vitest";
import {
  teamDefinitionSchema,
  type TeamDefinition,
  type TeamNode,
} from "./contract.js";
import { teamDefinitionFixture, teamEdge } from "./testing.js";
import {
  canonicalTeamDefinition,
  teamHashes,
  validateTeamDefinition,
} from "./validation.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";
const validate = (definition: TeamDefinition) =>
  validateTeamDefinition(
    definition,
    (id, revision) => id === agentId && revision === 1,
  );
const codes = (definition: TeamDefinition) =>
  validate(definition).diagnostics.map((item) => item.code);
function conditionalFixture(): TeamDefinition {
  const definition = teamDefinitionFixture(agentId);
  definition.graph.nodes.push(
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
    {
      id: "yes",
      label: "True path",
      kind: "agent",
      memberId: "builder",
      task: "Inspect the successful check",
      access: "read",
      candidate: { kind: "node", nodeId: "write" },
    },
    {
      id: "no",
      label: "False path",
      kind: "agent",
      memberId: "builder",
      task: "Inspect the failed check",
      access: "read",
      candidate: { kind: "node", nodeId: "write" },
    },
    {
      id: "selected",
      label: "Selected outcome",
      kind: "join",
      mode: "selected",
      decisionNodeId: "condition",
    },
  );
  definition.graph.edges = [
    teamEdge("write", "check"),
    teamEdge("check", "condition", "completed"),
    teamEdge("condition", "yes", "succeeded", "true"),
    teamEdge("condition", "no", "succeeded", "false"),
    teamEdge("yes", "selected"),
    teamEdge("no", "selected"),
    teamEdge("selected", "review"),
  ];
  return definition;
}

describe("canonical team graph validation", () => {
  it("reports supported execution only for a structurally valid graph without unavailable stages", () => {
    const definition = teamDefinitionFixture(agentId);
    expect(validate(definition)).toMatchObject({
      valid: true,
      execution: { available: true, blockers: [] },
    });
    definition.graph.entryNodeIds = ["missing"];
    expect(validate(definition)).toMatchObject({
      valid: false,
      execution: { available: false },
    });
  });
  it("preserves the full stage vocabulary and explicit configuration while reporting unsupported execution", () => {
    const definition = conditionalFixture();
    definition.members.push({
      id: "delegate",
      agentId,
      revision: 1,
      groupId: null,
    });
    definition.permissions.push({
      id: "delegate-grant",
      action: "delegate",
      fromMemberId: "builder",
      toMemberId: "delegate",
    });
    definition.graph.nodes.push(
      { id: "parallel", label: "Parallel", kind: "parallel" },
      {
        id: "all",
        label: "Required join",
        kind: "join",
        mode: "all",
        decisionNodeId: null,
      },
      {
        id: "integration",
        label: "Integration",
        kind: "integration",
        writerNodeIds: ["write"],
        baseCandidate: { kind: "source" },
      },
      {
        id: "repair",
        label: "Bounded repair",
        kind: "repair",
        body: { memberId: "builder", task: "Repair the actual failed check" },
        checkNodeId: "check",
        maxRounds: 3,
      },
      {
        id: "approval",
        label: "Approval",
        kind: "approval",
        approver: "user",
        message: "Approve the current candidate",
        candidate: { kind: "node", nodeId: "write" },
      },
      {
        id: "delegation",
        label: "Delegate",
        kind: "delegation",
        requesterMemberId: "builder",
        candidateMemberIds: ["delegate"],
        task: "Inspect the candidate",
        access: "read",
        candidate: { kind: "node", nodeId: "write" },
        maxChildCalls: 2,
      },
      {
        id: "release",
        label: "Release",
        kind: "release",
        target: "deploy",
        candidate: { kind: "node", nodeId: "write" },
        configurationRef: null,
      },
    );
    const parsed = canonicalTeamDefinition(
      teamDefinitionSchema.parse(JSON.parse(JSON.stringify(definition))),
    );
    expect(new Set(parsed.graph.nodes.map((node) => node.kind)).size).toBe(11);
    expect(
      parsed.graph.nodes.find((node) => node.kind === "repair"),
    ).toMatchObject({ checkNodeId: "check", maxRounds: 3 });
    expect(
      parsed.graph.nodes.find((node) => node.kind === "delegation"),
    ).toMatchObject({ candidateMemberIds: ["delegate"], maxChildCalls: 2 });
    const result = validate(parsed);
    expect(result.valid).toBe(false);
    expect(
      result.diagnostics.some((item) => item.code === "unreachable_node"),
    ).toBe(true);
    expect(result.execution).toMatchObject({
      available: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: "release_unavailable",
          nodeIds: ["release"],
        }),
      ]),
    });
  });

  it("accepts typed alternative joins and rejects the all-success interpretation of exclusive branches", () => {
    const definition = conditionalFixture();
    expect(validate(definition).diagnostics).toEqual([]);
    const join = definition.graph.nodes.find((node) => node.id === "selected");
    if (!join || join.kind !== "join") throw new Error("Fixture join missing");
    join.mode = "all";
    join.decisionNodeId = null;
    expect(codes(definition)).toContain("exclusive_all_join");
    join.mode = "selected";
    join.decisionNodeId = "check";
    expect(codes(definition)).toContain("missing_join_decision");
  });

  it("does not mistake parallel work after a selected reconvergence for mutually exclusive work", () => {
    const definition = conditionalFixture();
    definition.graph.nodes.push(
      { id: "parallel", label: "Parallel after decision", kind: "parallel" },
      {
        id: "later-a",
        label: "Later A",
        kind: "agent",
        memberId: "builder",
        task: "Inspect A",
        access: "read",
        candidate: { kind: "source" },
      },
      {
        id: "later-b",
        label: "Later B",
        kind: "agent",
        memberId: "builder",
        task: "Inspect B",
        access: "read",
        candidate: { kind: "source" },
      },
      {
        id: "all",
        label: "Later join",
        kind: "join",
        mode: "all",
        decisionNodeId: null,
      },
    );
    definition.graph.edges = definition.graph.edges.filter(
      (edge) => edge.source !== "selected",
    );
    definition.graph.edges.push(
      teamEdge("selected", "parallel"),
      teamEdge("parallel", "later-a"),
      teamEdge("parallel", "later-b"),
      teamEdge("later-a", "all"),
      teamEdge("later-b", "all"),
      teamEdge("all", "review"),
    );
    expect(validate(definition).diagnostics).toEqual([]);
  });

  it("requires nested alternatives to be reconciled before an enclosing selected join", () => {
    const definition = conditionalFixture();
    definition.graph.nodes.push(
      {
        id: "nested",
        label: "Nested",
        kind: "condition",
        predicate: {
          kind: "outcome",
          sourceNodeId: "yes",
          equals: "succeeded",
        },
      },
      {
        id: "nested-a",
        label: "Nested A",
        kind: "agent",
        memberId: "builder",
        task: "A",
        access: "read",
        candidate: { kind: "source" },
      },
      {
        id: "nested-b",
        label: "Nested B",
        kind: "agent",
        memberId: "builder",
        task: "B",
        access: "read",
        candidate: { kind: "source" },
      },
    );
    definition.graph.edges = definition.graph.edges.filter(
      (edge) => edge.source !== "yes",
    );
    definition.graph.edges.push(
      teamEdge("yes", "nested"),
      teamEdge("nested", "nested-a", "succeeded", "true"),
      teamEdge("nested", "nested-b", "succeeded", "false"),
      teamEdge("nested-a", "selected"),
      teamEdge("nested-b", "selected"),
    );
    expect(codes(definition)).toContain("unresolved_nested_branch");
    definition.graph.nodes.push({
      id: "nested-join",
      label: "Nested join",
      kind: "join",
      mode: "selected",
      decisionNodeId: "nested",
    });
    definition.graph.edges = definition.graph.edges.filter(
      (edge) => !["nested-a", "nested-b"].includes(edge.source),
    );
    definition.graph.edges.push(
      teamEdge("nested-a", "nested-join"),
      teamEdge("nested-b", "nested-join"),
      teamEdge("nested-join", "selected"),
    );
    expect(validate(definition).diagnostics).toEqual([]);
  });

  it("rejects graph/group cycles, broken references and stale presentation nodes", () => {
    const definition = teamDefinitionFixture(agentId);
    definition.groups[0] = {
      id: "blue",
      name: "Blue",
      color: "#0000ff",
      parentGroupId: "child",
    };
    definition.groups.push({
      id: "child",
      name: "Child",
      color: "#ffffff",
      parentGroupId: "blue",
    });
    definition.graph.edges.push(teamEdge("review", "write"));
    definition.presentation.nodes.push({ nodeId: "deleted", x: 0, y: 0 });
    definition.members.push({
      id: "builder",
      agentId,
      revision: 99,
      groupId: "missing",
    });
    expect(codes(definition)).toEqual(
      expect.arrayContaining([
        "duplicate_id",
        "group_cycle",
        "graph_cycle",
        "entry_has_dependencies",
        "agent_revision_unavailable",
        "missing_group",
        "missing_node",
      ]),
    );
  });

  it("validates typed predicate sources, branch handles and settled outcomes without prose predicates", () => {
    const definition = conditionalFixture();
    const condition = definition.graph.nodes.find(
      (node) => node.kind === "condition",
    );
    if (!condition || condition.kind !== "condition")
      throw new Error("Fixture condition missing");
    condition.predicate = {
      kind: "review-verdict",
      sourceNodeId: "check",
      equals: "approved",
    };
    definition.graph.edges.push(
      teamEdge("condition", "review", "failed", "next"),
    );
    expect(codes(definition)).toEqual(
      expect.arrayContaining([
        "invalid_condition_source",
        "invalid_handle",
        "invalid_branch_outcome",
      ]),
    );
    expect(() =>
      teamDefinitionSchema.parse({
        ...definition,
        graph: {
          ...definition.graph,
          nodes: [
            ...definition.graph.nodes,
            {
              ...condition,
              id: "arbitrary",
              predicate: { kind: "javascript", expression: "return true" },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("requires write-capable candidate ancestry for integration and exact failed checks for bounded repair", () => {
    const definition = teamDefinitionFixture(agentId);
    definition.graph.nodes.push(
      {
        id: "integration",
        label: "Integrate",
        kind: "integration",
        writerNodeIds: ["check"],
        baseCandidate: { kind: "node", nodeId: "check" },
      },
      {
        id: "repair",
        label: "Repair",
        kind: "repair",
        body: { memberId: "builder", task: "Repair" },
        checkNodeId: "check",
        maxRounds: 3,
      },
    );
    definition.graph.edges.push(
      teamEdge("check", "integration"),
      teamEdge("integration", "repair"),
      teamEdge("repair", "review", "failed", "repaired"),
    );
    expect(codes(definition)).toEqual(
      expect.arrayContaining([
        "invalid_candidate",
        "invalid_writer",
        "repair_failure_required",
        "invalid_repair_outcome",
      ]),
    );
    const repair = definition.graph.nodes.find(
      (node) => node.kind === "repair",
    );
    expect(() =>
      teamDefinitionSchema.parse({
        ...definition,
        graph: {
          ...definition.graph,
          nodes: [repair && { ...repair, maxRounds: 4 }],
        },
      }),
    ).toThrow();
  });

  it("keeps organizational grouping separate from directed delegation grants", () => {
    const definition = teamDefinitionFixture(agentId);
    definition.members.push({
      id: "recipient",
      agentId,
      revision: 1,
      groupId: "blue",
    });
    definition.graph.nodes.push({
      id: "delegate",
      label: "Delegate",
      kind: "delegation",
      requesterMemberId: "builder",
      candidateMemberIds: ["recipient"],
      task: "Review the result",
      access: "read",
      candidate: { kind: "node", nodeId: "write" },
      maxChildCalls: 1,
    });
    definition.graph.edges.push(teamEdge("review", "delegate"));
    expect(codes(definition)).toContain("delegation_grant_required");
    const before = teamHashes(definition).operationalHash;
    definition.permissions.push({
      id: "grant",
      fromMemberId: "builder",
      toMemberId: "recipient",
      action: "delegate",
    });
    expect(validate(definition).diagnostics).toEqual([]);
    expect(teamHashes(definition).operationalHash).not.toBe(before);
  });

  it("bounds draft shape and keeps empty required gates invalid for publication", () => {
    const definition = teamDefinitionFixture(agentId);
    definition.graph.requiredGates = [];
    expect(codes(definition)).toContain("gates_required");
    definition.graph.requiredGates.push({
      id: "empty",
      mode: "any",
      nodeIds: [],
    });
    expect(codes(definition)).toContain("empty_gate");
    expect(() =>
      teamDefinitionSchema.parse({
        ...definition,
        graph: {
          ...definition.graph,
          nodes: Array.from({ length: 201 }, () => definition.graph.nodes[0]),
        },
      }),
    ).toThrow();
  });

  it("rejects mandatory success from incompatible alternatives while allowing an any gate", () => {
    const definition = conditionalFixture();
    definition.graph.nodes = definition.graph.nodes.map((node) =>
      node.id === "yes" || node.id === "no"
        ? {
            id: node.id,
            label: node.label,
            kind: "approval",
            approver: "user",
            message: "Approve this selected outcome",
            candidate: null,
          }
        : node,
    );
    definition.graph.requiredGates = [
      { id: "alternatives", mode: "all", nodeIds: ["yes", "no"] },
    ];
    expect(codes(definition)).toContain("exclusive_required_gates");
    definition.graph.requiredGates = [
      { id: "yes-required", mode: "all", nodeIds: ["yes"] },
      { id: "no-required", mode: "all", nodeIds: ["no"] },
    ];
    expect(codes(definition)).toContain("exclusive_required_gates");
    definition.graph.requiredGates = [
      { id: "alternatives", mode: "any", nodeIds: ["yes", "no"] },
      { id: "final", mode: "all", nodeIds: ["review"] },
    ];
    expect(validate(definition).diagnostics).toEqual([]);
  });

  it("validates and round trips a 200-node graph without dropping stage identities", () => {
    const definition = teamDefinitionFixture(agentId);
    const nodes: TeamNode[] = [];
    for (let index = 0; index < 198; index++)
      nodes.push({
        id: `stage-${index}`,
        label: `Stage ${index}`,
        kind: "agent",
        memberId: "builder",
        task: `Inspect ${index}`,
        access: "read",
        candidate: { kind: "source" },
      });
    nodes.push(
      {
        id: "check",
        label: "Check",
        kind: "check",
        command: { executable: "node", args: ["--test"], timeoutMs: 60000 },
        candidate: { kind: "source" },
      },
      {
        id: "review",
        label: "Review",
        kind: "review",
        memberId: "builder",
        task: "Review",
        candidate: { kind: "source" },
      },
    );
    definition.graph.nodes = nodes;
    definition.graph.edges = nodes.slice(1).map((node, index) => {
      const previous = nodes[index];
      if (!previous) throw new Error("Previous stage missing");
      return teamEdge(previous.id, node.id);
    });
    definition.graph.entryNodeIds = ["stage-0"];
    definition.presentation.nodes = [];
    expect(validate(definition).diagnostics).toEqual([]);
    expect(canonicalTeamDefinition(definition).graph.nodes).toHaveLength(200);
    expect(teamHashes(definition).operationalHash).toBe(
      teamHashes(JSON.parse(JSON.stringify(definition))).operationalHash,
    );
  });
});

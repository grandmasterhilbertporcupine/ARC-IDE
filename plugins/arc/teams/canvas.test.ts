import { describe, expect, it } from "vitest";
import type { TeamDefinition, TeamEdge } from "./contract.js";
import {
  connectTeamCanvasEdge,
  layoutTeamCanvas,
  moveTeamCanvasNodes,
} from "./canvas.js";

function fixture(): TeamDefinition {
  return {
    schemaVersion: 1,
    name: "Nested team",
    description: "",
    groups: [
      {
        id: "inner",
        name: "Frontend",
        color: "#5599ff",
        parentGroupId: "outer",
      },
      { id: "outer", name: "Product", color: "#cc6655", parentGroupId: null },
    ],
    members: [
      {
        id: "builder",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        revision: 1,
        groupId: "inner",
      },
      {
        id: "reviewer",
        agentId: "agent_00000000-0000-4000-8000-000000000002",
        revision: 1,
        groupId: "outer",
      },
    ],
    permissions: [
      {
        id: "review-grant",
        fromMemberId: "builder",
        toMemberId: "reviewer",
        action: "review",
      },
    ],
    graph: {
      nodes: [
        {
          id: "writer",
          kind: "agent",
          label: "Build UI",
          memberId: "builder",
          task: "Build the interface",
          access: "write",
          candidate: { kind: "source" },
        },
        {
          id: "review",
          kind: "review",
          label: "Review UI",
          memberId: "reviewer",
          task: "Review the result",
          candidate: { kind: "node", nodeId: "writer" },
        },
        {
          id: "check",
          kind: "check",
          label: "Check",
          command: { executable: "node", args: ["check.mjs"], timeoutMs: 1000 },
          candidate: { kind: "source" },
        },
        {
          id: "condition",
          kind: "condition",
          label: "Choose",
          predicate: {
            kind: "outcome",
            sourceNodeId: "check",
            equals: "failed",
          },
        },
        {
          id: "repair",
          kind: "repair",
          label: "Repair",
          body: { memberId: "builder", task: "Repair the result" },
          checkNodeId: "check",
          maxRounds: 2,
        },
      ],
      edges: [
        {
          id: "retained-edge",
          source: "writer",
          target: "check",
          sourceHandle: "next",
          requiredOutcome: "completed",
        },
      ],
      entryNodeIds: ["writer"],
      requiredGates: [{ id: "gate", mode: "all", nodeIds: ["check"] }],
    },
    presentation: {
      groups: [
        { groupId: "outer", x: 100, y: 50, width: 800, height: 600 },
        { groupId: "inner", x: 180, y: 120, width: 400, height: 300 },
      ],
      nodes: [
        { nodeId: "writer", x: 220, y: 200 },
        { nodeId: "review", x: 600, y: 180 },
        { nodeId: "check", x: -100, y: 200 },
        { nodeId: "condition", x: -100, y: 400 },
        { nodeId: "repair", x: 220, y: 360 },
      ],
    },
  };
}

describe("Team canvas world coordinates", () => {
  it("places new empty groups beside occupied content and fits nested empty groups inside their parent", () => {
    const initial = fixture();
    initial.presentation.groups = [];
    initial.groups.push(
      {
        id: "empty-root",
        name: "Empty",
        color: "#ffffff",
        parentGroupId: null,
      },
      {
        id: "empty-child",
        name: "Empty child",
        color: "#ffffff",
        parentGroupId: "inner",
      },
    );
    const layout = layoutTeamCanvas(initial);
    const root = layout.groupRects.get("outer")!;
    const empty = layout.groupRects.get("empty-root")!;
    const inner = layout.groupRects.get("inner")!;
    const child = layout.groupRects.get("empty-child")!;
    expect(empty.x).toBeGreaterThanOrEqual(root.x + root.width + 80);
    expect(empty).toMatchObject({ width: 320, height: 200 });
    expect(child.x).toBeGreaterThan(inner.x);
    expect(child.y).toBeGreaterThan(inner.y);
    expect(child.x + child.width).toBeLessThan(inner.x + inner.width);
    expect(child.y + child.height).toBeLessThan(inner.y + inner.height);
    expect(child.x).toBeGreaterThanOrEqual(220 + 260 + 40);
  });

  it("fits missing nested group bounds around distant descendants and measured multiline cards", () => {
    const initial = fixture();
    initial.presentation.groups = [];
    initial.presentation.nodes.find((node) => node.nodeId === "review")!.x =
      1200;
    initial.presentation.nodes.find((node) => node.nodeId === "review")!.y =
      700;
    const sizes = new Map([
      ["repair", { width: 260, height: 260 }],
      ["review", { width: 260, height: 220 }],
    ]);
    const layout = layoutTeamCanvas(initial, sizes);
    expect(layout.groupRects.get("inner")).toEqual({
      groupId: "inner",
      x: 180,
      y: 136,
      width: 340,
      height: 524,
    });
    expect(layout.groupRects.get("outer")).toEqual({
      groupId: "outer",
      x: 140,
      y: 72,
      width: 1360,
      height: 888,
    });
    expect(layout.stagePositions.get("review")).toEqual({
      nodeId: "review",
      x: 1200,
      y: 700,
    });
    expect(initial.presentation.groups).toEqual([]);
  });

  it("preserves explicit bounds while independently fitting an unsaved nested group", () => {
    const initial = fixture();
    initial.presentation.groups = [initial.presentation.groups[0]!];
    const layout = layoutTeamCanvas(initial);
    expect(layout.groupRects.get("outer")).toBe(initial.presentation.groups[0]);
    expect(layout.groupRects.get("inner")).toMatchObject({
      x: 180,
      y: 136,
      width: 340,
      height: 408,
    });
  });

  it("keeps missing bounds automatic as a stage moves and a distant member is added", () => {
    const initial = fixture();
    initial.presentation.groups = [];
    const moved = moveTeamCanvasNodes(initial, [
      { type: "position", id: "stage:writer", position: { x: 1000, y: 64 } },
    ]);
    expect(moved.presentation.groups).toEqual([]);
    const before = layoutTeamCanvas(moved).groupRects.get("outer")!;
    moved.graph = {
      ...moved.graph,
      nodes: [
        ...moved.graph.nodes,
        {
          id: "far-writer",
          kind: "agent",
          label: "Additional writer",
          memberId: "builder",
          task: "More work",
          access: "write",
          candidate: { kind: "source" },
        },
      ],
    };
    moved.presentation.nodes.push({ nodeId: "far-writer", x: 2500, y: 1800 });
    const after = layoutTeamCanvas(moved).groupRects.get("outer")!;
    expect(after.x + after.width).toBeGreaterThanOrEqual(2500 + 260 + 80);
    expect(after.y + after.height).toBeGreaterThanOrEqual(1800 + 144 + 80);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    expect(moved.presentation.groups).toEqual([]);
    const groupMoved = moveTeamCanvasNodes(moved, [
      { type: "position", id: "group:outer", position: { x: 500, y: 500 } },
    ]);
    expect(groupMoved.presentation.groups).toHaveLength(2);
    expect(
      groupMoved.presentation.groups.find((group) => group.groupId === "outer"),
    ).toMatchObject({
      x: 500,
      y: 500,
      width: after.width,
      height: after.height,
    });
  });

  it("moves an outer group and all descendants without changing grants or graph semantics", () => {
    const initial = fixture();
    const moved = moveTeamCanvasNodes(initial, [
      {
        type: "position",
        id: "group:outer",
        position: { x: 200, y: 80 },
        dragging: true,
      },
    ]);
    expect(moved.presentation.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groupId: "outer", x: 200, y: 80 }),
        expect.objectContaining({ groupId: "inner", x: 280, y: 150 }),
      ]),
    );
    expect(moved.presentation.nodes).toEqual(
      expect.arrayContaining([
        { nodeId: "writer", x: 320, y: 230 },
        { nodeId: "review", x: 700, y: 210 },
        { nodeId: "repair", x: 320, y: 390 },
        { nodeId: "check", x: -100, y: 200 },
      ]),
    );
    expect(moved.graph).toBe(initial.graph);
    expect(moved.groups).toBe(initial.groups);
    expect(moved.members).toBe(initial.members);
    expect(moved.permissions).toBe(initial.permissions);
    expect(initial.presentation.nodes[0]).toEqual({
      nodeId: "writer",
      x: 220,
      y: 200,
    });
  });

  it("persists parent-relative mouse movement then one-unit keyboard movement as world coordinates", () => {
    const first = moveTeamCanvasNodes(fixture(), [
      { type: "position", id: "group:inner", position: { x: 120, y: 140 } },
    ]);
    expect(
      first.presentation.groups.find((group) => group.groupId === "inner"),
    ).toMatchObject({ x: 220, y: 190 });
    expect(
      first.presentation.nodes.find((node) => node.nodeId === "writer"),
    ).toEqual({ nodeId: "writer", x: 260, y: 270 });
    const next = moveTeamCanvasNodes(first, [
      {
        type: "position",
        id: "stage:writer",
        position: { x: 41, y: 80 },
        dragging: false,
      },
    ]);
    expect(
      next.presentation.nodes.find((node) => node.nodeId === "writer"),
    ).toEqual({ nodeId: "writer", x: 261, y: 270 });
    expect(
      next.presentation.nodes.find((node) => node.nodeId === "review"),
    ).toEqual({ nodeId: "review", x: 600, y: 180 });
  });

  it("resolves simultaneous nested movements against the new parent position without double translation", () => {
    const moved = moveTeamCanvasNodes(fixture(), [
      { type: "position", id: "stage:writer", position: { x: 41, y: 80 } },
      { type: "position", id: "group:inner", position: { x: 120, y: 140 } },
      { type: "position", id: "group:outer", position: { x: 200, y: 80 } },
    ]);
    expect(
      moved.presentation.groups.find((group) => group.groupId === "inner"),
    ).toMatchObject({ x: 320, y: 220 });
    expect(
      moved.presentation.nodes.find((node) => node.nodeId === "writer"),
    ).toEqual({ nodeId: "writer", x: 361, y: 300 });
  });

  it("does not silently delete graph data or persist an out-of-range drag", () => {
    const definition = fixture();
    expect(
      moveTeamCanvasNodes(definition, [{ type: "remove", id: "stage:writer" }]),
    ).toBe(definition);
    expect(
      moveTeamCanvasNodes(definition, [
        { type: "position", id: "group:outer", position: { x: 99999, y: 0 } },
      ]),
    ).toBe(definition);
  });
});

describe("Team canvas graph connections", () => {
  it.each<TeamEdge["requiredOutcome"]>(["succeeded", "failed", "completed"])(
    "preserves %s and the edge identity during reconnection",
    (requiredOutcome) => {
      const definition = fixture();
      definition.graph.edges[0]!.requiredOutcome = requiredOutcome;
      const next = connectTeamCanvasEdge(
        definition,
        {
          source: "stage:writer",
          sourceHandle: "next",
          target: "stage:review",
          targetHandle: "in",
        },
        "retained-edge",
      );
      expect(next.graph.edges).toEqual([
        {
          id: "retained-edge",
          source: "writer",
          target: "review",
          sourceHandle: "next",
          requiredOutcome,
        },
      ]);
      expect(next.graph.requiredGates).toBe(definition.graph.requiredGates);
      expect(next.presentation).toBe(definition.presentation);
    },
  );

  it.each([
    ["condition", "false", "succeeded"],
    ["condition", "true", "succeeded"],
    ["repair", "exhausted", "failed"],
    ["repair", "repaired", "succeeded"],
  ] as const)(
    "creates %s/%s with the correct outcome",
    (source, sourceHandle, requiredOutcome) => {
      const next = connectTeamCanvasEdge(fixture(), {
        source: `stage:${source}`,
        sourceHandle,
        target: "stage:review",
        targetHandle: "in",
      });
      expect(next.graph.edges.at(-1)).toMatchObject({
        source,
        sourceHandle,
        target: "review",
        requiredOutcome,
      });
    },
  );

  it("refuses group, missing-handle, duplicate and self connections without changing the draft", () => {
    const definition = fixture();
    for (const connection of [
      {
        source: "group:outer",
        sourceHandle: "next",
        target: "stage:review",
        targetHandle: "in",
      },
      {
        source: "stage:condition",
        sourceHandle: "next",
        target: "stage:review",
        targetHandle: "in",
      },
      {
        source: "stage:writer",
        sourceHandle: "next",
        target: "stage:check",
        targetHandle: "in",
      },
      {
        source: "stage:writer",
        sourceHandle: "next",
        target: "stage:writer",
        targetHandle: "in",
      },
    ])
      expect(connectTeamCanvasEdge(definition, connection)).toBe(definition);
  });
});

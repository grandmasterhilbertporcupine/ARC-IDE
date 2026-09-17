import { describe, expect, it } from "vitest";
import { teamEdge } from "../teams/testing.js";
import { runtimeNodeKey } from "./compiler.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { directoryDefinitionFixture } from "./directory-testing.js";

describe("serial directory graph compilation", () => {
  it("admits copies and captures as independently fenced host steps with one counted main response", () => {
    const compiled = compileArcDirectoryRun(directoryDefinitionFixture());
    expect(compiled.definition.schemaVersion).toBe(4);
    expect(compiled.workflow.schemaVersion).toBe(2);
    expect(compiled.definition.source).not.toHaveProperty("head");
    expect(compiled.definition.request).not.toHaveProperty("expectedHead");
    expect(
      Object.values(compiled.nodes).some((node) =>
        ["commit", "integrate", "prepare-worktree", "fork-worktree"].includes(
          node.kind,
        ),
      ),
    ).toBe(false);
    const steps = compiled.workflow.steps;
    const native = steps.filter((step) =>
      [
        "capture-source",
        "capture-directory",
        "materialize-directory",
        "check",
      ].includes(compiled.nodes[runtimeNodeKey(step)].kind),
    );
    expect(native.length).toBeGreaterThanOrEqual(6);
    expect(
      native.every((step) => step.kind === "host-effect" && step.lane !== null),
    ).toBe(true);
    expect(new Set(native.map((step) => JSON.stringify(step.lane))).size).toBe(
      1,
    );
    const main = steps.find(
      (step) =>
        runtimeNodeKey(step) ===
        runtimeNodeKey(compiled.references.mainCompletion),
    );
    expect(main).toMatchObject({ kind: "agent", lane: null, repair: null });
    const reader = Object.values(compiled.nodes).find(
      (node) => node.kind === "agent" && node.purpose === "review",
    );
    if (reader?.kind !== "agent") throw new Error("Missing reviewer");
    expect(compiled.nodes[runtimeNodeKey(reader.workspace)].kind).toBe(
      "materialize-directory",
    );
  });

  it("rejects an implicit parallel writing fanout instead of merely serializing its lane", () => {
    const definition = directoryDefinitionFixture((team) => {
      team.graph.nodes.push({
        id: "other",
        label: "Other writer",
        kind: "agent",
        memberId: "builder",
        task: "Build another part",
        access: "write",
        candidate: { kind: "source" },
      });
      team.graph.entryNodeIds.push("other");
    });
    expect(() => compileArcDirectoryRun(definition)).toThrow(
      "Connect these directory writing stages serially",
    );
  });

  it("rejects serial edges that discard the preceding writing candidate", () => {
    const definition = directoryDefinitionFixture((team) => {
      team.graph.nodes.push({
        id: "other",
        label: "Other writer",
        kind: "agent",
        memberId: "builder",
        task: "Build another part",
        access: "write",
        candidate: { kind: "source" },
      });
      team.graph.edges.push(
        teamEdge("write", "other"),
        teamEdge("other", "check"),
      );
    });
    expect(() => compileArcDirectoryRun(definition)).toThrow(
      "discards an earlier selected directory result",
    );
  });

  it("accepts a serial candidate chain and verifies its final snapshot", () => {
    const definition = directoryDefinitionFixture((team) => {
      team.graph.nodes.push({
        id: "other",
        label: "Other writer",
        kind: "agent",
        memberId: "builder",
        task: "Build another part",
        access: "write",
        candidate: { kind: "node", nodeId: "write" },
      });
      team.graph.edges.push(
        teamEdge("write", "other"),
        teamEdge("other", "check"),
      );
      for (const node of team.graph.nodes)
        if (node.kind === "check" || node.kind === "review")
          node.candidate = { kind: "node", nodeId: "other" };
    });
    const compiled = compileArcDirectoryRun(definition);
    expect(compiled.references.finalGates).toHaveLength(1);
    expect(compiled.references.finalGates[0].candidate).toEqual(
      compiled.references.outputs.other.candidate,
    );
  });

  it.each(["parallel", "integration"] as const)(
    "rejects explicit %s capability without rewriting the published graph",
    (kind) => {
      const definition = directoryDefinitionFixture((team) => {
        team.graph.nodes.push(
          kind === "parallel"
            ? { id: "stage", label: "Stage", kind: "parallel" }
            : {
                id: "stage",
                label: "Stage",
                kind: "integration",
                writerNodeIds: ["write"],
                baseCandidate: { kind: "source" },
              },
        );
        team.graph.edges.push(
          teamEdge("write", "stage"),
          teamEdge("stage", "check"),
        );
        if (kind === "parallel") {
          team.graph.nodes.push({
            id: "parallel-read",
            label: "Read",
            kind: "agent",
            memberId: "builder",
            task: "Inspect",
            access: "read",
            candidate: { kind: "node", nodeId: "write" },
          });
          team.graph.edges.push(
            teamEdge("stage", "parallel-read"),
            teamEdge("parallel-read", "review"),
          );
        }
      });
      expect(() => compileArcDirectoryRun(definition)).toThrow(
        kind === "parallel"
          ? "explicitly serial"
          : "cannot integrate Git branches",
      );
    },
  );

  it("refuses a changed source root or a main completion bound to another conversation", () => {
    const changed = directoryDefinitionFixture();
    changed.source.rootIdentity.fileId = "22";
    expect(() => compileArcDirectoryRun(changed)).toThrow("source changed");
    const redirected = directoryDefinitionFixture();
    redirected.completion.threadId = "another-thread";
    expect(() => compileArcDirectoryRun(redirected)).toThrow(
      "exact originating conversation",
    );
  });
});

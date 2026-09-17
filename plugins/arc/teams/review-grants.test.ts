import { describe, expect, it } from "vitest";
import type { TeamDefinition, TeamNode } from "./contract.js";
import { analyzeTeamReviewGrants } from "./review-grants.js";
import { teamDefinitionFixture } from "./testing.js";
import { validateTeamDefinition } from "./validation.js";

function fixture() {
  const team = teamDefinitionFixture(
    "agent_00000000-0000-4000-8000-000000000001",
  );
  for (const id of ["alice", "bob", "reviewer"])
    team.members.push({ ...team.members[0], id });
  const review = team.graph.nodes.find((node) => node.kind === "review")!;
  review.memberId = "reviewer";
  return { team, review };
}
function grant(team: TeamDefinition, author: string, reviewer = "reviewer") {
  team.permissions.push({
    id: `review-${reviewer}-${author}`,
    fromMemberId: reviewer,
    toMemberId: author,
    action: "review",
  });
}
function writer(
  id: string,
  memberId: string,
  candidate: string | null = null,
): TeamNode {
  return {
    id,
    kind: "agent",
    label: id,
    memberId,
    task: "Write code",
    access: "write",
    candidate:
      candidate === null
        ? { kind: "source" }
        : { kind: "node", nodeId: candidate },
  };
}
function result(team: TeamDefinition, id = "review") {
  return analyzeTeamReviewGrants(team).reviews.find(
    (review) => review.reviewNodeId === id,
  )!;
}

describe("declared candidate review grants", () => {
  it("requires review grants for both possible contributors forwarded by a version-2 selected join", () => {
    const { team, review } = fixture();
    team.schemaVersion = 2;
    team.graph.nodes.push(writer("alternate", "alice"), {
      id: "selection",
      label: "Selected result",
      kind: "join",
      mode: "selected",
      decisionNodeId: "decision",
    });
    team.graph.edges.push(
      ...["write", "alternate"].map((source) => ({
        id: `${source}-selection`,
        source,
        target: "selection",
        sourceHandle: "next" as const,
        requiredOutcome: "succeeded" as const,
      })),
    );
    review.candidate = { kind: "node", nodeId: "selection" };
    grant(team, "builder");
    expect(result(team).missingMemberIds).toEqual(["alice"]);
    grant(team, "alice");
    expect(result(team).missingMemberIds).toEqual([]);
    expect(analyzeTeamReviewGrants(team).complete).toBe(true);
    team.schemaVersion = 1;
    expect(analyzeTeamReviewGrants(team).complete).toBe(false);
  });
  it("requires reviewer-to-author grants even for two members using the same Agent revision", () => {
    const { team } = fixture();
    expect(validateTeamDefinition(team, () => true).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "review_grant_required",
        nodeIds: ["review", "write"],
      }),
    );
    grant(team, "builder");
    expect(validateTeamDefinition(team, () => true).valid).toBe(true);
  });
  it.each(["reverse", "delegate", "unrelated"])(
    "does not infer authority from %s permission",
    (kind) => {
      const { team } = fixture();
      if (kind === "reverse") grant(team, "reviewer", "builder");
      if (kind === "unrelated") grant(team, "alice");
      if (kind === "delegate")
        team.permissions.push({
          id: "delegate",
          action: "delegate",
          fromMemberId: "reviewer",
          toMemberId: "builder",
        });
      expect(result(team).missingMemberIds).toEqual(["builder"]);
    },
  );
  it("allows self-review and source review without claiming independent review", () => {
    const { team, review } = fixture();
    review.memberId = "builder";
    expect(result(team)).toMatchObject({
      contributors: [{ memberId: "builder", nodeIds: ["write"] }],
      missingMemberIds: [],
    });
    review.candidate = { kind: "source" };
    expect(result(team).contributors).toEqual([]);
    expect(analyzeTeamReviewGrants(team).complete).toBe(true);
  });
  it("keeps inherited authors through a serial rewrite and omits unrelated dependency ancestors", () => {
    const { team, review } = fixture();
    team.graph.nodes.push(
      writer("rewrite", "alice", "write"),
      writer("unrelated", "bob"),
    );
    team.graph.edges.push({
      id: "unrelated-review",
      source: "unrelated",
      target: "review",
      sourceHandle: "next",
      requiredOutcome: "succeeded",
    });
    review.candidate = { kind: "node", nodeId: "rewrite" };
    grant(team, "alice");
    expect(result(team).contributors).toEqual([
      { memberId: "alice", nodeIds: ["rewrite"] },
      { memberId: "builder", nodeIds: ["write"] },
    ]);
    expect(result(team).missingMemberIds).toEqual(["builder"]);
  });
  it("unions integration writers and their inherited authors with a non-source base", () => {
    const { team, review } = fixture();
    team.graph.nodes.push(
      writer("first", "alice", "write"),
      writer("second", "bob"),
      {
        id: "merge",
        kind: "integration",
        label: "Merge",
        baseCandidate: { kind: "node", nodeId: "write" },
        writerNodeIds: ["first", "second"],
      },
    );
    review.memberId = "alice";
    review.candidate = { kind: "node", nodeId: "merge" };
    grant(team, "builder", "alice");
    expect(result(team).missingMemberIds).toEqual(["bob"]);
    expect(
      result(team).contributors.map((contributor) => contributor.memberId),
    ).toEqual(["alice", "bob", "builder"]);
  });
  it("adds repairers conservatively, deduplicates rounds and excludes an unused sibling repair", () => {
    const { team, review } = fixture();
    team.graph.nodes.push({
      id: "repair",
      kind: "repair",
      label: "Repair",
      checkNodeId: "check",
      maxRounds: 3,
      body: { memberId: "alice", task: "Fix failure" },
    });
    expect(result(team).contributors).toEqual([
      { memberId: "builder", nodeIds: ["write"] },
    ]);
    review.candidate = { kind: "node", nodeId: "repair" };
    expect(result(team).contributors).toEqual([
      { memberId: "alice", nodeIds: ["repair"] },
      { memberId: "builder", nodeIds: ["write"] },
    ]);
    grant(team, "builder");
    expect(result(team).missingMemberIds).toEqual(["alice"]);
  });
  it("requires every permitted writing child, including unused children, without adding the requester", () => {
    const { team, review } = fixture();
    team.graph.nodes.push({
      id: "delegate",
      kind: "delegation",
      label: "Delegate",
      requesterMemberId: "reviewer",
      candidateMemberIds: ["bob", "alice", "bob"],
      access: "write",
      maxChildCalls: 1,
      task: "Choose one child",
      candidate: { kind: "node", nodeId: "write" },
    });
    review.candidate = { kind: "node", nodeId: "delegate" };
    grant(team, "builder");
    grant(team, "alice");
    expect(result(team).contributors).toEqual([
      { memberId: "alice", nodeIds: ["delegate"] },
      { memberId: "bob", nodeIds: ["delegate"] },
      { memberId: "builder", nodeIds: ["write"] },
    ]);
    expect(result(team).missingMemberIds).toEqual(["bob"]);
  });
  it.each(["agent", "delegation"])(
    "does not manufacture writable output from a read-only %s",
    (kind) => {
      const { team, review } = fixture();
      team.graph.nodes.push(
        kind === "agent"
          ? {
              ...writer("read", "alice"),
              kind: "agent",
              memberId: "alice",
              task: "Read",
              candidate: { kind: "source" },
              access: "read",
            }
          : {
              id: "read",
              kind: "delegation",
              label: "Read",
              requesterMemberId: "builder",
              candidateMemberIds: ["alice"],
              access: "read",
              maxChildCalls: 1,
              task: "Inspect",
              candidate: { kind: "source" },
            },
      );
      expect(result(team).contributors).toEqual([
        { memberId: "builder", nodeIds: ["write"] },
      ]);
      review.candidate = { kind: "node", nodeId: "read" };
      expect(analyzeTeamReviewGrants(team).complete).toBe(false);
    },
  );
  it.each([
    "missing-node",
    "cycle",
    "missing-member",
    "control",
    "invalid-check",
  ])("fails closed for %s lineage", (kind) => {
    const { team, review } = fixture();
    if (kind === "missing-node")
      review.candidate = { kind: "node", nodeId: "absent" };
    if (kind === "cycle") {
      team.graph.nodes.push(writer("loop", "alice", "loop"));
      review.candidate = { kind: "node", nodeId: "loop" };
    }
    if (kind === "missing-member")
      team.members = team.members.filter((member) => member.id !== "builder");
    if (kind === "control") {
      team.graph.nodes.push({
        id: "control",
        kind: "parallel",
        label: "Control",
      });
      review.candidate = { kind: "node", nodeId: "control" };
    }
    if (kind === "invalid-check") {
      team.graph.nodes.push({
        id: "repair",
        kind: "repair",
        label: "Repair",
        checkNodeId: "write",
        maxRounds: 1,
        body: { memberId: "alice", task: "Repair" },
      });
      review.candidate = { kind: "node", nodeId: "repair" };
    }
    expect(analyzeTeamReviewGrants(team)).toMatchObject({
      complete: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "review_candidate_invalid" }),
      ]),
    });
  });
  it("is deterministic and unaffected by labels, groups, colors or definition ordering", () => {
    const { team } = fixture();
    const before = analyzeTeamReviewGrants(team);
    team.members.reverse();
    team.graph.nodes.reverse();
    team.groups[0].color = "#ff0000";
    team.groups[0].name = "Reviewer authority";
    for (const node of team.graph.nodes) node.label = "Can review everyone";
    expect(analyzeTeamReviewGrants(team)).toEqual(before);
  });
});

import type { TeamDefinition, TeamDiagnostic, TeamNode } from "./contract.js";

type Authors = Map<string, Set<string>>;
type Lineage = { complete: boolean; authors: Authors };

export function analyzeTeamReviewGrants(team: TeamDefinition) {
  const nodes = new Map(team.graph.nodes.map((node) => [node.id, node]));
  const members = new Set(team.members.map((member) => member.id));
  const grants = new Map<string, Set<string>>();
  for (const grant of team.permissions) {
    if (grant.action !== "review") continue;
    const recipients = grants.get(grant.fromMemberId) ?? new Set<string>();
    recipients.add(grant.toMemberId);
    grants.set(grant.fromMemberId, recipients);
  }
  const memo = new Map<string, Lineage>();
  const visiting = new Set<string>();
  const empty = (complete = true): Lineage => ({
    complete,
    authors: new Map(),
  });
  function union(...inputs: Lineage[]): Lineage {
    const result = empty(inputs.every((input) => input.complete));
    for (const input of inputs)
      for (const [memberId, nodeIds] of input.authors) {
        const contributions = result.authors.get(memberId) ?? new Set<string>();
        for (const nodeId of nodeIds) contributions.add(nodeId);
        result.authors.set(memberId, contributions);
      }
    return result;
  }
  function contribute(input: Lineage, nodeId: string, memberIds: string[]) {
    const result = union(input);
    for (const memberId of memberIds) {
      if (!members.has(memberId)) result.complete = false;
      const contributions = result.authors.get(memberId) ?? new Set<string>();
      contributions.add(nodeId);
      result.authors.set(memberId, contributions);
    }
    return result;
  }
  function candidate(
    reference: { kind: "source" } | { kind: "node"; nodeId: string },
  ): Lineage {
    return reference.kind === "source" ? empty() : visit(reference.nodeId);
  }
  function produce(node: TeamNode): Lineage {
    switch (node.kind) {
      case "agent":
        return node.access === "write"
          ? contribute(candidate(node.candidate), node.id, [node.memberId])
          : empty(false);
      case "delegation":
        return node.access === "write" && node.candidateMemberIds.length > 0
          ? contribute(
              candidate(node.candidate),
              node.id,
              node.candidateMemberIds,
            )
          : empty(false);
      case "integration":
        return union(
          candidate(node.baseCandidate),
          ...node.writerNodeIds.map(visit),
        );
      case "repair": {
        const check = nodes.get(node.checkNodeId);
        return contribute(
          check?.kind === "check" ? visit(check.id) : empty(false),
          node.id,
          [node.body.memberId],
        );
      }
      case "check":
      case "review":
        return candidate(node.candidate);
      case "join": {
        if (
          team.schemaVersion !== 2 ||
          node.mode !== "selected" ||
          node.decisionNodeId === null
        )
          return empty(false);
        const incoming = team.graph.edges.filter(
          (edge) => edge.target === node.id,
        );
        return incoming.length === 0
          ? empty(false)
          : union(...incoming.map((edge) => visit(edge.source)));
      }
      default:
        return empty(false);
    }
  }
  function visit(nodeId: string): Lineage {
    const saved = memo.get(nodeId);
    if (saved) return saved;
    const node = nodes.get(nodeId);
    if (!node || visiting.has(nodeId)) return empty(false);
    visiting.add(nodeId);
    const result = produce(node);
    visiting.delete(nodeId);
    memo.set(nodeId, result);
    return result;
  }
  const unique =
    nodes.size === team.graph.nodes.length &&
    members.size === team.members.length;
  let complete = unique;
  const diagnostics: TeamDiagnostic[] = [];
  const reviews = team.graph.nodes
    .filter((node) => node.kind === "review")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((review) => {
      const lineage = candidate(review.candidate);
      const resolved =
        unique && lineage.complete && members.has(review.memberId);
      if (!resolved) {
        diagnostics.push({
          code: "review_candidate_invalid",
          message: `Review ${review.id} has an unknown, missing, or cyclic contributor lineage. Choose a complete writable candidate before authorizing this review.`,
          path: `graph.nodes.${review.id}.candidate`,
          nodeIds: [review.id],
        });
      }
      const contributors = [...lineage.authors]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([memberId, nodeIds]) => ({
          memberId,
          nodeIds: [...nodeIds].sort(),
        }));
      const missingMemberIds = contributors
        .filter(
          ({ memberId }) =>
            memberId !== review.memberId &&
            !grants.get(review.memberId)?.has(memberId),
        )
        .map(({ memberId }) => memberId);
      for (const memberId of missingMemberIds) {
        const origins = lineage.authors.get(memberId) ?? new Set<string>();
        diagnostics.push({
          code: "review_grant_required",
          message: `Allow ${review.memberId} to review work by ${memberId} for review ${review.id}. This candidate includes inherited contributions and every permitted writing delegate from ${[...origins].sort().join(", ")}.`,
          path: "permissions",
          nodeIds: [review.id, ...origins].sort(),
        });
      }
      complete = complete && resolved;
      return {
        reviewNodeId: review.id,
        reviewerMemberId: review.memberId,
        contributors,
        missingMemberIds,
      };
    });
  return { complete, reviews, diagnostics };
}

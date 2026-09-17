import type { TeamDefinition } from "./contract.js";
import { analyzeTeamReviewGrants } from "./review-grants.js";

export function ReviewGrantRequirements({
  definition,
  names,
  reviewNodeId,
}: {
  definition: TeamDefinition;
  names: Map<string, { name: string; model: string }>;
  reviewNodeId?: string;
}) {
  const analysis = analyzeTeamReviewGrants(definition);
  const reviews = analysis.reviews.filter(
    (review) =>
      reviewNodeId === undefined || review.reviewNodeId === reviewNodeId,
  );
  if (reviews.length === 0) return null;
  const name = (id: string) => names.get(id)?.name ?? id;
  const stage = (id: string) =>
    definition.graph.nodes.find((node) => node.id === id)?.label ?? id;
  return (
    <section
      aria-label="Review permission requirements"
      className="space-y-2 text-xs text-muted-foreground"
    >
      <p>
        Review permission covers inherited changes, repairs, and every permitted
        writing delegate. Connections and team colors do not grant it.
      </p>
      {!analysis.complete && (
        <p role="status">
          Choose a complete candidate before its review permissions can be
          verified.
        </p>
      )}
      {reviews.map((review) => (
        <div key={review.reviewNodeId} className="space-y-1 border-l pl-3">
          <p className="font-medium text-foreground">
            {stage(review.reviewNodeId)} · {name(review.reviewerMemberId)}
          </p>
          {review.contributors.length === 0 && analysis.complete && (
            <p>
              The original source has no Team authors; no cross-member review
              grant is required.
            </p>
          )}
          {review.contributors.map((contributor) => (
            <p key={contributor.memberId}>
              {contributor.memberId === review.reviewerMemberId
                ? "Self-review: no grant required. This is not independent review."
                : `${review.missingMemberIds.includes(contributor.memberId) ? "Grant needed" : "Allowed"}: ${name(review.reviewerMemberId)} may review work by ${name(contributor.memberId)}.`}{" "}
              Contributions from {contributor.nodeIds.map(stage).join(", ")}.
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

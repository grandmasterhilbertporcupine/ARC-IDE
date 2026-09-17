import type { OwnedStepRef } from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import type { TeamDiagnostic } from "../teams/contract.js";
import { analyzeTeamReviewGrants } from "../teams/review-grants.js";
import type { RetainedCompiledRun, RetainedRuntimeNode } from "./compiled.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";

export function reviewAuthorityDiagnostic(
  compiled: RetainedCompiledRun,
  ref: OwnedStepRef,
): TeamDiagnostic | null {
  if (compiled.definition.schemaVersion === 1) return null;
  const key = runtimeNodeKey(ref);
  const node = compiled.nodes[key];
  const invalid = (message: string): TeamDiagnostic => ({
    code: "review_authority_invalid",
    message,
    path: `runtime.nodes.${key}`,
    nodeIds: [ref.nodeId],
  });
  if (!node) return invalid("The retained review step is missing.");
  if (!("team" in compiled.definition) || !("references" in compiled))
    return invalid(
      "The retained review has no published Team authority binding.",
    );
  const origin = compiled.references.origins[key];
  const team = compiled.definition.team.definition;
  const declared = team.graph.nodes.find(
    (item) => item.id === origin?.graphNodeId,
  );
  function inputCandidate(
    review: Extract<RetainedRuntimeNode, { kind: "agent" }>,
  ): OwnedStepRef | null {
    if (compiled.definition.schemaVersion !== 4) return review.candidate;
    const materialized = compiled.nodes[runtimeNodeKey(review.candidate)];
    return materialized?.kind === "materialize-directory" &&
      "workspace" in review &&
      runtimeNodeKey(review.workspace) === runtimeNodeKey(review.candidate)
      ? materialized.candidate
      : null;
  }
  if (
    node.kind !== "verify" &&
    !(node.kind === "agent" && node.purpose === "review")
  ) {
    const output =
      declared?.kind === "review"
        ? compiled.references.outputs[declared.id]?.outcome
        : null;
    return output && runtimeNodeKey(output) === key
      ? invalid(
          "The declared review was replaced with a different runtime action.",
        )
      : null;
  }
  if (node.kind === "verify") {
    const review = compiled.nodes[runtimeNodeKey(node.review)];
    const gate = compiled.references.finalGates.find(
      (gate) => runtimeNodeKey(gate.verify) === key,
    );
    const candidate = review?.kind === "agent" ? inputCandidate(review) : null;
    if (
      review?.kind !== "agent" ||
      review.purpose !== "review" ||
      !gate ||
      !candidate ||
      runtimeNodeKey(gate.review) !== runtimeNodeKey(node.review) ||
      runtimeNodeKey(gate.check) !== runtimeNodeKey(node.check) ||
      runtimeNodeKey(gate.candidate) !== runtimeNodeKey(candidate)
    )
      return invalid(
        "Final verification does not reference its exact retained review and candidate.",
      );
    return reviewAuthorityDiagnostic(compiled, node.review);
  }
  const output = declared
    ? compiled.references.outputs[declared.id]?.outcome
    : null;
  if (
    !("memberId" in node) ||
    declared?.kind !== "review" ||
    origin?.memberId !== node.memberId ||
    declared.memberId !== node.memberId ||
    node.access !== "read" ||
    node.task !== declared.task ||
    !output ||
    runtimeNodeKey(output) !== key
  )
    return invalid(
      "The retained review does not match its exact Team stage, member, and read-only task.",
    );
  const member = team.members.find((item) => item.id === node.memberId);
  const snapshot = compiled.definition.members[node.memberId];
  if (
    !member ||
    !snapshot ||
    runtimeHash(snapshot) !== runtimeHash(node.agent) ||
    member.agentId !== snapshot.definition.agentId ||
    member.revision !== snapshot.definition.revision
  )
    return invalid(
      "The retained reviewer does not match the Team's pinned Agent revision.",
    );
  const expected =
    declared.candidate.kind === "source"
      ? compiled.references.source
      : compiled.references.outputs[declared.candidate.nodeId]?.candidate;
  const candidate = inputCandidate(node);
  if (
    !expected ||
    !candidate ||
    runtimeNodeKey(expected) !== runtimeNodeKey(candidate)
  )
    return invalid(
      "The retained review candidate differs from its declared contributor lineage.",
    );
  const analysis = analyzeTeamReviewGrants(team);
  if (!analysis.complete)
    return invalid(
      "The retained Team has an incomplete review contributor lineage; no new review authority can be granted.",
    );
  return (
    analysis.diagnostics.find((diagnostic) =>
      diagnostic.nodeIds.includes(declared.id),
    ) ?? null
  );
}

export function assertReviewAuthority(
  compiled: RetainedCompiledRun,
  ref: OwnedStepRef,
): void {
  const diagnostic = reviewAuthorityDiagnostic(compiled, ref);
  if (diagnostic)
    throw new AgentStoreError(diagnostic.code, diagnostic.message);
}

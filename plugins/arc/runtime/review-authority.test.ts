import { describe, expect, it } from "vitest";
import type { TeamDefinition } from "../teams/contract.js";
import { compileArcRun, runtimeNodeKey } from "./compiler.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { runDefinitionFixture } from "./testing.js";
import {
  assertReviewAuthority,
  reviewAuthorityDiagnostic,
} from "./review-authority.js";

function crossMember(team: TeamDefinition) {
  team.members.push({ ...team.members[0], id: "reviewer" });
  const review = team.graph.nodes.find((node) => node.kind === "review")!;
  review.memberId = "reviewer";
  team.permissions.push({
    id: "review-builder",
    action: "review",
    fromMemberId: "reviewer",
    toMemberId: "builder",
  });
}
const versions = [
  {
    version: 2,
    compile: () => compileArcGraphRun(graphRunDefinitionFixture(crossMember)),
  },
  {
    version: 3,
    compile: () =>
      compileArcOrchestratedRun(orchestratedDefinitionFixture(crossMember)),
  },
  {
    version: 4,
    compile: () =>
      compileArcDirectoryRun(directoryDefinitionFixture(crossMember)),
  },
];
describe.each(versions)(
  "retained V$version review authority",
  ({ compile }) => {
    it("authorizes exact retained reviews and final proofs without changing compiled bytes", () => {
      const compiled = compile();
      const before = JSON.stringify(compiled);
      const review = compiled.references.outputs.review.outcome;
      expect(reviewAuthorityDiagnostic(compiled, review)).toBeNull();
      expect(
        reviewAuthorityDiagnostic(
          compiled,
          compiled.references.finalGates[0].verify,
        ),
      ).toBeNull();
      expect(JSON.stringify(compiled)).toBe(before);
    });
    it("blocks recovered ungranted review and final proof but leaves source effects eligible", () => {
      const compiled = compile();
      compiled.definition.team.definition.permissions = [];
      const before = JSON.stringify(compiled);
      const review = compiled.references.outputs.review.outcome;
      expect(() => assertReviewAuthority(compiled, review)).toThrow(
        /review work by builder/,
      );
      expect(
        reviewAuthorityDiagnostic(
          compiled,
          compiled.references.finalGates[0].verify,
        )?.code,
      ).toBe("review_grant_required");
      expect(
        reviewAuthorityDiagnostic(compiled, compiled.references.source),
      ).toBeNull();
      expect(JSON.stringify(compiled)).toBe(before);
    });
    it.each([
      "origin",
      "member",
      "snapshot",
      "candidate",
      "output",
      "purpose",
      "final-proof",
    ])("rejects forged %s binding", (kind) => {
      const compiled = compile();
      const ref = compiled.references.outputs.review.outcome;
      const key = runtimeNodeKey(ref);
      const node = compiled.nodes[key];
      if (node.kind !== "agent") throw new Error("Missing reviewer");
      if (kind === "origin")
        compiled.references.origins[key].graphNodeId = "write";
      if (kind === "member") node.memberId = "builder";
      if (kind === "snapshot")
        node.agent.definition = {
          ...node.agent.definition,
          revision: node.agent.definition.revision + 1,
        };
      if (kind === "candidate") node.candidate = compiled.references.source;
      if (kind === "output")
        compiled.references.outputs.review.outcome = compiled.references.source;
      if (kind === "purpose") node.purpose = "writer";
      if (kind === "final-proof") {
        const gate = compiled.references.finalGates[0];
        gate.review = compiled.references.outputs.write.outcome;
        expect(reviewAuthorityDiagnostic(compiled, gate.verify)?.code).toBe(
          "review_authority_invalid",
        );
      } else
        expect(reviewAuthorityDiagnostic(compiled, ref)?.code).toBe(
          "review_authority_invalid",
        );
    });
    it("fails closed for incomplete retained candidate authorship", () => {
      const compiled = compile();
      const writer = compiled.definition.team.definition.graph.nodes.find(
        (node) => node.kind === "agent",
      )!;
      writer.candidate = { kind: "node", nodeId: writer.id };
      expect(
        reviewAuthorityDiagnostic(
          compiled,
          compiled.references.outputs.review.outcome,
        )?.code,
      ).toBe("review_authority_invalid");
    });
  },
);
it("keeps the fixed legacy V1 review contract separate", () => {
  const compiled = compileArcRun(runDefinitionFixture());
  for (const step of compiled.workflow.steps)
    expect(reviewAuthorityDiagnostic(compiled, step)).toBeNull();
});

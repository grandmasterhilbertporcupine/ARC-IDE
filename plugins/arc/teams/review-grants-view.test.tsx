// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReviewGrantRequirements } from "./review-grants-view.js";
import { teamDefinitionFixture } from "./testing.js";

afterEach(cleanup);
it("explains inherited grants with actual member and stage names and updates after an explicit grant", () => {
  const definition = teamDefinitionFixture(
    "agent_00000000-0000-4000-8000-000000000001",
  );
  definition.members.push({ ...definition.members[0], id: "reviewer" });
  definition.graph.nodes.find((node) => node.kind === "review")!.memberId =
    "reviewer";
  const names = new Map([
    ["builder", { name: "App builder", model: "m" }],
    ["reviewer", { name: "Quality reviewer", model: "m" }],
  ]);
  const view = render(
    <ReviewGrantRequirements
      definition={definition}
      names={names}
      reviewNodeId="review"
    />,
  );
  expect(
    screen.getByText(
      /Grant needed: Quality reviewer may review work by App builder/,
    ).textContent,
  ).toContain("Contributions from Build.");
  expect(screen.getByText(/every permitted writing delegate/)).toBeTruthy();
  const revised = {
    ...definition,
    permissions: [
      {
        id: "review-builder",
        action: "review" as const,
        fromMemberId: "reviewer",
        toMemberId: "builder",
      },
    ],
  };
  view.rerender(
    <ReviewGrantRequirements
      definition={revised}
      names={names}
      reviewNodeId="review"
    />,
  );
  expect(screen.queryByText(/Grant needed/)).toBeNull();
  expect(
    screen.getByText(
      /Allowed: Quality reviewer may review work by App builder/,
    ),
  ).toBeTruthy();
});
it("distinguishes self-review from independent review and never labels an unknown candidate as authorless", () => {
  const definition = teamDefinitionFixture(
    "agent_00000000-0000-4000-8000-000000000001",
  );
  const view = render(
    <ReviewGrantRequirements definition={definition} names={new Map()} />,
  );
  expect(
    screen.getByText(
      /Self-review: no grant required. This is not independent review/,
    ),
  ).toBeTruthy();
  const review = definition.graph.nodes.find((node) => node.kind === "review")!;
  review.candidate = { kind: "node", nodeId: "missing" };
  view.rerender(
    <ReviewGrantRequirements definition={definition} names={new Map()} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Choose a complete candidate",
  );
  expect(screen.queryByText(/original source has no Team authors/)).toBeNull();
});

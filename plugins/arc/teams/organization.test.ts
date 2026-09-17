import { describe, expect, it } from "vitest";
import { teamDefinitionFixture } from "./testing.js";
import {
  canonicalTeamDefinition,
  teamHashes,
  validateTeamDefinition,
} from "./validation.js";
import {
  addSubagentGrants,
  canLead,
  connectTeamMembers,
  removeTeamMember,
} from "./organization.js";
import { visibleTeamConnections } from "./organization-connections.js";
import { teamDefinitionSchema } from "./contract.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";
function fixture() {
  const definition = teamDefinitionFixture(agentId);
  definition.members.push(
    { id: "reader", agentId, revision: 1, groupId: null },
    { id: "tester", agentId, revision: 1, groupId: null },
  );
  return definition;
}
const diagnostics = (definition: ReturnType<typeof fixture>) =>
  validateTeamDefinition(definition, () => true).diagnostics.map(
    (item) => item.code,
  );

describe("team organization and explicit collaboration", () => {
  it("filters displayed connections without changing authority and retains the inspected connection", () => {
    const definition = connectTeamMembers(
      addSubagentGrants(fixture(), "builder", "reader"),
      "tester",
      "reader",
      "review",
    );
    const before = JSON.stringify(definition);
    const hash = teamHashes(definition).operationalHash;
    const hierarchy = visibleTeamConnections(definition, "reports-to", null);
    expect(hierarchy).toEqual([
      {
        id: "leader:reader",
        source: "reader",
        target: "builder",
        relationship: "reports-to",
      },
    ]);
    expect(visibleTeamConnections(definition, "message", null)).toHaveLength(2);
    expect(visibleTeamConnections(definition, "delegate", null)).toHaveLength(
      1,
    );
    const review = visibleTeamConnections(definition, "review", null)[0]!;
    expect(review).toMatchObject({
      source: "tester",
      target: "reader",
      relationship: "review",
    });
    expect(visibleTeamConnections(definition, "reports-to", review.id)).toEqual(
      [...hierarchy, review],
    );
    expect(visibleTeamConnections(definition, "all", review.id)).toHaveLength(
      5,
    );
    expect(JSON.stringify(definition)).toBe(before);
    expect(teamHashes(definition).operationalHash).toBe(hash);
  });

  it("preserves canonical v1 definitions without inserting new authority or presentation defaults", () => {
    const original = fixture();
    const before = JSON.stringify(original);
    const canonical = canonicalTeamDefinition(original);
    expect(canonical.schemaVersion).toBe(1);
    expect(canonical.leaderMemberId).toBeUndefined();
    expect(canonical.presentation.members).toBeUndefined();
    expect(canonical.presentation.color).toBeUndefined();
    expect(
      canonical.members.every(
        (member) =>
          member.leaderMemberId === undefined &&
          member.skills === undefined &&
          member.modelOverride === undefined,
      ),
    ).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    expect(teamHashes(canonical).operationalHash).toBe(
      teamHashes(original).operationalHash,
    );
  });

  it("allows cyclic messaging but rejects cycles and missing members in leadership", () => {
    let definition = connectTeamMembers(
      fixture(),
      "builder",
      "reader",
      "message",
      true,
    );
    expect(diagnostics(definition)).toEqual([]);
    definition = connectTeamMembers(
      definition,
      "reader",
      "builder",
      "reports-to",
    );
    expect(canLead(definition, "reader", "builder")).toBe(false);
    expect(
      connectTeamMembers(definition, "builder", "reader", "reports-to"),
    ).toBe(definition);
    definition.members[0]!.leaderMemberId = "reader";
    expect(diagnostics(definition)).toContain("leadership_cycle");
    definition.members[0]!.leaderMemberId = "missing";
    expect(diagnostics(definition)).toContain("missing_leader");
  });

  it("keeps team color cosmetic while model overrides change operational identity", () => {
    const original = fixture();
    const before = teamHashes(original);
    const colored = structuredClone(original);
    colored.name = "Blue builders";
    colored.presentation.color = "#AABBCC";
    const after = teamHashes(colored);
    expect(after.definition.presentation.color).toBe("#aabbcc");
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.operationalHash).toBe(before.operationalHash);
    const override = {
      providerId: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "high",
      serviceTier: "default",
    } as const;
    colored.members[0]!.modelOverride = override;
    expect(teamHashes(colored).operationalHash).not.toBe(
      before.operationalHash,
    );
    for (const invalid of [
      { ...override, model: "" },
      { ...override, providerId: null },
      { ...override, permissionMode: "full" },
      { ...override, reasoningLevel: null },
      { ...override, serviceTier: undefined },
    ]) {
      expect(
        teamDefinitionSchema.safeParse({
          ...colored,
          members: [{ ...colored.members[0], modelOverride: invalid }],
        }).success,
      ).toBe(false);
    }
    expect(
      teamDefinitionSchema.safeParse({
        ...original,
        presentation: { ...original.presentation, color: "url(unsafe)" },
      }).success,
    ).toBe(false);
  });

  it("requires the designated lead to exist and stay at the top of the hierarchy", () => {
    const definition = fixture();
    definition.leaderMemberId = "missing";
    expect(diagnostics(definition)).toContain("missing_team_leader");
    definition.leaderMemberId = "builder";
    definition.members[0]!.leaderMemberId = "reader";
    expect(diagnostics(definition)).toContain("team_leader_reports_to");
  });

  it("creates explicit grants for a subagent without rewriting workflow order", () => {
    const original = fixture();
    const definition = addSubagentGrants(original, "builder", "reader");
    expect(
      definition.members.find((member) => member.id === "reader")
        ?.leaderMemberId,
    ).toBe("builder");
    expect(
      definition.permissions.map(({ fromMemberId, toMemberId, action }) => [
        fromMemberId,
        toMemberId,
        action,
      ]),
    ).toEqual([
      ["builder", "reader", "delegate"],
      ["builder", "reader", "message"],
      ["reader", "builder", "message"],
    ]);
    expect(definition.graph).toEqual(original.graph);
    expect(definition.schemaVersion).toBe(2);
    expect(
      connectTeamMembers(definition, "builder", "reader", "message", true),
    ).toBe(definition);
  });

  it("invalidates operational hashes for member instructions, lead and skill changes, but not positioning", () => {
    const original = fixture();
    original.schemaVersion = 2;
    const hash = teamHashes(original).operationalHash;
    const moved = structuredClone(original);
    moved.presentation.members = [{ memberId: "builder", x: 420, y: 180 }];
    expect(teamHashes(moved).operationalHash).toBe(hash);
    for (const change of [
      { role: "Frontend lead" },
      { responsibility: "Own accessibility" },
      { leaderMemberId: "reader" },
      { skills: [{ id: "a".repeat(64), name: "frontend" }] },
    ]) {
      const edited = structuredClone(original);
      Object.assign(edited.members[0]!, change);
      expect(teamHashes(edited).operationalHash).not.toBe(hash);
    }
    expect(
      teamHashes({ ...original, leaderMemberId: "builder" }).operationalHash,
    ).not.toBe(hash);
  });

  it("removes a member's communication and hierarchy references while leaving assigned work for reassignment", () => {
    const definition = addSubagentGrants(fixture(), "builder", "reader");
    definition.leaderMemberId = "builder";
    definition.presentation.members = [{ memberId: "builder", x: 0, y: 0 }];
    const removed = removeTeamMember(definition, "builder");
    expect(removed.leaderMemberId).toBeNull();
    expect(
      removed.members.find((member) => member.id === "reader")?.leaderMemberId,
    ).toBeNull();
    expect(removed.permissions).toEqual([]);
    expect(removed.presentation.members).toEqual([]);
    expect(removed.graph).toEqual(definition.graph);
    expect(diagnostics(removed)).toContain("missing_member");
  });
});

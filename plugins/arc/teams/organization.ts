import type { TeamDefinition, TeamGrant, TeamMember } from "./contract.js";

export const AGENT_DRAG_TYPE = "application/x-arc-agent";
export type TeamRelationship = TeamGrant["action"] | "reports-to";
export const relationshipLabels: Record<TeamRelationship, string> = {
  message: "Can message",
  delegate: "Can delegate",
  review: "Can review",
  "reports-to": "Reports to",
};

export function canLead(
  definition: TeamDefinition,
  leaderId: string,
  memberId: string,
) {
  if (leaderId === memberId || memberId === definition.leaderMemberId)
    return false;
  const members = new Map(
    definition.members.map((member) => [member.id, member]),
  );
  if (!members.has(leaderId) || !members.has(memberId)) return false;
  const seen = new Set([memberId]);
  let next: string | null | undefined = leaderId;
  while (next != null) {
    if (seen.has(next)) return false;
    seen.add(next);
    next = members.get(next)?.leaderMemberId;
  }
  return true;
}

export function connectTeamMembers(
  definition: TeamDefinition,
  from: string,
  to: string,
  relationship: TeamRelationship,
  bothWays = false,
): TeamDefinition {
  if (
    from === to ||
    !definition.members.some((member) => member.id === from) ||
    !definition.members.some((member) => member.id === to)
  )
    return definition;
  if (relationship === "reports-to") {
    if (!canLead(definition, to, from)) return definition;
    return {
      ...definition,
      schemaVersion: 2,
      members: definition.members.map((member) =>
        member.id === from ? { ...member, leaderMemberId: to } : member,
      ),
    };
  }
  const directions =
    bothWays && relationship === "message"
      ? [
          [from, to],
          [to, from],
        ]
      : [[from, to]];
  const additions: TeamGrant[] = [];
  for (const [source, target] of directions) {
    if (
      !source ||
      !target ||
      definition.permissions.some(
        (grant) =>
          grant.action === relationship &&
          grant.fromMemberId === source &&
          grant.toMemberId === target,
      )
    )
      continue;
    additions.push({
      id: `grant_${crypto.randomUUID()}`,
      fromMemberId: source,
      toMemberId: target,
      action: relationship,
    });
  }
  return additions.length === 0 ||
    definition.permissions.length + additions.length > 1000
    ? definition
    : {
        ...definition,
        schemaVersion: 2,
        permissions: [...definition.permissions, ...additions],
      };
}

export function memberPosition(
  definition: TeamDefinition,
  member: TeamMember,
  index: number,
) {
  const saved = definition.presentation.members?.find(
    (position) => position.memberId === member.id,
  );
  if (saved) return { x: saved.x, y: saved.y };
  const seen = new Set([member.id]);
  let depth = 0;
  let leader = member.leaderMemberId;
  while (leader != null && !seen.has(leader)) {
    seen.add(leader);
    depth++;
    leader = definition.members.find(
      (item) => item.id === leader,
    )?.leaderMemberId;
  }
  return { x: (index % 3) * 320, y: depth * 240 + Math.floor(index / 3) * 240 };
}

export function removeTeamMember(
  definition: TeamDefinition,
  memberId: string,
): TeamDefinition {
  return {
    ...definition,
    schemaVersion: 2,
    leaderMemberId:
      definition.leaderMemberId === memberId ? null : definition.leaderMemberId,
    members: definition.members
      .filter((member) => member.id !== memberId)
      .map((member) =>
        member.leaderMemberId === memberId
          ? { ...member, leaderMemberId: null }
          : member,
      ),
    permissions: definition.permissions.filter(
      (grant) =>
        grant.fromMemberId !== memberId && grant.toMemberId !== memberId,
    ),
    presentation: {
      ...definition.presentation,
      members: definition.presentation.members?.filter(
        (position) => position.memberId !== memberId,
      ),
    },
  };
}

export function addSubagentGrants(
  definition: TeamDefinition,
  leaderId: string,
  memberId: string,
) {
  return connectTeamMembers(
    connectTeamMembers(
      connectTeamMembers(definition, memberId, leaderId, "reports-to"),
      leaderId,
      memberId,
      "delegate",
    ),
    leaderId,
    memberId,
    "message",
    true,
  );
}

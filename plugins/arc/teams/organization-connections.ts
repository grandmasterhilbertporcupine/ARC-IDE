import type { TeamDefinition } from "./contract.js";
import type { TeamRelationship } from "./organization.js";

export type TeamConnectionFilter = TeamRelationship | "all";
export const connectionFilterLabels: Record<TeamConnectionFilter, string> = {
  "reports-to": "Reports to",
  message: "Can message",
  delegate: "Can delegate",
  review: "Can review",
  all: "All connections",
};

export function visibleTeamConnections(
  definition: TeamDefinition,
  filter: TeamConnectionFilter,
  selectedId: string | null,
) {
  const connections: {
    id: string;
    source: string;
    target: string;
    relationship: TeamRelationship;
  }[] = [
    ...definition.members.flatMap((member) =>
      member.leaderMemberId == null
        ? []
        : [
            {
              id: `leader:${member.id}`,
              source: member.id,
              target: member.leaderMemberId,
              relationship: "reports-to" as const,
            },
          ],
    ),
    ...definition.permissions.map((grant) => ({
      id: grant.id,
      source: grant.fromMemberId,
      target: grant.toMemberId,
      relationship: grant.action,
    })),
  ];
  return connections.filter(
    (connection) =>
      filter === "all" ||
      connection.relationship === filter ||
      connection.id === selectedId,
  );
}

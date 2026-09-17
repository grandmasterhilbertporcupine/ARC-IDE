import { randomUUID } from "node:crypto";
import { defaultRunPolicy } from "../policy/contract.js";
import type { TeamDefinition } from "../teams/contract.js";
import { teamDefinitionFixture } from "../teams/testing.js";
import { canonicalTeamDefinition, teamHashes } from "../teams/validation.js";
import type { GraphRunDefinition } from "./graph-contract.js";
import { runDefinitionFixture } from "./testing.js";

export function graphRunDefinitionFixture(
  update?: (team: TeamDefinition) => void,
): GraphRunDefinition {
  const legacy = runDefinitionFixture();
  const agent = legacy.writers[0];
  const team = teamDefinitionFixture(agent.definition.agentId);
  update?.(team);
  const definition = canonicalTeamDefinition(team);
  const teamId = `team_${randomUUID()}`;
  return {
    schemaVersion: 2,
    runId: legacy.runId,
    request: {
      operationId: legacy.request.operationId,
      projectId: legacy.request.projectId,
      originThreadId: legacy.request.originThreadId,
      hostId: legacy.request.hostId,
      path: legacy.request.path,
      expectedHead: legacy.request.expectedHead,
      goal: legacy.request.goal,
      team: { teamId, revision: 1 },
      expectedProjectPolicyVersion: 0,
      expectedSessionPolicyVersion: 0,
    },
    source: legacy.source,
    team: {
      teamId,
      revision: 1,
      ...teamHashes(definition),
      createdAt: 1,
    },
    members: Object.fromEntries(
      definition.members.map((member) => [member.id, agent]),
    ),
    policy: defaultRunPolicy(),
    createdAt: legacy.createdAt,
  };
}

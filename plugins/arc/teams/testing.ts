import Database from "better-sqlite3";
import type { AgentScope } from "../contract.js";
import { createAgentStore, migrations } from "../data.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { TeamDefinition, TeamDetail, TeamEdge } from "./contract.js";
import { createTeamStore, teamMigrations } from "./data.js";

export function teamEdge(
  source: string,
  target: string,
  requiredOutcome: TeamEdge["requiredOutcome"] = "succeeded",
  sourceHandle: TeamEdge["sourceHandle"] = "next",
): TeamEdge {
  return {
    id: `${source}-${sourceHandle}-${target}`,
    source,
    target,
    requiredOutcome,
    sourceHandle,
  };
}

export function teamDefinitionFixture(
  agentId: string,
  revision = 1,
): TeamDefinition {
  return {
    schemaVersion: 1,
    name: "Build and verify",
    description: "A pinned authoring fixture",
    groups: [
      { id: "blue", name: "Blue team", color: "#3366cc", parentGroupId: null },
    ],
    members: [{ id: "builder", agentId, revision, groupId: "blue" }],
    permissions: [],
    graph: {
      nodes: [
        {
          id: "write",
          label: "Build",
          kind: "agent",
          memberId: "builder",
          task: "Build the requested app.",
          access: "write",
          candidate: { kind: "source" },
        },
        {
          id: "check",
          label: "Check",
          kind: "check",
          command: { executable: "node", args: ["--test"], timeoutMs: 60000 },
          candidate: { kind: "node", nodeId: "write" },
        },
        {
          id: "review",
          label: "Review",
          kind: "review",
          memberId: "builder",
          task: "Review the exact checked candidate.",
          candidate: { kind: "node", nodeId: "write" },
        },
      ],
      edges: [teamEdge("write", "check"), teamEdge("check", "review")],
      entryNodeIds: ["write"],
      requiredGates: [
        { id: "verification", mode: "all", nodeIds: ["check", "review"] },
      ],
    },
    presentation: {
      nodes: [
        { nodeId: "write", x: 0, y: 0 },
        { nodeId: "check", x: 260, y: 0 },
        { nodeId: "review", x: 520, y: 0 },
      ],
      groups: [],
    },
  };
}

export const teamTarget = (team: TeamDetail) => ({
  teamId: team.id,
  scope: team.scope,
  expectedDraftVersion: team.draft.version,
});

export function createTeamTestStore(scope: AgentScope = { kind: "library" }) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...teamMigrations].join(";\n"));
  const agents = createAgentStore(db);
  let agent = agents.createAgent({
    scope,
    document: serializeAgentDocument(
      defaultAgentMetadata("Pinned builder"),
      "Build and review the requested work.",
    ),
  });
  agent = agents.publish({
    scope,
    agentId: agent.id,
    expectedDraftVersion: agent.draft.version,
  });
  const store = createTeamStore(db, agents);
  return {
    db,
    agents,
    agent,
    store,
    scope,
    definition: teamDefinitionFixture(agent.id),
  };
}

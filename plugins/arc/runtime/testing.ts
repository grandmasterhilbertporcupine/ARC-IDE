import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AgentStore } from "../data.js";
import { createTeamStore, teamMigrations } from "../teams/data.js";
import { createPolicyStore, policyMigrations } from "../policy/data.js";
import { createPolicyService } from "../policy/service.js";
import { controlMigrations } from "./control-data.js";
import { instructionUpdateMigrations } from "./instruction-update-data.js";
import { collaborationMigrations } from "./collaboration-data.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { ArcRunDefinition, RunAgentSnapshot } from "./contract.js";
import { runtimeHash } from "./hash.js";

export function graphServicesFixture(
  db: Database.Database,
  agents: AgentStore,
  bb: BbPluginApi,
) {
  db.exec(
    [
      ...teamMigrations,
      ...policyMigrations,
      ...controlMigrations,
      ...instructionUpdateMigrations,
      ...collaborationMigrations,
    ].join(";\n"),
  );
  const teams = createTeamStore(db, agents);
  const policies = createPolicyStore(db);
  const policy = createPolicyService(policies, teams, {
    async requireProject(projectId) {
      await bb.sdk.projects.get({ projectId });
    },
    async threadProject(threadId) {
      return (await bb.sdk.threads.get({ threadId })).projectId;
    },
    async listThreads(input) {
      return (await bb.sdk.threads.list(input)).map(({ id, title }) => ({
        id,
        title: title ?? "Untitled conversation",
      }));
    },
    changed() {},
  });
  return { teams, policies, policy };
}

export function runDefinitionFixture(): ArcRunDefinition {
  const metadata = defaultAgentMetadata("Builder");
  const document = serializeAgentDocument(
    metadata,
    "Follow the assigned task and preserve required checks.",
  );
  const agent: RunAgentSnapshot = {
    definition: {
      agentId: `agent_${randomUUID()}`,
      revision: 1,
      document,
      metadata,
      attachments: [],
      contentHash: runtimeHash(document),
      createdAt: 1,
    },
    execution: {
      providerId: "codex",
      model: "test-model",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "accept-edits",
    },
  };
  const selection = { agentId: agent.definition.agentId, revision: 1 };
  return {
    schemaVersion: 1,
    runId: `run_${randomUUID()}`,
    request: {
      operationId: `operation-${randomUUID()}`,
      projectId: "project-a",
      originThreadId: "thread-parent",
      hostId: "host-a",
      path: "C:/Project 東京",
      expectedHead: "a".repeat(40),
      goal: "Build and verify the requested application",
      writers: [
        { agent: selection, task: "Build the frontend" },
        { agent: selection, task: "Build the backend" },
      ],
      reviewer: selection,
      repairer: selection,
      check: { executable: "node", args: ["check.mjs"], timeoutMs: 30_000 },
    },
    source: {
      path: "C:/Project 東京",
      commonGitDir: "C:/Project 東京/.git",
      head: "a".repeat(40),
      branch: "main",
      stateHash: "b".repeat(64),
    },
    writers: [agent, agent],
    reviewer: agent,
    repairer: agent,
    createdAt: 10,
  };
}

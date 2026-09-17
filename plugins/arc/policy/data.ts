import type Database from "better-sqlite3";
import { AgentStoreError } from "../data.js";
import {
  defaultRunPolicy,
  defaultSessionOverrides,
  resolveRunPolicy,
  resolvedRunPolicySchema,
  sessionPolicyOverridesSchema,
  type PolicyTarget,
  type ResolvedRunPolicy,
  type SessionPolicyOverrides,
} from "./contract.js";

export const policyMigrations = [
  `CREATE TABLE arc_policy_revisions (
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    value_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, scope_key, version)
  )`,
];
interface PolicyRow {
  version: number;
  valueJson: string;
  createdAt: number;
}
const SELECT =
  "SELECT version, value_json AS valueJson, created_at AS createdAt FROM arc_policy_revisions";
const key = (threadId: string | null) =>
  threadId === null ? "project" : `thread:${threadId}`;

export function createPolicyStore(db: Database.Database) {
  function latest(target: PolicyTarget) {
    return db
      .prepare<[string, string], PolicyRow>(
        `${SELECT} WHERE project_id = ? AND scope_key = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(target.projectId, key(target.threadId));
  }
  function project(projectId: string) {
    const row = latest({ projectId, threadId: null });
    return {
      projectId,
      version: row?.version ?? 0,
      policy: row
        ? resolvedRunPolicySchema.parse(JSON.parse(row.valueJson))
        : defaultRunPolicy(),
      createdAt: row?.createdAt ?? null,
    };
  }
  function session(projectId: string, threadId: string) {
    const row = latest({ projectId, threadId });
    return {
      projectId,
      threadId,
      version: row?.version ?? 0,
      overrides: row
        ? sessionPolicyOverridesSchema.parse(JSON.parse(row.valueJson))
        : defaultSessionOverrides(),
      createdAt: row?.createdAt ?? null,
    };
  }
  function view(target: PolicyTarget) {
    const currentProject = project(target.projectId);
    const currentSession =
      target.threadId === null
        ? null
        : session(target.projectId, target.threadId);
    try {
      return {
        project: currentProject,
        session: currentSession,
        effective:
          currentSession === null
            ? currentProject.policy
            : resolveRunPolicy(currentProject.policy, currentSession.overrides),
        errors: [],
      };
    } catch {
      return {
        project: currentProject,
        session: currentSession,
        effective: null,
        errors: [
          "The project's current team restriction conflicts with this session's preferences. Update the session before starting work.",
        ],
      };
    }
  }
  function save(
    target: PolicyTarget,
    expectedVersion: number,
    value: ResolvedRunPolicy | SessionPolicyOverrides,
  ) {
    const current = latest(target);
    if ((current?.version ?? 0) !== expectedVersion)
      throw new AgentStoreError(
        "policy_conflict",
        "These settings changed elsewhere. Reload and review them before saving.",
      );
    db.prepare(
      "INSERT INTO arc_policy_revisions (project_id, scope_key, version, value_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      target.projectId,
      key(target.threadId),
      expectedVersion + 1,
      JSON.stringify(value),
      Date.now(),
    );
  }
  return {
    project,
    session,
    view,
    saveProject(input: {
      projectId: string;
      expectedVersion: number;
      policy: ResolvedRunPolicy;
    }) {
      return db.transaction(() => {
        const policy = resolvedRunPolicySchema.parse(input.policy);
        save(
          { projectId: input.projectId, threadId: null },
          input.expectedVersion,
          policy,
        );
        return project(input.projectId);
      })();
    },
    saveSession(input: {
      projectId: string;
      threadId: string;
      expectedVersion: number;
      overrides: SessionPolicyOverrides;
    }) {
      return db.transaction(() => {
        const overrides = sessionPolicyOverridesSchema.parse(input.overrides);
        resolveRunPolicy(project(input.projectId).policy, overrides);
        save(input, input.expectedVersion, overrides);
        return view(input);
      })();
    },
    resolve(
      target: PolicyTarget & {
        expectedProjectPolicyVersion: number;
        expectedSessionPolicyVersion: number;
      },
    ) {
      const value = view(target);
      if (
        value.project.version !== target.expectedProjectPolicyVersion ||
        (value.session?.version ?? 0) !== target.expectedSessionPolicyVersion
      )
        throw new AgentStoreError(
          "policy_conflict",
          "Orchestration settings changed. Review the current settings before starting this run.",
        );
      if (value.effective === null)
        throw new AgentStoreError("policy_invalid", value.errors.join(" "));
      return value.effective;
    },
    history(target: PolicyTarget & { limit: number; offset: number }) {
      const rows = db
        .prepare<[string, string, number, number], PolicyRow>(
          `${SELECT} WHERE project_id = ? AND scope_key = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
        )
        .all(
          target.projectId,
          key(target.threadId),
          target.limit,
          target.offset,
        );
      const total = db
        .prepare<[string, string], { total: number }>(
          "SELECT COUNT(*) AS total FROM arc_policy_revisions WHERE project_id = ? AND scope_key = ?",
        )
        .get(target.projectId, key(target.threadId))!.total;
      return {
        revisions: rows.map((row) => ({
          version: row.version,
          value:
            target.threadId === null
              ? resolvedRunPolicySchema.parse(JSON.parse(row.valueJson))
              : sessionPolicyOverridesSchema.parse(JSON.parse(row.valueJson)),
          createdAt: row.createdAt,
        })),
        total,
      };
    },
  };
}
export type PolicyStore = ReturnType<typeof createPolicyStore>;

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./data.js";
import {
  canonicalOwnedJson,
  ownedControlReceiptSchema,
  ownedControlWaitReasonSchema,
  ownedDependencyReceiptSchema,
  ownedRunStartInputSchema,
  ownedRepairCatalogSchema,
  ownedRunViewSchema,
  ownedStepObservationInputSchema,
  ownedStepRequestInputSchema,
  ownedStepResourceV2Schema,
  ownedStepRefKey,
  resolveOwnedRequirements,
  type OwnedAdmittedStep,
  type OwnedAdmittedStepV2,
  type OwnedReceiptRequirement,
  type OwnedDependencyReceipt,
  type OwnedLaneClaim,
  type OwnedRunControl,
  type OwnedRunStartInput,
  type OwnedRunView,
  type OwnedRepairCatalog,
  type OwnedStepObservationInput,
  type OwnedStepRef,
  type OwnedStepRequestInput,
} from "./owned-contract.js";
import type { JsonValue } from "./types.js";

export const OWNED_ACTIVE_INTERVAL_MS = 1000;

export const ownedThreadLookupMigration = `CREATE INDEX workflow_owned_thread_lookup ON workflow_owned_runs(owner_plugin_id, json_extract(request_json, '$.projectId'), json_extract(request_json, '$.originThreadId'), created_at DESC, id DESC) WHERE state NOT IN ('succeeded', 'failed', 'cancelled');`;

export function findActiveOwnedThreadRuns(
  db: Db,
  owner: string,
  input: { projectId: string; originThreadIds: string[] },
) {
  return db
    .prepare<
      [string, string, string],
      {
        workflowRunId: string;
        ownerRunId: string;
        originThreadId: string;
        state: OwnedRunView["state"];
        createdAt: number;
      }
    >(`WITH ranked AS (
    SELECT id AS workflowRunId, owner_run_id AS ownerRunId,
      json_extract(request_json, '$.originThreadId') AS originThreadId, state, created_at AS createdAt,
      row_number() OVER (PARTITION BY json_extract(request_json, '$.originThreadId') ORDER BY created_at DESC, id DESC) AS position
    FROM workflow_owned_runs WHERE owner_plugin_id = ?
      AND json_extract(request_json, '$.projectId') = ?
      AND json_extract(request_json, '$.originThreadId') IN (SELECT value FROM json_each(?))
      AND state NOT IN ('succeeded', 'failed', 'cancelled')
  ) SELECT workflowRunId, ownerRunId, originThreadId, state, createdAt FROM ranked WHERE position = 1 ORDER BY originThreadId`)
    .all(owner, input.projectId, JSON.stringify(input.originThreadIds));
}

export const ownedMigration = `
CREATE TABLE workflow_owned_runs (
  id TEXT PRIMARY KEY, owner_plugin_id TEXT NOT NULL, owner_run_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
  desired_control TEXT NOT NULL, control_version INTEGER NOT NULL DEFAULT 0,
  dispatch_generation INTEGER NOT NULL DEFAULT 0, agent_calls INTEGER NOT NULL DEFAULT 0,
  charged_active_ms INTEGER NOT NULL DEFAULT 0, result_json TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  UNIQUE(owner_plugin_id, owner_run_id)
);
CREATE INDEX workflow_owned_runs_state_idx ON workflow_owned_runs(state, created_at);
CREATE TABLE workflow_owned_controls (
  run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id), operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, operation_id)
);
CREATE TABLE workflow_steps (
  run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id), node_id TEXT NOT NULL, iteration INTEGER NOT NULL,
  input_hash TEXT NOT NULL, input_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  dependencies_json TEXT NOT NULL, selected_effect_id TEXT,
  PRIMARY KEY(run_id, node_id, iteration)
);
CREATE TABLE workflow_attempts (
  effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id),
  node_id TEXT NOT NULL, iteration INTEGER NOT NULL, attempt INTEGER NOT NULL,
  kind TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL,
  resource_json TEXT, terminal_state TEXT, terminal_receipt_json TEXT, terminal_receipt_hash TEXT,
  validity_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, dispatched_at INTEGER NOT NULL,
  observed_at INTEGER, finished_at INTEGER,
  UNIQUE(run_id, node_id, iteration, attempt)
);
CREATE INDEX workflow_attempts_active_idx ON workflow_attempts(state, observed_at);
CREATE INDEX workflow_attempts_run_idx ON workflow_attempts(run_id, node_id, iteration, attempt);
CREATE TABLE workflow_repair_rounds (
  run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id), stage_id TEXT NOT NULL,
  round INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, stage_id, round)
);
CREATE TABLE workflow_lanes (
  lane_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, fence INTEGER NOT NULL,
  run_id TEXT, effect_id TEXT, acquired_at INTEGER, released_at INTEGER
);
CREATE TABLE workflow_active_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id),
  generation INTEGER NOT NULL, opened_at INTEGER NOT NULL, reserved_ms INTEGER NOT NULL,
  settled_ms INTEGER, closed_at INTEGER, uncertain INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX workflow_active_intervals_open_idx ON workflow_active_intervals(run_id) WHERE closed_at IS NULL;
`;

export const ownedControlMigration = `
ALTER TABLE workflow_attempts ADD COLUMN control_revision INTEGER;
ALTER TABLE workflow_attempts ADD COLUMN wait_reason TEXT;
`;

export const ownedValidationMigration = `
ALTER TABLE workflow_attempts ADD COLUMN validation_generation INTEGER;
`;

export const ownedValidationRequestMigration = `
ALTER TABLE workflow_attempts ADD COLUMN validation_request_id TEXT;
ALTER TABLE workflow_attempts ADD COLUMN validation_request_generation INTEGER;
`;

export const ownedContinuationMigration = `
CREATE TABLE workflow_owned_continuations (
  predecessor_run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id),
  operation_id TEXT NOT NULL, owner_plugin_id TEXT NOT NULL,
  successor_owner_run_id TEXT NOT NULL, reservation_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved', 'retiring', 'started', 'cancelled')),
  successor_request_hash TEXT, successor_request_json TEXT,
  successor_run_id TEXT UNIQUE REFERENCES workflow_owned_runs(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(predecessor_run_id, operation_id),
  UNIQUE(owner_plugin_id, successor_owner_run_id)
);
CREATE UNIQUE INDEX workflow_owned_continuations_predecessor_idx
  ON workflow_owned_continuations(predecessor_run_id) WHERE state <> 'cancelled';
CREATE INDEX workflow_owned_continuations_state_idx
  ON workflow_owned_continuations(state, created_at);
CREATE TABLE workflow_owned_repair_baselines (
  run_id TEXT NOT NULL REFERENCES workflow_owned_runs(id),
  stage_id TEXT NOT NULL, rounds INTEGER NOT NULL CHECK(rounds > 0),
  PRIMARY KEY(run_id, stage_id)
);
`;

export const ownedRuleContinuationMigration = `
ALTER TABLE workflow_owned_continuations ADD COLUMN rule_authorization_json TEXT;
CREATE TABLE workflow_owned_repair_catalogs (
  run_id TEXT PRIMARY KEY REFERENCES workflow_owned_runs(id),
  catalog_json TEXT NOT NULL
);
`;

const runRowSchema = z.object({
  id: z.string(),
  owner_plugin_id: z.string(),
  owner_run_id: z.string(),
  request_hash: z.string(),
  request_json: z.string(),
  state: ownedRunViewSchema.shape.state,
  desired_control: ownedRunViewSchema.shape.desiredControl,
  control_version: z.number(),
  dispatch_generation: z.number(),
  agent_calls: z.number(),
  charged_active_ms: z.number(),
  result_json: z.string().nullable(),
  error: z.string().nullable(),
  failure_requested: z.number().int().min(0).max(1),
  created_at: z.number(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
});

const attemptRowSchema = z.object({
  effect_id: z.string(),
  run_id: z.string(),
  node_id: z.string(),
  iteration: z.number(),
  attempt: z.number(),
  kind: z.enum(["agent", "host-effect", "owner-control"]),
  request_hash: z.string(),
  request_json: z.string(),
  state: z.enum([
    "dispatched",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "interrupted",
    "not-started",
    "needs-reconciliation",
  ]),
  resource_json: z.string().nullable(),
  terminal_state: z.enum(["succeeded", "failed", "interrupted"]).nullable(),
  terminal_receipt_json: z.string().nullable(),
  terminal_receipt_hash: z.string().nullable(),
  validity_json: z.string().nullable(),
  validation_generation: z.number().int().nonnegative().nullable(),
  validation_request_id: z.string().nullable(),
  validation_request_generation: z.number().int().nonnegative().nullable(),
  last_error: z.string().nullable(),
  created_at: z.number(),
  dispatched_at: z.number(),
  observed_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  control_revision: z.number().int().nonnegative().nullable(),
  wait_reason: ownedControlWaitReasonSchema.nullable(),
});

const stepRowSchema = z.object({
  run_id: z.string(),
  node_id: z.string(),
  iteration: z.number(),
  input_hash: z.string(),
  input_json: z.string(),
  definition_hash: z.string(),
  dependencies_json: z.string(),
  selected_effect_id: z.string().nullable(),
});

export interface OwnedRunRecord {
  row: z.infer<typeof runRowSchema>;
  input: OwnedRunStartInput;
}

export interface OwnedAttemptRecord {
  row: z.infer<typeof attemptRowSchema>;
  request: OwnedStepRequestInput;
}

export interface OwnedValidationRequest {
  id: string;
  generation: number;
}

export class OwnedAdmissionBlocked extends Error {}
export class OwnedBudgetExhausted extends Error {}
export class OwnedStepUnselected extends Error {}

export function hashOwnedValue(value: JsonValue): string {
  return createHash("sha256").update(canonicalOwnedJson(value)).digest("hex");
}

export function getOwnedRun(db: Db, id: string): OwnedRunRecord | null {
  const raw = db
    .prepare("SELECT * FROM workflow_owned_runs WHERE id = ?")
    .get(id);
  if (raw === undefined) return null;
  const row = runRowSchema.parse(raw);
  return {
    row,
    input: ownedRunStartInputSchema.parse(JSON.parse(row.request_json)),
  };
}

export function requireOwnedRun(db: Db, id: string): OwnedRunRecord {
  const run = getOwnedRun(db, id);
  if (run === null) throw new Error(`Unknown owned workflow run ${id}`);
  return run;
}

export function requireOwnedOwner(
  db: Db,
  id: string,
  owner: string,
): OwnedRunRecord {
  const run = requireOwnedRun(db, id);
  if (run.row.owner_plugin_id !== owner)
    throw new Error("This workflow run belongs to another owner");
  return run;
}

export function getOwnedAttempt(
  db: Db,
  effectId: string,
): OwnedAttemptRecord | null {
  const raw = db
    .prepare("SELECT * FROM workflow_attempts WHERE effect_id = ?")
    .get(effectId);
  if (raw === undefined) return null;
  const row = attemptRowSchema.parse(raw);
  return {
    row,
    request: ownedStepRequestInputSchema.parse(JSON.parse(row.request_json)),
  };
}

export function requireOwnedAttempt(
  db: Db,
  effectId: string,
): OwnedAttemptRecord {
  const attempt = getOwnedAttempt(db, effectId);
  if (attempt === null)
    throw new Error(`Unknown owned workflow effect ${effectId}`);
  return attempt;
}

export function reserveOwnedValidationRequest(
  db: Db,
  effectId: string,
  generation: number,
): OwnedValidationRequest {
  return db.transaction(() => {
    const attempt = requireOwnedAttempt(db, effectId);
    const run = requireOwnedRun(db, attempt.row.run_id);
    if (
      run.row.dispatch_generation !== generation ||
      run.row.desired_control !== "run" ||
      run.row.state !== "running" ||
      ownedTerminalObservation(attempt) === null
    )
      throw new OwnedAdmissionBlocked("Workflow validation dispatch is held");
    const request = { id: randomUUID(), generation };
    db.prepare(
      "UPDATE workflow_attempts SET validation_request_id = ?, validation_request_generation = ? WHERE effect_id = ?",
    ).run(request.id, request.generation, effectId);
    return request;
  })();
}

export function pendingOwnedValidationRequests(db: Db): OwnedAttemptRecord[] {
  return db
    .prepare(`SELECT a.* FROM workflow_attempts a
    JOIN workflow_steps s ON s.selected_effect_id = a.effect_id
    JOIN workflow_owned_runs r ON r.id = a.run_id
    WHERE a.validation_request_id IS NOT NULL
    AND r.state NOT IN ('succeeded', 'failed', 'cancelled')
    ORDER BY a.observed_at, a.created_at LIMIT 100`)
    .all()
    .map((raw) => {
      const row = attemptRowSchema.parse(raw);
      return {
        row,
        request: ownedStepRequestInputSchema.parse(
          JSON.parse(row.request_json),
        ),
      };
    });
}

function count(db: Db, sql: string, ...values: Array<string | number>): number {
  return z.object({ count: z.number() }).parse(db.prepare(sql).get(...values))
    .count;
}

export function activeOwnedAttempts(
  db: Db,
  runId?: string,
): OwnedAttemptRecord[] {
  const sql =
    "SELECT * FROM workflow_attempts WHERE state IN ('dispatched', 'running', 'waiting', 'needs-reconciliation')";
  const rows =
    runId === undefined
      ? db.prepare(`${sql} ORDER BY observed_at, created_at LIMIT 100`).all()
      : db
          .prepare(`${sql} AND run_id = ? ORDER BY created_at LIMIT 4096`)
          .all(runId);
  return rows.map((raw) => {
    const row = attemptRowSchema.parse(raw);
    return {
      row,
      request: ownedStepRequestInputSchema.parse(JSON.parse(row.request_json)),
    };
  });
}

export function checkingOwnedAttempts(
  db: Db,
  runId?: string,
): OwnedAttemptRecord[] {
  const rows = db
    .prepare(`SELECT a.* FROM workflow_attempts a
    JOIN workflow_steps s ON s.selected_effect_id = a.effect_id
    JOIN workflow_owned_runs r ON r.id = a.run_id
    WHERE json_extract(a.validity_json, '$.state') = 'checking'
    AND r.state NOT IN ('succeeded', 'failed', 'cancelled')
    ${runId === undefined ? "" : "AND a.run_id = ?"}
    ORDER BY a.observed_at, a.created_at LIMIT ${runId === undefined ? 100 : 4096}`)
    .all(...(runId === undefined ? [] : [runId]));
  return rows.map((raw) => {
    const row = attemptRowSchema.parse(raw);
    return {
      row,
      request: ownedStepRequestInputSchema.parse(JSON.parse(row.request_json)),
    };
  });
}

export function outdatedOwnedValidationAttempts(db: Db): OwnedAttemptRecord[] {
  return db
    .prepare(`SELECT a.* FROM workflow_attempts a
    JOIN workflow_steps s ON s.selected_effect_id = a.effect_id
    JOIN workflow_owned_runs r ON r.id = a.run_id
    WHERE r.state = 'running' AND r.desired_control = 'run'
    AND json_extract(a.validity_json, '$.state') = 'current'
    AND json_type(a.validity_json, '$.validationId') = 'text'
    AND (a.validation_generation IS NULL OR a.validation_generation != r.dispatch_generation)
    ORDER BY a.observed_at, a.created_at LIMIT 100`)
    .all()
    .map((raw) => {
      const row = attemptRowSchema.parse(raw);
      return {
        row,
        request: ownedStepRequestInputSchema.parse(
          JSON.parse(row.request_json),
        ),
      };
    });
}

export function unverifiedOwnedValidationAttempts(
  db: Db,
  runId: string,
): OwnedAttemptRecord[] {
  return db
    .prepare(`SELECT a.* FROM workflow_attempts a
    JOIN workflow_steps s ON s.selected_effect_id = a.effect_id
    JOIN workflow_owned_runs r ON r.id = a.run_id
    WHERE a.run_id = ? AND (a.validation_request_id IS NOT NULL OR
    (json_type(a.validity_json, '$.validationId') = 'text'
    AND (json_extract(a.validity_json, '$.state') != 'current' OR a.validation_generation IS NULL OR a.validation_generation != r.dispatch_generation)))
    ORDER BY a.observed_at, a.created_at LIMIT 4096`)
    .all(runId)
    .map((raw) => {
      const row = attemptRowSchema.parse(raw);
      return {
        row,
        request: ownedStepRequestInputSchema.parse(
          JSON.parse(row.request_json),
        ),
      };
    });
}

export function hasRunningOwnedValidation(db: Db, runId: string): boolean {
  return (
    count(
      db,
      `SELECT COUNT(*) AS count FROM workflow_attempts a
    JOIN workflow_steps s ON s.selected_effect_id = a.effect_id
    JOIN workflow_owned_runs r ON r.id = a.run_id
    WHERE a.run_id = ? AND r.state NOT IN ('succeeded', 'failed', 'cancelled')
    AND (a.validation_request_id IS NOT NULL OR
    (json_extract(a.validity_json, '$.state') = 'checking'
    AND json_extract(a.validity_json, '$.activity') = 'running'))`,
      runId,
    ) > 0
  );
}

export function viewOwnedRun(db: Db, id: string): OwnedRunView {
  const { row, input } = requireOwnedRun(db, id);
  return ownedRunViewSchema.parse({
    workflowRunId: id,
    ownerRunId: row.owner_run_id,
    projectId: input.projectId,
    originThreadId: input.originThreadId,
    planHash: input.planHash,
    state: row.state,
    desiredControl: row.desired_control,
    controlVersion: row.control_version,
    dispatchGeneration: row.dispatch_generation,
    limits: input.limits,
    agentCalls: row.agent_calls,
    activeAgents: count(
      db,
      "SELECT COUNT(*) AS count FROM workflow_attempts WHERE run_id = ? AND kind = 'agent' AND state IN ('dispatched', 'running', 'needs-reconciliation')",
      id,
    ),
    chargedActiveMs: row.charged_active_ms,
    repairRounds: db
      .prepare(
        `SELECT stage_id AS stageId, SUM(rounds) AS rounds FROM (
          SELECT stage_id, MAX(round) AS rounds FROM workflow_repair_rounds WHERE run_id = ? GROUP BY stage_id
          UNION ALL SELECT stage_id, rounds FROM workflow_owned_repair_baselines WHERE run_id = ?
        ) GROUP BY stage_id`,
      )
      .all(id, id),
    result:
      row.result_json === null
        ? { available: false }
        : { available: true, value: JSON.parse(row.result_json) },
    error: row.error,
  });
}

export function createOwnedRun(
  db: Db,
  owner: string,
  input: OwnedRunStartInput,
  now = Date.now(),
): OwnedRunView {
  return db.transaction(() => {
    if (
      db
        .prepare(
          "SELECT 1 FROM workflow_owned_continuations WHERE owner_plugin_id = ? AND successor_owner_run_id = ?",
        )
        .get(owner, input.ownerRunId) !== undefined
    )
      throw new Error("Reserved successor requires continuation admission");
    const requestHash = hashOwnedValue({ owner, input });
    const existing = db
      .prepare(
        "SELECT id, request_hash FROM workflow_owned_runs WHERE owner_plugin_id = ? AND owner_run_id = ?",
      )
      .get(owner, input.ownerRunId);
    if (existing !== undefined) {
      const row = z
        .object({ id: z.string(), request_hash: z.string() })
        .parse(existing);
      if (row.request_hash !== requestHash)
        throw new Error("Owner run identity was reused with different content");
      return viewOwnedRun(db, row.id);
    }
    const id = `wfo_${randomUUID()}`;
    db.prepare(
      "INSERT INTO workflow_owned_runs (id, owner_plugin_id, owner_run_id, request_hash, request_json, state, desired_control, created_at) VALUES (?, ?, ?, ?, ?, 'queued', 'run', ?)",
    ).run(
      id,
      owner,
      input.ownerRunId,
      requestHash,
      canonicalOwnedJson(input),
      now,
    );
    return viewOwnedRun(db, id);
  })();
}

export function countActiveWorkflowRuns(db: Db): number {
  return count(
    db,
    `SELECT (
    (SELECT COUNT(*) FROM workflow_runs WHERE status = 'running') +
    (SELECT COUNT(*) FROM workflow_owned_runs r WHERE r.state IN ('running', 'pausing', 'cancelling', 'needs-reconciliation') OR EXISTS (
      SELECT 1 FROM workflow_attempts a WHERE a.run_id = r.id AND (a.state IN ('dispatched', 'running', 'needs-reconciliation') OR a.validation_request_id IS NOT NULL OR (json_extract(a.validity_json, '$.state') = 'checking' AND json_extract(a.validity_json, '$.activity') = 'running'))
    ))
  ) AS count`,
  );
}

export function claimOwnedRun(
  db: Db,
  maximum: number,
  now = Date.now(),
): OwnedRunRecord | null {
  return db.transaction(() => {
    const raw = db
      .prepare(
        "SELECT id FROM workflow_owned_runs WHERE state = 'queued' AND desired_control = 'run' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (raw === undefined) return null;
    const { id } = z.object({ id: z.string() }).parse(raw);
    const alreadyActive =
      hasRunningOwnedValidation(db, id) ||
      activeOwnedAttempts(db, id).some(
        (attempt) => attempt.row.state !== "waiting",
      );
    if (countActiveWorkflowRuns(db) - Number(alreadyActive) >= maximum)
      return null;
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state = 'queued'",
    ).run(now, id);
    return requireOwnedRun(db, id);
  })();
}

function hasStaleOwnedReceipts(db: Db, runId: string): boolean {
  return (
    count(
      db,
      "SELECT COUNT(*) AS count FROM workflow_steps s JOIN workflow_attempts a ON a.effect_id = s.selected_effect_id WHERE s.run_id = ? AND json_extract(a.validity_json, '$.state') = 'stale'",
      runId,
    ) > 0
  );
}

function hasUnverifiedOwnedValidation(
  db: Db,
  runId: string,
  generation: number,
): boolean {
  return (
    count(
      db,
      `SELECT COUNT(*) AS count FROM workflow_steps s
    JOIN workflow_attempts a ON a.effect_id = s.selected_effect_id
    WHERE s.run_id = ? AND (a.validation_request_id IS NOT NULL OR
    (json_type(a.validity_json, '$.validationId') = 'text'
    AND (json_extract(a.validity_json, '$.state') != 'current' OR a.validation_generation IS NULL OR a.validation_generation != ?)))`,
      runId,
      generation,
    ) > 0
  );
}

function hasUntaggedStaleOwnedReceipts(db: Db, runId: string): boolean {
  return (
    count(
      db,
      `SELECT COUNT(*) AS count FROM workflow_steps s
    JOIN workflow_attempts a ON a.effect_id = s.selected_effect_id
    WHERE s.run_id = ? AND json_extract(a.validity_json, '$.state') = 'stale'
    AND json_type(a.validity_json, '$.validationId') IS NOT 'text'`,
      runId,
    ) > 0
  );
}

export function controlOwnedRun(
  db: Db,
  owner: string,
  input: OwnedRunControl,
  now = Date.now(),
  continuationOperationId: string | null = null,
): OwnedRunView {
  return db.transaction(() => {
    const run = requireOwnedOwner(db, input.workflowRunId, owner);
    const reservation = db
      .prepare(
        "SELECT operation_id, state FROM workflow_owned_continuations WHERE predecessor_run_id = ? AND state <> 'cancelled'",
      )
      .get(input.workflowRunId);
    if (reservation !== undefined) {
      const retained = z
        .object({ operation_id: z.string(), state: z.string() })
        .parse(reservation);
      if (
        input.action !== "cancel" ||
        retained.state !== "retiring" ||
        retained.operation_id !== continuationOperationId
      )
        throw new Error(
          "Workflow controls are held by a continuation reservation",
        );
    }
    const requestHash = hashOwnedValue(input);
    const existing = db
      .prepare(
        "SELECT request_hash, result_json FROM workflow_owned_controls WHERE run_id = ? AND operation_id = ?",
      )
      .get(input.workflowRunId, input.operationId);
    if (existing !== undefined) {
      const record = z
        .object({ request_hash: z.string(), result_json: z.string() })
        .parse(existing);
      if (record.request_hash !== requestHash)
        throw new Error(
          "Control operation identity was reused with different content",
        );
      return ownedRunViewSchema.parse(JSON.parse(record.result_json));
    }
    if (run.row.control_version !== input.expectedVersion)
      throw new Error("Workflow control version changed");
    if (["succeeded", "failed", "cancelled"].includes(run.row.state))
      throw new Error("Workflow run is already terminal");
    const stale = hasStaleOwnedReceipts(db, input.workflowRunId);
    const recheck =
      stale &&
      run.row.desired_control === "pause" &&
      activeOwnedAttempts(db, run.row.id).length === 0 &&
      !hasRunningOwnedValidation(db, run.row.id) &&
      !hasUntaggedStaleOwnedReceipts(db, run.row.id);
    if (
      input.action === "resume" &&
      !recheck &&
      (run.row.state !== "paused" || stale)
    )
      throw new Error("Reconcile and pause all native work before resuming");
    const active =
      hasRunningOwnedValidation(db, input.workflowRunId) ||
      activeOwnedAttempts(db, input.workflowRunId).some(
        (attempt) =>
          input.action !== "pause" || attempt.row.state !== "waiting",
      );
    const state =
      input.action === "resume"
        ? "queued"
        : input.action === "pause"
          ? stale
            ? "needs-reconciliation"
            : active
              ? "pausing"
              : "paused"
          : active
            ? "cancelling"
            : "cancelled";
    const desired = input.action === "resume" ? "run" : input.action;
    db.prepare(
      "UPDATE workflow_owned_runs SET state = ?, desired_control = ?, control_version = control_version + 1, dispatch_generation = dispatch_generation + 1, failure_requested = 0, error = CASE WHEN ? = 'pause' THEN error ELSE NULL END, finished_at = ? WHERE id = ?",
    ).run(
      state,
      desired,
      input.action,
      state === "cancelled" ? now : null,
      input.workflowRunId,
    );
    if (state === "cancelled")
      db.prepare(
        "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE run_id = ?",
      ).run(now, input.workflowRunId);
    const view = viewOwnedRun(db, input.workflowRunId);
    db.prepare(
      "INSERT INTO workflow_owned_controls (run_id, operation_id, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      input.workflowRunId,
      input.operationId,
      requestHash,
      canonicalOwnedJson(view),
      now,
    );
    return view;
  })();
}

export function ownedTerminalObservation(
  attempt: OwnedAttemptRecord,
): Extract<
  OwnedStepObservationInput,
  { state: "succeeded" | "failed" | "interrupted" }
> | null {
  const row = attempt.row;
  if (
    row.terminal_state === null ||
    row.terminal_receipt_json === null ||
    row.terminal_receipt_hash === null ||
    row.validity_json === null
  )
    return null;
  const observation = ownedStepObservationInputSchema.parse({
    state: row.terminal_state,
    resource: row.resource_json === null ? null : JSON.parse(row.resource_json),
    receipt: JSON.parse(row.terminal_receipt_json),
    receiptHash: row.terminal_receipt_hash,
    validity: JSON.parse(row.validity_json),
  });
  if (
    observation.state !== "succeeded" &&
    observation.state !== "failed" &&
    observation.state !== "interrupted"
  )
    throw new Error("Invalid terminal receipt");
  return observation;
}

export function ownedReceiptIsCurrent(
  attempt: OwnedAttemptRecord,
  generation: number,
): boolean {
  const observation = ownedTerminalObservation(attempt);
  return (
    attempt.row.validation_request_id === null &&
    observation?.validity.state === "current" &&
    (!("validationId" in observation.validity) ||
      attempt.row.validation_generation === generation)
  );
}

export function selectedOwnedAttempt(
  db: Db,
  runId: string,
  ref: OwnedStepRef,
): OwnedAttemptRecord | null {
  const raw = db
    .prepare(
      "SELECT selected_effect_id FROM workflow_steps WHERE run_id = ? AND node_id = ? AND iteration = ?",
    )
    .get(runId, ref.nodeId, ref.iteration);
  if (raw === undefined) return null;
  const { selected_effect_id: effectId } = z
    .object({ selected_effect_id: z.string().nullable() })
    .parse(raw);
  return effectId === null ? null : requireOwnedAttempt(db, effectId);
}

function dependencyReceipts(
  db: Db,
  runId: string,
  step: OwnedAdmittedStep,
): OwnedDependencyReceipt[] {
  const generation = requireOwnedRun(db, runId).row.dispatch_generation;
  return step.dependencies.map((dependency) => {
    const attempt = selectedOwnedAttempt(db, runId, dependency);
    const observation =
      attempt === null ? null : ownedTerminalObservation(attempt);
    if (
      attempt === null ||
      observation === null ||
      observation.state !== dependency.requiredOutcome ||
      !ownedReceiptIsCurrent(attempt, generation)
    ) {
      throw new OwnedAdmissionBlocked(
        `Required ${dependency.requiredOutcome} receipt is unavailable for ${dependency.nodeId} iteration ${dependency.iteration}`,
      );
    }
    return {
      nodeId: dependency.nodeId,
      iteration: dependency.iteration,
      effectId: attempt.row.effect_id,
      receiptHash: observation.receiptHash,
      outcome: dependency.requiredOutcome,
    };
  });
}

export function ownedStepDependencyReceipts(
  db: Db,
  runId: string,
  step: OwnedAdmittedStep | OwnedAdmittedStepV2,
): OwnedDependencyReceipt[] {
  if ("dependencies" in step) return dependencyReceipts(db, runId, step);
  const generation = requireOwnedRun(db, runId).row.dispatch_generation;
  const collected = new Map<string, OwnedDependencyReceipt>();
  function receipt(requirement: OwnedReceiptRequirement) {
    const attempt = selectedOwnedAttempt(db, runId, requirement.step);
    const observation =
      attempt === null ? null : ownedTerminalObservation(attempt);
    if (
      attempt === null ||
      observation === null ||
      !ownedReceiptIsCurrent(attempt, generation)
    )
      throw new OwnedAdmissionBlocked(
        `Required receipt is unavailable for ${requirement.step.nodeId}`,
      );
    if (
      observation.state === "interrupted" ||
      !requirement.outcomes.includes(observation.state)
    )
      throw new Error(
        `Required outcome did not match for ${requirement.step.nodeId}`,
      );
    const value: OwnedDependencyReceipt = {
      ...requirement.step,
      effectId: attempt.row.effect_id,
      receiptHash: observation.receiptHash,
      outcome: observation.state,
    };
    collected.set(ownedStepRefKey(requirement.step), value);
    return { attempt, observation };
  }
  const resolution = resolveOwnedRequirements(step, (ref) => {
    const decision = receipt({
      kind: "receipt",
      step: ref,
      outcomes: ["succeeded", "failed"],
    });
    if (
      decision.attempt.row.kind !== "owner-control" ||
      decision.observation.resource?.kind !== "owner-control"
    )
      throw new Error("Selection requires the admitted control's receipt");
    return ownedControlReceiptSchema.parse(decision.observation.receipt);
  });
  if (resolution.state === "pending")
    throw new OwnedAdmissionBlocked(
      `Decision receipt is unavailable for ${resolution.decision.nodeId}`,
    );
  if (resolution.state === "unselected")
    throw new OwnedStepUnselected(
      `Step ${step.nodeId} was not selected by ${resolution.decision.nodeId}`,
    );
  for (const requirement of resolution.receipts) receipt(requirement);
  return [...collected.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([, value]) => value);
}

export function ownedRepairStageLimits(input: OwnedRunStartInput) {
  const limits = new Map<string, number>();
  for (const step of input.steps) {
    if (step.repair === null) continue;
    limits.set(
      step.repair.stageId,
      Math.max(limits.get(step.repair.stageId) ?? 0, step.repair.round),
    );
  }
  return Array.from(limits, ([stageId, maxRounds]) => ({
    stageId,
    maxRounds,
  })).sort((a, b) => a.stageId.localeCompare(b.stageId, "en"));
}

export function readOwnedRepairCatalog(
  db: Db,
  runId: string,
): OwnedRepairCatalog | null {
  const raw = db
    .prepare(
      "SELECT catalog_json FROM workflow_owned_repair_catalogs WHERE run_id = ?",
    )
    .get(runId);
  if (raw === undefined) return null;
  const row = z.object({ catalog_json: z.string() }).parse(raw);
  return ownedRepairCatalogSchema.parse(JSON.parse(row.catalog_json));
}

export function validateOwnedRepairCatalog(
  input: OwnedRunStartInput,
  catalog: OwnedRepairCatalog,
) {
  if (
    catalog.stages.some(
      (stage) => stage.maxRounds > input.limits.maxRepairRounds,
    )
  )
    throw new Error("Repair catalog exceeds the workflow repair limit");
  if (
    canonicalOwnedJson(
      catalog.stages.filter((stage) => stage.maxRounds > 0),
    ) !==
    canonicalOwnedJson(
      ownedRepairCatalogSchema.parse({
        schemaVersion: 1,
        stages: ownedRepairStageLimits(input),
      }).stages,
    )
  )
    throw new Error("Repair catalog does not match the immutable manifest");
}

export function admitOwnedStep(
  db: Db,
  runId: string,
  ref: OwnedStepRef,
  input: JsonValue,
  generation: number,
  now = Date.now(),
): OwnedAttemptRecord | null {
  return db.transaction(() => {
    const run = requireOwnedRun(db, runId);
    if (
      run.row.state !== "running" ||
      run.row.desired_control !== "run" ||
      run.row.dispatch_generation !== generation
    )
      throw new OwnedAdmissionBlocked("Workflow dispatch is held");
    const definition = run.input.steps.find(
      (step) => ownedStepRefKey(step) === ownedStepRefKey(ref),
    );
    if (definition === undefined)
      throw new Error("Step was not admitted by the immutable manifest");
    const dependencies = ownedStepDependencyReceipts(db, runId, definition);
    const inputHash = hashOwnedValue(input);
    const existing = db
      .prepare(
        "SELECT * FROM workflow_steps WHERE run_id = ? AND node_id = ? AND iteration = ?",
      )
      .get(runId, ref.nodeId, ref.iteration);
    let previous: OwnedAttemptRecord | null = null;
    if (existing !== undefined) {
      const row = stepRowSchema.parse(existing);
      if (
        row.input_hash !== inputHash ||
        row.definition_hash !== definition.definitionHash ||
        canonicalOwnedJson(
          ownedDependencyReceiptSchema
            .array()
            .parse(JSON.parse(row.dependencies_json)),
        ) !== canonicalOwnedJson(dependencies)
      )
        throw new Error(
          "Step identity was reused with different input, definition or dependencies",
        );
      previous =
        row.selected_effect_id === null
          ? null
          : requireOwnedAttempt(db, row.selected_effect_id);
      if (previous !== null && previous.row.state !== "interrupted")
        return previous;
    }
    if (hasUnverifiedOwnedValidation(db, runId, generation))
      throw new OwnedAdmissionBlocked(
        "Retained validation must be current before native dispatch",
      );
    if (definition.kind === "agent") {
      if (run.row.agent_calls >= run.input.limits.maxAgentCalls)
        throw new OwnedBudgetExhausted("Workflow agent-call limit exhausted");
      const active = count(
        db,
        "SELECT COUNT(*) AS count FROM workflow_attempts WHERE run_id = ? AND kind = 'agent' AND state IN ('dispatched', 'running', 'needs-reconciliation')",
        runId,
      );
      if (active >= run.input.limits.maxConcurrentAgents) return null;
    }
    if (
      run.row.charged_active_ms >= run.input.limits.maxActiveMs &&
      count(
        db,
        "SELECT COUNT(*) AS count FROM workflow_active_intervals WHERE run_id = ? AND closed_at IS NULL",
        runId,
      ) === 0
    )
      throw new OwnedBudgetExhausted("Workflow active-time limit exhausted");
    if (definition.repair !== null) {
      const stageId = definition.repair.stageId;
      const catalog = readOwnedRepairCatalog(db, runId);
      if (catalog !== null) validateOwnedRepairCatalog(run.input, catalog);
      const declaredLimit =
        (catalog?.stages ?? ownedRepairStageLimits(run.input)).find(
          (stage) => stage.stageId === stageId,
        )?.maxRounds ?? 0;
      const inherited = count(
        db,
        "SELECT COALESCE(MAX(rounds), 0) AS count FROM workflow_owned_repair_baselines WHERE run_id = ? AND stage_id = ?",
        runId,
        definition.repair.stageId,
      );
      const latest = count(
        db,
        "SELECT COALESCE(MAX(round), 0) AS count FROM workflow_repair_rounds WHERE run_id = ? AND stage_id = ?",
        runId,
        definition.repair.stageId,
      );
      if (
        inherited + definition.repair.round >
          Math.min(run.input.limits.maxRepairRounds, declaredLimit) ||
        definition.repair.round > latest + 1
      )
        throw new OwnedBudgetExhausted(
          "Workflow stage repair limit or sequence was exceeded",
        );
    }
    const effectId = `wfe_${randomUUID()}`;
    let lane: OwnedLaneClaim | null = null;
    if (definition.lane !== null) {
      const key = hashOwnedValue(definition.lane);
      const rawLane = db
        .prepare(
          "SELECT fence, effect_id FROM workflow_lanes WHERE lane_key = ?",
        )
        .get(key);
      const priorLane =
        rawLane === undefined
          ? null
          : z
              .object({ fence: z.number(), effect_id: z.string().nullable() })
              .parse(rawLane);
      if (priorLane?.effect_id !== null && priorLane?.effect_id !== undefined)
        return null;
      lane = { key, fence: (priorLane?.fence ?? 0) + 1 };
      db.prepare(
        "INSERT INTO workflow_lanes (lane_key, identity_json, fence, run_id, effect_id, acquired_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(lane_key) DO UPDATE SET fence = excluded.fence, run_id = excluded.run_id, effect_id = excluded.effect_id, acquired_at = excluded.acquired_at, released_at = NULL",
      ).run(
        key,
        canonicalOwnedJson(definition.lane),
        lane.fence,
        runId,
        effectId,
        now,
      );
    }
    const immutableRequest = {
      ...("schemaVersion" in run.input ? { schemaVersion: 2 } : {}),
      workflowRunId: runId,
      ownerRunId: run.row.owner_run_id,
      ...ref,
      attempt: (previous?.row.attempt ?? 0) + 1,
      effectId,
      definitionHash: definition.definitionHash,
      dependencyReceipts: dependencies,
      lane,
      input,
    };
    const request = ownedStepRequestInputSchema.parse({
      ...immutableRequest,
      requestHash: hashOwnedValue({
        owner: run.row.owner_plugin_id,
        ...immutableRequest,
      }),
      dispatchGeneration: generation,
    });
    db.prepare(
      "INSERT INTO workflow_steps (run_id, node_id, iteration, input_hash, input_json, definition_hash, dependencies_json, selected_effect_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, node_id, iteration) DO UPDATE SET selected_effect_id = excluded.selected_effect_id",
    ).run(
      runId,
      ref.nodeId,
      ref.iteration,
      inputHash,
      canonicalOwnedJson(input),
      definition.definitionHash,
      canonicalOwnedJson(dependencies),
      effectId,
    );
    db.prepare(
      "INSERT INTO workflow_attempts (effect_id, run_id, node_id, iteration, attempt, kind, request_hash, request_json, state, created_at, dispatched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)",
    ).run(
      effectId,
      runId,
      ref.nodeId,
      ref.iteration,
      request.attempt,
      definition.kind,
      request.requestHash,
      canonicalOwnedJson(request),
      now,
      now,
    );
    if (definition.kind === "agent")
      db.prepare(
        "UPDATE workflow_owned_runs SET agent_calls = agent_calls + 1 WHERE id = ?",
      ).run(runId);
    if (definition.repair !== null)
      db.prepare(
        "INSERT OR IGNORE INTO workflow_repair_rounds (run_id, stage_id, round, created_at) VALUES (?, ?, ?, ?)",
      ).run(runId, definition.repair.stageId, definition.repair.round, now);
    return requireOwnedAttempt(db, effectId);
  })();
}

export function recordOwnedObservation(
  db: Db,
  effectId: string,
  generation: number,
  input: OwnedStepObservationInput,
  now = Date.now(),
  validationRequest: OwnedValidationRequest | null = null,
): boolean {
  const observation = ownedStepObservationInputSchema.parse(input);
  return db.transaction(() => {
    const attempt = requireOwnedAttempt(db, effectId);
    const run = requireOwnedRun(db, attempt.row.run_id);
    if (run.row.dispatch_generation !== generation) return false;
    if (
      validationRequest !== null &&
      (attempt.row.validation_request_id !== validationRequest.id ||
        attempt.row.validation_request_generation !==
          validationRequest.generation)
    )
      return false;
    const terminal =
      observation.state === "succeeded" ||
      observation.state === "failed" ||
      observation.state === "interrupted";
    if (
      terminal &&
      hashOwnedValue(observation.receipt) !== observation.receiptHash
    )
      throw new Error("Adapter receipt hash does not match its native receipt");
    const resource = "resource" in observation ? observation.resource : null;
    if (
      observation.state === "not-started" &&
      attempt.row.resource_json !== null
    )
      throw new Error(
        "A previously bound native resource cannot become an absent effect",
      );
    if (resource !== null && resource.kind !== attempt.row.kind)
      throw new Error("Adapter resource does not match the admitted step kind");
    if (resource !== null && attempt.row.resource_json !== null) {
      const previous = ownedStepResourceV2Schema.parse(
        JSON.parse(attempt.row.resource_json),
      );
      if (
        previous.kind !== resource.kind ||
        (previous.kind === "owner-control" &&
          resource.kind === "owner-control" &&
          previous.controlId !== resource.controlId) ||
        (previous.kind === "host-effect" &&
          resource.kind === "host-effect" &&
          (previous.hostId !== resource.hostId ||
            previous.effectId !== resource.effectId)) ||
        (previous.kind === "agent" &&
          resource.kind === "agent" &&
          (previous.threadId !== resource.threadId ||
            previous.executionContextId !== resource.executionContextId ||
            (previous.environmentId !== null &&
              previous.environmentId !== resource.environmentId) ||
            (previous.turnRequestId !== null &&
              previous.turnRequestId !== resource.turnRequestId)))
      )
        throw new Error("Adapter changed an effect's bound native resource");
    }
    if (resource?.kind === "host-effect" && resource.effectId !== effectId)
      throw new Error("Host receipt belongs to another effect");
    let revision: number | null = null;
    if (observation.state === "waiting") {
      if (attempt.row.kind !== "owner-control")
        throw new Error("Only owner controls can wait without native work");
      revision = observation.revision;
    } else if (
      terminal &&
      observation.state !== "interrupted" &&
      attempt.row.kind === "owner-control"
    ) {
      if (resource?.kind !== "owner-control")
        throw new Error("A terminal owner control requires its bound resource");
      const receipt = ownedControlReceiptSchema.parse(observation.receipt);
      revision = receipt.revision;
      const step = run.input.steps.find(
        (value) => ownedStepRefKey(value) === ownedStepRefKey(attempt.request),
      );
      if (step === undefined || !("control" in step) || step.control === null)
        throw new Error("Owner control has no immutable declaration");
      for (const output of receipt.selectedOutputs) {
        const declared = step.control.outputs.find(
          (value) => value.id === output,
        );
        if (declared === undefined || declared.outcome !== observation.state)
          throw new Error(
            "Control receipt selected an undeclared output or outcome",
          );
      }
    }
    if (
      revision !== null &&
      attempt.row.control_revision !== null &&
      revision < attempt.row.control_revision
    )
      return false;
    const priorTerminal = ownedTerminalObservation(attempt);
    const priorValidity = priorTerminal?.validity;
    const priorValidationId =
      priorValidity && "validationId" in priorValidity
        ? priorValidity.validationId
        : null;
    const validationId =
      terminal && "validationId" in observation.validity
        ? observation.validity.validationId
        : null;
    if (terminal && priorValidationId !== null && validationId === null)
      return false;
    if (terminal && validationId !== null) {
      if (
        priorTerminal !== null &&
        canonicalOwnedJson(priorTerminal.resource) !==
          canonicalOwnedJson(resource)
      )
        throw new Error(
          "Validation cannot replace the retained resource identity",
        );
      if (observation.validity.state === "checking") {
        if (resource === null)
          throw new Error(
            "Pending validation requires its retained native resource",
          );
        if (priorValidationId !== null) {
          if (validationId === priorValidationId) {
            if (priorValidity?.state !== "checking") {
              if (
                run.row.desired_control === "run" ||
                observation.validity.activity !== "quiescent"
              )
                return false;
            } else {
              if (
                run.row.desired_control === "run" &&
                attempt.row.validation_generation !== generation
              )
                return false;
              if (
                priorValidity.activity === "quiescent" &&
                observation.validity.activity === "running"
              )
                return false;
            }
          } else if (
            run.row.desired_control !== "run" ||
            (priorValidity?.state === "checking" &&
              priorValidity.activity === "running" &&
              attempt.row.validation_generation === generation)
          )
            return false;
        } else if (
          run.row.desired_control !== "run" &&
          observation.validity.activity !== "quiescent"
        )
          return false;
        if (
          observation.validity.activity === "quiescent" &&
          run.row.desired_control === "run" &&
          (priorValidity?.state !== "checking" ||
            priorValidationId !== validationId ||
            attempt.row.validation_generation !== generation)
        )
          throw new Error(
            "Running validation can quiesce only its exact previously retained scan",
          );
      } else if (
        priorValidationId !== validationId ||
        attempt.row.validation_generation !== generation ||
        (priorValidity?.state === "checking" &&
          priorValidity.activity !== "running") ||
        (priorValidity?.state !== "checking" &&
          canonicalOwnedJson(priorValidity ?? null) !==
            canonicalOwnedJson(observation.validity))
      )
        return false;
    }
    if (
      priorTerminal !== null &&
      (!terminal ||
        priorTerminal.state !== observation.state ||
        priorTerminal.receiptHash !== observation.receiptHash)
    )
      throw new Error("Adapter changed an immutable terminal effect outcome");
    db.prepare(`UPDATE workflow_attempts SET state = ?, resource_json = COALESCE(?, resource_json),
      terminal_state = COALESCE(terminal_state, ?), terminal_receipt_json = COALESCE(terminal_receipt_json, ?),
      terminal_receipt_hash = COALESCE(terminal_receipt_hash, ?), validity_json = COALESCE(?, validity_json),
      last_error = ?, observed_at = ?, finished_at = COALESCE(finished_at, ?),
      control_revision = COALESCE(?, control_revision), wait_reason = ?, validation_generation = COALESCE(?, validation_generation) WHERE effect_id = ?`).run(
      observation.state,
      resource === null ? null : canonicalOwnedJson(resource),
      terminal ? observation.state : null,
      terminal ? canonicalOwnedJson(observation.receipt) : null,
      terminal ? observation.receiptHash : null,
      terminal ? canonicalOwnedJson(observation.validity) : null,
      "reason" in observation ? observation.reason : null,
      now,
      terminal || observation.state === "not-started" ? now : null,
      revision,
      observation.state === "waiting" ? observation.waitReason : null,
      validationId === null ? null : generation,
      effectId,
    );
    if (validationRequest !== null)
      db.prepare(
        "UPDATE workflow_attempts SET validation_request_id = NULL, validation_request_generation = NULL WHERE effect_id = ? AND validation_request_id = ? AND validation_request_generation = ?",
      ).run(effectId, validationRequest.id, validationRequest.generation);
    if (terminal)
      db.prepare(
        "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE effect_id = ?",
      ).run(now, effectId);
    if (terminal && observation.validity.state === "stale") {
      db.prepare(
        "UPDATE workflow_owned_runs SET state = 'needs-reconciliation', desired_control = 'pause', error = ?, control_version = control_version + 1, dispatch_generation = dispatch_generation + 1 WHERE id = ? AND desired_control = 'run'",
      ).run(observation.validity.reason, run.row.id);
    }
    return true;
  })();
}

export function markOwnedAttemptUncertain(
  db: Db,
  effectId: string,
  generation: number,
  reason: string,
  now = Date.now(),
  validationRequest: OwnedValidationRequest | null = null,
): void {
  const attempt = requireOwnedAttempt(db, effectId);
  if (
    validationRequest !== null &&
    (attempt.row.validation_request_id !== validationRequest.id ||
      attempt.row.validation_request_generation !==
        validationRequest.generation)
  )
    return;
  const terminal = ownedTerminalObservation(attempt);
  if (terminal !== null) {
    if (terminal.validity.state === "checking") {
      recordOwnedObservation(
        db,
        effectId,
        generation,
        {
          ...terminal,
          validity: {
            ...terminal.validity,
            reason:
              reason.slice(0, 16_384) || "Validation observation unavailable",
          },
        },
        now,
      );
      return;
    }
    recordOwnedObservation(
      db,
      effectId,
      generation,
      ownedStepObservationInputSchema.parse({
        ...terminal,
        validity: {
          state: "stale",
          reason: reason.slice(0, 16_384) || "Adapter unavailable",
          ...("validationId" in terminal.validity
            ? { validationId: terminal.validity.validationId }
            : {}),
        },
      }),
      now,
    );
    return;
  }
  recordOwnedObservation(
    db,
    effectId,
    generation,
    {
      state: "needs-reconciliation",
      reason: reason.slice(0, 16_384) || "Adapter unavailable",
    },
    now,
  );
  db.prepare(
    "UPDATE workflow_owned_runs SET state = 'needs-reconciliation', error = ? WHERE id = ? AND dispatch_generation = ? AND state NOT IN ('succeeded', 'failed', 'cancelled')",
  ).run(reason.slice(0, 16_384), attempt.row.run_id, generation);
}

export function requiredOwnedGateAttempts(
  db: Db,
  runId: string,
  requireCurrent = true,
): OwnedAttemptRecord[] {
  const run = requireOwnedRun(db, runId);
  const result = new Map<string, OwnedAttemptRecord>();
  for (const gate of run.input.requiredGates) {
    const candidates = gate.steps.map((ref) =>
      selectedOwnedAttempt(db, runId, ref),
    );
    const successful = candidates.filter(
      (attempt): attempt is OwnedAttemptRecord => {
        if (attempt === null) return false;
        const observation = ownedTerminalObservation(attempt);
        return (
          observation?.state === "succeeded" &&
          (!requireCurrent ||
            ownedReceiptIsCurrent(attempt, run.row.dispatch_generation))
        );
      },
    );
    if (
      gate.mode === "all"
        ? successful.length !== candidates.length
        : successful.length === 0
    )
      throw new OwnedAdmissionBlocked(
        `Required gate ${gate.gateId} has no current successful receipts`,
      );
    for (const attempt of successful)
      result.set(attempt.row.effect_id, attempt);
  }
  return [...result.values()];
}

export function finishOwnedRun(
  db: Db,
  runId: string,
  generation: number,
  result: JsonValue,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const run = requireOwnedRun(db, runId);
    if (
      run.row.state !== "running" ||
      run.row.desired_control !== "run" ||
      run.row.dispatch_generation !== generation
    )
      return false;
    requiredOwnedGateAttempts(db, runId);
    if (
      activeOwnedAttempts(db, runId).length > 0 ||
      checkingOwnedAttempts(db, runId).length > 0
    )
      throw new OwnedAdmissionBlocked("Native work is still active");
    if (hasUnverifiedOwnedValidation(db, runId, generation))
      throw new OwnedAdmissionBlocked(
        "Retained receipt validation is still pending",
      );
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'succeeded', result_json = ?, error = NULL, finished_at = ? WHERE id = ?",
    ).run(canonicalOwnedJson(result), now, runId);
    db.prepare(
      "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE run_id = ?",
    ).run(now, runId);
    return true;
  })();
}

export function failOwnedRun(
  db: Db,
  runId: string,
  generation: number,
  error: string,
  now = Date.now(),
): void {
  const run = requireOwnedRun(db, runId);
  if (
    run.row.dispatch_generation !== generation ||
    ["succeeded", "failed", "cancelled"].includes(run.row.state)
  )
    return;
  const active =
    activeOwnedAttempts(db, runId).length > 0 ||
    hasRunningOwnedValidation(db, runId);
  db.prepare(
    "UPDATE workflow_owned_runs SET state = ?, desired_control = 'cancel', failure_requested = 1, error = ?, dispatch_generation = dispatch_generation + 1, finished_at = ? WHERE id = ?",
  ).run(
    active ? "cancelling" : "failed",
    error.slice(0, 16_384),
    active ? null : now,
    runId,
  );
  if (!active)
    db.prepare(
      "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE run_id = ?",
    ).run(now, runId);
}

export function reconcileOwnedRunState(
  db: Db,
  runId: string,
  hasVm: boolean,
  now = Date.now(),
  liveDispatches: ReadonlySet<string> = new Set(),
): void {
  const run = requireOwnedRun(db, runId);
  if (["succeeded", "failed", "cancelled"].includes(run.row.state)) return;
  const attempts = activeOwnedAttempts(db, runId);
  const validationRunning = hasRunningOwnedValidation(db, runId);
  const uncertain = attempts.some(
    (attempt) =>
      attempt.row.state === "needs-reconciliation" ||
      (attempt.row.state === "dispatched" &&
        !liveDispatches.has(attempt.row.effect_id)),
  );
  const stale = hasStaleOwnedReceipts(db, runId);
  let state =
    uncertain ||
    (stale &&
      (run.row.desired_control !== "cancel" ||
        hasUntaggedStaleOwnedReceipts(db, runId)))
      ? "needs-reconciliation"
      : run.row.desired_control === "pause"
        ? validationRunning ||
          attempts.some((attempt) => attempt.row.state !== "waiting")
          ? "pausing"
          : "paused"
        : run.row.desired_control === "cancel"
          ? validationRunning || attempts.length > 0
            ? "cancelling"
            : run.row.failure_requested === 1
              ? "failed"
              : "cancelled"
          : hasVm
            ? "running"
            : "queued";
  if (
    state === "cancelled" &&
    db
      .prepare(
        "SELECT 1 FROM workflow_owned_continuations WHERE predecessor_run_id = ? AND state = 'retiring'",
      )
      .get(runId) !== undefined
  )
    state = "cancelling";
  db.prepare(
    "UPDATE workflow_owned_runs SET state = ?, finished_at = ? WHERE id = ?",
  ).run(state, ["cancelled", "failed"].includes(state) ? now : null, runId);
  if (["cancelled", "failed"].includes(state))
    db.prepare(
      "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE run_id = ?",
    ).run(now, runId);
}

export function ownedRunClockExcluded(
  db: Db,
  runId: string,
  pendingSteps: readonly OwnedStepRef[] = [],
): boolean {
  const run = requireOwnedRun(db, runId);
  if (!("schemaVersion" in run.input)) return false;
  if (
    checkingOwnedAttempts(db, runId).length > 0 ||
    hasRunningOwnedValidation(db, runId)
  )
    return false;
  const attempts = activeOwnedAttempts(db, runId);
  const excluded = (attempt: OwnedAttemptRecord) =>
    attempt.row.state === "waiting" &&
    (attempt.row.wait_reason === "user" || attempt.row.wait_reason === "ci");
  return (
    attempts.length > 0 &&
    attempts.every(excluded) &&
    pendingSteps.every((ref) => {
      const attempt = selectedOwnedAttempt(db, runId, ref);
      return attempt !== null && excluded(attempt);
    })
  );
}

export function reserveOwnedActiveInterval(
  db: Db,
  runId: string,
  generation: number,
  now = Date.now(),
  pendingSteps: readonly OwnedStepRef[] = [],
): number {
  return db.transaction(() => {
    const run = requireOwnedRun(db, runId);
    if (
      run.row.dispatch_generation !== generation ||
      ["succeeded", "failed", "cancelled", "paused"].includes(run.row.state) ||
      (run.row.desired_control !== "run" &&
        !hasRunningOwnedValidation(db, runId) &&
        !activeOwnedAttempts(db, runId).some(
          (attempt) => attempt.row.state !== "waiting",
        )) ||
      ownedRunClockExcluded(db, runId, pendingSteps)
    )
      return 0;
    const existing = db
      .prepare(
        "SELECT reserved_ms FROM workflow_active_intervals WHERE run_id = ? AND closed_at IS NULL",
      )
      .get(runId);
    if (existing !== undefined)
      return z.object({ reserved_ms: z.number() }).parse(existing).reserved_ms;
    const reserved = Math.min(
      OWNED_ACTIVE_INTERVAL_MS,
      run.input.limits.maxActiveMs - run.row.charged_active_ms,
    );
    if (reserved <= 0)
      throw new OwnedBudgetExhausted("Workflow active-time limit exhausted");
    db.prepare(
      "INSERT INTO workflow_active_intervals (run_id, generation, opened_at, reserved_ms) VALUES (?, ?, ?, ?)",
    ).run(runId, generation, now, reserved);
    db.prepare(
      "UPDATE workflow_owned_runs SET charged_active_ms = charged_active_ms + ? WHERE id = ?",
    ).run(reserved, runId);
    return reserved;
  })();
}

export function settleOwnedActiveInterval(
  db: Db,
  runId: string,
  observedMs: number | null,
  now = Date.now(),
): void {
  db.transaction(() => {
    const raw = db
      .prepare(
        "SELECT id, reserved_ms FROM workflow_active_intervals WHERE run_id = ? AND closed_at IS NULL",
      )
      .get(runId);
    if (raw === undefined) return;
    const interval = z
      .object({ id: z.number(), reserved_ms: z.number() })
      .parse(raw);
    const run = requireOwnedRun(db, runId);
    const charged =
      observedMs === null
        ? interval.reserved_ms
        : Math.min(
            run.input.limits.maxActiveMs -
              run.row.charged_active_ms +
              interval.reserved_ms,
            Math.max(0, Math.ceil(observedMs)),
          );
    db.prepare(
      "UPDATE workflow_active_intervals SET settled_ms = ?, closed_at = ?, uncertain = ? WHERE id = ?",
    ).run(charged, now, Number(observedMs === null), interval.id);
    db.prepare(
      "UPDATE workflow_owned_runs SET charged_active_ms = charged_active_ms - ? WHERE id = ?",
    ).run(interval.reserved_ms - charged, runId);
  })();
}

export function recoverOwnedRuns(db: Db, now = Date.now()): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE workflow_active_intervals SET settled_ms = reserved_ms, closed_at = ?, uncertain = 1 WHERE closed_at IS NULL",
    ).run(now);
    db.prepare(
      "UPDATE workflow_attempts SET state = 'needs-reconciliation', last_error = 'Worker restarted; native outcome requires observation' WHERE state IN ('dispatched', 'running')",
    ).run();
    const rows = db
      .prepare(
        "SELECT id FROM workflow_owned_runs WHERE state NOT IN ('succeeded', 'failed', 'cancelled')",
      )
      .all();
    for (const { id } of z.array(z.object({ id: z.string() })).parse(rows)) {
      db.prepare(
        "UPDATE workflow_owned_runs SET dispatch_generation = dispatch_generation + 1 WHERE id = ?",
      ).run(id);
      reconcileOwnedRunState(db, id, false, now);
    }
  })();
}

export function redispatchOwnedAttempt(
  db: Db,
  effectId: string,
  generation: number,
): boolean {
  return db.transaction(() => {
    const attempt = requireOwnedAttempt(db, effectId);
    const run = requireOwnedRun(db, attempt.row.run_id);
    if (
      attempt.row.state !== "not-started" ||
      run.row.state !== "running" ||
      run.row.desired_control !== "run" ||
      run.row.dispatch_generation !== generation ||
      hasUnverifiedOwnedValidation(db, run.row.id, generation)
    )
      return false;
    if (
      attempt.row.kind === "agent" &&
      viewOwnedRun(db, run.row.id).activeAgents >=
        run.input.limits.maxConcurrentAgents
    )
      return false;
    db.prepare(
      "UPDATE workflow_attempts SET state = 'dispatched', finished_at = NULL WHERE effect_id = ?",
    ).run(effectId);
    return true;
  })();
}

export function pendingOwnedRunIds(db: Db): string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(
      db
        .prepare(
          "SELECT id FROM workflow_owned_runs WHERE state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY created_at",
        )
        .all(),
    )
    .map((row) => row.id);
}

export function staleOwnedAttempts(db: Db): OwnedAttemptRecord[] {
  return db
    .prepare(
      "SELECT a.* FROM workflow_attempts a JOIN workflow_steps s ON s.selected_effect_id = a.effect_id JOIN workflow_owned_runs r ON r.id = a.run_id WHERE json_extract(a.validity_json, '$.state') = 'stale' AND r.state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY a.observed_at LIMIT 100",
    )
    .all()
    .map((raw) => {
      const row = attemptRowSchema.parse(raw);
      return {
        row,
        request: ownedStepRequestInputSchema.parse(
          JSON.parse(row.request_json),
        ),
      };
    });
}

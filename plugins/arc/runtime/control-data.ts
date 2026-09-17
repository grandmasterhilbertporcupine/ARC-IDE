import type Database from "better-sqlite3";
import { z } from "zod";
import { AgentStoreError } from "../data.js";
import { runtimeHash } from "./hash.js";
import { directoryRunRequestSchema, type DirectoryRunRequest } from "./directory-contract.js";
import {
  orchestratedRunRequestSchema,
  type OrchestratedRunRequest,
} from "./orchestrated-contract.js";
import {
  graphRunRequestSchema,
  type GraphRunRequest,
} from "./graph-contract.js";
import {
  delegationAssignmentsSchema,
  resolveRunControlSchema,
  runControlContextInputSchema as runControlContextSchema,
  runControlSchema,
  type RunControlContextInput as RunControlContext,
} from "./control-contract.js";

export const controlMigrations = [
  `CREATE TABLE arc_run_controls (
    control_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    effect_id TEXT NOT NULL UNIQUE REFERENCES arc_run_effects(effect_id),
    context_hash TEXT NOT NULL,
    context_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    state TEXT NOT NULL CHECK(state IN ('pending', 'resolved', 'cancelled')),
    decision TEXT CHECK(decision IN ('approved', 'rejected')),
    operation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX arc_run_controls_by_run ON arc_run_controls(run_id, created_at, control_id)",
  `CREATE TABLE arc_run_control_operations (
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(run_id, operation_id)
  )`,
  `CREATE TABLE arc_delegation_proposals (
    requester_effect_id TEXT PRIMARY KEY REFERENCES arc_run_effects(effect_id),
    assignments_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE arc_discarded_run_requests (
    project_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    discarded_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, operation_id)
  )`,
];
interface ControlRow {
  controlId: string;
  runId: string;
  effectId: string;
  contextHash: string;
  contextJson: string;
  revision: number;
  state: string;
  decision: string | null;
  operationId: string | null;
  createdAt: number;
  updatedAt: number;
}
const SELECT = `SELECT control_id AS controlId, run_id AS runId, effect_id AS effectId, context_hash AS contextHash,
  context_json AS contextJson, revision, state, decision, operation_id AS operationId, created_at AS createdAt,
  updated_at AS updatedAt FROM arc_run_controls`;
const decode = (row: ControlRow) => {
  const { contextJson, ...fields } = row;
  return runControlSchema.parse({
    ...fields,
    context: runControlContextSchema.parse(JSON.parse(contextJson)),
  });
};
export function createRunControlStore(db: Database.Database) {
  function find(runId: string, controlId: string) {
    const row = db
      .prepare<[string, string], ControlRow>(
        `${SELECT} WHERE run_id = ? AND control_id = ?`,
      )
      .get(runId, controlId);
    return row ? decode(row) : null;
  }
  function get(runId: string, controlId: string) {
    const control = find(runId, controlId);
    if (!control)
      throw new AgentStoreError(
        "control_not_found",
        "This decision does not belong to the selected run",
      );
    return control;
  }
  return {
    find,
    get,
    whileStartActive<T>(
      input: GraphRunRequest | OrchestratedRunRequest | DirectoryRunRequest,
      reserve: () => T,
    ): T {
      return db.transaction(() => {
        const request =
          "sourceInspectionId" in input ? directoryRunRequestSchema.parse(input) : "invocation" in input
            ? orchestratedRunRequestSchema.parse(input)
            : graphRunRequestSchema.parse(input);
        const discarded = db
          .prepare<[string, string], { requestHash: string }>(
            "SELECT request_hash AS requestHash FROM arc_discarded_run_requests WHERE project_id = ? AND operation_id = ?",
          )
          .get(request.projectId, request.operationId);
        if (discarded)
          throw new AgentStoreError(
            discarded.requestHash === runtimeHash(request)
              ? "run_request_discarded"
              : "run_conflict",
            "This start request was retired. Review current settings and use a new operation ID.",
          );
        return reserve();
      })();
    },
    discardStart(input: GraphRunRequest | OrchestratedRunRequest | DirectoryRunRequest) {
      return db.transaction(() => {
        const request =
          "sourceInspectionId" in input ? directoryRunRequestSchema.parse(input) : "invocation" in input
            ? orchestratedRunRequestSchema.parse(input)
            : graphRunRequestSchema.parse(input);
        const requestHash = runtimeHash(request);
        const reserved = db
          .prepare<[string, string], { runId: string; requestHash: string }>(
            "SELECT id AS runId, request_hash AS requestHash FROM arc_runs WHERE project_id = ? AND operation_id = ?",
          )
          .get(request.projectId, request.operationId);
        if (reserved) {
          if (reserved.requestHash !== requestHash)
            throw new AgentStoreError(
              "run_conflict",
              "This operation already identifies different work",
            );
          return { state: "reserved" as const, runId: reserved.runId };
        }
        const discarded = db
          .prepare<[string, string], { requestHash: string }>(
            "SELECT request_hash AS requestHash FROM arc_discarded_run_requests WHERE project_id = ? AND operation_id = ?",
          )
          .get(request.projectId, request.operationId);
        if (discarded && discarded.requestHash !== requestHash)
          throw new AgentStoreError(
            "run_conflict",
            "This operation already identifies a different retired request",
          );
        if (!discarded)
          db.prepare(
            "INSERT INTO arc_discarded_run_requests (project_id, operation_id, request_hash, discarded_at) VALUES (?, ?, ?, ?)",
          ).run(
            request.projectId,
            request.operationId,
            requestHash,
            Date.now(),
          );
        return {
          state: "discarded" as const,
          operationId: request.operationId,
          requestHash,
        };
      })();
    },
    reserve(input: RunControlContext) {
      return db.transaction(() => {
        const context = runControlContextSchema.parse(input);
        const contextHash = runtimeHash(context);
        const existing = db
          .prepare<[string], ControlRow>(`${SELECT} WHERE effect_id = ?`)
          .get(context.effectId);
        if (existing) {
          if (
            existing.runId !== context.runId ||
            existing.contextHash !== contextHash
          )
            throw new AgentStoreError(
              "control_conflict",
              "This decision already belongs to different work or evidence",
            );
          return decode(existing);
        }
        const now = Date.now();
        db.prepare(`INSERT INTO arc_run_controls
          (control_id, run_id, effect_id, context_hash, context_json, revision, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)`).run(
          context.effectId,
          context.runId,
          context.effectId,
          contextHash,
          JSON.stringify(context),
          now,
          now,
        );
        return get(context.runId, context.effectId);
      })();
    },
    resolve(input: z.infer<typeof resolveRunControlSchema>) {
      return db.transaction(() => {
        const request = resolveRunControlSchema.parse(input);
        const requestHash = runtimeHash(request);
        const retained = db
          .prepare<
            [string, string],
            { requestHash: string; resultJson: string }
          >(
            "SELECT request_hash AS requestHash, result_json AS resultJson FROM arc_run_control_operations WHERE run_id = ? AND operation_id = ?",
          )
          .get(request.runId, request.operationId);
        if (retained) {
          if (retained.requestHash !== requestHash)
            throw new AgentStoreError(
              "control_conflict",
              "This operation ID already records a different decision",
            );
          return runControlSchema.parse(JSON.parse(retained.resultJson));
        }
        const current = get(request.runId, request.controlId);
        if (
          current.revision !== request.expectedRevision ||
          current.contextHash !== request.contextHash ||
          current.state !== "pending"
        )
          throw new AgentStoreError(
            "control_conflict",
            "This decision changed or is already closed. Review its current evidence before responding.",
          );
        db.prepare(
          "UPDATE arc_run_controls SET revision = revision + 1, state = 'resolved', decision = ?, operation_id = ?, updated_at = ? WHERE control_id = ?",
        ).run(
          request.decision,
          request.operationId,
          Date.now(),
          request.controlId,
        );
        const result = get(request.runId, request.controlId);
        db.prepare(
          "INSERT INTO arc_run_control_operations (run_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?)",
        ).run(
          request.runId,
          request.operationId,
          requestHash,
          JSON.stringify(result),
        );
        return result;
      })();
    },
    cancel(runId: string, controlId: string) {
      return db.transaction(() => {
        get(runId, controlId);
        db.prepare(
          "UPDATE arc_run_controls SET revision = revision + 1, state = 'cancelled', updated_at = ? WHERE run_id = ? AND control_id = ? AND state = 'pending'",
        ).run(Date.now(), runId, controlId);
        return get(runId, controlId);
      })();
    },
    list(runId: string, limit: number, offset: number) {
      const controls = db
        .prepare<[string, number, number], ControlRow>(
          `${SELECT} WHERE run_id = ? ORDER BY created_at, control_id LIMIT ? OFFSET ?`,
        )
        .all(runId, limit, offset)
        .map(decode);
      const total = db
        .prepare<[string], { total: number }>(
          "SELECT COUNT(*) AS total FROM arc_run_controls WHERE run_id = ?",
        )
        .get(runId)!.total;
      return { controls, total };
    },
    proposeDelegation(
      requesterEffectId: string,
      input: z.infer<typeof delegationAssignmentsSchema>,
    ) {
      return db.transaction(() => {
        const assignments = delegationAssignmentsSchema.parse(input);
        const json = JSON.stringify(assignments);
        const retained = db
          .prepare<[string], { json: string }>(
            "SELECT assignments_json AS json FROM arc_delegation_proposals WHERE requester_effect_id = ?",
          )
          .get(requesterEffectId);
        if (retained && retained.json !== json)
          throw new AgentStoreError(
            "delegation_conflict",
            "This admitted requester already proposed different assignments",
          );
        if (!retained)
          db.prepare(
            "INSERT INTO arc_delegation_proposals (requester_effect_id, assignments_json, created_at) VALUES (?, ?, ?)",
          ).run(requesterEffectId, json, Date.now());
        return assignments;
      })();
    },
    delegation(requesterEffectId: string) {
      const row = db
        .prepare<[string], { json: string }>(
          "SELECT assignments_json AS json FROM arc_delegation_proposals WHERE requester_effect_id = ?",
        )
        .get(requesterEffectId);
      return row
        ? delegationAssignmentsSchema.parse(JSON.parse(row.json))
        : null;
    },
  };
}
export type RunControlStore = ReturnType<typeof createRunControlStore>;

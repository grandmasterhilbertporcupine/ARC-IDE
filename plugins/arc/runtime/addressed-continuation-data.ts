import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AgentStoreError } from "../data.js";
import { orchestratedRunRequestSchema } from "./orchestrated-contract.js";
import { retainedCompiledRunSchema } from "./compiled.js";
import { runtimeHash } from "./hash.js";
import { teamRevisionSchema } from "../teams/contract.js";
import { runAgentSnapshotSchema } from "./definition.js";
import type { AddressedComponent } from "./addressed-composition.js";
import { addressedFollowupSchema } from "./addressed-continuation-contract.js";
import { compositionAuthorizationSchema } from "./composition-authorization-contract.js";

const compositionSchema = z
  .object({
    revision: teamRevisionSchema,
    members: z.record(z.string(), runAgentSnapshotSchema),
    compositionAuthorization: compositionAuthorizationSchema.optional(),
  })
  .strict();

export const addressedContinuationInputSchema = z
  .object({
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    operationId: z.string().uuid(),
    goal: z.string().trim().min(1).max(16_384),
    recipients: orchestratedRunRequestSchema.shape.addressedRecipients.unwrap(),
    attachments:
      orchestratedRunRequestSchema.shape.addressedAttachments.unwrap(),
  })
  .strict();
export type AddressedContinuationInput = z.infer<
  typeof addressedContinuationInputSchema
>;

export const addressedContinuationMigrations = [
  `CREATE TABLE arc_addressed_continuations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    root_run_id TEXT NOT NULL REFERENCES arc_runs(id),
    predecessor_run_id TEXT REFERENCES arc_runs(id),
    successor_run_id TEXT NOT NULL UNIQUE,
    control_version INTEGER,
    compiled_json TEXT,
    composition_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('queued','checking','starting','applied','action-required','cancelled')),
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(project_id, operation_id)
  )`,
  "CREATE INDEX arc_addressed_continuations_queue ON arc_addressed_continuations(thread_id, state, sequence)",
];

const rowSchema = z.object({
  sequence: z.number(),
  project_id: z.string(),
  thread_id: z.string(),
  operation_id: z.string(),
  request_hash: z.string(),
  request_json: z.string(),
  root_run_id: z.string(),
  predecessor_run_id: z.string().nullable(),
  successor_run_id: z.string(),
  control_version: z.number().nullable(),
  compiled_json: z.string().nullable(),
  composition_json: z.string().nullable(),
  state: z.enum([
    "queued",
    "checking",
    "starting",
    "applied",
    "action-required",
    "cancelled",
  ]),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
function decode(raw: unknown) {
  const row = rowSchema.parse(raw);
  return {
    sequence: row.sequence,
    input: addressedContinuationInputSchema.parse(JSON.parse(row.request_json)),
    rootRunId: row.root_run_id,
    predecessorRunId: row.predecessor_run_id,
    successorRunId: row.successor_run_id,
    controlVersion: row.control_version,
    compiled:
      row.compiled_json === null
        ? null
        : retainedCompiledRunSchema.parse(JSON.parse(row.compiled_json)),
    composition:
      row.composition_json === null
        ? null
        : compositionSchema.parse(JSON.parse(row.composition_json)),
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export type AddressedContinuation = ReturnType<typeof decode>;

export function createAddressedContinuationStore(db: Database.Database) {
  function find(projectId: string, operationId: string) {
    const row = db
      .prepare(
        "SELECT * FROM arc_addressed_continuations WHERE project_id = ? AND operation_id = ?",
      )
      .get(projectId, operationId);
    return row === undefined ? null : decode(row);
  }
  function update(
    item: AddressedContinuation,
    state: AddressedContinuation["state"],
    error: string | null = null,
  ) {
    db.prepare(
      "UPDATE arc_addressed_continuations SET state = ?, error = ?, updated_at = max(updated_at + 1, ?) WHERE sequence = ? AND state <> 'cancelled'",
    ).run(state, error, Date.now(), item.sequence);
    return find(item.input.projectId, item.input.operationId)!;
  }
  return {
    find,
    reserve(
      input: AddressedContinuationInput,
      priorRunId: string,
      composition: AddressedComponent | null = null,
    ) {
      const request = addressedContinuationInputSchema.parse(input);
      return db.transaction(() => {
        const retained = find(request.projectId, request.operationId);
        if (retained) {
          if (runtimeHash(retained.input) !== runtimeHash(request))
            throw new AgentStoreError(
              "run_conflict",
              "This Send operation already identifies a different follow-up",
            );
          return retained;
        }
        const count = z
          .object({ count: z.number() })
          .parse(
            db
              .prepare(
                "SELECT count(*) AS count FROM arc_addressed_continuations WHERE project_id = ? AND thread_id = ? AND state NOT IN ('applied','cancelled')",
              )
              .get(request.projectId, request.threadId),
          ).count;
        if (count >= 12)
          throw new AgentStoreError(
            "followup_queue_full",
            "This conversation already has twelve pending follow-ups. Cancel or finish one before sending another.",
          );
        const lineage = db
          .prepare(
            "SELECT root_run_id FROM arc_addressed_continuations WHERE successor_run_id = ?",
          )
          .get(priorRunId);
        const rootRunId =
          lineage === undefined
            ? priorRunId
            : z.object({ root_run_id: z.string() }).parse(lineage).root_run_id;
        const now = Date.now();
        db.prepare(
          "INSERT INTO arc_addressed_continuations (project_id,thread_id,operation_id,request_hash,request_json,root_run_id,successor_run_id,composition_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)",
        ).run(
          request.projectId,
          request.threadId,
          request.operationId,
          runtimeHash(request),
          JSON.stringify(request),
          rootRunId,
          `run_${randomUUID()}`,
          composition === null
            ? null
            : JSON.stringify(compositionSchema.parse(composition)),
          now,
          now,
        );
        return find(request.projectId, request.operationId)!;
      })();
    },
    queue(projectId: string, threadId: string) {
      return db
        .prepare(
          "SELECT * FROM arc_addressed_continuations WHERE project_id = ? AND thread_id = ? ORDER BY sequence DESC LIMIT 100",
        )
        .all(projectId, threadId)
        .map(decode)
        .reverse();
    },
    firstPending(projectId: string, threadId: string) {
      const row = db
        .prepare(
          "SELECT sequence FROM arc_addressed_continuations WHERE project_id = ? AND thread_id = ? AND state NOT IN ('applied','cancelled') ORDER BY sequence LIMIT 1",
        )
        .get(projectId, threadId);
      return row === undefined
        ? null
        : z.object({ sequence: z.number() }).parse(row).sequence;
    },
    publicQueue(projectId: string, threadId: string) {
      return db
        .prepare(
          "SELECT operation_id AS operationId, json_extract(request_json, '$.goal') AS goal, predecessor_run_id AS predecessorRunId, successor_run_id AS successorRunId, state, error, created_at AS createdAt, updated_at AS updatedAt FROM arc_addressed_continuations WHERE project_id = ? AND thread_id = ? ORDER BY CASE WHEN state IN ('applied','cancelled') THEN 1 ELSE 0 END, sequence DESC LIMIT 100",
        )
        .all(projectId, threadId)
        .map((row) => addressedFollowupSchema.parse(row))
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    pending() {
      return db
        .prepare(
          "SELECT * FROM arc_addressed_continuations WHERE state IN ('queued','checking','starting') AND sequence IN (SELECT min(sequence) FROM arc_addressed_continuations WHERE state NOT IN ('applied','cancelled') GROUP BY project_id, thread_id) ORDER BY sequence LIMIT 100",
        )
        .all()
        .map(decode);
    },
    incoming(runId: string) {
      const row = db
        .prepare(
          "SELECT * FROM arc_addressed_continuations WHERE successor_run_id = ?",
        )
        .get(runId);
      return row === undefined ? null : decode(row);
    },
    bind(
      item: AddressedContinuation,
      predecessorRunId: string,
      controlVersion: number,
    ) {
      db.prepare(
        "UPDATE arc_addressed_continuations SET predecessor_run_id = ?, control_version = ?, state = 'checking', updated_at = max(updated_at + 1, ?) WHERE sequence = ? AND state = 'queued'",
      ).run(predecessorRunId, controlVersion, Date.now(), item.sequence);
      return find(item.input.projectId, item.input.operationId)!;
    },
    seal(
      item: AddressedContinuation,
      compiled: z.infer<typeof retainedCompiledRunSchema>,
    ) {
      return db.transaction(() => {
        const current = find(item.input.projectId, item.input.operationId)!;
        if (
          current.compiled &&
          runtimeHash(current.compiled) !== runtimeHash(compiled)
        )
          throw new AgentStoreError(
            "run_conflict",
            "The follow-up already has a different sealed candidate",
          );
        db.prepare(
          "UPDATE arc_addressed_continuations SET compiled_json = ?, state = 'starting', updated_at = max(updated_at + 1, ?) WHERE sequence = ? AND state = 'checking'",
        ).run(
          JSON.stringify(retainedCompiledRunSchema.parse(compiled)),
          Date.now(),
          item.sequence,
        );
        return find(item.input.projectId, item.input.operationId)!;
      })();
    },
    update,
  };
}

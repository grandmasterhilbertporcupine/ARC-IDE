import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { AgentStoreError } from "../data.js";
import {
  retainedCompiledRunSchema,
  type RetainedCompiledRun,
} from "./compiled.js";
import {
  runUpdateApplicationSchema,
  runUpdatePreviewSchema,
  type RunUpdateApplication,
  type RunUpdatePreview,
} from "./rule-update-contract.js";
import { runtimeHash } from "./hash.js";

export const instructionUpdateMigrations = [
  "CREATE TABLE arc_instruction_update_previews (preview_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES arc_runs(id), preview_json TEXT NOT NULL, compiled_json TEXT NOT NULL)",
  "CREATE TABLE arc_instruction_updates (run_id TEXT NOT NULL REFERENCES arc_runs(id), operation_id TEXT NOT NULL, successor_run_id TEXT NOT NULL UNIQUE, preview_id TEXT NOT NULL REFERENCES arc_instruction_update_previews(preview_id), state TEXT NOT NULL, source_retry_operation_id TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(run_id, operation_id))",
  "CREATE UNIQUE INDEX arc_instruction_updates_active ON arc_instruction_updates(run_id) WHERE state != 'cancelled'",
];

type Key = { runId: string; operationId: string };
interface Row {
  runId: string;
  operationId: string;
  successorRunId: string;
  previewJson: string;
  state: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
const select =
  "SELECT u.run_id AS runId, u.operation_id AS operationId, u.successor_run_id AS successorRunId, p.preview_json AS previewJson, u.state, u.reason, u.created_at AS createdAt, u.updated_at AS updatedAt FROM arc_instruction_updates u JOIN arc_instruction_update_previews p ON p.preview_id=u.preview_id";
const decode = ({ previewJson, ...row }: Row) =>
  runUpdateApplicationSchema.parse({
    ...row,
    preview: JSON.parse(previewJson),
  });

export function createInstructionUpdateStore(db: Database.Database) {
  function find(key: Key) {
    const row = db
      .prepare<[string, string], Row>(
        `${select} WHERE u.run_id=? AND u.operation_id=?`,
      )
      .get(key.runId, key.operationId);
    return row ? decode(row) : null;
  }
  function get(key: Key) {
    const item = find(key);
    if (!item)
      throw new AgentStoreError(
        "instruction_update_missing",
        "This instruction update does not exist",
      );
    return item;
  }
  function preview(previewId: string) {
    const row = db
      .prepare<[string], { previewJson: string; compiledJson: string }>(
        "SELECT preview_json AS previewJson, compiled_json AS compiledJson FROM arc_instruction_update_previews WHERE preview_id=?",
      )
      .get(previewId);
    if (!row)
      throw new AgentStoreError(
        "instruction_preview_missing",
        "Review the updated instructions before applying them",
      );
    return {
      preview: runUpdatePreviewSchema.parse(JSON.parse(row.previewJson)),
      compiled: retainedCompiledRunSchema.parse(JSON.parse(row.compiledJson)),
    };
  }
  function lineage(runId: string) {
    const incoming = db
      .prepare<[string], Row>(`${select} WHERE u.successor_run_id=?`)
      .get(runId);
    const outgoing = db
      .prepare<[string], Row>(
        `${select} WHERE u.run_id=? ORDER BY u.created_at DESC, u.operation_id DESC LIMIT 1`,
      )
      .get(runId);
    return {
      incoming: incoming ? decode(incoming) : null,
      outgoing: outgoing ? decode(outgoing) : null,
    };
  }
  function sourceRetry(key: Key) {
    return (
      db
        .prepare<[string, string], { operationId: string | null }>(
          "SELECT source_retry_operation_id AS operationId FROM arc_instruction_updates WHERE run_id=? AND operation_id=?",
        )
        .get(key.runId, key.operationId)?.operationId ?? null
    );
  }
  return {
    find,
    get,
    preview,
    lineage,
    sourceRetry,
    reserveSourceRetry(key: Key) {
      return db.transaction(() => {
        if (get(key).state !== "starting")
          throw new AgentStoreError(
            "instruction_update_conflict",
            "This instruction update is no longer preparing its successor",
          );
        const operationId =
          sourceRetry(key) ?? `instruction_recheck_${randomUUID()}`;
        db.prepare(
          "UPDATE arc_instruction_updates SET source_retry_operation_id=? WHERE run_id=? AND operation_id=?",
        ).run(operationId, key.runId, key.operationId);
        return operationId;
      })();
    },
    consumeSourceRetry(key: Key, operationId: string) {
      db.prepare(
        "UPDATE arc_instruction_updates SET source_retry_operation_id=NULL WHERE run_id=? AND operation_id=? AND source_retry_operation_id=?",
      ).run(key.runId, key.operationId, operationId);
    },
    savePreview<T extends RunUpdatePreview>(
      value: T,
      compiled: RetainedCompiledRun,
    ) {
      db.prepare(
        "INSERT INTO arc_instruction_update_previews(preview_id, run_id, preview_json, compiled_json) VALUES (?, ?, ?, ?)",
      ).run(
        value.previewId,
        value.runId,
        JSON.stringify(value),
        JSON.stringify(compiled),
      );
      return value;
    },
    reserve(input: {
      operationId: string;
      previewId: string;
      previewHash: string;
    }) {
      return db.transaction(() => {
        const retained = preview(input.previewId);
        if (retained.preview.previewHash !== input.previewHash)
          throw new AgentStoreError(
            "instruction_preview_conflict",
            "The reviewed instruction preview changed",
          );
        const key = {
          runId: retained.preview.runId,
          operationId: input.operationId,
        };
        const existing = find(key);
        if (existing) {
          if (runtimeHash(existing.preview) !== runtimeHash(retained.preview))
            throw new AgentStoreError(
              "instruction_update_conflict",
              "This operation already identifies another instruction update",
            );
          return existing;
        }
        const active = db
          .prepare<[string], { operationId: string }>(
            "SELECT operation_id AS operationId FROM arc_instruction_updates WHERE run_id=? AND state != 'cancelled' LIMIT 1",
          )
          .get(key.runId);
        if (active)
          throw new AgentStoreError(
            "instruction_update_pending",
            "Finish or cancel the existing instruction update first",
          );
        const now = Date.now();
        db.prepare(
          "INSERT INTO arc_instruction_updates(run_id, operation_id, successor_run_id, preview_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pausing', ?, ?)",
        ).run(
          key.runId,
          key.operationId,
          retained.compiled.definition.runId,
          input.previewId,
          now,
          now,
        );
        return get(key);
      })();
    },
    transition(
      key: Key,
      states: RunUpdateApplication["state"][],
      state: RunUpdateApplication["state"],
      reason: string | null = null,
    ) {
      db.prepare(
        `UPDATE arc_instruction_updates SET state=?, reason=?, updated_at=? WHERE run_id=? AND operation_id=? AND state IN (${states.map(() => "?").join(",")})`,
      ).run(state, reason, Date.now(), key.runId, key.operationId, ...states);
      return get(key);
    },
    assertControllable(runId: string) {
      const outgoing = lineage(runId).outgoing;
      if (outgoing && outgoing.state !== "cancelled")
        throw new AgentStoreError(
          "instruction_update_locked",
          outgoing.state === "applied"
            ? "This run was superseded by reviewed instructions. Open its successor."
            : "Cancel the pending instruction update before changing the original run.",
        );
    },
  };
}

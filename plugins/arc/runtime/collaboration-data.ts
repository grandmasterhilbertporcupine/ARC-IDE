import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AgentStoreError } from "../data.js";
import type { CollaborationCursor } from "./usage-contract.js";
import { runtimeHash } from "./hash.js";
import {
  readerReportInputSchema,
  readerReportSchema,
  runMessageInputSchema,
  runMessageSchema,
  type ReaderReportInput,
  type ReportSource,
  type RunMessageInput,
} from "./collaboration-contract.js";

export const collaborationMigrations = [
  `CREATE TABLE arc_run_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    effect_id TEXT NOT NULL REFERENCES arc_run_effects(effect_id),
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    document_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(effect_id, operation_id)
  )`,
  "CREATE INDEX arc_run_reports_by_run ON arc_run_reports(run_id, created_at, id)",
  `CREATE TABLE arc_run_messages (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    effect_id TEXT NOT NULL REFERENCES arc_run_effects(effect_id),
    operation_id TEXT NOT NULL,
    from_member_id TEXT NOT NULL,
    to_member_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('information', 'question', 'reply')),
    reply_to TEXT UNIQUE REFERENCES arc_run_messages(id),
    request_hash TEXT NOT NULL,
    document_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(effect_id, operation_id)
  )`,
  "CREATE INDEX arc_run_messages_inbox ON arc_run_messages(run_id, to_member_id, created_at, id)",
  "CREATE INDEX arc_run_messages_by_run ON arc_run_messages(run_id, created_at, id)",
  `CREATE TABLE arc_run_message_selections (
    effect_id TEXT PRIMARY KEY REFERENCES arc_run_effects(effect_id),
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    message_id TEXT UNIQUE REFERENCES arc_run_messages(id)
  )`,
];
interface DocumentRow {
  document: string;
  hash: string;
}
type Actor = { runId: string; effectId: string; memberId: string };
export function createRunCollaborationStore(db: Database.Database) {
  function message(runId: string, id: string) {
    const row = db
      .prepare<[string, string], { document: string }>(
        "SELECT document_json AS document FROM arc_run_messages WHERE run_id = ? AND id = ?",
      )
      .get(runId, id);
    if (!row)
      throw new AgentStoreError(
        "message_not_found",
        "This message does not belong to the current run",
      );
    return runMessageSchema.parse(JSON.parse(row.document));
  }
  return {
    dialogueState(
      runId: string,
      checkpoints: { nodeId: string; iteration: number }[],
    ) {
      const unansweredQuestions = db
        .prepare<[string], { total: number }>(
          "SELECT count(*) AS total FROM arc_run_messages q WHERE q.run_id = ? AND q.kind = 'question' AND NOT EXISTS (SELECT 1 FROM arc_run_messages r WHERE r.run_id = q.run_id AND r.reply_to = q.id)",
        )
        .get(runId)!.total;
      const remainingCheckpoints = db
        .prepare<[string, string], { total: number }>(
          "SELECT count(*) AS total FROM json_each(?) c WHERE NOT EXISTS (SELECT 1 FROM arc_run_effects e WHERE e.run_id = ? AND e.node_id = json_extract(c.value, '$.nodeId') AND e.iteration = json_extract(c.value, '$.iteration'))",
        )
        .get(JSON.stringify(checkpoints), runId)!.total;
      return { unansweredQuestions, remainingCheckpoints };
    },
    reportsPage(
      runId: string,
      cursor: CollaborationCursor | null,
      limit: number,
    ) {
      const rows = db
        .prepare<Array<string | number>, { document: string }>(
          "SELECT document_json AS document FROM arc_run_reports WHERE run_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
        )
        .all(
          runId,
          cursor?.createdAt ?? -1,
          cursor?.createdAt ?? -1,
          cursor?.id ?? "",
          Math.min(20, Math.max(1, limit)) + 1,
        );
      const parsed = rows.map((row) =>
        readerReportSchema.parse(JSON.parse(row.document)),
      );
      const items = parsed.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          parsed.length > items.length && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },
    messagesPage(
      runId: string,
      cursor: CollaborationCursor | null,
      limit: number,
    ) {
      const rows = db
        .prepare<Array<string | number>, { document: string }>(
          "SELECT document_json AS document FROM arc_run_messages WHERE run_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
        )
        .all(
          runId,
          cursor?.createdAt ?? -1,
          cursor?.createdAt ?? -1,
          cursor?.id ?? "",
          Math.min(20, Math.max(1, limit)) + 1,
        );
      const parsed = rows.map((row) =>
        runMessageSchema.parse(JSON.parse(row.document)),
      );
      const items = parsed.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          parsed.length > items.length && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },
    report(actor: Actor, source: ReportSource, input: ReaderReportInput) {
      return db.transaction(() => {
        const report = readerReportInputSchema.parse(input);
        const hash = runtimeHash({ actor, source, report });
        const existing = db
          .prepare<[string, string], DocumentRow>(
            "SELECT document_json AS document, request_hash AS hash FROM arc_run_reports WHERE effect_id = ? AND operation_id = ?",
          )
          .get(actor.effectId, report.operationId);
        if (existing) {
          if (existing.hash !== hash)
            throw new AgentStoreError(
              "report_conflict",
              "This report operation already contains different findings",
            );
          return readerReportSchema.parse(JSON.parse(existing.document));
        }
        const count = db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_run_reports WHERE effect_id = ?",
          )
          .get(actor.effectId)!.total;
        if (count >= 4)
          throw new AgentStoreError(
            "report_limit",
            "This turn already produced four handoff reports; combine findings before publishing",
          );
        const value = readerReportSchema.parse({
          id: `report_${randomUUID()}`,
          ...actor,
          source,
          report,
          createdAt: Date.now(),
        });
        db.prepare(
          "INSERT INTO arc_run_reports (id, run_id, effect_id, operation_id, request_hash, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          value.id,
          actor.runId,
          actor.effectId,
          report.operationId,
          hash,
          JSON.stringify(value),
          value.createdAt,
        );
        return value;
      })();
    },
    reportCount(runId: string, effectIds: string[]) {
      if (effectIds.length === 0) return 0;
      return db
        .prepare<string[], { total: number }>(
          `SELECT count(*) AS total FROM arc_run_reports WHERE run_id = ? AND effect_id IN (${effectIds.map(() => "?").join(",")})`,
        )
        .get(runId, ...effectIds)!.total;
    },
    reports(runId: string, effectIds: string[] | null, limit = 50) {
      if (effectIds?.length === 0) return [];
      const bounded = Math.max(1, Math.min(50, limit));
      const restriction =
        effectIds === null
          ? ""
          : ` AND effect_id IN (${effectIds.map(() => "?").join(",")})`;
      return db
        .prepare<Array<string | number>, { document: string }>(
          `SELECT document_json AS document FROM arc_run_reports WHERE run_id = ?${restriction} ORDER BY created_at, id LIMIT ?`,
        )
        .all(runId, ...(effectIds ?? []), bounded)
        .map((row) => readerReportSchema.parse(JSON.parse(row.document)));
    },
    send(actor: Actor, input: RunMessageInput) {
      return db.transaction(() => {
        const inputMessage = runMessageInputSchema.parse(input);
        const hash = runtimeHash({ actor, message: inputMessage });
        const existing = db
          .prepare<[string, string], DocumentRow>(
            "SELECT document_json AS document, request_hash AS hash FROM arc_run_messages WHERE effect_id = ? AND operation_id = ?",
          )
          .get(actor.effectId, inputMessage.operationId);
        if (existing) {
          if (existing.hash !== hash)
            throw new AgentStoreError(
              "message_conflict",
              "This message operation already has different contents",
            );
          return runMessageSchema.parse(JSON.parse(existing.document));
        }
        const count = db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_run_messages WHERE effect_id = ?",
          )
          .get(actor.effectId)!.total;
        if (count >= 16)
          throw new AgentStoreError(
            "message_limit",
            "This turn reached its sixteen-message limit",
          );
        if (inputMessage.replyTo !== null) {
          const question = message(actor.runId, inputMessage.replyTo);
          if (
            question.message.kind !== "question" ||
            question.message.toMemberId !== actor.memberId ||
            question.fromMemberId !== inputMessage.toMemberId
          )
            throw new AgentStoreError(
              "reply_denied",
              "Only the addressed recipient may answer a question in this run",
            );
          const replied = db
            .prepare<[string], { id: string }>(
              "SELECT id FROM arc_run_messages WHERE reply_to = ?",
            )
            .get(inputMessage.replyTo);
          if (replied)
            throw new AgentStoreError(
              "question_answered",
              "This question already has a reply",
            );
        }
        const value = runMessageSchema.parse({
          id: `message_${randomUUID()}`,
          runId: actor.runId,
          effectId: actor.effectId,
          fromMemberId: actor.memberId,
          message: inputMessage,
          createdAt: Date.now(),
        });
        db.prepare(
          "INSERT INTO arc_run_messages (id, run_id, effect_id, operation_id, from_member_id, to_member_id, kind, reply_to, request_hash, document_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          value.id,
          actor.runId,
          actor.effectId,
          inputMessage.operationId,
          actor.memberId,
          inputMessage.toMemberId,
          inputMessage.kind,
          inputMessage.replyTo,
          hash,
          JSON.stringify(value),
          value.createdAt,
        );
        return value;
      })();
    },
    message,
    inboxPage(
      runId: string,
      memberId: string,
      cursor: CollaborationCursor | null,
      limit: number,
    ) {
      const bounded = Math.min(10, Math.max(1, limit));
      const rows = db
        .prepare<Array<string | number>, { document: string }>(
          "SELECT document_json AS document FROM arc_run_messages WHERE run_id = ? AND to_member_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
        )
        .all(
          runId,
          memberId,
          cursor?.createdAt ?? -1,
          cursor?.createdAt ?? -1,
          cursor?.id ?? "",
          bounded + 1,
        );
      const parsed = rows.map((row) =>
        runMessageSchema.parse(JSON.parse(row.document)),
      );
      const messages = parsed.slice(0, bounded);
      const last = messages.at(-1);
      return {
        messages,
        nextCursor:
          parsed.length > messages.length && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },
    selectQuestion(runId: string, effectId: string, memberIds: string[]) {
      return db.transaction(() => {
        const existing = db
          .prepare<[string, string], { messageId: string | null }>(
            "SELECT message_id AS messageId FROM arc_run_message_selections WHERE run_id = ? AND effect_id = ?",
          )
          .get(runId, effectId);
        if (existing)
          return existing.messageId === null
            ? null
            : message(runId, existing.messageId);
        const row =
          memberIds.length === 0
            ? undefined
            : db
                .prepare<string[], { id: string }>(
                  `SELECT m.id FROM arc_run_messages m WHERE m.run_id = ? AND m.kind = 'question' AND m.to_member_id IN (${memberIds.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM arc_run_messages r WHERE r.reply_to = m.id) AND NOT EXISTS (SELECT 1 FROM arc_run_message_selections s WHERE s.message_id = m.id) ORDER BY m.created_at, m.id LIMIT 1`,
                )
                .get(runId, ...memberIds);
        db.prepare(
          "INSERT INTO arc_run_message_selections (effect_id, run_id, message_id) VALUES (?, ?, ?)",
        ).run(effectId, runId, row?.id ?? null);
        return row ? message(runId, row.id) : null;
      })();
    },
    hasReply(runId: string, messageId: string) {
      return (
        db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM arc_run_messages WHERE run_id = ? AND reply_to = ?",
          )
          .get(runId, messageId) !== undefined
      );
    },
    inbox(runId: string, memberId: string | null, after: number, limit = 30) {
      const bounded = Math.max(1, Math.min(50, limit));
      const rows =
        memberId === null
          ? db
              .prepare<[string, number, number], { document: string }>(
                "SELECT document_json AS document FROM arc_run_messages WHERE run_id = ? AND created_at >= ? ORDER BY created_at, id LIMIT ?",
              )
              .all(runId, after, bounded)
          : db
              .prepare<[string, string, number, number], { document: string }>(
                "SELECT document_json AS document FROM arc_run_messages WHERE run_id = ? AND to_member_id = ? AND created_at >= ? ORDER BY created_at, id LIMIT ?",
              )
              .all(runId, memberId, after, bounded);
      return rows.map((row) =>
        runMessageSchema.parse(JSON.parse(row.document)),
      );
    },
  };
}

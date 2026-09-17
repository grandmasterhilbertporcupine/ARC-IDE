import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AgentStoreError } from "../data.js";
import {
  CONTEXT_REFERENCE_LIMITS,
  contextImportSchema,
  contextReferenceSchema,
  contextArchiveSchema,
  type ContextImport,
} from "./reference-contract.js";

export const contextMigrations = [
  `CREATE TABLE arc_context_blobs (
    sha256 TEXT PRIMARY KEY, content BLOB NOT NULL, size_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE arc_context_sources (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
    name TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES arc_context_blobs(sha256),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
  )`,
  `CREATE INDEX arc_context_sources_project ON arc_context_sources(project_id, id)`,
  `CREATE TABLE arc_context_source_revisions (
    source_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
    name TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES arc_context_blobs(sha256),
    created_at INTEGER NOT NULL, PRIMARY KEY(source_id, revision)
  )`,
  `CREATE TABLE arc_context_import_operations (
    project_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY(project_id, operation_id)
  )`,
];

const select = `SELECT s.id, s.name, s.sha256, b.size_bytes AS sizeBytes,
  s.revision, s.created_at AS createdAt, s.updated_at AS updatedAt
  FROM arc_context_sources s JOIN arc_context_blobs b ON b.sha256 = s.sha256`;
const hash = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

export function createContextStore(db: Database.Database) {
  function list(projectId: string) {
    return db
      .prepare(
        `${select} WHERE s.project_id = ? AND s.archived_at IS NULL ORDER BY s.id`,
      )
      .all(projectId)
      .map((row) => contextReferenceSchema.parse(row));
  }

  const importSource = db.transaction((raw: ContextImport) => {
    const input = contextImportSchema.parse(raw);
    const digest = hash(JSON.stringify(input));
    const previous = db
      .prepare<[string, string], { requestHash: string; resultJson: string }>(
        "SELECT request_hash AS requestHash, result_json AS resultJson FROM arc_context_import_operations WHERE project_id = ? AND operation_id = ?",
      )
      .get(input.projectId, input.operationId);
    if (previous) {
      if (previous.requestHash !== digest)
        throw new AgentStoreError(
          "operation_conflict",
          "This import operation already has different content",
        );
      return contextReferenceSchema.parse(JSON.parse(previous.resultJson));
    }
    const existing =
      input.sourceId === null
        ? null
        : db
            .prepare(
              `${select} WHERE s.project_id = ? AND s.id = ? AND s.archived_at IS NULL`,
            )
            .get(input.projectId, input.sourceId);
    const current = existing ? contextReferenceSchema.parse(existing) : null;
    if (input.sourceId !== null && current === null)
      throw new AgentStoreError(
        "source_missing",
        "This reference does not belong to the selected project",
      );
    if (current !== null && current.revision !== input.expectedRevision)
      throw new AgentStoreError(
        "source_changed",
        "Reload the reference before replacing its exact current revision",
      );
    const content = Buffer.from(input.text, "utf8");
    const usage = z
      .object({ count: z.number(), bytes: z.number() })
      .parse(
        db
          .prepare(
            "SELECT COUNT(*) AS count, COALESCE(SUM(b.size_bytes), 0) AS bytes FROM arc_context_sources s JOIN arc_context_blobs b ON s.sha256 = b.sha256 WHERE s.project_id = ? AND s.archived_at IS NULL",
          )
          .get(input.projectId),
      );
    if (
      (current === null && usage.count >= CONTEXT_REFERENCE_LIMITS.count) ||
      usage.bytes - (current?.sizeBytes ?? 0) + content.byteLength >
        CONTEXT_REFERENCE_LIMITS.totalBytes
    ) {
      throw new AgentStoreError(
        "reference_limit",
        "This text reference collection allows 32 files and 512 KiB total; replace or remove a reference, or reduce the import",
      );
    }
    const now = Date.now();
    const result = contextReferenceSchema.parse({
      id: current?.id ?? `context_${randomUUID()}`,
      name: input.name,
      sha256: hash(content),
      sizeBytes: content.byteLength,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    db.prepare(
      "INSERT OR IGNORE INTO arc_context_blobs (sha256, content, size_bytes) VALUES (?, ?, ?)",
    ).run(result.sha256, content, content.byteLength);
    db.prepare(`INSERT INTO arc_context_sources (id, project_id, revision, name, sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, name = excluded.name, sha256 = excluded.sha256, updated_at = excluded.updated_at`).run(
      result.id,
      input.projectId,
      result.revision,
      result.name,
      result.sha256,
      result.createdAt,
      result.updatedAt,
    );
    db.prepare(
      "INSERT INTO arc_context_source_revisions (source_id, project_id, revision, name, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      result.id,
      input.projectId,
      result.revision,
      result.name,
      result.sha256,
      now,
    );
    db.prepare(
      "INSERT INTO arc_context_import_operations (project_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?)",
    ).run(input.projectId, input.operationId, digest, JSON.stringify(result));
    return result;
  });

  const archive = db.transaction(
    (raw: z.infer<typeof contextArchiveSchema>) => {
      const input = contextArchiveSchema.parse(raw);
      const digest = hash(JSON.stringify({ action: "archive", ...input }));
      const previous = db
        .prepare<[string, string], { requestHash: string; resultJson: string }>(
          "SELECT request_hash AS requestHash, result_json AS resultJson FROM arc_context_import_operations WHERE project_id = ? AND operation_id = ?",
        )
        .get(input.projectId, input.operationId);
      if (previous) {
        if (previous.requestHash !== digest)
          throw new AgentStoreError(
            "operation_conflict",
            "This operation already has different content",
          );
        return contextReferenceSchema.parse(JSON.parse(previous.resultJson));
      }
      const rawSource = db
        .prepare(
          `${select} WHERE s.project_id = ? AND s.id = ? AND s.archived_at IS NULL`,
        )
        .get(input.projectId, input.sourceId);
      if (!rawSource)
        throw new AgentStoreError(
          "source_missing",
          "This current reference does not belong to the selected project",
        );
      const source = contextReferenceSchema.parse(rawSource);
      if (source.revision !== input.expectedRevision)
        throw new AgentStoreError(
          "source_changed",
          "Reload the reference before removing its exact current revision",
        );
      db.prepare(
        "UPDATE arc_context_sources SET archived_at = ? WHERE id = ? AND project_id = ?",
      ).run(Date.now(), source.id, input.projectId);
      db.prepare(
        "INSERT INTO arc_context_import_operations (project_id, operation_id, request_hash, result_json) VALUES (?, ?, ?, ?)",
      ).run(input.projectId, input.operationId, digest, JSON.stringify(source));
      return source;
    },
  );

  function read(projectId: string, sourceId: string, revision: number) {
    const raw = db
      .prepare(`SELECT r.name, r.sha256, r.revision, b.content FROM arc_context_source_revisions r
      JOIN arc_context_blobs b ON r.sha256 = b.sha256 WHERE r.project_id = ? AND r.source_id = ? AND r.revision = ?`)
      .get(projectId, sourceId, revision);
    if (!raw)
      throw new AgentStoreError(
        "source_missing",
        "The requested reference revision is unavailable in this project",
      );
    const row = z
      .object({
        name: z.string(),
        sha256: z.string(),
        revision: z.number(),
        content: z.instanceof(Uint8Array),
      })
      .parse(raw);
    const content = Buffer.from(row.content);
    if (hash(content) !== row.sha256)
      throw new AgentStoreError(
        "source_corrupt",
        "The stored reference failed its content check",
      );
    return {
      id: sourceId,
      name: row.name,
      sha256: row.sha256,
      revision: row.revision,
      text: content.toString("utf8"),
    };
  }

  return {
    list,
    importSource,
    archive,
    read,
    originals: (projectId: string) =>
      list(projectId).map((source) =>
        read(projectId, source.id, source.revision),
      ),
  };
}
export type ContextStore = ReturnType<typeof createContextStore>;

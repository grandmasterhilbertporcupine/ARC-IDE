import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  hostContextScopeSchema,
  hostContextSourceSchema,
  hostContextStatusSchema,
  type HostContextScope,
  type HostContextSource,
  type HostContextStatus,
} from "../../host-context-contract.js";
import {
  directoryRootSchema,
  type DirectoryRoot,
} from "../../host-directory-contract.js";

export const hashText = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const scopeKey = (scope: HostContextScope) =>
  hashText(
    JSON.stringify([
      scope.projectId,
      scope.hostId,
      scope.environmentId,
      process.platform === "win32"
        ? resolve(scope.path).toLowerCase()
        : resolve(scope.path),
    ]),
  );
const gitSchema = hostContextStatusSchema.shape.git;
const indexRowSchema = z.object({
  scope_key: z.string(),
  index_id: z.string(),
  scope_json: z.string(),
  root_json: z.string(),
  git_json: z.string(),
  generation: z.number(),
  operation_id: z.string(),
  state: hostContextStatusSchema.shape.state,
  coverage: hostContextStatusSchema.shape.coverage,
  semantic: hostContextStatusSchema.shape.semantic,
  manifest_digest: z.string().nullable(),
  reason: z.string().nullable(),
  updated_at: z.string(),
});
export type IndexRow = z.infer<typeof indexRowSchema>;
const sourceRowSchema = z.object({
  id: z.string(),
  index_id: z.string(),
  name: z.string(),
  kind: z.enum(["file", "reference"]),
  path: z.string().nullable(),
  revision: z.number(),
  generation: z.number(),
  sha: z.string().nullable(),
  text: z.string().nullable(),
  state: hostContextSourceSchema.shape.state,
  reason: z.string().nullable(),
  size: z.number(),
  seen_epoch: z.number(),
  manifest_digest: z.string().nullable(),
});
export type SourceRow = z.infer<typeof sourceRowSchema>;
const chunkRowSchema = z.object({
  rowid: z.number(),
  chunk_id: z.string(),
  index_id: z.string(),
  source_id: z.string(),
  source_gen: z.number(),
  sha: z.string(),
  start_offset: z.number(),
  end_offset: z.number(),
  start_line: z.number(),
  end_line: z.number(),
  token_count: z.number().nullable(),
  text: z.string(),
  name: z.string(),
  vector: z.instanceof(Uint8Array).nullable(),
  manifest_digest: z.string().nullable(),
});
export type ChunkRow = z.infer<typeof chunkRowSchema>;
export type StoredChunk = {
  id: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  text: string;
  tokenCount: number | null;
  vector: number[] | null;
};
const stopFenceSchema = z.object({
  fence_id: z.string(),
  helper_generation: z.string().nullable(),
});

export class ContextStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    const version = z
      .object({ user_version: z.number() })
      .parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error("Unsupported Context index version.");
    }
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS context_indexes (
          scope_key TEXT PRIMARY KEY, index_id TEXT NOT NULL UNIQUE, scope_json TEXT NOT NULL, root_json TEXT NOT NULL,
          git_json TEXT NOT NULL, generation INTEGER NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL,
          coverage TEXT NOT NULL, semantic TEXT NOT NULL, manifest_digest TEXT, reason TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS context_operations (
          scope_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          PRIMARY KEY(scope_key,operation_id)
        );
        CREATE TABLE IF NOT EXISTS context_stop_fences (
          scope_key TEXT PRIMARY KEY, fence_id TEXT NOT NULL, helper_generation TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS context_sources (
          id TEXT PRIMARY KEY, index_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT,
          revision INTEGER NOT NULL, generation INTEGER NOT NULL, sha TEXT, text TEXT, state TEXT NOT NULL,
          reason TEXT, size INTEGER NOT NULL, seen_epoch INTEGER NOT NULL, manifest_digest TEXT
        );
        CREATE INDEX IF NOT EXISTS context_sources_index ON context_sources(index_id,id);
        CREATE INDEX IF NOT EXISTS context_sources_path ON context_sources(index_id,path);
        CREATE TABLE IF NOT EXISTS context_chunks (
          rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, index_id TEXT NOT NULL, source_id TEXT NOT NULL,
          source_gen INTEGER NOT NULL, sha TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, token_count INTEGER, text TEXT NOT NULL,
          name TEXT NOT NULL, vector BLOB, manifest_digest TEXT
        );
        CREATE INDEX IF NOT EXISTS context_chunks_source ON context_chunks(source_id,source_gen);
        CREATE INDEX IF NOT EXISTS context_chunks_page ON context_chunks(index_id,rowid);
        CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(text,name,content='context_chunks',content_rowid='rowid',tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS context_chunks_insert AFTER INSERT ON context_chunks BEGIN
          INSERT INTO context_fts(rowid,text,name) VALUES(new.rowid,new.text,new.name);
        END;
        CREATE TRIGGER IF NOT EXISTS context_chunks_delete AFTER DELETE ON context_chunks BEGIN
          INSERT INTO context_fts(context_fts,rowid,text,name) VALUES('delete',old.rowid,old.text,old.name);
        END;
        CREATE TRIGGER IF NOT EXISTS context_chunks_update AFTER UPDATE OF text,name ON context_chunks BEGIN
          INSERT INTO context_fts(context_fts,rowid,text,name) VALUES('delete',old.rowid,old.text,old.name);
          INSERT INTO context_fts(rowid,text,name) VALUES(new.rowid,new.text,new.name);
        END;
        PRAGMA user_version=2;
        UPDATE context_indexes SET generation=generation+1,state='stale',coverage='unknown',reason='host_restarted'
          WHERE scope_key NOT IN (SELECT scope_key FROM context_stop_fences);
        UPDATE context_sources SET generation=generation+1,state='stale',reason='host_restarted' WHERE kind='file' AND state IN ('indexed','pending');
      `);
    });
  }

  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  index(scope: HostContextScope): IndexRow | null {
    const row = this.db
      .prepare("SELECT * FROM context_indexes WHERE scope_key=?")
      .get(scopeKey(scope));
    return row ? indexRowSchema.parse(row) : null;
  }

  stopFence(scope: HostContextScope) {
    const row = this.db
      .prepare(
        "SELECT fence_id,helper_generation FROM context_stop_fences WHERE scope_key=?",
      )
      .get(scopeKey(scope));
    return row ? stopFenceSchema.parse(row) : null;
  }

  retainStopFence(scope: HostContextScope, generation: string | null): void {
    this.transaction(() => {
      const prior = this.stopFence(scope);
      this.db
        .prepare(
          `INSERT INTO context_stop_fences VALUES(?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET fence_id=excluded.fence_id,helper_generation=excluded.helper_generation,created_at=excluded.created_at`,
        )
        .run(
          scopeKey(scope),
          randomUUID(),
          prior && prior.helper_generation !== generation ? null : generation,
          new Date().toISOString(),
        );
      const index = this.index(scope);
      if (index) {
        this.db
          .prepare(
            "UPDATE context_indexes SET generation=generation+1,state='failed',coverage='unknown',semantic='unavailable',reason='embedding_stop_unresolved',updated_at=? WHERE scope_key=?",
          )
          .run(new Date().toISOString(), index.scope_key);
        this.db
          .prepare(
            "UPDATE context_sources SET generation=generation+1,state='stale',reason='embedding_stop_unresolved' WHERE index_id=? AND state!='deleted'",
          )
          .run(index.index_id);
      }
    });
  }

  clearStopFence(scope: HostContextScope, fenceId: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM context_stop_fences WHERE scope_key=? AND fence_id=?",
      )
      .run(scopeKey(scope), fenceId);
    if (!result.changes) return false;
    this.update(scope, {
      state: "stale",
      coverage: "unknown",
      reason: "embedding_stop_confirmed_requires_reindex",
    });
    return true;
  }

  replay(
    scope: HostContextScope,
    operationId: string,
    requestHash: string,
  ): boolean {
    const raw = this.db
      .prepare(
        "SELECT request_hash FROM context_operations WHERE scope_key=? AND operation_id=?",
      )
      .get(scopeKey(scope), operationId);
    if (!raw) return false;
    if (
      z.object({ request_hash: z.string() }).parse(raw).request_hash !==
      requestHash
    )
      throw new Error(
        "Context operation identity was reused with different input.",
      );
    if (this.index(scope)?.operation_id !== operationId)
      throw new Error("Context operation was superseded.");
    return true;
  }

  start(
    scope: HostContextScope,
    operationId: string,
    requestHash: string,
    root: DirectoryRoot,
    git: HostContextStatus["git"],
  ): IndexRow {
    if (this.stopFence(scope))
      throw new Error(
        "Context helper cleanup needs verification before indexing can restart.",
      );
    this.transaction(() => {
      const old = this.index(scope);
      const indexId = `context_${hashText(JSON.stringify([scopeKey(scope), root.rootIdentity])).slice(0, 48)}`;
      if (old && old.index_id !== indexId) {
        this.db
          .prepare("DELETE FROM context_chunks WHERE index_id=?")
          .run(old.index_id);
        this.db
          .prepare("DELETE FROM context_sources WHERE index_id=?")
          .run(old.index_id);
      }
      this.db
        .prepare(
          `INSERT INTO context_indexes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET index_id=excluded.index_id,scope_json=excluded.scope_json,root_json=excluded.root_json,
        git_json=excluded.git_json,generation=excluded.generation,operation_id=excluded.operation_id,state=excluded.state,
        coverage=excluded.coverage,semantic=excluded.semantic,manifest_digest=NULL,reason=NULL,updated_at=excluded.updated_at`,
        )
        .run(
          scopeKey(scope),
          indexId,
          JSON.stringify(scope),
          JSON.stringify(root),
          JSON.stringify(git),
          (old?.generation ?? 0) + 1,
          operationId,
          "indexing",
          "unknown",
          "pending",
          null,
          null,
          new Date().toISOString(),
        );
      this.db
        .prepare("INSERT INTO context_operations VALUES(?,?,?)")
        .run(scopeKey(scope), operationId, requestHash);
      this.db
        .prepare(
          "UPDATE context_sources SET state='stale',generation=generation+1,reason='reindex_requested' WHERE index_id=? AND state IN ('indexed','pending')",
        )
        .run(indexId);
    });
    const row = this.index(scope);
    if (!row) throw new Error("Context index admission was not retained.");
    return row;
  }

  update(
    scope: HostContextScope,
    values: {
      state?: HostContextStatus["state"];
      coverage?: HostContextStatus["coverage"];
      semantic?: HostContextStatus["semantic"];
      manifestDigest?: string | null;
      reason?: string | null;
      git?: HostContextStatus["git"];
    },
  ): void {
    const row = this.index(scope);
    if (!row) return;
    if (this.stopFence(scope)) return;
    this.db
      .prepare(
        "UPDATE context_indexes SET state=?,coverage=?,semantic=?,manifest_digest=?,reason=?,git_json=?,updated_at=? WHERE scope_key=?",
      )
      .run(
        values.state ?? row.state,
        values.coverage ?? row.coverage,
        values.semantic ?? row.semantic,
        values.manifestDigest === undefined
          ? row.manifest_digest
          : values.manifestDigest,
        values.reason === undefined ? row.reason : values.reason,
        values.git === undefined ? row.git_json : JSON.stringify(values.git),
        new Date().toISOString(),
        row.scope_key,
      );
  }

  invalidate(
    scope: HostContextScope,
    paths: readonly string[] | null,
    reason: string,
    state: HostContextStatus["state"] = "indexing",
  ): void {
    const index = this.index(scope);
    if (!index) return;
    if (this.stopFence(scope)) return;
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE context_indexes SET generation=generation+1,state=?,coverage=?,reason=?,updated_at=? WHERE scope_key=?",
        )
        .run(
          state,
          paths === null ? "unknown" : "partial",
          reason,
          new Date().toISOString(),
          index.scope_key,
        );
      if (paths === null)
        this.db
          .prepare(
            "UPDATE context_sources SET generation=generation+1,state='stale',reason=? WHERE index_id=? AND state!='deleted'",
          )
          .run(reason, index.index_id);
      else
        for (const path of paths)
          this.db
            .prepare(
              "UPDATE context_sources SET generation=generation+1,state='stale',reason=? WHERE index_id=? AND path=? AND kind='file'",
            )
            .run(reason, index.index_id, path);
    });
  }

  status(scope: HostContextScope): HostContextStatus {
    const row = this.index(scope);
    const empty = {
      discovered: 0,
      indexed: 0,
      stale: 0,
      skipped: 0,
      failed: 0,
      chunks: 0,
      embeddedChunks: 0,
    };
    if (!row)
      return {
        scope,
        indexId: null,
        generation: 0,
        operationId: null,
        state: "absent",
        coverage: "unknown",
        root: null,
        git: null,
        counts: empty,
        semantic: "unavailable",
        manifestDigest: null,
        reason: null,
        updatedAt: null,
      };
    const sources = z
      .object({
        discovered: z.number(),
        indexed: z.number(),
        stale: z.number(),
        skipped: z.number(),
        failed: z.number(),
      })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(*) discovered,COALESCE(SUM(state='indexed'),0) "indexed",
        COALESCE(SUM(state IN ('pending','stale')),0) stale,COALESCE(SUM(state='skipped'),0) skipped,
        COALESCE(SUM(state='failed'),0) failed FROM context_sources WHERE index_id=? AND state!='deleted'`,
          )
          .get(row.index_id),
      );
    const chunks = z
      .object({ chunks: z.number(), embeddedChunks: z.number() })
      .parse(
        this.db
          .prepare(
            `SELECT COUNT(*) chunks,COALESCE(SUM(c.vector IS NOT NULL),0) embeddedChunks
      FROM context_chunks c JOIN context_sources s ON s.id=c.source_id AND s.generation=c.source_gen AND s.state='indexed' WHERE c.index_id=?`,
          )
          .get(row.index_id),
      );
    return {
      scope: hostContextScopeSchema.parse(JSON.parse(row.scope_json)),
      indexId: row.index_id,
      generation: row.generation,
      operationId: row.operation_id,
      state: row.state,
      coverage: row.coverage,
      root: directoryRootSchema.parse(JSON.parse(row.root_json)),
      git: gitSchema.parse(JSON.parse(row.git_json)),
      counts: { ...sources, ...chunks },
      semantic: row.semantic,
      manifestDigest: row.manifest_digest,
      reason: row.reason,
      updatedAt: row.updated_at,
    };
  }

  source(id: string, indexId: string): SourceRow | null {
    const row = this.db
      .prepare("SELECT * FROM context_sources WHERE id=? AND index_id=?")
      .get(id, indexId);
    return row ? sourceRowSchema.parse(row) : null;
  }

  ensureSource(
    indexId: string,
    input: {
      id: string;
      name: string;
      kind: SourceRow["kind"];
      path: string | null;
      revision: number;
    },
    epoch: number,
  ): SourceRow {
    this.db
      .prepare(
        `INSERT INTO context_sources VALUES(?,?,?,?,?,?,1,NULL,NULL,'pending',NULL,0,?,NULL)
      ON CONFLICT(id) DO UPDATE SET seen_epoch=excluded.seen_epoch`,
      )
      .run(
        input.id,
        indexId,
        input.name,
        input.kind,
        input.path,
        input.revision,
        epoch,
      );
    const row = this.source(input.id, indexId);
    if (!row) throw new Error("Context source identity collision.");
    return row;
  }

  content(
    source: SourceRow,
    text: string,
    sha: string,
    size: number,
    revision: number,
    name: string,
  ): boolean {
    const result = this.db
      .prepare(
        "UPDATE context_sources SET text=?,sha=?,size=?,revision=?,name=?,state='pending',reason=NULL WHERE id=? AND index_id=? AND generation=?",
      )
      .run(
        text,
        sha,
        size,
        revision,
        name,
        source.id,
        source.index_id,
        source.generation,
      );
    return Number(result.changes) === 1;
  }

  mark(
    source: SourceRow,
    state: SourceRow["state"],
    reason: string,
    size = 0,
  ): void {
    this.db
      .prepare(
        "UPDATE context_sources SET state=?,reason=?,size=? WHERE id=? AND index_id=? AND generation=?",
      )
      .run(state, reason, size, source.id, source.index_id, source.generation);
  }

  nextEpoch(indexId: string): number {
    return z
      .object({ epoch: z.number() })
      .parse(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seen_epoch),0)+1 epoch FROM context_sources WHERE index_id=?",
          )
          .get(indexId),
      ).epoch;
  }

  commit(
    scope: HostContextScope,
    operationId: string,
    source: SourceRow,
    sha: string,
    chunks: StoredChunk[],
    manifestDigest: string | null,
  ): boolean {
    return this.transaction(() => {
      const index = this.index(scope);
      const current = this.source(source.id, source.index_id);
      if (
        !index ||
        index.operation_id !== operationId ||
        index.index_id !== source.index_id ||
        !current ||
        current.generation !== source.generation ||
        current.sha !== sha ||
        !["pending", "indexed"].includes(current.state)
      )
        return false;
      this.db
        .prepare("DELETE FROM context_chunks WHERE source_id=?")
        .run(source.id);
      const insert = this.db.prepare(
        "INSERT INTO context_chunks(chunk_id,index_id,source_id,source_gen,sha,start_offset,end_offset,start_line,end_line,token_count,text,name,vector,manifest_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const chunk of chunks) {
        let vector: Buffer | null = null;
        if (chunk.vector) {
          if (
            chunk.vector.length !== 384 ||
            chunk.vector.some((value) => !Number.isFinite(value))
          )
            throw new Error("Invalid Context vector.");
          vector = Buffer.alloc(384 * 4);
          chunk.vector.forEach((value, i) =>
            vector?.writeFloatLE(value, i * 4),
          );
        }
        insert.run(
          chunk.id,
          source.index_id,
          source.id,
          source.generation,
          sha,
          chunk.start,
          chunk.end,
          chunk.startLine,
          chunk.endLine,
          chunk.tokenCount,
          chunk.text,
          current.name,
          vector,
          vector ? manifestDigest : null,
        );
      }
      this.db
        .prepare(
          "UPDATE context_sources SET state='indexed',reason=NULL,manifest_digest=? WHERE id=?",
        )
        .run(manifestDigest, source.id);
      return true;
    });
  }

  finishTraversal(indexId: string, epoch: number): void {
    this.db
      .prepare(
        "UPDATE context_sources SET state='deleted',generation=generation+1,reason='source_removed' WHERE index_id=? AND seen_epoch!=? AND state!='deleted'",
      )
      .run(indexId, epoch);
  }

  vectors(
    scope: HostContextScope,
    operationId: string,
    source: SourceRow,
    sha: string,
    manifestDigest: string,
    items: Array<{ id: string; vector: number[] }>,
  ): boolean {
    return this.transaction(() => {
      const index = this.index(scope),
        current = this.source(source.id, source.index_id);
      if (
        !index ||
        index.operation_id !== operationId ||
        index.index_id !== source.index_id ||
        !current ||
        current.generation !== source.generation ||
        current.sha !== sha ||
        current.state !== "indexed"
      )
        return false;
      const update = this.db.prepare(
        "UPDATE context_chunks SET vector=?,manifest_digest=? WHERE chunk_id=? AND source_id=? AND source_gen=? AND sha=?",
      );
      for (const item of items) {
        if (
          item.vector.length !== 384 ||
          item.vector.some((value) => !Number.isFinite(value)) ||
          Math.abs(Math.hypot(...item.vector) - 1) > 0.001
        )
          throw new Error("Invalid Context vector.");
        const bytes = Buffer.alloc(384 * 4);
        item.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
        if (
          Number(
            update.run(
              bytes,
              manifestDigest,
              item.id,
              source.id,
              source.generation,
              sha,
            ).changes,
          ) !== 1
        )
          throw new Error("Context chunk changed before vector commit.");
      }
      return true;
    });
  }

  sources(indexId: string, after: string, limit: number): HostContextSource[] {
    return this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM context_chunks c WHERE c.source_id=s.id AND c.source_gen=s.generation AND s.state='indexed') chunks,
      (SELECT COUNT(*) FROM context_chunks c WHERE c.source_id=s.id AND c.source_gen=s.generation AND s.state='indexed' AND c.vector IS NOT NULL) embedded_chunks
      FROM context_sources s WHERE s.index_id=? AND s.id>? ORDER BY s.id LIMIT ?`,
      )
      .all(indexId, after, limit)
      .map((raw) => {
        const row = sourceRowSchema
          .extend({ chunks: z.number(), embedded_chunks: z.number() })
          .parse(raw);
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          relativePath: row.path,
          revision: row.revision,
          generation: row.generation,
          sha256: row.sha,
          state: row.state,
          reason: row.reason,
          sizeBytes: row.size,
          chunks: row.chunks,
          embeddedChunks: row.embedded_chunks,
        };
      });
  }

  chunk(indexId: string, id: string): ChunkRow | null {
    const raw = this.db
      .prepare(
        `SELECT c.* FROM context_chunks c JOIN context_sources s ON s.id=c.source_id AND s.generation=c.source_gen AND s.state='indexed' WHERE c.index_id=? AND c.chunk_id=?`,
      )
      .get(indexId, id);
    return raw ? chunkRowSchema.parse(raw) : null;
  }

  lexical(indexId: string, query: string, limit: number): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM context_fts f JOIN context_chunks c ON c.rowid=f.rowid JOIN context_sources s ON s.id=c.source_id
      AND s.generation=c.source_gen AND s.state='indexed' WHERE context_fts MATCH ? AND c.index_id=? ORDER BY bm25(context_fts),c.rowid LIMIT ?`,
      )
      .all(query, indexId, limit)
      .map((row) => chunkRowSchema.parse(row));
  }

  vectorPage(
    indexId: string,
    digest: string,
    after: number,
    limit: number,
  ): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM context_chunks c JOIN context_sources s ON s.id=c.source_id AND s.generation=c.source_gen AND s.state='indexed'
      WHERE c.index_id=? AND c.manifest_digest=? AND c.vector IS NOT NULL AND c.rowid>? ORDER BY c.rowid LIMIT ?`,
      )
      .all(indexId, digest, after, limit)
      .map((row) => chunkRowSchema.parse(row));
  }

  close(): void {
    this.db.close();
  }
}

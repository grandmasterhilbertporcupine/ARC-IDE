import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  hostEffectRecordSchema,
  hostEffectRequestSchema,
  type HostEffectIdentity,
  type HostEffectReceipt,
  type HostEffectRecord,
  type HostEffectRequest,
} from "../host-contract.js";
import { canonicalHostEffectRequest, hostEffectRequestHash } from "./hash.js";
import { samePath } from "./git.js";
import {
  directoryEffectRecordSchema,
  directoryEffectRequestSchema,
  directoryEffectReceiptSchema,
  directorySnapshotSchema,
  directoryRootIdentitySchema,
  type DirectoryBinding,
  type DirectoryEffectIdentity,
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
  type DirectoryEffectReceipt,
  type DirectorySnapshot,
} from "../host-directory-contract.js";
import {
  canonicalDirectoryEffectRequest,
  directoryEffectRequestHash,
} from "./hash.js";
import { DirectoryFailure, type DirectoryInventory } from "./directory.js";

const storedSchema = z.object({
  run_id: z.string(),
  effect_id: z.string(),
  request_hash: z.string(),
  request_json: z.string(),
  state: z.enum(["running", "terminal", "needs-reconciliation"]),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  receipt_json: z.string().nullable(),
  resource: z.string(),
  effect_kind: z.enum(["git", "directory"]),
  scan_owner_pid: z.number().int().positive().nullable(),
});
const workspaceSchema = z.object({
  path: z.string(),
  run_id: z.string(),
  common_git_dir: z.string(),
  original_path: z.string(),
  ready: z.number(),
});
const directoryWorkspaceSchema = z.object({
  path: z.string(),
  run_id: z.string(),
  workspace_id: z.string(),
  original_path: z.string(),
  role: z.enum(["working", "snapshot"]),
  root_identity_json: z.string().nullable(),
  source_snapshot_id: z.string().nullable(),
  creator_effect_id: z.string(),
  ready: z.number(),
});
type DirectoryReservation = {
  path: string;
  workspaceId: string;
  originalPath: string;
  role: "working" | "snapshot";
  sourceSnapshotId: string | null;
};

export class HostJournal {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version = z
      .object({ user_version: z.number() })
      .parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
      this.db.close();
      throw new Error("Unsupported ARC host journal version.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS effects (
        effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','terminal','needs-reconciliation')),
        started_at TEXT NOT NULL, finished_at TEXT, receipt_json TEXT, resource TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS effects_resource_state ON effects(resource,state);
      CREATE TABLE IF NOT EXISTS lanes (lane_key TEXT PRIMARY KEY, fence INTEGER NOT NULL, effect_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        path TEXT PRIMARY KEY, run_id TEXT NOT NULL, common_git_dir TEXT NOT NULL, original_path TEXT NOT NULL, ready INTEGER NOT NULL
      );
    `);
      if (version < 2)
        this.db.exec(
          "ALTER TABLE effects ADD COLUMN effect_kind TEXT NOT NULL DEFAULT 'git' CHECK(effect_kind IN ('git','directory'));",
        );
      if (version < 3)
        this.db.exec(
          "ALTER TABLE effects ADD COLUMN scan_owner_pid INTEGER CHECK(scan_owner_pid IS NULL OR scan_owner_pid > 0);",
        );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS directory_workspaces (
          path TEXT PRIMARY KEY, run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, original_path TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('working','snapshot')), root_identity_json TEXT, source_snapshot_id TEXT,
          creator_effect_id TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, UNIQUE(run_id,workspace_id)
        );
        CREATE TABLE IF NOT EXISTS directory_snapshots (
          snapshot_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE, creator_effect_id TEXT NOT NULL UNIQUE,
          manifest_digest TEXT NOT NULL, manifest_json TEXT NOT NULL, entry_count INTEGER NOT NULL, file_bytes INTEGER NOT NULL
        );
        PRAGMA user_version=3;
        UPDATE effects SET state='needs-reconciliation' WHERE state='running';
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  private stored(effectId: string) {
    const row = this.db
      .prepare("SELECT * FROM effects WHERE effect_id=?")
      .get(effectId);
    return row === undefined ? null : storedSchema.parse(row);
  }

  get(effectId: string): HostEffectRecord | null {
    const row = this.stored(effectId);
    if (!row) return null;
    if (row.effect_kind !== "git")
      throw new Error("This native effect is not a Git effect.");
    return hostEffectRecordSchema.parse({
      runId: row.run_id,
      effectId: row.effect_id,
      requestHash: row.request_hash,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
      receiptValidity: null,
    });
  }

  request(effectId: string): HostEffectRequest {
    const row = this.stored(effectId);
    if (!row) throw new Error("Native effect does not exist.");
    if (row.effect_kind !== "git")
      throw new Error("This native effect is not a Git effect.");
    return hostEffectRequestSchema.parse(JSON.parse(row.request_json));
  }

  identify(identity: HostEffectIdentity): HostEffectRecord | null {
    const record = this.get(identity.effectId);
    if (
      record &&
      (record.runId !== identity.runId ||
        record.requestHash !== identity.requestHash)
    )
      throw new Error(
        "Native effect ownership or request hash does not match.",
      );
    return record;
  }

  admit(
    request: HostEffectRequest,
    resource: string,
  ): { record: HostEffectRecord; created: boolean } {
    const requestHash = hostEffectRequestHash(request);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.identify({
        runId: request.runId,
        effectId: request.effectId,
        requestHash,
      });
      if (existing) {
        this.db.exec("COMMIT");
        return { record: existing, created: false };
      }
      const occupied = this.db
        .prepare(
          "SELECT effect_id FROM effects WHERE resource=? AND state!='terminal' LIMIT 1",
        )
        .get(resource);
      if (occupied)
        throw new Error(
          "Workspace has an active or unreconciled native effect.",
        );
      if (request.lane !== null) {
        const lane = this.db
          .prepare("SELECT fence,effect_id FROM lanes WHERE lane_key=?")
          .get(request.lane.key);
        if (lane) {
          const current = z
            .object({ fence: z.number(), effect_id: z.string() })
            .parse(lane);
          if (request.lane.fence <= current.fence)
            throw new Error("Native integration lane fence is stale.");
          const owner = this.stored(current.effect_id);
          if (owner?.state !== "terminal")
            throw new Error("Native integration lane is still occupied.");
        }
        this.db
          .prepare(
            "INSERT INTO lanes(lane_key,fence,effect_id) VALUES(?,?,?) ON CONFLICT(lane_key) DO UPDATE SET fence=excluded.fence,effect_id=excluded.effect_id",
          )
          .run(request.lane.key, request.lane.fence, request.effectId);
      }
      this.db
        .prepare(
          "INSERT INTO effects(effect_id,run_id,request_hash,request_json,state,started_at,resource) VALUES(?,?,?,?,'running',?,?)",
        )
        .run(
          request.effectId,
          request.runId,
          requestHash,
          canonicalHostEffectRequest(request),
          new Date().toISOString(),
          resource,
        );
      this.db.exec("COMMIT");
      return { record: this.get(request.effectId)!, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertFence(request: HostEffectRequest): void {
    if (this.get(request.effectId)?.state !== "running")
      throw new Error("Native effect no longer owns its execution intent.");
    if (request.lane === null) return;
    const row = z
      .object({ fence: z.number(), effect_id: z.string() })
      .parse(
        this.db
          .prepare("SELECT fence,effect_id FROM lanes WHERE lane_key=?")
          .get(request.lane.key),
      );
    if (row.fence !== request.lane.fence || row.effect_id !== request.effectId)
      throw new Error("Native integration lane fence changed.");
  }

  getDirectory(effectId: string): DirectoryEffectRecord | null {
    const row = this.stored(effectId);
    if (!row) return null;
    if (row.effect_kind !== "directory")
      throw new Error("This native effect is not a directory effect.");
    return directoryEffectRecordSchema.parse({
      kind: "directory",
      runId: row.run_id,
      effectId: row.effect_id,
      requestHash: row.request_hash,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
    });
  }

  directoryRequest(effectId: string): DirectoryEffectRequest {
    const row = this.stored(effectId);
    if (!row || row.effect_kind !== "directory")
      throw new Error("Directory effect does not exist.");
    return directoryEffectRequestSchema.parse(JSON.parse(row.request_json));
  }

  identifyDirectory(
    identity: DirectoryEffectIdentity,
  ): DirectoryEffectRecord | null {
    const record = this.getDirectory(identity.effectId);
    if (
      record &&
      (record.runId !== identity.runId ||
        record.requestHash !== identity.requestHash)
    )
      throw new DirectoryFailure(
        "ownership_mismatch",
        "Directory effect owner or immutable request hash does not match.",
      );
    return record;
  }

  admitDirectory(
    request: DirectoryEffectRequest,
    resource: string,
    reservation: DirectoryReservation | null,
    scanOwnerPid: number | null = null,
  ): { record: DirectoryEffectRecord; created: boolean } {
    if (
      scanOwnerPid !== null &&
      (request.operation.type !== "scan-directory" ||
        !Number.isSafeInteger(scanOwnerPid) ||
        scanOwnerPid <= 0)
    )
      throw new Error(
        "Only read-only directory scans retain an execution PID.",
      );
    const requestHash = directoryEffectRequestHash(request);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.identifyDirectory({
        runId: request.runId,
        effectId: request.effectId,
        requestHash,
      });
      if (existing) {
        this.db.exec("COMMIT");
        return { record: existing, created: false };
      }
      if (
        this.db
          .prepare(
            "SELECT effect_id FROM effects WHERE resource=? AND state!='terminal' LIMIT 1",
          )
          .get(resource)
      )
        throw new DirectoryFailure(
          "ownership_mismatch",
          "Directory has an active or unreconciled native operation.",
        );
      if (request.lane !== null) {
        const raw = this.db
          .prepare("SELECT fence,effect_id FROM lanes WHERE lane_key=?")
          .get(request.lane.key);
        if (raw) {
          const lane = z
            .object({ fence: z.number(), effect_id: z.string() })
            .parse(raw);
          if (
            request.lane.fence <= lane.fence ||
            this.stored(lane.effect_id)?.state !== "terminal"
          )
            throw new DirectoryFailure(
              "ownership_mismatch",
              "Directory serial lane is stale or still occupied.",
            );
        }
        this.db
          .prepare(
            "INSERT INTO lanes(lane_key,fence,effect_id) VALUES(?,?,?) ON CONFLICT(lane_key) DO UPDATE SET fence=excluded.fence,effect_id=excluded.effect_id",
          )
          .run(request.lane.key, request.lane.fence, request.effectId);
      }
      if (reservation !== null) {
        if (
          this.db
            .prepare(
              "SELECT path FROM directory_workspaces WHERE path=? OR (run_id=? AND workspace_id=?)",
            )
            .get(reservation.path, request.runId, reservation.workspaceId)
        )
          throw new DirectoryFailure(
            "destination_exists",
            "Directory workspace path or ID is already reserved.",
          );
        this.db
          .prepare(
            "INSERT INTO directory_workspaces(path,run_id,workspace_id,original_path,role,source_snapshot_id,creator_effect_id,ready) VALUES(?,?,?,?,?,?,?,0)",
          )
          .run(
            reservation.path,
            request.runId,
            reservation.workspaceId,
            reservation.originalPath,
            reservation.role,
            reservation.sourceSnapshotId,
            request.effectId,
          );
      }
      this.db
        .prepare(
          "INSERT INTO effects(effect_id,run_id,request_hash,request_json,state,started_at,resource,effect_kind,scan_owner_pid) VALUES(?,?,?,?,'running',?,?,'directory',?)",
        )
        .run(
          request.effectId,
          request.runId,
          requestHash,
          canonicalDirectoryEffectRequest(request),
          new Date().toISOString(),
          resource,
          scanOwnerPid,
        );
      this.db.exec("COMMIT");
      return { record: this.getDirectory(request.effectId)!, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  directoryScanOwner(identity: DirectoryEffectIdentity): number | null {
    const record = this.identifyDirectory(identity);
    if (!record || record.state === "terminal") return null;
    const row = this.stored(identity.effectId)!;
    return this.directoryRequest(identity.effectId).operation.type ===
      "scan-directory"
      ? row.scan_owner_pid
      : null;
  }

  finishStoppedDirectoryScan(
    identity: DirectoryEffectIdentity,
    ownerPid: number,
  ): void {
    if (this.directoryScanOwner(identity) !== ownerPid) return;
    const receipt = directoryEffectReceiptSchema.parse({
      kind: "directory",
      operationType: "scan-directory",
      outcome: "interrupted",
      errorCode: "interrupted",
      reason:
        "The read-only scan's owning execution stopped without retaining a complete inventory. Start a new validation pass.",
      before: null,
      after: null,
      source: null,
      processes: [],
      artifact: null,
      finishedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        "UPDATE effects SET state='terminal',finished_at=?,receipt_json=? WHERE effect_id=? AND run_id=? AND request_hash=? AND effect_kind='directory' AND scan_owner_pid=? AND state IN ('running','needs-reconciliation')",
      )
      .run(
        receipt.finishedAt,
        JSON.stringify(receipt),
        identity.effectId,
        identity.runId,
        identity.requestHash,
        ownerPid,
      );
  }

  assertDirectoryFence(request: DirectoryEffectRequest): void {
    const row = this.stored(request.effectId);
    if (
      row?.effect_kind !== "directory" ||
      row.run_id !== request.runId ||
      row.state !== "running" ||
      row.request_hash !== directoryEffectRequestHash(request)
    )
      throw new NativeJournalStateError(
        "Directory effect no longer owns its execution intent.",
      );
    if (request.lane === null) return;
    const lane = z
      .object({ fence: z.number(), effect_id: z.string() })
      .parse(
        this.db
          .prepare("SELECT fence,effect_id FROM lanes WHERE lane_key=?")
          .get(request.lane.key),
      );
    if (
      lane.fence !== request.lane.fence ||
      lane.effect_id !== request.effectId
    )
      throw new NativeJournalStateError("Directory serial lane changed.");
  }

  requireDirectoryWorkspace(
    binding: DirectoryBinding,
    runId: string,
    role?: "working" | "snapshot",
  ) {
    const raw = this.db
      .prepare("SELECT * FROM directory_workspaces WHERE path=?")
      .get(binding.path);
    if (!raw)
      throw new DirectoryFailure(
        "ownership_mismatch",
        `Directory is not owned by this journal: ${binding.path}`,
      );
    const row = directoryWorkspaceSchema.parse(raw);
    if (
      row.run_id !== runId ||
      row.workspace_id !== binding.workspaceId ||
      !samePath(row.original_path, binding.originalPath) ||
      row.ready !== 1 ||
      row.root_identity_json === null ||
      (role !== undefined && row.role !== role)
    )
      throw new DirectoryFailure(
        "ownership_mismatch",
        `Directory is not a ready ${role ?? "owned"} workspace of this run: ${binding.path}`,
      );
    const rootIdentity = directoryRootIdentitySchema.parse(
      JSON.parse(row.root_identity_json),
    );
    if (
      rootIdentity.deviceId !== binding.rootIdentity.deviceId ||
      rootIdentity.fileId !== binding.rootIdentity.fileId
    )
      throw new DirectoryFailure(
        "ownership_mismatch",
        `Directory physical identity differs from its reservation: ${binding.path}`,
      );
    if (row.role === "snapshot") {
      const snapshot = z
        .object({ manifest_digest: z.string() })
        .parse(
          this.db
            .prepare(
              "SELECT manifest_digest FROM directory_snapshots WHERE workspace_path=?",
            )
            .get(row.path),
        );
      if (snapshot.manifest_digest !== binding.expectedManifestDigest)
        throw new DirectoryFailure(
          "ownership_mismatch",
          "Snapshot manifest differs from its retained identity.",
        );
    }
    return row;
  }

  directorySnapshot(snapshotId: string, runId: string): DirectorySnapshot {
    const raw = this.db
      .prepare(
        "SELECT s.snapshot_id,s.manifest_digest,w.* FROM directory_snapshots s JOIN directory_workspaces w ON w.path=s.workspace_path WHERE s.snapshot_id=? AND w.run_id=?",
      )
      .get(snapshotId, runId);
    if (!raw)
      throw new DirectoryFailure(
        "ownership_mismatch",
        "Snapshot is not owned by this run and journal.",
      );
    const row = directoryWorkspaceSchema
      .extend({ snapshot_id: z.string(), manifest_digest: z.string() })
      .parse(raw);
    if (
      row.ready !== 1 ||
      row.role !== "snapshot" ||
      row.root_identity_json === null
    )
      throw new DirectoryFailure(
        "ownership_mismatch",
        "Snapshot is not ready.",
      );
    return directorySnapshotSchema.parse({
      kind: "directory-snapshot",
      snapshotId: row.snapshot_id,
      manifestDigest: row.manifest_digest,
      workspace: {
        kind: "directory",
        path: row.path,
        rootIdentity: JSON.parse(row.root_identity_json),
        workspaceId: row.workspace_id,
        originalPath: row.original_path,
        expectedManifestDigest: row.manifest_digest,
      },
    });
  }

  requireDirectorySnapshot(snapshot: DirectorySnapshot, runId: string): void {
    const retained = this.directorySnapshot(snapshot.snapshotId, runId);
    if (
      JSON.stringify(retained) !==
      JSON.stringify(directorySnapshotSchema.parse(snapshot))
    )
      throw new DirectoryFailure(
        "ownership_mismatch",
        "Snapshot binding or manifest differs from its retained identity.",
      );
  }

  finishDirectory(effectId: string, receipt: DirectoryEffectReceipt): void {
    receipt = directoryEffectReceiptSchema.parse(receipt);
    if (
      this.directoryRequest(effectId).operation.type !== receipt.operationType
    )
      throw new NativeJournalStateError(
        "Directory receipt operation differs from its intent.",
      );
    const result = this.db
      .prepare(
        "UPDATE effects SET state='terminal',finished_at=?,receipt_json=? WHERE effect_id=? AND effect_kind='directory' AND state='running'",
      )
      .run(receipt.finishedAt, JSON.stringify(receipt), effectId);
    if (result.changes !== 1)
      throw new NativeJournalStateError(
        "Directory effect lost its receipt write authority.",
      );
  }

  finishDirectoryWorkspace(
    effectId: string,
    receipt: DirectoryEffectReceipt,
    inventory: DirectoryInventory,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE directory_workspaces SET ready=1,root_identity_json=? WHERE path=? AND creator_effect_id=? AND ready=0",
        )
        .run(
          JSON.stringify(inventory.state.rootIdentity),
          inventory.state.path,
          effectId,
        );
      if (changed.changes !== 1)
        throw new NativeJournalStateError(
          "Directory workspace lost its reservation.",
        );
      if (receipt.artifact?.kind === "snapshot") {
        this.db
          .prepare(
            "INSERT INTO directory_snapshots(snapshot_id,workspace_path,creator_effect_id,manifest_digest,manifest_json,entry_count,file_bytes) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            receipt.artifact.snapshot.snapshotId,
            inventory.state.path,
            effectId,
            inventory.state.manifestDigest,
            inventory.manifestJson,
            inventory.state.entryCount,
            inventory.state.fileBytes,
          );
      }
      this.finishDirectory(effectId, receipt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserveWorkspace(
    path: string,
    runId: string,
    commonGitDir: string,
    originalPath: string,
  ): void {
    const existing = this.db
      .prepare("SELECT * FROM workspaces WHERE path=?")
      .get(path);
    if (existing) throw new Error("Run workspace path is already reserved.");
    this.db
      .prepare(
        "INSERT INTO workspaces(path,run_id,common_git_dir,original_path,ready) VALUES(?,?,?,?,0)",
      )
      .run(path, runId, commonGitDir, originalPath);
  }

  readyWorkspace(path: string): void {
    this.db.prepare("UPDATE workspaces SET ready=1 WHERE path=?").run(path);
  }

  requireWorkspace(
    path: string,
    runId: string,
    commonGitDir: string,
    originalPath: string,
  ): void {
    const row = workspaceSchema.parse(
      this.db.prepare("SELECT * FROM workspaces WHERE path=?").get(path),
    );
    if (
      row.run_id !== runId ||
      row.ready !== 1 ||
      !samePath(row.common_git_dir, commonGitDir) ||
      !samePath(row.original_path, originalPath)
    )
      throw new Error(
        "Workspace is not a ready native workspace owned by this run.",
      );
  }

  finish(effectId: string, receipt: HostEffectReceipt): void {
    const result = this.db
      .prepare(
        "UPDATE effects SET state='terminal',finished_at=?,receipt_json=? WHERE effect_id=? AND state='running'",
      )
      .run(receipt.finishedAt, JSON.stringify(receipt), effectId);
    if (result.changes !== 1)
      throw new NativeJournalStateError(
        "Native effect lost its receipt write authority.",
      );
  }

  finishWorkspace(
    effectId: string,
    receipt: HostEffectReceipt,
    path: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE workspaces SET ready=1 WHERE path=? AND ready=0 AND run_id=(SELECT run_id FROM effects WHERE effect_id=?)",
        )
        .run(path, effectId);
      if (result.changes !== 1)
        throw new NativeJournalStateError(
          "Native effect lost its workspace reservation.",
        );
      this.finish(effectId, receipt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  uncertain(effectId: string): void {
    this.db
      .prepare(
        "UPDATE effects SET state='needs-reconciliation' WHERE effect_id=? AND state='running'",
      )
      .run(effectId);
  }

  close(): void {
    this.db.close();
  }
}

export class NativeJournalStateError extends Error {}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  directoryEffectRequestSchema,
  type DirectoryBinding,
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
  type DirectorySnapshot,
  type DirectoryState,
} from "../host-directory-contract.js";
import { NativeEffects } from "./effects.js";
import { scanDirectory } from "./directory.js";
import { HostJournal } from "./journal.js";
import { directoryEffectRequestHash, hostEffectRequestHash } from "./hash.js";

let fixture: string;
let source: string;
let data: string;
let engine: NativeEffects;
let initial: DirectoryState;
let sequence: number;
const runId = "directory-native-run";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "ARC directory effects 東京 '& "));
  source = join(fixture, "original");
  data = join(fixture, "host-data");
  sequence = 0;
  await mkdir(source);
  await writeFile(join(source, "input.txt"), "original");
  initial = (await scanDirectory(source, AbortSignal.timeout(30_000))).state;
  engine = await NativeEffects.open(data);
});
afterEach(async () => {
  await engine.dispose();
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

function request(
  operation: DirectoryEffectRequest["operation"],
): DirectoryEffectRequest {
  const id = ++sequence;
  return {
    kind: "directory",
    runId,
    effectId: `directory-effect-${id}`,
    lane:
      operation.type === "scan-directory"
        ? null
        : { key: "serial-directory-lane", fence: id },
    operation,
  };
}
async function settled(
  input: DirectoryEffectRequest,
  start = true,
): Promise<DirectoryEffectRecord> {
  if (start) await engine.startDirectory(input);
  const identity = {
    runId: input.runId,
    effectId: input.effectId,
    requestHash: directoryEffectRequestHash(input),
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = await engine.observeDirectory(identity);
    if (record && record.state !== "running") return record;
    await delay(10);
  }
  throw new Error("Directory effect did not settle");
}
async function snapshot(): Promise<DirectorySnapshot> {
  const record = await settled(
    request({
      type: "capture-source",
      source: initial,
      workspaceId: "source-snapshot",
    }),
  );
  expect(
    record.receipt?.outcome,
    record.receipt?.reason ?? "missing receipt",
  ).toBe("succeeded");
  if (record.receipt?.artifact?.kind !== "snapshot")
    throw new Error("Expected snapshot");
  return record.receipt.artifact.snapshot;
}
async function working(
  snapshot: DirectorySnapshot,
  workspaceId = "working",
): Promise<DirectoryBinding> {
  const record = await settled(
    request({ type: "materialize-directory", source: snapshot, workspaceId }),
  );
  expect(
    record.receipt?.outcome,
    record.receipt?.reason ?? "missing receipt",
  ).toBe("succeeded");
  if (record.receipt?.artifact?.kind !== "working")
    throw new Error("Expected working copy");
  return record.receipt.artifact.workspace;
}

describe("durable native directory effects", () => {
  it("captures, materializes and retains serial writer output without changing the original", async () => {
    const base = await snapshot();
    const writer = await working(base);
    await writeFile(join(writer.path, "input.txt"), "repaired");
    const scan = await settled(
      request({
        type: "scan-directory",
        target: {
          kind: "directory",
          path: writer.path,
          rootIdentity: writer.rootIdentity,
        },
        consumer: { kind: "effect", effectId: "writer", dispatchGeneration: 1 },
        phase: "revalidate",
        validationId: "writer-after",
      }),
    );
    expect(scan.receipt?.outcome).toBe("succeeded");
    if (scan.receipt?.artifact?.kind !== "inspection")
      throw new Error("Expected inspection");
    const captured = await settled(
      request({
        type: "capture-directory",
        source: {
          ...writer,
          expectedManifestDigest: scan.receipt.artifact.state.manifestDigest,
        },
        workspaceId: "output-snapshot",
      }),
    );
    expect(
      captured.receipt?.outcome,
      captured.receipt?.reason ?? "missing receipt",
    ).toBe("succeeded");
    if (captured.receipt?.artifact?.kind !== "snapshot")
      throw new Error("Expected output snapshot");
    expect(captured.receipt.artifact.snapshot.snapshotId).not.toBe(
      base.snapshotId,
    );
    expect(await readFile(join(base.workspace.path, "input.txt"), "utf8")).toBe(
      "original",
    );
    expect(
      await readFile(
        join(captured.receipt.artifact.snapshot.workspace.path, "input.txt"),
        "utf8",
      ),
    ).toBe("repaired");
    expect(
      (await scanDirectory(source, AbortSignal.timeout(30_000))).state,
    ).toEqual(initial);
  });

  it("returns retained receipts on lost-response replay and rejects changed input or family", async () => {
    const input = request({
      type: "capture-source",
      source: initial,
      workspaceId: "snapshot",
    });
    const first = await settled(input);
    expect(await engine.startDirectory(input)).toEqual(first);
    await engine.dispose();
    engine = await NativeEffects.open(data);
    expect(await engine.startDirectory(input)).toEqual(first);
    await expect(
      engine.startDirectory({
        ...input,
        operation: {
          type: "capture-source",
          source: initial,
          workspaceId: "different",
        },
      }),
    ).rejects.toThrow("immutable request hash");
    await expect(
      engine.observe({
        runId,
        effectId: input.effectId,
        requestHash: directoryEffectRequestHash(input),
      }),
    ).rejects.toThrow("not a Git effect");
  });

  it("rejects stale original content and existing deterministic destinations", async () => {
    await writeFile(join(source, "input.txt"), "changed!");
    const invalid = await settled(
      request({
        type: "capture-source",
        source: initial,
        workspaceId: "stale",
      }),
    );
    expect(invalid.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "directory_changed",
      artifact: null,
    });
    initial = (await scanDirectory(source, AbortSignal.timeout(30_000))).state;
    const input = request({
      type: "capture-source",
      source: initial,
      workspaceId: "occupied",
    });
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 32);
    const destination = join(
      data,
      "directories",
      hash(runId),
      hash("occupied"),
    );
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "keep"), "untouched");
    const record = await settled(input);
    expect(record.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "destination_exists",
      artifact: null,
    });
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("untouched");
  });

  it("refuses foreign run snapshots, forged physical roots and stale fences", async () => {
    const base = await snapshot();
    const foreign = await settled({
      ...request({
        type: "materialize-directory",
        source: base,
        workspaceId: "foreign",
      }),
      runId: "foreign-run",
    });
    expect(foreign.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "ownership_mismatch",
    });
    const forged = await settled(
      request({
        type: "materialize-directory",
        source: {
          ...base,
          workspace: {
            ...base.workspace,
            rootIdentity: { ...base.workspace.rootIdentity, fileId: "123" },
          },
        },
        workspaceId: "forged",
      }),
    );
    expect(forged.receipt?.outcome).toBe("invalid");
    await expect(
      engine.startDirectory({
        ...request({
          type: "materialize-directory",
          source: base,
          workspaceId: "stale-fence",
        }),
        lane: { key: "serial-directory-lane", fence: 1 },
      }),
    ).rejects.toThrow("lane is stale");
  });

  it("invalidates checks that write ordinary build caches while preserving the retained snapshot", async () => {
    const base = await snapshot();
    const candidate = await working(base);
    const record = await settled(
      request({
        type: "check-directory",
        workspace: candidate,
        snapshotId: base.snapshotId,
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').mkdirSync('.vite');require('node:fs').writeFileSync('.vite/cache','changed');",
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(record.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "directory_changed",
      artifact: null,
    });
    expect(record.receipt?.processes[0]).toMatchObject({
      exitCode: 0,
      interrupted: false,
    });
    expect(record.receipt?.before?.manifestDigest).not.toBe(
      record.receipt?.after?.manifestDigest,
    );
    expect(
      (await scanDirectory(base.workspace.path, AbortSignal.timeout(30_000)))
        .state.manifestDigest,
    ).toBe(base.manifestDigest);
    expect(
      (await scanDirectory(source, AbortSignal.timeout(30_000))).state,
    ).toEqual(initial);
  });

  it("retains an ordinary failed check with exact snapshot identity and bounded output", async () => {
    const base = await snapshot();
    const candidate = await working(base);
    const record = await settled(
      request({
        type: "check-directory",
        workspace: candidate,
        snapshotId: base.snapshotId,
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('x'.repeat(90000));process.exitCode=7",
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(record.receipt).toMatchObject({
      outcome: "failed",
      errorCode: "process_failed",
    });
    expect(record.receipt?.before).toEqual(record.receipt?.after);
    expect(record.receipt?.processes[0]).toMatchObject({
      exitCode: 7,
      stdoutBytes: 90000,
      truncated: true,
    });
    expect(record.receipt?.processes[0]?.stdout.length).toBe(65536);
  });

  it("asynchronously interrupts a real check process and never replays its native input", async () => {
    const base = await snapshot();
    const candidate = await working(base);
    const readyPath = join(fixture, "check-started");
    const input = request({
      type: "check-directory",
      workspace: candidate,
      snapshotId: base.snapshotId,
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'started');setInterval(()=>{},1000)",
        readyPath,
      ],
      timeoutMs: 30_000,
    });
    await engine.startDirectory(input);
    await expect
      .poll(() => readFile(readyPath, "utf8").catch(() => null), {
        timeout: 10_000,
      })
      .toBe("started");
    await engine.interruptDirectory({
      runId,
      effectId: input.effectId,
      requestHash: directoryEffectRequestHash(input),
    });
    const record = await settled(input, false);
    expect(record.receipt).toMatchObject({
      outcome: "interrupted",
      errorCode: "interrupted",
    });
    expect(record.receipt?.processes[0]?.interrupted).toBe(true);
    expect(await engine.startDirectory(input)).toEqual(record);
    expect(
      (await scanDirectory(source, AbortSignal.timeout(30_000))).state,
    ).toEqual(initial);
  });

  it("keeps each read-only validation pass distinct and observes fresh changed contents", async () => {
    const scan = (validationId: string) =>
      request({
        type: "scan-directory",
        target: { kind: "path", path: source },
        consumer: { kind: "setup", operationId: "setup" },
        phase: "admission",
        validationId,
      });
    const firstInput = scan("first");
    const first = await settled(firstInput);
    expect(first.receipt?.artifact?.kind).toBe("inspection");
    await writeFile(join(source, "input.txt"), "modified");
    expect(
      await engine.observeDirectory({
        runId,
        effectId: firstInput.effectId,
        requestHash: directoryEffectRequestHash(firstInput),
      }),
    ).toEqual(first);
    const second = await settled(scan("second"));
    expect(second.receipt?.after?.manifestDigest).not.toBe(
      first.receipt?.after?.manifestDigest,
    );
    expect(first).not.toHaveProperty("receiptValidity");
  });

  it("retains unknown interrupted copy intent across journal reopen without adopting partial files", async () => {
    await engine.dispose();
    const journal = new HostJournal(join(data, "native-effects.sqlite"));
    const input = request({
      type: "capture-source",
      source: initial,
      workspaceId: "partial",
    });
    const destination = join(data, "partial-intent");
    journal.admitDirectory(input, destination, {
      path: destination,
      workspaceId: "partial",
      originalPath: source,
      role: "snapshot",
      sourceSnapshotId: null,
    });
    await mkdir(destination);
    await writeFile(join(destination, "partial"), "keep evidence");
    journal.close();
    engine = await NativeEffects.open(data);
    const replay = await engine.startDirectory(input);
    expect(replay).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    expect(
      await engine.interruptDirectory({
        runId,
        effectId: input.effectId,
        requestHash: directoryEffectRequestHash(input),
      }),
    ).toEqual(replay);
    expect(await readFile(join(destination, "partial"), "utf8")).toBe(
      "keep evidence",
    );
    expect(
      (await scanDirectory(source, AbortSignal.timeout(30_000))).state,
    ).toEqual(initial);
  });

  it("rejects root replacement before check and unsafe links during an asynchronous scan", async () => {
    const base = await snapshot();
    const candidate = await working(base);
    const moved = `${candidate.path}-moved`;
    await rename(candidate.path, moved);
    await symlink(
      moved,
      candidate.path,
      process.platform === "win32" ? "junction" : "dir",
    );
    const record = await settled(
      request({
        type: "check-directory",
        workspace: candidate,
        snapshotId: base.snapshotId,
        executable: process.execPath,
        args: ["-e", "throw Error('Must not execute')"],
        timeoutMs: 1000,
      }),
    );
    expect(record.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "unsupported_link",
      processes: [],
    });
    await symlink(
      moved,
      join(source, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const scan = await settled(
      request({
        type: "scan-directory",
        target: { kind: "path", path: source },
        consumer: { kind: "setup", operationId: "links" },
        phase: "admission",
        validationId: "links",
      }),
    );
    expect(scan.receipt).toMatchObject({
      outcome: "invalid",
      errorCode: "unsupported_link",
      artifact: null,
    });
  });

  it("migrates an actual version-one journal without changing retained Git request bytes or hashes", async () => {
    const oldPath = join(fixture, "legacy.sqlite");
    const old = new DatabaseSync(oldPath);
    old.exec(
      "CREATE TABLE effects(effect_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,receipt_json TEXT,resource TEXT NOT NULL); PRAGMA user_version=1;",
    );
    const gitRequest = {
      runId: "git-run",
      effectId: "git-effect",
      workspace: {
        path: source,
        commonGitDir: join(source, ".git"),
        originalPath: source,
        expectedHead: "a".repeat(40),
        expectedStateDigest: null,
      },
      lane: null,
      operation: { type: "snapshot" as const },
    };
    const raw = JSON.stringify(gitRequest);
    const hash = hostEffectRequestHash(gitRequest);
    old
      .prepare("INSERT INTO effects VALUES(?,?,?,?,?,?,NULL,NULL,?)")
      .run(
        "git-effect",
        "git-run",
        hash,
        raw,
        "needs-reconciliation",
        new Date().toISOString(),
        source,
      );
    old.close();
    const journal = new HostJournal(oldPath);
    expect(journal.get("git-effect")).toMatchObject({
      requestHash: hash,
      state: "needs-reconciliation",
    });
    expect(journal.request("git-effect")).toEqual(gitRequest);
    expect(() => journal.getDirectory("git-effect")).toThrow(
      "not a directory effect",
    );
    journal.close();
    const inspect = new DatabaseSync(oldPath, { readOnly: true });
    expect(
      inspect
        .prepare(
          "SELECT request_json FROM effects WHERE effect_id='git-effect'",
        )
        .get(),
    ).toMatchObject({ request_json: raw });
    expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 3,
    });
    inspect.close();
  });

  it("validates distinct read-only and mutating lane requirements before native admission", () => {
    expect(() =>
      directoryEffectRequestSchema.parse({
        ...request({
          type: "capture-source",
          source: initial,
          workspaceId: "missing-lane",
        }),
        lane: null,
      }),
    ).toThrow("serial lane fence");
    expect(() =>
      directoryEffectRequestSchema.parse({
        ...request({
          type: "scan-directory",
          target: { kind: "path", path: source },
          consumer: { kind: "setup", operationId: "setup" },
          phase: "admission",
          validationId: "validation",
        }),
        lane: { key: "bad", fence: 1 },
      }),
    ).toThrow("do not acquire");
  });
});

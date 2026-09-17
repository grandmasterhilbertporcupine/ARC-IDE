import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  directoryEffectRecordSchema,
  type DirectoryEffectRequest,
} from "../host-directory-contract.js";
import { NativeEffects } from "./effects.js";
import {
  canonicalDirectoryEffectRequest,
  directoryEffectRequestHash,
} from "./hash.js";
import { requireDirectorySource, scanDirectory } from "./directory.js";

let fixture: string;
let source: string;
let data: string;
let engine: NativeEffects | null;
let child: ChildProcess | null;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "ARC actual scan crash Δ "));
  source = join(fixture, "source");
  data = join(fixture, "host");
  engine = null;
  child = null;
  await mkdir(source);
  await writeFile(join(source, "untouched.txt"), "original evidence");
});
afterEach(async () => {
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await engine?.dispose();
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

function request(effectId: string): DirectoryEffectRequest {
  return {
    kind: "directory",
    runId: "actual-scan-recovery",
    effectId,
    lane: null,
    operation: {
      type: "scan-directory",
      target: { kind: "path", path: source },
      consumer: {
        kind: "effect",
        effectId: "retained-proof",
        dispatchGeneration: 1,
      },
      phase: "revalidate",
      validationId: `validation-${effectId}`,
    },
  };
}
function identity(input: DirectoryEffectRequest) {
  return {
    runId: input.runId,
    effectId: input.effectId,
    requestHash: directoryEffectRequestHash(input),
  };
}
async function startHeldScan(input: DirectoryEffectRequest): Promise<number> {
  await Promise.all(
    Array.from({ length: 750 }, (_, index) =>
      writeFile(
        join(source, `entry-${index}.txt`),
        `Actual inventory entry ${index}`,
      ),
    ),
  );
  child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "held-directory-scan.mjs",
      ),
      data,
      JSON.stringify(input),
    ],
    {
      cwd: join(dirname(fileURLToPath(import.meta.url)), "../../.."),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [message] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => {
      throw new Error(
        `Scan fixture exited before admission (${code}): ${stderr}`,
      );
    }),
  ]);
  const received = z
    .object({
      pid: z.number().int().positive(),
      record: directoryEffectRecordSchema,
    })
    .parse(message);
  expect(received.pid).toBe(child.pid);
  expect(received.record).toMatchObject({
    state: "running",
    receipt: null,
    requestHash: identity(input).requestHash,
  });
  const db = new DatabaseSync(join(data, "native-effects.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      db
        .prepare("SELECT state,scan_owner_pid FROM effects WHERE effect_id=?")
        .get(input.effectId),
    ).toMatchObject({ state: "running", scan_owner_pid: child.pid });
  } finally {
    db.close();
  }
  return received.pid;
}
async function killScan() {
  if (!child) throw new Error("The actual scan process is missing");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function settle(input: DirectoryEffectRequest) {
  await engine!.startDirectory(input);
  await expect
    .poll(
      async () => (await engine!.observeDirectory(identity(input)))?.state,
      { timeout: 10_000 },
    )
    .toBe("terminal");
  return engine!.observeDirectory(identity(input));
}

describe("read-only directory scan crash recovery", () => {
  it("confirms the real crashed owner is absent, retains interruption, and permits only a fresh scan", async () => {
    const input = request("crashed-scan");
    const ownerPid = await startHeldScan(input);
    const original = await scanDirectory(source, AbortSignal.timeout(30_000));
    await killScan();
    expect(() => process.kill(ownerPid, 0)).toThrow();
    engine = await NativeEffects.open(data);
    expect(await engine.observeDirectory(identity(input))).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    const stopped = await engine.interruptDirectory(identity(input));
    expect(stopped).toMatchObject({
      state: "terminal",
      receipt: {
        outcome: "interrupted",
        operationType: "scan-directory",
        errorCode: "interrupted",
        before: null,
        after: null,
        source: null,
        processes: [],
        artifact: null,
      },
    });
    expect(await engine.startDirectory(input)).toEqual(stopped);
    const fresh = await settle(request("fresh-after-crash"));
    expect(fresh?.receipt?.outcome).toBe("succeeded");
    expect(fresh?.receipt?.artifact?.kind).toBe("inspection");
    expect(
      (await scanDirectory(source, AbortSignal.timeout(30_000))).state,
    ).toEqual(original.state);
  }, 30_000);

  it("does not treat an overlapping journal or plugin instance as proof that its live scan owner stopped", async () => {
    const input = request("still-live-scan");
    const ownerPid = await startHeldScan(input);
    engine = await NativeEffects.open(data);
    expect(process.kill(ownerPid, 0)).toBe(true);
    expect(await engine.interruptDirectory(identity(input))).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    expect(await engine.startDirectory(input)).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    await killScan();
    expect(await engine.interruptDirectory(identity(input))).toMatchObject({
      state: "terminal",
      receipt: { outcome: "interrupted", artifact: null },
    });
    expect(await readFile(join(source, "untouched.txt"), "utf8")).toBe(
      "original evidence",
    );
  }, 30_000);

  it("keeps a migrated version-two scan without process ownership unresolved", async () => {
    await mkdir(data);
    const input = request("legacy-unknown-owner");
    const path = join(data, "native-effects.sqlite");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE effects(effect_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,receipt_json TEXT,resource TEXT NOT NULL,effect_kind TEXT NOT NULL DEFAULT 'git'); PRAGMA user_version=2;",
    );
    old
      .prepare(
        "INSERT INTO effects VALUES(?,?,?,?,?,?,NULL,NULL,?,'directory')",
      )
      .run(
        input.effectId,
        input.runId,
        directoryEffectRequestHash(input),
        canonicalDirectoryEffectRequest(input),
        "running",
        new Date().toISOString(),
        "legacy-read-only-resource",
      );
    old.close();
    engine = await NativeEffects.open(data);
    expect(await engine.interruptDirectory(identity(input))).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    expect(await engine.startDirectory(input)).toMatchObject({
      state: "needs-reconciliation",
      receipt: null,
    });
    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: 3,
      });
      expect(
        migrated
          .prepare(
            "SELECT request_json,scan_owner_pid FROM effects WHERE effect_id=?",
          )
          .get(input.effectId),
      ).toMatchObject({
        request_json: canonicalDirectoryEffectRequest(input),
        scan_owner_pid: null,
      });
    } finally {
      migrated.close();
    }
  });

  it("rejects ordinary, bare and ancestor Git metadata through in-process scan guards", async () => {
    expect(
      (await requireDirectorySource(source, AbortSignal.timeout(5000))).kind,
    ).toBe("directory");
    await writeFile(join(fixture, ".git"), "gitdir: elsewhere");
    await expect(
      requireDirectorySource(source, AbortSignal.timeout(5000)),
    ).rejects.toThrow("Git metadata");
    await rm(join(fixture, ".git"));
    await Promise.all([
      writeFile(join(source, "HEAD"), "ref: refs/heads/main"),
      mkdir(join(source, "objects")),
      mkdir(join(source, "refs")),
    ]);
    await expect(
      requireDirectorySource(source, AbortSignal.timeout(5000)),
    ).rejects.toThrow("Git metadata");
  });
});

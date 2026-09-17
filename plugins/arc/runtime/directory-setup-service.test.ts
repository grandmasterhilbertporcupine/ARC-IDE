import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { migrations } from "../data.js";
import {
  directoryEffectRequestSchema,
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { directoryValidationMigrations } from "./directory-validation.js";
import { createDirectorySetupService } from "./directory-setup-service.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...directoryValidationMigrations,
    ].join(";\n"),
  );
  const input = {
    projectId: "project-a",
    originThreadId: "main-a",
    hostId: "host-a",
    operationId: "setup-a",
  };
  const parent = {
    id: input.originThreadId,
    projectId: input.projectId,
    providerId: "codex",
    environmentId: "environment-main",
    parentThreadId: null,
    experimental_executionContextId: null,
    archivedAt: null,
  };
  const environment = {
    id: parent.environmentId,
    projectId: input.projectId,
    hostId: input.hostId,
    path: "C:/Project 東京",
    status: "ready",
  };
  const source = {
    kind: "directory",
    path: "C:/Project 東京",
    rootIdentity: { deviceId: "1", fileId: "12" },
    manifestDigest: "a".repeat(64),
    entryCount: 3,
    fileBytes: 60,
  } as const;
  const jobs: DirectoryEffectRequest[] = [];
  let record: DirectoryEffectRecord | null = null;
  let loseReply = false;
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: input.projectId,
          kind: "standard",
          sources: [{ hostId: input.hostId, path: source.path }],
        }),
      },
      threads: { get: () => parent },
      environments: { get: () => environment },
    },
    async experimental_callHostRpc(call) {
      if (call.method === "inspectProjectSource")
        return { kind: "directory", path: source.path };
      if (call.method === "observeDirectoryEffect") return record;
      if (call.method === "startDirectoryEffect") {
        const job = directoryEffectRequestSchema.parse(call.input);
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM arc_directory_setups")
            .get(),
        ).toEqual({ count: 1 });
        expect(job.operation.type).toBe("scan-directory");
        expect(job.lane).toBeNull();
        jobs.push(job);
        record = {
          kind: "directory",
          runId: job.runId,
          effectId: job.effectId,
          requestHash: directoryEffectRequestHash(job),
          state: "running",
          startedAt: "2026-09-10T13:00:00.000Z",
          finishedAt: null,
          receipt: null,
        };
        if (loseReply) {
          loseReply = false;
          throw new Error("Lost source inspection acknowledgement");
        }
        return record;
      }
      throw new Error(`Unexpected setup mutation ${call.method}`);
    },
  });
  hosts.push(host);
  const store = createArcRunStore(db);
  const service = createDirectorySetupService(host.bb, store);
  function finish(failure: string | null = null) {
    const job = jobs[0];
    if (!record || !job || job.operation.type !== "scan-directory")
      throw new Error("No retained scan");
    record = {
      ...record,
      state: "terminal",
      finishedAt: "2026-09-10T13:00:02.000Z",
      receipt: {
        kind: "directory",
        operationType: "scan-directory",
        outcome: failure ? "invalid" : "succeeded",
        errorCode: failure ? "unsupported_link" : null,
        reason: failure,
        before: null,
        after: failure ? null : source,
        source: null,
        processes: [],
        finishedAt: "2026-09-10T13:00:02.000Z",
        artifact: failure
          ? null
          : {
              kind: "inspection",
              validationId: job.operation.validationId,
              consumer: job.operation.consumer,
              phase: job.operation.phase,
              state: source,
              checkedAt: "2026-09-10T13:00:02.000Z",
            },
      },
    };
  }
  return {
    db,
    input,
    parent,
    environment,
    jobs,
    service,
    source,
    store,
    host,
    finish,
    loseReply() {
      loseReply = true;
    },
  };
}

describe("durable directory source setup", () => {
  it("retains intent before one asynchronous scan and recovers the same result after service recreation", async () => {
    const f = fixture();
    const pending = await f.service.inspect(f.input, { kind: "user" });
    expect(pending.state).toBe("pending");
    f.finish();
    const restarted = createDirectorySetupService(
      f.host.bb,
      createArcRunStore(f.db),
    );
    const ready = await restarted.inspect(f.input, { kind: "user" });
    expect(ready).toEqual({ ...pending, state: "ready", source: f.source });
    expect(f.jobs).toHaveLength(1);
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 0 });
  });

  it("reconciles a lost host acknowledgement without creating another scan", async () => {
    const f = fixture();
    f.loseReply();
    await expect(f.service.inspect(f.input, { kind: "user" })).rejects.toThrow(
      "Lost source inspection acknowledgement",
    );
    f.finish();
    const ready = await f.service.inspect(f.input, { kind: "user" });
    expect(ready.state).toBe("ready");
    expect(f.jobs).toHaveLength(1);
  });

  it("returns the named offending link instead of presenting a partial snapshot", async () => {
    const f = fixture();
    await f.service.inspect(f.input, { kind: "user" });
    f.finish("Unsupported link at C:/Project 東京/node_modules/package");
    const failed = await f.service.inspect(f.input, { kind: "user" });
    expect(failed).toMatchObject({
      state: "failed",
      code: "unsupported_link",
      reason: "Unsupported link at C:/Project 東京/node_modules/package",
    });
    expect(failed).not.toHaveProperty("source");
    expect(f.jobs).toHaveLength(1);
  });

  it("rejects a different main environment on the same setup operation", async () => {
    const f = fixture();
    await f.service.inspect(f.input, { kind: "user" });
    f.environment.id = "replacement-environment";
    f.parent.environmentId = "replacement-environment";
    await expect(
      f.service.inspect(f.input, { kind: "user" }),
    ).rejects.toMatchObject({ code: "directory_setup_conflict" });
    expect(f.jobs).toHaveLength(1);
  });

  it("rejects a different agent conversation before starting an inspection", async () => {
    const f = fixture();
    await expect(
      f.service.inspect(f.input, {
        kind: "agent",
        projectId: f.input.projectId,
        threadId: "different-main",
      }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(f.jobs).toEqual([]);
  });

  it("does not admit an interrupted request or mark its inspection failed", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("Caller stopped"));
    await expect(
      f.service.inspect(f.input, { kind: "user" }, controller.signal),
    ).rejects.toThrow("Caller stopped");
    expect(f.jobs).toEqual([]);
    expect(f.store.directories.getSetup(f.input)).toBeNull();
  });
});

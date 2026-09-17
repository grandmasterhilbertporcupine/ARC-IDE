import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contextMigrations, createContextStore } from "./data.js";
import { createArcContextService } from "./service.js";
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import {
  contextHostRpcMethods,
  hostContextStatusInputSchema,
  hostContextStatusSchema,
} from "../host-context-contract.js";

let db: Database.Database;
const hostCall =
  vi.fn<ExperimentalHostClient<typeof contextHostRpcMethods>["call"]>();
const changed = vi.fn();
function fixture() {
  const store = createContextStore(db);
  const service = createArcContextService(store, {
    project: async (id) => ({
      id,
      name: id,
      kind: "project",
      sources: [{ hostId: "local", path: "C:/project", isDefault: true }],
    }),
    environment: async () => ({
      projectId: "foreign",
      hostId: "local",
      path: "C:/foreign",
      status: "ready",
    }),
    host: {
      call: hostCall,
      experimental_onWorkerExit: () => () => undefined,
      experimental_onSignal: () => () => undefined,
    },
    changed,
  });
  return { store, service };
}
const target = { projectId: "p1", hostId: "local", environmentId: null };
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(contextMigrations.join(";\n"));
  vi.clearAllMocks();
  hostCall.mockReset().mockRejectedValue(new Error("Host offline"));
});
afterEach(() => db.close());

it("resolves only the project's registered source and rejects foreign environments before host calls", async () => {
  const { service } = fixture();
  expect(
    await service.handlers().getContextSetup({ projectId: "p1", hostId: null }),
  ).toMatchObject({ target });
  await expect(
    service
      .handlers()
      .getContextStatus({ target: { ...target, hostId: "foreign" } }),
  ).rejects.toThrow("scope_denied");
  await expect(
    service.handlers().getContextStatus({
      target: { ...target, environmentId: "foreign-env" },
    }),
  ).rejects.toThrow("scope_denied");
  expect(hostCall).not.toHaveBeenCalled();
});

it("retains a successful reference import when the enrolled host cannot index it", async () => {
  const { store, service } = fixture();
  const input = {
    target,
    operationId: "persist",
    sourceId: null,
    expectedRevision: null,
    name: "Rules.md",
    text: "Retained reference, not instructions.",
  };
  const result = await service.handlers().importContextSource(input);
  expect(result).toMatchObject({
    outcome: "applied",
    indexError: "Host offline",
    status: null,
    reference: { revision: 1 },
  });
  if (result.outcome !== "applied") throw new Error("Import was rejected");
  expect(store.read("p1", result.reference.id, 1).text).toBe(input.text);
  expect(hostCall).toHaveBeenCalledWith(
    "startContextIndex",
    expect.objectContaining({
      scope: expect.objectContaining({
        ...target,
        path: "C:/project",
        referenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      operationId: "import:persist",
    }),
    expect.objectContaining({ hostId: "local" }),
  );
  expect(changed).toHaveBeenCalledWith("p1");
});

it("refuses agent-thread reads and imports until execution-context snapshot binding is implemented", async () => {
  const { service } = fixture();
  const actor = { kind: "agent", projectId: "p1", threadId: "t1" } as const;
  await expect(
    service.call("listContextReferences", { projectId: "p1" }, actor),
  ).rejects.toThrow("context_snapshot_required");
  await expect(
    service.call("searchContext", { target, query: "rules", limit: 8 }, actor),
  ).rejects.toThrow("context_snapshot_required");
  expect(hostCall).not.toHaveBeenCalled();
});

it("returns typed capacity rejection without a write and permits removal followed by a new import", async () => {
  const { store, service } = fixture();
  for (let index = 0; index < 8; index++) {
    store.importSource({
      projectId: "p1",
      operationId: `seed-${index}`,
      sourceId: null,
      expectedRevision: null,
      name: `Source-${index}.md`,
      text: "x".repeat(64 * 1024),
    });
  }
  const input = {
    target,
    operationId: "over-capacity",
    sourceId: null,
    expectedRevision: null,
    name: "Notes.md",
    text: "New notes",
  };
  expect(await service.handlers().importContextSource(input)).toMatchObject({
    outcome: "rejected",
    error: { code: "reference_limit" },
  });
  expect(store.list("p1")).toHaveLength(8);
  expect(hostCall).not.toHaveBeenCalled();
  const first = store.list("p1")[0]!;
  expect(
    await service.handlers().archiveContextReference({
      target,
      operationId: "free-capacity",
      sourceId: first.id,
      expectedRevision: first.revision,
    }),
  ).toMatchObject({ outcome: "applied" });
  expect(
    await service.handlers().importContextSource({
      ...input,
      operationId: "after-removal",
    }),
  ).toMatchObject({ outcome: "applied", reference: { name: "Notes.md" } });
  expect(store.list("p1")).toHaveLength(8);
});

it("preserves the current reference when a replacement or removal uses an old revision", async () => {
  const { store, service } = fixture();
  const input = {
    projectId: "p1",
    operationId: "original",
    sourceId: null,
    expectedRevision: null,
    name: "Notes.md",
    text: "Original notes",
  };
  const original = store.importSource(input);
  const current = store.importSource({
    ...input,
    operationId: "newer-revision",
    sourceId: original.id,
    expectedRevision: 1,
    text: "Newer notes",
  });
  const replace = {
    target,
    operationId: "outdated-replacement",
    sourceId: original.id,
    expectedRevision: 1,
    name: original.name,
    text: "Outdated notes",
  };
  expect(await service.handlers().importContextSource(replace)).toMatchObject({
    outcome: "rejected",
    error: { code: "source_changed" },
  });
  expect(
    await service.handlers().archiveContextReference({
      target,
      operationId: "outdated-removal",
      sourceId: original.id,
      expectedRevision: 1,
    }),
  ).toMatchObject({ outcome: "rejected", error: { code: "source_changed" } });
  expect(store.list("p1")).toEqual([current]);
  expect(store.read("p1", current.id, 2).text).toBe("Newer notes");
  expect(hostCall).not.toHaveBeenCalled();
  expect(
    await service.handlers().importContextSource({
      ...replace,
      operationId: "fresh-replacement",
      expectedRevision: 2,
      text: "Reviewed notes",
    }),
  ).toMatchObject({ outcome: "applied", reference: { revision: 3 } });
});

it("rejects caller-selected filesystem paths at the public boundary", async () => {
  const { service } = fixture();
  await expect(
    service.call(
      "getContextStatus",
      { target: { ...target, path: "C:/private" } },
      { kind: "user" },
    ),
  ).rejects.toThrow();
  expect(hostCall).not.toHaveBeenCalled();
});

it("rejects a read whose reference catalog changes while the host is responding", async () => {
  const { store, service } = fixture();
  hostCall.mockImplementationOnce(async (_method, input) => {
    const { scope } = hostContextStatusInputSchema.parse(input);
    store.importSource({
      projectId: "p1",
      operationId: "concurrent",
      sourceId: null,
      expectedRevision: null,
      name: "New.md",
      text: "This arrived during the query.",
    });
    return hostContextStatusSchema.parse({
      scope,
      indexId: null,
      generation: 0,
      operationId: null,
      state: "absent",
      coverage: "unknown",
      root: null,
      git: null,
      counts: {
        discovered: 0,
        indexed: 0,
        stale: 0,
        skipped: 0,
        failed: 0,
        chunks: 0,
        embeddedChunks: 0,
      },
      semantic: "unavailable",
      manifestDigest: null,
      reason: null,
      updatedAt: null,
    });
  });
  await expect(service.handlers().getContextStatus({ target })).rejects.toThrow(
    "context_changed",
  );
});

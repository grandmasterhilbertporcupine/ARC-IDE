import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  contextMigrations,
  createContextStore,
  type ContextStore,
} from "./data.js";
import { contextReferenceTextSchema } from "./reference-contract.js";

let db: Database.Database;
let store: ContextStore;
const input = {
  projectId: "p1",
  operationId: "import1",
  sourceId: null,
  expectedRevision: null,
  name: "Architecture.md",
  text: "Use small functions.\nUnicode: λ and 🎯.",
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(contextMigrations.join(";\n"));
  store = createContextStore(db);
});
afterEach(() => db.close());

it("retains immutable originals and hashes across replacements and store reopen", () => {
  const first = store.importSource(input);
  const second = store.importSource({
    ...input,
    operationId: "replace1",
    sourceId: first.id,
    expectedRevision: 1,
    text: "Use bounded queues.",
  });
  const reopened = createContextStore(db);
  expect(second.revision).toBe(2);
  expect(second.sha256).not.toBe(first.sha256);
  expect(reopened.read("p1", first.id, 1).text).toBe(input.text);
  expect(reopened.originals("p1")).toEqual([
    {
      id: first.id,
      name: first.name,
      sha256: second.sha256,
      revision: 2,
      text: "Use bounded queues.",
    },
  ]);
});

it("reconciles identical operation retries without duplicating revisions and refuses changed retries", () => {
  const first = store.importSource(input);
  expect(store.importSource(input)).toEqual(first);
  expect(store.list("p1")).toHaveLength(1);
  expect(() => store.importSource({ ...input, text: "Changed" })).toThrow(
    "operation_conflict",
  );
});

it("rejects foreign project and outdated replacements without changing current bytes", () => {
  const first = store.importSource(input);
  expect(() =>
    store.importSource({
      ...input,
      projectId: "p2",
      operationId: "foreign",
      sourceId: first.id,
      expectedRevision: 1,
    }),
  ).toThrow("source_missing");
  expect(() => store.read("p2", first.id, 1)).toThrow("source_missing");
  expect(() =>
    store.importSource({
      ...input,
      operationId: "stale",
      sourceId: first.id,
      expectedRevision: 2,
    }),
  ).toThrow("source_changed");
  expect(store.read("p1", first.id, 1).text).toBe(input.text);
});

it("deduplicates originals and rejects corrupt stored bytes on read", () => {
  const first = store.importSource(input);
  store.importSource({ ...input, operationId: "import2", name: "Copy.md" });
  expect(
    db.prepare("SELECT count(*) AS count FROM arc_context_blobs").get(),
  ).toEqual({ count: 1 });
  db.prepare("UPDATE arc_context_blobs SET content = ? WHERE sha256 = ?").run(
    Buffer.from("corrupt"),
    first.sha256,
  );
  expect(() => store.read("p1", first.id, 1)).toThrow("source_corrupt");
});

it("removes only an exact current reference while retaining its original and retry receipt", () => {
  const source = store.importSource(input);
  const request = {
    projectId: "p1",
    operationId: "archive",
    sourceId: source.id,
    expectedRevision: 1,
  };
  expect(() => store.archive({ ...request, expectedRevision: 2 })).toThrow(
    "source_changed",
  );
  expect(() => store.archive({ ...request, projectId: "p2" })).toThrow(
    "source_missing",
  );
  expect(store.archive(request)).toEqual(source);
  expect(store.archive(request)).toEqual(source);
  expect(store.list("p1")).toEqual([]);
  expect(store.originals("p1")).toEqual([]);
  expect(store.read("p1", source.id, 1).text).toBe(input.text);
  expect(() =>
    store.importSource({
      ...input,
      operationId: "restore",
      sourceId: source.id,
      expectedRevision: 1,
    }),
  ).toThrow("source_missing");
});

it("enforces UTF-8 byte and total reference limits without partial imports", () => {
  expect(
    contextReferenceTextSchema.safeParse("🎯".repeat(16_385)).success,
  ).toBe(false);
  expect(contextReferenceTextSchema.safeParse("\ud800").success).toBe(false);
  for (let i = 0; i < 8; i++)
    store.importSource({
      ...input,
      operationId: `full${i}`,
      text: "x".repeat(65_536),
    });
  expect(() =>
    store.importSource({ ...input, operationId: "overflow" }),
  ).toThrow("reference_limit");
  expect(store.list("p1")).toHaveLength(8);
});

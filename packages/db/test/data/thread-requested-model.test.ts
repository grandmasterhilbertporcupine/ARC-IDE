import { describe, expect, it } from "vitest";
import { threadScope, type ThreadEventType } from "@bb/domain";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createThread } from "../../src/data/threads.js";
import {
  insertEvents,
  listLastRequestedModelsByThreadIds,
} from "../../src/data/events.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "model-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "model-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/models" },
  });
  const thread = (providerId: string) =>
    createThread(db, noopNotifier, { projectId: project.id, providerId });
  const request = (
    threadId: string,
    sequence: number,
    type: ThreadEventType,
    data: object,
    createdAt = 1,
  ) =>
    insertEvents(db, noopNotifier, [
      {
        threadId,
        sequence,
        type,
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        createdAt,
        data: JSON.stringify(data),
      },
    ]);
  return { db, thread, request };
}

describe("last requested thread models", () => {
  it("selects the latest request by sequence in a batch, ignoring lifecycle noise", () => {
    const { db, thread, request } = setup();
    try {
      const first = thread("codex");
      const second = thread("custom-provider");
      const empty = thread("claude");
      request(first.id, 1, "client/turn/requested", {
        execution: { model: "old-model" },
      }, 100);
      request(first.id, 2, "client/turn/requested", {
        execution: { model: "requested-model" },
      }, 50);
      request(first.id, 3, "client/turn/start", {
        execution: { model: "lifecycle-only" },
      });
      request(second.id, 1, "client/turn/requested", {
        execution: { model: "same-name-on-any-provider" },
      });
      const rows = listLastRequestedModelsByThreadIds(db, {
        threadIds: [first.id, second.id, empty.id, first.id, "missing"],
      });
      expect(new Map(rows.map((row) => [row.threadId, row.model]))).toEqual(
        new Map([
          [first.id, "requested-model"],
          [second.id, "same-name-on-any-provider"],
          [empty.id, null],
        ]),
      );
      expect(rows).toHaveLength(3);
      expect(listLastRequestedModelsByThreadIds(db, { threadIds: [] })).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("recognizes retained legacy request records without falling back past a missing model", () => {
    const { db, thread, request } = setup();
    try {
      const first = thread("codex");
      request(first.id, 1, "client/thread/start", {
        input: [], execution: { model: "legacy-start" },
      });
      expect(listLastRequestedModelsByThreadIds(db, { threadIds: [first.id] }))
        .toEqual([{ threadId: first.id, model: "legacy-start" }]);
      request(first.id, 2, "client/turn/start", {
        input: [], execution: { model: "legacy-turn" },
      });
      expect(listLastRequestedModelsByThreadIds(db, { threadIds: [first.id] }))
        .toEqual([{ threadId: first.id, model: "legacy-turn" }]);
      for (const [offset, execution] of [{}, { model: 7 }, { model: "" }].entries()) {
        request(first.id, offset + 3, "client/turn/requested", { execution });
        expect(listLastRequestedModelsByThreadIds(db, { threadIds: [first.id] }))
          .toEqual([{ threadId: first.id, model: null }]);
      }
    } finally {
      db.$client.close();
    }
  });

  it("batches identities within the SQLite variable limit", () => {
    const { db, thread, request } = setup();
    try {
      const target = thread("codex");
      request(target.id, 1, "client/turn/requested", {
        execution: { model: "retained-model" },
      });
      const threadIds = Array.from({ length: 33_000 }, (_, i) => `missing-${i}`);
      threadIds.push(target.id);
      expect(listLastRequestedModelsByThreadIds(db, { threadIds })).toEqual([
        { threadId: target.id, model: "retained-model" },
      ]);
    } finally {
      db.$client.close();
    }
  });
});

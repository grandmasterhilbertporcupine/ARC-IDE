import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../data.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import {
  addressedContinuationMigrations,
  createAddressedContinuationStore,
  type AddressedContinuationInput,
} from "./addressed-continuation-data.js";

const databases: Database.Database[] = [];
afterEach(() => {
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
      ...addressedContinuationMigrations,
    ].join(";\n"),
  );
  const definition = orchestratedDefinitionFixture();
  definition.request.addressedRecipients = [
    {
      kind: "team",
      entityId: definition.team.teamId,
      versionId: 1,
      scopeKey: `project:${definition.request.projectId}`,
    },
  ];
  const run = createArcRunStore(db).reserve(
    compileArcOrchestratedRun(definition),
  );
  const input: AddressedContinuationInput = {
    projectId: definition.request.projectId,
    threadId: definition.request.originThreadId,
    operationId: randomUUID(),
    goal: "Continue the accepted candidate",
    recipients: definition.request.addressedRecipients,
    attachments: [],
  };
  return { db, run, input, queue: createAddressedContinuationStore(db) };
}

describe("durable addressed follow-up queue", () => {
  it("bounds public history without decoding past compiled graphs and still includes pending work", () => {
    const { db, run, input, queue } = fixture();
    const pending = queue.reserve(input, run.summary.runId);
    for (let index = 0; index < 105; index++) {
      const historical = queue.reserve(
        { ...input, operationId: randomUUID(), goal: `Past ${index}` },
        run.summary.runId,
      );
      queue.update(historical, "cancelled");
    }
    db.prepare(
      "UPDATE arc_addressed_continuations SET compiled_json = 'legacy-unreadable' WHERE state = 'cancelled'",
    ).run();
    const publicRows = queue.publicQueue(input.projectId, input.threadId);
    expect(publicRows).toHaveLength(100);
    expect(
      publicRows.some((row) => row.operationId === pending.input.operationId),
    ).toBe(true);
    expect(queue.firstPending(input.projectId, input.threadId)).toBe(
      pending.sequence,
    );
    expect(queue.pending().map((row) => row.sequence)).toEqual([
      pending.sequence,
    ]);
  });
  it("replays one operation after restart and rejects changed content without inserting more work", () => {
    const { db, run, input, queue } = fixture();
    const first = queue.reserve(input, run.summary.runId);
    const restarted = createAddressedContinuationStore(db);
    expect(restarted.reserve(input, run.summary.runId)).toEqual(first);
    expect(() =>
      restarted.reserve(
        { ...input, goal: "Another instruction" },
        run.summary.runId,
      ),
    ).toThrow("different follow-up");
    expect(restarted.queue(input.projectId, input.threadId)).toHaveLength(1);
  });

  it("orders a bounded queue and holds later work behind an actionable failure", () => {
    const { run, input, queue } = fixture();
    const first = queue.reserve(input, run.summary.runId);
    for (let index = 1; index < 12; index++)
      queue.reserve(
        { ...input, operationId: randomUUID(), goal: `Follow-up ${index}` },
        run.summary.runId,
      );
    expect(() =>
      queue.reserve({ ...input, operationId: randomUUID() }, run.summary.runId),
    ).toThrow("twelve pending");
    expect(queue.pending().map((item) => item.sequence)).toEqual([
      first.sequence,
    ]);
    const failed = queue.update(first, "action-required", "Candidate changed");
    expect(queue.pending()).toEqual([]);
    expect(failed.updatedAt).toBeGreaterThan(first.updatedAt);
    queue.update(failed, "cancelled");
    expect(queue.pending()).toHaveLength(1);
    expect(queue.pending()[0].input.goal).toBe("Follow-up 1");
  });

  it("retains pinned recipients, predecessor CAS and sealed candidate across restart", () => {
    const { db, run, input, queue } = fixture();
    const item = queue.bind(
      queue.reserve(input, run.summary.runId),
      run.summary.runId,
      7,
    );
    const definition = orchestratedDefinitionFixture();
    definition.runId = item.successorRunId;
    definition.request = {
      ...definition.request,
      operationId: input.operationId,
      goal: input.goal,
      addressedRecipients: input.recipients,
      addressedAttachments: input.attachments,
    };
    const compiled = compileArcOrchestratedRun(definition);
    queue.seal(item, compiled);
    const restarted = createAddressedContinuationStore(db).incoming(
      item.successorRunId,
    );
    expect(restarted).toMatchObject({
      state: "starting",
      predecessorRunId: run.summary.runId,
      controlVersion: 7,
      compiled,
    });
    expect(() =>
      queue.seal(
        item,
        compileArcOrchestratedRun({
          ...definition,
          request: { ...definition.request, goal: "Changed" },
        }),
      ),
    ).toThrow("different sealed candidate");
  });
});

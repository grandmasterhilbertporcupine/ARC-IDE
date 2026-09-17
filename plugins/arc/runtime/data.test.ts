import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnedStepRequest } from "bb-plugin-workflows/owned-contract";
import { migrations } from "../data.js";
import { compileArcRun } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { runDefinitionFixture } from "./testing.js";
import { runtimeHash } from "./hash.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
});
afterEach(() => db.close());

describe("ARC run and effect persistence", () => {
  it("retains the first compiled snapshot across repeated starts and reopened services", () => {
    const store = createArcRunStore(db);
    const compiled = compileArcRun(runDefinitionFixture());
    const first = store.reserve(compiled);
    const changedResolved = compileArcRun({
      ...compiled.definition,
      createdAt: 99,
    });
    expect(store.reserve(changedResolved)).toEqual(first);
    expect(
      createArcRunStore(db).findRequest(compiled.definition.request),
    ).toEqual(first);
    expect(() =>
      store.findRequest({
        ...compiled.definition.request,
        goal: "Changed authority",
      }),
    ).toThrow("run_conflict");
    expect(store.list("project-a", 10, 0).total).toBe(1);
    expect(store.list("project-b", 10, 0).total).toBe(0);
  });

  it("retains an uncertain submission and refuses a different workflow binding", () => {
    const store = createArcRunStore(db);
    const { summary } = store.reserve(compileArcRun(runDefinitionFixture()));
    store.submissionUncertain(summary.runId, "Lost acknowledgment");
    expect(createArcRunStore(db).get(summary.runId).summary.submission).toBe(
      "needs-reconciliation",
    );
    store.submitted(summary.runId, "workflow-a");
    store.submitted(summary.runId, "workflow-a");
    expect(() => store.submitted(summary.runId, "workflow-b")).toThrow(
      "run_conflict",
    );
    expect(store.get(summary.runId).summary.submissionError).toBeNull();
  });

  it("deduplicates effects, rejects changed authority and old callbacks, and preserves terminal receipts", () => {
    const store = createArcRunStore(db);
    const compiled = compileArcRun(runDefinitionFixture());
    store.reserve(compiled);
    const request: OwnedStepRequest = {
      workflowRunId: "workflow-a",
      ownerRunId: compiled.definition.runId,
      nodeId: "writer-0-workspace",
      iteration: 0,
      attempt: 1,
      effectId: "effect-a",
      requestHash: "d".repeat(64),
      dispatchGeneration: 1,
      definitionHash: compiled.workflow.steps[0].definitionHash,
      dependencyReceipts: [],
      lane: null,
      input: null,
    };
    const {
      requestHash: _hash,
      dispatchGeneration: _generation,
      ...immutableRequest
    } = request;
    request.requestHash = runtimeHash({ owner: "arc", ...immutableRequest });
    const first = store.reserveEffect(request);
    expect(store.reserveEffect(request).executionContextId).toBe(
      first.executionContextId,
    );
    expect(() => store.reserveEffect({ ...request, input: "changed" })).toThrow(
      "effect_conflict",
    );
    store.reserveEffect({ ...request, dispatchGeneration: 2 });
    expect(() => store.reserveEffect(request)).toThrow("stale_generation");
    const receipt = { recorded: true };
    const result = {
      state: "succeeded",
      resource: { kind: "host-effect", hostId: "host-a", effectId: "effect-a" },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: "d".repeat(64) },
    } as const;
    store.recordObservation(request.effectId, result);
    const reopened = createArcRunStore(db);
    expect(reopened.effect(request.effectId).observation).toEqual(result);
    expect(() =>
      reopened.recordObservation(request.effectId, {
        state: "needs-reconciliation",
        reason: "replace success",
      }),
    ).toThrow("receipt_conflict");
    reopened.recordObservation(request.effectId, {
      ...result,
      validity: { state: "stale", reason: "Candidate moved" },
    });
    expect(reopened.effect(request.effectId).observation).toMatchObject({
      state: "succeeded",
      validity: { state: "stale" },
    });
  });
});

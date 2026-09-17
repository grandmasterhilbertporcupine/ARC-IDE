import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations } from "./data.js";
import {
  canonicalOwnedJson,
  ownedRuleContinuationStartSchema,
  type OwnedRunStartV2,
  type OwnedRuleContinuationAuthorization,
} from "./owned-contract.js";
import {
  cancelOwnedContinuation,
  finalizeOwnedContinuations,
  inspectOwnedContinuation,
  inspectOwnedRuleContext,
  reserveOwnedContinuation,
  startOwnedContinuation,
  startOwnedRuleContinuation,
} from "./owned-continuation-data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  controlOwnedRun,
  createOwnedRun,
  hashOwnedValue,
  readOwnedRepairCatalog,
  recordOwnedObservation,
  recoverOwnedRuns,
  requireOwnedAttempt,
  requireOwnedRun,
  reserveOwnedActiveInterval,
  reserveOwnedValidationRequest,
  settleOwnedActiveInterval,
  viewOwnedRun,
} from "./owned-data.js";
import { ownedRunInput, terminalReceipt } from "./owned-test-fixtures.js";
import {
  decisionStep,
  v2Input,
  v2Step,
  waitingControl,
} from "./owned-v2-test-fixtures.js";

describe("reviewed rule continuation with stable cumulative catalogs", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });
  afterEach(() => db.close());

  function input(
    ownerRunId = "original",
    caps: Record<string, number> = { repair: 2 },
    limits: Partial<OwnedRunStartV2["limits"]> = {},
  ): OwnedRunStartV2 {
    return v2Input({
      ownerRunId,
      planHash: hashOwnedValue(ownerRunId),
      steps: [
        v2Step("check"),
        v2Step("worker", { kind: "agent" }),
        ...Object.entries(caps).flatMap(([stageId, max]) =>
          Array.from({ length: max }, (_, index) =>
            v2Step(`${stageId}-${index + 1}`, {
              kind: "agent",
              repair: { stageId, round: index + 1 },
            }),
          ),
        ),
      ],
      limits: {
        maxAgentCalls: 6,
        maxActiveMs: 10000,
        maxConcurrentAgents: 2,
        maxRepairRounds: 3,
        ...limits,
      },
    });
  }
  function start(value = input()) {
    const run = createOwnedRun(db, "arc", value, 100);
    expect(claimOwnedRun(db, 4, 110)?.row.id).toBe(run.workflowRunId);
    return run.workflowRunId;
  }
  function reserve(runId: string, successor: OwnedRunStartV2) {
    const key = {
      predecessorWorkflowRunId: runId,
      operationId: `apply-${successor.ownerRunId}`,
    };
    reserveOwnedContinuation(
      db,
      "arc",
      {
        ...key,
        successorOwnerRunId: successor.ownerRunId,
        expectedControlVersion: viewOwnedRun(db, runId).controlVersion,
      },
      200,
    );
    return key;
  }
  function request(
    runId: string,
    successor: OwnedRunStartV2,
    before: Record<string, number>,
    after: Record<string, number>,
  ) {
    const authorization: OwnedRuleContinuationAuthorization = {
      schemaVersion: 1,
      reviewHash: hashOwnedValue({ before, after, successor }),
      repairStages: Object.entries(before).map(
        ([stageId, beforeMaxRounds]) => ({
          stageId,
          beforeMaxRounds,
          afterMaxRounds: after[stageId],
        }),
      ),
    };
    return { ...reserve(runId, successor), successor, authorization };
  }
  function admit(runId: string, nodeId: string) {
    const result = admitOwnedStep(
      db,
      runId,
      { nodeId, iteration: 0 },
      null,
      requireOwnedRun(db, runId).row.dispatch_generation,
      120,
    );
    if (result === null) throw new Error("Fixture admission unavailable");
    return result;
  }
  function complete(runId: string, nodeId: string) {
    const attempt = admit(runId, nodeId);
    if (attempt.row.kind === "owner-control")
      throw new Error("Fixture is a control");
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        requireOwnedRun(db, runId).row.dispatch_generation,
        terminalReceipt(
          attempt.request,
          "succeeded",
          { effect: attempt.row.effect_id },
          attempt.row.kind,
        ),
        130,
      ),
    ).toBe(true);
    return requireOwnedAttempt(db, attempt.row.effect_id);
  }
  function successorId(result: ReturnType<typeof startOwnedRuleContinuation>) {
    if (result.successor === null) throw new Error("Successor was not created");
    expect(result.state).toBe("started");
    return result.successor.workflowRunId;
  }

  it("retains authoritative calls, settled time and per-stage usage under a reviewed grant", () => {
    const run = start(input("original", { repair: 2 }, { maxAgentCalls: 2 }));
    const original = complete(run, "worker");
    complete(run, "repair-1");
    reserveOwnedActiveInterval(db, run, 0, 140);
    settleOwnedActiveInterval(db, run, 1200, 150);
    const change = request(
      run,
      input(
        "next",
        { repair: 3 },
        { maxAgentCalls: 4, maxActiveMs: 2000, maxConcurrentAgents: 1 },
      ),
      { repair: 2 },
      { repair: 3 },
    );
    const next = successorId(
      startOwnedRuleContinuation(db, "arc", change, 300),
    );
    expect(viewOwnedRun(db, next)).toMatchObject({
      agentCalls: 2,
      chargedActiveMs: 1200,
      repairRounds: [{ stageId: "repair", rounds: 1 }],
      limits: change.successor.limits,
    });
    expect(readOwnedRepairCatalog(db, next)).toEqual({
      schemaVersion: 1,
      stages: [{ stageId: "repair", maxRounds: 3 }],
    });
    expect(claimOwnedRun(db, 4)?.row.id).toBe(next);
    complete(next, "repair-1");
    complete(next, "repair-2");
    expect(viewOwnedRun(db, next)).toMatchObject({
      agentCalls: 4,
      repairRounds: [{ stageId: "repair", rounds: 3 }],
    });
    expect(() => admit(next, "worker")).toThrow("agent-call limit");
    expect(
      requireOwnedAttempt(db, original.row.effect_id).row.terminal_receipt_json,
    ).toBe(original.row.terminal_receipt_json);
  });

  it.each(["calls", "time", "stage"] as const)(
    "leaves a reservation cancelable when a reviewed %s ceiling is below usage",
    (kind) => {
      const run = start();
      complete(run, "worker");
      complete(run, "repair-1");
      reserveOwnedActiveInterval(db, run, 0, 140);
      settleOwnedActiveInterval(db, run, 1200, 150);
      const cap = kind === "stage" ? 0 : 2;
      const next = input(
        "next",
        { repair: cap },
        {
          maxAgentCalls: kind === "calls" ? 1 : 6,
          maxActiveMs: kind === "time" ? 1000 : 10000,
        },
      );
      const change = request(run, next, { repair: 2 }, { repair: cap });
      expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow(
        "consumption",
      );
      expect(
        inspectOwnedContinuation(db, "arc", {
          predecessorWorkflowRunId: change.predecessorWorkflowRunId,
          operationId: change.operationId,
        }),
      ).toMatchObject({
        state: "ready",
        successorPlanHash: null,
        successor: null,
      });
      expect(
        cancelOwnedContinuation(db, "arc", {
          predecessorWorkflowRunId: change.predecessorWorkflowRunId,
          operationId: change.operationId,
        }).predecessor.desiredControl,
      ).toBe("pause");
    },
  );

  it("allows a ceiling equal to consumption without granting another call or repair", () => {
    const run = start();
    complete(run, "repair-1");
    const change = request(
      run,
      input("next", { repair: 1 }, { maxAgentCalls: 1 }),
      { repair: 2 },
      { repair: 1 },
    );
    const next = successorId(startOwnedRuleContinuation(db, "arc", change));
    expect(claimOwnedRun(db, 4)?.row.id).toBe(next);
    expect(() => admit(next, "worker")).toThrow("agent-call limit");
    expect(viewOwnedRun(db, next).agentCalls).toBe(1);
  });

  it("preserves mixed amended and ordinary lineage across database reload without stage resets", () => {
    const run = start(input("original", { repair: 1, other: 2 }));
    complete(run, "repair-1");
    const first = request(
      run,
      input("amended", { repair: 3, other: 2 }),
      { repair: 1, other: 2 },
      { repair: 3, other: 2 },
    );
    const amended = successorId(startOwnedRuleContinuation(db, "arc", first));
    expect(claimOwnedRun(db, 4)?.row.id).toBe(amended);
    complete(amended, "repair-1");
    complete(amended, "other-1");
    const ordinaryInput = input("ordinary", { repair: 3, other: 2 });
    const ordinary = successorId(
      startOwnedContinuation(db, "arc", {
        ...reserve(amended, ordinaryInput),
        successor: ordinaryInput,
      }),
    );
    const bytes = db.serialize();
    db.close();
    db = new Database(bytes);
    db.pragma("foreign_keys = ON");
    recoverOwnedRuns(db, 500);
    const context = inspectOwnedRuleContext(db, "arc", ordinary);
    expect(context.repairCatalog).toEqual({
      source: "stored",
      stages: [
        { stageId: "other", maxRounds: 2 },
        { stageId: "repair", maxRounds: 3 },
      ],
    });
    expect(context.run.repairRounds).toEqual([
      { stageId: "other", rounds: 1 },
      { stageId: "repair", rounds: 2 },
    ]);
    const finalRequest = request(
      ordinary,
      input("final", { repair: 2, other: 2 }),
      { repair: 3, other: 2 },
      { repair: 2, other: 2 },
    );
    const final = successorId(
      startOwnedRuleContinuation(db, "arc", finalRequest),
    );
    expect(claimOwnedRun(db, 4)?.row.id).toBe(final);
    expect(() => admit(final, "repair-1")).toThrow("stage repair limit");
    complete(final, "other-1");
    expect(viewOwnedRun(db, final)).toMatchObject({
      agentCalls: 4,
      repairRounds: [
        { stageId: "other", rounds: 2 },
        { stageId: "repair", rounds: 2 },
      ],
    });
  });

  it("retains zero ceilings through ordinary successors and rejects dormant stage renaming", () => {
    const run = start(input("legacy", {}, { maxRepairRounds: 0 }));
    expect(inspectOwnedRuleContext(db, "arc", run).repairCatalog).toEqual({
      source: "legacy-zero",
    });
    const initialize = request(
      run,
      input("disabled", {}, { maxRepairRounds: 0 }),
      { dormant: 0 },
      { dormant: 0 },
    );
    const disabled = successorId(
      startOwnedRuleContinuation(db, "arc", initialize),
    );
    const ordinaryInput = input("ordinary", {}, { maxRepairRounds: 0 });
    const ordinary = successorId(
      startOwnedContinuation(db, "arc", {
        ...reserve(disabled, ordinaryInput),
        successor: ordinaryInput,
      }),
    );
    expect(inspectOwnedRuleContext(db, "arc", ordinary).repairCatalog).toEqual({
      source: "stored",
      stages: [{ stageId: "dormant", maxRounds: 0 }],
    });
    const enable = request(
      ordinary,
      input("enabled", { dormant: 2 }),
      { dormant: 0 },
      { dormant: 2 },
    );
    expect(() =>
      startOwnedRuleContinuation(db, "arc", {
        ...enable,
        authorization: {
          ...enable.authorization,
          repairStages: [
            { stageId: "renamed", beforeMaxRounds: 0, afterMaxRounds: 2 },
          ],
        },
      }),
    ).toThrow("identities");
    const enabled = successorId(startOwnedRuleContinuation(db, "arc", enable));
    expect(claimOwnedRun(db, 4)?.row.id).toBe(enabled);
    complete(enabled, "dormant-1");
    expect(viewOwnedRun(db, enabled).repairRounds).toEqual([
      { stageId: "dormant", rounds: 1 },
    ]);
  });

  it("does not invent an empty known catalog for ordinary legacy zero-round lineage", () => {
    const run = start(input("legacy", {}, { maxRepairRounds: 0 })),
      nextInput = input("ordinary", {}, { maxRepairRounds: 0 });
    const next = successorId(
      startOwnedContinuation(db, "arc", {
        ...reserve(run, nextInput),
        successor: nextInput,
      }),
    );
    expect(readOwnedRepairCatalog(db, next)).toBeNull();
    expect(inspectOwnedRuleContext(db, "arc", next).repairCatalog).toEqual({
      source: "legacy-zero",
    });
  });

  it("distinguishes a reviewed empty catalog from legacy unknown IDs", () => {
    const run = start(input("empty", {}, { maxRepairRounds: 0 }));
    const next = successorId(
      startOwnedRuleContinuation(
        db,
        "arc",
        request(run, input("empty-next", {}, { maxRepairRounds: 0 }), {}, {}),
      ),
    );
    expect(inspectOwnedRuleContext(db, "arc", next).repairCatalog).toEqual({
      source: "stored",
      stages: [],
    });
    const invalid = request(
      next,
      input("invented", { other: 1 }),
      { other: 0 },
      { other: 1 },
    );
    expect(() => startOwnedRuleContinuation(db, "arc", invalid)).toThrow(
      "identities",
    );
  });

  it.each([
    "before",
    "missing",
    "extra",
    "emitted",
    "zero",
    "overall",
  ] as const)(
    "rejects an inconsistent %s stage catalog before seal",
    (kind) => {
      const run = start(input("original", { repair: 2 }));
      const change = request(
        run,
        input("next", { repair: 2 }),
        { repair: 2 },
        { repair: 2 },
      );
      if (kind === "before")
        change.authorization.repairStages[0].beforeMaxRounds = 1;
      if (kind === "missing") change.authorization.repairStages = [];
      if (kind === "extra")
        change.authorization.repairStages.push({
          stageId: "unknown",
          beforeMaxRounds: 0,
          afterMaxRounds: 0,
        });
      if (kind === "emitted")
        change.successor = input("next", { repair: 2, other: 1 });
      if (kind === "zero")
        change.authorization.repairStages[0].afterMaxRounds = 0;
      if (kind === "overall")
        change.authorization.repairStages[0].afterMaxRounds = 4;
      expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow();
      expect(
        inspectOwnedContinuation(db, "arc", {
          predecessorWorkflowRunId: change.predecessorWorkflowRunId,
          operationId: change.operationId,
        }),
      ).toMatchObject({ state: "ready", successorPlanHash: null });
    },
  );

  it("canonicalizes new stage order and seals the exact method, review and successor across retry", () => {
    const run = start(input("original", { a: 1, b: 2 }));
    const change = request(
      run,
      input("next", { a: 2, b: 2 }),
      { b: 2, a: 1 },
      { b: 2, a: 2 },
    );
    const result = startOwnedRuleContinuation(db, "arc", change);
    expect(
      startOwnedRuleContinuation(db, "arc", {
        ...change,
        authorization: {
          ...change.authorization,
          repairStages: [...change.authorization.repairStages].reverse(),
        },
      }),
    ).toEqual(result);
    expect(() =>
      startOwnedRuleContinuation(db, "arc", {
        ...change,
        authorization: {
          ...change.authorization,
          reviewHash: hashOwnedValue("changed"),
        },
      }),
    ).toThrow("authorization");
    expect(() =>
      startOwnedRuleContinuation(db, "arc", {
        ...change,
        successor: { ...change.successor, args: "changed" },
      }),
    ).toThrow("different content");
    expect(() =>
      startOwnedContinuation(db, "arc", {
        predecessorWorkflowRunId: run,
        operationId: change.operationId,
        successor: change.successor,
      }),
    ).toThrow("method");
    expect(() =>
      cancelOwnedContinuation(db, "arc", {
        predecessorWorkflowRunId: change.predecessorWorkflowRunId,
        operationId: change.operationId,
      }),
    ).toThrow("consumed");
    expect(() => createOwnedRun(db, "arc", change.successor)).toThrow(
      "continuation admission",
    );
  });

  it("rejects adding reviewed authority to an already sealed ordinary successor", () => {
    const run = start(),
      change = request(run, input("next"), { repair: 2 }, { repair: 2 });
    const ordinary = {
      predecessorWorkflowRunId: run,
      operationId: change.operationId,
      successor: change.successor,
    };
    startOwnedContinuation(db, "arc", ordinary);
    expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow(
      "method",
    );
    expect(startOwnedContinuation(db, "arc", ordinary).state).toBe("started");
  });

  it("replays the same reviewed catalogue order for distinct IDs with equal locale collation", () => {
    const before = { "\u00e9": 1, "e\u0301": 1 };
    const after = { "\u00e9": 2, "e\u0301": 2 };
    const run = start(input("original", before));
    const change = request(run, input("next", after), before, after);
    const result = startOwnedRuleContinuation(db, "arc", change);
    expect(
      startOwnedRuleContinuation(db, "arc", {
        ...change,
        authorization: {
          ...change.authorization,
          repairStages: [...change.authorization.repairStages].reverse(),
        },
      }),
    ).toEqual(result);
  });

  it("keeps catalogue reads pure and owner-only even while pause awaits a lost validation reply", () => {
    const run = start(),
      finished = complete(run, "worker");
    reserveOwnedValidationRequest(db, finished.row.effect_id, 0);
    const change = request(run, input("next"), { repair: 2 }, { repair: 2 });
    const before = db.serialize();
    expect(inspectOwnedRuleContext(db, "arc", run)).toMatchObject({
      run: { agentCalls: 1 },
      repairCatalog: {
        source: "manifest",
        stages: [{ stageId: "repair", maxRounds: 2 }],
      },
    });
    expect(db.serialize()).toEqual(before);
    expect(() => inspectOwnedRuleContext(db, "other", run)).toThrow(
      "not admitted",
    );
    expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow(
      "not yet quiescent",
    );
    expect(
      inspectOwnedContinuation(db, "arc", {
        predecessorWorkflowRunId: change.predecessorWorkflowRunId,
        operationId: change.operationId,
      })?.successorPlanHash,
    ).toBeNull();
  });

  it("holds native retirement, rechecks late accepted charges and preserves the sealed grant", () => {
    const run = start(),
      running = admit(run, "worker");
    const change = request(
      run,
      input("next", { repair: 2 }, { maxAgentCalls: 1 }),
      { repair: 2 },
      { repair: 2 },
    );
    expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow(
      "not yet quiescent",
    );
    recordOwnedObservation(
      db,
      running.row.effect_id,
      requireOwnedRun(db, run).row.dispatch_generation,
      terminalReceipt(
        running.request,
        "interrupted",
        { stopped: true },
        "agent",
      ),
      220,
    );
    const result = startOwnedRuleContinuation(db, "arc", change);
    expect(result.successor?.agentCalls).toBe(1);
    expect(result.predecessor.state).toBe("cancelled");
  });

  it("waits for exact owner-control retirement without deadlocking the ready review", () => {
    const run = start({ ...input(), steps: [v2Step("check"), decisionStep()] });
    const waiting = admit(run, "choice");
    recordOwnedObservation(
      db,
      waiting.row.effect_id,
      0,
      waitingControl(waiting.request),
      130,
    );
    const change = request(run, input("next", {}), {}, {});
    const retiring = startOwnedRuleContinuation(db, "arc", change);
    expect(retiring.state).toBe("retiring");
    expect(retiring.successor).toBeNull();
    expect(() =>
      cancelOwnedContinuation(db, "arc", {
        predecessorWorkflowRunId: change.predecessorWorkflowRunId,
        operationId: change.operationId,
      }),
    ).toThrow("consumed");
    const control = waitingControl(waiting.request);
    recordOwnedObservation(
      db,
      waiting.row.effect_id,
      requireOwnedRun(db, run).row.dispatch_generation,
      {
        state: "interrupted",
        resource: control.resource,
        receipt: { stopped: true },
        receiptHash: hashOwnedValue({ stopped: true }),
        validity: { state: "current", identityHash: hashOwnedValue("retired") },
      },
      310,
    );
    expect(finalizeOwnedContinuations(db, 320)).toEqual([run]);
    expect(startOwnedRuleContinuation(db, "arc", change).state).toBe("started");
  });

  it("rolls back the entire seal and retirement if catalogue persistence fails", () => {
    const run = start();
    complete(run, "repair-1");
    const change = request(run, input("next"), { repair: 2 }, { repair: 2 });
    db.exec(
      "CREATE TRIGGER reject_catalog BEFORE INSERT ON workflow_owned_repair_catalogs BEGIN SELECT RAISE(ABORT, 'catalog failure'); END",
    );
    expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow(
      "catalog failure",
    );
    expect(
      inspectOwnedContinuation(db, "arc", {
        predecessorWorkflowRunId: change.predecessorWorkflowRunId,
        operationId: change.operationId,
      }),
    ).toMatchObject({
      state: "ready",
      successorPlanHash: null,
      successor: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM workflow_owned_runs").get(),
    ).toEqual({ n: 1 });
    db.exec("DROP TRIGGER reject_catalog");
    expect(startOwnedRuleContinuation(db, "arc", change).state).toBe("started");
  });

  it("rejects V1 predecessors, foreign identities, caller counters and duplicate stage declarations", () => {
    const run = createOwnedRun(db, "arc", ownedRunInput());
    const change = request(run.workflowRunId, input("next", {}), {}, {});
    expect(() => startOwnedRuleContinuation(db, "arc", change)).toThrow("V2");
    expect(() => startOwnedRuleContinuation(db, "foreign", change)).toThrow(
      "not admitted",
    );
    for (const candidate of [
      { ...change, inheritedCalls: 0 },
      { ...change, authorization: { ...change.authorization, usedRounds: 0 } },
      {
        ...change,
        authorization: {
          ...change.authorization,
          repairStages: [
            { stageId: "a", beforeMaxRounds: 0, afterMaxRounds: 0 },
            { stageId: "a", beforeMaxRounds: 0, afterMaxRounds: 0 },
          ],
        },
      },
    ])
      expect(
        ownedRuleContinuationStartSchema.safeParse(candidate).success,
      ).toBe(false);
  });

  it.each(["ownerRunId", "projectId", "originThreadId"] as const)(
    "rejects a changed successor %s before the reviewed rule seal",
    (field) => {
      const run = start();
      const change = request(run, input("next"), { repair: 2 }, { repair: 2 });
      expect(() =>
        startOwnedRuleContinuation(db, "arc", {
          ...change,
          successor: { ...change.successor, [field]: "foreign" },
        }),
      ).toThrow("Continuation");
      expect(
        inspectOwnedContinuation(db, "arc", {
          predecessorWorkflowRunId: run,
          operationId: change.operationId,
        }),
      ).toMatchObject({ state: "ready", successorPlanHash: null });
    },
  );

  it("migrates the previous schema without rewriting old requests, receipts or ordinary continuation seals", () => {
    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.slice(0, -1).join("\n"));
    const legacy = v2Input({ steps: [v2Step("check"), decisionStep()] });
    const run = createOwnedRun(db, "arc", legacy, 100);
    claimOwnedRun(db, 4, 110);
    const original = complete(run.workflowRunId, "check");
    const waiting = admit(run.workflowRunId, "choice");
    const waitingObservation = waitingControl(waiting.request);
    recordOwnedObservation(
      db,
      waiting.row.effect_id,
      0,
      waitingObservation,
      130,
    );
    const before = requireOwnedRun(db, run.workflowRunId).row.request_json;
    const next = {
      ...legacy,
      ownerRunId: "legacy-successor",
      planHash: hashOwnedValue("legacy-next"),
    };
    const key = {
      predecessorWorkflowRunId: run.workflowRunId,
      operationId: "legacy-apply",
    };
    controlOwnedRun(
      db,
      "arc",
      {
        workflowRunId: run.workflowRunId,
        operationId: "legacy-pause",
        expectedVersion: 0,
        action: "pause",
      },
      200,
    );
    const successorJson = canonicalOwnedJson(next);
    const successorHash = hashOwnedValue({ owner: "arc", input: next });
    db.prepare(`INSERT INTO workflow_owned_continuations
      (predecessor_run_id, operation_id, owner_plugin_id, successor_owner_run_id,
       reservation_hash, state, successor_request_hash, successor_request_json, created_at, updated_at)
      VALUES (?, ?, 'arc', ?, ?, 'retiring', ?, ?, 200, 210)`).run(
      key.predecessorWorkflowRunId,
      key.operationId,
      next.ownerRunId,
      hashOwnedValue("legacy-reservation"),
      successorHash,
      successorJson,
    );
    controlOwnedRun(
      db,
      "arc",
      {
        workflowRunId: run.workflowRunId,
        operationId: "legacy-retire",
        expectedVersion: 1,
        action: "cancel",
      },
      210,
      key.operationId,
    );
    db.exec(migrations.at(-1)!);
    expect(requireOwnedRun(db, run.workflowRunId).row.request_json).toBe(
      before,
    );
    expect(
      requireOwnedAttempt(db, original.row.effect_id).row.terminal_receipt_json,
    ).toBe(original.row.terminal_receipt_json);
    expect(readOwnedRepairCatalog(db, run.workflowRunId)).toBeNull();
    expect(
      db
        .prepare(
          "SELECT successor_request_json, successor_request_hash, rule_authorization_json FROM workflow_owned_continuations",
        )
        .get(),
    ).toEqual({
      successor_request_json: successorJson,
      successor_request_hash: successorHash,
      rule_authorization_json: null,
    });
    expect(inspectOwnedContinuation(db, "arc", key)?.state).toBe("retiring");
    recordOwnedObservation(
      db,
      waiting.row.effect_id,
      requireOwnedRun(db, run.workflowRunId).row.dispatch_generation,
      {
        state: "interrupted",
        resource: waitingObservation.resource,
        receipt: { retired: true },
        receiptHash: hashOwnedValue({ retired: true }),
        validity: { state: "current", identityHash: hashOwnedValue("retired") },
      },
      230,
    );
    expect(finalizeOwnedContinuations(db, 240)).toEqual([run.workflowRunId]);
    expect(
      startOwnedContinuation(db, "arc", { ...key, successor: next }).state,
    ).toBe("started");
  });
});

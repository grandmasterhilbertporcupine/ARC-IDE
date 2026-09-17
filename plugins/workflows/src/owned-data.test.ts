import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimQueuedRun,
  createRun,
  migrations,
  recoverInterruptedRuns,
} from "./data.js";
import {
  admittedStep,
  ownedRunInput,
  terminalReceipt,
} from "./owned-test-fixtures.js";
import {
  activeOwnedAttempts,
  admitOwnedStep,
  claimOwnedRun,
  controlOwnedRun,
  countActiveWorkflowRuns,
  createOwnedRun,
  finishOwnedRun,
  hashOwnedValue,
  markOwnedAttemptUncertain,
  ownedTerminalObservation,
  recordOwnedObservation,
  recoverOwnedRuns,
  reconcileOwnedRunState,
  redispatchOwnedAttempt,
  requireOwnedAttempt,
  requireOwnedRun,
  reserveOwnedActiveInterval,
  settleOwnedActiveInterval,
  viewOwnedRun,
} from "./owned-data.js";
import type { OwnedRunStart, OwnedStepRef } from "./owned-contract.js";

describe("owned workflow durable ledger", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });
  afterEach(() => db.close());

  function start(input: OwnedRunStart = ownedRunInput()) {
    const run = createOwnedRun(db, "arc", input, 100);
    const claimed = claimOwnedRun(db, 4, 110);
    expect(claimed?.row.id).toBe(run.workflowRunId);
    return claimed!;
  }
  function admit(
    runId: string,
    ref: OwnedStepRef = { nodeId: "check", iteration: 0 },
    input = null,
  ) {
    const attempt = admitOwnedStep(
      db,
      runId,
      ref,
      input,
      requireOwnedRun(db, runId).row.dispatch_generation,
      120,
    );
    expect(attempt).not.toBeNull();
    return attempt!;
  }
  function terminal(
    effectId: string,
    state: "succeeded" | "failed" | "interrupted" = "succeeded",
  ) {
    const attempt = requireOwnedAttempt(db, effectId);
    const run = requireOwnedRun(db, attempt.row.run_id);
    if (attempt.row.kind === "owner-control")
      throw new Error("V1 fixture cannot complete an owner control");
    recordOwnedObservation(
      db,
      effectId,
      run.row.dispatch_generation,
      terminalReceipt(attempt.request, state, null, attempt.row.kind),
      130,
    );
  }

  it("makes owner start and versioned control idempotent while rejecting identity reuse", () => {
    const input = ownedRunInput();
    const run = createOwnedRun(db, "arc", input, 100);
    expect(createOwnedRun(db, "arc", input).workflowRunId).toBe(
      run.workflowRunId,
    );
    expect(() =>
      createOwnedRun(db, "arc", { ...input, args: "changed" }),
    ).toThrow("different content");
    const pause = {
      workflowRunId: run.workflowRunId,
      operationId: "pause-1",
      expectedVersion: 0,
      action: "pause" as const,
    };
    const result = controlOwnedRun(db, "arc", pause);
    expect(result).toMatchObject({
      state: "paused",
      controlVersion: 1,
      dispatchGeneration: 1,
    });
    expect(controlOwnedRun(db, "arc", pause)).toEqual(result);
    expect(() => controlOwnedRun(db, "other", pause)).toThrow("another owner");
    expect(() =>
      controlOwnedRun(db, "arc", { ...pause, action: "cancel" }),
    ).toThrow("different content");
    expect(() =>
      controlOwnedRun(db, "arc", { ...pause, operationId: "pause-2" }),
    ).toThrow("version changed");
  });

  it("binds canonical requests to fixed dependency receipts and preserves successful null", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("writer"),
          admittedStep("check", {
            dependencies: [
              { nodeId: "writer", iteration: 0, requiredOutcome: "succeeded" },
            ],
          }),
        ],
      }),
    );
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "check", iteration: 0 },
        null,
        0,
      ),
    ).toThrow("Required succeeded receipt");
    const writer = admit(run.row.id, { nodeId: "writer", iteration: 0 });
    terminal(writer.row.effect_id);
    const check = admit(run.row.id);
    expect(check.request.dependencyReceipts).toEqual([
      {
        nodeId: "writer",
        iteration: 0,
        effectId: writer.row.effect_id,
        receiptHash: hashOwnedValue(null),
        outcome: "succeeded",
      },
    ]);
    const {
      requestHash,
      dispatchGeneration: _generation,
      ...immutable
    } = check.request;
    expect(requestHash).toBe(hashOwnedValue({ owner: "arc", ...immutable }));
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "check", iteration: 0 },
        "different",
        0,
      ),
    ).toThrow("different input");
    terminal(check.row.effect_id);
    expect(finishOwnedRun(db, run.row.id, 0, null)).toBe(true);
    expect(viewOwnedRun(db, run.row.id).result).toEqual({
      available: true,
      value: null,
    });
  });

  it("blocks early return and failed required joins while admitting explicit failure branches", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("writer"),
          admittedStep("repair", {
            dependencies: [
              { nodeId: "writer", iteration: 0, requiredOutcome: "failed" },
            ],
          }),
          admittedStep("check", {
            dependencies: [
              { nodeId: "writer", iteration: 0, requiredOutcome: "succeeded" },
            ],
          }),
        ],
      }),
    );
    expect(() => finishOwnedRun(db, run.row.id, 0, null)).toThrow(
      "Required gate",
    );
    const writer = admit(run.row.id, { nodeId: "writer", iteration: 0 });
    terminal(writer.row.effect_id, "failed");
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "check", iteration: 0 },
        null,
        0,
      ),
    ).toThrow("Required succeeded");
    expect(
      admit(run.row.id, { nodeId: "repair", iteration: 0 }).request
        .dependencyReceipts[0]?.outcome,
    ).toBe("failed");
  });

  it("keeps historical receipts immutable while stale validity holds dispatch", () => {
    const run = start();
    const attempt = admit(run.row.id);
    terminal(attempt.row.effect_id);
    const history = requireOwnedAttempt(db, attempt.row.effect_id).row
      .terminal_receipt_json;
    markOwnedAttemptUncertain(db, attempt.row.effect_id, 0, "Host unavailable");
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "needs-reconciliation",
      desiredControl: "pause",
      dispatchGeneration: 1,
    });
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.terminal_receipt_json,
    ).toBe(history);
    expect(
      ownedTerminalObservation(requireOwnedAttempt(db, attempt.row.effect_id))
        ?.validity.state,
    ).toBe("stale");
    expect(() =>
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        1,
        terminalReceipt(attempt.request, "failed"),
      ),
    ).toThrow("immutable terminal");
    recordOwnedObservation(
      db,
      attempt.row.effect_id,
      1,
      terminalReceipt(attempt.request),
    );
    reconcileOwnedRunState(db, run.row.id, false);
    expect(viewOwnedRun(db, run.row.id).state).toBe("paused");
  });

  it("ignores late generations and refuses foreign native resource identities", () => {
    const run = start();
    const attempt = admit(run.row.id);
    controlOwnedRun(db, "arc", {
      workflowRunId: run.row.id,
      operationId: "pause",
      action: "pause",
      expectedVersion: 0,
    });
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        0,
        terminalReceipt(attempt.request),
      ),
    ).toBe(false);
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.terminal_state,
    ).toBeNull();
    expect(() =>
      recordOwnedObservation(db, attempt.row.effect_id, 1, {
        state: "running",
        resource: {
          kind: "host-effect",
          hostId: "host-1",
          effectId: "foreign",
        },
      }),
    ).toThrow("another effect");
    recordOwnedObservation(db, attempt.row.effect_id, 1, {
      state: "running",
      resource: {
        kind: "host-effect",
        hostId: "host-1",
        effectId: attempt.row.effect_id,
      },
    });
    expect(() =>
      recordOwnedObservation(db, attempt.row.effect_id, 1, {
        state: "not-started",
        reason: "Journal missing",
      }),
    ).toThrow("previously bound native resource");
    expect(() =>
      recordOwnedObservation(db, attempt.row.effect_id, 1, {
        state: "running",
        resource: {
          kind: "host-effect",
          hostId: "different",
          effectId: attempt.row.effect_id,
        },
      }),
    ).toThrow("bound native resource");
  });

  it("retains calls, lanes and unknown effects across both recovery paths", () => {
    const lane = {
      hostId: "host-1",
      repositoryId: "repo-1",
      target: { kind: "git-ref" as const, id: "branch" },
    };
    const steps = [admittedStep("check", { kind: "agent", lane })];
    const run = start(ownedRunInput({ steps }));
    const first = admit(run.row.id);
    recoverInterruptedRuns(db);
    expect(requireOwnedAttempt(db, first.row.effect_id).row.state).toBe(
      "dispatched",
    );
    recoverOwnedRuns(db, 5000);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      agentCalls: 1,
      state: "needs-reconciliation",
    });
    expect(activeOwnedAttempts(db)[0]?.row.effect_id).toBe(first.row.effect_id);
    const other = start(ownedRunInput({ ownerRunId: "arc-run-2", steps }));
    expect(
      admitOwnedStep(
        db,
        other.row.id,
        { nodeId: "check", iteration: 0 },
        null,
        0,
      ),
    ).toBeNull();
    terminal(first.row.effect_id, "interrupted");
    const next = admit(other.row.id);
    expect(next.request.lane?.fence).toBe((first.request.lane?.fence ?? 0) + 1);
  });

  it("redispatches authoritative absence with the same reservation and releases its lane on cancel", () => {
    const lane = {
      hostId: "host-1",
      repositoryId: "repo-1",
      target: { kind: "environment" as const, id: "workspace" },
    };
    const run = start(
      ownedRunInput({
        steps: [admittedStep("check", { kind: "agent", lane })],
      }),
    );
    const attempt = admit(run.row.id);
    recordOwnedObservation(db, attempt.row.effect_id, 0, {
      state: "not-started",
      reason: "No persisted native effect",
    });
    expect(admit(run.row.id).row.effect_id).toBe(attempt.row.effect_id);
    expect(redispatchOwnedAttempt(db, attempt.row.effect_id, 0)).toBe(true);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
    recordOwnedObservation(db, attempt.row.effect_id, 0, {
      state: "not-started",
      reason: null,
    });
    expect(
      controlOwnedRun(db, "arc", {
        workflowRunId: run.row.id,
        operationId: "cancel",
        expectedVersion: 0,
        action: "cancel",
      }).state,
    ).toBe("cancelled");
    expect(db.prepare("SELECT effect_id FROM workflow_lanes").get()).toEqual({
      effect_id: null,
    });
  });

  it("separates stage repair rounds from physical attempts and enforces slots and call limits", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("check", {
            kind: "agent",
            repair: { stageId: "checks", round: 1 },
          }),
          admittedStep("second", { kind: "agent" }),
        ],
        limits: {
          ...ownedRunInput().limits,
          maxConcurrentAgents: 1,
          maxAgentCalls: 2,
        },
      }),
    );
    const first = admit(run.row.id);
    expect(
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "second", iteration: 0 },
        null,
        0,
      ),
    ).toBeNull();
    terminal(first.row.effect_id, "interrupted");
    const second = admit(run.row.id);
    expect(second.row.attempt).toBe(2);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      agentCalls: 2,
      repairRounds: [{ stageId: "checks", rounds: 1 }],
    });
    terminal(second.row.effect_id, "interrupted");
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "check", iteration: 0 },
        null,
        0,
      ),
    ).toThrow("agent-call limit");
  });

  it("charges measured active intervals, preserves unresolved reservation, and excludes offline time", () => {
    const run = start(
      ownedRunInput({
        limits: { ...ownedRunInput().limits, maxActiveMs: 5000 },
      }),
    );
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 200)).toBe(1000);
    settleOwnedActiveInterval(db, run.row.id, 240, 440);
    expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(240);
    reserveOwnedActiveInterval(db, run.row.id, 0, 450);
    recoverOwnedRuns(db, 999_999_999);
    expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(1240);
    const claimed = claimOwnedRun(db, 4)!;
    reserveOwnedActiveInterval(db, run.row.id, claimed.row.dispatch_generation);
    settleOwnedActiveInterval(db, run.row.id, 1800);
    expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(3040);
  });

  it("shares one active-run cap with legacy workflows", () => {
    const legacy = createRun(db, {
      projectId: "project-1",
      originThreadId: "origin-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "Legacy",
      source: "return null",
      sourceHash: "hash",
      argsJson: "null",
      settingsJson: "{}",
      resumedFromRunId: null,
    });
    createOwnedRun(db, "arc", ownedRunInput());
    expect(claimQueuedRun(db, 1)?.id).toBe(legacy.id);
    expect(claimOwnedRun(db, 1)).toBeNull();
    expect(countActiveWorkflowRuns(db)).toBe(1);
    db.prepare(
      "UPDATE workflow_runs SET status = 'succeeded' WHERE id = ?",
    ).run(legacy.id);
    expect(claimOwnedRun(db, 1)).not.toBeNull();
    expect(countActiveWorkflowRuns(db)).toBe(1);
  });

  it("holds exhausted active-time budget across pause and resume", () => {
    const run = start(
      ownedRunInput({
        limits: { ...ownedRunInput().limits, maxActiveMs: 250 },
      }),
    );
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 200)).toBe(250);
    settleOwnedActiveInterval(db, run.row.id, 300, 500);
    expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(250);
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "check", iteration: 0 },
        null,
        0,
      ),
    ).toThrow("active-time limit");
    controlOwnedRun(
      db,
      "arc",
      {
        workflowRunId: run.row.id,
        operationId: "pause",
        expectedVersion: 0,
        action: "pause",
      },
      600,
    );
    expect(reserveOwnedActiveInterval(db, run.row.id, 1, 600_000)).toBe(0);
    controlOwnedRun(
      db,
      "arc",
      {
        workflowRunId: run.row.id,
        operationId: "resume",
        expectedVersion: 1,
        action: "resume",
      },
      700_000,
    );
    claimOwnedRun(db, 4);
    expect(() => reserveOwnedActiveInterval(db, run.row.id, 2)).toThrow(
      "active-time limit",
    );
    expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(250);
  });

  it("reconciles a recovered absent effect before reusing its original dispatch reservation", () => {
    const run = start(
      ownedRunInput({ steps: [admittedStep("check", { kind: "agent" })] }),
    );
    const attempt = admit(run.row.id);
    recoverOwnedRuns(db);
    expect(redispatchOwnedAttempt(db, attempt.row.effect_id, 1)).toBe(false);
    recordOwnedObservation(db, attempt.row.effect_id, 1, {
      state: "not-started",
      reason: "Native journal proves absence",
    });
    reconcileOwnedRunState(db, run.row.id, false);
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(redispatchOwnedAttempt(db, attempt.row.effect_id, 1)).toBe(true);
    expect(requireOwnedAttempt(db, attempt.row.effect_id)).toMatchObject({
      row: { attempt: 1 },
      request: {
        requestHash: attempt.request.requestHash,
        effectId: attempt.request.effectId,
      },
    });
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(1);
  });

  it("keeps user cancellation distinct from temporary reconciliation errors", () => {
    const run = start();
    const attempt = admit(run.row.id);
    controlOwnedRun(db, "arc", {
      workflowRunId: run.row.id,
      operationId: "cancel",
      expectedVersion: 0,
      action: "cancel",
    });
    markOwnedAttemptUncertain(
      db,
      attempt.row.effect_id,
      1,
      "Stop acknowledgement unavailable",
    );
    reconcileOwnedRunState(db, run.row.id, false);
    expect(viewOwnedRun(db, run.row.id).state).toBe("needs-reconciliation");
    terminal(attempt.row.effect_id, "interrupted");
    reconcileOwnedRunState(db, run.row.id, false);
    expect(viewOwnedRun(db, run.row.id).state).toBe("cancelled");
  });

  it("does not use repeated pause and resume to bypass unresolved receipt validity", () => {
    const run = start();
    const attempt = admit(run.row.id);
    terminal(attempt.row.effect_id);
    markOwnedAttemptUncertain(
      db,
      attempt.row.effect_id,
      0,
      "Candidate changed",
    );
    expect(
      controlOwnedRun(db, "arc", {
        workflowRunId: run.row.id,
        operationId: "pause-again",
        expectedVersion: 1,
        action: "pause",
      }).state,
    ).toBe("needs-reconciliation");
    expect(() =>
      controlOwnedRun(db, "arc", {
        workflowRunId: run.row.id,
        operationId: "resume",
        expectedVersion: 2,
        action: "resume",
      }),
    ).toThrow("Reconcile");
  });
});

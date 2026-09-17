import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations } from "./data.js";
import {
  ownedContinuationReserveSchema,
  ownedContinuationStartSchema,
  ownedStepObservationInputSchema,
  type OwnedRunStartInput,
} from "./owned-contract.js";
import {
  cancelOwnedContinuation,
  finalizeOwnedContinuations,
  inspectOwnedContinuation,
  reserveOwnedContinuation,
  startOwnedContinuation,
  startOwnedAddressedContinuation,
} from "./owned-continuation-data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  controlOwnedRun,
  createOwnedRun,
  hashOwnedValue,
  recordOwnedObservation,
  recoverOwnedRuns,
  reconcileOwnedRunState,
  requireOwnedAttempt,
  requireOwnedRun,
  reserveOwnedActiveInterval,
  reserveOwnedValidationRequest,
  settleOwnedActiveInterval,
  viewOwnedRun,
  readOwnedRepairCatalog,
} from "./owned-data.js";
import {
  admittedStep,
  ownedRunInput,
  terminalReceipt,
} from "./owned-test-fixtures.js";
import {
  decisionStep,
  v2Input,
  v2Step,
  waitingControl,
} from "./owned-v2-test-fixtures.js";

describe("owned continuation reservation and cumulative admission", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });
  afterEach(() => db.close());

  function start(input: OwnedRunStartInput = ownedRunInput()) {
    const view = createOwnedRun(db, "arc", input, 100);
    expect(claimOwnedRun(db, 4, 110)?.row.id).toBe(view.workflowRunId);
    return requireOwnedRun(db, view.workflowRunId);
  }
  function reserve(
    runId: string,
    operationId = "apply-1",
    successorOwnerRunId = "successor-1",
  ) {
    const input = {
      predecessorWorkflowRunId: runId,
      operationId,
      successorOwnerRunId,
      expectedControlVersion: viewOwnedRun(db, runId).controlVersion,
    };
    return {
      input,
      view: reserveOwnedContinuation(db, "arc", input, 200),
      key: { predecessorWorkflowRunId: runId, operationId },
    };
  }
  function successor(runId: string, ownerRunId = "successor-1") {
    return {
      ...requireOwnedRun(db, runId).input,
      ownerRunId,
      planHash: hashOwnedValue(ownerRunId),
    };
  }
  function admit(runId: string, nodeId = "check") {
    const attempt = admitOwnedStep(
      db,
      runId,
      { nodeId, iteration: 0 },
      null,
      requireOwnedRun(db, runId).row.dispatch_generation,
      120,
    );
    if (attempt === null) throw new Error("Fixture was not admitted");
    return attempt;
  }
  function complete(effectId: string) {
    const attempt = requireOwnedAttempt(db, effectId);
    if (attempt.row.kind === "owner-control")
      throw new Error("Fixture is a control");
    const receipt = terminalReceipt(
      attempt.request,
      "succeeded",
      { result: effectId },
      attempt.row.kind,
    );
    expect(
      recordOwnedObservation(
        db,
        effectId,
        requireOwnedRun(db, attempt.row.run_id).row.dispatch_generation,
        receipt,
        130,
      ),
    ).toBe(true);
    return receipt;
  }

  it("reserves exactly once, fences competing controls and prevents all direct successor starts", () => {
    const run = start();
    const operation = reserve(run.row.id);
    expect(operation.view).toMatchObject({
      state: "ready",
      successorPlanHash: null,
      successor: null,
    });
    expect(reserveOwnedContinuation(db, "arc", operation.input)).toEqual(
      operation.view,
    );
    expect(() =>
      reserveOwnedContinuation(db, "arc", {
        ...operation.input,
        successorOwnerRunId: "other",
      }),
    ).toThrow("different content");
    expect(() => reserve(run.row.id, "competing", "other")).toThrow(
      "already has",
    );
    for (const action of ["pause", "resume", "cancel"] as const)
      expect(() =>
        controlOwnedRun(db, "arc", {
          workflowRunId: run.row.id,
          operationId: action,
          expectedVersion: operation.view.predecessor.controlVersion,
          action,
        }),
      ).toThrow("held");
    expect(() => createOwnedRun(db, "arc", successor(run.row.id))).toThrow(
      "continuation admission",
    );
    expect(() => inspectOwnedContinuation(db, "other", operation.key)).toThrow(
      "not admitted",
    );
  });

  it.each(["succeeded", "failed", "cancelled"])(
    "continues a quiescent %s run without rewriting its outcome or resetting consumption",
    (state) => {
      const run = start();
      db.prepare(
        "UPDATE workflow_owned_runs SET state = ?, desired_control = ?, agent_calls = 2, charged_active_ms = 450, finished_at = 180 WHERE id = ?",
      ).run(state, state === "succeeded" ? "run" : "cancel", run.row.id);
      const before = viewOwnedRun(db, run.row.id);
      expect(() =>
        reserveOwnedContinuation(db, "arc", {
          predecessorWorkflowRunId: run.row.id,
          operationId: "stale",
          successorOwnerRunId: "stale-successor",
          expectedControlVersion: before.controlVersion + 1,
        }),
      ).toThrow("control version changed");
      const operation = reserve(run.row.id);
      expect(operation.view.state).toBe("ready");
      const result = startOwnedContinuation(db, "arc", {
        ...operation.key,
        successor: successor(run.row.id),
      });
      expect(result).toMatchObject({
        state: "started",
        predecessor: { state, agentCalls: 2, chargedActiveMs: 450 },
        successor: { agentCalls: 2, chargedActiveMs: 450 },
      });
      expect(viewOwnedRun(db, run.row.id)).toEqual(before);
      expect(
        startOwnedContinuation(db, "arc", {
          ...operation.key,
          successor: successor(run.row.id),
        }),
      ).toEqual(result);
    },
  );

  it("refuses terminal continuation while an admitted native effect is still unresolved", () => {
    const run = start();
    admit(run.row.id);
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'failed', desired_control = 'cancel' WHERE id = ?",
    ).run(run.row.id);
    expect(() => reserve(run.row.id)).toThrow("native work to reconcile");
  });

  it("carries shared consumption and retired repair history into an explicitly addressed revised graph", () => {
    const original = v2Input({
      steps: [
        v2Step("check"),
        v2Step("old-repair", {
          kind: "agent",
          repair: { stageId: "old", round: 1 },
        }),
      ],
    });
    const run = start(original);
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'succeeded', agent_calls = 3, charged_active_ms = 600 WHERE id = ?",
    ).run(run.row.id);
    db.prepare(
      "INSERT INTO workflow_owned_repair_baselines (run_id,stage_id,rounds) VALUES (?,'old',1)",
    ).run(run.row.id);
    const operation = reserve(run.row.id);
    const next = v2Input({
      ...original,
      ownerRunId: "successor-1",
      planHash: hashOwnedValue("revised"),
      steps: [
        v2Step("check"),
        v2Step("new-repair", {
          kind: "agent",
          repair: { stageId: "new", round: 1 },
        }),
      ],
    });
    expect(() =>
      startOwnedContinuation(db, "arc", { ...operation.key, successor: next }),
    ).toThrow("repair-stage identities");
    const input = {
      ...operation.key,
      successor: next,
      authorization: {
        kind: "addressed" as const,
        requestHash: hashOwnedValue("user-send"),
        predecessorPlanHash: original.planHash,
        repairStageMappings: [{ fromStageId: "old", toStageId: "stable-old" }],
      },
    };
    expect(() =>
      startOwnedAddressedContinuation(db, "arc", {
        ...input,
        authorization: {
          ...input.authorization,
          predecessorPlanHash: hashOwnedValue("wrong"),
        },
      }),
    ).toThrow("exact terminal predecessor");
    expect(() =>
      startOwnedAddressedContinuation(db, "arc", {
        ...input,
        successor: {
          ...next,
          limits: {
            ...next.limits,
            maxAgentCalls: next.limits.maxAgentCalls + 1,
          },
        },
      }),
    ).toThrow("shared limits");
    const result = startOwnedAddressedContinuation(db, "arc", input);
    expect(result.successor).toMatchObject({
      agentCalls: 3,
      chargedActiveMs: 600,
      repairRounds: [{ stageId: "stable-old", rounds: 1 }],
    });
    expect(readOwnedRepairCatalog(db, result.successor!.workflowRunId)).toEqual(
      {
        schemaVersion: 1,
        stages: [
          { stageId: "new", maxRounds: 1 },
          { stageId: "stable-old", maxRounds: 0 },
        ],
      },
    );
    expect(startOwnedAddressedContinuation(db, "arc", input)).toEqual(result);
    expect(() =>
      startOwnedAddressedContinuation(db, "arc", {
        ...input,
        authorization: {
          ...input.authorization,
          requestHash: hashOwnedValue("another-send"),
        },
      }),
    ).toThrow("does not match its seal");
  });

  it("cancels only unconsumed reservations, retains pause and permits a new explicit resume", () => {
    const run = start();
    const operation = reserve(run.row.id);
    const cancelled = cancelOwnedContinuation(db, "arc", operation.key);
    expect(cancelled).toMatchObject({
      state: "cancelled",
      predecessor: { desiredControl: "pause", state: "paused" },
    });
    expect(cancelOwnedContinuation(db, "arc", operation.key)).toEqual(
      cancelled,
    );
    expect(() =>
      startOwnedContinuation(db, "arc", {
        ...operation.key,
        successor: successor(run.row.id),
      }),
    ).toThrow("cancelled");
    expect(() => createOwnedRun(db, "arc", successor(run.row.id))).toThrow(
      "continuation admission",
    );
    const resumed = controlOwnedRun(db, "arc", {
      workflowRunId: run.row.id,
      expectedVersion: cancelled.predecessor.controlVersion,
      operationId: "explicit-resume",
      action: "resume",
    });
    expect(resumed.state).toBe("queued");
    expect(
      reserveOwnedContinuation(db, "arc", operation.input).predecessor.state,
    ).toBe("queued");
    expect(reserve(run.row.id, "apply-2", "successor-2").view.state).toBe(
      "ready",
    );
  });

  it("waits for unresolved native work and settled active intervals without rewriting receipts", () => {
    const run = start();
    const attempt = admit(run.row.id);
    reserveOwnedActiveInterval(
      db,
      run.row.id,
      run.row.dispatch_generation,
      125,
    );
    const operation = reserve(run.row.id);
    expect(operation.view.state).toBe("pausing");
    const request = { ...operation.key, successor: successor(run.row.id) };
    expect(() => startOwnedContinuation(db, "arc", request)).toThrow(
      "not yet quiescent",
    );
    const receipt = complete(attempt.row.effect_id);
    expect(inspectOwnedContinuation(db, "arc", operation.key)?.state).toBe(
      "pausing",
    );
    settleOwnedActiveInterval(db, run.row.id, 350, 300);
    expect(inspectOwnedContinuation(db, "arc", operation.key)?.state).toBe(
      "ready",
    );
    const result = startOwnedContinuation(db, "arc", request, 310);
    expect(result).toMatchObject({
      state: "started",
      predecessor: { state: "cancelled" },
      successor: { chargedActiveMs: 350 },
    });
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.terminal_receipt_hash,
    ).toBe("receiptHash" in receipt ? receipt.receiptHash : null);
    expect(startOwnedContinuation(db, "arc", request)).toEqual(result);
    expect(() => cancelOwnedContinuation(db, "arc", operation.key)).toThrow(
      "consumed",
    );
    expect(() =>
      startOwnedContinuation(db, "arc", {
        ...request,
        successor: { ...request.successor, args: "changed" },
      }),
    ).toThrow("different content");
  });

  it("retains a lost validation reply marker until the exact acknowledged proof quiesces", () => {
    const run = start(v2Input());
    const attempt = admit(run.row.id);
    const receipt = terminalReceipt(attempt.request, "succeeded", {
      candidate: "exact",
    });
    const current = ownedStepObservationInputSchema.parse({
      ...receipt,
      validity: {
        state: "current",
        validationId: "proof-a",
        identityHash: hashOwnedValue("exact"),
      },
    });
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        run.row.dispatch_generation,
        ownedStepObservationInputSchema.parse({
          ...receipt,
          validity: {
            state: "checking",
            validationId: "proof-a",
            activity: "running",
            reason: "Initial proof",
          },
        }),
        125,
      ),
    ).toBe(true);
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        run.row.dispatch_generation,
        current,
        130,
      ),
    ).toBe(true);
    const pending = reserveOwnedValidationRequest(
      db,
      attempt.row.effect_id,
      run.row.dispatch_generation,
    );
    const operation = reserve(run.row.id);
    expect(operation.view.state).toBe("pausing");
    expect(() =>
      startOwnedContinuation(db, "arc", {
        ...operation.key,
        successor: successor(run.row.id),
      }),
    ).toThrow("not yet quiescent");
    const paused = requireOwnedRun(db, run.row.id);
    expect(
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        paused.row.dispatch_generation,
        ownedStepObservationInputSchema.parse({
          ...receipt,
          validity: {
            state: "checking",
            validationId: "proof-a",
            activity: "quiescent",
            reason: "All actual scans stopped",
          },
        }),
        220,
        pending,
      ),
    ).toBe(true);
    expect(inspectOwnedContinuation(db, "arc", operation.key)?.state).toBe(
      "ready",
    );
    expect(
      startOwnedContinuation(db, "arc", {
        ...operation.key,
        successor: successor(run.row.id),
      }).state,
    ).toBe("started");
    expect(
      requireOwnedAttempt(db, attempt.row.effect_id).row.validation_request_id,
    ).toBeNull();
  });

  it("holds a tagged running proof even without an unresolved validation request", () => {
    const run = start(v2Input());
    const attempt = admit(run.row.id);
    const receipt = terminalReceipt(attempt.request);
    recordOwnedObservation(
      db,
      attempt.row.effect_id,
      run.row.dispatch_generation,
      ownedStepObservationInputSchema.parse({
        ...receipt,
        validity: {
          state: "checking",
          validationId: "proof-a",
          activity: "running",
          reason: "Scanning",
        },
      }),
    );
    const operation = reserve(run.row.id);
    expect(operation.view.predecessor.activeAgents).toBe(0);
    expect(operation.view.state).toBe("pausing");
    expect(finalizeOwnedContinuations(db)).toEqual([]);
  });

  it.each(["user", "ci"] as const)(
    "preserves waiting %s controls until start and waits for their actual interruption",
    (waitReason) => {
      const run = start(v2Input({ steps: [decisionStep(), v2Step("check")] }));
      const attempt = admit(run.row.id, "choice");
      const waiting = waitingControl(attempt.request, 4, waitReason);
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        run.row.dispatch_generation,
        waiting,
      );
      const first = reserve(run.row.id);
      expect(first.view.state).toBe("ready");
      cancelOwnedContinuation(db, "arc", first.key);
      expect(requireOwnedAttempt(db, attempt.row.effect_id).row.state).toBe(
        "waiting",
      );
      const next = reserve(run.row.id, "apply-2", "successor-2");
      const request = {
        ...next.key,
        successor: successor(run.row.id, "successor-2"),
      };
      expect(startOwnedContinuation(db, "arc", request).state).toBe("retiring");
      expect(() => cancelOwnedContinuation(db, "arc", next.key)).toThrow(
        "consumed",
      );
      expect(finalizeOwnedContinuations(db)).toEqual([]);
      recoverOwnedRuns(db, 250);
      const retained = requireOwnedRun(db, run.row.id);
      expect(retained.row.desired_control).toBe("cancel");
      recordOwnedObservation(
        db,
        attempt.row.effect_id,
        retained.row.dispatch_generation,
        {
          state: "interrupted",
          resource: waiting.resource,
          receipt: { stopped: true },
          receiptHash: hashOwnedValue({ stopped: true }),
          validity: {
            state: "current",
            identityHash: hashOwnedValue("cancelled-control"),
          },
        },
      );
      reconcileOwnedRunState(db, run.row.id, false, 260);
      expect(viewOwnedRun(db, run.row.id).state).toBe("cancelling");
      expect(finalizeOwnedContinuations(db, 270)).toEqual([run.row.id]);
      const completed = inspectOwnedContinuation(db, "arc", next.key);
      expect(completed).toMatchObject({
        state: "started",
        predecessor: { state: "cancelled" },
        successor: { agentCalls: 0 },
      });
      expect(startOwnedContinuation(db, "arc", request)).toEqual(completed);
      expect(finalizeOwnedContinuations(db)).toEqual([]);
    },
  );

  it("enforces cumulative calls, time and local repair offsets across repeated continuations", () => {
    const input = ownedRunInput({
      steps: [
        admittedStep("normal", { kind: "agent" }),
        ...[1, 2, 3].map((round) =>
          admittedStep(`repair-${round}`, {
            kind: "agent",
            repair: { stageId: "stage-a", round },
          }),
        ),
        admittedStep("check"),
      ],
      limits: {
        maxAgentCalls: 4,
        maxConcurrentAgents: 4,
        maxRepairRounds: 3,
        maxActiveMs: 2000,
      },
    });
    let run = start(input);
    complete(admit(run.row.id, "normal").row.effect_id);
    for (let index = 0; index < 3; index += 1) {
      complete(admit(run.row.id, "repair-1").row.effect_id);
      reserveOwnedActiveInterval(
        db,
        run.row.id,
        run.row.dispatch_generation,
        120,
      );
      settleOwnedActiveInterval(db, run.row.id, 200, 150);
      expect(viewOwnedRun(db, run.row.id)).toMatchObject({
        agentCalls: index + 2,
        chargedActiveMs: (index + 1) * 200,
        repairRounds: [{ stageId: "stage-a", rounds: index + 1 }],
      });
      const operation = reserve(
        run.row.id,
        `apply-${index}`,
        `successor-${index}`,
      );
      const next = startOwnedContinuation(db, "arc", {
        ...operation.key,
        successor: successor(run.row.id, `successor-${index}`),
      });
      if (next.successor === null) throw new Error("Missing successor");
      expect(next.successor).toMatchObject({
        agentCalls: index + 2,
        chargedActiveMs: (index + 1) * 200,
        repairRounds: [{ stageId: "stage-a", rounds: index + 1 }],
      });
      expect(claimOwnedRun(db, 4)?.row.id).toBe(next.successor.workflowRunId);
      run = requireOwnedRun(db, next.successor.workflowRunId);
    }
    expect(() => admit(run.row.id, "normal")).toThrow("agent-call limit");
    expect(() => admit(run.row.id, "repair-1")).toThrow("agent-call limit");
  });

  it("does not reset the repair limit when new runs restart their local round numbers", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("check", { repair: { stageId: "stage-a", round: 1 } }),
        ],
        limits: {
          maxConcurrentAgents: 4,
          maxAgentCalls: 100,
          maxRepairRounds: 1,
          maxActiveMs: 2000,
        },
      }),
    );
    complete(admit(run.row.id).row.effect_id);
    const operation = reserve(run.row.id);
    const next = startOwnedContinuation(db, "arc", {
      ...operation.key,
      successor: successor(run.row.id),
    });
    if (next.successor === null) throw new Error("Missing successor");
    claimOwnedRun(db, 4);
    expect(() => admit(next.successor!.workflowRunId)).toThrow(
      "stage repair limit",
    );
  });

  it.each([1, 2])(
    "retains a stage ceiling of %s below the policy limit across continuation and restart",
    (stageLimit) => {
      const run = start(
        v2Input({
          steps: [
            v2Step("check"),
            ...Array.from({ length: stageLimit }, (_, index) =>
              v2Step(`repair-${index + 1}`, {
                kind: "agent",
                repair: { stageId: "stage-a", round: index + 1 },
              }),
            ),
            v2Step("other-repair", {
              kind: "agent",
              repair: { stageId: "stage-b", round: 1 },
            }),
          ],
          limits: {
            maxConcurrentAgents: 4,
            maxAgentCalls: 100,
            maxRepairRounds: 3,
            maxActiveMs: 2000,
          },
        }),
      );
      const original = admit(run.row.id, "repair-1");
      const receipt = complete(original.row.effect_id);
      const operation = reserve(run.row.id);
      const request = {
        ...operation.key,
        successor: successor(run.row.id),
      };
      const next = startOwnedContinuation(db, "arc", request);
      if (next.successor === null) throw new Error("Missing successor");
      expect(startOwnedContinuation(db, "arc", request)).toEqual(next);
      recoverOwnedRuns(db, 300);
      const nextId = next.successor.workflowRunId;
      expect(claimOwnedRun(db, 4)?.row.id).toBe(nextId);
      if (stageLimit === 2) complete(admit(nextId, "repair-1").row.effect_id);
      const before = viewOwnedRun(db, nextId);
      expect(() => admit(nextId, `repair-${stageLimit}`)).toThrow(
        "stage repair limit",
      );
      expect(viewOwnedRun(db, nextId)).toEqual(before);
      complete(admit(nextId, "other-repair").row.effect_id);
      const repeated = reserve(nextId, "apply-2", "successor-2");
      const last = startOwnedContinuation(db, "arc", {
        ...repeated.key,
        successor: successor(nextId, "successor-2"),
      });
      if (last.successor === null) throw new Error("Missing successor");
      expect(last.successor.repairRounds).toEqual([
        { stageId: "stage-a", rounds: stageLimit },
        { stageId: "stage-b", rounds: 1 },
      ]);
      expect(claimOwnedRun(db, 4)?.row.id).toBe(last.successor.workflowRunId);
      expect(() => admit(last.successor!.workflowRunId, "repair-1")).toThrow(
        "stage repair limit",
      );
      expect(
        requireOwnedAttempt(db, original.row.effect_id).row
          .terminal_receipt_hash,
      ).toBe("receiptHash" in receipt ? receipt.receiptHash : null);
    },
  );

  it("rejects changed declared stage ceilings before sealing an unchanged-rule continuation", () => {
    const stageSteps = (rounds: number) => [
      v2Step("check"),
      ...Array.from({ length: rounds }, (_, index) =>
        v2Step(`repair-${index + 1}`, {
          repair: { stageId: "stage-a", round: index + 1 },
        }),
      ),
    ];
    const run = start(v2Input({ steps: stageSteps(2) }));
    const operation = reserve(run.row.id);
    for (const rounds of [1, 3])
      expect(() =>
        startOwnedContinuation(db, "arc", {
          ...operation.key,
          successor: {
            ...successor(run.row.id),
            schemaVersion: 2,
            steps: stageSteps(rounds),
          },
        }),
      ).toThrow("repair-stage");
    expect(inspectOwnedContinuation(db, "arc", operation.key)).toMatchObject({
      state: "ready",
      successorPlanHash: null,
      successor: null,
    });
  });

  it("rejects changed scope, origin, limits and repair identities before consuming the reservation", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("check", { repair: { stageId: "stage-a", round: 1 } }),
        ],
      }),
    );
    const operation = reserve(run.row.id);
    const next = successor(run.row.id);
    for (const invalid of [
      { ...next, ownerRunId: "different" },
      { ...next, projectId: "other-project" },
      { ...next, originThreadId: "other-origin" },
      { ...next, limits: { ...next.limits, maxAgentCalls: 1 } },
      {
        ...next,
        steps: [
          admittedStep("check", { repair: { stageId: "renamed", round: 1 } }),
        ],
      },
    ])
      expect(() =>
        startOwnedContinuation(db, "arc", {
          ...operation.key,
          successor: invalid,
        }),
      ).toThrow();
    expect(inspectOwnedContinuation(db, "arc", operation.key)).toMatchObject({
      state: "ready",
      successorPlanHash: null,
    });
    expect(
      ownedContinuationReserveSchema.safeParse({
        ...operation.input,
        inheritedAgentCalls: 0,
      }).success,
    ).toBe(false);
    expect(
      ownedContinuationStartSchema.safeParse({
        ...operation.key,
        successor: next,
        counters: {},
      }).success,
    ).toBe(false);
  });

  it("rolls back retirement and successor creation together if inherited accounting cannot be persisted", () => {
    const run = start(
      ownedRunInput({
        steps: [
          admittedStep("check", { repair: { stageId: "stage-a", round: 1 } }),
        ],
      }),
    );
    complete(admit(run.row.id).row.effect_id);
    const operation = reserve(run.row.id);
    const request = { ...operation.key, successor: successor(run.row.id) };
    db.exec(
      "CREATE TRIGGER reject_transfer BEFORE INSERT ON workflow_owned_repair_baselines BEGIN SELECT RAISE(ABORT, 'transfer failure'); END",
    );
    expect(() => startOwnedContinuation(db, "arc", request)).toThrow(
      "transfer failure",
    );
    expect(inspectOwnedContinuation(db, "arc", operation.key)).toMatchObject({
      state: "ready",
      successor: null,
      successorPlanHash: null,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM workflow_owned_runs").get(),
    ).toEqual({ total: 1 });
    db.exec("DROP TRIGGER reject_transfer");
    const result = startOwnedContinuation(db, "arc", request);
    expect(result.state).toBe("started");
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM workflow_owned_runs").get(),
    ).toEqual({ total: 2 });
  });

  it("reports owned reservation absence after a competing control wins without releasing foreign state", () => {
    const run = start();
    const key = {
      predecessorWorkflowRunId: run.row.id,
      operationId: "late-apply",
    };
    const paused = controlOwnedRun(db, "arc", {
      workflowRunId: run.row.id,
      operationId: "competing-pause",
      expectedVersion: 0,
      action: "pause",
    });
    expect(() =>
      reserveOwnedContinuation(db, "arc", {
        ...key,
        expectedControlVersion: 0,
        successorOwnerRunId: "replacement",
      }),
    ).toThrow("version changed");
    expect(inspectOwnedContinuation(db, "arc", key)).toBeNull();
    expect(viewOwnedRun(db, run.row.id)).toEqual(paused);
    expect(() => inspectOwnedContinuation(db, "other", key)).toThrow(
      "not admitted",
    );
    expect(() =>
      inspectOwnedContinuation(db, "arc", {
        ...key,
        predecessorWorkflowRunId: "missing",
      }),
    ).toThrow("Unknown owned workflow run");
    expect(() => cancelOwnedContinuation(db, "arc", key)).toThrow(
      "Unknown workflow continuation",
    );
    expect(
      controlOwnedRun(db, "arc", {
        workflowRunId: run.row.id,
        operationId: "explicit-resume",
        expectedVersion: paused.controlVersion,
        action: "resume",
      }).state,
    ).toBe("queued");
  });
});

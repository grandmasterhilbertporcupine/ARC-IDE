import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations } from "./data.js";
import {
  canonicalOwnedJson,
  ownedRunStartInputSchema,
  type OwnedRunStartInput,
  type OwnedStepObservationV2,
} from "./owned-contract.js";
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
  ownedRunClockExcluded,
  recordOwnedObservation,
  recoverOwnedRuns,
  reconcileOwnedRunState,
  requireOwnedAttempt,
  requireOwnedRun,
  reserveOwnedActiveInterval,
  selectedOwnedAttempt,
  settleOwnedActiveInterval,
  viewOwnedRun,
} from "./owned-data.js";
import { ownedRunInput, terminalReceipt } from "./owned-test-fixtures.js";
import {
  branchInput,
  controlReceipt,
  decisionStep,
  v2Input,
  v2Step,
  waitingControl,
} from "./owned-v2-test-fixtures.js";

describe("V2 owned graph ledger", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });
  afterEach(() => db.close());
  function start(input: OwnedRunStartInput = branchInput()) {
    const view = createOwnedRun(
      db,
      "arc",
      ownedRunStartInputSchema.parse(input),
      100,
    );
    const run = claimOwnedRun(db, 4, 110);
    expect(run?.row.id).toBe(view.workflowRunId);
    if (run === null) throw new Error("Run was not claimed");
    return run;
  }
  function admit(runId: string, nodeId: string, input = null) {
    const attempt = admitOwnedStep(
      db,
      runId,
      { nodeId, iteration: 0 },
      input,
      requireOwnedRun(db, runId).row.dispatch_generation,
      120,
    );
    if (attempt === null) throw new Error("Step was not admitted");
    return attempt;
  }
  function observe(
    effectId: string,
    observation: OwnedStepObservationV2,
    generation?: number,
  ) {
    const attempt = requireOwnedAttempt(db, effectId);
    return recordOwnedObservation(
      db,
      effectId,
      generation ??
        requireOwnedRun(db, attempt.row.run_id).row.dispatch_generation,
      observation,
      130,
    );
  }

  it("ignores forged branch input, creates no unselected attempt and binds only selected dependency receipts", () => {
    const run = start();
    expect(() => admit(run.row.id, "left")).toThrow("receipt is unavailable");
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, controlReceipt(choice.request));
    expect(() =>
      admitOwnedStep(
        db,
        run.row.id,
        { nodeId: "right", iteration: 0 },
        { selectedOutputs: ["false"], dependencyReceipts: [] },
        0,
      ),
    ).toThrow("was not selected");
    expect(
      selectedOwnedAttempt(db, run.row.id, { nodeId: "right", iteration: 0 }),
    ).toBeNull();
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(0);
    expect(() => admit(run.row.id, "check")).toThrow("receipt is unavailable");
    const left = admit(run.row.id, "left");
    observe(
      left.row.effect_id,
      terminalReceipt(left.request, "succeeded", { actual: "left" }, "agent"),
    );
    const check = admit(run.row.id, "check");
    expect(
      check.request.dependencyReceipts.map((receipt) => receipt.nodeId),
    ).toEqual(["choice", "left"]);
    expect(check.request).toHaveProperty("schemaVersion", 2);
    const {
      requestHash,
      dispatchGeneration: _generation,
      ...immutable
    } = check.request;
    expect(requestHash).toBe(hashOwnedValue({ owner: "arc", ...immutable }));
    observe(check.row.effect_id, terminalReceipt(check.request));
    expect(finishOwnedRun(db, run.row.id, 0, null)).toBe(true);
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      state: "succeeded",
      agentCalls: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_attempts").get(),
    ).toEqual({ count: 3 });
  });

  it("rejects undeclared outputs, wrong outcomes and changed control identities before a branch can dispatch", () => {
    const run = start();
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request));
    expect(() =>
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["invented"]),
      ),
    ).toThrow("undeclared output");
    expect(() =>
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["true"], 1, "failed"),
      ),
    ).toThrow("undeclared output");
    const receipt = controlReceipt(choice.request);
    expect(() =>
      observe(choice.row.effect_id, {
        ...receipt,
        resource: { kind: "owner-control", controlId: "different" },
      }),
    ).toThrow("bound native resource");
    expect(
      requireOwnedAttempt(db, choice.row.effect_id).row.terminal_state,
    ).toBeNull();
    observe(choice.row.effect_id, receipt);
    expect(() =>
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["false"], 2),
      ),
    ).toThrow("immutable terminal");
    expect(() => admit(run.row.id, "right")).toThrow("was not selected");
  });

  it("preserves one waiting control across pause, lost responses and restart without accepting stale revisions or generations", () => {
    const run = start();
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request, 2));
    const pause = {
      workflowRunId: run.row.id,
      expectedVersion: 0,
      operationId: "pause-control",
      action: "pause" as const,
    };
    const paused = controlOwnedRun(db, "arc", pause);
    expect(paused.state).toBe("paused");
    expect(controlOwnedRun(db, "arc", pause)).toEqual(paused);
    expect(
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["true"], 3),
        0,
      ),
    ).toBe(false);
    markOwnedAttemptUncertain(
      db,
      choice.row.effect_id,
      1,
      "response lost",
      150,
    );
    recoverOwnedRuns(db, 160);
    expect(requireOwnedAttempt(db, choice.row.effect_id).row.state).toBe(
      "needs-reconciliation",
    );
    observe(choice.row.effect_id, waitingControl(choice.request, 2));
    reconcileOwnedRunState(db, run.row.id, false);
    expect(viewOwnedRun(db, run.row.id).state).toBe("paused");
    controlOwnedRun(db, "arc", {
      workflowRunId: run.row.id,
      expectedVersion: 1,
      operationId: "resume-control",
      action: "resume",
    });
    expect(claimOwnedRun(db, 4)?.row.id).toBe(run.row.id);
    expect(admit(run.row.id, "choice").row.effect_id).toBe(
      choice.row.effect_id,
    );
    expect(
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["true"], 1),
      ),
    ).toBe(false);
    expect(requireOwnedAttempt(db, choice.row.effect_id).row.state).toBe(
      "waiting",
    );
    expect(
      observe(
        choice.row.effect_id,
        controlReceipt(choice.request, ["true"], 3),
      ),
    ).toBe(true);
    expect(
      requireOwnedAttempt(db, choice.row.effect_id).row.control_revision,
    ).toBe(3);
    expect(viewOwnedRun(db, run.row.id).agentCalls).toBe(0);
  });

  it("holds an unsettled optional control even when the required successful gate exists", () => {
    const run = start(v2Input({ steps: [decisionStep(), v2Step("check")] }));
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request));
    const check = admit(run.row.id, "check");
    observe(check.row.effect_id, terminalReceipt(check.request));
    expect(() => finishOwnedRun(db, run.row.id, 0, null)).toThrow(
      "still active",
    );
    expect(viewOwnedRun(db, run.row.id)).toMatchObject({
      activeAgents: 0,
      agentCalls: 0,
      state: "running",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_lanes").get(),
    ).toEqual({ count: 0 });
  });

  it("discards delayed control revisions after terminal acceptance without invalidating the accepted decision", () => {
    const run = start();
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request, 2));
    const accepted = controlReceipt(choice.request, ["true"], 3);
    observe(choice.row.effect_id, accepted);
    const before = requireOwnedAttempt(db, choice.row.effect_id);
    for (const delayed of [
      waitingControl(choice.request, 2),
      controlReceipt(choice.request, ["false"], 2),
    ]) {
      expect(observe(choice.row.effect_id, delayed)).toBe(false);
      expect(requireOwnedAttempt(db, choice.row.effect_id)).toEqual(before);
      expect(viewOwnedRun(db, run.row.id)).toMatchObject({
        state: "running",
        desiredControl: "run",
        dispatchGeneration: 0,
      });
    }
    for (const revision of [3, 4]) {
      expect(() =>
        observe(choice.row.effect_id, waitingControl(choice.request, revision)),
      ).toThrow("immutable terminal");
      expect(() =>
        observe(
          choice.row.effect_id,
          controlReceipt(choice.request, ["false"], revision),
        ),
      ).toThrow("immutable terminal");
    }
    expect(requireOwnedAttempt(db, choice.row.effect_id)).toEqual(before);
    expect(
      admit(run.row.id, "left").request.dependencyReceipts[0].receiptHash,
    ).toBe(accepted.receiptHash);
    expect(() => admit(run.row.id, "right")).toThrow("was not selected");
  });

  it.each(["user", "ci", "dependency", "owner"] as const)(
    "accounts %s waits without resetting the active budget",
    (waitReason) => {
      const run = start(v2Input({ steps: [decisionStep(), v2Step("check")] }));
      const choice = admit(run.row.id, "choice");
      expect(reserveOwnedActiveInterval(db, run.row.id, 0, 120)).toBe(1000);
      settleOwnedActiveInterval(db, run.row.id, 50, 170);
      observe(
        choice.row.effect_id,
        waitingControl(choice.request, 0, waitReason),
      );
      const excluded = waitReason === "user" || waitReason === "ci";
      expect(ownedRunClockExcluded(db, run.row.id)).toBe(excluded);
      expect(reserveOwnedActiveInterval(db, run.row.id, 0, 10_000)).toBe(
        excluded ? 0 : 1000,
      );
      expect(viewOwnedRun(db, run.row.id).chargedActiveMs).toBe(
        excluded ? 50 : 1050,
      );
    },
  );

  it("charges time when a user wait overlaps native work or another blocked script step", () => {
    const run = start(v2Input({ steps: [decisionStep(), v2Step("check")] }));
    const choice = admit(run.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request));
    expect(ownedRunClockExcluded(db, run.row.id)).toBe(true);
    const pending = [{ nodeId: "check", iteration: 0 }];
    expect(ownedRunClockExcluded(db, run.row.id, pending)).toBe(false);
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 200, pending)).toBe(
      1000,
    );
    settleOwnedActiveInterval(db, run.row.id, 100, 300);
    admit(run.row.id, "check");
    expect(ownedRunClockExcluded(db, run.row.id)).toBe(false);
    expect(reserveOwnedActiveInterval(db, run.row.id, 0, 400)).toBe(1000);
  });

  it("does not let paused waiting controls bypass the shared active-run cap on resume", () => {
    const first = start();
    const choice = admit(first.row.id, "choice");
    observe(choice.row.effect_id, waitingControl(choice.request));
    controlOwnedRun(db, "arc", {
      workflowRunId: first.row.id,
      expectedVersion: 0,
      operationId: "pause",
      action: "pause",
    });
    expect(countActiveWorkflowRuns(db)).toBe(0);
    const second = start(v2Input({ ownerRunId: "second" }));
    controlOwnedRun(db, "arc", {
      workflowRunId: first.row.id,
      expectedVersion: 1,
      operationId: "resume",
      action: "resume",
    });
    expect(claimOwnedRun(db, 1)).toBeNull();
    expect(countActiveWorkflowRuns(db)).toBe(1);
    expect(requireOwnedRun(db, second.row.id).row.state).toBe("running");
  });

  it("retains V1 request bytes and hash semantics across recovery after the additive migration", () => {
    const input = ownedRunInput();
    const run = start(input);
    const check = admit(run.row.id, "check");
    expect(run.row.request_json).toBe(canonicalOwnedJson(input));
    expect(run.row.request_hash).toBe(hashOwnedValue({ owner: "arc", input }));
    expect(check.request).not.toHaveProperty("schemaVersion");
    const {
      requestHash,
      dispatchGeneration: _generation,
      ...immutable
    } = check.request;
    expect(requestHash).toBe(hashOwnedValue({ owner: "arc", ...immutable }));
    recoverOwnedRuns(db, 1000);
    expect(requireOwnedRun(db, run.row.id).row.request_json).toBe(
      run.row.request_json,
    );
    expect(requireOwnedAttempt(db, check.row.effect_id).row.request_json).toBe(
      check.row.request_json,
    );
    expect(activeOwnedAttempts(db, run.row.id)[0]?.row.effect_id).toBe(
      check.row.effect_id,
    );
  });
});

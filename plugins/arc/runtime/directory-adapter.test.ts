import { afterEach, describe, expect, it } from "vitest";
import {
  claimOwnedRun,
  reconcileOwnedRunState,
  controlOwnedRun,
  getOwnedAttempt,
  ownedTerminalObservation,
  pendingOwnedValidationRequests,
  recordOwnedObservation,
  reserveOwnedValidationRequest,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { runtimeNodeKey } from "./compiler.js";
import { createDirectoryRuntimeFixture } from "./directory-runtime-testing.js";
import { runtimeHash } from "./hash.js";
import { teamEdge } from "../teams/testing.js";

const fixtures: ReturnType<typeof createDirectoryRuntimeFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
function fixture(
  options: Parameters<typeof createDirectoryRuntimeFixture>[0] = {},
) {
  const value = createDirectoryRuntimeFixture(options);
  fixtures.push(value);
  return value;
}

function reviewGrantFixture() {
  return fixture({
    update(team) {
      team.members.push({ ...team.members[0], id: "reviewer" });
      team.graph.nodes.find((node) => node.kind === "review")!.memberId =
        "reviewer";
      team.permissions.push({
        id: "review-builder",
        action: "review",
        fromMemberId: "reviewer",
        toMemberId: "builder",
      });
    },
  });
}
function retainWithoutReviewGrant(run: ReturnType<typeof fixture>) {
  const retained = structuredClone(run.compiled);
  retained.definition.team.definition.permissions = [];
  run.db
    .prepare("UPDATE arc_runs SET compiled_json = ? WHERE id = ?")
    .run(JSON.stringify(retained), retained.definition.runId);
}
async function admitReview(run: ReturnType<typeof fixture>) {
  for (const step of run.compiled.workflow.steps) {
    const request = run.admit(step.nodeId, step.iteration);
    const node = run.compiled.nodes[runtimeNodeKey(step)];
    if (node.kind === "agent" && node.purpose === "review") return request;
    await run.settle(request);
  }
  throw new Error("Missing review step");
}

describe("directory review authority recovery", () => {
  it("blocks an ungranted recovered review before provider preparation", async () => {
    const run = reviewGrantFixture();
    const request = await admitReview(run);
    retainWithoutReviewGrant(run);
    await expect(run.invoke(request, "executeStep")).rejects.toThrow(
      /review work by builder/,
    );
    expect(run.preparations.has(request.effectId)).toBe(false);
    expect(run.calls.workerStarts).toBe(1);
  });
  it("does not release a prepared ungranted reviewer and still interrupts its physical admission scan", async () => {
    const run = reviewGrantFixture();
    const request = await admitReview(run);
    run.holdScans(true);
    await run.invoke(request, "executeStep");
    const preparation = run.preparations.get(request.effectId);
    expect(preparation?.state).toBe("prepared");
    retainWithoutReviewGrant(run);
    expect(await run.invoke(request, "observeStep")).toMatchObject({
      state: "needs-reconciliation",
      reason: expect.stringContaining("review work by builder"),
    });
    expect(run.calls.workerStarts).toBe(1);
    expect(run.preparations.get(request.effectId)).toEqual(preparation);
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-ungranted-review",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    await run.invoke(request, "interruptStep");
    expect(run.store.directories.activeValidations(request.effectId)).toEqual(
      [],
    );
    expect(run.calls.workerStarts).toBe(1);
  });
  it.each(["review", "verify"])(
    "preserves retained %s receipt hashes while new physical validation reports stale authority",
    async (target) => {
      const run = reviewGrantFixture();
      const review = await admitReview(run);
      await run.settle(review);
      if (target === "verify") {
        const ref = run.compiled.references.finalGates[0].verify;
        await run.settle(run.admit(ref.nodeId, ref.iteration));
      }
      const targets = run.store
        .completionEffects(run.compiled.definition.runId)
        .filter((effect) => {
          const node = run.compiled.nodes[runtimeNodeKey(effect.request)];
          return target === "verify"
            ? node.kind === "verify"
            : node.kind === "agent" && node.purpose === "review";
        });
      expect(targets).toHaveLength(1);
      retainWithoutReviewGrant(run);
      const beforeScans = run.calls.scans;
      for (const effect of targets) {
        const before = effect.observation;
        if (!before || !("receipt" in before))
          throw new Error("Missing old receipt");
        let after = await run.invoke(effect.request, "observeStep");
        for (
          let index = 0;
          index < 20 &&
          !("receipt" in after && after.validity.state === "stale");
          index++
        )
          after = await run.invoke(effect.request, "observeStep");
        expect(after).toMatchObject({
          state: before.state,
          receipt: before.receipt,
          receiptHash: before.receiptHash,
          validity: {
            state: "stale",
            reason: expect.stringContaining("review work by builder"),
          },
        });
      }
      expect(run.calls.scans).toBeGreaterThan(beforeScans);
      expect(run.calls.workerStarts).toBe(2);
      expect(run.calls.mainStarts).toBe(0);
    },
  );
  it("quiesces pending validation without adopting or changing a now-ungranted review receipt", async () => {
    const run = reviewGrantFixture();
    const review = await admitReview(run);
    await run.settle(review);
    const effect = run.store.effect(review.effectId);
    const before = effect.observation;
    if (!before || !("receipt" in before))
      throw new Error("Missing original review");
    run.holdScans(true);
    const validationRequest = reserveOwnedValidationRequest(
      run.db,
      effect.effectId,
      viewOwnedRun(run.db, run.workflow.workflowRunId).dispatchGeneration,
    );
    await run.invoke(effect.request, "observeStep", false);
    retainWithoutReviewGrant(run);
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-ungranted-proof",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    run.delayInterrupt(true);
    const stopping = await run.invoke(effect.request, "interruptStep", false);
    expect(stopping).toMatchObject({
      validity: { state: "checking", activity: "running" },
    });
    expect(
      recordOwnedObservation(
        run.db,
        effect.effectId,
        viewOwnedRun(run.db, run.workflow.workflowRunId).dispatchGeneration,
        stopping,
        Date.now(),
        validationRequest,
      ),
    ).toBe(false);
    expect(
      pendingOwnedValidationRequests(run.db).map(
        (attempt) => attempt.row.effect_id,
      ),
    ).toContain(effect.effectId);
    run.delayInterrupt(false);
    expect(await run.invoke(effect.request, "interruptStep")).toMatchObject({
      receipt: before.receipt,
      receiptHash: before.receiptHash,
      validity: { state: "checking", activity: "quiescent" },
    });
    expect(run.store.directories.activeValidations(effect.effectId)).toEqual(
      [],
    );
  });
});

describe("directory native runtime and shared scheduler", () => {
  it.each([0, 1])(
    "executes only the selected serial condition branch and joins its exact receipts (predicate %s)",
    async (value) => {
      const run = fixture({
        update(team) {
          team.graph.nodes.push(
            {
              id: "condition",
              kind: "condition",
              label: "Check outcome",
              predicate: {
                kind: "check-exit",
                sourceNodeId: "check",
                operator: "eq",
                value,
              },
            },
            ...["yes", "no"].map((id) => ({
              id,
              kind: "agent" as const,
              label: id,
              memberId: "builder",
              task: "Inspect the chosen path",
              access: "read" as const,
              candidate: { kind: "node" as const, nodeId: "write" },
            })),
            {
              id: "selected",
              kind: "join",
              label: "Selected path",
              mode: "selected",
              decisionNodeId: "condition",
            },
          );
          team.graph.edges = [
            teamEdge("write", "check"),
            teamEdge("check", "condition", "completed"),
            teamEdge("condition", "yes", "succeeded", "true"),
            teamEdge("condition", "no", "succeeded", "false"),
            teamEdge("yes", "selected"),
            teamEdge("no", "selected"),
            teamEdge("selected", "review"),
          ];
        },
      });
      await run.execute();
      const executed = run.store
        .completionEffects(run.compiled.definition.runId)
        .flatMap((effect) => {
          const origin =
            run.compiled.references.origins[runtimeNodeKey(effect.request)];
          return origin ? [origin.graphNodeId] : [];
        });
      expect(executed).toContain(value === 0 ? "yes" : "no");
      expect(executed).not.toContain(value === 0 ? "no" : "yes");
      expect(run.calls.workerStarts).toBe(3);
      expect(run.calls.mainStarts).toBe(1);
    },
  );
  it("runs bounded declared delegations serially and retains each assigned writer snapshot", async () => {
    const run = fixture({
      assignments: ["alice", "bob"],
      update(team) {
        for (const id of ["alice", "bob"]) {
          team.members.push({ ...team.members[0], id });
          team.permissions.push({
            id: `grant-${id}`,
            action: "delegate",
            fromMemberId: "builder",
            toMemberId: id,
          });
          team.permissions.push({
            id: `review-${id}`,
            action: "review",
            fromMemberId: "builder",
            toMemberId: id,
          });
        }
        team.graph.nodes = team.graph.nodes.filter(
          (node) => node.id !== "write",
        );
        team.graph.nodes.push({
          id: "write",
          label: "Delegate work",
          kind: "delegation",
          requesterMemberId: "builder",
          candidateMemberIds: ["alice", "bob"],
          maxChildCalls: 2,
          task: "Build the requested app",
          access: "write",
          candidate: { kind: "source" },
        });
      },
    });
    await run.execute();
    expect(run.calls.workerStarts).toBe(4);
    expect(run.calls.mainStarts).toBe(1);
    const workers = run.store
      .completionEffects(run.compiled.definition.runId)
      .filter(
        (effect) =>
          run.compiled.nodes[runtimeNodeKey(effect.request)].kind === "agent",
      );
    expect(workers).toHaveLength(4);
    expect(
      new Set(workers.map((effect) => effect.workerBinding?.workspace.path))
        .size,
    ).toBe(4);
  });
  it("does not settle a mismatched scan while another scan in the same pass is still running", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    )!;
    const request = run.admit(source.nodeId, source.iteration);
    await run.settle(request);
    run.holdScans(true);
    await run.invoke(request, "observeStep");
    const original = run.directories.get(run.compiled.definition.source.path)!;
    run.directories.set(original.path, {
      ...original,
      manifestDigest: runtimeHash("changed source"),
    });
    run.completeScan(original.path);
    expect(await run.invoke(request, "observeStep")).toMatchObject({
      validity: { state: "checking", activity: "running" },
    });
    run.completeScans();
    expect(await run.invoke(request, "observeStep")).toMatchObject({
      validity: { state: "stale" },
    });
  });
  it("pauses a core-completed writer during output inventory and binds output only after fresh resumed inspection", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    )!;
    await run.settle(run.admit(source.nodeId, source.iteration));
    const writer = run.compiled.workflow.steps.find((step) => {
      const node = run.compiled.nodes[runtimeNodeKey(step)];
      return node.kind === "agent" && node.purpose === "writer";
    })!;
    const node = run.compiled.nodes[runtimeNodeKey(writer)];
    if (node.kind !== "agent") throw new Error("Missing writer");
    await run.settle(
      run.admit(node.workspace.nodeId, node.workspace.iteration),
    );
    const request = run.admit(writer.nodeId, writer.iteration);
    run.holdAfterWorker(true);
    await run.invoke(request, "executeStep");
    expect(run.calls.workerStarts).toBe(1);
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-output",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    const paused = await run.invoke(request, "interruptStep");
    expect(paused).toMatchObject({
      state: "succeeded",
      receipt: {
        kind: "directory-agent",
        terminalStatus: "completed",
        observed: null,
      },
      validity: { state: "checking", activity: "quiescent" },
    });
    expect(run.store.directories.workerOutput(request.effectId)).toBeNull();
    reconcileOwnedRunState(run.db, current.workflowRunId, false);
    const settled = viewOwnedRun(run.db, current.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "resume-output",
      expectedVersion: settled.controlVersion,
      action: "resume",
    });
    claimOwnedRun(run.db, 4);
    run.holdScans(false);
    const resumed = await run.settle(request);
    expect(resumed).toMatchObject({
      state: "succeeded",
      validity: { state: "current" },
    });
    if (!("receipt" in paused) || !("receipt" in resumed))
      throw new Error("Missing terminal receipt");
    expect(resumed.receiptHash).toBe(paused.receiptHash);
    expect(run.calls.workerStarts).toBe(1);
    const output = run.store.directories.workerOutput(request.effectId);
    expect(output).toEqual(run.directories.get(output!.path));
    run.directories.set(output!.path, {
      ...output!,
      manifestDigest: runtimeHash("post-output drift"),
    });
    await run.invoke(request, "observeStep");
    expect(await run.invoke(request, "observeStep")).toMatchObject({
      validity: { state: "stale" },
    });
  });
  it("preserves the same pending approval and original context when the run pauses", async () => {
    const run = fixture({ autonomy: "collaborative" });
    const plan = run.compiled.workflow.steps.find((step) => {
      const node = run.compiled.nodes[runtimeNodeKey(step)];
      return node.kind === "control" && node.operation.type === "approval";
    })!;
    const request = run.admit(plan.nodeId, plan.iteration);
    expect(await run.settle(request)).toMatchObject({
      state: "waiting",
      waitReason: "user",
    });
    const before = run.store.controls.find(
      request.ownerRunId,
      request.effectId,
    );
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-approval",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    expect(await run.invoke(request, "interruptStep")).toMatchObject({
      state: "waiting",
      waitReason: "user",
    });
    expect(
      run.store.controls.find(request.ownerRunId, request.effectId),
    ).toEqual(before);
    expect(run.calls.workerStarts).toBe(0);
  });
  it.each([false, true])(
    "executes immutable copies, exact check and review, and counted main completion (repair %s)",
    async (repair) => {
      const run = fixture({ repair });
      const original = structuredClone(
        run.directories.get(run.compiled.definition.source.path),
      );
      await run.execute();
      expect(run.calls.workerStarts).toBe(repair ? 3 : 2);
      expect(run.calls.mainStarts).toBe(1);
      expect(viewOwnedRun(run.db, run.workflow.workflowRunId)).toMatchObject({
        agentCalls: repair ? 4 : 3,
        activeAgents: 0,
      });
      expect(run.directories.get(run.compiled.definition.source.path)).toEqual(
        original,
      );
      const receipts = run.receipts();
      const native = receipts.filter(
        (receipt) => "kind" in receipt && receipt.kind === "directory-native",
      );
      const checks = native.filter(
        (receipt) => receipt.request.operation.type === "check-directory",
      );
      expect(checks.map((receipt) => receipt.receipt.outcome)).toContain(
        "succeeded",
      );
      if (repair)
        expect(checks.map((receipt) => receipt.receipt.outcome)).toContain(
          "failed",
        );
      const final = run.store.finalVerification(run.compiled.definition.runId);
      expect(final?.observation).toMatchObject({
        state: "succeeded",
        validity: { state: "current" },
      });
      if (
        !final?.observation ||
        !("receipt" in final.observation) ||
        !("validationId" in final.observation.validity)
      )
        throw new Error("Missing final proof");
      expect(
        run.store.directories.validationCheckedAt(
          final.observation.validity.validationId,
          { effectId: final.effectId, runId: final.runId },
        ),
      ).toBeTruthy();
      expect(
        new Set(
          native
            .filter(
              (receipt) =>
                receipt.request.operation.type === "materialize-directory",
            )
            .map((receipt) => receipt.receipt.after?.path),
        ).size,
      ).toBe(repair ? 5 : 3);
    },
  );

  it("retains a long source scan without mutation, stale poisoning or a duplicate effect", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    );
    if (!source) throw new Error("Missing source");
    const request = run.admit(source.nodeId, source.iteration);
    run.holdScans(true);
    expect(await run.invoke(request, "executeStep")).toMatchObject({
      state: "not-started",
    });
    expect(await run.invoke(request, "executeStep")).toMatchObject({
      state: "not-started",
    });
    expect(run.calls).toMatchObject({
      scans: 1,
      mutations: 0,
      workerStarts: 0,
    });
    expect(viewOwnedRun(run.db, run.workflow.workflowRunId)).toMatchObject({
      agentCalls: 0,
      desiredControl: "run",
    });
    run.completeScans();
    expect(await run.settle(request)).toMatchObject({
      state: "succeeded",
      validity: { state: "current" },
    });
    expect(run.calls.mutations).toBe(1);
    expect(run.store.listEffectIds(request.ownerRunId, 100, 0).total).toBe(1);
  });

  it("detects same-root content drift before capture instead of admitting a provider", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    );
    if (!source) throw new Error("Missing source");
    const request = run.admit(source.nodeId, source.iteration);
    const original = run.directories.get(run.compiled.definition.source.path)!;
    run.directories.set(original.path, {
      ...original,
      manifestDigest: runtimeHash("drift"),
    });
    expect(await run.invoke(request, "executeStep")).toMatchObject({
      state: "needs-reconciliation",
    });
    expect(run.calls).toMatchObject({
      mutations: 0,
      workerStarts: 0,
      mainStarts: 0,
    });
  });

  it("quiesces the exact acknowledged validation after pause advances generation", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    );
    if (!source) throw new Error("Missing source");
    const request = run.admit(source.nodeId, source.iteration);
    await run.settle(request);
    run.holdScans(true);
    const checking = await run.invoke(request, "observeStep");
    expect(checking).toMatchObject({
      state: "succeeded",
      validity: { state: "checking", activity: "running" },
    });
    const before = run.calls.scans;
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      action: "pause",
      expectedVersion: current.controlVersion,
      operationId: "pause-test",
    });
    const quiescent = await run.invoke(request, "interruptStep");
    if (!("receipt" in checking) || !("receipt" in quiescent))
      throw new Error("Missing terminal evidence");
    expect(quiescent.receiptHash).toBe(checking.receiptHash);
    expect(quiescent.validity).toMatchObject({
      state: "checking",
      activity: "quiescent",
      validationId:
        "validationId" in checking.validity
          ? checking.validity.validationId
          : null,
    });
    expect(run.calls.scans).toBe(before);
    expect(run.calls.interruptedScans).toBeGreaterThan(0);
    const attempt = getOwnedAttempt(run.db, request.effectId)!;
    expect(ownedTerminalObservation(attempt)?.validity).toMatchObject({
      state: "checking",
      activity: "quiescent",
    });
  });
  it("waits for the actual scan process to stop after an abort acknowledgement", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    )!;
    const request = run.admit(source.nodeId, source.iteration);
    await run.settle(request);
    run.holdScans(true);
    await run.invoke(request, "observeStep");
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-delayed",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    run.delayInterrupt(true);
    expect(await run.invoke(request, "interruptStep")).toMatchObject({
      validity: { state: "checking", activity: "running" },
    });
    expect(
      run.store.directories.activeValidations(request.effectId).length,
    ).toBeGreaterThan(0);
    run.delayInterrupt(false);
    expect(await run.invoke(request, "interruptStep")).toMatchObject({
      validity: { state: "checking", activity: "quiescent" },
    });
    expect(run.store.directories.activeValidations(request.effectId)).toEqual(
      [],
    );
  });
  it("retains acknowledged A when the next scan reply B was lost before pause", async () => {
    const run = fixture();
    const source = run.compiled.workflow.steps.find(
      (step) =>
        run.compiled.nodes[runtimeNodeKey(step)].kind === "capture-source",
    )!;
    const request = run.admit(source.nodeId, source.iteration);
    const currentProof = await run.settle(request);
    run.holdScans(true);
    const lost = await run.invoke(request, "observeStep", false);
    const current = viewOwnedRun(run.db, run.workflow.workflowRunId);
    controlOwnedRun(run.db, "arc", {
      workflowRunId: current.workflowRunId,
      operationId: "pause-lost",
      expectedVersion: current.controlVersion,
      action: "pause",
    });
    const paused = await run.invoke(request, "interruptStep");
    if (
      !("receipt" in currentProof) ||
      !("receipt" in lost) ||
      !("receipt" in paused)
    )
      throw new Error("Missing receipt");
    expect(paused.validity).toMatchObject({
      state: "checking",
      activity: "quiescent",
      validationId:
        "validationId" in currentProof.validity
          ? currentProof.validity.validationId
          : null,
    });
    expect(lost.validity).not.toEqual(paused.validity);
    expect(paused.receiptHash).toBe(currentProof.receiptHash);
    expect(run.store.directories.activeValidations(request.effectId)).toEqual(
      [],
    );
  });
});

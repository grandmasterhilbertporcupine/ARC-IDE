import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  OwnedAdmittedStepV2,
  OwnedDependencyReceipt,
  OwnedStepObservationV2,
  OwnedStepRequestInput,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
} from "../../workflows/src/owned-data.js";
import { terminalReceipt } from "../../workflows/src/owned-test-fixtures.js";
import { migrations } from "../data.js";
import { runtimeNodeKey } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { runtimeHash } from "./hash.js";
import type { ArcRunEffect } from "./data.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    [...migrations, ...runtimeMigrations, ...workflowMigrations].join(";\n"),
  );
});
afterEach(() => db.close());

function fixture(writerOutcome: "succeeded" | "failed" = "succeeded") {
  const definition = graphRunDefinitionFixture((team) => {
    team.graph.edges[0].requiredOutcome = "completed";
  });
  definition.policy.autonomy = "autonomous";
  const compiled = compileArcGraphRun(definition);
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const run = createOwnedRun(db, "arc", compiled.workflow);
  const claimed = claimOwnedRun(db, 4);
  if (claimed === null) throw new Error("Run was not claimed");
  let proof: OwnedDependencyReceipt | null = null;
  for (const step of compiled.workflow.steps) {
    if (compiled.nodes[runtimeNodeKey(step)].kind === "check") {
      if (proof === null) throw new Error("Writer proof is missing");
      return {
        store,
        step,
        run,
        generation: claimed.row.dispatch_generation,
        proof,
      };
    }
    if (step.kind === "owner-control")
      throw new Error("Unexpected control in autonomous writer chain");
    const attempt = admitOwnedStep(
      db,
      run.workflowRunId,
      { nodeId: step.nodeId, iteration: step.iteration },
      null,
      claimed.row.dispatch_generation,
    );
    if (attempt === null)
      throw new Error("Writer prerequisite was not admitted");
    store.reserveEffect(attempt.request);
    const state =
      compiled.nodes[runtimeNodeKey(step)].kind === "commit"
        ? writerOutcome
        : "succeeded";
    const observation = terminalReceipt(
      attempt.request,
      state,
      { prerequisite: step.nodeId },
      step.kind,
    );
    if (!("receiptHash" in observation))
      throw new Error("Prerequisite did not produce a terminal receipt");
    store.recordObservation(attempt.row.effect_id, observation);
    recordOwnedObservation(
      db,
      attempt.row.effect_id,
      claimed.row.dispatch_generation,
      observation,
    );
    proof = {
      nodeId: step.nodeId,
      iteration: step.iteration,
      effectId: attempt.row.effect_id,
      outcome: state,
      receiptHash: observation.receiptHash,
    };
  }
  throw new Error("The compiled check is missing");
}

function requestFor(
  step: OwnedAdmittedStepV2,
  workflowRunId: string,
  ownerRunId: string,
  dependencyReceipts: OwnedDependencyReceipt[],
): OwnedStepRequestInput {
  const immutable = {
    schemaVersion: 2 as const,
    workflowRunId,
    ownerRunId,
    nodeId: step.nodeId,
    iteration: step.iteration,
    attempt: 1,
    effectId: "check-admission",
    definitionHash: step.definitionHash,
    dependencyReceipts,
    lane: step.lane === null ? null : { key: runtimeHash(step.lane), fence: 1 },
    input: null,
  };
  return {
    ...immutable,
    requestHash: runtimeHash({ owner: "arc", ...immutable }),
    dispatchGeneration: 0,
  };
}

describe("compiled graph dependency admission", () => {
  it("retains the accepted owner-control decision when an earlier observation arrives late", () => {
    const compiled = compileArcGraphRun(graphRunDefinitionFixture());
    const store = createArcRunStore(db);
    store.reserve(compiled);
    const step = compiled.workflow.steps[0];
    expect(step.kind).toBe("owner-control");
    const request = requestFor(
      step,
      "workflow-control",
      compiled.definition.runId,
      [],
    );
    store.reserveEffect(request);
    const waiting = {
      state: "waiting",
      resource: { kind: "owner-control", controlId: request.effectId },
      revision: 2,
      waitReason: "user",
    } as const;
    store.recordObservation(request.effectId, waiting);
    const receipt = {
      revision: 3,
      selectedOutputs: ["approved"],
      data: {
        workspace: null,
        decision: {
          kind: "approval",
          value: "approved",
          operationId: "approval",
          contextHash: "a".repeat(64),
        },
        check: null,
      },
    };
    const accepted = {
      state: "succeeded",
      resource: waiting.resource,
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: compiled.workflow.planHash },
    } as const;
    store.recordObservation(request.effectId, accepted);
    const oldReceipt = {
      ...receipt,
      revision: 2,
      selectedOutputs: ["rejected"],
      data: {
        ...receipt.data,
        decision: { ...receipt.data.decision, value: "rejected" },
      },
    };
    expect(store.recordObservation(request.effectId, waiting)).toEqual(
      accepted,
    );
    expect(
      store.recordObservation(request.effectId, {
        ...accepted,
        state: "failed",
        receipt: oldReceipt,
        receiptHash: runtimeHash(oldReceipt),
      }),
    ).toEqual(accepted);
    expect(createArcRunStore(db).effect(request.effectId).observation).toEqual(
      accepted,
    );
    for (const revision of [3, 4]) {
      expect(() =>
        store.recordObservation(request.effectId, { ...waiting, revision }),
      ).toThrow("receipt_conflict");
      const changed = { ...oldReceipt, revision };
      expect(() =>
        store.recordObservation(request.effectId, {
          ...accepted,
          state: "failed",
          receipt: changed,
          receiptHash: runtimeHash(changed),
        }),
      ).toThrow("receipt_conflict");
    }
    expect(() =>
      store.recordObservation(request.effectId, {
        ...waiting,
        resource: { ...waiting.resource, controlId: "different-control" },
      }),
    ).toThrow("receipt_conflict");
    expect(store.effect(request.effectId).observation).toEqual(accepted);
  });

  it("accepts the Workflows ledger's single proof for repeated compiled edge and candidate requirements", () => {
    const { store, step, run, generation } = fixture();
    expect(step.requirements).toHaveLength(2);
    const attempt = admitOwnedStep(
      db,
      run.workflowRunId,
      { nodeId: step.nodeId, iteration: step.iteration },
      null,
      generation,
    );
    if (attempt === null) throw new Error("Check was not admitted");
    expect(attempt.request.dependencyReceipts).toHaveLength(1);
    const admitted = store.reserveEffect(attempt.request);
    expect(admitted.request).toEqual(attempt.request);
    expect(createArcRunStore(db).reserveEffect(attempt.request).effectId).toBe(
      admitted.effectId,
    );
  });

  it("rejects duplicated supplied proofs even when their count equals the compiled requirement count", () => {
    const { store, step, run, proof } = fixture();
    const request = requestFor(step, run.workflowRunId, run.ownerRunId, [
      proof,
      proof,
    ]);
    expect(() => store.reserveEffect(request)).toThrow("effect_conflict");
    expect(store.findEffect(request.effectId)).toBeNull();
  });

  it("requires every repeated outcome constraint instead of widening completed and succeeded to either outcome", () => {
    const { store, step, run, proof } = fixture("failed");
    expect(step.requirements).toEqual([
      {
        kind: "receipt",
        step: { nodeId: proof.nodeId, iteration: proof.iteration },
        outcomes: ["succeeded", "failed"],
      },
      {
        kind: "receipt",
        step: { nodeId: proof.nodeId, iteration: proof.iteration },
        outcomes: ["succeeded"],
      },
    ]);
    const request = requestFor(step, run.workflowRunId, run.ownerRunId, [
      proof,
    ]);
    expect(() => store.reserveEffect(request)).toThrow("dependency_missing");
    expect(store.findEffect(request.effectId)).toBeNull();
  });

  it.each(["missing", "substituted", "extra"] as const)(
    "rejects %s dependency identities without reserving an effect",
    (kind) => {
      const { store, step, run, proof } = fixture();
      const other = { ...proof, nodeId: "unadmitted-source" };
      const proofs =
        kind === "missing"
          ? []
          : kind === "substituted"
            ? [other]
            : [proof, other];
      const request = requestFor(
        step,
        run.workflowRunId,
        run.ownerRunId,
        proofs,
      );
      expect(() => store.reserveEffect(request)).toThrow();
      expect(store.findEffect(request.effectId)).toBeNull();
    },
  );

  it("selects only bound same-run agents retaining the exact successful approval proof", () => {
    const definition = graphRunDefinitionFixture();
    definition.policy.autonomy = "guided";
    const compiled = compileArcGraphRun(definition);
    const store = createArcRunStore(db);
    store.reserve(compiled);
    const run = createOwnedRun(db, "arc", compiled.workflow);
    const claimed = claimOwnedRun(db, 4);
    if (claimed === null) throw new Error("Run was not claimed");
    let approval: ArcRunEffect | null = null;
    let worker: ArcRunEffect | null = null;
    for (const step of compiled.workflow.steps) {
      const attempt = admitOwnedStep(
        db,
        run.workflowRunId,
        { nodeId: step.nodeId, iteration: step.iteration },
        null,
        claimed.row.dispatch_generation,
      );
      if (attempt === null) throw new Error("Guided step was not admitted");
      const effect = store.reserveEffect(attempt.request);
      if (step.kind === "agent") {
        worker = effect;
        break;
      }
      const receipt = {
        revision: 2,
        selectedOutputs: ["approved"],
        data: {
          workspace: null,
          decision: {
            kind: "approval",
            value: "approved",
            operationId: "approve-writer",
            contextHash: "a".repeat(64),
          },
          check: null,
        },
      };
      const observation: OwnedStepObservationV2 =
        step.kind === "owner-control"
          ? {
              state: "succeeded",
              resource: { kind: "owner-control", controlId: effect.effectId },
              receipt,
              receiptHash: runtimeHash(receipt),
              validity: {
                state: "current",
                identityHash: compiled.workflow.planHash,
              },
            }
          : terminalReceipt(attempt.request);
      store.recordObservation(effect.effectId, observation);
      recordOwnedObservation(
        db,
        effect.effectId,
        claimed.row.dispatch_generation,
        observation,
      );
      if (step.kind === "owner-control")
        approval = store.effect(effect.effectId);
    }
    if (worker === null || approval === null)
      throw new Error("Guided worker and approval were not admitted");
    expect(store.approvalConsumers(approval.effectId)).toEqual([]);
    const path = "C:/Project 東京/worktree";
    store.sealWorker(worker.effectId, {
      prompt: "Approved task",
      workspace: {
        path,
        topLevel: path,
        gitDir: `${path}/.git`,
        commonGitDir: definition.source.commonGitDir,
        head: definition.source.head,
        currentBranch: null,
        clean: true,
        trackedDigest: "b".repeat(64),
        untrackedDigest: "b".repeat(64),
        contentDigest: "b".repeat(64),
        stateDigest: "b".repeat(64),
      },
    });
    expect(
      store
        .approvalConsumers(approval.effectId)
        .map((effect) => effect.effectId),
    ).toEqual([worker.effectId]);
    const originalRequest = JSON.stringify(worker.request);
    for (const change of [
      { receiptHash: "c".repeat(64) },
      { outcome: "failed" },
      { effectId: "different-approval" },
    ]) {
      const changed = {
        ...worker.request,
        dependencyReceipts: worker.request.dependencyReceipts.map((proof) =>
          proof.effectId === approval.effectId
            ? { ...proof, ...change }
            : proof,
        ),
      };
      db.prepare(
        "UPDATE arc_run_effects SET request_json = ? WHERE effect_id = ?",
      ).run(JSON.stringify(changed), worker.effectId);
      expect(store.approvalConsumers(approval.effectId)).toEqual([]);
    }
    db.prepare(
      "UPDATE arc_run_effects SET request_json = ? WHERE effect_id = ?",
    ).run(originalRequest, worker.effectId);
    const other = graphRunDefinitionFixture();
    other.policy.autonomy = "autonomous";
    const otherRun = store.reserve(compileArcGraphRun(other));
    db.prepare("UPDATE arc_run_effects SET run_id = ? WHERE effect_id = ?").run(
      otherRun.summary.runId,
      worker.effectId,
    );
    expect(store.approvalConsumers(approval.effectId)).toEqual([]);
  });
});

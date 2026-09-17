import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  ownedStepObservationV2Schema,
  ownedStepFailureSchema,
  type OwnedDependencyReceipt,
  type OwnedStepObservationV2,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  viewOwnedRun,
  controlOwnedRun,
} from "../../workflows/src/owned-data.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { migrations } from "../data.js";
import type {
  HostEffectRequest,
  HostWorkspaceState,
} from "../host-contract.js";
import type { TeamDefinition } from "../teams/contract.js";
import { teamEdge } from "../teams/testing.js";
import { runtimeNodeKey } from "./compiler.js";
import { controlMigrations } from "./control-data.js";
import {
  createGraphControlDriver,
  graphReceiptWorkspace,
} from "./control-driver.js";
import {
  createArcRunStore,
  runtimeMigrations,
  type ArcRunEffect,
  type ArcRunStore,
} from "./data.js";
import { collaborationMigrations } from "./collaboration-data.js";
import {
  registerCollaborationTools,
  responseQuestion,
  boundedHandoff,
  appendDependencyHandoff,
} from "./collaboration-service.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import type {
  GraphControlOperation,
  GraphRuntimeNode,
} from "./graph-contract.js";
import {
  graphControlReceiptSchema,
  graphRuntimeReceiptSchema,
  type GraphRuntimeReceipt,
} from "./graph-receipt.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { runtimeHash } from "./hash.js";
import type { RuntimeReceipt } from "./receipt.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});
const ref = (nodeId: string, iteration = 0): OwnedStepRef => ({
  nodeId,
  iteration,
});

function repairTeam(team: TeamDefinition) {
  const review = team.graph.nodes.find((node) => node.kind === "review");
  if (review?.kind !== "review") throw new Error("Review fixture is missing");
  review.candidate = { kind: "node", nodeId: "repair" };
  team.graph.nodes.push({
    id: "repair",
    label: "Repair",
    kind: "repair",
    checkNodeId: "check",
    maxRounds: 3,
    body: {
      memberId: "builder",
      task: "Repair the implementation while preserving the check.",
    },
  });
  team.graph.edges = [
    teamEdge("write", "check"),
    teamEdge("check", "repair", "failed"),
    teamEdge("repair", "review", "succeeded", "repaired"),
  ];
  team.graph.requiredGates = [
    { id: "verified", mode: "all", nodeIds: ["repair", "review"] },
  ];
}

function delegationTeam(team: TeamDefinition) {
  for (const id of ["alice", "bob"]) {
    team.members.push({ ...team.members[0], id });
    team.permissions.push({
      id: `delegate-${id}`,
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
  team.graph.nodes = team.graph.nodes.filter((node) => node.id !== "write");
  team.graph.nodes.push({
    id: "write",
    label: "Delegate",
    kind: "delegation",
    requesterMemberId: "builder",
    candidateMemberIds: ["alice", "bob"],
    maxChildCalls: 3,
    access: "write",
    candidate: { kind: "source" },
    task: "Assign the declared bounded work.",
  });
}

interface Options {
  autonomy?: "guided" | "autonomous";
  failedChecks?: number;
  exitCode?: number | null;
  interruptedCheck?: boolean;
  missingReview?: boolean;
  rejectedReview?: boolean;
  decision?: "approved" | "rejected";
  assignments?: Array<{ memberId: string }> | null;
  mismatchCheck?: boolean;
  extraCandidateCheck?: boolean;
  ambiguousSlot?: boolean;
  maxAgentCalls?: number;
  onAgent?(
    item: ReturnType<ArcRunStore["fromContext"]>,
    store: ArcRunStore,
    db: Database.Database,
  ): Promise<void>;
}

function setup(update?: (team: TeamDefinition) => void, options: Options = {}) {
  const definition = graphRunDefinitionFixture(update);
  definition.policy.autonomy = options.autonomy ?? "autonomous";
  if (options.maxAgentCalls !== undefined)
    definition.policy.limits.maxAgentCalls = options.maxAgentCalls;
  const compiled = compileArcGraphRun(definition);
  let extra: OwnedStepRef | null = null;
  if (options.extraCandidateCheck) {
    const original = [...compiled.workflow.steps].reverse().find((step) => {
      const node = compiled.nodes[runtimeNodeKey(step)];
      return (
        node.kind === "control" && node.operation.type === "candidate-choice"
      );
    });
    const checked = compiled.references.outputs.check.outcome;
    if (!original) throw new Error("Candidate-choice fixture is missing");
    const node = compiled.nodes[runtimeNodeKey(original)];
    if (node.kind !== "control" || node.operation.type !== "candidate-choice")
      throw new Error("Candidate-choice fixture is invalid");
    extra = ref("driver-candidate-proof");
    const added: GraphRuntimeNode = {
      kind: "control",
      operation: {
        ...node.operation,
        branches: node.operation.branches.map((branch) => ({
          ...branch,
          check: checked,
        })),
      },
    };
    compiled.nodes[runtimeNodeKey(extra)] = added;
    compiled.workflow.steps.push({
      ...original,
      ...extra,
      definitionHash: runtimeHash(added),
      requirements: [
        ...original.requirements,
        { kind: "receipt", step: checked, outcomes: ["succeeded"] },
      ],
    });
    compiled.workflow.planHash = runtimeHash({
      source: compiled.workflow.source,
      nodes: compiled.nodes,
      steps: compiled.workflow.steps,
    });
  }
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...controlMigrations,
      ...collaborationMigrations,
      ...workflowMigrations,
    ].join(";\n"),
  );
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const run = createOwnedRun(db, "arc", compiled.workflow);
  const claimed = claimOwnedRun(db, 4);
  if (!claimed) throw new Error("Run was not claimed");
  const generation = claimed.row.dispatch_generation;
  const source: HostWorkspaceState = {
    path: definition.source.path,
    topLevel: definition.source.path,
    gitDir: definition.source.commonGitDir,
    commonGitDir: definition.source.commonGitDir,
    head: definition.source.head,
    currentBranch: "main",
    clean: true,
    stateDigest: definition.source.stateHash,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
  };
  const effects: ArcRunEffect[] = [];
  const waits: Array<{
    effect: ArcRunEffect;
    operation: GraphControlOperation;
  }> = [];
  function dependency(
    effect: ArcRunEffect,
    identity: OwnedStepRef,
  ): GraphRuntimeReceipt {
    const proof = effect.request.dependencyReceipts.find(
      (item) => runtimeNodeKey(item) === runtimeNodeKey(identity),
    );
    if (!proof) throw new Error("Missing admitted dependency proof");
    const observed = store.effect(proof.effectId).observation;
    if (
      !observed ||
      !("receipt" in observed) ||
      observed.state !== proof.outcome ||
      observed.receiptHash !== proof.receiptHash
    )
      throw new Error("Retained dependency proof changed");
    return graphRuntimeReceiptSchema.parse(observed.receipt);
  }
  const workspace = (effect: ArcRunEffect, identity: OwnedStepRef) =>
    graphReceiptWorkspace(dependency(effect, identity));
  const driver = createGraphControlDriver({
    store,
    dependency,
    async validity() {
      return { state: "current", identityHash: compiled.workflow.planHash };
    },
  });
  let checks = 0;
  function native(
    effect: ArcRunEffect,
    node: Exclude<GraphRuntimeNode, { kind: "control" }>,
  ): OwnedStepObservationV2 {
    const key = runtimeNodeKey(effect.request);
    const before =
      node.kind === "prepare-worktree"
        ? source
        : workspace(
            effect,
            node.kind === "commit"
              ? node.worker
              : node.kind === "verify"
                ? node.workspace
                : node.candidate,
          );
    let after = before;
    if (node.kind === "prepare-worktree" || node.kind === "fork-worktree") {
      const path = `C:/control-driver/${node.workspaceKey}`;
      after = {
        ...before,
        path,
        topLevel: path,
        gitDir: `${source.commonGitDir}/worktrees/${node.workspaceKey}`,
        currentBranch: null,
      };
    } else if (node.kind === "commit")
      after = {
        ...before,
        head: runtimeHash(key).slice(0, 40),
        clean: true,
        stateDigest: runtimeHash(key),
      };
    let state: "succeeded" | "failed" = "succeeded";
    let receipt: RuntimeReceipt;
    if (node.kind === "agent") {
      if (node.access === "write")
        after = { ...before, clean: false, stateDigest: runtimeHash(key) };
      if (node.purpose === "delegation" && options.assignments !== null)
        store.controls.proposeDelegation(
          effect.effectId,
          options.assignments ?? [{ memberId: "bob" }, { memberId: "alice" }],
        );
      const review =
        node.purpose === "review" && !options.missingReview
          ? {
              candidateHead: before.head,
              outcome: options.rejectedReview
                ? ("changes-requested" as const)
                : ("approved" as const),
              summary: "Fixture reviewer verdict",
              findings: [],
            }
          : null;
      if (node.purpose === "review" && review?.outcome !== "approved")
        state = "failed";
      receipt = {
        kind: "agent",
        threadId: `thread-${effect.effectId}`,
        executionContextId: effect.executionContextId,
        turnRequestId: `request-${effect.effectId}`,
        terminalEventId: `terminal-${effect.effectId}`,
        terminalStatus: "completed",
        workspace: after,
        review,
        definitionHash: effect.request.definitionHash,
      };
    } else {
      const exitCode =
        node.kind === "check"
          ? options.exitCode !== undefined
            ? options.exitCode
            : checks++ < (options.failedChecks ?? 0)
              ? 1
              : 0
          : 0;
      if (node.kind === "check" && exitCode !== 0) state = "failed";
      if (node.kind === "check" && options.mismatchCheck)
        after = { ...before, stateDigest: "f".repeat(64) };
      const operation: HostEffectRequest["operation"] =
        node.kind === "prepare-worktree" || node.kind === "fork-worktree"
          ? { type: node.kind, workspaceId: node.workspaceKey }
          : node.kind === "commit"
            ? { type: "commit", message: node.message }
            : node.kind === "check"
              ? { type: "check", ...node.command }
              : { type: "snapshot" };
      const request: HostEffectRequest = {
        runId: effect.runId,
        effectId: effect.effectId,
        lane: effect.request.lane,
        workspace: {
          path: before.path,
          commonGitDir: before.commonGitDir,
          originalPath: source.path,
          expectedHead: before.head,
          expectedStateDigest: before.stateDigest,
        },
        operation,
      };
      store.sealNative(effect.effectId, request);
      receipt = {
        kind: "native",
        request,
        receipt: {
          outcome: state,
          reason: state === "failed" ? "Fixture command failed" : null,
          before,
          after,
          source: node.kind === "fork-worktree" ? before : null,
          processes:
            node.kind === "check"
              ? [
                  {
                    executable: node.command.executable,
                    args: node.command.args,
                    exitCode,
                    signal: null,
                    stdout: "",
                    stderr: "",
                    stdoutBytes: 0,
                    stderrBytes: 0,
                    stdoutDigest: runtimeHash(""),
                    stderrDigest: runtimeHash(""),
                    truncated: false,
                    interrupted: options.interruptedCheck ?? false,
                    startedAt: "2026-09-10T10:00:00Z",
                    finishedAt: "2026-09-10T10:00:01Z",
                  },
                ]
              : [],
          artifact: {
            workspacePath: after.path,
            commitSha: after.head,
            treeSha: "c".repeat(40),
          },
          finishedAt: "2026-09-10T10:00:01Z",
        },
      };
    }
    return ownedStepObservationV2Schema.parse({
      state,
      resource:
        node.kind === "agent"
          ? {
              kind: "agent",
              threadId: `thread-${effect.effectId}`,
              executionContextId: effect.executionContextId,
              environmentId: `environment-${effect.effectId}`,
              turnRequestId: `request-${effect.effectId}`,
            }
          : {
              kind: "host-effect",
              hostId: definition.request.hostId,
              effectId: effect.effectId,
            },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: compiled.workflow.planHash },
    });
  }
  async function step(nodeId: string, iteration: number) {
    const attempt = admitOwnedStep(
      db,
      run.workflowRunId,
      ref(nodeId, iteration),
      null,
      generation,
    );
    if (!attempt) throw new Error("The control fixture step was not admitted");
    const effect = store.reserveEffect(attempt.request);
    const node = compiled.nodes[runtimeNodeKey(effect.request)];
    if (node.kind === "agent" && options.onAgent) {
      const threadId = `thread-${effect.effectId}`;
      store.sealWorker(effect.effectId, {
        workspace: workspace(effect, node.workspace),
        prompt: node.task,
      });
      store.bindThread(effect.effectId, threadId);
      await options.onAgent(
        store.fromContext(
          effect.executionContextId,
          definition.request.projectId,
          threadId,
        ),
        store,
        db,
      );
    }
    let observed =
      node.kind === "control"
        ? await driver.drive(
            effect,
            node.operation,
            new AbortController().signal,
          )
        : native(effect, node);
    if (observed.state === "waiting" && node.kind === "control") {
      waits.push({ effect, operation: node.operation });
      store.recordObservation(effect.effectId, observed);
      recordOwnedObservation(db, effect.effectId, generation, observed);
      const control = store.controls.get(effect.runId, effect.effectId);
      store.controls.resolve({
        runId: effect.runId,
        controlId: control.controlId,
        operationId: `resolve-${effect.effectId}`,
        expectedRevision: control.revision,
        contextHash: control.contextHash,
        decision:
          node.operation.type === "delegation" ||
          (node.operation.type === "approval" &&
            node.operation.message === "Explicit decision")
            ? (options.decision ?? "approved")
            : "approved",
      });
      observed = await driver.drive(
        effect,
        node.operation,
        new AbortController().signal,
      );
    }
    if (
      options.ambiguousSlot &&
      node.kind === "control" &&
      node.operation.type === "delegation-slot" &&
      observed.state === "succeeded"
    ) {
      const receipt = graphControlReceiptSchema.parse(observed.receipt);
      receipt.selectedOutputs = ["skip", "member:bob"];
      observed = { ...observed, receipt, receiptHash: runtimeHash(receipt) };
    }
    store.recordObservation(effect.effectId, observed);
    recordOwnedObservation(db, effect.effectId, generation, observed);
    effects.push(store.effect(effect.effectId));
    if (!("receipt" in observed))
      throw new Error("Fixture control did not settle");
    if (observed.state === "failed")
      throw Object.assign(new Error("Recorded driver failure"), {
        stepFailure: ownedStepFailureSchema.parse({
          workflowRunId: effect.request.workflowRunId,
          ownerRunId: effect.request.ownerRunId,
          nodeId: effect.request.nodeId,
          iteration: effect.request.iteration,
          attempt: effect.request.attempt,
          effectId: effect.effectId,
          requestHash: effect.request.requestHash,
          state: observed.state,
          receipt: observed.receipt,
          receiptHash: observed.receiptHash,
        }),
      });
    return observed.receipt;
  }
  const result = executeWorkflowScript({
    args: compiled.workflow.args,
    body: parseWorkflowSource(compiled.workflow.source).body,
    capabilities: {
      step,
      async agent() {
        throw new Error("No unadmitted agent dispatch");
      },
      log() {},
      phase() {},
    },
  });
  const controls = (type: GraphControlOperation["type"]) =>
    effects.filter((effect) => {
      const node = compiled.nodes[runtimeNodeKey(effect.request)];
      return node.kind === "control" && node.operation.type === type;
    });
  const controlReceipt = (effect: ArcRunEffect) => {
    const observed = store.effect(effect.effectId).observation;
    if (!observed || !("receipt" in observed))
      throw new Error("Missing control receipt");
    return graphControlReceiptSchema.parse(observed.receipt);
  };
  const proof = (effect: ArcRunEffect): OwnedDependencyReceipt => {
    const observed = store.effect(effect.effectId).observation;
    if (
      !observed ||
      (observed.state !== "succeeded" && observed.state !== "failed")
    )
      throw new Error("Missing settled receipt");
    return {
      nodeId: effect.request.nodeId,
      iteration: effect.request.iteration,
      effectId: effect.effectId,
      outcome: observed.state,
      receiptHash: observed.receiptHash,
    };
  };
  return {
    db,
    store,
    compiled,
    result,
    driver,
    effects,
    waits,
    controls,
    controlReceipt,
    proof,
    extra,
    step,
  };
}

function conditionTeam(
  kind: "check-exit" | "approval" | "review-verdict",
  compare = 0,
) {
  return (team: TeamDefinition) => {
    if (kind === "approval")
      team.graph.nodes.push({
        id: "approval",
        label: "Approval",
        kind: "approval",
        approver: "user",
        message: "Explicit decision",
        candidate: null,
      });
    const source =
      kind === "approval"
        ? "approval"
        : kind === "review-verdict"
          ? "review"
          : "check";
    team.graph.nodes.push({
      id: "condition",
      label: "Condition",
      kind: "condition",
      predicate:
        kind === "check-exit"
          ? { kind, sourceNodeId: source, operator: "eq", value: compare }
          : { kind, sourceNodeId: source, equals: "rejected" },
    });
    if (kind === "approval")
      team.graph.edges.push(teamEdge("write", "approval"));
    team.graph.edges.push(teamEdge(source, "condition", "completed"));
    for (const output of ["true", "false"] as const) {
      team.graph.nodes.push({
        id: `condition-${output}`,
        label: `Observe ${output}`,
        kind: "agent",
        memberId: "builder",
        task: `Observe the ${output} condition outcome without changing files.`,
        access: "read",
        candidate: { kind: "source" },
      });
      team.graph.edges.push(
        teamEdge("condition", `condition-${output}`, "succeeded", output),
      );
    }
  };
}

describe("persisted graph control driver", () => {
  it.each([0, 1])(
    "derives check-exit selection from the actual retained process exit for comparison %s",
    async (compare) => {
      const state = setup(conditionTeam("check-exit", compare));
      await expect(state.result).resolves.toBeDefined();
      const effect = state.controls("condition")[0];
      expect(state.controlReceipt(effect)).toMatchObject({
        selectedOutputs: [String(compare === 0)],
        data: { decision: { kind: "condition", value: compare === 0 } },
      });
      const checked = state.effects.find(
        (item) =>
          state.compiled.nodes[runtimeNodeKey(item.request)].kind === "check",
      );
      if (!checked) throw new Error("Missing native check");
      expect(() =>
        state.driver.checkReceipt(effect, {
          ...state.proof(checked),
          receiptHash: "f".repeat(64),
        }),
      ).toThrow("receipt_conflict");
    },
  );

  it.each(["missing-exit", "interrupted"] as const)(
    "rejects %s native check evidence before choosing a branch",
    async (reason) => {
      const state = setup(
        conditionTeam("check-exit"),
        reason === "missing-exit"
          ? { exitCode: null }
          : { interruptedCheck: true },
      );
      await expect(state.result).rejects.toThrow("confirmed exit code");
      expect(state.controls("condition")).toEqual([]);
    },
  );

  it.each(["approved", "rejected"] as const)(
    "derives approval conditions from a persisted %s user decision",
    async (decision) => {
      const state = setup(conditionTeam("approval"), { decision });
      await expect(state.result).resolves.toBeDefined();
      const effect = state.controls("condition")[0];
      expect(state.controlReceipt(effect).selectedOutputs).toEqual([
        String(decision === "rejected"),
      ]);
      expect(state.waits).toHaveLength(1);
      const stored = state.store.controls.get(
        effect.runId,
        state.waits[0].effect.effectId,
      );
      expect(stored).toMatchObject({
        state: "resolved",
        revision: 2,
        decision,
      });
    },
  );

  it.each([false, true])(
    "uses the reviewer verdict instead of provider completion when rejection is %s",
    async (rejectedReview) => {
      const state = setup(conditionTeam("review-verdict"), { rejectedReview });
      if (rejectedReview)
        await expect(state.result).rejects.toThrow(
          "Required gate did not succeed",
        );
      else await expect(state.result).resolves.toBeDefined();
      expect(
        state.controlReceipt(state.controls("condition")[0]).selectedOutputs,
      ).toEqual([String(rejectedReview)]);
    },
  );

  it("refuses review-condition evaluation without an actual actor verdict", async () => {
    const state = setup(conditionTeam("review-verdict"), {
      missingReview: true,
    });
    await expect(state.result).rejects.toThrow("actual reviewer verdict");
    expect(state.controls("condition")).toEqual([]);
  });

  it.each([1, 2, 4])(
    "forwards native repair receipts and exact candidate state after %s failed checks",
    async (failedChecks) => {
      const state = setup(repairTeam, { failedChecks });
      if (failedChecks === 4)
        await expect(state.result).rejects.toThrow(
          "Required gate did not succeed",
        );
      else await expect(state.result).resolves.toBeDefined();
      const results = state.controls("repair-result");
      expect(results).toHaveLength(Math.min(failedChecks, 3));
      const outer = results.at(-1);
      if (!outer) throw new Error("Missing repair result");
      const receipt = state.controlReceipt(outer);
      expect(receipt.selectedOutputs).toEqual([
        failedChecks === 4 ? "exhausted" : "repaired",
      ]);
      if (!receipt.data.check) throw new Error("Missing forwarded check");
      const native = state.driver.checkReceipt(outer, state.proof(outer));
      expect(native.proof).toEqual(receipt.data.check);
      expect(native.proof.outcome).toBe(
        failedChecks === 4 ? "failed" : "succeeded",
      );
      expect(receipt.data.workspace).toEqual(native.receipt.receipt.after);
      expect(native.receipt.request.operation).toMatchObject({
        type: "check",
        executable: "node",
        args: ["--test"],
      });
      for (const result of results)
        expect(state.controlReceipt(result).data).toEqual(receipt.data);
    },
  );

  it("rejects a repaired candidate whose successful check observed different files", async () => {
    const state = setup(repairTeam, { failedChecks: 1, mismatchCheck: true });
    await expect(state.result).rejects.toThrow(
      "repaired candidate does not match",
    );
    expect(state.controls("repair-result")).toEqual([]);
  });

  it("retains ordered assignments, skips unused slots and waits for Guided approval", async () => {
    const state = setup(delegationTeam, { autonomy: "guided" });
    await expect(state.result).resolves.toBeDefined();
    const decision = state.controls("delegation")[0];
    expect(state.controlReceipt(decision)).toMatchObject({
      revision: 2,
      selectedOutputs: ["next"],
      data: {
        decision: {
          kind: "delegation",
          assignments: [
            { slot: 0, memberId: "bob" },
            { slot: 1, memberId: "alice" },
          ],
        },
      },
    });
    expect(
      state
        .controls("delegation-slot")
        .map((effect) => state.controlReceipt(effect).selectedOutputs),
    ).toEqual([["member:bob"], ["member:alice"], ["skip"]]);
    const pending = state.waits.find(
      (item) => item.operation.type === "delegation",
    );
    if (!pending) throw new Error("Assignment approval was not requested");
    expect(
      state.store.controls.get(decision.runId, pending.effect.effectId).context
        .proposedAssignments,
    ).toEqual([{ memberId: "bob" }, { memberId: "alice" }]);
  });

  it("stops rejected Guided delegation before slots or child agents are admitted", async () => {
    const state = setup(delegationTeam, {
      autonomy: "guided",
      decision: "rejected",
    });
    await expect(state.result).rejects.toThrow("Required gate did not succeed");
    expect(
      state.controlReceipt(state.controls("delegation")[0]).selectedOutputs,
    ).toEqual(["rejected"]);
    expect(state.controls("delegation-slot")).toEqual([]);
    expect(
      state.effects.filter(
        (effect) =>
          state.compiled.nodes[runtimeNodeKey(effect.request)].kind === "agent",
      ),
    ).toHaveLength(1);
  });

  it.each([
    null,
    [{ memberId: "outside" }],
    Array.from({ length: 4 }, () => ({ memberId: "alice" })),
  ])(
    "rejects absent, undeclared or excessive persisted assignments %j",
    async (assignments) => {
      const state = setup(delegationTeam, { assignments });
      await expect(state.result).rejects.toThrow(
        "valid bounded assignment proposal",
      );
      expect(state.controls("delegation-slot")).toEqual([]);
    },
  );

  it("rejects candidate selection when a decision chooses more than one candidate", async () => {
    const state = setup(delegationTeam, { ambiguousSlot: true });
    await expect(state.result).rejects.toThrow(
      "exactly one selected candidate",
    );
    expect(state.controls("candidate-choice")).toEqual([]);
  });

  it.each([false, true])(
    "validates the selected candidate's forwarded native check when mismatch is %s",
    async (mismatchCheck) => {
      const state = setup(delegationTeam, {
        extraCandidateCheck: true,
        mismatchCheck,
      });
      await expect(state.result).resolves.toBeDefined();
      if (!state.extra)
        throw new Error("Missing admitted candidate check control");
      const result = state.step(state.extra.nodeId, state.extra.iteration);
      if (mismatchCheck)
        await expect(result).rejects.toThrow(
          "Selected check and candidate do not match",
        );
      else {
        const receipt = graphControlReceiptSchema.parse(await result);
        expect(receipt.data.check?.outcome).toBe("succeeded");
        expect(receipt.selectedOutputs).toEqual(["next"]);
      }
    },
  );
});

function messageTeam(
  team: TeamDefinition,
  reciprocal = true,
  includeLeadStage = false,
) {
  team.schemaVersion = 2;
  team.members.push({ ...team.members[0]!, id: "lead" });
  team.permissions.push({
    id: "ask-lead",
    action: "message",
    fromMemberId: "builder",
    toMemberId: "lead",
  });
  if (reciprocal)
    team.permissions.push({
      id: "reply-builder",
      action: "message",
      fromMemberId: "lead",
      toMemberId: "builder",
    });
  if (includeLeadStage) {
    team.graph.nodes.push({
      id: "lead-read",
      label: "Read independently",
      kind: "agent",
      memberId: "lead",
      access: "read",
      task: "Read source",
      candidate: { kind: "source" },
    });
    team.graph.entryNodeIds.push("lead-read");
    team.graph.edges.push(teamEdge("lead-read", "check"));
  }
}

function toolsFor(
  item: ReturnType<ArcRunStore["fromContext"]>,
  store: ArcRunStore,
  db: Database.Database,
  duringStateRead?: () => Promise<void>,
) {
  const host = createFakePluginHost({ pluginId: "arc" });
  hosts.push(host);
  registerCollaborationTools(
    host.bb,
    store,
    async (threadId, projectId) =>
      store.fromContext(item.effect.executionContextId, projectId, threadId),
    async (current) => {
      if (
        current.effect.observation !== null &&
        "receipt" in current.effect.observation
      )
        throw new Error("worker_closed");
      const run = viewOwnedRun(db, current.run.summary.workflowRunId!);
      if (
        run.desiredControl !== "run" ||
        !["running", "queued"].includes(run.state)
      )
        throw new Error("run_paused");
      await duringStateRead?.();
    },
  );
  return {
    host,
    call: (
      name: string,
      input: unknown,
      projectId = item.run.summary.projectId,
    ) =>
      host.harness.callAgentTool(name, input, {
        threadId: item.effect.threadId!,
        projectId,
      }),
  };
}

describe("collaboration through admitted workflow steps", () => {
  it("hands source-pinned reader findings to the dependent builder within the prompt budget", async () => {
    let inspected = false;
    const state = setup(
      (team) => {
        team.members.push({ ...team.members[0], id: "reader" });
        team.graph.nodes.push({
          id: "read",
          kind: "agent",
          label: "Read source",
          memberId: "reader",
          access: "read",
          task: "Inspect relevant source",
          candidate: { kind: "source" },
        });
        team.graph.edges.push(teamEdge("read", "write"));
        team.graph.entryNodeIds = ["read"];
      },
      {
        async onAgent(item, store, db) {
          const tools = toolsFor(item, store, db);
          if ("memberId" in item.node && item.node.memberId === "reader") {
            await tools.call("arc_run_report", {
              operationId: "reader-report",
              findings: "The pricing route multiplies by unit price.",
              files: [{ path: "src/pricing.ts", detail: "lines 4-12" }],
              coverage: "Pricing route and caller.",
              omissions: "No external provider inspected.",
              questions: [],
            });
            expect(boundedHandoff(store, item.effect.effectId).reports).toEqual(
              [],
            );
          }
          if (item.node.purpose === "writer") {
            const handoff = boundedHandoff(store, item.effect.effectId);
            expect(handoff.reports).toHaveLength(1);
            expect(handoff.reports[0]).toMatchObject({
              memberId: "reader",
              source: { kind: "git", head: "a".repeat(40) },
              report: {
                files: [{ path: "src/pricing.ts", detail: "lines 4-12" }],
              },
            });
            expect(handoff.omitted).toBe(0);
            const prompt = appendDependencyHandoff(
              store,
              item.effect.effectId,
              "Task ".repeat(13_000),
            );
            expect(prompt.length).toBeLessThanOrEqual(65_536);
            expect(prompt).toContain('"omitted":1');
            inspected = true;
          }
        },
      },
    );
    await expect(state.result).resolves.toBeDefined();
    expect(inspected).toBe(true);
  });

  it("enforces directional messaging and scope while information never schedules a response", async () => {
    const state = setup((team) => messageTeam(team, false, true), {
      async onAgent(item, store, db) {
        if (!("memberId" in item.node)) throw new Error("Missing member");
        const tools = toolsFor(item, store, db);
        const input = {
          operationId: "notice",
          kind: "information",
          toMemberId: item.node.memberId === "builder" ? "lead" : "builder",
          text: "See retained findings",
          replyTo: null,
        };
        if (item.node.memberId === "lead")
          await expect(tools.call("arc_run_message", input)).rejects.toThrow(
            "message_denied",
          );
        else if (item.node.purpose === "writer") {
          await tools.call("arc_run_message", input);
          await expect(
            tools.call("arc_run_message", {
              ...input,
              kind: "question",
              operationId: "question",
            }),
          ).rejects.toThrow("reply_permission_missing");
          await expect(
            tools.call("arc_run_message", { ...input, toMemberId: "outsider" }),
          ).rejects.toThrow("recipient_denied");
          await expect(
            tools.call("arc_run_message", input, "another-project"),
          ).rejects.toThrow("scope_denied");
          await expect(
            tools.call("arc_run_message", { ...input, runId: "another-run" }),
          ).rejects.toThrow();
        }
      },
    });
    await expect(state.result).resolves.toBeDefined();
    expect(state.controls("message-response")).toHaveLength(0);
    expect(
      state.store.collaboration.inbox(
        state.compiled.definition.runId,
        "lead",
        0,
      ),
    ).toHaveLength(1);
  });

  it("durably selects one question per response and binds replies to that question across reopen", async () => {
    const answered: string[] = [];
    const state = setup(messageTeam, {
      async onAgent(item, store, db) {
        const tools = toolsFor(item, store, db);
        if (item.node.purpose === "writer") {
          for (let index = 0; index < 3; index++)
            await tools.call("arc_run_message", {
              operationId: `question-${index}`,
              kind: "question",
              toMemberId: "lead",
              text: `Clarify requirement ${index}`,
              replyTo: null,
            });
        }
        if ("replyDecision" in item.node && item.node.replyDecision) {
          const question = responseQuestion(
            store,
            item.effect,
            item.node.replyDecision,
          )!;
          const other = store.collaboration
            .inbox(item.run.summary.runId, "lead", 0)
            .find((message) => message.id !== question.id)!;
          await expect(
            tools.call("arc_run_message", {
              operationId: "wrong-answer",
              kind: "reply",
              toMemberId: "builder",
              text: "Wrong question",
              replyTo: other.id,
            }),
          ).rejects.toThrow("reply_not_admitted");
          await tools.call("arc_run_message", {
            operationId: "answer",
            kind: "reply",
            toMemberId: "builder",
            text: "Use the existing requirement",
            replyTo: question.id,
          });
          answered.push(question.id);
        }
      },
    });
    await expect(state.result).resolves.toBeDefined();
    expect(answered).toHaveLength(3);
    expect(new Set(answered).size).toBe(3);
    const reopened = createArcRunStore(state.db);
    const selected = state
      .controls("message-response")
      .filter(
        (effect) => state.controlReceipt(effect).selectedOutputs[0] !== "skip",
      );
    expect(selected).toHaveLength(3);
    for (const effect of selected) {
      const decision = state.controlReceipt(effect).data.decision;
      if (decision.kind !== "message-response")
        throw new Error("Unexpected decision");
      expect(
        reopened.collaboration.selectQuestion(effect.runId, effect.effectId, [
          "lead",
        ])?.id,
      ).toBe(decision.messageId);
    }
    expect(state.compiled.workflow.limits).toEqual(
      state.compiled.definition.policy.limits,
    );
  });

  it("charges response workers to the same agent-call limit and never starts an extra response outside admission", async () => {
    const dispatched: string[] = [];
    const state = setup(messageTeam, {
      maxAgentCalls: 2,
      async onAgent(item, store, db) {
        dispatched.push(item.effect.effectId);
        const tools = toolsFor(item, store, db);
        if (item.node.purpose === "writer") {
          for (let index = 0; index < 3; index++)
            await tools.call("arc_run_message", {
              operationId: `question-${index}`,
              kind: "question",
              toMemberId: "lead",
              text: `Question ${index}`,
              replyTo: null,
            });
        } else if ("replyDecision" in item.node && item.node.replyDecision) {
          const question = responseQuestion(
            store,
            item.effect,
            item.node.replyDecision,
          )!;
          await tools.call("arc_run_message", {
            operationId: "answer",
            kind: "reply",
            toMemberId: "builder",
            text: "Bounded answer",
            replyTo: question.id,
          });
        }
      },
    });
    await expect(state.result).rejects.toThrow();
    expect(dispatched).toHaveLength(2);
    expect(
      state.store.collaboration.inbox(
        state.compiled.definition.runId,
        "builder",
        0,
      ),
    ).toHaveLength(1);
    expect(
      state.effects.some((effect) => {
        const node = state.compiled.nodes[runtimeNodeKey(effect.request)];
        return node.kind === "agent" && node.purpose === "review";
      }),
    ).toBe(false);
  });

  it.each(["arc_run_message", "arc_run_report"])(
    "refuses %s when its worker closes during the scheduler state read",
    async (tool) => {
      const state = setup((team) => messageTeam(team, false), {
        async onAgent(item, store, db) {
          if (item.node.purpose !== "writer") return;
          const tools = toolsFor(item, store, db, async () => {
            await Promise.resolve();
            const receipt = {
              kind: "preparation",
              operationId: item.effect.effectId,
              threadId: item.effect.threadId!,
              revision: 1,
              state: "cancelled",
              reason: "User stopped the worker",
            };
            store.recordObservation(item.effect.effectId, {
              state: "interrupted",
              resource: null,
              receipt,
              receiptHash: runtimeHash(receipt),
              validity: {
                state: "current",
                identityHash: item.effect.request.definitionHash,
              },
            });
          });
          await expect(
            tools.call(
              tool,
              tool === "arc_run_message"
                ? {
                    operationId: "late-notice",
                    kind: "information",
                    toMemberId: "lead",
                    text: "Late message",
                    replyTo: null,
                  }
                : {
                    operationId: "late-report",
                    findings: "Late finding",
                    files: [],
                    coverage: "One file",
                    omissions: "Other files",
                    questions: [],
                  },
            ),
          ).rejects.toThrow("worker_closed");
          throw new Error("Stopped fixture");
        },
      });
      await expect(state.result).rejects.toThrow("Stopped fixture");
      expect(
        state.store.collaboration.inbox(
          state.compiled.definition.runId,
          "lead",
          0,
        ),
      ).toEqual([]);
      expect(
        state.store.collaboration.reports(
          state.compiled.definition.runId,
          null,
        ),
      ).toEqual([]);
    },
  );

  it("refuses new messages after the shared run is paused", async () => {
    const state = setup((team) => messageTeam(team, false), {
      async onAgent(item, store, db) {
        if (item.node.purpose !== "writer") return;
        const tools = toolsFor(item, store, db);
        controlOwnedRun(db, "arc", {
          workflowRunId: item.run.summary.workflowRunId!,
          operationId: "pause-dialogue-test",
          expectedVersion: viewOwnedRun(db, item.run.summary.workflowRunId!)
            .controlVersion,
          action: "pause",
        });
        await expect(
          tools.call("arc_run_message", {
            operationId: "late-notice",
            kind: "information",
            toMemberId: "lead",
            text: "Late message",
            replyTo: null,
          }),
        ).rejects.toThrow("run_paused");
        throw new Error("Paused fixture");
      },
    });
    await expect(state.result).rejects.toThrow("Paused fixture");
    expect(
      state.store.collaboration.inbox(
        state.compiled.definition.runId,
        "lead",
        0,
      ),
    ).toEqual([]);
  });
});

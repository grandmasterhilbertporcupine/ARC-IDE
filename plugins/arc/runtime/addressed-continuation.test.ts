import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";
import {
  finishOwnedRun,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import {
  reserveOwnedContinuation,
  startOwnedAddressedContinuation,
  inspectOwnedContinuation,
  cancelOwnedContinuation,
} from "../../workflows/src/owned-continuation-data.js";
import { createAgentStore } from "../data.js";
import { createPolicyStore, policyMigrations } from "../policy/data.js";
import { createPolicyService } from "../policy/service.js";
import { createTeamStore, teamMigrations } from "../teams/data.js";
import { arcHostContract, type HostWorkspaceState } from "../host-contract.js";
import {
  createOrchestratedTestRun,
  orchestratedDefinitionFixture,
} from "./orchestrated-testing.js";
import { addressedContinuationMigrations } from "./addressed-continuation-data.js";
import { createAddressedContinuationService } from "./addressed-continuation.js";
import { runtimeReceiptSchema } from "./receipt.js";
import { runtimeHash } from "./hash.js";
import { runtimeNodeKey } from "./compiler.js";

const runs: ReturnType<typeof createOrchestratedTestRun>[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const run of runs.splice(0)) run.db.close();
});

function fixture() {
  const definition = orchestratedDefinitionFixture();
  definition.request.expectedProjectPolicyVersion = 1;
  definition.request.addressedRecipients = [
    {
      kind: "team",
      entityId: definition.team.teamId,
      versionId: 1,
      scopeKey: `project:${definition.request.projectId}`,
    },
  ];
  const run = createOrchestratedTestRun(definition);
  runs.push(run);
  run.db.exec(
    [
      ...addressedContinuationMigrations,
      ...policyMigrations,
      ...teamMigrations,
    ].join(";\n"),
  );
  const agents = createAgentStore(run.db);
  const policies = createPolicyStore(run.db);
  policies.saveProject({
    projectId: definition.request.projectId,
    expectedVersion: 0,
    policy: definition.policy,
  });
  const source = definition.source;
  const workspace = (path: string): HostWorkspaceState => ({
    path,
    topLevel: path,
    gitDir: `${path}/.git`,
    commonGitDir: source.commonGitDir,
    head: path === source.path ? source.head : "d".repeat(40),
    currentBranch: path === source.path ? source.branch : null,
    clean: true,
    trackedDigest: source.stateHash,
    untrackedDigest: source.stateHash,
    contentDigest: source.stateHash,
    stateDigest: source.stateHash,
  });
  const candidate = workspace("C:/verified-addressed-candidate");
  let changedSource = false;
  let loseReply = false;
  let starts = 0;
  let failReservation = false;
  let failStart = false;
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: definition.request.projectId,
          kind: "standard",
          sources: [{ hostId: definition.request.hostId, path: source.path }],
        }),
      },
      threads: {
        get: () => ({
          id: definition.request.originThreadId,
          projectId: definition.request.projectId,
          parentThreadId: null,
          experimental_executionContextId: null,
          archivedAt: null,
          providerId: definition.completion.execution.providerId,
          environmentId: definition.completion.environment.environmentId,
        }),
      },
      environments: {
        get: () => ({
          id: definition.completion.environment.environmentId,
          projectId: definition.request.projectId,
          hostId: definition.request.hostId,
          status: "ready",
          path: definition.completion.environment.path,
        }),
      },
    },
    async experimental_callHostRpc(call) {
      if (call.method === "inspectProjectSource")
        return { kind: "git", path: source.path };
      if (call.method === "inspectWorkspace") {
        const input = arcHostContract.inspectWorkspace.input.parse(call.input);
        return {
          ...workspace(input.path),
          ...(changedSource ? { stateDigest: "f".repeat(64) } : {}),
        };
      }
      throw new Error(`Unexpected host method ${call.method}`);
    },
    async experimental_internalRpc(call) {
      if (call.pluginId !== "workflows")
        throw new Error("Unexpected workflow owner");
      if (call.method === "inspectOwnedRun")
        return {
          run: viewOwnedRun(
            run.db,
            ownedWorkflowRpcContract.inspectOwnedRun.input.parse(call.input)
              .workflowRunId,
          ),
        };
      if (call.method === "inspectOwnedContinuation")
        return {
          continuation: inspectOwnedContinuation(
            run.db,
            "arc",
            ownedWorkflowRpcContract.inspectOwnedContinuation.input.parse(
              call.input,
            ),
          ),
        };
      if (call.method === "cancelOwnedContinuation")
        return {
          continuation: cancelOwnedContinuation(
            run.db,
            "arc",
            ownedWorkflowRpcContract.cancelOwnedContinuation.input.parse(
              call.input,
            ),
          ),
        };
      if (call.method === "reserveOwnedContinuation") {
        if (failReservation)
          throw new Error("Workflow control version changed");
        return {
          continuation: reserveOwnedContinuation(
            run.db,
            "arc",
            ownedWorkflowRpcContract.reserveOwnedContinuation.input.parse(
              call.input,
            ),
          ),
        };
      }
      if (call.method === "startOwnedAddressedContinuation") {
        if (failStart)
          throw new Error("Workflow start rejected before admission");
        starts++;
        const result = {
          continuation: startOwnedAddressedContinuation(
            run.db,
            "arc",
            ownedWorkflowRpcContract.startOwnedAddressedContinuation.input.parse(
              call.input,
            ),
          ),
        };
        if (loseReply) {
          loseReply = false;
          throw new Error("Lost acknowledged continuation reply");
        }
        return result;
      }
      throw new Error(`Unexpected workflow method ${call.method}`);
    },
  });
  hosts.push(host);
  const policy = createPolicyService(
    policies,
    createTeamStore(run.db, agents),
    {
      requireProject: async () => {},
      threadProject: async () => definition.request.projectId,
      listThreads: async () => [],
      changed() {},
    },
  );
  const createService = () =>
    createAddressedContinuationService(host.bb, run.store, agents, {
      policies,
      policy,
      teams: createTeamStore(run.db, agents),
    });
  const input = () => ({
    projectId: definition.request.projectId,
    threadId: definition.request.originThreadId,
    operationId: randomUUID(),
    goal: "Improve the existing result",
    recipients: definition.request.addressedRecipients!,
    attachments: [],
  });
  async function complete() {
    await run.execute({
      native(effect) {
        const node = run.compiled.nodes[runtimeNodeKey(effect.request)];
        const receipt = runtimeReceiptSchema.parse(
          node.kind === "agent"
            ? {
                kind: "agent",
                threadId: `thread-${effect.effectId}`,
                executionContextId: effect.executionContextId,
                turnRequestId: `request-${effect.effectId}`,
                terminalEventId: `terminal-${effect.effectId}`,
                terminalStatus: "completed",
                workspace: candidate,
                review: null,
                definitionHash: effect.request.definitionHash,
              }
            : {
                kind: "native",
                request: {
                  runId: effect.runId,
                  effectId: effect.effectId,
                  lane: null,
                  workspace: {
                    path: candidate.path,
                    commonGitDir: candidate.commonGitDir,
                    originalPath: source.path,
                    expectedHead: candidate.head,
                    expectedStateDigest: candidate.stateDigest,
                  },
                  operation:
                    node.kind === "check"
                      ? { type: "check", ...node.command }
                      : { type: "snapshot" },
                },
                receipt: {
                  outcome: "succeeded",
                  reason: null,
                  before: candidate,
                  after: candidate,
                  source: null,
                  processes: [],
                  artifact: {
                    workspacePath: candidate.path,
                    commitSha: candidate.head,
                    treeSha: "e".repeat(40),
                  },
                  finishedAt: new Date().toISOString(),
                },
              },
        );
        return {
          state: "succeeded",
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
          validity: {
            state: "current",
            identityHash: effect.request.definitionHash,
          },
        };
      },
    });
    expect(
      finishOwnedRun(run.db, run.workflow.workflowRunId, run.generation, null),
    ).toBe(true);
  }
  return {
    run,
    definition,
    candidate,
    input,
    createService,
    complete,
    starts: () => starts,
    changeSource: () => {
      changedSource = true;
    },
    loseReply: () => {
      loseReply = true;
    },
    failReservation: () => {
      failReservation = true;
    },
    failStart: () => {
      failStart = true;
    },
    allowStart: () => {
      failStart = false;
    },
  };
}

describe("addressed follow-up admission", () => {
  it("rechecks a sealed candidate before retrying unacknowledged admission", async () => {
    const state = fixture();
    await state.complete();
    state.failStart();
    const input = state.input();
    const service = state.createService();
    await service.continue(input, state.definition.runId);
    const saved = service.find(input.projectId, input.operationId)!;
    expect(saved.compiled).not.toBeNull();
    state.allowStart();
    state.changeSource();
    const retried = await service
      .handlers()
      .retryAddressedFollowup({ ...input, expectedUpdatedAt: saved.updatedAt });
    expect(retried.state).toBe("action-required");
    expect(retried.error).toContain("changed before admission");
    expect(state.starts()).toBe(0);
  });
  it.each(["failReservation", "failStart"] as const)(
    "cancels a sealed but unadmitted follow-up after %s",
    async (failure) => {
      const state = fixture();
      await state.complete();
      state[failure]();
      const input = state.input();
      const service = state.createService();
      await service.continue(input, state.definition.runId);
      const saved = service.find(input.projectId, input.operationId)!;
      expect(saved.compiled).not.toBeNull();
      expect(saved.state).toBe("action-required");
      const cancelled = await service.handlers().cancelAddressedFollowup({
        ...input,
        expectedUpdatedAt: saved.updatedAt,
      });
      expect(cancelled.state).toBe("cancelled");
      expect(state.starts()).toBe(0);
    },
  );
  it("resumes queued work after service restart from the verified candidate and keeps later Sends ordered", async () => {
    const state = fixture();
    const first = state.input();
    const second = state.input();
    const service = state.createService();
    expect(
      (await service.continue(first, state.definition.runId)).summary,
    ).toContain("queued");
    await service.continue(second, state.definition.runId);
    expect(state.starts()).toBe(0);
    await state.complete();
    const consumed = state.run.view();
    const restarted = state.createService();
    restarted.start();
    for (
      let attempt = 0;
      attempt < 6 &&
      restarted.find(first.projectId, first.operationId)?.state !== "applied";
      attempt++
    )
      await delay(450);
    const admitted = restarted.find(first.projectId, first.operationId)!;
    expect(admitted.state, admitted.error ?? undefined).toBe("applied");
    expect(admitted.compiled?.definition.source.path).toBe(
      state.candidate.path,
    );
    expect(admitted.compiled?.definition.request.path).toBe(
      state.candidate.path,
    );
    const successor = state.run.store.get(admitted.successorRunId);
    expect(
      viewOwnedRun(state.run.db, successor.summary.workflowRunId!),
    ).toMatchObject({
      agentCalls: consumed.agentCalls,
      chargedActiveMs: consumed.chargedActiveMs,
    });
    expect(restarted.find(second.projectId, second.operationId)?.state).toBe(
      "queued",
    );
    expect(state.starts()).toBe(1);
  });

  it("reconciles a lost successor acknowledgement without admitting a fresh run", async () => {
    const state = fixture();
    await state.complete();
    state.loseReply();
    const input = state.input();
    const service = state.createService();
    expect(
      (await service.continue(input, state.definition.runId)).summary,
    ).toContain("action required");
    const saved = service.find(input.projectId, input.operationId)!;
    const restarted = state.createService();
    await restarted
      .handlers()
      .retryAddressedFollowup({ ...input, expectedUpdatedAt: saved.updatedAt });
    const reconciled = restarted.find(input.projectId, input.operationId)!;
    expect(reconciled.state, reconciled.error ?? undefined).toBe("applied");
    expect(state.starts()).toBe(1);
  });

  it("retains a stale-candidate error without creating a replacement or resetting usage", async () => {
    const state = fixture();
    await state.complete();
    state.changeSource();
    const input = state.input();
    const service = state.createService();
    const result = await service.continue(input, state.definition.runId);
    expect(result.summary).toContain("action required");
    expect(service.find(input.projectId, input.operationId)?.error).toContain(
      "changed",
    );
    expect(state.starts()).toBe(0);
    expect(
      state.run.store.findOperation(input.projectId, input.operationId),
    ).toBeNull();
  });

  it("admits changed recipients from a pinned snapshot while retaining earlier checks and cumulative usage", async () => {
    const state = fixture();
    await state.complete();
    const next = orchestratedDefinitionFixture((team) => {
      team.name = "New addressed team";
      for (const node of team.graph.nodes) {
        if (node.kind === "agent")
          node.task = "Implement the next assignment on the retained candidate";
        if (node.kind === "check") node.command.args = ["--test", "new-team"];
      }
    });
    const input = state.input();
    input.recipients = [
      {
        kind: "team",
        entityId: next.team.teamId,
        versionId: next.team.revision,
        scopeKey: `project:${input.projectId}`,
      },
    ];
    const service = state.createService();
    const result = await service.continue(input, state.definition.runId, {
      revision: next.team,
      members: next.members,
    });
    const saved = service.find(input.projectId, input.operationId)!;
    expect(result.summary, saved.error ?? undefined).toContain(
      "Continued from the verified candidate",
    );
    expect(saved.state).toBe("applied");
    expect(saved.composition?.revision.teamId).toBe(next.team.teamId);
    expect(saved.compiled?.definition.source.path).toBe(state.candidate.path);
    const successor = state.run.store.get(saved.successorRunId);
    if (successor.compiled.definition.schemaVersion !== 3)
      throw new Error("Expected orchestrated follow-up");
    expect(
      successor.compiled.definition.team.definition.graph.requiredGates.some(
        (gate) => gate.id.startsWith("prior-check"),
      ),
    ).toBe(true);
    expect(
      viewOwnedRun(state.run.db, successor.summary.workflowRunId!).agentCalls,
    ).toBe(state.run.view().agentCalls);
    next.team.definition.name = "Changed after Send";
    expect(
      service.find(input.projectId, input.operationId)?.composition?.revision
        .definition.name,
    ).toBe("New addressed team");
  });
});

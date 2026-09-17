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
import {
  sealCompositionAuthorization,
  validateCompositionAuthorization,
} from "./composition-authorization.js";
import type { OrchestratedRunDefinition } from "./orchestrated-contract.js";
import type { AddressedComponent } from "./addressed-composition.js";
import { teamTarget } from "../teams/testing.js";

const runs: ReturnType<typeof createOrchestratedTestRun>[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const run of runs.splice(0)) run.db.close();
});

function authorize(definition: OrchestratedRunDefinition): AddressedComponent {
  return {
    revision: definition.team,
    members: definition.members,
    compositionAuthorization: sealCompositionAuthorization(
      definition.request.projectId,
      { team: definition.team, members: definition.members },
      [
        {
          kind: "team",
          scope: { kind: "project", projectId: definition.request.projectId },
          entityId: definition.team.teamId,
          revision: definition.team.revision,
          contentHash: definition.team.contentHash,
        },
      ],
    ),
  };
}

function fixture(
  options: {
    restricted?: boolean;
    next?: OrchestratedRunDefinition;
    legacy?: boolean;
  } = {},
) {
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
  const run = createOrchestratedTestRun(definition, (db) => {
    db.exec(
      [
        ...addressedContinuationMigrations,
        ...policyMigrations,
        ...teamMigrations,
      ].join(";\n"),
    );
    if (!options.restricted) return;
    const agents = createAgentStore(db);
    const teams = createTeamStore(db, agents);
    const scope = {
      kind: "project" as const,
      projectId: definition.request.projectId,
    };
    for (const selected of [
      definition,
      ...(options.next ? [options.next] : []),
    ]) {
      for (const member of selected.team.definition.members) {
        const snapshot = selected.members[member.id]!;
        const created = agents.createAgent({
          scope,
          document: snapshot.definition.document,
        });
        const published = agents.publish({
          scope,
          agentId: created.id,
          expectedDraftVersion: created.draft.version,
        });
        snapshot.definition = agents.getRevision({
          scope,
          agentId: published.id,
          revision: 1,
        });
        member.agentId = published.id;
        member.revision = 1;
      }
      const created = teams.createTeam({
        scope,
        definition: selected.team.definition,
      });
      const published = teams.publish(teamTarget(created));
      selected.team = teams.getRevision({
        scope,
        teamId: published.id,
        revision: 1,
      });
      selected.request.team = { teamId: published.id, revision: 1 };
    }
    definition.request.addressedRecipients = [
      {
        kind: "team",
        entityId: definition.team.teamId,
        versionId: 1,
        scopeKey: `project:${definition.request.projectId}`,
      },
    ];
    definition.policy.restrictedTeams = [
      definition.request.team,
      ...(options.next ? [options.next.request.team] : []),
    ];
    if (!options.legacy)
      definition.compositionAuthorization =
        authorize(definition).compositionAuthorization;
  });
  runs.push(run);
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
  it.each([false, true])(
    "resumes queued work after service restart from the verified candidate and keeps later Sends ordered (restricted %s)",
    async (restricted) => {
      const state = fixture({ restricted });
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
      if (successor.compiled.definition.schemaVersion !== 3)
        throw new Error("Expected orchestrated follow-up");
      expect(successor.compiled.definition.compositionAuthorization).toEqual(
        state.definition.compositionAuthorization,
      );
      expect(successor.compiled.definition.policy).toEqual(
        state.definition.policy,
      );
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
    },
  );

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

  it.each([false, true])(
    "admits changed recipients from a pinned snapshot while retaining earlier checks and cumulative usage (restricted %s)",
    async (restricted) => {
      const next = orchestratedDefinitionFixture((team) => {
        team.name = "New addressed team";
        for (const node of team.graph.nodes) {
          if (node.kind === "agent")
            node.task =
              "Implement the next assignment on the retained candidate";
          if (node.kind === "check") node.command.args = ["--test", "new-team"];
        }
      });
      const state = fixture({ restricted, next });
      await state.complete();
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
      const composition = restricted
        ? authorize(next)
        : { revision: next.team, members: next.members };
      const result = await service.continue(
        input,
        state.definition.runId,
        composition,
      );
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
      expect(successor.compiled.definition.policy).toEqual(
        state.definition.policy,
      );
      if (restricted) {
        const definition = successor.compiled.definition;
        const authorization = definition.compositionAuthorization!;
        expect(
          authorization.origins.map((origin) => origin.entityId).sort(),
        ).toEqual([state.definition.team.teamId, next.team.teamId].sort());
        expect(authorization.bindingHash).not.toBe(
          composition.compositionAuthorization?.bindingHash,
        );
        expect(() =>
          validateCompositionAuthorization(
            input.projectId,
            { team: definition.team, members: definition.members },
            authorization,
          ),
        ).not.toThrow();
      }
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
    },
  );

  it.each(["project", "member", "origin"] as const)(
    "blocks a tampered queued %s snapshot after restart before admitting a provider",
    async (change) => {
      const state = fixture({ restricted: true });
      await state.complete();
      state.failStart();
      const input = state.input();
      const service = state.createService();
      await service.continue(input, state.definition.runId);
      const saved = service.find(input.projectId, input.operationId)!;
      const compiled = saved.compiled!;
      if (compiled.definition.schemaVersion !== 3)
        throw new Error("Expected orchestrated follow-up");
      if (change === "project")
        compiled.definition.compositionAuthorization!.projectId =
          "different-project";
      if (change === "member")
        compiled.definition.members.builder.execution.model = "different-model";
      if (change === "origin")
        compiled.definition.compositionAuthorization!.origins[0]!.contentHash =
          "f".repeat(64);
      state.run.db
        .prepare(
          "UPDATE arc_addressed_continuations SET compiled_json = ? WHERE project_id = ? AND operation_id = ?",
        )
        .run(JSON.stringify(compiled), input.projectId, input.operationId);
      state.allowStart();
      const restarted = state.createService();
      const retried = await restarted.handlers().retryAddressedFollowup({
        ...input,
        expectedUpdatedAt: saved.updatedAt,
      });
      expect(retried.state).toBe("action-required");
      expect(retried.error).toContain("does not match this project");
      expect(state.starts()).toBe(0);
    },
  );

  it("rejects a changed recipient outside the retained allowlist without losing the earlier result", async () => {
    const state = fixture({ restricted: true });
    await state.complete();
    const next = orchestratedDefinitionFixture();
    const input = state.input();
    input.recipients = [
      {
        kind: "team",
        entityId: next.team.teamId,
        versionId: next.team.revision,
        scopeKey: `project:${input.projectId}`,
      },
    ];
    const before = state.run.store.get(state.definition.runId);
    const service = state.createService();
    await service.continue(input, state.definition.runId, authorize(next));
    const saved = service.find(input.projectId, input.operationId)!;
    expect(saved.state).toBe("action-required");
    expect(saved.error).toContain("outside the resolved session restriction");
    expect(state.run.store.get(state.definition.runId)).toEqual(before);
    expect(state.starts()).toBe(0);
  });

  it.each([false, true])(
    "does not manufacture origin authority for a legacy predecessor when recipients change (restricted %s)",
    async (restricted) => {
      const next = orchestratedDefinitionFixture((team) => {
        team.name = "New recipient for legacy work";
        const check = team.graph.nodes.find((node) => node.kind === "check");
        if (!check || check.kind !== "check")
          throw new Error("Expected required check");
        check.command.args = ["--test", "legacy-followup"];
      });
      const state = fixture({ restricted, next, legacy: true });
      await state.complete();
      const before = state.run.store.get(state.definition.runId);
      expect(before.compiled.definition).not.toHaveProperty(
        "compositionAuthorization",
      );
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
      await service.continue(input, state.definition.runId, authorize(next));
      const saved = service.find(input.projectId, input.operationId)!;
      if (restricted) {
        expect(state.definition.policy.restrictedTeams).toEqual([
          state.definition.request.team,
          next.request.team,
        ]);
        expect(saved.state).toBe("action-required");
        expect(saved.error).toContain(
          "requires resolved origin records for both compositions",
        );
        expect(saved.compiled).toBeNull();
        expect(state.starts()).toBe(0);
      } else {
        expect(saved.state, saved.error ?? undefined).toBe("applied");
        expect(saved.compiled!.definition).not.toHaveProperty(
          "compositionAuthorization",
        );
        expect(state.starts()).toBe(1);
      }
      expect(state.run.store.get(state.definition.runId)).toEqual(before);
    },
  );

  it("keeps an allowed legacy team's unchanged recipients without inventing authorization", async () => {
    const state = fixture({ restricted: true, legacy: true });
    await state.complete();
    const input = state.input();
    const service = state.createService();
    await service.continue(input, state.definition.runId);
    const saved = service.find(input.projectId, input.operationId)!;
    expect(saved.state, saved.error ?? undefined).toBe("applied");
    expect(saved.compiled!.definition).not.toHaveProperty(
      "compositionAuthorization",
    );
    expect(saved.compiled!.definition.policy).toEqual(state.definition.policy);
    expect(state.starts()).toBe(1);
  });
});

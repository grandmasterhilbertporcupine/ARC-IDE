import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOrchestratorService } from "../orchestrator/service.js";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  ownedWorkflowRpcContract,
  type OwnedRunStartInput,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { terminalReceipt } from "../../workflows/src/owned-test-fixtures.js";
import type { AgentScope } from "../contract.js";
import { createAgentStore, migrations } from "../data.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { HostWorkspaceState } from "../host-contract.js";
import {
  defaultRunPolicy,
  defaultSessionOverrides,
} from "../policy/contract.js";
import { teamDefinitionFixture, teamTarget } from "../teams/testing.js";
import { runtimeNodeKey } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import type { GraphRunRequest } from "./graph-contract.js";
import { createArcRunService } from "./service.js";
import { runtimeHash } from "./hash.js";
import { graphServicesFixture, runDefinitionFixture } from "./testing.js";
import { directoryValidationMigrations } from "./directory-validation.js";
import type { DirectoryRunRequest } from "./directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function setup(
  options: {
    scope?: AgentScope;
    execution?: "parent" | "project" | "missing";
    delegation?: boolean;
    inspectGate?: Promise<void>;
    onInspect?: () => void;
    onCompletion?: () => void;
    onSubmission?: () => void;
    directory?: boolean;
  } = {},
) {
  const source = runDefinitionFixture();
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [...migrations, ...runtimeMigrations, ...workflowMigrations].join(";\n"),
  );
  const agents = createAgentStore(db);
  const scope = options.scope ?? {
    kind: "project",
    projectId: source.request.projectId,
  };
  const metadata = defaultAgentMetadata("Pinned graph builder");
  if (options.execution === "project")
    metadata.execution.permissionMode = "full";
  let agent = agents.createAgent({
    scope,
    document: serializeAgentDocument(
      metadata,
      "Implement the sealed task using the exact project context.",
    ),
  });
  agent = agents.publish({
    scope,
    agentId: agent.id,
    expectedDraftVersion: agent.draft.version,
  });
  const parentExecution = {
    model: "parent-model",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "accept-edits",
  } as const;
  const projectExecution = {
    ...parentExecution,
    providerId: "codex",
    model: "project-model",
    reasoningLevel: "medium",
  } as const;
  const workspace: HostWorkspaceState = {
    path: source.source.path,
    topLevel: source.source.path,
    gitDir: `${source.source.path}/.git`,
    commonGitDir: source.source.commonGitDir,
    head: source.source.head,
    currentBranch: "main",
    clean: true,
    trackedDigest: "b".repeat(64),
    untrackedDigest: "b".repeat(64),
    contentDigest: "b".repeat(64),
    stateDigest: source.source.stateHash,
  };
  const submissions: OwnedRunStartInput[] = [];
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: source.request.projectId,
          kind: "standard",
          sources: [
            { hostId: source.request.hostId, path: source.request.path },
          ],
        }),
        defaultExecutionOptions: () =>
          options.execution === "project" ? projectExecution : null,
      },
      threads: {
        get: () => ({
          id: source.request.originThreadId,
          projectId: source.request.projectId,
          providerId: "claude-code",
          originPluginId: "sdk-owner",
          environmentId: "environment-main",
          parentThreadId: null,
          archivedAt: null,
          experimental_executionContextId: null,
        }),
        defaultExecutionOptions: () =>
          options.execution === "missing"
            ? null
            : { ...parentExecution, source: "client/turn/requested" },
      },
      environments: {
        get: () => {
          options.onCompletion?.();
          return {
            id: "environment-main",
            projectId: source.request.projectId,
            hostId: source.request.hostId,
            path: `${source.request.path}/main-worktree`,
            status: "ready",
          };
        },
      },
    },
    async experimental_callHostRpc(call) {
      if (options.directory && call.method === "inspectProjectSource") {
        options.onInspect?.();
        await options.inspectGate;
        return { kind: "directory", path: workspace.path };
      }
      if (call.method !== "inspectWorkspace")
        throw new Error("Run authoring must not execute a native effect");
      options.onInspect?.();
      await options.inspectGate;
      return workspace;
    },
    experimental_internalRpc: async ({ pluginId, method, input }) => {
      if (pluginId !== "workflows") throw new Error("Unexpected plugin");
      if (method === "startOwnedRun") {
        const parsed =
          ownedWorkflowRpcContract.startOwnedRun.input.parse(input);
        submissions.push(parsed);
        const run = createOwnedRun(db, "arc", parsed);
        options.onSubmission?.();
        return { run };
      }
      if (method === "inspectOwnedRun") {
        const parsed =
          ownedWorkflowRpcContract.inspectOwnedRun.input.parse(input);
        return { run: viewOwnedRun(db, parsed.workflowRunId) };
      }
      throw new Error("Unexpected run control during authoring");
    },
  });
  hosts.push(host);
  const graph = graphServicesFixture(db, agents, host.bb);
  const definition = teamDefinitionFixture(agent.id);
  if (options.delegation) {
    for (const memberId of ["alice", "bob"]) {
      definition.members.push({ ...definition.members[0], id: memberId });
      definition.permissions.push({
        id: `delegate-${memberId}`,
        action: "delegate",
        fromMemberId: "builder",
        toMemberId: memberId,
      });
      definition.permissions.push({
        id: `review-${memberId}`,
        action: "review",
        fromMemberId: "builder",
        toMemberId: memberId,
      });
    }
    definition.members.push({ ...definition.members[0], id: "observer" });
    definition.graph.nodes = definition.graph.nodes.filter(
      (node) => node.id !== "write",
    );
    definition.graph.nodes.push({
      id: "write",
      label: "Bounded work",
      kind: "delegation",
      requesterMemberId: "builder",
      candidateMemberIds: ["alice", "bob"],
      maxChildCalls: 1,
      task: "Assign the implementation to one declared member.",
      access: "write",
      candidate: { kind: "source" },
    });
    graph.policies.saveProject({
      projectId: source.request.projectId,
      expectedVersion: 0,
      policy: { ...defaultRunPolicy(), autonomy: "autonomous" },
    });
  }
  let team = graph.teams.createTeam({ scope, definition });
  team = graph.teams.publish(teamTarget(team));
  const request: GraphRunRequest = {
    operationId: source.request.operationId,
    projectId: source.request.projectId,
    originThreadId: source.request.originThreadId,
    hostId: source.request.hostId,
    path: source.request.path,
    expectedHead: source.request.expectedHead,
    goal: source.request.goal,
    team: { teamId: team.id, revision: 1 },
    expectedProjectPolicyVersion: options.delegation ? 1 : 0,
    expectedSessionPolicyVersion: 0,
  };
  const store = createArcRunStore(db);
  const service = createArcRunService(host.bb, store, agents, graph);
  const orchestrator = createOrchestratorService(
    host.bb,
    agents,
    graph.teams,
    graph.policy,
    service,
  );
  return {
    db,
    host,
    agents,
    agent,
    graph,
    team,
    store,
    service,
    orchestrator,
    request,
    workspace,
    parentExecution,
    projectExecution,
    submissions,
  };
}

function nextTeam(state: ReturnType<typeof setup>) {
  const current = state.graph.teams.getTeam({
    teamId: state.team.id,
    scope: state.team.scope,
  });
  const saved = state.graph.teams.saveDraft({
    ...teamTarget(current),
    definition: {
      ...current.draft.definition,
      description: "A later published team revision",
    },
  });
  return state.graph.teams.publish(teamTarget(saved));
}

function expectNoAdmission(state: ReturnType<typeof setup>) {
  expect(state.store.findRequest(state.request)).toBeNull();
  expect(state.submissions).toEqual([]);
  expect(
    state.db.prepare("SELECT count(*) AS total FROM workflow_owned_runs").get(),
  ).toEqual({ total: 0 });
}

function nativeRequest(state: ReturnType<typeof setup>) {
  const {
    operationId: _operationId,
    projectId,
    originThreadId,
    ...input
  } = state.request;
  return {
    input,
    ctx: {
      projectId,
      threadId: originThreadId,
      signal: new AbortController().signal,
      experimental_invocation: {
        providerThreadId: "provider-main",
        turnId: "native-turn-a",
        callId: "native-call-a",
        ownedTurn: null,
      },
    },
  };
}

function directoryRequest(
  state: ReturnType<typeof setup>,
): DirectoryRunRequest {
  state.db.exec(directoryValidationMigrations.join(";\n"));
  const setup = state.store.directories.reserveSetup({
    operationId: "source-inspection",
    projectId: state.request.projectId,
    originThreadId: state.request.originThreadId,
    hostId: state.request.hostId,
    path: state.request.path,
    originEnvironment: {
      hostId: state.request.hostId,
      environmentId: "environment-main",
      path: `${state.request.path}/main-worktree`,
    },
    providerId: "claude-code",
  });
  const operation = setup.job.operation;
  if (operation.type !== "scan-directory")
    throw new Error("Expected source scan");
  const source = {
    kind: "directory" as const,
    path: state.request.path,
    rootIdentity: { deviceId: "7", fileId: "11" },
    manifestDigest: "b".repeat(64),
    entryCount: 4,
    fileBytes: 1024,
  };
  state.store.directories.recordSetupInspection({
    projectId: state.request.projectId,
    operationId: setup.intent.operationId,
    record: {
      kind: "directory",
      runId: setup.job.runId,
      effectId: setup.job.effectId,
      requestHash: directoryEffectRequestHash(setup.job),
      state: "terminal",
      startedAt: "2026-09-10T13:00:00.000Z",
      finishedAt: "2026-09-10T13:00:01.000Z",
      receipt: {
        kind: "directory",
        operationType: "scan-directory",
        outcome: "succeeded",
        errorCode: null,
        reason: null,
        before: null,
        after: source,
        source: null,
        processes: [],
        finishedAt: "2026-09-10T13:00:01.000Z",
        artifact: {
          kind: "inspection",
          validationId: operation.validationId,
          consumer: operation.consumer,
          phase: operation.phase,
          state: source,
          checkedAt: "2026-09-10T13:00:01.000Z",
        },
      },
    },
  });
  const { expectedHead: _expectedHead, ...request } = state.request;
  return {
    ...request,
    sourceInspectionId: operation.validationId,
    expectedSource: {
      rootIdentity: source.rootIdentity,
      manifestDigest: source.manifestDigest,
    },
    invocation: null,
  };
}

describe("directory main-run admission", () => {
  it("deduplicates simultaneous identical admissions without consuming the inspection for a second run", async () => {
    const state = setup({ directory: true });
    const request = directoryRequest(state);
    const [first, second] = await Promise.all([
      state.service.startDirectoryRun(request),
      state.service.startDirectoryRun(request),
    ]);
    expect(first.summary.runId).toBe(second.summary.runId);
    expect(
      state.store.directories.getSetupByInspection(request)?.consumed?.runId,
    ).toBe(first.summary.runId);
    expect(
      state.db.prepare("SELECT COUNT(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 1 });
    expect(
      state.db
        .prepare("SELECT COUNT(*) AS count FROM workflow_owned_runs")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      new Set(state.submissions.map((value) => runtimeHash(value))).size,
    ).toBe(1);
  });

  it("seals V4 with an exact consumed inspection and counted response, preserving native invocation identity", async () => {
    const state = setup({ directory: true });
    const request = directoryRequest(state);
    const {
      operationId: _operationId,
      projectId: _projectId,
      originThreadId: _origin,
      invocation: _invocation,
      ...input
    } = request;
    const { ctx } = nativeRequest(state);
    const run = await state.orchestrator.requestDirectoryFromTool(input, ctx);
    expect(run.definition.schemaVersion).toBe(4);
    if (run.definition.schemaVersion !== 4)
      throw new Error("Expected directory run");
    expect(run.definition.request.invocation).toEqual({
      providerThreadId: "provider-main",
      turnId: "native-turn-a",
      callId: "native-call-a",
    });
    expect(run.definition.source).toMatchObject({
      kind: "directory",
      manifestDigest: request.expectedSource.manifestDigest,
    });
    expect(run.definition.source).not.toHaveProperty("head");
    expect(
      state.store.get(run.summary.runId).compiled.nodes[
        "arc:main-completion:0"
      ],
    ).toMatchObject({ kind: "orchestrator" });
    expect(
      state.store.directories.getSetupByInspection(request)?.consumed?.runId,
    ).toBe(run.summary.runId);
    expect(state.submissions).toHaveLength(1);
  });

  it("rejects a changed content digest without consuming the inspection or creating a workflow", async () => {
    const state = setup({ directory: true });
    const request = directoryRequest(state);
    await expect(
      state.service.startDirectoryRun({
        ...request,
        expectedSource: {
          ...request.expectedSource,
          manifestDigest: "c".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "directory_source_changed" });
    expect(
      state.store.directories.getSetupByInspection(request)?.consumed,
    ).toBeNull();
    expect(state.submissions).toEqual([]);
  });

  it("reuses the same saved run but refuses to spend its inspection on a different operation", async () => {
    const state = setup({ directory: true });
    const request = directoryRequest(state);
    const run = await state.service.startDirectoryRun(request);
    expect(
      (await state.service.reconcileOrchestratedRun(run.summary.runId)).summary
        .runId,
    ).toBe(run.summary.runId);
    await expect(
      state.service.startDirectoryRun({
        ...request,
        operationId: "different-run",
      }),
    ).rejects.toMatchObject({ code: "directory_inspection_used" });
    expect(state.submissions).toHaveLength(1);
    expect(
      state.db.prepare("SELECT COUNT(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 1 });
  });

  it("rejects an automatic completion attempting to mint a new directory budget", async () => {
    const state = setup({ directory: true });
    const request = directoryRequest(state);
    const {
      operationId: _operationId,
      projectId: _projectId,
      originThreadId: _origin,
      invocation: _invocation,
      ...input
    } = request;
    const { ctx } = nativeRequest(state);
    await expect(
      state.orchestrator.requestDirectoryFromTool(input, {
        ...ctx,
        experimental_invocation: {
          ...ctx.experimental_invocation,
          ownedTurn: {
            ownerPluginId: "arc",
            operationId: "owned-main",
            executionContextId: "owned-context",
            clientTurnRequestId: "creq_abcdefghij",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "episode_boundary" });
    expect(state.submissions).toEqual([]);
  });
});

describe("bounded main orchestrator admission", () => {
  it("does not admit a native request cancelled during source preflight", async () => {
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const state = setup({ inspectGate: held, onInspect: () => arrived() });
    const { input, ctx } = nativeRequest(state);
    const controller = new AbortController();
    const pending = state.orchestrator.requestFromTool(input, {
      ...ctx,
      signal: controller.signal,
    });
    await entered;
    controller.abort(new Error("Main request cancelled"));
    release();
    await expect(pending).rejects.toThrow("Main request cancelled");
    expectNoAdmission(state);
  });

  it("reconciles an uncertain native admission from its saved run without inventing another request", async () => {
    let loseReply = true;
    const state = setup({
      onSubmission: () => {
        if (loseReply) {
          loseReply = false;
          throw new Error("Lost workflow start response");
        }
      },
    });
    const { input, ctx } = nativeRequest(state);
    await expect(
      state.orchestrator.requestFromTool(input, ctx),
    ).rejects.toMatchObject({ code: "run_submission_uncertain" });
    const page = await state.service
      .handlers()
      .listRuns({ projectId: state.request.projectId, limit: 10, offset: 0 });
    expect(page.runs).toHaveLength(1);
    const runId = page.runs[0].runId;
    const result = await state.orchestrator
      .handlers()
      .reconcileOrchestratedRun({ runId });
    expect(result.summary).toMatchObject({ runId, submission: "submitted" });
    expect(result.workflow).toMatchObject({ agentCalls: 0, state: "queued" });
    expect(
      state.db
        .prepare("SELECT count(*) AS total FROM workflow_owned_runs")
        .get(),
    ).toEqual({ total: 1 });
    expect(state.submissions).toHaveLength(2);
    expect(state.submissions[1]).toEqual(state.submissions[0]);
    const actor = {
      kind: "agent",
      threadId: ctx.threadId,
      projectId: ctx.projectId,
    } as const;
    await expect(
      state.orchestrator.call("reconcileOrchestratedRun", { runId }, actor),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(
      await state.orchestrator.handlers().reconcileOrchestratedRun({ runId }),
    ).toEqual(result);
  });

  it("seals the main provider separately from project worker defaults and preserves old user starts", async () => {
    const state = setup({ execution: "project" });
    const run = await state.orchestrator
      .handlers()
      .requestTeamRun(state.request);
    expect(run.definition).toMatchObject({
      schemaVersion: 3,
      request: { ...state.request, invocation: null },
      completion: {
        threadId: state.request.originThreadId,
        environment: {
          environmentId: "environment-main",
          hostId: state.request.hostId,
          path: `${state.request.path}/main-worktree`,
        },
        execution: { ...state.parentExecution, providerId: "claude-code" },
      },
      members: {
        builder: {
          execution: { ...state.projectExecution, permissionMode: "full" },
        },
      },
    });
    expect(run.workflow).toMatchObject({
      state: "queued",
      agentCalls: 0,
      limits: defaultRunPolicy().limits,
    });
    const legacy = await state.service
      .handlers()
      .startTeamRun({ ...state.request, operationId: "legacy-manual-request" });
    expect(legacy.definition.schemaVersion).toBe(2);
    await expect(
      state.service.handlers().startTeamRun(state.request),
    ).rejects.toMatchObject({ code: "run_conflict" });
    expect(
      await state.orchestrator.handlers().requestTeamRun(state.request),
    ).toEqual(run);
    expect(state.submissions).toHaveLength(2);
  });

  it("binds native admission to actual project, conversation and tool identity with replay protection", async () => {
    const state = setup();
    const { input, ctx } = nativeRequest(state);
    const run = await state.orchestrator.requestFromTool(input, ctx);
    expect(run.definition).toMatchObject({
      schemaVersion: 3,
      request: {
        ...input,
        projectId: ctx.projectId,
        originThreadId: ctx.threadId,
        invocation: {
          providerThreadId: "provider-main",
          turnId: "native-turn-a",
          callId: "native-call-a",
        },
      },
    });
    expect(run.definition.request.operationId).toMatch(/^main_[a-f0-9]{64}$/u);
    expect(await state.orchestrator.requestFromTool(input, ctx)).toEqual(run);
    expect(state.submissions).toHaveLength(1);
    await expect(
      state.orchestrator.requestFromTool(
        { ...input, goal: "Changed goal" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "run_conflict" });
    await expect(
      state.orchestrator.requestFromTool(
        { ...input, operationId: "forged", projectId: "foreign-project" },
        ctx,
      ),
    ).rejects.toThrow();
    expect(state.submissions).toHaveLength(1);
  });

  it.each(["arc", "another-plugin"])(
    "refuses fresh limits from an automatic turn owned by %s",
    async (ownerPluginId) => {
      const state = setup();
      const { input, ctx } = nativeRequest(state);
      await expect(
        state.orchestrator.requestFromTool(input, {
          ...ctx,
          experimental_invocation: {
            ...ctx.experimental_invocation,
            ownedTurn: {
              ownerPluginId,
              operationId: "effect-owned",
              executionContextId: "run-execution_owned",
              clientTurnRequestId: "creq_abcdefghij",
            },
          },
        }),
      ).rejects.toMatchObject({ code: "episode_boundary" });
      expectNoAdmission(state);
      expect(state.host.harness.sdk.callsTo("projects.get")).toEqual([]);
    },
  );

  it("refuses non-native mutation and agent CLI/RPC impersonation before admission", async () => {
    const state = setup();
    const { input, ctx } = nativeRequest(state);
    await expect(
      state.orchestrator.requestFromTool(input, {
        ...ctx,
        experimental_invocation: null,
      }),
    ).rejects.toMatchObject({ code: "invocation_required" });
    const actor = {
      kind: "agent",
      threadId: ctx.threadId,
      projectId: ctx.projectId,
    } as const;
    await expect(
      state.orchestrator.call("requestTeamRun", state.request, actor),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      state.orchestrator.call(
        "discardOrchestratedRunRequest",
        state.request,
        actor,
      ),
    ).rejects.toMatchObject({ code: "approval_required" });
    expectNoAdmission(state);
  });

  it.each([
    { parentThreadId: "parent-main" },
    { experimental_executionContextId: "team-execution_assistant" },
    { archivedAt: 100 },
    { projectId: "foreign-project" },
  ])("rejects an ineligible native origin %j", async (patch) => {
    const state = setup();
    state.host.harness.sdk.stub("threads.get", () => ({
      id: state.request.originThreadId,
      projectId: state.request.projectId,
      providerId: "codex",
      ...patch,
    }));
    const { input, ctx } = nativeRequest(state);
    await expect(
      state.orchestrator.requestFromTool(input, ctx),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expectNoAdmission(state);
  });

  it("rechecks policy after asynchronous main-environment resolution", async () => {
    const state = setup({
      onCompletion: () =>
        state.graph.policies.saveProject({
          projectId: state.request.projectId,
          expectedVersion: 0,
          policy: { ...defaultRunPolicy(), restrictedTeams: [] },
        }),
    });
    await expect(
      state.orchestrator.handlers().requestTeamRun(state.request),
    ).rejects.toMatchObject({ code: "policy_conflict" });
    expectNoAdmission(state);
  });

  it("refuses an unavailable main tuple before allocating work", async () => {
    const state = setup();
    state.host.harness.sdk.stub("environments.get", () => ({
      id: "environment-main",
      projectId: state.request.projectId,
      hostId: state.request.hostId,
      path: state.request.path,
      status: "provisioning",
    }));
    await expect(
      state.orchestrator.handlers().requestTeamRun(state.request),
    ).rejects.toMatchObject({ code: "completion_environment_changed" });
    expectNoAdmission(state);
  });

  it("retires a pending user request before its late main-environment reservation", async () => {
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const state = setup();
    state.host.harness.sdk.stub("environments.get", async () => {
      arrived();
      await held;
      return {
        id: "environment-main",
        projectId: state.request.projectId,
        hostId: state.request.hostId,
        path: state.request.path,
        status: "ready",
      };
    });
    const pending = state.orchestrator.handlers().requestTeamRun(state.request);
    await entered;
    const discarded = await state.orchestrator
      .handlers()
      .discardOrchestratedRunRequest(state.request);
    expect(discarded.state).toBe("discarded");
    release();
    await expect(pending).rejects.toMatchObject({
      code: "run_request_discarded",
    });
    expectNoAdmission(state);
    expect(
      await state.orchestrator
        .handlers()
        .discardOrchestratedRunRequest(state.request),
    ).toEqual(discarded);
  });
});

describe("published graph run service", () => {
  it("durably discards an exact request while source inspection is pending without admitting or cancelling a run", async () => {
    let release = () => {};
    let entered = () => {};
    const inspectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const state = setup({ inspectGate, onInspect: entered });
    const pending = state.service.handlers().startTeamRun(state.request);
    await inspecting;
    const discarded = await state.service
      .handlers()
      .discardTeamRunRequest(state.request);
    expect(discarded).toEqual({
      state: "discarded",
      operationId: state.request.operationId,
      requestHash: runtimeHash(state.request),
    });
    expect(
      await state.service.handlers().discardTeamRunRequest(state.request),
    ).toEqual(discarded);
    expect(
      createArcRunStore(state.db).controls.discardStart(state.request),
    ).toEqual(discarded);
    release();
    await expect(pending).rejects.toMatchObject({
      code: "run_request_discarded",
    });
    await expect(
      state.service.handlers().startTeamRun(state.request),
    ).rejects.toMatchObject({ code: "run_request_discarded" });
    expectNoAdmission(state);
    expect(
      state.db
        .prepare("SELECT count(*) AS total FROM arc_discarded_run_requests")
        .get(),
    ).toEqual({ total: 1 });
    const changed = {
      ...state.request,
      goal: "Different work with the same operation identity",
    };
    await expect(
      state.service.handlers().discardTeamRunRequest(changed),
    ).rejects.toMatchObject({ code: "run_conflict" });
    await expect(
      state.service.handlers().startTeamRun(changed),
    ).rejects.toMatchObject({ code: "run_conflict" });
    expectNoAdmission(state);
  });

  it("returns the saved run when discard loses the admission race and never cancels or replaces it", async () => {
    const state = setup();
    const started = await state.service.handlers().startTeamRun(state.request);
    const retained = await state.service
      .handlers()
      .discardTeamRunRequest(state.request);
    expect(retained).toEqual({ state: "reserved", run: started });
    expect(
      await state.service.handlers().discardTeamRunRequest(state.request),
    ).toEqual(retained);
    expect(
      createArcRunStore(state.db).controls.discardStart(state.request),
    ).toEqual({ state: "reserved", runId: started.summary.runId });
    expect(state.submissions).toHaveLength(1);
    expect(
      state.db
        .prepare("SELECT count(*) AS total FROM arc_discarded_run_requests")
        .get(),
    ).toEqual({ total: 0 });
    expect(await state.service.handlers().startTeamRun(state.request)).toEqual(
      started,
    );
    await expect(
      state.service
        .handlers()
        .discardTeamRunRequest({ ...state.request, goal: "Different work" }),
    ).rejects.toMatchObject({ code: "run_conflict" });
    expect(started.workflow).toMatchObject({
      state: "queued",
      desiredControl: "run",
      controlVersion: 0,
      agentCalls: 0,
    });
  });
  it("pins the selected project revision, exact member documents, resolved policy versions and inherited tuple", async () => {
    const state = setup();
    const selected = state.graph.teams.getRevision({
      teamId: state.team.id,
      scope: state.team.scope,
      revision: 1,
    });
    const latest = nextTeam(state);
    const project = state.graph.policies.saveProject({
      projectId: state.request.projectId,
      expectedVersion: 0,
      policy: {
        ...defaultRunPolicy(),
        autonomy: "guided",
        preferredTeams: [state.request.team],
      },
    });
    const session = state.graph.policies.saveSession({
      projectId: state.request.projectId,
      threadId: state.request.originThreadId,
      expectedVersion: 0,
      overrides: {
        ...defaultSessionOverrides(),
        preferredTeams: { kind: "none" },
        limits: { ...project.policy.limits, maxAgentCalls: 9 },
      },
    });
    state.request.expectedProjectPolicyVersion = 1;
    state.request.expectedSessionPolicyVersion = 1;
    const result = await state.service.handlers().startTeamRun(state.request);
    if (result.definition.schemaVersion !== 2)
      throw new Error("Expected a graph run");
    expect(result.definition.team).toEqual(selected);
    expect(result.definition.policy).toEqual(session.effective);
    expect(result.definition.request).toEqual(state.request);
    expect(result.definition.members.builder).toEqual({
      definition: state.agents.getRevision({
        agentId: state.agent.id,
        scope: state.agent.scope,
        revision: 1,
      }),
      execution: { ...state.parentExecution, providerId: "claude-code" },
    });
    expect(
      state.graph.teams.getTeam({
        teamId: state.team.id,
        scope: state.team.scope,
      }),
    ).toEqual(latest);
    expect(result.workflow).toMatchObject({
      state: "queued",
      agentCalls: 0,
      limits: session.effective?.limits,
    });
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]).toHaveProperty("schemaVersion", 2);
  });

  it("uses project execution defaults before the parent while preserving explicit agent settings", async () => {
    const state = setup({ execution: "project" });
    const result = await state.service.handlers().startTeamRun(state.request);
    if (result.definition.schemaVersion !== 2)
      throw new Error("Expected a graph run");
    expect(result.definition.members.builder.execution).toEqual({
      ...state.projectExecution,
      permissionMode: "full",
    });
    expect(
      state.host.harness.sdk.callsTo("threads.defaultExecutionOptions"),
    ).toEqual([]);
  });

  it("reuses immutable admission after agent, team, policy and execution defaults change", async () => {
    const state = setup();
    const first = await state.service.handlers().startTeamRun(state.request);
    nextTeam(state);
    const draft = state.agents.saveDraft({
      agentId: state.agent.id,
      scope: state.agent.scope,
      expectedDraftVersion: state.agent.draft.version,
      document: serializeAgentDocument(
        defaultAgentMetadata("Changed agent"),
        "Different later instructions.",
      ),
      attachmentIds: [],
    });
    state.agents.publish({
      agentId: draft.id,
      scope: draft.scope,
      expectedDraftVersion: draft.draft.version,
    });
    state.graph.policies.saveProject({
      projectId: state.request.projectId,
      expectedVersion: 0,
      policy: {
        ...defaultRunPolicy(),
        autonomy: "autonomous",
        restrictedTeams: [],
      },
    });
    for (const method of [
      "projects.defaultExecutionOptions",
      "threads.defaultExecutionOptions",
      "projects.get",
      "threads.get",
    ] as const)
      state.host.harness.sdk.stub(method, () => {
        throw new Error("A retained run must not resolve new authority");
      });
    const repeated = await state.service.handlers().startTeamRun(state.request);
    expect(repeated).toEqual(first);
    expect(state.submissions).toHaveLength(1);
    expect(
      state.db.prepare("SELECT count(*) AS total FROM arc_runs").get(),
    ).toEqual({ total: 1 });
    await expect(
      state.service.handlers().startTeamRun({
        ...state.request,
        team: { ...state.request.team, revision: 2 },
      }),
    ).rejects.toMatchObject({ code: "run_conflict" });
  });

  it("seals team model overrides separately from reusable agents and later draft edits", async () => {
    const state = setup({ execution: "project" });
    const override = {
      providerId: "claude-code",
      model: "team-model",
      reasoningLevel: "high",
      serviceTier: "default",
    } as const;
    const definition = structuredClone(state.team.draft.definition);
    definition.members[0]!.modelOverride = override;
    const saved = state.graph.teams.saveDraft({
      ...teamTarget(state.team),
      definition,
    });
    const published = state.graph.teams.publish(teamTarget(saved));
    const request = {
      ...state.request,
      team: { teamId: published.id, revision: published.currentRevision! },
    };
    const first = await state.service.handlers().startTeamRun(request);
    if (first.definition.schemaVersion !== 2)
      throw new Error("Expected a graph run");
    expect(first.definition.members.builder.execution).toEqual({
      ...override,
      permissionMode: "full",
    });
    expect(first.definition.members.builder.definition).toEqual(
      state.agents.getRevision({
        agentId: state.agent.id,
        scope: state.agent.scope,
        revision: 1,
      }),
    );
    const edited = structuredClone(published.draft.definition);
    edited.members[0]!.modelOverride = { ...override, model: "later-model" };
    state.graph.teams.saveDraft({
      ...teamTarget(published),
      definition: edited,
    });
    expect(await state.service.handlers().startTeamRun(request)).toEqual(first);
    expect(state.submissions).toHaveLength(1);
  });

  it.each(["project", "session"] as const)(
    "rejects stale %s policy versions before either run ledger is admitted",
    async (kind) => {
      const state = setup();
      if (kind === "project")
        state.graph.policies.saveProject({
          projectId: state.request.projectId,
          expectedVersion: 0,
          policy: defaultRunPolicy(),
        });
      else
        state.graph.policies.saveSession({
          projectId: state.request.projectId,
          threadId: state.request.originThreadId,
          expectedVersion: 0,
          overrides: defaultSessionOverrides(),
        });
      await expect(
        state.service.handlers().startTeamRun(state.request),
      ).rejects.toMatchObject({ code: "policy_conflict" });
      expectNoAdmission(state);
    },
  );

  it.each(["library", "other-project"] as const)(
    "rejects a published team from %s scope",
    async (kind) => {
      const state = setup({
        scope:
          kind === "library"
            ? { kind: "library" }
            : { kind: "project", projectId: "other-project" },
      });
      await expect(
        state.service.handlers().startTeamRun(state.request),
      ).rejects.toMatchObject({ code: "team_not_found" });
      expectNoAdmission(state);
    },
  );

  it.each(["team", "agent"] as const)(
    "rejects an archived %s before admission",
    async (kind) => {
      const state = setup();
      if (kind === "team")
        state.graph.teams.setArchived({
          ...teamTarget(state.team),
          archived: true,
        });
      else
        state.agents.setArchived({
          agentId: state.agent.id,
          scope: state.agent.scope,
          expectedDraftVersion: state.agent.draft.version,
          archived: true,
        });
      await expect(
        state.service.handlers().startTeamRun(state.request),
      ).rejects.toMatchObject({ code: `${kind}_archived` });
      expectNoAdmission(state);
    },
  );

  it("enforces a restriction on the exact published version rather than only the team ID", async () => {
    const state = setup();
    nextTeam(state);
    state.graph.policies.saveProject({
      projectId: state.request.projectId,
      expectedVersion: 0,
      policy: {
        ...defaultRunPolicy(),
        restrictedTeams: [{ teamId: state.team.id, revision: 2 }],
      },
    });
    state.request.expectedProjectPolicyVersion = 1;
    await expect(
      state.service.handlers().startTeamRun(state.request),
    ).rejects.toMatchObject({ code: "team_restricted" });
    expectNoAdmission(state);
  });

  it("rejects an orchestrator from another project", async () => {
    const state = setup();
    state.host.harness.sdk.stub("threads.get", () => ({
      id: state.request.originThreadId,
      projectId: "other-project",
      providerId: "codex",
    }));
    await expect(
      state.service.handlers().startTeamRun(state.request),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expectNoAdmission(state);
  });

  it("requires resolved execution settings before persisting a graph run", async () => {
    const state = setup({ execution: "missing" });
    await expect(
      state.service.handlers().startTeamRun(state.request),
    ).rejects.toMatchObject({ code: "execution_configuration_missing" });
    expectNoAdmission(state);
  });

  it.each([
    { parentThreadId: "main-thread", experimental_executionContextId: null },
    {
      parentThreadId: null,
      experimental_executionContextId: "team-execution_assistant",
    },
    {
      parentThreadId: null,
      experimental_executionContextId: "run-execution_worker",
    },
  ])(
    "rejects a worker or authoring conversation as the graph orchestrator: %j",
    async (binding) => {
      const state = setup();
      state.host.harness.sdk.stub("threads.get", () => ({
        id: state.request.originThreadId,
        projectId: state.request.projectId,
        providerId: "codex",
        ...binding,
      }));
      await expect(
        state.service.handlers().startTeamRun(state.request),
      ).rejects.toMatchObject({ code: "scope_denied" });
      expectNoAdmission(state);
    },
  );

  it("denies agent actors both run admission and user decisions", async () => {
    const state = setup();
    const handlers = state.service.handlers({
      kind: "agent",
      projectId: state.request.projectId,
      threadId: state.request.originThreadId,
    });
    await expect(handlers.startTeamRun(state.request)).rejects.toMatchObject({
      code: "approval_required",
    });
    await expect(
      handlers.discardTeamRunRequest(state.request),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      handlers.resolveRunControl({
        runId: runDefinitionFixture().runId,
        controlId: "control-id",
        operationId: "approve",
        expectedRevision: 1,
        contextHash: "a".repeat(64),
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expectNoAdmission(state);
    expect(state.host.harness.sdk.callsTo("projects.get")).toEqual([]);
  });

  it("binds delegation proposals to the admitted requester, fixed candidates, grants and child-call bound", async () => {
    const state = setup({ delegation: true });
    const started = await state.service.handlers().startTeamRun(state.request);
    const { compiled } = state.store.get(started.summary.runId);
    if (compiled.definition.schemaVersion !== 2)
      throw new Error("Expected a graph run");
    const claimed = claimOwnedRun(state.db, 4);
    if (claimed === null) throw new Error("Run was not claimed");
    let requester: ReturnType<typeof state.store.effect> | null = null;
    for (const step of compiled.workflow.steps) {
      const attempt = admitOwnedStep(
        state.db,
        claimed.row.id,
        { nodeId: step.nodeId, iteration: step.iteration },
        null,
        claimed.row.dispatch_generation,
      );
      if (attempt === null)
        throw new Error("Delegation prerequisite was not admitted");
      const effect = state.store.reserveEffect(attempt.request);
      const node = compiled.nodes[runtimeNodeKey(step)];
      if (node.kind === "agent" && node.purpose === "delegation") {
        requester = effect;
        break;
      }
      if (step.kind === "owner-control")
        throw new Error("Unexpected owner control before autonomous requester");
      const observation = terminalReceipt(
        attempt.request,
        "succeeded",
        null,
        step.kind,
      );
      state.store.recordObservation(effect.effectId, observation);
      recordOwnedObservation(
        state.db,
        effect.effectId,
        claimed.row.dispatch_generation,
        observation,
      );
    }
    if (requester === null) throw new Error("Requester is missing");
    const effect = requester;
    const threadId = "bound-requester";
    state.store.sealWorker(effect.effectId, {
      workspace: state.workspace,
      prompt: "Choose one declared assignee.",
    });
    state.store.bindThread(effect.effectId, threadId);
    const thread = {
      id: threadId,
      projectId: state.request.projectId,
      originPluginId: "arc",
      providerId: "claude-code",
      experimental_executionContextId: effect.executionContextId,
    };
    const call = (
      assignments: Array<{ memberId: string }>,
      context = { threadId, projectId: state.request.projectId },
    ) =>
      state.host.harness.callAgentTool(
        "arc_run_delegate",
        { assignments },
        context,
      );
    state.host.harness.sdk.stub("threads.get", () => ({
      ...thread,
      originPluginId: "other-plugin",
    }));
    await expect(call([{ memberId: "alice" }])).rejects.toMatchObject({
      code: "scope_denied",
    });
    state.host.harness.sdk.stub("threads.get", () => thread);
    await expect(
      call([{ memberId: "alice" }], {
        threadId: "unbound-thread",
        projectId: state.request.projectId,
      }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await expect(
      call([{ memberId: "alice" }], { threadId, projectId: "other-project" }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    await expect(call([{ memberId: "observer" }])).rejects.toMatchObject({
      code: "delegation_denied",
    });
    await expect(
      call([{ memberId: "alice" }, { memberId: "bob" }]),
    ).rejects.toMatchObject({ code: "delegation_denied" });
    expect(state.store.controls.delegation(effect.effectId)).toBeNull();
    const raw = await call([{ memberId: "alice" }]);
    expect(JSON.parse(z.string().parse(raw))).toEqual({
      recorded: true,
      assignments: [{ memberId: "alice" }],
    });
    expect(await call([{ memberId: "alice" }])).toEqual(raw);
    await expect(call([{ memberId: "bob" }])).rejects.toMatchObject({
      code: "delegation_conflict",
    });
    expect(state.store.controls.delegation(effect.effectId)).toEqual([
      { memberId: "alice" },
    ]);
    expect(viewOwnedRun(state.db, claimed.row.id)).toMatchObject({
      agentCalls: 1,
      activeAgents: 1,
    });
    const terminal = terminalReceipt(
      effect.request,
      "succeeded",
      null,
      "agent",
    );
    state.store.recordObservation(effect.effectId, terminal);
    await expect(call([{ memberId: "alice" }])).rejects.toMatchObject({
      code: "delegation_closed",
    });
  });
});

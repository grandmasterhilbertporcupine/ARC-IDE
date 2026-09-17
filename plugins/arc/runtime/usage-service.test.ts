import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BbPluginApi,
  ExperimentalTurnPreparation,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { OwnedStepRequest } from "bb-plugin-workflows/owned-contract";
import { migrations } from "../data.js";
import { compileArcRun } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { collaborationMigrations } from "./collaboration-data.js";
import { runDefinitionFixture } from "./testing.js";
import { runtimeHash } from "./hash.js";
import {
  createOrchestratedTestRun,
  orchestratedDefinitionFixture,
} from "./orchestrated-testing.js";
import { orchestratorReceiptSchema } from "./orchestrated-receipt.js";
import {
  createArcRunUsageService,
  cumulativeWorkerUsage,
  projectRunReceipt,
} from "./usage-service.js";

type Event = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [...migrations, ...runtimeMigrations, ...collaborationMigrations].join(
      ";\n",
    ),
  );
  const store = createArcRunStore(db);
  const compiled = compileArcRun(runDefinitionFixture());
  store.reserve(compiled);
  const immutable = {
    workflowRunId: "workflow",
    ownerRunId: compiled.definition.runId,
    nodeId: "writer-0-workspace",
    iteration: 0,
    attempt: 1,
    effectId: "effect-reader",
    definitionHash: compiled.workflow.steps[0].definitionHash,
    dependencyReceipts: [],
    lane: null,
    input: null,
  };
  const request: OwnedStepRequest = {
    ...immutable,
    requestHash: runtimeHash({ owner: "arc", ...immutable }),
    dispatchGeneration: 1,
  };
  store.reserveEffect(request);
  return { store, compiled, effect: store.effect(request.effectId) };
}
function event(
  seq: number,
  input: number,
  threadId = "thread",
  turnId = "turn",
): Event {
  return {
    id: `event-${seq}`,
    seq,
    createdAt: seq,
    threadId,
    scope: { kind: "turn", turnId },
    type: "thread/tokenUsage/updated",
    data: {
      providerThreadId: "provider-thread",
      tokenUsage: {
        total: {
          inputTokens: input,
          outputTokens: 10,
          cachedInputTokens: 5,
          totalTokens: input + 10,
          reasoningOutputTokens: 0,
        },
        last: {
          inputTokens: 2,
          outputTokens: 1,
          cachedInputTokens: 0,
          totalTokens: 3,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: null,
      },
    },
  };
}
async function mainFixture(
  providerId = "codex",
  receiptContextId: string | null = null,
  completed = true,
) {
  const definition = orchestratedDefinitionFixture();
  definition.completion.execution = {
    ...definition.completion.execution,
    providerId,
  };
  const run = createOrchestratedTestRun(definition);
  databases.push(run.db);
  await expect(
    run.execute({
      main: async () => {
        throw new Error("Hold main response");
      },
    }),
  ).rejects.toThrow("Hold main response");
  const effect = run.mainEffect();
  const node =
    run.compiled.nodes[`${effect.request.nodeId}:${effect.request.iteration}`];
  if (node.kind !== "orchestrator") throw new Error("Main response missing");
  const receipt = orchestratorReceiptSchema.parse({
    kind: "orchestrator",
    operationId: effect.effectId,
    threadId: node.completion.threadId,
    executionContextId: receiptContextId ?? effect.executionContextId,
    turnRequestId: "request-main",
    providerThreadId: "provider-thread",
    turnId: "turn-main",
    acceptedEventId: "accepted-10",
    terminalEventId: "terminal-main",
    terminalStatus: "completed",
    definitionHash: effect.request.definitionHash,
  });
  if (completed)
    run.store.recordObservation(effect.effectId, {
      state: "succeeded",
      resource: {
        kind: "agent",
        threadId: node.completion.threadId,
        executionContextId: effect.executionContextId,
        environmentId: node.completion.environment.environmentId,
        turnRequestId: "request-main",
      },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: {
        state: "current",
        identityHash: effect.request.definitionHash,
      },
    });
  const offset = run.store
    .listEffectIds(run.compiled.definition.runId, 1000, 0)
    .ids.indexOf(effect.effectId);
  const input = { runId: run.compiled.definition.runId, limit: 1, offset };
  return { run, node, effect: run.mainEffect(), receipt, input };
}
function acceptedEvent(
  seq: number,
  threadId: string,
  turnId: string,
  clientRequestId: string,
): Event {
  return {
    id: `accepted-${seq}`,
    seq,
    createdAt: seq,
    threadId,
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId },
    data: { providerThreadId: "provider-thread", clientRequestId },
  };
}
function mainHost(
  f: Awaited<ReturnType<typeof mainFixture>>,
  events: Event[],
  preparation: ExperimentalTurnPreparation | null = null,
) {
  const list = vi.fn<BbPluginApi["sdk"]["threads"]["events"]["list"]>(
    async (input) =>
      events
        .filter(
          (value) =>
            value.threadId === input.threadId &&
            (!input.types || input.types.includes(value.type)) &&
            (input.afterSeq === undefined ||
              value.seq > Number(input.afterSeq)) &&
            (input.beforeSeq === undefined ||
              value.seq < Number(input.beforeSeq)),
        )
        .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
        .slice(0, Number(input.limit ?? 100)),
  );
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_preparedTurns: {
      getPreparation: async () => preparation,
      prepare: async () => {
        throw new Error("Usage must not prepare a turn");
      },
      startPrepared: async () => {
        throw new Error("Usage must not start a turn");
      },
      interrupt: async () => {
        throw new Error("Usage must not interrupt a turn");
      },
    },
    sdk: {
      projects: { get: ({ projectId }) => ({ id: projectId }) },
      threads: {
        get: ({ threadId }) => ({
          id: threadId,
          projectId: f.run.compiled.definition.request.projectId,
          experimental_executionContextId: null,
        }),
        events: { list },
      },
    },
  });
  hosts.push(host);
  return {
    list,
    host,
    service: createArcRunUsageService(host.bb, f.run.store),
  };
}
describe("truthful run usage and results", () => {
  it("projects real main completion and preparation receipts in Git and folder runs", async () => {
    const f = await mainFixture();
    for (const directory of [false, true]) {
      expect(projectRunReceipt(f.effect, directory)).toMatchObject({
        state: "succeeded",
        reason: "Main conversation response completed",
        checks: [],
        review: null,
        artifact: null,
      });
      const receipt = orchestratorReceiptSchema.parse({
        kind: "orchestrator-preparation",
        operationId: f.effect.effectId,
        threadId: f.node.completion.threadId,
        executionContextId: f.effect.executionContextId,
        revision: 2,
        state: "cancelled",
        reason: "Owner paused this response",
      });
      expect(
        projectRunReceipt(
          {
            ...f.effect,
            observation: {
              state: "interrupted",
              resource: null,
              receipt,
              receiptHash: runtimeHash(receipt),
              validity: {
                state: "current",
                identityHash: f.effect.request.definitionHash,
              },
            },
          },
          directory,
        ),
      ).toMatchObject({
        state: "interrupted",
        reason: "Owner paused this response",
      });
    }
    const { service } = mainHost(f, []);
    await expect(
      service.handlers().getRunResults(f.input),
    ).resolves.toMatchObject({
      receipts: [
        {
          effectId: f.effect.effectId,
          reason: "Main conversation response completed",
        },
      ],
    });
  });
  it("attributes main usage to its exact accepted turn and subtracts the preceding cumulative total", async () => {
    const f = await mainFixture();
    const threadId = f.node.completion.threadId;
    const latest = event(14, 160, threadId, "turn-main");
    if (latest.type !== "thread/tokenUsage/updated")
      throw new Error("Usage missing");
    latest.data.tokenUsage.total.outputTokens = 40;
    latest.data.tokenUsage.total.cachedInputTokens = 25;
    const { service, list } = mainHost(f, [
      acceptedEvent(1, threadId, "prior", "request-prior"),
      event(2, 100, threadId, "prior"),
      acceptedEvent(10, threadId, "turn-main", "request-main"),
      event(12, 120, threadId, "turn-main"),
      latest,
      acceptedEvent(20, threadId, "later", "request-later"),
      event(21, 9000, threadId, "later"),
    ]);
    await expect(
      service.handlers().getRunUsage(f.input),
    ).resolves.toMatchObject({
      workers: [
        {
          effectId: f.effect.effectId,
          threadId,
          purpose: "completion",
          role: "Team lead",
          providerId: "codex",
          inputTokens: 60,
          outputTokens: 30,
          cachedInputTokens: 20,
          reason: null,
        },
      ],
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSeq: "10",
        beforeSeq: "20",
        limit: "100",
      }),
    );
  });
  it.each(["missing-baseline", "wrong-acceptance", "counter-reset"])(
    "keeps main usage unavailable for %s",
    async (failure) => {
      const f = await mainFixture();
      const threadId = f.node.completion.threadId;
      const events = [
        acceptedEvent(1, threadId, "prior", "request-prior"),
        acceptedEvent(
          10,
          threadId,
          "turn-main",
          failure === "wrong-acceptance" ? "another-request" : "request-main",
        ),
        event(
          12,
          failure === "counter-reset" ? 20 : 160,
          threadId,
          "turn-main",
        ),
      ];
      if (failure !== "missing-baseline")
        events.push(event(2, 100, threadId, "prior"));
      const { service } = mainHost(f, events);
      const { workers } = await service.handlers().getRunUsage(f.input);
      expect(workers[0].inputTokens).toBeNull();
      expect(workers[0].reason).not.toBeNull();
    },
  );
  it("uses Claude's reported result usage without attributing prior conversation tokens", async () => {
    const f = await mainFixture("claude-code");
    const threadId = f.node.completion.threadId;
    const { service } = mainHost(f, [
      acceptedEvent(10, threadId, "turn-main", "request-main"),
      event(12, 9999, threadId, "turn-main"),
    ]);
    await expect(
      service.handlers().getRunUsage(f.input),
    ).resolves.toMatchObject({
      workers: [
        {
          providerId: "claude-code",
          inputTokens: 2,
          outputTokens: 1,
          cachedInputTokens: 0,
          reason: null,
        },
      ],
    });
  });
  it("rejects retained main receipts bound to another execution context", async () => {
    const f = await mainFixture("codex", "another-effect-context");
    const { service, list } = mainHost(f, []);
    await expect(service.handlers().getRunUsage(f.input)).rejects.toThrow(
      "scope_denied",
    );
    expect(list).not.toHaveBeenCalled();
  });
  it("attributes an active main response through the owned preparation before its receipt exists", async () => {
    const f = await mainFixture("codex", null, false);
    const threadId = f.node.completion.threadId;
    const { service } = mainHost(
      f,
      [
        acceptedEvent(1, threadId, "prior", "prior-request"),
        event(2, 100, threadId, "prior"),
        acceptedEvent(10, threadId, "turn-main", "request-main"),
        event(12, 135, threadId, "turn-main"),
      ],
      {
        operationId: f.effect.effectId,
        requestHash: f.effect.requestHash,
        threadId,
        executionContextId: f.effect.executionContextId,
        revision: 2,
        state: "started",
        environment: f.node.completion.environment,
        reason: null,
        dispatch: {
          acceptedRevision: 1,
          queuedMessageId: "queued-main",
          clientTurnRequestId: "request-main",
        },
        turn: {
          turnId: "turn-main",
          providerThreadId: "provider-thread",
          acceptedEventId: "accepted-10",
          terminalEventId: null,
          terminalStatus: null,
        },
      },
    );
    await expect(
      service.handlers().getRunUsage(f.input),
    ).resolves.toMatchObject({ workers: [{ inputTokens: 35, reason: null }] });
  });
  it("takes the latest cumulative event once and excludes other turns or threads", () => {
    expect(
      cumulativeWorkerUsage(
        [
          event(1, 20),
          event(3, 100, "other"),
          event(4, 400, "thread", "other"),
          event(2, 30),
        ],
        "thread",
        "turn",
      ),
    ).toEqual({ inputTokens: 30, outputTokens: 10, cachedInputTokens: 5 });
    expect(cumulativeWorkerUsage([event(1, 20)], "missing", "turn")).toBeNull();
  });
  it("keeps absent and invalid provider fields unavailable instead of zero", () => {
    const value = event(1, Number.NaN);
    expect(cumulativeWorkerUsage([value], "thread", "turn")).toEqual({
      inputTokens: null,
      outputTokens: 10,
      cachedInputTokens: 5,
    });
    expect(cumulativeWorkerUsage([], "thread", "turn")).toBeNull();
  });
  it("does not invent checks, review, changes or artifacts for an admitted effect", () => {
    const { effect } = fixture();
    expect(projectRunReceipt(effect, false)).toMatchObject({
      state: "admitted",
      checks: [],
      review: null,
      changes: null,
      artifact: null,
      validity: null,
    });
  });
  it("restricts whole-run evidence to the user or the exact main conversation", async () => {
    const { store, compiled } = fixture();
    const host = createFakePluginHost({
      pluginId: "arc",
      sdk: { projects: { get: ({ projectId }) => ({ id: projectId }) } },
    });
    hosts.push(host);
    const service = createArcRunUsageService(host.bb, store);
    const input = { runId: compiled.definition.runId, offset: 0, limit: 20 };
    await expect(
      service
        .handlers({
          kind: "agent",
          projectId: compiled.definition.request.projectId,
          threadId: "sibling-main",
        })
        .getRunUsage(input),
    ).rejects.toThrow("scope_denied");
    await expect(
      service
        .handlers({
          kind: "agent",
          projectId: "other-project",
          threadId: compiled.definition.request.originThreadId,
        })
        .getRunResults(input),
    ).rejects.toThrow("scope_denied");
    await expect(
      service
        .handlers({
          kind: "agent",
          projectId: compiled.definition.request.projectId,
          threadId: compiled.definition.request.originThreadId,
        })
        .getRunResults(input),
    ).resolves.toMatchObject({ effectsTotal: 1, nextOffset: null });
  });
  it("counts unanswered questions independently of receipts and clears only an actual reply", () => {
    const { store, compiled, effect } = fixture();
    const actor = {
      runId: compiled.definition.runId,
      effectId: effect.effectId,
      memberId: "reader",
    };
    const question = store.collaboration.send(actor, {
      operationId: "question",
      toMemberId: "builder",
      kind: "question",
      text: "Which route should change?",
      replyTo: null,
    });
    expect(
      store.collaboration.dialogueState(actor.runId, [
        { nodeId: "future-response", iteration: 0 },
      ]),
    ).toEqual({ unansweredQuestions: 1, remainingCheckpoints: 1 });
    expect(store.collaboration.dialogueState("other-run", [])).toEqual({
      unansweredQuestions: 0,
      remainingCheckpoints: 0,
    });
    store.collaboration.send(
      { ...actor, memberId: "builder" },
      {
        operationId: "reply",
        toMemberId: "reader",
        kind: "reply",
        text: "Use the quote route.",
        replyTo: question.id,
      },
    );
    expect(store.collaboration.dialogueState(actor.runId, [])).toEqual({
      unansweredQuestions: 0,
      remainingCheckpoints: 0,
    });
  });
  it("paginates same-timestamp reports and messages without skipping or repeating", () => {
    const { store, compiled, effect } = fixture();
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const actor = {
      runId: compiled.definition.runId,
      effectId: effect.effectId,
      memberId: "reader",
    };
    for (let index = 0; index < 4; index++) {
      store.collaboration.report(
        actor,
        { kind: "git", head: "a".repeat(40) },
        {
          operationId: `report-${index}`,
          findings: "Bounded finding",
          files: [],
          coverage: "One file",
          omissions: "Other files",
          questions: [],
        },
      );
      store.collaboration.send(actor, {
        operationId: `message-${index}`,
        toMemberId: "builder",
        kind: "information",
        text: "Bounded message",
        replyTo: null,
      });
    }
    for (const page of [
      store.collaboration.reportsPage,
      store.collaboration.messagesPage,
    ]) {
      const first = page(actor.runId, null, 2);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = page(actor.runId, first.nextCursor, 2);
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(
        new Set([...first.items, ...second.items].map((item) => item.id)).size,
      ).toBe(4);
      expect(page("another-run", null, 2).items).toEqual([]);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  assertPreparedTurnHistoryMutable,
  assertPreparedTurnHistorySuffixMutable,
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessage,
  deleteQueuedThreadMessage,
  events,
  getLatestThreadSequence,
  getThread,
  getThreadTurnPreparationByQueue,
  getThreadTurnPreparationByRequest,
  listQueuedThreadMessages,
  queuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
  threadTurnPreparations,
  updateQueuedThreadMessage,
  threads,
} from "@bb/db";
import { turnScope, type ClientTurnRequestId } from "@bb/domain";
import type { ExperimentalPrepareTurnRequest } from "@get-bb/plugin-sdk";
import {
  createPreparedTurnApi,
  type PreparedTurnStop,
} from "../../../src/services/threads/prepared-turns.js";
import {
  recordPreparedTurnDispatch,
  resolveToolInvocation,
} from "../../../src/services/threads/prepared-turn-state.js";
import { createClientTurnRequestId } from "../../../src/services/threads/thread-events.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import {
  internalAuthHeaders,
  listQueuedCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";

async function fixture(
  harness: TestAppHarness,
  stop?: PreparedTurnStop,
  sdk = false,
) {
  const root = join(harness.config.dataDir, "turn-owner");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "bb-plugin-turn-owner",
      version: "0.1.0",
      bb: {
        name: "Turn owner",
        description: "Prepared existing conversation",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(root, "server.ts"),
    `export default function plugin(bb) { bb.agents.configure(context => ({ tools: [], skills: [], instructions: "TURN_CONTEXT=" + JSON.stringify(context.experimental_turnContext) + ";ORIGIN=" + JSON.stringify(context.origin) })); }`,
  );
  await harness.pluginService.installPath(root);
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/workspace",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/workspace/main",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    threadId: thread.id,
    providerThreadId: "native-main",
  });
  const priorRequests = harness.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .all();
  const lifecycle = new AbortController();
  const api = sdk
    ? harness.pluginService.getApi("turn-owner")!.experimental_turns
    : createPreparedTurnApi(
        harness.deps,
        { pluginId: "turn-owner", signal: lifecycle.signal },
        stop,
      );
  const request: ExperimentalPrepareTurnRequest = {
    operationId: "run:main:1",
    executionContextId: "arc:main:1",
    threadId: thread.id,
    projectId: project.id,
    environment: {
      environmentId: environment.id,
      hostId: host.id,
      path: "/workspace/main",
    },
    execution: {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    },
    input: [
      {
        type: "text",
        text: "Summarize the retained team result",
        mentions: [],
      },
    ],
  };
  return {
    api,
    request,
    thread,
    environment,
    host,
    session,
    lifecycle,
    priorRequests,
  };
}

function nativeEvent(
  harness: TestAppHarness,
  threadId: string,
  requestId: ClientTurnRequestId,
  status?: "completed" | "failed" | "interrupted",
  providerThreadId = "native-main",
  turnId = "native-turn",
) {
  const sequence = getLatestThreadSequence(harness.db, { threadId }) + 1;
  if (status === undefined)
    seedEvent(harness.deps, {
      threadId,
      sequence,
      type: "turn/input/accepted",
      providerThreadId,
      scope: turnScope(turnId),
      data: { clientRequestId: requestId },
    });
  else
    seedEvent(harness.deps, {
      threadId,
      sequence,
      type: "turn/completed",
      providerThreadId,
      scope: turnScope(turnId),
      data: { status },
    });
}

async function held(harness: TestAppHarness, stop?: PreparedTurnStop) {
  const setup = await fixture(harness, stop);
  const ready = await setup.api.prepare(setup.request);
  const release = setup.api.startPrepared({
    operationId: ready.operationId,
    expectedRevision: ready.revision,
  });
  const queue = listQueuedThreadMessages(harness.db, ready.threadId)[0];
  if (!queue) throw new Error("Expected retained release queue");
  return { ...setup, ready, queue, release };
}

describe("prepared existing-thread turns", () => {
  it("sends only an exact conditional stop and awaits native terminal evidence", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      await setup.release;
      const requestId = createClientTurnRequestId();
      h.db.transaction((tx) =>
        recordPreparedTurnDispatch(tx, {
          threadId: setup.thread.id,
          queueId: setup.queue.id,
          requestId,
          input: setup.request.input,
          execution: {
            ...setup.request.execution,
            source: "client/turn/requested",
          },
        }),
      );
      nativeEvent(h, setup.thread.id, requestId);
      const accepted = await setup.api.getPreparation({
        operationId: setup.ready.operationId,
      });
      if (!accepted) throw new Error("Expected accepted operation");
      const stopping = setup.api.interrupt({
        operationId: accepted.operationId,
        expectedRevision: accepted.revision,
      });
      const command = await waitForQueuedCommand(
        h,
        ({ command }) => command.type === "turn.stop-if-current",
      );
      expect(command.command).toMatchObject({
        type: "turn.stop-if-current",
        threadId: setup.thread.id,
        environmentId: setup.environment.id,
        expectedClientRequestId: requestId,
        expectedTurnId: "native-turn",
      });
      expect(listQueuedCommands(h, "thread.stop")).toEqual([]);
      await reportQueuedCommandSuccess(h, command, {
        status: "stopped",
        clientRequestId: requestId,
        turnId: "native-turn",
        providerCheckpointId: null,
      });
      expect((await stopping).turn?.terminalEventId).toBeNull();
      nativeEvent(h, setup.thread.id, requestId, "interrupted");
      expect(
        (await setup.api.getPreparation({ operationId: accepted.operationId }))
          ?.state,
      ).toBe("interrupted");
      setup.lifecycle.abort();
    });
  });
  it("does not release native input when pause wins asynchronous provider readiness", async () => {
    await withTestHarness(async (h) => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const setup = await fixture(h);
      const readiness = vi
        .spyOn(h.deps.providerRegistry, "whenRegistrationsSettled")
        .mockImplementation(async () => {
          enter();
          await gate;
        });
      const ready = await setup.api.prepare(setup.request);
      await setup.api.startPrepared({
        operationId: ready.operationId,
        expectedRevision: ready.revision,
      });
      await entered;
      const current = await setup.api.getPreparation({
        operationId: ready.operationId,
      });
      if (!current) throw new Error("Expected preparation");
      await setup.api.interrupt({
        operationId: ready.operationId,
        expectedRevision: current.revision,
      });
      release();
      readiness.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        (await setup.api.getPreparation({ operationId: ready.operationId }))
          ?.state,
      ).toBe("cancelled");
      expect(listQueuedCommands(h, "turn.submit")).toEqual([]);
      expect(
        h.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, setup.thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toEqual(setup.priorRequests);
      setup.lifecycle.abort();
    });
  });

  it("supplies exact ownership to a native tool and refuses unknown identity before its callback", async () => {
    await withTestHarness(async (h) => {
      const setup = await fixture(h);
      let calls = 0;
      h.pluginService.getApi("turn-owner")!.agents.registerTool({
        name: "inspect_turn",
        description: "Inspect authoritative native input",
        parameters: z.object({}),
        execute: (_input, ctx) => {
          calls++;
          return JSON.stringify(ctx.experimental_invocation);
        },
      });
      const ready = await setup.api.prepare(setup.request);
      const release = setup.api.startPrepared({
        operationId: ready.operationId,
        expectedRevision: ready.revision,
      });
      const queued = listQueuedThreadMessages(h.db, ready.threadId)[0];
      if (!queued) throw new Error("Expected queue");
      await release;
      const requestId = createClientTurnRequestId();
      h.db.transaction((tx) =>
        recordPreparedTurnDispatch(tx, {
          threadId: ready.threadId,
          queueId: queued.id,
          requestId,
          input: setup.request.input,
          execution: {
            ...setup.request.execution,
            source: "client/turn/requested",
          },
        }),
      );
      const invoke = () =>
        h.app.request("/internal/session/tool-call", {
          method: "POST",
          headers: internalAuthHeaders(h),
          body: JSON.stringify({
            sessionId: setup.session.id,
            threadId: ready.threadId,
            providerThreadId: "native-main",
            turnId: "native-turn",
            callId: "call-authority",
            tool: "inspect_turn",
            arguments: {},
          }),
        });
      expect((await invoke()).status).toBe(409);
      expect(calls).toBe(0);
      nativeEvent(h, ready.threadId, requestId);
      const response = await invoke();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(requestId);
      expect(calls).toBe(1);
      setup.lifecycle.abort();
    });
  });
  it("reserves immutable owner input without changing the existing thread or allocating native input", async () => {
    await withTestHarness(async (h) => {
      const { api, request, thread, lifecycle } = await fixture(h);
      const before = getThread(h.db, thread.id);
      const first = await api.prepare(request);
      expect(await api.prepare(request)).toEqual(first);
      expect(first.dispatch).toBeNull();
      expect(getThread(h.db, thread.id)).toEqual(before);
      expect(listQueuedThreadMessages(h.db, thread.id)).toEqual([]);
      expect(listQueuedCommands(h, "turn.submit")).toEqual([]);
      await expect(
        api.prepare({
          ...request,
          input: [{ type: "text", text: "Different", mentions: [] }],
        }),
      ).rejects.toThrow("different immutable");
      const other = createPreparedTurnApi(h.deps, {
        pluginId: "foreign",
        signal: new AbortController().signal,
      });
      expect(
        await other.getPreparation({ operationId: request.operationId }),
      ).toBeNull();
      await expect(
        other.startPrepared({
          operationId: request.operationId,
          expectedRevision: 0,
        }),
      ).rejects.toThrow("does not belong");
      await expect(
        other.prepare({ ...request, operationId: "other" }),
      ).rejects.toThrow("already prepared");
      lifecycle.abort();
    });
  });

  it("rejects changed project, environment and dynamic input before reservation", async () => {
    await withTestHarness(async (h) => {
      const { api, request, lifecycle } = await fixture(h);
      for (const changed of [
        { ...request, projectId: "wrong" },
        {
          ...request,
          environment: { ...request.environment, path: "/different" },
        },
        {
          ...request,
          execution: { ...request.execution, providerId: "claude" },
        },
      ])
        await expect(api.prepare(changed)).rejects.toThrow("changed");
      await expect(
        api.prepare({
          ...request,
          input: [
            {
              type: "text",
              text: "Unresolved",
              mentions: [
                {
                  start: 0,
                  end: 10,
                  resource: { kind: "thread", threadId: "unknown", label: "x" },
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow();
      expect(h.db.select().from(threadTurnPreparations).all()).toEqual([]);
      lifecycle.abort();
    });
  });

  it("uses the public SDK to dispatch exactly once with transient owner context and native evidence", async () => {
    await withTestHarness(async (h) => {
      const { api, request, thread, priorRequests } = await fixture(
        h,
        undefined,
        true,
      );
      const before = getThread(h.db, thread.id);
      const ready = await api.prepare(request);
      const control = {
        operationId: ready.operationId,
        expectedRevision: ready.revision,
      };
      await api.startPrepared(control);
      await api.startPrepared(control);
      const command = await waitForQueuedCommand(
        h,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (command.command.type !== "turn.submit")
        throw new Error("Expected existing native conversation");
      const native = command.command;
      const row = getThreadTurnPreparationByRequest(h.db, native.requestId);
      expect(row?.threadId).toBe(thread.id);
      expect(native.input).toEqual(request.input);
      expect(JSON.stringify(native)).toContain("TURN_CONTEXT=");
      expect(JSON.stringify(native)).toContain(request.executionContextId);
      expect(native.target).toEqual({ mode: "start" });
      expect(await api.startPrepared(control)).toMatchObject({
        state: "start-requested",
        dispatch: { clientTurnRequestId: native.requestId },
        turn: null,
      });
      expect(getThread(h.db, thread.id)).toMatchObject({
        originKind: before?.originKind,
        originPluginId: before?.originPluginId,
        experimental_executionContextId:
          before?.experimental_executionContextId,
        modelOverride: before?.modelOverride,
      });
      nativeEvent(
        h,
        thread.id,
        createClientTurnRequestId(),
        undefined,
        "other-provider",
        "other-turn",
      );
      expect(
        (await api.getPreparation({ operationId: ready.operationId }))?.turn,
      ).toBeNull();
      nativeEvent(h, thread.id, native.requestId);
      const accepted = await api.getPreparation({
        operationId: ready.operationId,
      });
      expect(accepted).toMatchObject({
        state: "started",
        turn: {
          providerThreadId: "native-main",
          turnId: "native-turn",
          terminalEventId: null,
        },
      });
      nativeEvent(
        h,
        thread.id,
        native.requestId,
        "completed",
        "wrong-native-provider",
      );
      expect(() => assertPreparedTurnHistoryMutable(h.db, thread.id)).toThrow(
        "settle",
      );
      nativeEvent(h, thread.id, native.requestId, "completed");
      expect(() =>
        assertPreparedTurnHistorySuffixMutable(h.db, thread.id, 1),
      ).toThrow("retained owned turn history");
      await reportQueuedCommandSuccess(h, command, {
        providerThreadId: "native-main",
        appliedAs: "new-turn",
      });
      const completed = await api.getPreparation({
        operationId: ready.operationId,
      });
      expect(completed).toMatchObject({
        state: "completed",
        turn: { terminalStatus: "completed" },
      });
      expect(completed?.turn?.terminalEventId).toBeTruthy();
      expect(() =>
        assertPreparedTurnHistorySuffixMutable(h.db, thread.id, 1),
      ).toThrow("retained owned turn history");
      expect(() =>
        assertPreparedTurnHistorySuffixMutable(
          h.db,
          thread.id,
          getLatestThreadSequence(h.db, { threadId: thread.id }) + 1,
        ),
      ).not.toThrow();
      expect(
        await api.getPreparation({ operationId: ready.operationId }),
      ).toEqual(completed);
      expect(
        h.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(priorRequests.length + 1);
      expect(await api.startPrepared(control)).toEqual(completed);
    });
  });

  it("cancels a released queue before request allocation and cannot rearm that terminal operation", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      const released = await setup.release;
      const cancelled = await setup.api.interrupt({
        operationId: released.operationId,
        expectedRevision: released.revision,
      });
      expect(cancelled).toMatchObject({
        state: "cancelled",
        dispatch: { clientTurnRequestId: null },
      });
      expect(listQueuedThreadMessages(h.db, setup.thread.id)).toEqual([]);
      await expect(
        setup.api.startPrepared({
          operationId: cancelled.operationId,
          expectedRevision: cancelled.revision,
        }),
      ).rejects.toThrow("state changed");
      expect(
        await setup.api.interrupt({
          operationId: released.operationId,
          expectedRevision: released.revision,
        }),
      ).toEqual(cancelled);
      setup.lifecycle.abort();
    });
  });

  it("revokes an old owner queue and rearms only by the retained revision before any request", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      const released = await setup.release;
      setup.lifecycle.abort();
      const signal = new AbortController();
      const restarted = createPreparedTurnApi(h.deps, {
        pluginId: "turn-owner",
        signal: signal.signal,
      });
      const retained = await restarted.getPreparation({
        operationId: setup.request.operationId,
      });
      if (!retained) throw new Error("Expected retained preparation");
      expect(retained.state).toBe("needs-reconciliation");
      expect(listQueuedThreadMessages(h.db, setup.thread.id)).toEqual([]);
      expect(() =>
        h.db.transaction((tx) =>
          recordPreparedTurnDispatch(tx, {
            threadId: setup.thread.id,
            queueId: setup.queue.id,
            requestId: createClientTurnRequestId(),
            input: setup.request.input,
            execution: {
              ...setup.request.execution,
              source: "client/turn/requested" as const,
            },
          }),
        ),
      ).toThrow("no longer released");
      await expect(
        restarted.startPrepared({
          operationId: retained.operationId,
          expectedRevision: released.revision,
        }),
      ).rejects.toThrow("revision");
      const resumed = await restarted.startPrepared({
        operationId: retained.operationId,
        expectedRevision: retained.revision,
      });
      expect(resumed.dispatch?.queuedMessageId).not.toBe(setup.queue.id);
      expect(resumed.requestHash).toBe(released.requestHash);
      signal.abort();
    });
  });

  it("retains exact native identity across owner restart and uncertain conditional stop", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      const released = await setup.release;
      const requestId = createClientTurnRequestId();
      h.db.transaction((tx) =>
        recordPreparedTurnDispatch(tx, {
          threadId: setup.thread.id,
          queueId: setup.queue.id,
          requestId,
          input: setup.request.input,
          execution: {
            ...setup.request.execution,
            source: "client/turn/requested" as const,
          },
        }),
      );
      setup.lifecycle.abort();
      const stopped: string[] = [];
      const controller = new AbortController();
      const api = createPreparedTurnApi(
        h.deps,
        { pluginId: "turn-owner", signal: controller.signal },
        async (row) => {
          stopped.push(row.clientTurnRequestId ?? "");
          if (stopped.length === 1) throw new Error("lost reply");
        },
      );
      const retained = await api.getPreparation({
        operationId: released.operationId,
      });
      if (!retained) throw new Error("Expected retained operation");
      expect(retained.dispatch?.clientTurnRequestId).toBe(requestId);
      await expect(
        api.startPrepared({
          operationId: retained.operationId,
          expectedRevision: retained.revision,
        }),
      ).rejects.toThrow("state changed");
      const control = {
        operationId: retained.operationId,
        expectedRevision: retained.revision,
      };
      await expect(api.interrupt(control)).rejects.toThrow("lost reply");
      expect((await api.interrupt(control)).state).toBe("needs-reconciliation");
      expect(stopped).toEqual([requestId, requestId]);
      expect(() =>
        assertPreparedTurnHistoryMutable(h.db, setup.thread.id),
      ).toThrow("settle");
      nativeEvent(h, setup.thread.id, requestId);
      nativeEvent(h, setup.thread.id, requestId, "interrupted");
      expect(
        (await api.getPreparation({ operationId: released.operationId }))
          ?.state,
      ).toBe("interrupted");
      expect(() =>
        assertPreparedTurnHistoryMutable(h.db, setup.thread.id),
      ).not.toThrow();
      controller.abort();
    });
  });

  it("keeps owned rows immutable and separate from adjacent manually grouped messages", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      await setup.release;
      const manual = createQueuedThreadMessage(h.db, h.hub, {
        threadId: setup.thread.id,
        content: setup.request.input,
        ...setup.request.execution,
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      expect(() =>
        updateQueuedThreadMessage(h.db, h.hub, {
          id: setup.queue.id,
          threadId: setup.thread.id,
          expectedUpdatedAt: setup.queue.updatedAt,
          content: [],
        }),
      ).toThrow("preparation owner");
      expect(() =>
        deleteQueuedThreadMessage(h.db, h.hub, setup.queue.id),
      ).toThrow("preparation owner");
      expect(() =>
        claimQueuedThreadMessageGroup(h.db, h.hub, setup.queue.id, {
          kind: "explicit-send",
        }),
      ).toThrow("preparation owner");
      expect(() =>
        setQueuedThreadMessageGroupBoundary({
          db: h.db,
          notifier: h.hub,
          threadId: setup.thread.id,
          expectedGroupedPrefixQueuedMessageIds: [setup.queue.id],
          groupBoundaryQueuedMessageId: manual.id,
        }),
      ).toThrow("preparation owner");
      h.db
        .update(queuedThreadMessages)
        .set({ groupWithNext: true })
        .where(eq(queuedThreadMessages.id, setup.queue.id))
        .run();
      const claimed = claimNextQueuedThreadMessageGroup(
        h.db,
        h.hub,
        setup.thread.id,
      );
      expect(claimed?.map((row) => row.id)).toEqual([setup.queue.id]);
      setup.lifecycle.abort();
    });
  });

  it("rechecks idle status and exact immutable bytes at the final dispatch transaction", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      await setup.release;
      const input = {
        threadId: setup.thread.id,
        queueId: setup.queue.id,
        requestId: createClientTurnRequestId(),
        input: setup.request.input,
        execution: {
          ...setup.request.execution,
          source: "client/turn/requested" as const,
        },
      };
      for (const changed of [
        {
          ...input,
          input: [{ type: "text" as const, text: "changed", mentions: [] }],
        },
        { ...input, execution: { ...input.execution, model: "different" } },
      ])
        expect(() =>
          h.db.transaction((tx) => recordPreparedTurnDispatch(tx, changed)),
        ).toThrow("exact admitted");
      h.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, setup.thread.id))
        .run();
      expect(() =>
        h.db.transaction((tx) => recordPreparedTurnDispatch(tx, input)),
      ).toThrow("idle conversation");
      expect(
        getThreadTurnPreparationByQueue(h.db, setup.queue.id)
          ?.clientTurnRequestId,
      ).toBeNull();
      setup.lifecycle.abort();
    });
  });

  it("exposes foreign ownership and rejects missing, stale, or mixed native input attribution", async () => {
    await withTestHarness(async (h) => {
      const setup = await held(h);
      await setup.release;
      const identity = {
        threadId: setup.thread.id,
        providerThreadId: "native-main",
        turnId: "native-turn",
        callId: "call-1",
      };
      expect(() => resolveToolInvocation(h.db, identity)).toThrow(
        "not yet unambiguous",
      );
      const requestId = createClientTurnRequestId();
      h.db.transaction((tx) =>
        recordPreparedTurnDispatch(tx, {
          threadId: setup.thread.id,
          queueId: setup.queue.id,
          requestId,
          input: setup.request.input,
          execution: {
            ...setup.request.execution,
            source: "client/turn/requested" as const,
          },
        }),
      );
      nativeEvent(h, setup.thread.id, requestId);
      expect(resolveToolInvocation(h.db, identity)).toMatchObject({
        ownedTurn: {
          ownerPluginId: "turn-owner",
          operationId: setup.request.operationId,
          executionContextId: setup.request.executionContextId,
          clientTurnRequestId: requestId,
        },
      });
      nativeEvent(h, setup.thread.id, createClientTurnRequestId());
      expect(() => resolveToolInvocation(h.db, identity)).toThrow(
        "Several inputs",
      );
      nativeEvent(
        h,
        setup.thread.id,
        createClientTurnRequestId(),
        undefined,
        "native-main",
        "manual-turn",
      );
      expect(
        resolveToolInvocation(h.db, { ...identity, turnId: "manual-turn" })
          .ownedTurn,
      ).toBeNull();
      nativeEvent(
        h,
        setup.thread.id,
        requestId,
        "completed",
        "native-main",
        "manual-turn",
      );
      expect(() =>
        resolveToolInvocation(h.db, { ...identity, turnId: "manual-turn" }),
      ).toThrow("already settled");
      setup.lifecycle.abort();
    });
  });
});

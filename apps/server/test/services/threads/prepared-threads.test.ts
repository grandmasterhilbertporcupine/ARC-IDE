import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  events,
  getThread,
  getThreadPreparation,
  listQueuedThreadMessages,
  markThreadDeleted,
  updateQueuedThreadMessage,
  deleteQueuedThreadMessage,
  createQueuedThreadMessage,
  getLatestThreadSequence,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import type { ExperimentalPrepareThreadRequest } from "@get-bb/plugin-sdk";
import { createPreparedThreadApi } from "../../../src/services/threads/prepared-threads.js";
import { createClientTurnRequestId } from "../../../src/services/threads/thread-events.js";
import { attemptDispatch } from "../../../src/services/threads/dispatch-attempt.js";
import { stopThreadForCurrentState } from "../../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedCommands,
  waitForQueuedCommand,
  reportQueuedCommandSuccess,
} from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  buildChildThreadTurnStatusBatchInput,
  queueChildThreadNeedsAttentionNotificationBestEffort,
  queueChildThreadTurnNotificationBestEffort,
} from "../../../src/services/threads/child-thread-notifications.js";
import { queueParentSystemMessage } from "../../../src/services/threads/parent-system-messages.js";
import { runQueuedMessageDispatch } from "../../../src/services/threads/queued-message-dispatch.js";
import { resolveMessageSenderThreadId } from "../../../src/services/threads/thread-send.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

async function fixture(harness: TestAppHarness, useSdk = false) {
  const root = join(harness.config.dataDir, "prepared-owner-fixture");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "bb-plugin-arc-test",
      version: "0.1.0",
      bb: {
        name: "Prepared owner",
        description: "Prepared worker integration fixture",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(root, "server.ts"),
    `export default function plugin(bb) { bb.agents.configure(() => ({ tools: [], skills: [], instructions: "SEALED_OWNER_CONTEXT" })); }`,
  );
  await harness.pluginService.installPath(root);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/workspace",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/workspace/worker",
  });
  const lifecycle = new AbortController();
  const api = useSdk
    ? harness.pluginService.getApi("arc-test")!.experimental_threads
    : createPreparedThreadApi(harness.deps, {
        pluginId: "arc-test",
        signal: lifecycle.signal,
      });
  const request: ExperimentalPrepareThreadRequest = {
    operationId: "run:writer:1",
    projectId: project.id,
    parentThreadId: null,
    executionContextId: "arc:run:writer:1",
    title: "Implement first writer",
    visibility: "hidden",
    turnPolicy: "single",
    environment: { type: "reuse", environmentId: environment.id },
    execution: {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    },
    input: [{ type: "text", text: "Implement the sealed task", mentions: [] }],
  };
  return { api, request, environment, lifecycle };
}

async function prepare(harness: TestAppHarness, useSdk = false) {
  const setup = await fixture(harness, useSdk);
  const reservation = await setup.api.prepare(setup.request);
  await expect
    .poll(
      async () =>
        (
          await setup.api.getPreparation({
            operationId: setup.request.operationId,
          })
        )?.state,
    )
    .toBe("prepared");
  const ready = await setup.api.getPreparation({
    operationId: setup.request.operationId,
  });
  if (ready?.state !== "prepared") throw new Error("Expected prepared worker");
  return { ...setup, reservation, ready };
}

describe("durable prepared worker admission", () => {
  it("seals optional parent delivery without changing legacy request hashes", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, environment } = await fixture(harness, true);
      await expect(
        api.prepare({ ...request, parentNotification: "owner-controlled" }),
      ).rejects.toThrow("requires a parent thread");
      const parent = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
      });
      const legacy = { ...request, parentThreadId: parent.id };
      const first = await api.prepare(legacy);
      const repeated = await api.prepare({
        ...legacy,
        parentNotification: undefined,
      });
      expect(repeated.requestHash).toBe(first.requestHash);
      expect(
        getThreadPreparation(harness.db, first.threadId)?.requestJson,
      ).not.toContain("parentNotification");
      await expect(
        api.prepare({ ...legacy, parentNotification: "owner-controlled" }),
      ).rejects.toThrow("different sealed input");
      const owned = await api.prepare({
        ...legacy,
        operationId: "owned-notices",
        parentNotification: "owner-controlled",
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: "owned-notices" }))?.state,
        )
        .toBe("prepared");
      expect(
        getThreadPreparation(harness.db, owned.threadId)?.requestJson,
      ).toContain('"parentNotification":"owner-controlled"');
      expect(getThread(harness.db, owned.threadId)).toMatchObject({
        parentThreadId: parent.id,
        originKind: null,
        originPluginId: "arc-test",
      });
    });
  });

  it.each(["idle", "active"] as const)(
    "records owned child outcomes passively while its parent is %s",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { api, request, environment, lifecycle } = await fixture(harness);
        const parent = seedThread(harness.deps, {
          projectId: request.projectId,
          environmentId: environment.id,
          status,
        });
        seedThreadRuntimeState(harness.deps, {
          environmentId: environment.id,
          threadId: parent.id,
          providerThreadId: "parent-provider",
        });
        const reserved = await api.prepare({
          ...request,
          parentThreadId: parent.id,
          parentNotification: "owner-controlled",
        });
        await expect
          .poll(
            async () =>
              (await api.getPreparation({ operationId: request.operationId }))
                ?.state,
          )
          .toBe("prepared");
        const child = getThread(harness.db, reserved.threadId)!;
        const priorRequests = harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, parent.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all().length;
        for (const turnStatus of [
          "completed",
          "failed",
          "interrupted",
        ] as const) {
          const notification = {
            childThread: child,
            parentThreadId: parent.id,
            turnStatus,
          };
          await queueChildThreadTurnNotificationBestEffort(
            harness.deps,
            notification,
          );
          await queueChildThreadTurnNotificationBestEffort(
            harness.deps,
            notification,
          );
        }
        lifecycle.abort();
        await queueChildThreadNeedsAttentionNotificationBestEffort(
          harness.deps,
          {
            childThread: child,
            parentThreadId: parent.id,
            blockerSummary: "Waiting for its owner",
          },
        );
        const notices = harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, parent.id),
              eq(events.type, "system/operation"),
            ),
          )
          .all();
        expect(notices).toHaveLength(4);
        expect(notices.map((notice) => JSON.parse(notice.data))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              operation: "owned_child_notice",
              status: "completed",
              metadata: expect.objectContaining({
                kind: "child-completed",
                delivery: "owner-controlled",
              }),
            }),
            expect.objectContaining({
              metadata: expect.objectContaining({ kind: "child-failed" }),
            }),
            expect.objectContaining({
              metadata: expect.objectContaining({ kind: "child-interrupted" }),
            }),
            expect.objectContaining({
              metadata: expect.objectContaining({
                kind: "child-needs-attention",
              }),
            }),
          ]),
        );
        expect(
          harness.db
            .select()
            .from(events)
            .where(
              and(
                eq(events.threadId, parent.id),
                eq(events.type, "client/turn/requested"),
              ),
            )
            .all(),
        ).toHaveLength(priorRequests);
        expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
        expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
        expect(listQueuedCommands(harness, "turn.submit")).toEqual([]);
        expect(() =>
          resolveMessageSenderThreadId(harness.deps, {
            senderThreadId: child.id,
            targetThread: parent,
          }),
        ).toThrow("owner's admission");
        expect(() =>
          resolveMessageSenderThreadId(harness.deps, {
            senderThreadId: child.id,
            targetThread: child,
          }),
        ).not.toThrow();
      });
    },
  );

  it("drains a retained owned system notice without dispatch and blocks explicit parent sends", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, environment } = await fixture(harness);
      const parent = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: parent.id,
        providerThreadId: "parent-provider",
      });
      const reserved = await api.prepare({
        ...request,
        parentThreadId: parent.id,
        parentNotification: "owner-controlled",
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: request.operationId }))
              ?.state,
        )
        .toBe("prepared");
      createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: parent.id,
        content: request.input,
        ...request.execution,
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind: "child-completed",
          subject: {
            kind: "thread",
            threadId: reserved.threadId,
            threadName: "Owned worker",
          },
        },
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: parent.id,
      });
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, parent.id),
              eq(events.type, "system/operation"),
            ),
          )
          .all(),
      ).toHaveLength(1);
      await expect(
        Promise.resolve().then(() =>
          attemptDispatch(harness.deps, {
            thread: parent,
            payload: {
              input: request.input,
              senderThreadId: reserved.threadId,
              mode: "start",
            },
            source: { kind: "inline" },
            queuePayload: { kind: "inline" },
            origin: null,
            originPluginId: null,
            startedOnBehalfOf: null,
            trigger: "user",
          }),
        ),
      ).rejects.toThrow("owner's admission");
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
      expect(listQueuedCommands(harness, "turn.submit")).toEqual([]);
    });
  });

  it("splits retained mixed batches and refuses retained sender-tagged queue bypasses", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, environment } = await fixture(harness);
      const parent = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: parent.id,
        providerThreadId: "parent-provider",
      });
      const reserved = await api.prepare({
        ...request,
        parentThreadId: parent.id,
        parentNotification: "owner-controlled",
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: request.operationId }))
              ?.state,
        )
        .toBe("prepared");
      const owned = getThread(harness.db, reserved.threadId)!;
      const ordinary = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
        parentThreadId: parent.id,
      });
      createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: parent.id,
        content: buildChildThreadTurnStatusBatchInput({
          items: [owned, ordinary].map((childThread) => ({
            childThread,
            activeWorkflowCount: childThread.id === ordinary.id ? 1 : 0,
            terminalOutput: null,
            turnStatus:
              childThread.id === ordinary.id ? "interrupted" : "completed",
          })),
        }),
        ...request.execution,
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind: "child-outcome-batch",
          subject: { kind: "thread-batch", count: 2 },
        },
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: parent.id,
      });
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === parent.id,
      );
      await reportQueuedCommandSuccess(harness, command, {
        providerThreadId: "parent-provider",
        appliedAs: "new-turn",
      });
      const parentRequests = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, parent.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .all();
      const delivered = parentRequests
        .map((event) => JSON.parse(event.data))
        .find((event) => event.systemMessageKind === "child-outcome-batch");
      expect(JSON.stringify(delivered.input)).toContain(ordinary.id);
      expect(JSON.stringify(delivered.input)).not.toContain(owned.id);
      expect(JSON.stringify(delivered.input)).toContain(
        "was interrupted, with 1 workflow still running",
      );
      expect(JSON.stringify(delivered.input)).toContain(
        "do not resume, restart, retry, replace, or continue",
      );
      expect(JSON.stringify(delivered.input)).toContain(
        "workflow still running have not finished",
      );
      const passive = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, parent.id),
            eq(events.type, "system/operation"),
          ),
        )
        .all();
      expect(passive).toHaveLength(1);
      expect(passive[0]!.data).toContain(owned.id);
      expect(passive[0]!.data).not.toContain(ordinary.id);
      const otherParent = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: otherParent.id,
        providerThreadId: "other-parent-provider",
      });
      const otherOwned = await api.prepare({
        ...request,
        operationId: "queued-sender",
        executionContextId: "queued-sender-context",
        parentThreadId: otherParent.id,
        parentNotification: "owner-controlled",
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: "queued-sender" }))?.state,
        )
        .toBe("prepared");
      const queued = createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: otherParent.id,
        senderThreadId: otherOwned.threadId,
        content: request.input,
        ...request.execution,
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: otherParent.id,
      });
      expect(
        listQueuedThreadMessages(harness.db, otherParent.id).map(
          (row) => row.id,
        ),
      ).toContain(queued.id);
      expect(
        listQueuedCommands(harness, "turn.submit").filter(
          (command) =>
            command.type === "turn.submit" &&
            command.threadId === otherParent.id,
        ),
      ).toEqual([]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, otherParent.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
    });
  });

  it("preserves automatic notices and explicit sends for legacy prepared and ordinary children", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, environment } = await fixture(harness);
      const parent = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        threadId: parent.id,
        providerThreadId: "parent-provider",
      });
      const legacy = await api.prepare({
        ...request,
        parentThreadId: parent.id,
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: request.operationId }))
              ?.state,
        )
        .toBe("prepared");
      const ordinary = seedThread(harness.deps, {
        projectId: request.projectId,
        environmentId: environment.id,
        parentThreadId: parent.id,
      });
      for (const childThreadId of [legacy.threadId, ordinary.id])
        expect(
          resolveMessageSenderThreadId(harness.deps, {
            senderThreadId: childThreadId,
            targetThread: parent,
          }),
        ).toBe(childThreadId);
      await queueParentSystemMessage(harness.deps, {
        parentThreadId: parent.id,
        input: request.input,
        systemMessageKind: "child-completed",
        systemMessageSubject: {
          kind: "thread",
          threadId: legacy.threadId,
          threadName: "Legacy worker",
        },
      });
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === parent.id,
      );
      await reportQueuedCommandSuccess(harness, command, {
        providerThreadId: "parent-provider",
        appliedAs: "new-turn",
      });
      const requested = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, parent.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .all();
      expect(requested.map((event) => JSON.parse(event.data))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            initiator: "system",
            systemMessageKind: "child-completed",
          }),
        ]),
      );
    });
  });

  it.each([false, true])(
    "retains unmanaged provisioning without dispatch when owner disposal is %s",
    async (disposed) => {
      await withTestHarness(async (harness) => {
        const { api, request, environment, lifecycle } = await fixture(harness);
        const path = "/workspace/owned-detached-writer";
        const reservation = await api.prepare({
          ...request,
          environment: {
            type: "host",
            hostId: environment.hostId,
            workspace: { type: "unmanaged", path },
          },
        });
        const provision = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.provision" &&
            command.initiator?.threadId === reservation.threadId,
        );
        expect(provision.command).toMatchObject({
          type: "environment.provision",
          workspaceProvisionType: "unmanaged",
          path,
        });
        expect(
          getThreadPreparation(harness.db, reservation.threadId)
            ?.provisioningContextJson,
        ).toContain(path);
        expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
        if (disposed) lifecycle.abort();
        await reportQueuedCommandSuccess(harness, provision, {
          path,
          branchName: null,
          defaultBranch: "main",
          isGitRepo: true,
          isWorktree: true,
          transcript: [],
        });
        if (disposed) {
          const replacement = createPreparedThreadApi(harness.deps, {
            pluginId: "arc-test",
            signal: new AbortController().signal,
          });
          expect(
            await replacement.getPreparation({
              operationId: request.operationId,
            }),
          ).toMatchObject({
            state: "needs-reconciliation",
            threadId: reservation.threadId,
          });
        } else {
          await expect
            .poll(
              async () =>
                (await api.getPreparation({ operationId: request.operationId }))
                  ?.state,
            )
            .toBe("prepared");
          expect(
            await api.getPreparation({ operationId: request.operationId }),
          ).toMatchObject({
            environment: { hostId: environment.hostId, path },
          });
        }
        expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
        expect(listQueuedCommands(harness, "turn.submit")).toEqual([]);
        expect(
          listQueuedThreadMessages(harness.db, reservation.threadId),
        ).toEqual([]);
      });
    },
  );
  it("reserves one owner-bound thread, provisions without a turn and holds ordinary sends", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, ready } = await prepare(harness, true);
      const repeats = await Promise.all([
        api.prepare(request),
        api.prepare(request),
      ]);
      expect(repeats.map((row) => row.threadId)).toEqual([
        ready.threadId,
        ready.threadId,
      ]);
      await expect(
        api.prepare({
          ...request,
          input: [{ type: "text", text: "different", mentions: [] }],
        }),
      ).rejects.toThrow("different sealed input");
      const other = createPreparedThreadApi(harness.deps, {
        pluginId: "other",
        signal: new AbortController().signal,
      });
      expect(
        await other.getPreparation({ operationId: request.operationId }),
      ).toBeNull();
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
      expect(listQueuedCommands(harness, "turn.submit")).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, ready.threadId)).toEqual([]);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, ready.threadId),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toEqual([]);
      const thread = getThread(harness.db, ready.threadId)!;
      expect(thread).toMatchObject({
        status: "idle",
        originPluginId: "arc-test",
        experimental_executionContextId: request.executionContextId,
      });
      await expect(
        attemptDispatch(harness.deps, {
          thread,
          payload: { input: request.input, mode: "start" },
          source: { kind: "inline" },
          queuePayload: { kind: "inline" },
          origin: null,
          originPluginId: null,
          startedOnBehalfOf: null,
          trigger: "user",
        }),
      ).rejects.toThrow("admitted first turn");
      await expect(
        api.startPrepared({
          operationId: request.operationId,
          expectedRevision: ready.revision,
          environment: { ...ready.environment, path: "/wrong" },
        }),
      ).rejects.toThrow("environment changed");
    });
  });

  it("atomically releases the sealed queue once and observes native acceptance by exact request id", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, ready } = await prepare(harness);
      const start = {
        operationId: request.operationId,
        expectedRevision: ready.revision,
        environment: ready.environment,
      };
      const releasing = api.startPrepared(start);
      const queued = listQueuedThreadMessages(harness.db, ready.threadId)[0]!;
      expect(() =>
        updateQueuedThreadMessage(harness.db, harness.hub, {
          id: queued.id,
          threadId: ready.threadId,
          expectedUpdatedAt: queued.updatedAt,
          content: [{ type: "text", text: "edited", mentions: [] }],
        }),
      ).toThrow("admitted first turn");
      expect(() =>
        deleteQueuedThreadMessage(harness.db, harness.hub, queued.id),
      ).toThrow("admitted first turn");
      expect(() =>
        createQueuedThreadMessage(harness.db, harness.hub, {
          threadId: ready.threadId,
          content: request.input,
          ...request.execution,
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
        }),
      ).toThrow("admitted first turn");
      await releasing;
      const [first, second] = await Promise.all([
        api.startPrepared(start),
        api.startPrepared(start),
      ]);
      expect(first.dispatch?.queuedMessageId).toBe(
        second.dispatch?.queuedMessageId,
      );
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === ready.threadId,
      );
      expect(command.command.type).toBe("thread.start");
      const durable = getThreadPreparation(harness.db, ready.threadId)!;
      expect(durable.clientTurnRequestId).not.toBeNull();
      expect(listQueuedThreadMessages(harness.db, ready.threadId)).toEqual([]);
      expect(await api.startPrepared(start)).toMatchObject({
        state: "start-requested",
        dispatch: { clientTurnRequestId: durable.clientTurnRequestId },
      });
      seedEvent(harness.deps, {
        threadId: ready.threadId,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: ready.threadId }) + 1,
        type: "turn/input/accepted",
        providerThreadId: "native",
        scope: turnScope("native-turn"),
        data: { clientRequestId: createClientTurnRequestId() },
      });
      expect(
        await api.getPreparation({ operationId: request.operationId }),
      ).toMatchObject({ state: "start-requested" });
      seedEvent(harness.deps, {
        threadId: ready.threadId,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: ready.threadId }) + 1,
        type: "turn/input/accepted",
        providerThreadId: "native",
        scope: turnScope("native-turn"),
        data: { clientRequestId: durable.clientTurnRequestId! },
      });
      expect(
        await api.getPreparation({ operationId: request.operationId }),
      ).toMatchObject({ state: "started" });
      await reportQueuedCommandSuccess(harness, command, {
        providerThreadId: "native",
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, ready.threadId),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
    });
  });

  it("preserves cancelled and disposed reservations without replaying preparation", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, ready, environment, lifecycle } =
        await prepare(harness);
      const stopping = stopThreadForCurrentState(
        harness.deps,
        getThread(harness.db, ready.threadId)!,
        environment,
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === ready.threadId,
      );
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      await stopping;
      expect(await api.prepare(request)).toMatchObject({
        state: "cancelled",
        threadId: ready.threadId,
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: ready.threadId });
      expect(await api.prepare(request)).toMatchObject({
        state: "cancelled",
        threadId: ready.threadId,
      });
      lifecycle.abort();
      await expect(api.prepare(request)).rejects.toThrow();
      const replacement = createPreparedThreadApi(harness.deps, {
        pluginId: "arc-test",
        signal: new AbortController().signal,
      });
      expect(await replacement.prepare(request)).toMatchObject({
        state: "cancelled",
        threadId: ready.threadId,
      });
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
    });
  });

  it("rejects an old owner generation after restart with its retained environment", async () => {
    await withTestHarness(async (harness) => {
      const { api, request, ready, lifecycle } = await prepare(harness);
      lifecycle.abort();
      const replacement = createPreparedThreadApi(harness.deps, {
        pluginId: "arc-test",
        signal: new AbortController().signal,
      });
      expect(await replacement.prepare(request)).toMatchObject({
        state: "needs-reconciliation",
        environment: ready.environment,
        threadId: ready.threadId,
      });
      await expect(
        replacement.startPrepared({
          operationId: request.operationId,
          expectedRevision: ready.revision,
          environment: ready.environment,
        }),
      ).rejects.toThrow();
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
      await expect(
        api.getPreparation({ operationId: request.operationId }),
      ).rejects.toThrow();
    });
  });
});

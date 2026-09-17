import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  environments,
  events,
  getThread,
  getThreadPreparation,
  listQueuedThreadMessages,
  threadPreparations,
  threads,
} from "@bb/db";
import { z } from "zod";
import { settlePreparedEnvironment } from "../../../src/services/threads/prepared-thread-provision.js";
import { preparedThreadRequestSchema } from "../../../src/services/threads/prepared-thread-validation.js";
import {
  canonicalPreparationJson,
  preparationHash,
} from "../../../src/services/threads/prepared-thread-state.js";
import {
  createMetadataPendingContext,
  type ThreadProvisionContext,
} from "../../../src/services/threads/thread-provisioning-context.js";
import {
  forgetActiveThreadProvisionContext,
  rememberActiveThreadProvisionContext,
} from "../../../src/services/threads/thread-provisioning-active-context.js";
import { appendThreadProvisioningEvent } from "../../../src/services/threads/thread-events.js";
import { failThreadProvisioning } from "../../../src/services/threads/thread-provisioning-environment.js";
import { stopThreadForCurrentState } from "../../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

function provisioningRows(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/thread-provisioning"),
      ),
    )
    .all()
    .map((row) => ({
      id: row.id,
      ...z
        .object({ provisioningId: z.string(), status: z.string() })
        .parse(JSON.parse(row.data)),
    }));
}

function noDispatch(harness: TestAppHarness, threadId: string) {
  expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
  expect(listQueuedCommands(harness, "turn.submit")).toEqual([]);
  expect(listQueuedThreadMessages(harness.db, threadId)).toEqual([]);
  expect(
    harness.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
          eq(events.type, "client/turn/requested"),
        ),
      )
      .all(),
  ).toEqual([]);
}

function preparationRequest(
  projectId: string,
  environmentId: string,
  key: string,
) {
  return preparedThreadRequestSchema.parse({
    operationId: `prepared:${key}`,
    projectId,
    parentThreadId: null,
    executionContextId: `execution:${key}`,
    title: "Held prepared worker",
    visibility: "hidden",
    turnPolicy: "single",
    environment: { type: "reuse", environmentId },
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
        text: "Wait for the owner's explicit release",
        mentions: [],
      },
    ],
  });
}

function fixture(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/workspace/prepared",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "starting",
    originPluginId: "arc-test",
  });
  const request = preparationRequest(project.id, environment.id, thread.id);
  harness.db
    .update(threads)
    .set({ experimental_executionContextId: request.executionContextId })
    .where(eq(threads.id, thread.id))
    .run();
  harness.db
    .insert(threadPreparations)
    .values({
      ownerPluginId: "arc-test",
      operationId: request.operationId,
      threadId: thread.id,
      requestHash: preparationHash(request),
      requestJson: canonicalPreparationJson(request),
      ownerGeneration: "fixture-owner",
      turnPolicy: "single",
      state: "provisioning",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const initial = createMetadataPendingContext({
    environmentIntent: { type: "reuse", environmentId: environment.id },
    execution: { ...request.execution, source: "client/turn/requested" },
    clientRequestId: null,
    fork: null,
    input: request.input,
    seedWithoutRun: false,
    titleProvided: true,
  });
  const sequence = appendThreadProvisioningEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    provisioningId: initial.state.provisioningId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "workspace-ready",
        text: "Workspace is ready",
        status: "completed",
      },
    ],
  });
  const context: ThreadProvisionContext = {
    ...initial,
    state: {
      ...initial.state,
      stage: "workspace-ready",
      environmentId: environment.id,
      provisionEventSequence: sequence,
      workspaceReadyEventSequence: sequence,
    },
  };
  rememberActiveThreadProvisionContext({
    db: harness.db,
    threadId: thread.id,
    context,
  });
  return { thread, environment, request, context };
}

describe("prepared provisioning terminal events", () => {
  it("records one completion when held preparation becomes ready without releasing a turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, context } = fixture(harness);
      try {
        settlePreparedEnvironment(harness.deps, thread.id, environment);
        expect(getThreadPreparation(harness.db, thread.id)).toMatchObject({
          state: "prepared",
          revision: 2,
          clientTurnRequestId: null,
          queuedMessageId: null,
        });
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(
          provisioningRows(harness, thread.id).map((row) => ({
            provisioningId: row.provisioningId,
            status: row.status,
          })),
        ).toEqual([
          { provisioningId: context.state.provisioningId, status: "active" },
          { provisioningId: context.state.provisioningId, status: "completed" },
        ]);
        const retained = provisioningRows(harness, thread.id);
        expect(() =>
          settlePreparedEnvironment(harness.deps, thread.id, environment),
        ).toThrow("no longer current");
        expect(provisioningRows(harness, thread.id)).toEqual(retained);
        noDispatch(harness, thread.id);
      } finally {
        forgetActiveThreadProvisionContext(thread.id);
      }
    });
  });

  it("rolls the event and lifecycle back if the prepared-state write fails, then completes exactly once", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = fixture(harness);
      try {
        harness.db.$client.exec(
          "CREATE TRIGGER reject_prepared_settle BEFORE UPDATE ON thread_preparations WHEN NEW.state = 'prepared' BEGIN SELECT RAISE(ABORT, 'fixture prepared write rejected'); END",
        );
        expect(() =>
          settlePreparedEnvironment(harness.deps, thread.id, environment),
        ).toThrow("fixture prepared write rejected");
        expect(
          provisioningRows(harness, thread.id).map((row) => row.status),
        ).toEqual(["active"]);
        expect(getThreadPreparation(harness.db, thread.id)).toMatchObject({
          state: "provisioning",
          revision: 1,
          environmentJson: null,
        });
        expect(getThread(harness.db, thread.id)?.status).toBe("starting");
        harness.db.$client.exec("DROP TRIGGER reject_prepared_settle");
        settlePreparedEnvironment(harness.deps, thread.id, environment);
        expect(
          provisioningRows(harness, thread.id).map((row) => row.status),
        ).toEqual(["active", "completed"]);
        noDispatch(harness, thread.id);
      } finally {
        forgetActiveThreadProvisionContext(thread.id);
      }
    });
  });

  it.each(["cancel", "failure"] as const)(
    "preserves %s before settlement and rejects the late ready callback",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { thread, environment } = fixture(harness);
        try {
          if (kind === "cancel")
            await stopThreadForCurrentState(harness.deps, thread, environment);
          else
            failThreadProvisioning(harness.deps, {
              thread,
              environmentId: environment.id,
              detail: "Fixture provisioning failed",
            });
          const before = provisioningRows(harness, thread.id);
          expect(getThreadPreparation(harness.db, thread.id)?.state).toBe(
            kind === "cancel" ? "cancelled" : "failed",
          );
          expect(() =>
            settlePreparedEnvironment(harness.deps, thread.id, environment),
          ).toThrow("no longer current");
          expect(provisioningRows(harness, thread.id)).toEqual(before);
          expect(before.some((row) => row.status === "completed")).toBe(false);
          noDispatch(harness, thread.id);
        } finally {
          forgetActiveThreadProvisionContext(thread.id);
        }
      });
    },
  );

  it.each(["environment", "context"] as const)(
    "rejects a stale %s observed before the ready callback",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { thread, environment, context } = fixture(harness);
        try {
          if (kind === "environment")
            harness.db
              .update(environments)
              .set({ path: "/workspace/moved" })
              .where(eq(environments.id, environment.id))
              .run();
          else
            harness.db
              .update(threadPreparations)
              .set({
                provisioningContextJson: JSON.stringify({
                  ...context,
                  state: {
                    ...context.state,
                    provisioningId: "replacement-provision",
                  },
                }),
              })
              .where(eq(threadPreparations.threadId, thread.id))
              .run();
          expect(() =>
            settlePreparedEnvironment(harness.deps, thread.id, environment),
          ).toThrow("no longer current");
          expect(
            provisioningRows(harness, thread.id).map((row) => row.status),
          ).toEqual(["active"]);
          expect(getThreadPreparation(harness.db, thread.id)?.state).toBe(
            "provisioning",
          );
          noDispatch(harness, thread.id);
        } finally {
          forgetActiveThreadProvisionContext(thread.id);
        }
      });
    },
  );

  it("completes the real SDK preparation path and retains the same event on replay", async () => {
    await withTestHarness(async (harness) => {
      const root = join(harness.config.dataDir, "prepared-events-owner");
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "bb-plugin-arc-test",
          version: "0.1.0",
          bb: {
            name: "Prepared events owner",
            description: "Prepared events integration",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(root, "server.ts"),
        'export default function plugin(bb) { bb.agents.configure(() => ({ tools: [], skills: [], instructions: "Held prepared fixture" })); }',
      );
      await harness.pluginService.installPath(root);
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/workspace/held-worker",
      });
      const path = "/workspace/owned-held-worker";
      const request = preparedThreadRequestSchema.parse({
        ...preparationRequest(project.id, environment.id, "actual-api-prepare"),
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path },
        },
      });
      const api =
        harness.pluginService.getApi("arc-test")!.experimental_threads;
      const reserved = await api.prepare(request);
      const provision = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.initiator?.threadId === reserved.threadId,
      );
      expect(provisioningRows(harness, reserved.threadId).at(-1)?.status).toBe(
        "active",
      );
      noDispatch(harness, reserved.threadId);
      await reportQueuedCommandSuccess(harness, provision, {
        path,
        branchName: null,
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: true,
        transcript: [],
      });
      await expect
        .poll(
          async () =>
            (await api.getPreparation({ operationId: request.operationId }))
              ?.state,
        )
        .toBe("prepared");
      const before = provisioningRows(harness, reserved.threadId);
      expect(before.at(-1)?.status).toBe("completed");
      expect(before.filter((row) => row.status === "completed")).toHaveLength(
        1,
      );
      await api.prepare(request);
      expect(provisioningRows(harness, reserved.threadId)).toEqual(before);
      expect(getThread(harness.db, reserved.threadId)?.status).toBe("idle");
      noDispatch(harness, reserved.threadId);
    });
  });
});

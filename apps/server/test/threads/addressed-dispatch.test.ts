import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createThread, getThread, listEvents } from "@bb/db";
import { describe, expect, it } from "vitest";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import {
  readAddressedProvision,
  reserveAddressedCreation,
  persistAddressedProvision,
} from "../../src/services/threads/addressed-dispatch.js";
import { forgetActiveThreadProvisionContext } from "../../src/services/threads/thread-provisioning-active-context.js";
import { loadActiveThreadProvisionContext } from "../../src/services/threads/thread-provisioning-environment.js";
import { createMetadataPendingContext } from "../../src/services/threads/thread-provisioning-context.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function fixture(
  harness: TestAppHarness,
  source = `export default function plugin(bb) { let calls = 0; bb.ui.experimental_registerAddressedDispatch(async (context) => ({runId: "run-" + (++calls), status: "started", summary: context.prompt[0].text, path: "/plugins/addressed-test/runs/run-" + calls})); }`,
) {
  const root = join(harness.config.dataDir, "addressed-fixture");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "bb-plugin-addressed-test",
      version: "0.1.0",
      bb: {
        name: "Addressed test",
        description: "Addressed dispatch test",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(root, "server.ts"), source);
  await harness.pluginService.installPath(root);
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/addressed-project",
  });
  const environment = seedEnvironment(harness.deps, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/addressed-project",
  });
  const addressing = {
    operationId: randomUUID(),
    recipients: [
      {
        pluginId: "addressed-test",
        kind: "team" as const,
        entityId: "team-a",
        versionId: 1,
        scopeKey: `project:${project.id}`,
        label: "Research",
      },
    ],
  };
  return { project, environment, addressing };
}

describe("addressed composer dispatch", () => {
  it("rejects owned worker senders before dispatch, receipt replay, or retry on any main conversation", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(harness);
      const parent = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const other = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const workerApi =
        harness.pluginService.getApi("addressed-test")!.experimental_threads;
      const worker = await workerApi.prepare({
        operationId: "protected-addressed-worker",
        projectId: project.id,
        parentThreadId: parent.id,
        parentNotification: "owner-controlled",
        executionContextId: "arc:protected-worker",
        title: "Owned worker",
        visibility: "visible",
        turnPolicy: "single",
        environment: { type: "reuse", environmentId: environment.id },
        execution: {
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        },
        input: textInput("Stay within admitted work"),
      });
      await expect
        .poll(
          async () =>
            (
              await workerApi.getPreparation({
                operationId: "protected-addressed-worker",
              })
            )?.state,
        )
        .toBe("prepared");
      expect(getThread(harness.db, worker.threadId)).toMatchObject({
        id: worker.threadId,
        parentThreadId: parent.id,
        originPluginId: "addressed-test",
        experimental_executionContextId: "arc:protected-worker",
      });
      const send = (threadId: string, senderThreadId?: string) =>
        harness.app.request(`/api/v1/threads/${threadId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: textInput("Coordinate the work"),
            mode: "auto",
            experimental_addressing: addressing,
            senderThreadId,
          }),
        });
      const rejection = (threadId: string) => ({
        status: 409,
        body:
          threadId === parent.id
            ? {
                code: "invalid_request",
                message:
                  "This worker's parent messages require its owner's admission; report the result in the worker conversation",
              }
            : {
                code: "addressed_worker_denied",
                message:
                  "Owned workers cannot send or retry coordinated work. Use the admitted run's message tools or report the result in the worker conversation.",
              },
      });
      for (const target of [parent, other]) {
        const denied = await send(target.id, worker.threadId);
        expect({ status: denied.status, body: await denied.json() }).toEqual(
          rejection(target.id),
        );
        expect(
          listEvents(harness.db, { threadId: target.id }).filter(
            (event) => event.type === "system/operation",
          ),
        ).toHaveLength(0);
      }
      const accepted = await send(parent.id);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        experimental_addressed: { runId: "run-1" },
      });
      const deniedReplay = await send(parent.id, worker.threadId);
      expect({
        status: deniedReplay.status,
        body: await deniedReplay.json(),
      }).toEqual(rejection(parent.id));
      for (const target of [parent, other]) {
        const deniedRetry = await harness.app.request(
          `/api/v1/threads/${target.id}/retry-addressed`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId: addressing.operationId,
              senderThreadId: worker.threadId,
            }),
          },
        );
        expect({
          status: deniedRetry.status,
          body: await deniedRetry.json(),
        }).toEqual(rejection(target.id));
      }
      const permittedRetry = await harness.app.request(
        `/api/v1/threads/${parent.id}/retry-addressed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: addressing.operationId }),
        },
      );
      expect(permittedRetry.status).toBe(200);
      expect(await permittedRetry.json()).toMatchObject({
        experimental_addressed: { runId: "run-1" },
      });
      expect(
        listEvents(harness.db, { threadId: parent.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(2);
    });
  });

  it("rejects addressed creation attributed to an admitted worker before creating another conversation", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(harness);
      const worker = createThread(harness.db, harness.deps.hub, {
        projectId: project.id,
        providerId: "codex",
        environmentId: environment.id,
        originPluginId: "addressed-test",
        experimental_executionContextId: "arc:owned-create",
        status: "idle",
      });
      await expect(
        createThreadFromRequest(harness.deps, {
          projectId: project.id,
          providerId: "codex",
          origin: "sdk",
          environment: { type: "reuse", environmentId: environment.id },
          input: textInput("Ordinary request"),
          startedOnBehalfOf: null,
          senderThreadId: worker.id,
        }),
      ).rejects.toThrow("requires experimental_addressing");
      for (const origin of [
        { senderThreadId: worker.id },
        { parentThreadId: worker.id },
        { sourceThreadId: worker.id, originKind: "fork" },
        {
          sourceThreadId: worker.id,
          originKind: "fork",
          startedOnBehalfOf: {
            initiator: "agent",
            senderThreadId: worker.id,
          },
        },
      ]) {
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            providerId: "codex",
            origin: "sdk",
            environment: { type: "reuse", environmentId: environment.id },
            input: textInput("Start independent work"),
            experimental_addressing: addressing,
            ...origin,
          }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "addressed_worker_denied",
        });
      }
    });
  });

  it("retries a failed first Send from durable context and reuses the successful receipt", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(
        harness,
        `export default function plugin(bb) { let calls = 0; bb.ui.experimental_registerAddressedDispatch(async (context) => { if (++calls === 1) throw new Error("Configure the project roles first"); return {runId:"retained-run",status:"started",summary:JSON.stringify({prompt:context.prompt,recipients:context.recipients,calls})}; }); }`,
      );
      const input = textInput("Preserve the exact initial request");
      input.push({
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/K/8AAAAASUVORK5CYII=",
      });
      const thread = await createThreadFromRequest(harness.deps, {
        projectId: project.id,
        providerId: "codex",
        environment: { type: "reuse", environmentId: environment.id },
        input,
        origin: "app",
        startedOnBehalfOf: null,
        experimental_addressing: addressing,
      });
      await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
      expect(readAddressedProvision(harness.db, thread.id)?.state).toBe(
        "failed",
      );
      const invoke = () =>
        harness.app.request(`/api/v1/threads/${thread.id}/retry-addressed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: addressing.operationId }),
        });
      const [first, replay] = await Promise.all([invoke(), invoke()]);
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(await replay.json()).toEqual(result);
      expect(JSON.parse(result.experimental_addressed.summary)).toEqual({
        prompt: input,
        recipients: addressing.recipients,
        calls: 2,
      });
      expect(readAddressedProvision(harness.db, thread.id)?.state).toBe(
        "completed",
      );
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      const wrongThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const denied = await harness.app.request(
        `/api/v1/threads/${wrongThread.id}/retry-addressed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: addressing.operationId }),
        },
      );
      expect(denied.status).toBe(404);
    });
  });
  it("serializes distinct first Sends for one conversation and deduplicates an in-flight replay", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(
        harness,
        `export default function plugin(bb) { let admitted = false; let calls = 0; bb.ui.experimental_registerAddressedDispatch(async () => { const existing = admitted; await new Promise(resolve => setTimeout(resolve, 25)); admitted = true; return {runId: "one-budget", status: existing ? "continued" : "started", summary: "dispatch-" + (++calls)}; }); }`,
      );
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const payload = {
        input: textInput("Initial work"),
        mode: "auto" as const,
        experimental_addressing: addressing,
      };
      const [first, second, replay] = await Promise.all([
        acceptThreadSendRequest(harness.deps, { thread, payload }),
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: {
            ...payload,
            input: textInput("Follow-up"),
            experimental_addressing: {
              ...addressing,
              operationId: randomUUID(),
            },
          },
        }),
        acceptThreadSendRequest(harness.deps, { thread, payload }),
      ]);
      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        experimental_addressed: { status: "started", summary: "dispatch-1" },
      });
      expect(second).toMatchObject({
        experimental_addressed: { status: "continued", summary: "dispatch-2" },
      });
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(4);
    });
  });
  it("routes active followups once without a provider turn and rejects changed operation input", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(harness);
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const payload = {
        input: textInput("Inspect the preview"),
        mode: "auto" as const,
        experimental_addressing: addressing,
      };
      const first = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload,
      });
      const replay = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload,
      });
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        delivery: "sent",
        experimental_addressed: { runId: "run-1" },
      });
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "system/operation",
        ),
      ).toHaveLength(2);
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: { ...payload, input: textInput("Different work") },
        }),
      ).rejects.toThrow("different input");
      await expect(
        acceptThreadSendRequest(harness.deps, {
          thread,
          payload: { ...payload, sendAt: Date.now() + 10000 },
        }),
      ).rejects.toThrow("sent now");
    });
  });

  it("prepares the first addressed workspace without starting the selected provider and reuses the created thread", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(harness);
      const request = {
        projectId: project.id,
        providerId: "codex",
        environment: { type: "reuse" as const, environmentId: environment.id },
        input: textInput("Build the page"),
        title: "Build the page",
        origin: "app" as const,
        startedOnBehalfOf: null,
        experimental_addressing: addressing,
      };
      const thread = await createThreadFromRequest(harness.deps, request);
      await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
      expect(readAddressedProvision(harness.db, thread.id)?.state).toBe(
        "completed",
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
      expect((await createThreadFromRequest(harness.deps, request)).id).toBe(
        thread.id,
      );
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "client/turn/requested",
        ),
      ).toHaveLength(1);
    });
  });

  it("restores addressed provisioning context from SQLite after its process cache is lost", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, addressing } = await fixture(harness);
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "starting",
      });
      const context = createMetadataPendingContext({
        clientRequestId: "creq_23456789ab",
        environmentIntent: { type: "reuse", environmentId: environment.id },
        execution: {
          model: "gpt-6-astra",
          reasoningLevel: "high",
          serviceTier: "default",
          permissionMode: "auto",
          source: "client/thread/start",
        },
        fork: null,
        input: textInput("Resume setup"),
        titleProvided: true,
        seedWithoutRun: false,
        experimental_addressing: addressing,
      });
      reserveAddressedCreation(
        harness.db,
        thread.id,
        addressing.operationId,
        "fingerprint",
      );
      persistAddressedProvision(harness.db, thread.id, context);
      forgetActiveThreadProvisionContext(thread.id);
      expect(loadActiveThreadProvisionContext(harness.deps, thread.id)).toEqual(
        context,
      );
    });
  });
});

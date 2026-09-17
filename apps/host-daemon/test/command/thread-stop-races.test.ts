import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeProcessExitInfo,
} from "@bb/agent-runtime";
import {
  createScriptedEchoRequestRecord,
  type ScriptedEchoLaunchScript,
  type ScriptedEchoRequestRecord,
} from "@bb/agent-runtime/test";
import { buildPluginHost, resolvePluginBuildToolchain } from "@bb/plugin-build";
import {
  encodeClientTurnRequestIdNumber,
  getThreadEventScopeTurnId,
  type ClientTurnRequestId,
  type ThreadEvent,
} from "@bb/domain";
import type {
  HostDaemonBridgeLaunch,
  HostDaemonOnlineRpcResponseMessage,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import {
  noopEventSink,
  resolveRuntimeBridgeLaunch,
  type CommandDispatchOptions,
  type CommandOf,
} from "../../src/command-dispatch-support.js";
import { CommandRouter } from "../../src/command-router.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import {
  cleanupTempDirs,
  createFakeWorkspace,
  makeDispatchOptions,
  makeTempDir,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
  fetchDispatchTestArtifact,
} from "./dispatch-helpers.js";

const ENVIRONMENT_ID = "env-stop-race";
const THREAD_STOP_ACTIVE_TURN_WAIT_MS = 5_000;

interface RaceHarness {
  dispatchOptions: CommandDispatchOptions;
  events: ThreadEvent[];
  launch: HostDaemonBridgeLaunch;
  manager: RuntimeManager;
  unexpectedProcessExit: Promise<AgentRuntimeProcessExitInfo>;
  record: ScriptedEchoRequestRecord;
  requireRuntime: () => AgentRuntime;
  workspacePath: string;
}

interface ThreadStartArgs {
  threadId: string;
  providerId?: string;
  inputText?: string;
  bridgeLaunch?: HostDaemonBridgeLaunch;
}

interface TurnSubmitArgs {
  threadId: string;
  inputText: string;
}

const managers: RuntimeManager[] = [];
let nextClientRequestIdValue = 1;
let nextRpcRequestIdValue = 1;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
  await cleanupTempDirs();
});

function nextClientRequestId(): ClientTurnRequestId {
  const requestId = encodeClientTurnRequestIdNumber({
    value: nextClientRequestIdValue,
  });
  nextClientRequestIdValue += 1;
  return requestId;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

let scriptedEchoArtifact: Promise<{
  bytes: Uint8Array;
  digest: string;
}> | null = null;

function buildScriptedEchoArtifact(): Promise<{
  bytes: Uint8Array;
  digest: string;
}> {
  scriptedEchoArtifact ??= (async () => {
    const rootDir = fileURLToPath(
      new URL("../../../../tests/scripted-echo-provider", import.meta.url),
    );
    const toolchain = await resolvePluginBuildToolchain(
      path.join(os.tmpdir(), "bb-plugin-build-toolchain"),
    );
    const build = await buildPluginHost(rootDir, "0.0.0-test", toolchain);
    return {
      bytes: await readFile(build.jsPath),
      digest: build.artifactDigest,
    };
  })();
  return scriptedEchoArtifact;
}

async function scriptedEchoDispatchLaunch(
  options: { pluginId?: string; scripted?: ScriptedEchoLaunchScript } = {},
): Promise<HostDaemonBridgeLaunch> {
  const artifact = await buildScriptedEchoArtifact();
  return {
    pluginId: options.pluginId ?? "provider-scripted-echo",
    source: {
      kind: "artifact",
      digest: artifact.digest,
      byteLength: artifact.bytes.byteLength,
    },
    providerOptions:
      options.scripted === undefined
        ? {}
        : { scripted: JSON.parse(JSON.stringify(options.scripted)) },
    envPassthrough: [],
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: false,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint",
    },
  };
}

async function createRaceHarness(): Promise<RaceHarness> {
  const workspacePath = await makeTempDir("bb-stop-race-workspace-");
  const events: ThreadEvent[] = [];
  const record = createScriptedEchoRequestRecord();
  let resolveUnexpectedProcessExit: (
    info: AgentRuntimeProcessExitInfo,
  ) => void = () => undefined;
  const unexpectedProcessExit = new Promise<AgentRuntimeProcessExitInfo>(
    (resolve) => {
      resolveUnexpectedProcessExit = resolve;
    },
  );
  let runtime: AgentRuntime | null = null;
  const manager = new RuntimeManager({
    provisionWorkspace: async () =>
      createFakeWorkspace(workspacePath).workspace,
    createRuntime: (options) => {
      runtime = createAgentRuntime({
        ...options,
        env: { ...options.env, ...record.env },
      });
      return runtime;
    },
    onEvent: ({ event }) => {
      events.push(event);
    },
    onProcessExit: (info) => {
      if (!info.expected) {
        resolveUnexpectedProcessExit(info);
      }
    },
  });
  managers.push(manager);

  const artifact = await buildScriptedEchoArtifact();
  const dataDir = await makeTempDir("bb-stop-race-daemon-data-");
  return {
    dispatchOptions: makeDispatchOptions({
      runtimeManager: manager,
      dataDir,
      fetchPluginHostArtifact: async ({ digest }) => {
        if (digest !== artifact.digest) {
          throw new Error(`unknown plugin host artifact ${digest}`);
        }
        return artifact.bytes;
      },
    }),
    events,
    launch: await scriptedEchoDispatchLaunch(),
    manager,
    record,
    requireRuntime: () => {
      if (!runtime) {
        throw new Error("Runtime has not been created yet");
      }
      return runtime;
    },
    unexpectedProcessExit,
    workspacePath,
  };
}

function threadStartCommand(
  harness: RaceHarness,
  args: ThreadStartArgs,
): CommandOf<"thread.start"> {
  return {
    bridgeLaunch: args.bridgeLaunch ?? harness.launch,
    type: "thread.start",
    environmentId: ENVIRONMENT_ID,
    threadId: args.threadId,
    workspaceContext: {
      workspacePath: harness.workspacePath,
      workspaceProvisionType: "unmanaged",
    },
    projectId: "project-stop-race",
    providerId: args.providerId ?? "fake",
    requestId: nextClientRequestId(),
    input:
      args.inputText === undefined
        ? []
        : [{ type: "text", text: args.inputText, mentions: [] }],
    options: {
      model: "fake-model",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
    contributedEnv: [],
    injectedSkillSources: [],
    instructionMode: "append",
  };
}

function turnSubmitCommand(
  harness: RaceHarness,
  args: TurnSubmitArgs,
): CommandOf<"turn.submit"> {
  return {
    bridgeLaunch: harness.launch,
    type: "turn.submit",
    environmentId: ENVIRONMENT_ID,
    threadId: args.threadId,
    requestId: nextClientRequestId(),
    input: [{ type: "text", text: args.inputText, mentions: [] }],
    options: {
      model: "fake-model",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    resumeContext: {
      bridgeLaunch: harness.launch,
      workspaceContext: {
        workspacePath: harness.workspacePath,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "project-stop-race",
      providerId: "fake",
      providerThreadId: "prov-1",
      instructions: "Be a helpful coding agent.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    },
    target: { mode: "start" },
  };
}

function threadStopCommand(threadId: string): CommandOf<"thread.stop"> {
  return {
    type: "thread.stop",
    intent: "interrupt",
    environmentId: ENVIRONMENT_ID,
    threadId,
  };
}

function recordedThreadStops(harness: RaceHarness): Record<string, unknown>[] {
  return harness.record
    .read()
    .filter((request) => request.method === "thread/stop")
    .map((request) => request.params ?? {});
}

function routerStop(
  router: CommandRouter,
  threadId: string,
): Promise<HostDaemonOnlineRpcResponseMessage> {
  const requestId = `stop-race-rpc-${nextRpcRequestIdValue}`;
  nextRpcRequestIdValue += 1;
  return router.handleOnlineRpcRequest({
    type: "host-rpc.request",
    requestId,
    command: threadStopCommand(threadId),
  });
}

function conditionalStop(
  command: CommandOf<"thread.start"> | CommandOf<"turn.submit">,
  turnId: string | null,
): CommandOf<"turn.stop-if-current"> {
  return {
    type: "turn.stop-if-current",
    environmentId: command.environmentId,
    threadId: command.threadId,
    expectedClientRequestId: command.requestId,
    expectedTurnId: turnId,
  };
}

function raceRouter(harness: RaceHarness) {
  return new CommandRouter({
    ...harness.dispatchOptions,
    runtimeManager: harness.manager,
    logger: { debug: () => undefined, warn: () => undefined },
    threadStorageRootPath: path.join(harness.workspacePath, "thread-storage"),
  });
}

function routerCommand(
  router: CommandRouter,
  command:
    | CommandOf<"thread.start">
    | CommandOf<"turn.submit">
    | CommandOf<"turn.stop-if-current">,
) {
  return router
    .handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: `conditional-stop-${nextRpcRequestIdValue++}`,
      command,
    })
    .then((response) => {
      if (!response.ok)
        throw new Error(
          `${command.type}: ${response.errorCode}: ${response.errorMessage}`,
        );
      return response;
    });
}

async function acceptedTurn(
  harness: RaceHarness,
  command: CommandOf<"thread.start"> | CommandOf<"turn.submit">,
) {
  await vi.waitFor(() => {
    expect(
      harness.events.some(
        (event) =>
          event.type === "turn/input/accepted" &&
          event.clientRequestId === command.requestId,
      ),
    ).toBe(true);
  });
  const event = harness.events.find(
    (event) =>
      event.type === "turn/input/accepted" &&
      event.clientRequestId === command.requestId,
  );
  const turnId = event
    ? (getThreadEventScopeTurnId(event.scope) ?? null)
    : null;
  if (turnId === null) throw new Error("Accepted native turn identity missing");
  return turnId;
}

describe("turn.stop-if-current native identity", () => {
  it("stops exactly the accepted request once and preserves the settled identity on replay", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const command = threadStartCommand(harness, {
      threadId: "conditional-exact",
      inputText: "delay:60000",
    });
    expect((await routerCommand(router, command)).ok).toBe(true);
    const turnId = await acceptedTurn(harness, command);
    const [first, second] = await Promise.all([
      routerCommand(router, conditionalStop(command, turnId)),
      routerCommand(router, conditionalStop(command, turnId)),
    ]);
    expect(first).toMatchObject({
      ok: true,
      result: { status: "stopped", clientRequestId: command.requestId, turnId },
    });
    expect(second).toMatchObject({
      ok: true,
      result: {
        status: "already-settled",
        clientRequestId: command.requestId,
        turnId,
      },
    });
    expect(recordedThreadStops(harness)).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === "turn/completed"),
    ).toEqual([expect.objectContaining({ status: "interrupted" })]);
  });

  it("cannot interrupt a newer manual turn after the owned request completed", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const owned = threadStartCommand(harness, {
      threadId: "conditional-newer",
      inputText: "old owned input",
    });
    expect((await routerCommand(router, owned)).ok).toBe(true);
    const oldTurnId = await acceptedTurn(harness, owned);
    await vi.waitFor(() =>
      expect(
        harness.events.some(
          (event) =>
            event.type === "turn/completed" &&
            getThreadEventScopeTurnId(event.scope) === oldTurnId,
        ),
      ).toBe(true),
    );
    expect(
      await routerCommand(router, conditionalStop(owned, oldTurnId)),
    ).toMatchObject({ ok: true, result: { status: "already-settled" } });
    const manual = turnSubmitCommand(harness, {
      threadId: owned.threadId,
      inputText: "delay:60000 manual input",
    });
    expect((await routerCommand(router, manual)).ok).toBe(true);
    const newTurnId = await acceptedTurn(harness, manual);
    expect(
      await routerCommand(router, conditionalStop(owned, oldTurnId)),
    ).toMatchObject({
      ok: true,
      result: {
        status: "not-current",
        clientRequestId: manual.requestId,
        turnId: newTurnId,
      },
    });
    expect(recordedThreadStops(harness)).toHaveLength(0);
    expect(harness.requireRuntime().getActiveTurnId(owned.threadId)).toBe(
      newTurnId,
    );
  });

  it("protects a newer input accepted into the same native turn and rejects a mismatched expected turn", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const owned = threadStartCommand(harness, {
      threadId: "conditional-steered",
      inputText: "delay:60000 owned input",
    });
    expect((await routerCommand(router, owned)).ok).toBe(true);
    const turnId = await acceptedTurn(harness, owned);
    const manual = turnSubmitCommand(harness, {
      threadId: owned.threadId,
      inputText: "manual steering input",
    });
    manual.target = { mode: "steer", expectedTurnId: turnId };
    expect((await routerCommand(router, manual)).ok).toBe(true);
    expect(await acceptedTurn(harness, manual)).toBe(turnId);
    expect(
      await routerCommand(router, conditionalStop(owned, turnId)),
    ).toMatchObject({
      ok: true,
      result: {
        status: "not-current",
        clientRequestId: manual.requestId,
        turnId,
      },
    });
    expect(
      await routerCommand(router, conditionalStop(manual, "foreign-turn")),
    ).toMatchObject({ ok: true, result: { status: "not-current" } });
    expect(recordedThreadStops(harness)).toHaveLength(0);
    expect(harness.requireRuntime().getActiveTurnId(owned.threadId)).toBe(
      turnId,
    );
  });

  it("does not release another environment when the requested runtime is missing", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const command = threadStartCommand(harness, {
      threadId: "conditional-wrong-environment",
      inputText: "delay:60000",
    });
    expect((await routerCommand(router, command)).ok).toBe(true);
    const turnId = await acceptedTurn(harness, command);
    expect(
      await routerCommand(router, {
        ...conditionalStop(command, turnId),
        environmentId: "missing-environment",
      }),
    ).toMatchObject({
      ok: true,
      result: { status: "unknown", clientRequestId: null, turnId: null },
    });
    expect(recordedThreadStops(harness)).toHaveLength(0);
    expect(harness.requireRuntime().getActiveTurnId(command.threadId)).toBe(
      turnId,
    );
  });

  it("serializes a conditional stop behind an admitted pending start without allowing a later dispatch", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const command = threadStartCommand(harness, {
      threadId: "conditional-pending-start",
      inputText: "delay:60000",
      bridgeLaunch: await scriptedEchoDispatchLaunch({
        scripted: { startDelayMs: 120 },
      }),
    });
    const [start, stop] = await Promise.all([
      routerCommand(router, command),
      routerCommand(router, conditionalStop(command, null)),
    ]);
    expect(start).toMatchObject({ ok: true });
    const turnId = await acceptedTurn(harness, command);
    expect(stop).toMatchObject({
      ok: true,
      result: { status: "stopped", clientRequestId: command.requestId, turnId },
    });
    expect(
      harness.record
        .read()
        .filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    expect(recordedThreadStops(harness)).toHaveLength(1);
    expect(
      harness.requireRuntime().getActiveTurnId(command.threadId),
    ).toBeNull();
    expect(harness.requireRuntime().hasThread(command.threadId)).toBe(false);
  });

  it("retains an unaccepted provider start as unknown instead of falsely acknowledging cancellation", async () => {
    const harness = await createRaceHarness();
    const router = raceRouter(harness);
    const command = threadStartCommand(harness, {
      threadId: "conditional-unaccepted",
      inputText: "delay:60000",
    });
    command.options.providerOptions = { scripted: { swallowTurnStart: true } };
    expect((await routerCommand(router, command)).ok).toBe(true);
    expect(
      harness.events.some((event) => event.type === "turn/input/accepted"),
    ).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = routerCommand(router, conditionalStop(command, null));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    expect(await stop).toMatchObject({
      ok: true,
      result: {
        status: "unknown",
        clientRequestId: command.requestId,
        turnId: null,
      },
    });
    expect(recordedThreadStops(harness)).toHaveLength(0);
    expect(harness.requireRuntime().hasThread(command.threadId)).toBe(true);
    expect(
      harness.events.some((event) => event.type === "turn/completed"),
    ).toBe(false);
  });
});

describe("thread.stop race semantics", () => {
  it("resolves a stop dispatched before turn/started event-driven and stops the right turn", async () => {
    const harness = await createRaceHarness();
    await dispatchCommand(
      threadStartCommand(harness, { threadId: "t-race" }),
      harness.dispatchOptions,
    );
    const runtime = harness.requireRuntime();
    expect(runtime.hasThread("t-race")).toBe(true);
    expect(runtime.getActiveTurnId("t-race")).toBeNull();

    const stopPromise = dispatchCommand(
      threadStopCommand("t-race"),
      harness.dispatchOptions,
    );
    await flushMicrotasks();
    expect(recordedThreadStops(harness)).toHaveLength(0);

    const submitPromise = dispatchCommand(
      turnSubmitCommand(harness, {
        threadId: "t-race",
        inputText: "delay:60000",
      }),
      harness.dispatchOptions,
    );
    await expect(stopPromise).resolves.toEqual({ providerCheckpointId: null });
    await expect(submitPromise).resolves.toEqual({ appliedAs: "new-turn" });

    expect(recordedThreadStops(harness)).toEqual([
      expect.objectContaining({
        threadId: "t-race",
        intent: "interrupt",
        activeTurnId: "turn-1",
      }),
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t-race",
        status: "interrupted",
      }),
    );
    expect(runtime.getActiveTurnId("t-race")).toBeNull();
    expect(runtime.hasThread("t-race")).toBe(false);
  });

  it("noops a stop after the turn-start wait times out without hanging", async () => {
    const harness = await createRaceHarness();
    await dispatchCommand(
      threadStartCommand(harness, { threadId: "t-idle" }),
      harness.dispatchOptions,
    );
    const runtime = harness.requireRuntime();
    expect(runtime.getActiveTurnId("t-idle")).toBeNull();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopPromise = dispatchCommand(
      threadStopCommand("t-idle"),
      harness.dispatchOptions,
    );
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(THREAD_STOP_ACTIVE_TURN_WAIT_MS);
    vi.useRealTimers();

    await expect(stopPromise).resolves.toEqual({ providerCheckpointId: null });
    expect(recordedThreadStops(harness)).toEqual([
      expect.objectContaining({
        threadId: "t-idle",
        intent: "release",
        activeTurnId: null,
      }),
    ]);
    expect(runtime.hasThread("t-idle")).toBe(false);
    expect(
      harness.events.filter((event) => event.type === "turn/completed"),
    ).toEqual([]);
  });

  it("clears the active turn when the provider crashes mid-turn so a later stop noops", async () => {
    const harness = await createRaceHarness();
    const crasherLaunch = await scriptedEchoDispatchLaunch({
      pluginId: "provider-crasher",
      scripted: { exitAfter: "turn/start" },
    });
    const entry = await harness.manager.ensureEnvironment({
      environmentId: ENVIRONMENT_ID,
      workspacePath: harness.workspacePath,
      workspaceProvisionType: "unmanaged",
    });
    const healthyLaunch = await resolveRuntimeBridgeLaunch(
      harness.launch,
      harness.dispatchOptions,
    );
    const healthyStart = entry.runtime.ensureProvider({
      providerId: "fake",
      bridgeLaunch: healthyLaunch,
    });
    const crashStart = dispatchCommand(
      threadStartCommand(harness, {
        threadId: "t-crash",
        providerId: "crasher",
        inputText: "boom",
        bridgeLaunch: crasherLaunch,
      }),
      harness.dispatchOptions,
    );
    await Promise.all([healthyStart, crashStart]);

    const crashExit = await harness.unexpectedProcessExit;
    expect(crashExit.providerId).toBe("crasher");
    expect(crashExit.threads).toEqual([
      expect.objectContaining({
        threadId: "t-crash",
        providerThreadId: "prov-1",
        activeTurnId: expect.any(String),
      }),
    ]);
    const runtime = harness.requireRuntime();
    expect(runtime.getActiveTurnId("t-crash")).toBeNull();
    expect(runtime.hasThread("t-crash")).toBe(false);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t-crash",
        status: "failed",
      }),
    );
    expect(await harness.manager.getOrAwait(ENVIRONMENT_ID)).toBe(entry);

    await expect(
      dispatchCommand(threadStopCommand("t-crash"), harness.dispatchOptions),
    ).resolves.toEqual({ providerCheckpointId: null });
    expect(recordedThreadStops(harness)).toHaveLength(0);
  });

  it("treats the second of two racing stops as an idempotent no-op", async () => {
    const harness = await createRaceHarness();
    const router = new CommandRouter({
      dataDir: "/tmp/bb-stop-race-data",
      eventSink: noopEventSink,
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      logger: { debug: () => undefined, warn: () => undefined },
      runtimeManager: harness.manager,
      threadStorageRootPath: "/tmp/bb-stop-race-thread-storage",
    });
    await dispatchCommand(
      threadStartCommand(harness, {
        threadId: "t-double",
        inputText: "delay:60000",
      }),
      harness.dispatchOptions,
    );
    const runtime = harness.requireRuntime();
    await vi.waitFor(
      () => {
        expect(runtime.getActiveTurnId("t-double")).not.toBeNull();
      },
      { timeout: 5_000 },
    );

    const [firstStop, secondStop] = await Promise.all([
      routerStop(router, "t-double"),
      routerStop(router, "t-double"),
    ]);

    expect(firstStop.ok).toBe(true);
    expect(secondStop.ok).toBe(true);
    expect(recordedThreadStops(harness)).toHaveLength(1);
    expect(
      harness.events.filter(
        (event) =>
          event.type === "turn/completed" && event.threadId === "t-double",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "interrupted",
      }),
    ]);
    expect(runtime.hasThread("t-double")).toBe(false);
  });
});

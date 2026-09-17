import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeControl = vi.hoisted(() => ({
  enabled: false,
  onStarted: (): void => {},
  pauseUntil: Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      if (writeControl.enabled) {
        await original.writeFile(args[0], "", args[2]);
        writeControl.onStarted();
        await writeControl.pauseUntil;
      }
      await original.writeFile(...args);
    },
  };
});

import {
  readOwnedRuntimePidFile,
  reapStaleOwnedRuntime,
  stopOwnedRuntimeAndRelease,
  writeOwnedRuntimePidFile,
  type OwnedRuntimeProcessOps,
  type WaitForProcessExitArgs,
} from "../src/owned-runtime-supervisor.js";
import { handleDesktopQuit } from "../src/desktop-shutdown.js";

interface TempDir {
  path: string;
}

interface FakeProcessOps {
  killedSignals: NodeJS.Signals[];
  ops: OwnedRuntimeProcessOps;
}

interface CreateFakeProcessOpsArgs {
  command: string | null;
  running: boolean;
}

const tempDirs: TempDir[] = [];

async function createTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "bb-desktop-supervisor-"));
  const tempDir = { path };
  tempDirs.push(tempDir);
  return tempDir;
}

function createFakeProcessOps(args: CreateFakeProcessOpsArgs): FakeProcessOps {
  let running = args.running;
  const killedSignals: NodeJS.Signals[] = [];
  const ops: OwnedRuntimeProcessOps = {
    isRunning() {
      return running;
    },
    kill(_pid, signal) {
      killedSignals.push(signal);
      running = false;
    },
    async readCommand() {
      return args.command;
    },
    async readElapsedSeconds() {
      return 0;
    },
    async waitForExit(_args: WaitForProcessExitArgs) {
      return !running;
    },
  };
  return { killedSignals, ops };
}

afterEach(async () => {
  writeControl.enabled = false;
  writeControl.onStarted = (): void => {};
  writeControl.pauseUntil = Promise.resolve();
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir !== undefined) {
      await rm(tempDir.path, { force: true, recursive: true });
    }
  }
});

describe("owned runtime supervisor", () => {
  it("retains ownership after failed quit cleanup and releases it after a confirmed retry", async () => {
    const tempDir = await createTempDir();
    await writeOwnedRuntimePidFile({
      bridgePath: "/Applications/ARC/bb-app-bridge.mjs",
      pid: 12345,
      serverUrl: "http://127.0.0.1:38986",
      userDataPath: tempDir.path,
    });
    const pidFilePath = join(tempDir.path, "owned-runtime.json");
    const original = await readFile(pidFilePath, "utf8");
    const failure = new Error("The owned Windows runtime did not exit");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const onError = vi.fn();
    const quitApplication = vi.fn();
    let runtimeOwned = true;
    const stopRuntime = () =>
      stopOwnedRuntimeAndRelease({
        release() {
          runtimeOwned = false;
        },
        stop,
        userDataPath: tempDir.path,
      });

    await expect(
      handleDesktopQuit({
        finishQuit: stopRuntime,
        onError,
        quitApplication,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(quitApplication).toHaveBeenCalledTimes(1);
    expect(runtimeOwned).toBe(true);
    expect(await readFile(pidFilePath, "utf8")).toBe(original);

    await stopRuntime();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(runtimeOwned).toBe(false);
    await expect(
      readOwnedRuntimePidFile({ userDataPath: tempDir.path }),
    ).resolves.toBeNull();
  });

  it("does not publish incomplete pid file JSON", async () => {
    const tempDir = await createTempDir();
    let releaseWrite = (): void => {};
    writeControl.pauseUntil = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      writeControl.onStarted = resolve;
    });
    writeControl.enabled = true;

    const writePromise = writeOwnedRuntimePidFile({
      bridgePath: "/tmp/app/resources/app.asar.unpacked/bb-app-bridge.mjs",
      pid: 12345,
      serverUrl: "http://127.0.0.1:38886",
      userDataPath: tempDir.path,
    });
    await writeStarted;
    const [observation] = await Promise.allSettled([
      readFile(join(tempDir.path, "owned-runtime.json"), "utf8").then((raw) =>
        JSON.parse(raw),
      ),
    ]);

    releaseWrite();
    await writePromise;

    expect(observation).toMatchObject({
      reason: { code: "ENOENT" },
      status: "rejected",
    });
    await expect(
      readOwnedRuntimePidFile({ userDataPath: tempDir.path }),
    ).resolves.toMatchObject({
      bridgePath: "/tmp/app/resources/app.asar.unpacked/bb-app-bridge.mjs",
      pid: 12345,
      serverUrl: "http://127.0.0.1:38886",
    });
  });

  it("reaps a stale Electron-owned bb-app bridge process", async () => {
    const tempDir = await createTempDir();
    const bridgePath = "/Applications/bb.app/bb-app-bridge.mjs";
    const fakeProcessOps = createFakeProcessOps({
      command: `/Applications/bb.app/Contents/MacOS/bb ${bridgePath}`,
      running: true,
    });

    await writeOwnedRuntimePidFile({
      bridgePath,
      pid: 12345,
      serverUrl: "http://127.0.0.1:38886",
      userDataPath: tempDir.path,
    });

    await expect(
      reapStaleOwnedRuntime({
        processOps: fakeProcessOps.ops,
        signal: "SIGTERM",
        timeoutMs: 100,
        userDataPath: tempDir.path,
      }),
    ).resolves.toEqual({
      kind: "reaped",
      pid: 12345,
    });
    expect(fakeProcessOps.killedSignals).toEqual(["SIGTERM"]);
    await expect(
      readOwnedRuntimePidFile({ userDataPath: tempDir.path }),
    ).resolves.toBeNull();
  });

  it("does not kill a PID that no longer matches the owned bridge command", async () => {
    const tempDir = await createTempDir();
    const bridgePath = "/Applications/bb.app/bb-app-bridge.mjs";
    const fakeProcessOps = createFakeProcessOps({
      command: "/usr/bin/vim",
      running: true,
    });

    await writeOwnedRuntimePidFile({
      bridgePath,
      pid: 12345,
      serverUrl: "http://127.0.0.1:38886",
      userDataPath: tempDir.path,
    });

    const result = await reapStaleOwnedRuntime({
      processOps: fakeProcessOps.ops,
      signal: "SIGTERM",
      timeoutMs: 100,
      userDataPath: tempDir.path,
    });

    expect(result.kind).toBe("skipped-unverified-process");
    expect(fakeProcessOps.killedSignals).toEqual([]);
  });

  it("clears a stale pid file when the process is already gone", async () => {
    const tempDir = await createTempDir();
    const bridgePath = "/Applications/bb.app/bb-app-bridge.mjs";
    const fakeProcessOps = createFakeProcessOps({
      command: null,
      running: false,
    });

    await writeOwnedRuntimePidFile({
      bridgePath,
      pid: 12345,
      serverUrl: "http://127.0.0.1:38886",
      userDataPath: tempDir.path,
    });

    await expect(
      reapStaleOwnedRuntime({
        processOps: fakeProcessOps.ops,
        signal: "SIGTERM",
        timeoutMs: 100,
        userDataPath: tempDir.path,
      }),
    ).resolves.toEqual({
      kind: "cleared-stale-pid-file",
      pid: 12345,
    });
    await expect(
      readOwnedRuntimePidFile({ userDataPath: tempDir.path }),
    ).resolves.toBeNull();
  });
});

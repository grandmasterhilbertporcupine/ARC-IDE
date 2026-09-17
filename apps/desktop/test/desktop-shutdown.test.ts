import { describe, expect, it, vi } from "vitest";
import {
  createDesktopShutdownState,
  handleDesktopShutdownSignal,
  registerDesktopShutdownSignalHandlers,
  type DesktopSignalListener,
  type DesktopSignalProcess,
  type DesktopShutdownSignal,
} from "../src/desktop-shutdown.js";

class FakeSignalProcess implements DesktopSignalProcess {
  private listeners: Record<DesktopShutdownSignal, DesktopSignalListener[]> = {
    SIGINT: [],
    SIGTERM: [],
  };

  emit(signal: DesktopShutdownSignal): void {
    for (const listener of this.listeners[signal]) {
      listener();
    }
  }

  off(signal: DesktopShutdownSignal, listener: DesktopSignalListener): void {
    this.listeners[signal] = this.listeners[signal].filter(
      (currentListener) => currentListener !== listener,
    );
  }

  on(signal: DesktopShutdownSignal, listener: DesktopSignalListener): void {
    this.listeners[signal].push(listener);
  }
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 0);
  });
}

describe("desktop shutdown supervision", () => {
  it("stops the owned runtime before quitting on SIGTERM", async () => {
    const state = createDesktopShutdownState();
    const calls: string[] = [];
    let exitCode: number | null = null;

    await handleDesktopShutdownSignal({
      exitProcess(code) {
        exitCode = code;
      },
      onError: vi.fn(),
      quitApplication() {
        calls.push("quit");
      },
      signal: "SIGTERM",
      state,
      async stopOwnedRuntime() {
        calls.push("stop");
      },
    });

    expect(calls).toEqual(["stop", "quit"]);
    expect(exitCode).toBe(143);
  });

  it("registers removable SIGINT and SIGTERM handlers", async () => {
    const fakeProcess = new FakeSignalProcess();
    const state = createDesktopShutdownState();
    let stopCount = 0;
    let quitCount = 0;
    let exitCode: number | null = null;

    const registeredHandlers = registerDesktopShutdownSignalHandlers({
      exitProcess(code) {
        exitCode = code;
      },
      onError: vi.fn(),
      processEvents: fakeProcess,
      quitApplication() {
        quitCount += 1;
      },
      state,
      async stopOwnedRuntime() {
        stopCount += 1;
      },
    });

    fakeProcess.emit("SIGINT");
    await flushPromises();
    registeredHandlers.remove();
    fakeProcess.emit("SIGTERM");
    await flushPromises();

    expect(stopCount).toBe(1);
    expect(quitCount).toBe(1);
    expect(exitCode).toBe(130);
  });

  it("reports a failed stop and permits a later signal to retry", async () => {
    const fakeProcess = new FakeSignalProcess();
    const state = createDesktopShutdownState();
    const failure = new Error("Owned process tree still running");
    const onError = vi.fn();
    const exitProcess = vi.fn();
    const quitApplication = vi.fn();
    const stopOwnedRuntime = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce();
    const registeredHandlers = registerDesktopShutdownSignalHandlers({
      exitProcess,
      onError,
      processEvents: fakeProcess,
      quitApplication,
      state,
      stopOwnedRuntime,
    });

    try {
      fakeProcess.emit("SIGTERM");
      fakeProcess.emit("SIGINT");
      await flushPromises();

      expect(stopOwnedRuntime).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(state.inProgress).toBe(false);
      expect(quitApplication).not.toHaveBeenCalled();
      expect(exitProcess).not.toHaveBeenCalled();

      fakeProcess.emit("SIGTERM");
      await flushPromises();

      expect(stopOwnedRuntime).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(quitApplication).toHaveBeenCalledTimes(1);
      expect(exitProcess).toHaveBeenCalledWith(143);
    } finally {
      registeredHandlers.remove();
    }
  });
});

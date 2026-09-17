import type { IPty } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeManager } from "../runtime-manager.js";
import { TerminalManager } from "./terminal-manager.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: native.spawn }));
vi.mock("./preview-probe.js", () => ({ probeTerminalPreview: native.probe }));

afterEach(() => {
  native.spawn.mockReset();
  native.probe.mockReset();
});

it("observes a Windows PID assigned after native spawn through the production adapter", async () => {
  let connectedPid = 0;
  const exitListeners: ((event: { exitCode: number }) => void)[] = [];
  const pty: IPty & { destroy(): void } = {
    get pid() {
      return connectedPid;
    },
    cols: 100,
    rows: 30,
    process: "powershell.exe",
    handleFlowControl: false,
    onData: () => ({ dispose: vi.fn() }),
    onExit: (listener) => {
      exitListeners.push(listener);
      return { dispose: vi.fn() };
    },
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  };
  native.spawn.mockReturnValue(pty);
  native.probe.mockResolvedValue({
    state: "ready",
    statusCode: 200,
    reason: null,
  });
  const manager = new TerminalManager({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: "win32",
    resolveShell: async () => "powershell.exe",
    runtimeManager: new RuntimeManager({
      createRuntime: () => {
        throw new Error("Unexpected provider runtime");
      },
      provisionWorkspace: async () => {
        throw new Error("Unexpected workspace provisioning");
      },
    }),
    sendMessage: () => true,
  });
  await manager.handleMessage({
    type: "terminal.open",
    requestId: "open",
    terminalId: "preview",
    target: { kind: "host_path", cwd: process.cwd() },
    cols: 100,
    rows: 30,
    start: { mode: "command", command: "npm run dev" },
  });
  expect(native.spawn).toHaveBeenCalledTimes(1);
  expect(
    await manager.probePreview("preview", "http://localhost:3000/"),
  ).toMatchObject({ state: "unavailable" });
  expect(native.probe).not.toHaveBeenCalled();
  connectedPid = 43123;
  expect(
    await manager.probePreview("preview", "http://localhost:3000/"),
  ).toEqual({ state: "ready", statusCode: 200, reason: null });
  expect(native.probe).toHaveBeenCalledExactlyOnceWith(
    43123,
    "http://localhost:3000/",
    "win32",
  );
  exitListeners[0]?.({ exitCode: 0 });
  expect(
    await manager.probePreview("preview", "http://localhost:3000/"),
  ).toMatchObject({ state: "unavailable" });
  expect(native.probe).toHaveBeenCalledTimes(1);
});

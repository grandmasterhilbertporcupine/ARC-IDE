import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { BbDesktopSurfaceStyleResult } from "@bb/desktop-contract";
import { BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL } from "../src/desktop-update-ipc.js";

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  nativeTheme: {
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  },
  release: vi.fn(() => "10.0.22621"),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: { handle: electron.handle },
  nativeTheme: electron.nativeTheme,
}));
vi.mock("node:os", () => ({ release: electron.release }));

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;

beforeEach(() => {
  vi.clearAllMocks();
  electron.release.mockReturnValue("10.0.22621");
  Object.assign(electron.nativeTheme, {
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

async function setup(platform: NodeJS.Platform = "win32") {
  Object.defineProperty(process, "platform", { value: platform });
  const window = {
    isDestroyed: vi.fn(() => false),
    getBackgroundColor: vi.fn(() => "#1b2030"),
    setBackgroundColor: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    setVibrancy: vi.fn(),
  };
  electron.fromWebContents.mockReturnValue(window);
  const { registerDesktopSurfaceStyleIpc } =
    await import("../src/desktop-surface-style.js");
  registerDesktopSurfaceStyleIpc(new Set([17]));
  expect(electron.handle).toHaveBeenCalledWith(
    BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL,
    expect.any(Function),
  );
  const handler = electron.handle.mock.calls[0]![1] as (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ) => BbDesktopSurfaceStyleResult;
  const mainFrame = {};
  const sender = { id: 17, mainFrame };
  function invoke(payload: unknown, id = 17, frame: object | null = mainFrame) {
    return handler(
      {
        sender: { ...sender, id },
        senderFrame: frame,
      } as unknown as IpcMainInvokeEvent,
      payload,
    );
  }
  return { invoke, window };
}

describe("desktop surface style IPC", () => {
  it("applies Windows acrylic and restores the original background after repeated requests", async () => {
    const { invoke, window } = await setup();
    expect(invoke("liquid-glass")).toEqual({ material: "acrylic" });
    expect(invoke("liquid-glass")).toEqual({ material: "acrylic" });
    expect(window.getBackgroundColor).toHaveBeenCalledTimes(1);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith("acrylic");
    expect(invoke("default")).toEqual({ material: "none" });
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith("none");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1b2030");
    expect(window.setVibrancy).not.toHaveBeenCalled();
    invoke("liquid-glass");
    expect(window.getBackgroundColor).toHaveBeenCalledTimes(2);
  });

  it("uses macOS under-window vibrancy and removes it on default", async () => {
    const { invoke, window } = await setup("darwin");
    expect(invoke("liquid-glass")).toEqual({ material: "vibrancy" });
    expect(window.setVibrancy).toHaveBeenLastCalledWith("under-window");
    invoke("default");
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1b2030");
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled();
  });

  it.each(["10.0.19045", "10.0.22000", "unrecognized"])(
    "leaves unsupported Windows %s opaque",
    async (version) => {
      electron.release.mockReturnValue(version);
      const { invoke, window } = await setup();
      expect(invoke("liquid-glass")).toEqual({ material: "none" });
      expect(window.setBackgroundColor).not.toHaveBeenCalled();
      expect(window.setBackgroundMaterial).not.toHaveBeenCalled();
    },
  );

  it("does not change Linux backgrounds, including explicit transparent windows", async () => {
    const { invoke, window } = await setup("linux");
    window.getBackgroundColor.mockReturnValue("#00000000");
    expect(invoke("liquid-glass")).toEqual({ material: "none" });
    expect(invoke("default")).toEqual({ material: "none" });
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    expect(window.setVibrancy).not.toHaveBeenCalled();
  });

  it.each(["light", "reduced-transparency", "high-contrast"])(
    "restores opaque content when %s becomes active",
    async (preference) => {
      const { invoke, window } = await setup();
      invoke("liquid-glass");
      if (preference === "light")
        electron.nativeTheme.shouldUseDarkColors = false;
      if (preference === "reduced-transparency")
        electron.nativeTheme.prefersReducedTransparency = true;
      if (preference === "high-contrast")
        electron.nativeTheme.shouldUseHighContrastColors = true;
      expect(invoke("liquid-glass")).toEqual({ material: "none" });
      expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith("none");
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1b2030");
    },
  );

  it("rolls back partial native failures and reports no material", async () => {
    const { invoke, window } = await setup();
    window.setBackgroundMaterial.mockImplementationOnce(() => {
      throw new Error("DWM unavailable");
    });
    expect(invoke("liquid-glass")).toEqual({ material: "none" });
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1b2030");
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith("none");
  });

  it("rejects other windows, child frames, and invalid modes before touching a window", async () => {
    const { invoke, window } = await setup();
    expect(() => invoke("liquid-glass", 18)).toThrow("application main frame");
    expect(() => invoke("liquid-glass", 17, {})).toThrow(
      "application main frame",
    );
    expect(() => invoke("liquid-glass", 17, null)).toThrow(
      "application main frame",
    );
    expect(() => invoke("acrylic")).toThrow();
    expect(() => invoke({ style: "liquid-glass" })).toThrow();
    expect(electron.fromWebContents).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("reports no material when the sender's window has closed", async () => {
    const { invoke, window } = await setup();
    window.isDestroyed.mockReturnValue(true);
    expect(invoke("liquid-glass")).toEqual({ material: "none" });
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    electron.fromWebContents.mockReturnValue(null);
    expect(invoke("liquid-glass")).toEqual({ material: "none" });
  });
});

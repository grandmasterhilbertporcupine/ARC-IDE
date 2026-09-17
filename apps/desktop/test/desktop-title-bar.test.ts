import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL } from "../src/desktop-window-command-ipc.js";
import { registerDesktopTitleBarIpc } from "../src/desktop-title-bar.js";

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  ipcMain: { handle: electron.handle },
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => Object.defineProperty(process, "platform", platformDescriptor));

function setup() {
  const window = {
    isDestroyed: vi.fn(() => false),
    setTitleBarOverlay: vi.fn(),
  };
  electron.fromWebContents.mockReturnValue(window);
  registerDesktopTitleBarIpc(new Set([17]));
  expect(electron.handle).toHaveBeenCalledWith(
    BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL,
    expect.any(Function),
  );
  const handle = electron.handle.mock.calls[0]![1] as (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ) => void;
  const frame = {};
  function invoke(
    payload: unknown,
    id = 17,
    senderFrame: object | null = frame,
  ) {
    return handle(
      {
        sender: { id, mainFrame: frame },
        senderFrame,
      } as unknown as IpcMainInvokeEvent,
      payload,
    );
  }
  return { window, invoke };
}

describe("desktop title bar appearance IPC", () => {
  const colors = { color: "#182030ff", symbolColor: "#ffffff" };

  it("updates the requesting window's colors with the native-owned height", () => {
    const { window, invoke } = setup();
    invoke(colors);
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
      ...colors,
      height: 36,
    });
  });

  it("rejects unregistered windows, subframes and detached frames", () => {
    const { invoke, window } = setup();
    expect(() => invoke(colors, 18)).toThrow("Windows application main frame");
    expect(() => invoke(colors, 17, {})).toThrow(
      "Windows application main frame",
    );
    expect(() => invoke(colors, 17, null)).toThrow(
      "Windows application main frame",
    );
    expect(electron.fromWebContents).not.toHaveBeenCalled();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"])(
    "does not expose native styling on %s",
    (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const { invoke, window } = setup();
      expect(() => invoke(colors)).toThrow("Windows application main frame");
      expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...colors, color: "red" },
    { ...colors, symbolColor: "var(--ink)" },
    { ...colors, height: 1 },
    null,
  ])("rejects malformed appearance %j", (payload) => {
    const { invoke, window } = setup();
    expect(() => invoke(payload)).toThrow();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("tolerates a closed sender window without styling another one", () => {
    const { invoke, window } = setup();
    window.isDestroyed.mockReturnValue(true);
    invoke(colors);
    electron.fromWebContents.mockReturnValue(null);
    invoke(colors);
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("propagates native failures so the renderer can retain a fallback", () => {
    const { invoke, window } = setup();
    window.setTitleBarOverlay.mockImplementation(() => {
      throw new Error("Window unavailable");
    });
    expect(() => invoke(colors)).toThrow("Window unavailable");
  });
});

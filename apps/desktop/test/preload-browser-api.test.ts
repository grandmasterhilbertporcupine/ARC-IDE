import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCommandId } from "@bb/domain";
import type {
  BbDesktopApi,
  BbDesktopBrowserFindResult,
  BbDesktopBrowserOpenTabRequest,
  BbDesktopBrowserScopedOpenTabRequest,
  BbDesktopBrowserSnapshot,
  BbDesktopBrowserState,
  BbDesktopInfo,
  BbDesktopWindowState,
} from "@bb/desktop-contract";
import {
  BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  BB_DESKTOP_GET_INFO_CHANNEL,
  BB_DESKTOP_INFO_CHANGED_CHANNEL,
  BB_DESKTOP_INSTALL_UPDATE_CHANNEL,
  BB_DESKTOP_SET_THEME_CHANNEL,
  BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL,
} from "../src/desktop-update-ipc.js";
import {
  BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
  BB_DESKTOP_BROWSER_DETACH_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
  BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  BB_DESKTOP_BROWSER_STATE_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_CHANNEL,
  BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "../src/desktop-browser-ipc.js";
import {
  BB_DESKTOP_APP_COMMAND_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL,
  BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
} from "../src/desktop-window-command-ipc.js";
const electronMock = vi.hoisted(() => {
  interface IpcRendererEvent {}

  interface SendCall {
    channel: string;
    payload: unknown;
  }

  type IpcRendererListener = (
    event: IpcRendererEvent,
    payload: unknown,
  ) => void;

  const desktopInfo: BbDesktopInfo = {
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: "macos",
    updateAvailable: false,
    updateDownloaded: false,
    version: "0.0.0-test",
  };
  const desktopWindowState: BbDesktopWindowState = {
    isFullScreen: false,
  };
  const invokeCalls: string[] = [];
  const listeners = new Map<string, IpcRendererListener>();
  const sendCalls: SendCall[] = [];
  let exposedApi: BbDesktopApi | null = null;
  let exposedName: string | null = null;
  let zoomFactor = 1;

  return {
    get exposedApi() {
      return exposedApi;
    },
    get exposedName() {
      return exposedName;
    },
    invokeCalls,
    listeners,
    sendCalls,
    reset(): void {
      exposedApi = null;
      exposedName = null;
      invokeCalls.length = 0;
      listeners.clear();
      sendCalls.length = 0;
      zoomFactor = 1;
    },
    setZoomFactor(nextZoomFactor: number): void {
      zoomFactor = nextZoomFactor;
    },
    contextBridge: {
      exposeInMainWorld(name: string, api: unknown): void {
        if (name === "bbDesktop") {
          exposedName = name;
          exposedApi = api as BbDesktopApi;
        }
      },
    },
    ipcRenderer: {
      invoke(channel: string): Promise<unknown> {
        invokeCalls.push(channel);
        if (channel === "bb-desktop:get-window-state") {
          return Promise.resolve(desktopWindowState);
        }
        return Promise.resolve(desktopInfo);
      },
      on(channel: string, listener: IpcRendererListener): void {
        listeners.set(channel, listener);
      },
      send(channel: string, payload: unknown): void {
        sendCalls.push({ channel, payload });
      },
    },
    webFrame: {
      getZoomFactor(): number {
        return zoomFactor;
      },
    },
  };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllGlobals();
});

vi.mock("electron", () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
  webFrame: electronMock.webFrame,
}));

interface EmitIpcPayloadArgs {
  channel: string;
  payload: unknown;
}

async function loadPreload(): Promise<BbDesktopApi> {
  electronMock.reset();
  vi.resetModules();
  process.env.BB_DESKTOP_VERSION = "0.0.0-test";
  await import("../src/preload.js");
  const api = electronMock.exposedApi;
  expect(electronMock.exposedName).toBe("bbDesktop");
  expect(api).not.toBeNull();
  if (api === null) {
    throw new Error("Expected preload to expose window.bbDesktop.");
  }
  return api;
}

function emitIpcPayload(args: EmitIpcPayloadArgs): void {
  const listener = electronMock.listeners.get(args.channel);
  expect(listener).toBeDefined();
  if (listener === undefined) {
    throw new Error(`Expected listener for ${args.channel}.`);
  }
  listener({}, args.payload);
}

describe("desktop preload browser API", () => {
  let api: BbDesktopApi;

  beforeEach(async () => {
    api = await loadPreload();
  }, 30_000);

  it("exposes Windows title bar support and validates appearance before invoking native code", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    api = await loadPreload();
    const invoke = vi.spyOn(electronMock.ipcRenderer, "invoke");
    try {
      expect(api.titleBarOverlay).toBe(true);
      expect(api.setTitleBarAppearance).toBeTypeOf("function");
      const appearance = { color: "#182030ff", symbolColor: "#FFFFFF" };
      await api.setTitleBarAppearance?.(appearance);
      expect(invoke).toHaveBeenLastCalledWith(
        BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL,
        appearance,
      );
      invoke.mockClear();
      await expect(
        api.setTitleBarAppearance?.({
          color: "var(--canvas)",
          symbolColor: "#FFFFFF",
        }),
      ).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      invoke.mockRestore();
    }
  });

  it.each(["darwin", "linux"])(
    "omits the Windows title bar capability and command on %s",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      api = await loadPreload();
      expect(api).not.toHaveProperty("titleBarOverlay");
      expect(api).not.toHaveProperty("setTitleBarAppearance");
    },
  );

  it("forwards native window activation and accepts legacy fullscreen-only state", () => {
    const states: BbDesktopWindowState[] = [];
    api.onWindowStateChange?.((state) => states.push(state));
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: false, isFocused: true },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: true, isFocused: false },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: false, isFocused: "yes" },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: false },
    });
    expect(states).toEqual([
      { isFullScreen: false, isFocused: true },
      { isFullScreen: true, isFocused: false },
      { isFullScreen: false },
    ]);
  });

  it("keeps live window state when earlier native snapshot requests resolve late", async () => {
    let resolveSnapshot: (state: BbDesktopWindowState) => void = () => {
      throw new Error("Window snapshot promise is not initialized");
    };
    const snapshot = new Promise<BbDesktopWindowState>((resolve) => {
      resolveSnapshot = resolve;
    });
    const originalInvoke = electronMock.ipcRenderer.invoke;
    const invoke = vi
      .spyOn(electronMock.ipcRenderer, "invoke")
      .mockImplementation((channel) =>
        channel === BB_DESKTOP_GET_WINDOW_STATE_CHANNEL
          ? snapshot
          : originalInvoke(channel),
      );
    try {
      api = await loadPreload();
      const request = api.getWindowState?.();
      const states: BbDesktopWindowState[] = [];
      api.onWindowStateChange?.((state) => states.push(state));
      const liveState = { isFullScreen: true, isFocused: true };
      emitIpcPayload({
        channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
        payload: liveState,
      });
      resolveSnapshot({ isFullScreen: false, isFocused: false });
      await expect(request).resolves.toEqual(liveState);
      expect(states).toEqual([liveState]);
    } finally {
      invoke.mockRestore();
    }
  });

  it.each(["available", "loading"])(
    "reflects validated native fullscreen only on a local document with its root %s",
    async (rootState) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const root = {
        hasAttribute: vi.fn((name: string) => name === "data-bb-local-view"),
        setAttribute: vi.fn(),
      };
      let currentRoot = rootState === "loading" ? null : root;
      const readyListeners: (() => void)[] = [];
      vi.stubGlobal("document", {
        get documentElement() {
          return currentRoot;
        },
        addEventListener(event: string, listener: () => void) {
          if (event === "DOMContentLoaded") readyListeners.push(listener);
        },
      });
      api = await loadPreload();
      root.setAttribute.mockClear();
      emitIpcPayload({
        channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
        payload: { isFullScreen: true, isFocused: true },
      });
      if (rootState === "loading") {
        expect(root.setAttribute).not.toHaveBeenCalled();
        currentRoot = root;
        for (const listener of readyListeners) listener();
      }
      expect(root.setAttribute).toHaveBeenLastCalledWith(
        "data-bb-desktop-fullscreen",
        "true",
      );
      root.setAttribute.mockClear();
      emitIpcPayload({
        channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
        payload: { isFullScreen: false, isFocused: "yes" },
      });
      expect(root.setAttribute).not.toHaveBeenCalled();
      emitIpcPayload({
        channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
        payload: { isFullScreen: false, isFocused: true },
      });
      expect(root.setAttribute).toHaveBeenLastCalledWith(
        "data-bb-desktop-fullscreen",
        "false",
      );
      root.hasAttribute.mockReturnValue(false);
      root.setAttribute.mockClear();
      emitIpcPayload({
        channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
        payload: { isFullScreen: true, isFocused: true },
      });
      expect(root.setAttribute).not.toHaveBeenCalled();
    },
  );

  it("validates native material acknowledgments and uses the fixed surface-style channel", async () => {
    const invoke = vi.spyOn(electronMock.ipcRenderer, "invoke");
    try {
      invoke.mockResolvedValueOnce({ material: "acrylic" });
      await expect(api.setSurfaceStyle?.("liquid-glass")).resolves.toEqual({
        material: "acrylic",
      });
      expect(invoke).toHaveBeenLastCalledWith(
        BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL,
        "liquid-glass",
      );
      invoke.mockResolvedValueOnce({ material: "transparent" });
      await expect(api.setSurfaceStyle?.("liquid-glass")).rejects.toThrow();
      invoke.mockResolvedValueOnce({ material: "none" });
      await expect(api.setSurfaceStyle?.("default")).resolves.toEqual({
        material: "none",
      });
    } finally {
      invoke.mockRestore();
    }
  });

  it("exposes only the typed browser commands and forwards them over fixed channels", async () => {
    const attachRequest = {
      threadId: "thread-1",
      existingOnly: true as const,
      tabId: "browser:a",
      url: "http://localhost:5173/",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
    };
    const navigateRequest = {
      tabId: "browser:a",
      url: "https://example.com/",
    };
    const boundsRequest = {
      tabId: "browser:a",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    };
    const visibleRequest = {
      tabId: "browser:a",
      visible: false,
    };
    const findRequest = {
      tabId: "browser:a",
      text: "needle",
      forward: true,
      newSession: true,
    };
    const stopFindRequest = {
      tabId: "browser:a",
      action: "clearSelection" as const,
    };

    expect(Object.keys(api.browser).sort()).toEqual([
      "attach",
      "captureFeedback",
      "detach",
      "findInPage",
      "focus",
      "getControl",
      "getTarget",
      "goBack",
      "goForward",
      "navigate",
      "onControl",
      "onFindResult",
      "onFocus",
      "onOpenTab",
      "onReveal",
      "onScopedOpenTab",
      "onSnapshot",
      "onState",
      "releaseControl",
      "reload",
      "setBounds",
      "setVisible",
      "setVisibleWithoutFocus",
      "stop",
      "stopFindInPage",
    ]);
    expect(api.browser).not.toHaveProperty("send");
    expect(api.browser).not.toHaveProperty("invoke");

    api.browser.attach(attachRequest);
    api.browser.detach("browser:a");
    api.browser.navigate(navigateRequest);
    api.browser.goBack("browser:a");
    api.browser.goForward("browser:a");
    api.browser.reload("browser:a");
    api.browser.stop("browser:a");
    api.browser.focus?.("browser:a");
    api.browser.setBounds(boundsRequest);
    api.browser.setVisible(visibleRequest);
    api.browser.setVisibleWithoutFocus?.(visibleRequest);
    api.browser.findInPage?.(findRequest);
    api.browser.stopFindInPage?.(stopFindRequest);
    api.setTheme("dark");
    await api.checkForUpdates();
    await expect(api.getWindowState?.()).resolves.toEqual({
      isFullScreen: false,
    });
    await api.installUpdate();

    expect(electronMock.sendCalls).toEqual([
      { channel: BB_DESKTOP_BROWSER_ATTACH_CHANNEL, payload: attachRequest },
      {
        channel: BB_DESKTOP_BROWSER_DETACH_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
        payload: navigateRequest,
      },
      {
        channel: BB_DESKTOP_BROWSER_GO_BACK_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_RELOAD_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_STOP_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_FOCUS_CHANNEL,
        payload: { tabId: "browser:a" },
      },
      {
        channel: BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
        payload: boundsRequest,
      },
      {
        channel: BB_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
        payload: visibleRequest,
      },
      {
        channel: BB_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
        payload: visibleRequest,
      },
      {
        channel: BB_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
        payload: findRequest,
      },
      {
        channel: BB_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
        payload: stopFindRequest,
      },
      { channel: BB_DESKTOP_SET_THEME_CHANNEL, payload: "dark" },
    ]);
    expect(electronMock.invokeCalls).toContain(BB_DESKTOP_GET_INFO_CHANNEL);
    expect(electronMock.invokeCalls).toContain(
      BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
    );
    expect(electronMock.invokeCalls).toContain(
      BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
    );
    expect(electronMock.invokeCalls).toContain(
      BB_DESKTOP_INSTALL_UPDATE_CHANNEL,
    );
  }, 10_000);

  it("converts zoomed renderer bounds to native window coordinates", () => {
    electronMock.setZoomFactor(1.25);

    api.browser.attach({
      threadId: "thread-1",
      tabId: "browser:zoomed",
      url: "https://example.com/",
      bounds: { x: 800, y: 40, width: 400, height: 600 },
      visible: false,
    });
    api.browser.setBounds({
      tabId: "browser:zoomed",
      bounds: { x: 801, y: 41, width: 399, height: 599 },
    });

    expect(electronMock.sendCalls).toEqual([
      {
        channel: BB_DESKTOP_BROWSER_ATTACH_CHANNEL,
        payload: {
          threadId: "thread-1",
          tabId: "browser:zoomed",
          url: "https://example.com/",
          bounds: { x: 1000, y: 50, width: 500, height: 750 },
          visible: false,
        },
      },
      {
        channel: BB_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
        payload: {
          tabId: "browser:zoomed",
          bounds: { x: 1001, y: 51, width: 499, height: 749 },
        },
      },
    ]);
  });

  it("validates browser event payloads before notifying renderer listeners", () => {
    const states: BbDesktopBrowserState[] = [];
    const openTabs: BbDesktopBrowserOpenTabRequest[] = [];
    const scopedOpenTabs: BbDesktopBrowserScopedOpenTabRequest[] = [];
    const focusedTabs: string[] = [];
    const snapshots: BbDesktopBrowserSnapshot[] = [];
    const findResults: BbDesktopBrowserFindResult[] = [];
    let closeWindowRequestCount = 0;
    let openNewTabCount = 0;
    const appCommands: AppCommandId[] = [];
    const windowStates: BbDesktopWindowState[] = [];
    const state: BbDesktopBrowserState = {
      tabId: "browser:a",
      url: "https://example.com/",
      title: "Example",
      isLoading: false,
      canGoBack: false,
      canGoForward: true,
      errorText: null,
    };
    const openTab: BbDesktopBrowserOpenTabRequest = {
      url: "https://example.com/popup",
    };
    const scopedOpenTab: BbDesktopBrowserScopedOpenTabRequest = {
      tabId: "browser:a",
      url: "https://example.com/scoped-popup",
    };
    const snapshot: BbDesktopBrowserSnapshot = {
      tabId: "browser:a",
      dataUrl: null,
    };
    const findResult: BbDesktopBrowserFindResult = {
      tabId: "browser:a",
      requestId: 3,
      activeMatchOrdinal: 1,
      matches: 4,
      finalUpdate: true,
    };

    api.browser.onState((nextState) => {
      states.push(nextState);
    });
    api.browser.onOpenTab((request) => {
      openTabs.push(request);
    });
    api.browser.onScopedOpenTab?.((request) => {
      scopedOpenTabs.push(request);
    });
    api.browser.onFocus?.((tabId) => {
      focusedTabs.push(tabId);
    });
    api.browser.onSnapshot?.((nextSnapshot) => {
      snapshots.push(nextSnapshot);
    });
    api.browser.onFindResult?.((result) => {
      findResults.push(result);
    });
    api.onOpenNewTab?.(() => {
      openNewTabCount += 1;
    });
    api.onAppCommand?.((command) => {
      appCommands.push(command);
    });
    api.onCloseWindowRequest?.(() => {
      closeWindowRequestCount += 1;
      return true;
    });
    api.onWindowStateChange?.((windowState) => {
      windowStates.push(windowState);
    });

    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_STATE_CHANNEL,
      payload: { ...state, extra: true },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
      payload: { url: "" },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
      payload: { tabId: "", url: "https://example.com/scoped-popup" },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
      payload: { tabId: "", extra: true },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
      payload: { tabId: "browser:a", dataUrl: 42 },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
      payload: { ...findResult, matches: -1 },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
      payload: { ...findResult, selectionArea: {} },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: false, extra: true },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_STATE_CHANNEL,
      payload: state,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
      payload: openTab,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
      payload: scopedOpenTab,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_FOCUSED_CHANNEL,
      payload: { tabId: "browser:a" },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
      payload: snapshot,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
      payload: findResult,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
      payload: { isFullScreen: true },
    });
    emitIpcPayload({
      channel: BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
      payload: null,
    });
    emitIpcPayload({
      channel: BB_DESKTOP_APP_COMMAND_CHANNEL,
      payload: "not-a-command",
    });
    emitIpcPayload({
      channel: BB_DESKTOP_APP_COMMAND_CHANNEL,
      payload: "thread.new",
    });
    emitIpcPayload({
      channel: BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
      payload: null,
    });

    expect(states).toEqual([state]);
    expect(openTabs).toEqual([openTab]);
    expect(scopedOpenTabs).toEqual([scopedOpenTab]);
    expect(focusedTabs).toEqual(["browser:a"]);
    expect(snapshots).toEqual([snapshot]);
    expect(findResults).toEqual([findResult]);
    expect(windowStates).toEqual([{ isFullScreen: true }]);
    expect(closeWindowRequestCount).toBe(1);
    expect(openNewTabCount).toBe(1);
    expect(appCommands).toEqual(["thread.new"]);
    expect(electronMock.sendCalls).toContainEqual({
      channel: BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
      payload: true,
    });
  });

  it("routes the log viewer request to main and mirrors its availability", async () => {
    await api.openServerDaemonLogs?.();
    expect(electronMock.invokeCalls).toContain(
      BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
    );

    expect(api.serverDaemonLogsAvailable).toBeUndefined();
    emitIpcPayload({
      channel: BB_DESKTOP_INFO_CHANGED_CHANNEL,
      payload: {
        lastCheckedAt: null,
        latestVersion: null,
        pendingVersion: null,
        platform: "macos",
        serverDaemonLogsAvailable: true,
        updateAvailable: false,
        updateDownloaded: false,
        version: "0.0.0-test",
      },
    });
    expect(api.serverDaemonLogsAvailable).toBe(true);
  });

  it("answers unhandled close-window requests so main closes the window", () => {
    emitIpcPayload({
      channel: BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
      payload: null,
    });

    expect(electronMock.sendCalls).toContainEqual({
      channel: BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
      payload: false,
    });
  });
});

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BbDesktopWindowState,
  BbDesktopTitleBarAppearance,
} from "@bb/desktop-contract";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import { DesktopTitleBar } from "./DesktopTitleBar";

const appearance = vi.hoisted(() => ({
  epoch: 0,
  theme: "dark",
  reduced: false,
}));
vi.mock("@/hooks/useAppTheme", () => ({
  useAppThemeEpoch: () => appearance.epoch,
}));
vi.mock("@/hooks/useTheme", () => ({
  usePreferredTheme: () => appearance.theme,
}));
vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => appearance.reduced,
}));

class Overlay extends EventTarget {
  visible = true;
  setVisible(visible: boolean) {
    this.visible = visible;
    this.dispatchEvent(new Event("geometrychange"));
  }
}

const originalOverlay = Object.getOwnPropertyDescriptor(
  navigator,
  "windowControlsOverlay",
);
let overlay: Overlay;
let windowStateListener: ((state: BbDesktopWindowState) => void) | undefined;

function installDesktop(overlayEnabled = true) {
  const api = createBbDesktopApi({
    platform: "windows",
    version: "0.42.4",
    titleBarOverlay: overlayEnabled,
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    updateAvailable: false,
    updateDownloaded: false,
  });
  const setTitleBarAppearance = vi.fn(
    async (_value: BbDesktopTitleBarAppearance) => {},
  );
  api.setTitleBarAppearance = setTitleBarAppearance;
  api.getWindowState = async () => ({ isFullScreen: false });
  api.onWindowStateChange = (listener) => {
    windowStateListener = listener;
    return () => {
      windowStateListener = undefined;
    };
  };
  window.bbDesktop = api;
  return { api, setTitleBarAppearance };
}

beforeEach(() => {
  document.title = "Agent Studio";
  appearance.epoch = 0;
  appearance.theme = "dark";
  appearance.reduced = false;
  overlay = new Overlay();
  Object.defineProperty(navigator, "windowControlsOverlay", {
    configurable: true,
    value: overlay,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  delete window.bbDesktop;
  document.title = "";
  if (originalOverlay)
    Object.defineProperty(navigator, "windowControlsOverlay", originalOverlay);
  else Reflect.deleteProperty(navigator, "windowControlsOverlay");
  vi.restoreAllMocks();
});

describe("DesktopTitleBar", () => {
  it("does not add a second title bar to older Windows shells", async () => {
    const { api } = installDesktop();
    delete api.titleBarOverlay;
    api.getInfo = async () => ({ ...api, titleBarOverlay: undefined });
    render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.queryByRole("banner")).toBeNull();
    expect(
      document.documentElement.hasAttribute("data-arc-window-chrome"),
    ).toBe(false);
  });

  it("requires a visible native overlay, even when the shell advertises support", async () => {
    installDesktop();
    overlay.visible = false;
    render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.queryByRole("banner")).toBeNull();
    act(() => overlay.setVisible(true));
    expect(screen.getByRole("banner", { name: "ARC title bar" })).toBeTruthy();
    expect(
      document.documentElement.style.getPropertyValue(
        "--arc-window-titlebar-height",
      ),
    ).toBe("calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 36px))");
  });

  it("leaves browser and non-Windows application layouts unchanged", async () => {
    const result = render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.queryByRole("banner")).toBeNull();
    result.unmount();
    const { api } = installDesktop();
    api.platform = "macos";
    api.getInfo = async () => ({ ...api });
    render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("uses the native capability when the web overlay API is unavailable", async () => {
    installDesktop();
    Reflect.deleteProperty(navigator, "windowControlsOverlay");
    render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.getByRole("banner")).toBeTruthy();
    act(() => windowStateListener?.({ isFullScreen: true }));
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("keeps an active window bright when its embedded browser takes renderer focus", async () => {
    const { api } = installDesktop();
    api.getWindowState = async () => ({ isFullScreen: false, isFocused: true });
    render(<DesktopTitleBar />);
    await act(async () => {});
    const bar = screen.getByRole("banner");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(bar.getAttribute("data-focused")).toBe("true");
    act(() => windowStateListener?.({ isFullScreen: false, isFocused: false }));
    expect(bar.getAttribute("data-focused")).toBe("false");
    act(() => window.dispatchEvent(new Event("focus")));
    expect(bar.getAttribute("data-focused")).toBe("false");
  });

  it("follows real document titles and focus changes without remounting application content", async () => {
    installDesktop();
    render(<DesktopTitleBar />);
    const bar = screen.getByRole("banner");
    expect(screen.getByText("Agent Studio")).toBeTruthy();
    act(() => {
      document.title = "A project with a long title · Threads";
    });
    await waitFor(() =>
      expect(
        screen.getByText("A project with a long title · Threads"),
      ).toBeTruthy(),
    );
    act(() => window.dispatchEvent(new Event("blur")));
    expect(bar.getAttribute("data-focused")).toBe("false");
    act(() => window.dispatchEvent(new Event("focus")));
    expect(bar.getAttribute("data-focused")).toBe("true");
    expect(screen.getByRole("banner")).toBe(bar);
  });

  it("removes and restores the content inset through fullscreen and cleans up on unmount", async () => {
    installDesktop();
    const result = render(<DesktopTitleBar />);
    await act(async () => {});
    act(() => windowStateListener?.({ isFullScreen: true }));
    expect(screen.queryByRole("banner")).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue(
        "--arc-window-titlebar-height",
      ),
    ).toBe("0px");
    act(() => windowStateListener?.({ isFullScreen: false }));
    expect(screen.getByRole("banner")).toBeTruthy();
    result.unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--arc-window-titlebar-height",
      ),
    ).toBe("");
    expect(
      document.documentElement.hasAttribute("data-arc-window-chrome"),
    ).toBe(false);
    act(() => overlay.setVisible(false));
    expect(
      document.documentElement.hasAttribute("data-arc-window-chrome"),
    ).toBe(false);
  });

  it("does not overwrite a live fullscreen event with a delayed initial snapshot", async () => {
    const { api } = installDesktop();
    let resolveInitial: ((state: BbDesktopWindowState) => void) | undefined;
    api.getWindowState = () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      });
    render(<DesktopTitleBar />);
    await act(async () => {});
    act(() => windowStateListener?.({ isFullScreen: true, isFocused: true }));
    await act(async () => {
      resolveInitial?.({ isFullScreen: false, isFocused: false });
    });
    expect(screen.queryByRole("banner")).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue(
        "--arc-window-titlebar-height",
      ),
    ).toBe("0px");
  });

  it("does not expose replacement caption controls or reuse panel close actions", async () => {
    installDesktop();
    render(<DesktopTitleBar />);
    await act(async () => {});
    expect(screen.getByRole("banner").querySelector("button")).toBeNull();
  });
});

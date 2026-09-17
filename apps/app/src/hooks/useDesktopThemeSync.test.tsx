// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BbDesktopInfo,
  BbDesktopSurfaceStyleResult,
} from "@bb/desktop-contract";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";

const config = vi.hoisted(() => ({ surfaceStyle: "liquid-glass" }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { appearance: config } }),
}));

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);
let media: Map<string, { matches: boolean; listeners: Set<() => void> }>;

function setMedia(query: string, matches: boolean) {
  const value = media.get(query);
  if (!value) throw new Error(`Missing subscribed query: ${query}`);
  value.matches = matches;
  for (const listener of value.listeners) listener();
}

beforeEach(() => {
  config.surfaceStyle = "liquid-glass";
  window.localStorage.setItem("bb.theme", "system");
  media = new Map();
  window.matchMedia = vi.fn((query: string): MediaQueryList => {
    let value = media.get(query);
    if (!value) {
      value = {
        matches: query === "(prefers-color-scheme: dark)",
        listeners: new Set(),
      };
      media.set(query, value);
    }
    const current = value;
    return {
      get matches() {
        return current.matches;
      },
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        current.listeners.add(listener as () => void);
      },
      removeEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        current.listeners.delete(listener as () => void);
      },
      dispatchEvent() {
        return true;
      },
    };
  });
});

afterEach(() => {
  cleanup();
  delete window.bbDesktop;
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.nativeGlass;
  if (matchMediaDescriptor)
    Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
  else Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
  vi.resetModules();
});

function installDesktop() {
  const api = createBbDesktopApi(desktopInfo);
  const setSurfaceStyle = vi.fn(
    async (): Promise<BbDesktopSurfaceStyleResult> => ({ material: "acrylic" }),
  );
  const setTheme = vi.fn();
  api.setSurfaceStyle = setSurfaceStyle;
  api.setTheme = setTheme;
  window.bbDesktop = api;
  return { api, setSurfaceStyle, setTheme };
}

function pendingMaterial() {
  let acknowledge: (value: BbDesktopSurfaceStyleResult) => void = () => {
    throw new Error("Not pending");
  };
  const promise = new Promise<BbDesktopSurfaceStyleResult>((resolve) => {
    acknowledge = resolve;
  });
  return { promise, acknowledge };
}

describe("desktop theme synchronization", () => {
  it("keeps Electron on system while OS changes disable glass in light mode", async () => {
    const { setTheme, setSurfaceStyle } = installDesktop();
    const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
    const { usePreferredTheme } = await import("./useTheme");
    const { result } = renderHook(() => {
      useDesktopThemeSync();
      return usePreferredTheme();
    });
    await waitFor(() =>
      expect(document.documentElement.dataset.nativeGlass).toBe("acrylic"),
    );
    expect(result.current).toBe("dark");
    expect(setTheme.mock.calls).toEqual([["system"]]);
    expect(setSurfaceStyle).toHaveBeenLastCalledWith("liquid-glass");
    act(() => setMedia("(prefers-color-scheme: dark)", false));
    expect(result.current).toBe("light");
    expect(setTheme.mock.calls).toEqual([["system"]]);
    expect(setSurfaceStyle).toHaveBeenLastCalledWith("default");
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    act(() => setMedia("(prefers-color-scheme: dark)", true));
    await waitFor(() =>
      expect(document.documentElement.dataset.nativeGlass).toBe("acrylic"),
    );
  });

  it("waits for native acknowledgment and ignores a stale response after opting out", async () => {
    const { setSurfaceStyle } = installDesktop();
    const pending = pendingMaterial();
    setSurfaceStyle.mockReturnValueOnce(pending.promise);
    const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
    const { rerender } = renderHook(useDesktopThemeSync);
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    config.surfaceStyle = "default";
    rerender();
    await act(async () => pending.acknowledge({ material: "acrylic" }));
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    expect(setSurfaceStyle).toHaveBeenLastCalledWith("default");
  });

  it.each([
    "(prefers-reduced-transparency: reduce)",
    "(forced-colors: active)",
  ])(
    "restores the window when %s changes and enables glass again when cleared",
    async (query) => {
      const { setSurfaceStyle } = installDesktop();
      const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
      renderHook(useDesktopThemeSync);
      await waitFor(() =>
        expect(document.documentElement.dataset.nativeGlass).toBe("acrylic"),
      );
      act(() => setMedia(query, true));
      expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
      expect(setSurfaceStyle).toHaveBeenLastCalledWith("default");
      act(() => setMedia(query, false));
      await waitFor(() =>
        expect(document.documentElement.dataset.nativeGlass).toBe("acrylic"),
      );
    },
  );

  it.each(["unavailable", "rejected"])(
    "keeps the root opaque when the native request is %s",
    async (mode) => {
      const { setSurfaceStyle } = installDesktop();
      if (mode === "rejected")
        setSurfaceStyle.mockRejectedValue(new Error("IPC unavailable"));
      else setSurfaceStyle.mockResolvedValue({ material: "none" });
      const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
      await act(async () => {
        renderHook(useDesktopThemeSync);
      });
      expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    },
  );

  it.each(["browser", "older-shell"])(
    "supports %s without the optional native API",
    async (mode) => {
      if (mode === "older-shell")
        window.bbDesktop = createBbDesktopApi(desktopInfo);
      const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
      await act(async () => {
        renderHook(useDesktopThemeSync);
      });
      expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    },
  );

  it("restores native defaults on unmount and cannot apply an acknowledgment afterward", async () => {
    const { setSurfaceStyle } = installDesktop();
    const pending = pendingMaterial();
    setSurfaceStyle.mockReturnValueOnce(pending.promise);
    const { useDesktopThemeSync } = await import("./useDesktopThemeSync");
    const { unmount } = renderHook(useDesktopThemeSync);
    unmount();
    expect(setSurfaceStyle).toHaveBeenLastCalledWith("default");
    await act(async () => pending.acknowledge({ material: "vibrancy" }));
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
  });
});

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BB_DESKTOP_TITLE_BAR_HEIGHT } from "@bb/desktop-contract";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { usePreferredTheme } from "@/hooks/useTheme";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import { BbLogo } from "@/components/ui/bb-logo";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";

type WindowOverlay = EventTarget & { visible: boolean };

function getWindowOverlay(): WindowOverlay | null {
  if (typeof navigator === "undefined") return null;
  const overlay: unknown = Reflect.get(navigator, "windowControlsOverlay");
  if (
    !(overlay instanceof EventTarget) ||
    !("visible" in overlay) ||
    typeof overlay.visible !== "boolean"
  )
    return null;
  return overlay as WindowOverlay;
}

function subscribeOverlay(listener: () => void): () => void {
  const overlay = getWindowOverlay();
  const handleGeometry = () => {
    listener();
    dispatchBrowserViewBoundsSync();
  };
  overlay?.addEventListener("geometrychange", handleGeometry);
  return () => overlay?.removeEventListener("geometrychange", handleGeometry);
}

function getOverlayVisible(): boolean {
  return getWindowOverlay()?.visible ?? true;
}

function subscribeTitle(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.querySelector("title") ?? document.head, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function getTitle(): string {
  return document.title || "ARC";
}

function getServerTitle(): string {
  return "ARC";
}

function getServerOverlayVisible(): boolean {
  return false;
}

function toNativeColor(
  context: CanvasRenderingContext2D,
  color: string,
): string {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data, (channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function DesktopTitleBar() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const { isFullScreen, isFocused } = useDesktopWindowState();
  const overlayVisible = useSyncExternalStore(
    subscribeOverlay,
    getOverlayVisible,
    getServerOverlayVisible,
  );
  const title = useSyncExternalStore(subscribeTitle, getTitle, getServerTitle);
  const themeEpoch = useAppThemeEpoch();
  const theme = usePreferredTheme();
  const reducedTransparency = useMediaQuery(
    "(prefers-reduced-transparency: reduce)",
  );
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const [rendererFocused, setRendererFocused] = useState(() =>
    document.hasFocus(),
  );
  const focused = isFocused ?? rendererFocused;
  const barRef = useRef<HTMLElement>(null);
  const info = desktopInfo ?? desktopApi;
  const visible =
    info?.platform === "windows" &&
    info.titleBarOverlay === true &&
    overlayVisible &&
    !isFullScreen;

  useEffect(() => {
    const onFocus = () => setRendererFocused(true);
    const onBlur = () => setRendererFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      "--arc-window-titlebar-height",
      visible
        ? `calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, ${BB_DESKTOP_TITLE_BAR_HEIGHT}px))`
        : "0px",
    );
    root.toggleAttribute("data-arc-window-chrome", visible);
    dispatchBrowserViewBoundsSync();
    return () => {
      root.style.removeProperty("--arc-window-titlebar-height");
      root.removeAttribute("data-arc-window-chrome");
      dispatchBrowserViewBoundsSync();
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !desktopApi?.setTitleBarAppearance) return;
    const frame = window.requestAnimationFrame(() => {
      const bar = barRef.current;
      const context = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });
      if (!bar || !context) return;
      const style = getComputedStyle(bar);
      void desktopApi
        .setTitleBarAppearance?.({
          color: toNativeColor(context, style.backgroundColor),
          symbolColor: toNativeColor(context, style.color),
        })
        .catch(() => {});
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    desktopApi,
    visible,
    focused,
    themeEpoch,
    theme,
    reducedTransparency,
    forcedColors,
  ]);

  if (!visible) return null;

  return (
    <header
      ref={barRef}
      data-arc-window-titlebar=""
      data-focused={focused}
      className="arc-window-titlebar select-none text-xs"
      style={{ zIndex: APP_OVERLAY_LAYER.desktopTitleBar }}
      aria-label="ARC title bar"
    >
      <div className="arc-window-titlebar-brand flex items-center gap-2 font-medium">
        <BbLogo className="size-4" />
        <span>ARC</span>
      </div>
      <div className="arc-window-titlebar-context">
        <span className="truncate">{title}</span>
      </div>
    </header>
  );
}

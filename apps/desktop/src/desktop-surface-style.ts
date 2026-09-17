import { release } from "node:os";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  bbDesktopSurfaceStyleSchema,
  type BbDesktopSurfaceStyleResult,
} from "@bb/desktop-contract";
import { BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL } from "./desktop-update-ipc.js";

export function registerDesktopSurfaceStyleIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
): void {
  const backgrounds = new WeakMap<BrowserWindow, string>();
  const windowsBuild = /^10\.0\.(\d+)(?:\.|$)/.exec(release())?.[1];
  const windowsAcrylicSupported =
    process.platform === "win32" &&
    windowsBuild !== undefined &&
    Number(windowsBuild) >= 22621;
  const material = windowsAcrylicSupported
    ? "acrylic"
    : process.platform === "darwin"
      ? "vibrancy"
      : "none";

  function restoreBackground(window: BrowserWindow): void {
    const background = backgrounds.get(window);
    if (background === undefined || window.isDestroyed()) return;
    try {
      if (material === "acrylic") window.setBackgroundMaterial("none");
      if (material === "vibrancy") window.setVibrancy(null);
    } finally {
      window.setBackgroundColor(background);
      backgrounds.delete(window);
    }
  }

  ipcMain.handle(
    BB_DESKTOP_SET_SURFACE_STYLE_CHANNEL,
    (event, payload: unknown): BbDesktopSurfaceStyleResult => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Surface style requires an application main frame");
      }
      const style = bbDesktopSurfaceStyleSchema.parse(payload);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window.isDestroyed()) return { material: "none" };
      try {
        if (
          style === "default" ||
          material === "none" ||
          !nativeTheme.shouldUseDarkColors ||
          nativeTheme.prefersReducedTransparency ||
          nativeTheme.shouldUseHighContrastColors
        ) {
          restoreBackground(window);
          return { material: "none" };
        }
        if (!backgrounds.has(window)) {
          backgrounds.set(window, window.getBackgroundColor());
        }
        window.setBackgroundColor("#00000000");
        if (material === "acrylic") window.setBackgroundMaterial("acrylic");
        if (material === "vibrancy") window.setVibrancy("under-window");
        return { material };
      } catch {
        try {
          restoreBackground(window);
        } catch {}
        return { material: "none" };
      }
    },
  );
}

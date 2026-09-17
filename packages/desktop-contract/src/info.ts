import { z } from "zod";
import type { BbDesktopBrowserApi } from "./browser.js";
import type { AppCommandId } from "@bb/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

const bbDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);

export const bbDesktopInfoSchema = z.object({
  checkState: z.enum(["idle", "checking", "succeeded", "failed"]).optional(),
  downloadState: bbDesktopDownloadStateSchema.optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: z.enum(["macos", "linux", "windows"]),
  titleBarOverlay: z.boolean().optional(),
  serverDaemonLogsAvailable: z.boolean().optional(),
  updatesConfigured: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
});
export type BbDesktopInfo = z.infer<typeof bbDesktopInfoSchema>;

export const bbDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
    isFocused: z.boolean().optional(),
  })
  .strict();
export type BbDesktopWindowState = z.infer<typeof bbDesktopWindowStateSchema>;

export const bbDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type BbDesktopTheme = z.infer<typeof bbDesktopThemeSchema>;

export const BB_DESKTOP_TITLE_BAR_HEIGHT = 36;
const titleBarColorSchema = z.string().regex(/^#[\da-f]{6}(?:[\da-f]{2})?$/i);
export const bbDesktopTitleBarAppearanceSchema = z
  .object({ color: titleBarColorSchema, symbolColor: titleBarColorSchema })
  .strict();
export type BbDesktopTitleBarAppearance = z.infer<
  typeof bbDesktopTitleBarAppearanceSchema
>;

export const bbDesktopSurfaceStyleSchema = z.enum(["default", "liquid-glass"]);
export type BbDesktopSurfaceStyle = z.infer<typeof bbDesktopSurfaceStyleSchema>;
export const bbDesktopSurfaceStyleResultSchema = z
  .object({ material: z.enum(["none", "acrylic", "vibrancy"]) })
  .strict();
export type BbDesktopSurfaceStyleResult = z.infer<
  typeof bbDesktopSurfaceStyleResultSchema
>;

export type BbDesktopInfoChangeHandler = (info: BbDesktopInfo) => void;
export type BbDesktopInfoUnsubscribe = () => void;
export type BbDesktopWindowStateChangeHandler = (
  state: BbDesktopWindowState,
) => void;
export type BbDesktopOpenNewTabHandler = () => void;
export type BbDesktopAppCommandHandler = (command: AppCommandId) => void;
export type BbDesktopCloseWindowRequestHandler = () => boolean;

export interface BbDesktopApi extends BbDesktopInfo {
  browser: BbDesktopBrowserApi;
  checkForUpdates(): Promise<BbDesktopInfo>;
  getInfo(): Promise<BbDesktopInfo>;
  getWindowState?(): Promise<BbDesktopWindowState>;
  installUpdate(): Promise<void>;
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe;
  onOpenNewTab?(listener: BbDesktopOpenNewTabHandler): BbDesktopInfoUnsubscribe;
  onAppCommand?(listener: BbDesktopAppCommandHandler): BbDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: BbDesktopCloseWindowRequestHandler,
  ): BbDesktopInfoUnsubscribe;
  openExternalUrl(url: string): void;
  openServerDaemonLogs?(): Promise<void>;
  setTheme(theme: BbDesktopTheme): void;
  setTitleBarAppearance?(
    appearance: BbDesktopTitleBarAppearance,
  ): Promise<void>;
  setSurfaceStyle?(
    style: BbDesktopSurfaceStyle,
  ): Promise<BbDesktopSurfaceStyleResult>;
}

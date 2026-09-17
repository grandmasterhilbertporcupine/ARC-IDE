import { BrowserWindow, ipcMain } from "electron";
import {
  BB_DESKTOP_TITLE_BAR_HEIGHT,
  bbDesktopTitleBarAppearanceSchema,
} from "@bb/desktop-contract";
import { BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL } from "./desktop-window-command-ipc.js";

export function registerDesktopTitleBarIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
): void {
  ipcMain.handle(
    BB_DESKTOP_SET_TITLE_BAR_APPEARANCE_CHANNEL,
    (event, payload: unknown): void => {
      if (
        process.platform !== "win32" ||
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error(
          "Title bar appearance requires a Windows application main frame",
        );
      }
      const appearance = bbDesktopTitleBarAppearanceSchema.parse(payload);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window.isDestroyed()) return;
      window.setTitleBarOverlay({
        ...appearance,
        height: BB_DESKTOP_TITLE_BAR_HEIGHT,
      });
    },
  );
}

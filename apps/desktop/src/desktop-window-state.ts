import type { BbDesktopWindowState } from "@bb/desktop-contract";
import type { DesktopBrowserWindow } from "./desktop-window-factory.js";

export function getDesktopWindowState(
  window: Pick<DesktopBrowserWindow, "isFullScreen" | "isFocused"> | null,
): BbDesktopWindowState {
  return {
    isFullScreen: window?.isFullScreen() ?? false,
    isFocused: window?.isFocused() ?? false,
  };
}

export function registerDesktopWindowStateEvents(
  window: Pick<DesktopBrowserWindow, "isFullScreen" | "isFocused" | "on">,
  onState: (state: BbDesktopWindowState) => void,
): void {
  let state: BbDesktopWindowState = getDesktopWindowState(window);
  for (const [event, change] of [
    ["enter-full-screen", { isFullScreen: true }],
    ["leave-full-screen", { isFullScreen: false }],
    ["focus", { isFocused: true }],
    ["blur", { isFocused: false }],
  ] as const) {
    window.on(event, () => {
      state = { ...state, ...change };
      onState(state);
    });
  }
}

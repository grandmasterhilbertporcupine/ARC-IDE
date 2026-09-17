import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BbDesktopWindowState } from "@bb/desktop-contract";
import {
  getDesktopWindowState,
  registerDesktopWindowStateEvents,
} from "../src/desktop-window-state.js";

class NativeWindow extends EventEmitter {
  focused = true;
  fullScreen = false;
  webContents = { isFocused: () => false };
  isFocused() {
    return this.focused;
  }
  isFullScreen() {
    return this.fullScreen;
  }
}

describe("desktop native window state", () => {
  it("reports window activation even when a native browser view owns page focus", () => {
    const window = new NativeWindow();
    expect(window.webContents.isFocused()).toBe(false);
    expect(getDesktopWindowState(window)).toEqual({
      isFocused: true,
      isFullScreen: false,
    });
    window.focused = false;
    expect(getDesktopWindowState(window)).toEqual({
      isFocused: false,
      isFullScreen: false,
    });
  });

  it("publishes focus and fullscreen changes together from the native window", () => {
    const window = new NativeWindow();
    const states: BbDesktopWindowState[] = [];
    registerDesktopWindowStateEvents(window, (state) => states.push(state));
    window.focused = false;
    window.emit("blur");
    window.fullScreen = true;
    window.emit("enter-full-screen");
    window.focused = true;
    window.emit("focus");
    window.fullScreen = false;
    window.emit("leave-full-screen");
    expect(states).toEqual([
      { isFocused: false, isFullScreen: false },
      { isFocused: false, isFullScreen: true },
      { isFocused: true, isFullScreen: true },
      { isFocused: true, isFullScreen: false },
    ]);
  });

  it("does not cross-report state between application windows", () => {
    const first = new NativeWindow();
    const second = new NativeWindow();
    const states: BbDesktopWindowState[] = [];
    registerDesktopWindowStateEvents(first, (state) => states.push(state));
    second.focused = false;
    second.emit("blur");
    expect(states).toEqual([]);
    first.emit("focus");
    expect(states).toEqual([{ isFocused: true, isFullScreen: false }]);
  });

  it("preserves event state while native fullscreen and focus getters lag behind", () => {
    const window = new NativeWindow();
    window.focused = false;
    const states: BbDesktopWindowState[] = [];
    registerDesktopWindowStateEvents(window, (state) => states.push(state));

    window.emit("enter-full-screen");
    window.emit("focus");
    window.fullScreen = true;
    window.focused = true;
    window.emit("leave-full-screen");
    window.emit("blur");

    expect(states).toEqual([
      { isFocused: false, isFullScreen: true },
      { isFocused: true, isFullScreen: true },
      { isFocused: true, isFullScreen: false },
      { isFocused: false, isFullScreen: false },
    ]);
  });

  it("reports a missing window as inactive and outside fullscreen", () => {
    expect(getDesktopWindowState(null)).toEqual({
      isFocused: false,
      isFullScreen: false,
    });
  });
});

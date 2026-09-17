import { describe, expect, it } from "vitest";
import {
  bbDesktopInfoSchema,
  bbDesktopWindowStateSchema,
  bbDesktopTitleBarAppearanceSchema,
} from "../src/info.js";

const baseInfo = {
  lastCheckedAt: null,
  latestVersion: "0.0.32",
  pendingVersion: null,
  platform: "macos",
  updateAvailable: true,
  updateDownloaded: false,
  version: "0.0.31",
} as const;

describe("bbDesktopInfoSchema", () => {
  it("accepts check outcomes while preserving legacy shell payloads", () => {
    for (const checkState of ["idle", "checking", "succeeded", "failed"]) {
      expect(
        bbDesktopInfoSchema.parse({ ...baseInfo, checkState }).checkState,
      ).toBe(checkState);
    }
    expect(bbDesktopInfoSchema.parse(baseInfo).checkState).toBeUndefined();
    expect(
      bbDesktopInfoSchema.safeParse({ ...baseInfo, checkState: "offline" })
        .success,
    ).toBe(false);
  });
  it("accepts both explicit download state and legacy shell payloads", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "downloading",
      }).success,
    ).toBe(true);
    expect(bbDesktopInfoSchema.safeParse(baseInfo).success).toBe(true);
  });

  it("rejects an unknown download state", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "available",
      }).success,
    ).toBe(false);
  });

  it("accepts linux", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "linux",
      }).success,
    ).toBe(true);
  });

  it("rejects win32", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "win32",
      }).success,
    ).toBe(false);
  });

  it("accepts an explicit title bar capability and legacy shell absence", () => {
    expect(
      bbDesktopInfoSchema.parse({
        ...baseInfo,
        platform: "windows",
        titleBarOverlay: true,
      }).titleBarOverlay,
    ).toBe(true);
    expect(bbDesktopInfoSchema.parse(baseInfo).titleBarOverlay).toBeUndefined();
    expect(
      bbDesktopInfoSchema.safeParse({ ...baseInfo, titleBarOverlay: "yes" })
        .success,
    ).toBe(false);
  });
});

describe("title bar appearance boundary", () => {
  it("accepts RGB and RGBA hex values without arbitrary CSS", () => {
    expect(
      bbDesktopTitleBarAppearanceSchema.parse({
        color: "#123ABC00",
        symbolColor: "#E7E9Ef",
      }),
    ).toEqual({ color: "#123ABC00", symbolColor: "#E7E9Ef" });
  });

  it.each([
    "transparent",
    "#fff",
    "#12345",
    "#1234567",
    "#123456789",
    "#xyzxyz",
    " #123456",
    "rgb(0,0,0)",
    "var(--canvas)",
  ])("rejects unsafe or unsupported color %s", (color) => {
    expect(
      bbDesktopTitleBarAppearanceSchema.safeParse({
        color,
        symbolColor: "#ffffff",
      }).success,
    ).toBe(false);
    expect(
      bbDesktopTitleBarAppearanceSchema.safeParse({
        color: "#123456",
        symbolColor: color,
      }).success,
    ).toBe(false);
  });

  it("rejects missing fields and renderer-controlled geometry", () => {
    expect(
      bbDesktopTitleBarAppearanceSchema.safeParse({ color: "#123456" }).success,
    ).toBe(false);
    expect(
      bbDesktopTitleBarAppearanceSchema.safeParse({
        color: "#123456",
        symbolColor: "#ffffff",
        height: 0,
      }).success,
    ).toBe(false);
  });
});

describe("desktop native focus compatibility", () => {
  it("preserves activation from new shells and meaningful absence from older shells", () => {
    expect(
      bbDesktopWindowStateSchema.parse({
        isFullScreen: false,
        isFocused: true,
      }),
    ).toEqual({ isFullScreen: false, isFocused: true });
    expect(bbDesktopWindowStateSchema.parse({ isFullScreen: false })).toEqual({
      isFullScreen: false,
    });
    expect(
      bbDesktopWindowStateSchema.safeParse({
        isFullScreen: false,
        isFocused: "true",
      }).success,
    ).toBe(false);
  });
});

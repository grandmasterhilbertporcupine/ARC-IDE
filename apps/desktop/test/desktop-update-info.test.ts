import { describe, expect, it } from "vitest";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import { mergeDesktopUpdateInfo } from "../src/desktop-update-info.js";

function info(overrides: Partial<BbDesktopInfo> = {}): BbDesktopInfo {
  return {
    lastCheckedAt: "2026-07-19T00:00:00.000Z",
    latestVersion: "0.0.32",
    pendingVersion: null,
    platform: "macos",
    updateAvailable: true,
    updateDownloaded: false,
    version: "0.0.31",
    ...overrides,
  };
}

describe("mergeDesktopUpdateInfo", () => {
  it("reports native check failure even when the lightweight feed succeeded", () => {
    const merged = mergeDesktopUpdateInfo({
      autoInfo: info({
        updatesConfigured: true,
        checkState: "failed",
        updateAvailable: false,
      }),
      feedInfo: info({ updatesConfigured: true, checkState: "succeeded" }),
    });
    expect(merged).toMatchObject({
      checkState: "failed",
      latestVersion: "0.0.32",
      updateAvailable: true,
    });
  });

  it("uses native success despite an unavailable JSON feed", () => {
    expect(
      mergeDesktopUpdateInfo({
        autoInfo: info({ updatesConfigured: true, checkState: "succeeded" }),
        feedInfo: info({ updatesConfigured: true, checkState: "failed" }),
      })?.checkState,
    ).toBe("succeeded");
  });

  it("uses the feed outcome when native updating is disabled", () => {
    expect(
      mergeDesktopUpdateInfo({
        autoInfo: info({ updatesConfigured: false, checkState: "idle" }),
        feedInfo: info({ updatesConfigured: true, checkState: "failed" }),
      })?.checkState,
    ).toBe("failed");
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
  ])(
    "merges configured feed %s and native updater %s as %s",
    (feedConfigured, nativeConfigured, expected) => {
      expect(
        mergeDesktopUpdateInfo({
          feedInfo: info({ updatesConfigured: feedConfigured }),
          autoInfo: info({ updatesConfigured: nativeConfigured }),
        })?.updatesConfigured,
      ).toBe(expected);
    },
  );

  it("does not infer native download activity from feed availability", () => {
    const merged = mergeDesktopUpdateInfo({
      autoInfo: info({
        downloadState: "idle",
        latestVersion: null,
        updateAvailable: false,
      }),
      feedInfo: info(),
    });

    expect(merged).toMatchObject({
      downloadState: "idle",
      latestVersion: "0.0.32",
      updateAvailable: true,
      updateDownloaded: false,
    });
  });

  it("preserves native updater activity when the feed also has an update", () => {
    const merged = mergeDesktopUpdateInfo({
      autoInfo: info({ downloadState: "downloading" }),
      feedInfo: info(),
    });

    expect(merged).toMatchObject({
      downloadState: "downloading",
      updateAvailable: true,
      updateDownloaded: false,
    });
  });

  it("leaves download state unknown for a legacy feed-only shell", () => {
    const merged = mergeDesktopUpdateInfo({
      autoInfo: null,
      feedInfo: info(),
    });

    expect(merged).not.toHaveProperty("downloadState");
    expect(merged).not.toHaveProperty("checkState");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ARC_UPDATE_BASE_URL", "");
  vi.stubEnv("BB_DESKTOP_RELEASE_CHANNEL", "latest");
});
afterEach(() => vi.unstubAllEnvs());

describe("ARC update ownership", () => {
  it("uses the public ARC GitHub stable release for Windows by default", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", undefined);
    vi.stubEnv("WNDR_UPDATE_BASE_URL", "https://foreign.example.test/releases");
    const provider = await import("../src/desktop-update-provider.js");
    expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toEqual({
      channel: "latest",
      provider: "github",
      owner: "grandmasterhilbertporcupine",
      repo: "ARC-IDE",
    });
    expect(provider.createDesktopUpdateFeedUrl("windows")).toBe(
      "https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases/latest/download/desktop-version-windows.json",
    );
    expect(
      provider.resolveDesktopUpdateSupport({
        platform: "windows",
        env: {},
        canReplaceAppImage: () => false,
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    for (const platform of ["macos", "linux"] as const) {
      expect(provider.createDesktopUpdateFeedUrl(platform)).toBe("");
      expect(
        provider.resolveDesktopUpdateSupport({
          platform,
          env: { APPIMAGE: "/tmp/ARC.AppImage" },
          canReplaceAppImage: () => true,
        }),
      ).toEqual({ autoUpdate: false, versionCheck: false });
    }
  });
  it.each(["", "  "])(
    "disables updates with an explicit empty feed %j",
    async (base) => {
      vi.stubEnv("ARC_UPDATE_BASE_URL", base);
      vi.stubEnv(
        "WNDR_UPDATE_BASE_URL",
        "https://foreign.example.test/releases",
      );
      const provider = await import("../src/desktop-update-provider.js");
      for (const platform of ["windows", "macos", "linux"] as const) {
        expect(provider.createDesktopUpdateFeedUrl(platform)).toBe("");
        expect(
          provider.resolveDesktopUpdateSupport({
            platform,
            env: {},
            canReplaceAppImage: () => true,
          }),
        ).toEqual({ autoUpdate: false, versionCheck: false });
      }
      expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toEqual({
        channel: "latest",
        provider: "generic",
        url: "",
      });
    },
  );
  it("keeps the default nightly channel isolated and disabled", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", undefined);
    vi.stubEnv("BB_DESKTOP_RELEASE_CHANNEL", "nightly");
    const provider = await import("../src/desktop-update-provider.js");
    expect(provider.DESKTOP_RELEASE_INFO.applicationName).toBe("ARC Nightly");
    expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toEqual({
      channel: "nightly",
      provider: "generic",
      url: "",
    });
    expect(provider.createDesktopUpdateFeedUrl("windows")).toBe("");
    expect(
      provider.resolveDesktopUpdateSupport({
        platform: "windows",
        env: {},
        canReplaceAppImage: () => true,
      }),
    ).toEqual({ autoUpdate: false, versionCheck: false });
  });
  it("routes each platform only to the configured HTTPS release origin", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", "https://releases.example.test/arc");
    const provider = await import("../src/desktop-update-provider.js");
    expect(provider.createDesktopUpdateFeedUrl("windows")).toBe(
      "https://releases.example.test/arc/desktop-latest/desktop-version-windows.json",
    );
    expect(provider.createDesktopUpdateFeedUrl("macos")).toBe(
      "https://releases.example.test/arc/desktop-latest/desktop-version.json",
    );
    expect(provider.createDesktopUpdateFeedUrl("linux")).toBe(
      "https://releases.example.test/arc/desktop-latest/desktop-version-linux.json",
    );
    expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toEqual({
      channel: "latest",
      provider: "generic",
      url: "https://releases.example.test/arc/desktop-latest/",
    });
  });
  it("preserves the explicitly configured nightly release directory", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", "https://releases.example.test/arc/");
    vi.stubEnv("BB_DESKTOP_RELEASE_CHANNEL", "nightly");
    const provider = await import("../src/desktop-update-provider.js");
    expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toEqual({
      channel: "nightly",
      provider: "generic",
      url: "https://releases.example.test/arc/desktop-nightly/",
    });
    expect(provider.createDesktopUpdateFeedUrl("windows")).toBe(
      "https://releases.example.test/arc/desktop-nightly/desktop-version-windows.json",
    );
  });
  it("rejects insecure configured release origins", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", "http://releases.example.test/arc");
    await expect(import("../src/desktop-update-provider.js")).rejects.toThrow(
      "HTTPS",
    );
  });
  it("supports Windows and macOS without consulting AppImage permissions", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", "https://releases.example.test");
    const provider = await import("../src/desktop-update-provider.js");
    const canReplaceAppImage = vi.fn(() => false);
    for (const platform of ["windows", "macos"] as const)
      expect(
        provider.resolveDesktopUpdateSupport({
          platform,
          env: {},
          canReplaceAppImage,
        }),
      ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(canReplaceAppImage).not.toHaveBeenCalled();
  });
  it("preserves Linux replaceable-AppImage requirements", async () => {
    vi.stubEnv("ARC_UPDATE_BASE_URL", "https://releases.example.test");
    const provider = await import("../src/desktop-update-provider.js");
    expect(
      provider.resolveDesktopUpdateSupport({
        platform: "linux",
        env: {},
        canReplaceAppImage: () => true,
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      provider.resolveDesktopUpdateSupport({
        platform: "linux",
        env: { APPIMAGE: "/tmp/ARC.AppImage" },
        canReplaceAppImage: () => false,
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      provider.resolveDesktopUpdateSupport({
        platform: "linux",
        env: { APPIMAGE: "/tmp/ARC.AppImage" },
        canReplaceAppImage: () => true,
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });
});

import { describe, expect, it } from "vitest";
import { CURSOR_ACP_MAINTENANCE, __testing } from "./provider-maintenance.js";

function cursorMissingInstallationStatus() {
  return {
    executableName: "agent",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Cursor",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

describe("ACP provider maintenance", () => {
  it("reads only documented CLI authentication states and rejects ambiguous output", () => {
    expect(
      __testing.parseCursorAccount("Logged in as cursor@example.com"),
    ).toEqual({ email: "cursor@example.com" });
    expect(__testing.parseCursorAccount("Authenticated with API key")).toEqual({
      email: null,
    });
    expect(__testing.parseCursorAccount("Not logged in")).toBeNull();
    expect(() => __testing.parseCursorAccount("agent 1.0.0")).toThrow(
      "recognized authentication state",
    );
    expect(() => __testing.parseCursorAccount(null)).toThrow(
      "could not be read",
    );
  });
  it("does not infer account quota through private Cursor APIs", async () => {
    await expect(CURSOR_ACP_MAINTENANCE.readUsage()).resolves.toEqual({
      supported: false,
    });
  });

  it("offers the installer only through a fresh matching action", () => {
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: CURSOR_ACP_MAINTENANCE,
          command: "agent",
          action: "install",
        },
      ),
    ).toMatchObject({
      available: true,
      command: {
        command:
          process.platform === "win32"
            ? expect.stringMatching(/(?:powershell|pwsh)\.exe$/iu)
            : "sh",
      },
      verification: { kind: "installed" },
    });
    expect(
      __testing.buildProviderInstallationRun(
        { ...cursorMissingInstallationStatus(), installAction: null },
        { maintenance: undefined, command: "opencode", action: "install" },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
    expect(
      __testing.buildProviderInstallationRun(
        cursorMissingInstallationStatus(),
        {
          maintenance: undefined,
          command: "opencode",
          action: "install",
        },
      ),
    ).toEqual({
      available: false,
      message: "opencode install is not available on this host.",
    });
  });
});

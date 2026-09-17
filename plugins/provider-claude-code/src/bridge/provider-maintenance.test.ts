import { describe, expect, it } from "vitest";
import { __testing, getClaudeProviderUsage } from "./provider-maintenance.js";

function missingInstallationStatus() {
  return {
    executableName: "claude",
    executablePath: null,
    installed: false,
    installSource: "notInstalled" as const,
    currentVersion: null,
    latestVersion: "2.1.0",
    minimumSupportedVersion: null,
    npmPackageName: "@anthropic-ai/claude-code",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install" as const,
      label: "Install" as const,
      command: "install Claude Code",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

describe("Claude Code provider maintenance", () => {
  it("validates the provider-owned CLI account state without reading credentials", () => {
    expect(
      __testing.parseClaudeStatus(
        '{"loggedIn":true,"email":"user@example.com","subscriptionType":"pro"}',
      ),
    ).toEqual({
      loggedIn: true,
      email: "user@example.com",
      subscriptionType: "pro",
    });
    expect(__testing.parseClaudeStatus('{"loggedIn":false}')).toEqual({
      loggedIn: false,
    });
    expect(() =>
      __testing.parseClaudeStatus('{"accessToken":"not-a-status"}'),
    ).toThrow();
  });
  it("does not claim usage from a private OAuth endpoint", async () => {
    await expect(getClaudeProviderUsage()).resolves.toEqual({
      supported: false,
    });
  });

  it("keeps the native installer plan private behind the run method", () => {
    const run = __testing.buildProviderInstallationRun(
      missingInstallationStatus(),
      "install",
    );
    expect(run).toMatchObject({
      available: true,
      command: {
        command:
          process.platform === "win32"
            ? expect.stringMatching(/(?:powershell|pwsh)\.exe$/iu)
            : "sh",
      },
      verification: { kind: "installed" },
    });
    expect(run.available && run.command.args.join(" ")).toContain(
      process.platform === "win32"
        ? "https://claude.ai/install.ps1"
        : "https://claude.ai/install.sh",
    );
  });
});

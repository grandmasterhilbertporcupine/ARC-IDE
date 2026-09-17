import { afterEach, describe, expect, it, vi } from "vitest";
import * as kit from "@get-bb/plugin-sdk/provider-bridge";
import type { CodexAppServerConnection } from "./app-server-connection.js";
import {
  __testing,
  getCodexProviderHealth,
  getCodexProviderUsage,
} from "./provider-maintenance.js";

function installationStatus() {
  return {
    executableName: "codex",
    executablePath: "/usr/local/bin/codex",
    installed: true,
    installSource: "npmGlobal" as const,
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: "1.0.0",
    installAction: {
      kind: "update" as const,
      label: "Update" as const,
      command: "codex update",
    },
    needsUpdate: true,
    versionUnsupported: false,
  };
}

function withReplies(replies: Record<string, unknown>) {
  const connection: CodexAppServerConnection = {
    request: async (args) => args.resultSchema.parse(replies[args.method]),
    notify: () => {},
    kill: async () => {},
    exited: false,
  };
  return <T>(work: (value: CodexAppServerConnection) => Promise<T>) =>
    work(connection);
}
afterEach(() => vi.restoreAllMocks());
function installed() {
  vi.spyOn(kit, "experimental_resolveExecutablePath").mockResolvedValue(
    "codex",
  );
  vi.spyOn(kit, "experimental_readCliVersion").mockResolvedValue("0.150.0");
}
describe("Codex app-server maintenance", () => {
  it("owns the stricter CLI requirement for thread rewind", () => {
    expect(__testing.minimumSupportedVersionForRequirement()).toBe("0.136.0");
    expect(
      __testing.minimumSupportedVersionForRequirement("thread_rewind"),
    ).toBe("0.143.0");
  });
  it("rejects a stale installation action", () => {
    expect(
      __testing.buildProviderInstallationRun(installationStatus(), "install"),
    ).toMatchObject({ available: false });
  });
  it("updates the npm installation instead of a shadowing native Codex executable", () => {
    const status = {
      ...installationStatus(),
      executablePath: "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd",
    };
    expect(
      __testing.buildProviderInstallationRun(status, "update"),
    ).toMatchObject({
      available: true,
      command: kit.experimental_npmGlobalInstallCommand("@openai/codex"),
      verification: { kind: "version_at_least", version: "1.1.0" },
    });
  });
  it("updates the exact discovered external executable when PATH contains multiple installations", () => {
    const command = "C:\\Tools With Spaces\\Codex\\codex.exe";
    expect(
      __testing.buildProviderInstallationRun(
        {
          ...installationStatus(),
          installSource: "external",
          executablePath: command,
        },
        "update",
      ),
    ).toMatchObject({
      available: true,
      command: { command, args: ["update"] },
    });
  });
  it("requires runtime-confirmed authentication and reads only public account fields", async () => {
    installed();
    await expect(
      getCodexProviderHealth(
        withReplies({
          "account/read": { account: null, requiresOpenaiAuth: true },
        }),
      ),
    ).resolves.toMatchObject({ health: { status: "unauthenticated" } });
    await expect(
      getCodexProviderHealth(
        withReplies({
          "account/read": {
            account: {
              type: "chatgpt",
              email: "user@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: true,
          },
        }),
      ),
    ).resolves.toMatchObject({
      health: {
        status: "ready",
        accountEmail: "user@example.com",
        planLabel: "pro",
        loginCommand: expect.stringContaining("node -e"),
      },
    });
    await expect(
      getCodexProviderHealth(
        withReplies({
          "account/read": { account: { access_token: "must-never-use" } },
        }),
      ),
    ).resolves.toMatchObject({
      health: { status: "unknown", accountEmail: null },
    });
  });
  it("prefers documented multi-bucket rate limits and preserves unavailable windows", () => {
    expect(
      __testing.normalizeUsage(
        {
          rateLimits: {
            primary: {
              usedPercent: 100,
              resetsAt: null,
              windowDurationMins: null,
            },
          },
          rateLimitsByLimitId: {
            codex: {
              primary: {
                usedPercent: 42.4,
                resetsAt: 1750000000,
                windowDurationMins: 300,
              },
              secondary: null,
            },
          },
        },
        { type: "chatgpt", email: "user@example.com", planType: "pro" },
      ),
    ).toMatchObject({
      status: "ok",
      windows: [
        {
          label: "codex current limit",
          usedPercent: 42,
          resetsAt: "2025-06-15T15:06:40.000Z",
        },
      ],
    });
    expect(__testing.normalizeUsage({ rateLimits: null }, null)).toMatchObject({
      status: "error",
    });
  });
  it("does not claim subscription quota for an API key and reports RPC failures", async () => {
    installed();
    await expect(
      getCodexProviderUsage(
        withReplies({
          "account/read": {
            account: { type: "apiKey" },
            requiresOpenaiAuth: true,
          },
        }),
      ),
    ).resolves.toEqual({ supported: false });
    await expect(getCodexProviderUsage(withReplies({}))).resolves.toMatchObject(
      { usage: { status: "error" } },
    );
  });
});

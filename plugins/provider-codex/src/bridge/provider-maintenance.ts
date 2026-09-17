import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsage,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import type { CodexAppServerConnection } from "./app-server-connection.js";
import { codexLoginCommand } from "./codex-login.js";

type WithCodexConnection = <T>(
  work: (connection: CodexAppServerConnection) => Promise<T>,
) => Promise<T>;

const CODEX_MINIMUM_SUPPORTED_VERSION = "0.136.0";
const CODEX_REWIND_MINIMUM_SUPPORTED_VERSION = "0.143.0";
const CODEX_NPM_PACKAGE = "@openai/codex";

function minimumSupportedVersionForRequirement(
  requirement?: "thread_rewind",
): string {
  return requirement === "thread_rewind"
    ? CODEX_REWIND_MINIMUM_SUPPORTED_VERSION
    : CODEX_MINIMUM_SUPPORTED_VERSION;
}

function codexUpdateCommand(
  status: Pick<ProviderInstallationStatus, "installSource" | "executablePath">,
): {
  command: string;
  args: string[];
  displayCommand: string;
} {
  if (status.installSource === "npmGlobal") {
    return npmGlobalInstallCommand(CODEX_NPM_PACKAGE);
  }
  const command = status.executablePath ?? "codex";
  const args = ["update"];
  return {
    command,
    args,
    displayCommand: formatCommand(command, args),
  };
}

export async function getCodexProviderInstallationStatus(
  requirement?: "thread_rewind",
): Promise<ProviderInstallationStatus> {
  const minimumSupportedVersion =
    minimumSupportedVersionForRequirement(requirement);
  const [resolvedExecutable, versionOutput, latestVersion, npmGlobal] =
    await Promise.all([
      resolveExecutablePath("codex"),
      commandOutput("codex", ["--version"]),
      npmLatestVersion(CODEX_NPM_PACKAGE),
      probeNpmGlobalPackage(CODEX_NPM_PACKAGE),
    ]);
  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const needsUpdate =
    installed &&
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const versionUnsupported =
    installed &&
    (currentVersion === null
      ? requirement === "thread_rewind"
      : compareVersions(currentVersion, minimumSupportedVersion) < 0);
  const actionKind = !installed
    ? "install"
    : needsUpdate || versionUnsupported
      ? "update"
      : null;
  const installSource = npmGlobalInstallSource({
    installed,
    executablePath: resolvedExecutable,
    npmBin: npmGlobal.npmBin,
  });

  return {
    executableName: "codex",
    executablePath: resolvedExecutable,
    installed,
    installSource,
    currentVersion,
    latestVersion,
    minimumSupportedVersion,
    npmPackageName: CODEX_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command:
              actionKind === "install"
                ? npmGlobalInstallCommand(CODEX_NPM_PACKAGE).displayCommand
                : codexUpdateCommand({
                    installSource,
                    executablePath: resolvedExecutable,
                  }).displayCommand,
          },
    needsUpdate,
    versionUnsupported,
  };
}

export async function getCodexProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getCodexProviderInstallationStatus();
  return buildCodexProviderInstallationRun(status, action);
}

function buildCodexProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Codex ${action} is no longer available on this host.`,
    };
  }
  return {
    available: true,
    command:
      action === "install"
        ? npmGlobalInstallCommand(CODEX_NPM_PACKAGE)
        : codexUpdateCommand(status),
    verification: installationVerification(status, action),
  };
}

function healthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "expired"
    | "unsupported_version"
    | "unknown",
  args: {
    accountEmail?: string | null;
    installedVersion?: string | null;
    planLabel?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: args.planLabel ?? null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: CODEX_MINIMUM_SUPPORTED_VERSION,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: codexLoginCommand(),
    },
  };
}

const accountResponseSchema = z.object({
  account: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("apiKey") }),
      z.object({
        type: z.literal("chatgpt"),
        email: z.string(),
        planType: z.string(),
      }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});

const usageWindowSchema = z.object({
  usedPercent: z.number().finite(),
  resetsAt: z.number().finite().nullable(),
  windowDurationMins: z.number().finite().nullable(),
});
const rateLimitSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  primary: usageWindowSchema.nullish(),
  secondary: usageWindowSchema.nullish(),
});
const usageResponseSchema = z.object({
  rateLimits: rateLimitSchema.nullish(),
  rateLimitsByLimitId: z.record(z.string(), rateLimitSchema).nullish(),
});

function readAccount(connection: CodexAppServerConnection) {
  return connection.request({
    method: "account/read",
    params: { refreshToken: false },
    resultSchema: accountResponseSchema,
    timeoutMs: 15_000,
  });
}

export async function getCodexProviderHealth(
  withConnection: WithCodexConnection,
): Promise<ProviderHealthResult> {
  if ((await resolveExecutablePath("codex")) === null)
    return healthResult("not_installed");
  const version = await readCliVersion("codex");
  if (
    version !== null &&
    compareVersions(version, CODEX_MINIMUM_SUPPORTED_VERSION) < 0
  ) {
    return healthResult("unsupported_version", { installedVersion: version });
  }
  try {
    const { account, requiresOpenaiAuth } = await withConnection(readAccount);
    if (account === null && requiresOpenaiAuth)
      return healthResult("unauthenticated", { installedVersion: version });
    return healthResult("ready", {
      installedVersion: version,
      accountEmail: account?.type === "chatgpt" ? account.email : null,
      planLabel: account?.type === "chatgpt" ? account.planType : null,
    });
  } catch {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage:
        "Codex app-server could not verify account readiness. Sign in again or inspect the provider runtime.",
    });
  }
}

function usageWindow(
  value: z.infer<typeof usageWindowSchema> | null | undefined,
  label: string,
): ProviderUsageWindow | null {
  if (!value) return null;
  const reset =
    value.resetsAt === null ? null : new Date(value.resetsAt * 1000);
  return {
    label: value.windowDurationMins === 10_080 ? `${label} (weekly)` : label,
    usedPercent: clampPercent(value.usedPercent),
    resetsAt:
      reset === null || !Number.isFinite(reset.getTime())
        ? null
        : reset.toISOString(),
  };
}

function normalizeUsage(
  raw: unknown,
  account: z.infer<typeof accountResponseSchema>["account"],
): ProviderUsage {
  const parsed = usageResponseSchema.safeParse(raw);
  if (!parsed.success)
    return {
      status: "error",
      message: "Codex app-server returned malformed usage information.",
      planLabel: null,
      accountEmail: null,
    };
  const buckets = parsed.data.rateLimitsByLimitId
    ? Object.entries(parsed.data.rateLimitsByLimitId)
    : [];
  const rates =
    buckets.length > 0
      ? buckets
      : parsed.data.rateLimits
        ? [["codex", parsed.data.rateLimits] as const]
        : [];
  const windows = rates
    .flatMap(([id, value]) => [
      usageWindow(value.primary, `${value.limitName ?? id} current limit`),
      usageWindow(value.secondary, `${value.limitName ?? id} extended limit`),
    ])
    .filter((window): window is ProviderUsageWindow => window !== null);
  if (windows.length === 0)
    return {
      status: "error",
      message: "Usage information is unavailable from Codex app-server.",
      planLabel: null,
      accountEmail: account?.type === "chatgpt" ? account.email : null,
    };
  return {
    status: "ok",
    accountEmail: account?.type === "chatgpt" ? account.email : null,
    planLabel: account?.type === "chatgpt" ? account.planType : null,
    windows,
  };
}

export async function getCodexProviderUsage(
  withConnection: WithCodexConnection,
): Promise<ProviderUsageResult> {
  if ((await resolveExecutablePath("codex")) === null)
    return { supported: true, usage: { status: "not_installed" } };
  try {
    return await withConnection(async (connection) => {
      const { account, requiresOpenaiAuth } = await readAccount(connection);
      if (account === null && requiresOpenaiAuth)
        return { supported: true, usage: { status: "unauthenticated" } };
      if (account?.type !== "chatgpt") return { supported: false };
      const response = await connection.request({
        method: "account/rateLimits/read",
        resultSchema: usageResponseSchema,
        timeoutMs: 15_000,
      });
      return { supported: true, usage: normalizeUsage(response, account) };
    });
  } catch {
    return {
      supported: true,
      usage: {
        status: "error",
        message: "Usage information could not be read from Codex app-server.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }
}

export const __testing = {
  buildProviderInstallationRun: buildCodexProviderInstallationRun,
  minimumSupportedVersionForRequirement,
  normalizeUsage,
  accountResponseSchema,
};

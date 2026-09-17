import {
  experimental_killProcessGroup as killProcessGroup,
  experimental_resolveWindowsPowerShell as resolveWindowsPowerShell,
  experimental_spawnPortableProcess as spawnPortableProcess,
  experimental_supportsProcessGroups as supportsProcessGroups,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsageResult,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

function claudeInstaller() {
  if (process.platform !== "win32")
    return downloadedInstallerCommand("https://claude.ai/install.sh");
  const command = resolveWindowsPowerShell();
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression",
  ];
  return { command, args, displayCommand: formatCommand(command, args) };
}

function claudeExecutable(): string {
  return process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
}

function claudeDistTags(value: string | null): {
  latest: string;
  stable: string | null;
} | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        latest: z.string().min(1),
        stable: z.string().min(1).optional(),
      })
      .safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const latest = versionFrom(parsed.data.latest);
    if (latest === null) return null;
    return {
      latest,
      stable:
        parsed.data.stable === undefined
          ? latest
          : versionFrom(parsed.data.stable),
    };
  } catch {
    return null;
  }
}

function claudeDoctor(value: string | null): {
  installMethod: "native" | "npm-global" | "package-manager" | "unknown" | null;
  updateChannel: "latest" | "stable" | null;
} {
  const running =
    value === null ? null : /^Running:\s+([^\s(]+)/mu.exec(value)?.[1];
  const channel =
    value === null
      ? null
      : /^Auto-update channel:\s+(latest|stable)\s*$/mu.exec(value)?.[1];
  return {
    installMethod:
      running === "native" || running === "npm-global"
        ? running
        : running !== null && running !== undefined
          ? ["homebrew", "winget", "apt", "dnf", "apk"].includes(running)
            ? "package-manager"
            : "unknown"
          : null,
    updateChannel:
      channel === "latest" || channel === "stable" ? channel : null,
  };
}

function isDefaultNativeClaudePath(executablePath: string | null): boolean {
  if (executablePath === null) return false;
  const normalized = executablePath.replace(/\\/gu, "/");
  return (
    normalized.endsWith("/.local/bin/claude") ||
    (process.platform === "win32" &&
      normalized.endsWith("/.local/bin/claude.exe"))
  );
}

export async function getClaudeProviderInstallationStatus(): Promise<ProviderInstallationStatus> {
  const command = claudeExecutable();
  const [
    resolvedExecutable,
    versionOutput,
    tagsOutput,
    npmGlobal,
    doctorOutput,
  ] = await Promise.all([
    resolveExecutablePath(command),
    commandOutput(command, ["--version"]),
    commandOutput(npmCommand(), [
      "view",
      CLAUDE_NPM_PACKAGE,
      "dist-tags",
      "--json",
    ]),
    probeNpmGlobalPackage(CLAUDE_NPM_PACKAGE),
    commandOutput(command, ["doctor"]),
  ]);
  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const doctor = claudeDoctor(doctorOutput);
  const tags = claudeDistTags(tagsOutput);
  const latestVersion =
    doctor.updateChannel === null || tags === null
      ? null
      : tags[doctor.updateChannel];
  const definitelyNeedsUnknownChannelUpdate =
    installed &&
    currentVersion !== null &&
    tags?.stable !== null &&
    tags?.stable !== undefined &&
    compareVersions(tags.latest, currentVersion) > 0 &&
    compareVersions(tags.stable, currentVersion) > 0;
  const needsUpdate =
    installed && currentVersion !== null && latestVersion !== null
      ? compareVersions(latestVersion, currentVersion) > 0
      : definitelyNeedsUnknownChannelUpdate;
  const installSource = npmGlobalInstallSource({
    installed,
    executablePath: resolvedExecutable,
    npmBin: npmGlobal.npmBin,
  });
  const nativeFallback =
    doctor.installMethod === null &&
    installSource === "external" &&
    isDefaultNativeClaudePath(resolvedExecutable);
  const canRunUpdate =
    doctor.installMethod === "native" ||
    nativeFallback ||
    (installSource === "npmGlobal" &&
      (doctor.installMethod === null || doctor.installMethod === "npm-global"));
  const actionKind = !installed
    ? "install"
    : needsUpdate && canRunUpdate
      ? "update"
      : null;
  const displayCommand =
    actionKind === "install"
      ? claudeInstaller().displayCommand
      : formatCommand(command, ["update"]);
  return {
    executableName: command,
    executablePath: resolvedExecutable,
    installed,
    installSource,
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: CLAUDE_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command: displayCommand,
          },
    needsUpdate,
    versionUnsupported: false,
  };
}

export async function getClaudeProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getClaudeProviderInstallationStatus();
  return buildClaudeProviderInstallationRun(status, action);
}

function buildClaudeProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Claude Code ${action} is no longer available on this host.`,
    };
  }
  const command = claudeExecutable();
  const execution =
    action === "install"
      ? claudeInstaller()
      : {
          command,
          args: ["update"],
          displayCommand: formatCommand(command, ["update"]),
        };
  return {
    available: true,
    command: execution,
    verification: installationVerification(status, action),
  };
}

function healthResult(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  args: {
    accountEmail?: string | null;
    planLabel?: string | null;
    installedVersion?: string | null;
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
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: formatCommand(claudeExecutable(), ["auth", "login"]),
    },
  };
}

const claudeStatusSchema = z.object({
  loggedIn: z.boolean(),
  email: z.string().email().nullish(),
  subscriptionType: z.string().min(1).nullish(),
});

function parseClaudeStatus(raw: string) {
  return claudeStatusSchema.parse(JSON.parse(raw));
}

async function readClaudeStatus(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnPortableProcess({
      command,
      args: ["auth", "status"],
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: supportsProcessGroups(),
    });
    let output = "";
    const timer = setTimeout(() => {
      killProcessGroup({ child, signal: "SIGKILL" });
      reject(new Error("Claude authentication status timed out."));
    }, 15_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 65_536) {
        killProcessGroup({ child, signal: "SIGKILL" });
        reject(
          new Error("Claude authentication status exceeded its output limit."),
        );
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Claude authentication status could not start."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) resolve(output);
      else reject(new Error("Claude authentication status failed."));
    });
  });
}

export async function getClaudeProviderHealth(): Promise<ProviderHealthResult> {
  const command = claudeExecutable();
  if ((await resolveExecutablePath(command)) === null)
    return healthResult("not_installed");
  const version = await readCliVersion(command);
  try {
    const status = parseClaudeStatus(await readClaudeStatus(command));
    return healthResult(status.loggedIn ? "ready" : "unauthenticated", {
      installedVersion: version,
      accountEmail: status.email ?? null,
      planLabel: status.subscriptionType ?? null,
    });
  } catch {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage:
        "Claude could not verify authentication. Run claude auth status or sign in again.",
    });
  }
}

export async function getClaudeProviderUsage(): Promise<ProviderUsageResult> {
  return { supported: false };
}

export const __testing = {
  buildProviderInstallationRun: buildClaudeProviderInstallationRun,
  parseClaudeStatus,
};

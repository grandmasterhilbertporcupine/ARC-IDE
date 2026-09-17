import { resolveWindowsPowerShell } from "@bb/process-utils";
import type {
  ProviderHealthResult,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderUsageResult,
} from "@bb/provider-bridge-protocol";
import {
  commandOutput,
  downloadedInstallerCommand,
  formatCommand,
  readCliVersion,
  resolveExecutablePath,
} from "@bb/provider-bridge-protocol/bridge-kit";

export interface AcpMaintenanceDialect {
  loginCommand: string;
  installer(): { command: string; args: string[]; displayCommand: string };
  readAccount(): Promise<{ email: string | null } | null>;
  readUsage(): Promise<ProviderUsageResult>;
}

function healthResult(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  status: "ready" | "not_installed" | "unauthenticated" | "unknown";
  accountEmail?: string | null;
  installedVersion?: string | null;
  statusMessage?: string | null;
}): ProviderHealthResult {
  const maintained = args.maintenance !== undefined;
  return {
    supported: true,
    health: {
      status: args.status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: maintained,
      canUpdate: maintained && args.status !== "not_installed",
      loginCommand: args.maintenance?.loginCommand ?? null,
    },
  };
}

export async function getAcpProviderHealth(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderHealthResult> {
  const maintenance = args.maintenance;
  if (args.command === null) {
    return healthResult({
      maintenance,
      status: "unknown",
      statusMessage: "The ACP provider has no launch command.",
    });
  }
  if ((await resolveExecutablePath(args.command)) === null) {
    return healthResult({ maintenance, status: "not_installed" });
  }
  const version = await readCliVersion(args.command);
  if (maintenance === undefined) {
    return healthResult({
      maintenance,
      status: "unknown",
      installedVersion: version,
      statusMessage:
        "Installed. Authentication readiness has not been verified by this runtime.",
    });
  }
  try {
    const account = await maintenance.readAccount();
    return healthResult({
      maintenance,
      status: account === null ? "unauthenticated" : "ready",
      accountEmail: account?.email ?? null,
      installedVersion: version,
    });
  } catch (error) {
    return healthResult({
      maintenance,
      status: "unknown",
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAcpProviderInstallationStatus(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderInstallationStatus> {
  const executableName = args.command ?? "";
  const resolvedExecutable =
    args.command === null ? null : await resolveExecutablePath(args.command);
  const installed = resolvedExecutable !== null;
  const currentVersion =
    installed && args.command !== null
      ? await readCliVersion(args.command)
      : null;
  const installAction =
    args.maintenance !== undefined && !installed
      ? {
          kind: "install" as const,
          label: "Install" as const,
          command: args.maintenance.installer().displayCommand,
        }
      : null;
  return {
    executableName,
    executablePath: resolvedExecutable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

export async function getAcpProviderInstallationRun(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
  action: "install" | "update";
}): Promise<ProviderInstallationRunResult> {
  const status = await getAcpProviderInstallationStatus(args);
  return buildAcpProviderInstallationRun(status, args);
}

function buildAcpProviderInstallationRun(
  status: ProviderInstallationStatus,
  args: {
    maintenance: AcpMaintenanceDialect | undefined;
    command: string | null;
    action: "install" | "update";
  },
): ProviderInstallationRunResult {
  if (
    status.installAction?.kind !== args.action ||
    args.maintenance === undefined
  ) {
    return {
      available: false,
      message: `${args.command ?? "This ACP agent"} ${args.action} is not available on this host.`,
    };
  }
  return {
    available: true,
    command: args.maintenance.installer(),
    verification: { kind: "installed" },
  };
}

export async function getAcpProviderUsage(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
}): Promise<ProviderUsageResult> {
  if (args.maintenance === undefined) return { supported: false };
  if (
    args.command === null ||
    (await resolveExecutablePath(args.command)) === null
  ) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  return args.maintenance.readUsage();
}

function parseCursorAccount(
  output: string | null,
): { email: string | null } | null {
  if (output === null)
    throw new Error(
      "Cursor authentication status could not be read. Run agent status.",
    );
  const status = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  if (
    /not (?:logged in|authenticated)|unauthenticated|logged out/iu.test(status)
  )
    return null;
  if (!/(?:logged in|authenticated)(?:\s|:|$)/iu.test(status)) {
    throw new Error(
      "Cursor did not report a recognized authentication state. Run agent status.",
    );
  }
  const email =
    status.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu)?.[0] ?? null;
  return { email };
}

function cursorInstaller(): {
  command: string;
  args: string[];
  displayCommand: string;
} {
  if (process.platform !== "win32")
    return downloadedInstallerCommand("https://cursor.com/install");
  const command = resolveWindowsPowerShell();
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Invoke-RestMethod 'https://cursor.com/install?win32=true' | Invoke-Expression",
  ];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export const CURSOR_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: "agent login",
  installer: cursorInstaller,
  readAccount: async () =>
    parseCursorAccount(await commandOutput("agent", ["status"])),
  readUsage: async () => ({ supported: false }),
};

export const __testing = {
  buildProviderInstallationRun: buildAcpProviderInstallationRun,
  parseCursorAccount,
};

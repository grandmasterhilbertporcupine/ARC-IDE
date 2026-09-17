export function installerGuid(appId: string): string;
export function assertSafeInstallationState(
  raw: unknown,
  appGuid: string,
  ownedDirectory?: string | null,
): unknown;
export function nsisArguments(directory?: string | null): string[];
export function requireValidSignature(metadata: unknown): void;
export function parseInstallerMetadata(
  raw: unknown,
  expectedVersion?: string | null,
): {
  product: "ARC";
  version: string;
  fileVersion: string;
  signatureStatus: string;
  signerThumbprint: string | null;
};
export function installerUninstallerName(config: unknown): string;
export function runInstallerSmoke(
  installer: string,
  options?: {
    upgradeInstaller?: string;
    requireSignature?: boolean;
    releaseManifest?: string;
  },
): Promise<Record<string, unknown>>;

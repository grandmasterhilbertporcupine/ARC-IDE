export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
}
export interface ReleaseManifest {
  schemaVersion: 1;
  files: ReleaseFile[];
  digest: string;
}
export interface ReleaseSource extends ReleaseManifest {
  commit: string;
  tree: string;
}
export interface SourceIdentity {
  commit: string;
  tree: string;
  digest: string;
}
export interface VerificationStep {
  id: string;
  args: string[];
  logPath: string;
  logSha256: string;
}
export interface SourceReceipt {
  schemaVersion: 1;
  kind: "source";
  status: "passed";
  source: SourceIdentity;
  steps: VerificationStep[];
}
export interface PackagedReceipt {
  schemaVersion: 1;
  kind: "packaged";
  status: "passed";
  buildSha256: string;
  payloadDigest: string;
  steps: VerificationStep[];
}
export interface InstallerReceipt {
  schemaVersion: 1;
  kind: "installer";
  status: "passed";
  buildSha256: string;
  payloadDigest: string;
  installerSha256: string;
  installedPayloadDigest: string;
  reinstalledPayloadDigest: string;
  packagedVerificationSha256: string;
  reportSha256: string;
}
export interface ReleaseBuild {
  schemaVersion: 1;
  buildId: string;
  version: string;
  source: SourceIdentity;
  sourceManifestSha256: string;
  sourceVerificationSha256: string;
  payloadDigest: string;
  payloadManifestSha256: string;
  assets: ReleaseFile[];
}
export function digestJson(value: unknown): string;
export function hashFile(path: string): Promise<string>;
export function pathWithin(root: string, path: string): string;
export function fileEntry(root: string, name: string): Promise<ReleaseFile>;
export function createManifest(files: ReleaseFile[]): ReleaseManifest;
export function verifyManifest(raw: unknown): ReleaseManifest;
export function sourceIdentity(source: SourceIdentity): SourceIdentity;
export function captureReleaseSource(
  repository: string,
): Promise<ReleaseSource>;
export function capturePayload(
  directory: string,
  installed?: boolean,
): Promise<ReleaseManifest>;
export function assertPayload(
  directory: string,
  expected: ReleaseManifest,
  installed?: boolean,
): Promise<ReleaseManifest>;
export function readJson(file: string): Promise<unknown>;
export function writeJson(file: string, value: unknown): Promise<void>;
export function verifySourceReceipt(
  raw: unknown,
  source: SourceIdentity,
): SourceReceipt;
export function verifyPackagedReceipt(
  raw: unknown,
  buildSha256: string,
  payloadDigest: string,
): PackagedReceipt;
export function verifyInstallerReceipt(
  raw: unknown,
  expected: Pick<
    InstallerReceipt,
    | "buildSha256"
    | "payloadDigest"
    | "installerSha256"
    | "packagedVerificationSha256"
    | "reportSha256"
  >,
): InstallerReceipt;
export function loadReleaseBuild(release: string): Promise<{
  build: ReleaseBuild;
  source: ReleaseSource;
  payload: ReleaseManifest;
  buildSha256: string;
}>;
export function assertCurrentSource(
  repository: string,
  source: ReleaseSource,
): Promise<void>;
export function verifyReceiptLogs(
  directory: string,
  receipt: SourceReceipt | PackagedReceipt,
): Promise<void>;
export function copyReceiptLogs(
  from: string,
  to: string,
  receipt: SourceReceipt | PackagedReceipt,
): Promise<void>;
export function verifyReleaseUpdateAssets(
  release: string,
  version: string,
): Promise<{
  version: string;
  path: string;
  sha512: string;
  files: Array<{ url: string; sha512: string; size: number }>;
}>;

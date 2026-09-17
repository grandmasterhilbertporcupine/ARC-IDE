import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assertCurrentSource,
  capturePayload,
  captureReleaseSource,
  copyReceiptLogs,
  fileEntry,
  hashFile,
  pathWithin,
  readJson,
  sourceIdentity,
  verifyReceiptLogs,
  verifyReleaseUpdateAssets,
  verifySourceReceipt,
  writeJson,
} from "./release-provenance.mjs";
import { runReleaseCommand } from "./run-release-command.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
assert.equal(
  process.platform,
  "win32",
  "ARC release builds require native Windows.",
);
assert(
  process.env.ARC_UPDATE_BASE_URL === undefined,
  "Release builds require the default public GitHub feed; unset ARC_UPDATE_BASE_URL.",
);
assert(
  !process.env.BB_DESKTOP_RELEASE_CHANNEL ||
    process.env.BB_DESKTOP_RELEASE_CHANNEL === "latest",
  "Release builds require the stable channel.",
);
const source = await captureReleaseSource(repository);
const versionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
});
const { version } = versionSchema.parse(
  await readJson(join(repository, "apps/desktop/package.json")),
);
assert.equal(
  versionSchema.parse(
    await readJson(join(repository, "packages/bb-app/package.json")),
  ).version,
  version,
  "Desktop and bundled app versions must agree.",
);
const sourceReceipt = verifySourceReceipt(
  await readJson(
    join(repository, ".arc-verification/mvp/source-verification.json"),
  ),
  source,
);
await verifyReceiptLogs(
  join(repository, ".arc-verification/mvp"),
  sourceReceipt,
);
const buildId = randomUUID();
const evidence = pathWithin(
  repository,
  `.arc-verification/mvp/build-${buildId}`,
);
await mkdir(evidence, { recursive: true });
const release = pathWithin(repository, "apps/desktop/release");
try {
  const info = await lstat(release);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    "Existing release output must be a regular directory.",
  );
  await rename(release, pathWithin(evidence, "previous-release"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await runReleaseCommand(
  repository,
  [
    "exec",
    "turbo",
    "run",
    "release:package",
    "--filter=@bb/desktop",
    "--concurrency=1",
    "--force",
  ],
  join(evidence, "build.log"),
  {
    BB_DESKTOP_RELEASE_CHANNEL: "latest",
    BB_DESKTOP_COMMIT: source.commit,
    BB_DESKTOP_BUILD_DATE: new Date().toISOString(),
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
  ],
);
await assertCurrentSource(repository, source);
const payload = await capturePayload(join(release, "win-unpacked"));
await verifyReleaseUpdateAssets(release, version);
await writeJson(join(release, "source-manifest.json"), source);
await writeJson(join(release, "source-verification.json"), sourceReceipt);
await copyReceiptLogs(
  join(repository, ".arc-verification/mvp"),
  join(release, "verification-logs"),
  sourceReceipt,
);
await writeJson(join(release, "payload-manifest.json"), payload);
const assets = [];
for (const name of [
  `ARC-${version}-x64.exe`,
  `ARC-${version}-x64.exe.blockmap`,
  "latest.yml",
])
  assets.push(await fileEntry(release, name));
await writeJson(join(release, "release-build.json"), {
  schemaVersion: 1,
  buildId,
  version,
  source: sourceIdentity(source),
  sourceManifestSha256: await hashFile(join(release, "source-manifest.json")),
  sourceVerificationSha256: await hashFile(
    join(release, "source-verification.json"),
  ),
  payloadDigest: payload.digest,
  payloadManifestSha256: await hashFile(join(release, "payload-manifest.json")),
  assets,
});
console.log(`Frozen release build: ${join(release, "release-build.json")}`);

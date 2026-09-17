import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { z } from "zod";
import { bbDesktopVersionFeedSchema } from "@bb/desktop-contract";
import {
  assertCurrentSource,
  assertPayload,
  fileEntry,
  hashFile,
  loadReleaseBuild,
  readJson,
  verifyInstallerReceipt,
  verifyPackagedReceipt,
  verifyReceiptLogs,
} from "./release-provenance.mjs";

const root = process.cwd();
const release = resolve(root, "release");
const repository = "https://github.com/grandmasterhilbertporcupine/ARC-IDE";
const pkg = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .parse(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")));
const name = `ARC-${pkg.version}-x64.exe`;
const frozen = await loadReleaseBuild(release);
assert.equal(
  frozen.build.version,
  pkg.version,
  "Release build version differs from the source package.",
);
await assertCurrentSource(resolve(root, "../.."), frozen.source);
await assertPayload(resolve(release, "win-unpacked"), frozen.payload);
const packagedReceipt = verifyPackagedReceipt(
  await readJson(resolve(release, "packaged-verification.json")),
  frozen.buildSha256,
  frozen.payload.digest,
);
await verifyReceiptLogs(resolve(release, "verification-logs"), packagedReceipt);
const installerDigest = await hashFile(resolve(release, name));
const installerReceipt = verifyInstallerReceipt(
  await readJson(resolve(release, "installer-verification.json")),
  {
    buildSha256: frozen.buildSha256,
    payloadDigest: frozen.payload.digest,
    installerSha256: installerDigest,
    packagedVerificationSha256: await hashFile(
      resolve(release, "packaged-verification.json"),
    ),
    reportSha256: await hashFile(resolve(release, "installer-result.json")),
  },
);
z.object({
  status: z.literal("passed"),
  installerSha256: z.literal(installerDigest),
  transition: z.literal("same-version reinstall"),
  installedPayloadDigest: z.literal(frozen.payload.digest),
  reinstalledPayloadDigest: z.literal(frozen.payload.digest),
  baseline: z.object({
    version: z.literal(pkg.version),
    sha256: z.literal(installerDigest),
  }),
  next: z.object({
    version: z.literal(pkg.version),
    sha256: z.literal(installerDigest),
  }),
}).parse(await readJson(resolve(release, "installer-result.json")));
const metadata = z
  .object({
    version: z.literal(pkg.version),
    path: z.literal(name),
    releaseDate: z.iso.datetime(),
    sha512: z.string().min(1),
    files: z
      .array(
        z.object({
          url: z.literal(name),
          sha512: z.string().min(1),
          size: z.number().int().positive(),
        }),
      )
      .length(1),
  })
  .parse(parse(await readFile(resolve(release, "latest.yml"), "utf8")));
let feed = bbDesktopVersionFeedSchema.parse({
  ...metadata,
  schemaVersion: 1,
  channel: "latest",
  platform: "windows",
  releaseName: `ARC desktop ${pkg.version}`,
  releaseNotes: null,
  minimumSystemVersion: null,
  stagingPercentage: null,
});
try {
  feed = bbDesktopVersionFeedSchema.parse(
    JSON.parse(
      await readFile(resolve(release, "desktop-version-windows.json"), "utf8"),
    ),
  );
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}
const config = z
  .object({
    provider: z.literal("github"),
    owner: z.literal("grandmasterhilbertporcupine"),
    repo: z.literal("ARC-IDE"),
    channel: z.literal("latest"),
    updaterCacheDirName: z.literal("arc-desktop-updater"),
  })
  .parse(
    parse(
      await readFile(
        resolve(release, "win-unpacked/resources/app-update.yml"),
        "utf8",
      ),
    ),
  );
if (
  feed.version !== pkg.version ||
  feed.platform !== "windows" ||
  feed.channel !== "latest" ||
  feed.path !== name ||
  feed.sha512 !== metadata.sha512 ||
  JSON.stringify(feed.files) !== JSON.stringify(metadata.files)
) {
  throw new Error(
    "The installer, GitHub update configuration and version feeds must agree.",
  );
}
const sha256 = createHash("sha256");
const sha512 = createHash("sha512");
for await (const chunk of createReadStream(resolve(release, name))) {
  sha256.update(chunk);
  sha512.update(chunk);
}
const digest = sha256.digest("hex");
const installerSize = (await stat(resolve(release, name))).size;
if (
  sha512.digest("base64") !== metadata.sha512 ||
  metadata.files[0].sha512 !== metadata.sha512 ||
  metadata.files[0].size !== installerSize ||
  (await stat(resolve(release, `${name}.blockmap`))).size === 0
) {
  throw new Error(
    "Installer bytes do not match the published update metadata.",
  );
}
await writeFile(
  resolve(release, "desktop-version-windows.json"),
  JSON.stringify(feed, null, 2) + "\n",
);
await writeFile(resolve(release, `${name}.sha256`), `${digest}  ${name}\n`);
await writeFile(
  resolve(release, `ARC-${pkg.version}-x64.install.txt`),
  `ARC ${pkg.version} for Windows 11 x64\n\n` +
    `Public download pending; locally verified personal build. No publication was performed.\n` +
    `Intended release destination: ${repository}/releases/tag/v${pkg.version}\n` +
    `Run ${name}; choose your installation folder and Desktop/Start menu shortcuts.\n` +
    `The uninstaller preserves ARC data and project files.\n\n` +
    `Electron, Node, the frontend, server, daemon, CLI, plugins and Context assets are bundled.\n` +
    `Install Git separately for repository operations. Open Settings > Providers for provider setup and sign-in.\n` +
    `Provider executables and accounts are external prerequisites; npm-based setup needs external Node/npm.\n\n` +
    `This personal build is unsigned. Check its source and SHA-256 before running.\n` +
    `SHA-256: ${digest}\n\n` +
    `Source commit: ${frozen.source.commit}\nSource tree: ${frozen.source.tree}\nPayload manifest: ${frozen.payload.digest}\n\n` +
    `GitHub updates are enabled: ARC checks on launch, periodically, and through Settings > Updates.\n` +
    `New stable releases download in the background and install on restart/quit.\n` +
    `Older local builds with updates disabled require this installer once to enable future updates.\n`,
);
await writeFile(
  resolve(release, "release-provenance.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      build: frozen.build,
      buildSha256: frozen.buildSha256,
      sourceVerification: await readJson(
        resolve(release, "source-verification.json"),
      ),
      packagedVerification: packagedReceipt,
      installerVerification: installerReceipt,
    },
    null,
    2,
  ) + "\n",
);
const published = [
  name,
  `${name}.blockmap`,
  "latest.yml",
  "desktop-version-windows.json",
  `${name}.sha256`,
  `ARC-${pkg.version}-x64.install.txt`,
  "source-manifest.json",
  "payload-manifest.json",
  "release-build.json",
  "source-verification.json",
  "packaged-verification.json",
  "installer-verification.json",
  "installer-result.json",
  "release-provenance.json",
];
for (const receipt of [
  await readJson(resolve(release, "source-verification.json")),
  packagedReceipt,
]) {
  const logs = z
    .object({ steps: z.array(z.object({ logPath: z.string() })) })
    .parse(receipt);
  for (const step of logs.steps)
    published.push(`verification-logs/${step.logPath}`);
}
const checksumLines = [];
for (const file of published) {
  const entry = await fileEntry(release, file);
  checksumLines.push(`${entry.sha256}  ${entry.path}`);
}
await writeFile(
  resolve(release, "SHA256SUMS"),
  checksumLines.join("\n") + "\n",
);
console.log(
  JSON.stringify({
    version: pkg.version,
    installer: name,
    bytes: installerSize,
    sha256: digest,
    provider: config.provider,
  }),
);

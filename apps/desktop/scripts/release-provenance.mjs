import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parse } from "yaml";
import {
  packagedVerificationPlan,
  sourceVerificationPlan,
} from "./mvp-verification-plan.mjs";

const execute = promisify(execFile);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const objectId = z.string().regex(/^[a-f0-9]{40,64}$/u);
const fileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.includes("\\") &&
          !value.startsWith("/") &&
          !value.includes(":") &&
          value
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
      ),
    size: z.number().int().nonnegative(),
    sha256: digestSchema,
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.array(fileSchema).min(1),
    digest: digestSchema,
  })
  .strict();
const sourceIdentitySchema = z
  .object({ commit: objectId, tree: objectId, digest: digestSchema })
  .strict();
const sourceSchema = manifestSchema.extend({
  commit: objectId,
  tree: objectId,
});
const stepSchema = z
  .object({
    id: z.string(),
    args: z.array(z.string()),
    logPath: fileSchema.shape.path,
    logSha256: digestSchema,
  })
  .strict();
const sourceReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("source"),
    status: z.literal("passed"),
    source: sourceIdentitySchema,
    steps: z.array(stepSchema),
  })
  .strict();
const buildSchema = z
  .object({
    schemaVersion: z.literal(1),
    buildId: z.uuid(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    source: sourceIdentitySchema,
    sourceManifestSha256: digestSchema,
    sourceVerificationSha256: digestSchema,
    payloadDigest: digestSchema,
    payloadManifestSha256: digestSchema,
    assets: z.array(fileSchema).length(3),
  })
  .strict();
const packagedReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("packaged"),
    status: z.literal("passed"),
    buildSha256: digestSchema,
    payloadDigest: digestSchema,
    steps: z.array(stepSchema),
  })
  .strict();
const installerReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("installer"),
    status: z.literal("passed"),
    buildSha256: digestSchema,
    payloadDigest: digestSchema,
    installerSha256: digestSchema,
    installedPayloadDigest: digestSchema,
    reinstalledPayloadDigest: digestSchema,
    packagedVerificationSha256: digestSchema,
    reportSha256: digestSchema,
  })
  .strict();

export function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

export function pathWithin(root, path) {
  const destination = resolve(root, path);
  const child = relative(resolve(root), destination);
  assert(
    child && !child.startsWith("..") && !isAbsolute(child),
    "Release path must stay within its owned directory.",
  );
  return destination;
}

export async function fileEntry(root, name) {
  const file = pathWithin(root, name);
  const info = await lstat(file);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    `Release files must be regular files: ${name}`,
  );
  return {
    path: name.replaceAll("\\", "/"),
    size: info.size,
    sha256: await hashFile(file),
  };
}

export function createManifest(files) {
  const ordered = files
    .map((file) => fileSchema.parse(file))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  assert(
    new Set(ordered.map((file) => file.path.toLowerCase())).size ===
      ordered.length,
    "Manifest contains duplicate paths.",
  );
  return manifestSchema.parse({
    schemaVersion: 1,
    files: ordered,
    digest: digestJson(ordered),
  });
}

export function verifyManifest(raw) {
  const manifest = manifestSchema.parse(raw);
  assert.deepEqual(
    manifest,
    createManifest(manifest.files),
    "Manifest digest or file ordering differs.",
  );
  return manifest;
}

export function sourceIdentity(source) {
  return sourceIdentitySchema.parse({
    commit: source.commit,
    tree: source.tree,
    digest: source.digest,
  });
}

export async function captureReleaseSource(repository) {
  const git = async (args) =>
    (
      await execute("git", args, {
        cwd: repository,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  assert.equal(
    (await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim(),
    "",
    "Release verification requires a clean committed checkout, including untracked source files.",
  );
  await git(["fsck", "--connectivity-only"]);
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim();
  const names = (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
  const files = [];
  for (const name of names) files.push(await fileEntry(repository, name));
  const result = sourceSchema.parse({ ...createManifest(files), commit, tree });
  assert.equal(
    (await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim(),
    "",
    "Source changed while its manifest was recorded.",
  );
  assert.equal(
    (await git(["rev-parse", "HEAD"])).trim(),
    commit,
    "Commit changed while its manifest was recorded.",
  );
  return result;
}

export async function capturePayload(directory, installed = false) {
  const files = [];
  const visit = async (root) => {
    const info = await lstat(root);
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      "Payload cannot contain linked directories.",
    );
    for (const item of await readdir(root, { withFileTypes: true })) {
      const absolute = pathWithin(directory, join(root, item.name));
      const name = relative(directory, absolute).replaceAll("\\", "/");
      assert(!item.isSymbolicLink(), `Payload cannot contain links: ${name}`);
      if (item.isDirectory()) await visit(absolute);
      else if (!(installed && name === "Uninstall ARC IDE.exe"))
        files.push(await fileEntry(directory, name));
    }
  };
  await visit(resolve(directory));
  const manifest = createManifest(files);
  for (const name of [
    "ARC IDE.exe",
    "resources/app.asar",
    "resources/app-update.yml",
  ])
    assert(
      manifest.files.some((file) => file.path === name),
      `Payload is missing ${name}.`,
    );
  return manifest;
}

export async function assertPayload(directory, expected, installed = false) {
  const manifest = verifyManifest(expected);
  const actual = await capturePayload(directory, installed);
  assert.deepEqual(
    actual,
    manifest,
    "Packaged or installed payload differs from the frozen release manifest.",
  );
  return actual;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function verifySteps(steps, plan) {
  assert.deepEqual(
    steps.map(({ id, args }) => ({ id, args })),
    plan,
    "Verification receipt does not contain every required gate in order.",
  );
}

export function verifySourceReceipt(raw, source) {
  const receipt = sourceReceiptSchema.parse(raw);
  assert.deepEqual(
    receipt.source,
    sourceIdentity(source),
    "Source verification receipt is stale.",
  );
  verifySteps(receipt.steps, sourceVerificationPlan);
  return receipt;
}

export function verifyPackagedReceipt(raw, buildSha256, payloadDigest) {
  const receipt = packagedReceiptSchema.parse(raw);
  assert.equal(
    receipt.buildSha256,
    buildSha256,
    "Packaged verification receipt belongs to another release build.",
  );
  assert.equal(
    receipt.payloadDigest,
    payloadDigest,
    "Packaged verification receipt belongs to another payload.",
  );
  verifySteps(receipt.steps, packagedVerificationPlan);
  return receipt;
}

export function verifyInstallerReceipt(raw, expected) {
  const receipt = installerReceiptSchema.parse(raw);
  for (const [key, value] of Object.entries(expected))
    assert.equal(
      receipt[key],
      value,
      `Installer verification receipt has a stale ${key}.`,
    );
  assert.equal(
    receipt.installedPayloadDigest,
    receipt.payloadDigest,
    "Installed payload was not verified.",
  );
  assert.equal(
    receipt.reinstalledPayloadDigest,
    receipt.payloadDigest,
    "Reinstalled payload was not verified.",
  );
  return receipt;
}

export async function verifyReceiptLogs(directory, receipt) {
  for (const step of receipt.steps) {
    const entry = await fileEntry(directory, step.logPath);
    assert.equal(
      entry.sha256,
      step.logSha256,
      `Verification log bytes differ: ${step.id}`,
    );
  }
}

export async function copyReceiptLogs(from, to, receipt) {
  await verifyReceiptLogs(from, receipt);
  for (const step of receipt.steps) {
    const destination = pathWithin(to, step.logPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(pathWithin(from, step.logPath), destination);
  }
  await verifyReceiptLogs(to, receipt);
}

export async function loadReleaseBuild(release) {
  const buildPath = join(release, "release-build.json");
  const build = buildSchema.parse(await readJson(buildPath));
  const source = sourceSchema.parse(
    await readJson(join(release, "source-manifest.json")),
  );
  verifyManifest({
    schemaVersion: source.schemaVersion,
    files: source.files,
    digest: source.digest,
  });
  const payload = verifyManifest(
    await readJson(join(release, "payload-manifest.json")),
  );
  assert.deepEqual(
    build.source,
    sourceIdentity(source),
    "Build source identity differs.",
  );
  assert.equal(
    build.sourceManifestSha256,
    await hashFile(join(release, "source-manifest.json")),
    "Source manifest bytes differ.",
  );
  assert.equal(
    build.payloadManifestSha256,
    await hashFile(join(release, "payload-manifest.json")),
    "Payload manifest bytes differ.",
  );
  assert.equal(
    build.payloadDigest,
    payload.digest,
    "Build payload identity differs.",
  );
  assert.equal(
    build.sourceVerificationSha256,
    await hashFile(join(release, "source-verification.json")),
    "Source verification receipt bytes differ.",
  );
  const receipt = verifySourceReceipt(
    await readJson(join(release, "source-verification.json")),
    source,
  );
  await verifyReceiptLogs(join(release, "verification-logs"), receipt);
  const expectedNames = [
    `ARC-${build.version}-x64.exe`,
    `ARC-${build.version}-x64.exe.blockmap`,
    "latest.yml",
  ].sort();
  assert.deepEqual(
    build.assets.map((file) => file.path).sort(),
    expectedNames,
    "Release build has the wrong asset set.",
  );
  for (const expected of build.assets)
    assert.deepEqual(
      await fileEntry(release, expected.path),
      expected,
      `Release asset bytes differ: ${expected.path}`,
    );
  await verifyReleaseUpdateAssets(release, build.version);
  return { build, source, payload, buildSha256: await hashFile(buildPath) };
}

export async function verifyReleaseUpdateAssets(release, version) {
  const name = `ARC-${version}-x64.exe`;
  const metadata = z
    .object({
      version: z.literal(version),
      path: z.literal(name),
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
    .parse(parse(await readFile(join(release, "latest.yml"), "utf8")));
  const installer = pathWithin(release, name);
  const digest = createHash("sha512");
  for await (const bytes of createReadStream(installer)) digest.update(bytes);
  assert.equal(
    digest.digest("base64"),
    metadata.sha512,
    "Installer bytes do not match the update metadata.",
  );
  assert.equal(
    metadata.files[0].sha512,
    metadata.sha512,
    "Update metadata contains inconsistent installer hashes.",
  );
  assert.equal(
    metadata.files[0].size,
    (await lstat(installer)).size,
    "Update metadata contains a stale installer size.",
  );
  assert(
    (await lstat(pathWithin(release, `${name}.blockmap`))).size > 0,
    "Installer blockmap is empty.",
  );
  z.object({
    provider: z.literal("github"),
    owner: z.literal("grandmasterhilbertporcupine"),
    repo: z.literal("ARC-IDE"),
    channel: z.literal("latest"),
    updaterCacheDirName: z.literal("arc-desktop-updater"),
  }).parse(
    parse(
      await readFile(
        join(release, "win-unpacked/resources/app-update.yml"),
        "utf8",
      ),
    ),
  );
  return metadata;
}

export async function assertCurrentSource(repository, source) {
  assert.deepEqual(
    await captureReleaseSource(repository),
    source,
    "Current checkout differs from the frozen release source.",
  );
}

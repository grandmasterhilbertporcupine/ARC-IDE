import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  capturePayload,
  captureReleaseSource,
  fileEntry,
  hashFile,
  sourceIdentity,
  writeJson,
} from "../scripts/release-provenance.mjs";
import {
  packagedVerificationPlan,
  sourceVerificationPlan,
} from "../scripts/mvp-verification-plan.mjs";

const run = promisify(execFile);
const logSha256 = createHash("sha256").update("unit fixture log").digest("hex");

export async function releaseFixture(roots: string[]) {
  const repository = await mkdtemp(
    join(resolve(tmpdir()), "arc-release-assets-"),
  );
  roots.push(repository);
  const root = join(repository, "apps/desktop");
  const release = join(root, "release");
  const unpacked = join(release, "win-unpacked");
  await mkdir(join(unpacked, "resources"), { recursive: true });
  await mkdir(join(repository, "packages/bb-app"), { recursive: true });
  await writeFile(join(repository, ".gitignore"), "apps/desktop/release/\n");
  for (const packageRoot of [root, join(repository, "packages/bb-app")]) {
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
  }
  const git = async (args: string[]) =>
    run("git", args, { cwd: repository, windowsHide: true });
  await git(["init"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=ARC Test",
    "-c",
    "user.email=arc-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Owned release fixture",
  ]);
  const source = await captureReleaseSource(repository);
  const bytes = Buffer.from("installer test fixture");
  const name = "ARC-1.2.3-x64.exe";
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = {
    version: "1.2.3",
    path: name,
    sha512,
    releaseDate: "2026-09-15T00:00:00.000Z",
    files: [{ url: name, size: bytes.length, sha512 }],
  };
  const feed = {
    ...metadata,
    schemaVersion: 1,
    channel: "latest",
    platform: "windows",
    releaseDate: "2026-09-15T00:00:00.000Z",
    releaseName: "ARC 1.2.3",
    releaseNotes: null,
    minimumSystemVersion: null,
    stagingPercentage: null,
  };
  await writeFile(join(release, name), bytes);
  await writeFile(join(release, `${name}.blockmap`), "blockmap fixture");
  await writeJson(join(release, "latest.yml"), metadata);
  await writeJson(join(release, "desktop-version-windows.json"), feed);
  await writeFile(join(unpacked, "ARC IDE.exe"), "executable fixture");
  await writeFile(join(unpacked, "resources/app.asar"), "application fixture");
  await writeJson(join(unpacked, "resources/app-update.yml"), {
    provider: "github",
    owner: "grandmasterhilbertporcupine",
    repo: "ARC-IDE",
    channel: "latest",
    updaterCacheDirName: "arc-desktop-updater",
  });
  const payload = await capturePayload(unpacked);
  const sourceReceipt = {
    schemaVersion: 1,
    kind: "source",
    status: "passed",
    source: sourceIdentity(source),
    steps: sourceVerificationPlan.map((step) => ({
      ...step,
      logPath: `source/${step.id}.log`,
      logSha256,
    })),
  };
  await writeJson(join(release, "source-manifest.json"), source);
  await writeJson(join(release, "payload-manifest.json"), payload);
  await writeJson(join(release, "source-verification.json"), sourceReceipt);
  const assets = [];
  for (const asset of [name, `${name}.blockmap`, "latest.yml"])
    assets.push(await fileEntry(release, asset));
  const build = {
    schemaVersion: 1,
    buildId: randomUUID(),
    version: "1.2.3",
    source: sourceIdentity(source),
    sourceManifestSha256: await hashFile(join(release, "source-manifest.json")),
    sourceVerificationSha256: await hashFile(
      join(release, "source-verification.json"),
    ),
    payloadDigest: payload.digest,
    payloadManifestSha256: await hashFile(
      join(release, "payload-manifest.json"),
    ),
    assets,
  };
  await writeJson(join(release, "release-build.json"), build);
  const buildSha256 = await hashFile(join(release, "release-build.json"));
  const packagedReceipt = {
    schemaVersion: 1,
    kind: "packaged",
    status: "passed",
    buildSha256,
    payloadDigest: payload.digest,
    steps: packagedVerificationPlan.map((step) => ({
      ...step,
      logPath: `packaged/${step.id}.log`,
      logSha256,
    })),
  };
  for (const step of [...sourceReceipt.steps, ...packagedReceipt.steps]) {
    const directory = join(
      release,
      "verification-logs",
      step.logPath.split("/")[0],
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(release, "verification-logs", step.logPath),
      "unit fixture log",
    );
  }
  await writeJson(join(release, "packaged-verification.json"), packagedReceipt);
  const installerDigest = await hashFile(join(release, name));
  const report = {
    status: "passed",
    installerSha256: installerDigest,
    transition: "same-version reinstall",
    installedPayloadDigest: payload.digest,
    reinstalledPayloadDigest: payload.digest,
    baseline: { version: "1.2.3", sha256: installerDigest },
    next: { version: "1.2.3", sha256: installerDigest },
  };
  await writeJson(join(release, "installer-result.json"), report);
  const installerReceipt = {
    schemaVersion: 1,
    kind: "installer",
    status: "passed",
    buildSha256,
    payloadDigest: payload.digest,
    installerSha256: installerDigest,
    installedPayloadDigest: payload.digest,
    reinstalledPayloadDigest: payload.digest,
    packagedVerificationSha256: await hashFile(
      join(release, "packaged-verification.json"),
    ),
    reportSha256: await hashFile(join(release, "installer-result.json")),
  };
  await writeJson(
    join(release, "installer-verification.json"),
    installerReceipt,
  );
  return {
    root,
    repository,
    release,
    unpacked,
    name,
    bytes,
    feed,
    source,
    payload,
    build,
    buildSha256,
    sourceReceipt,
    packagedReceipt,
    installerReceipt,
  };
}

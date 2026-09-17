import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  packagedVerificationPlan,
  sourceVerificationPlan,
} from "./mvp-verification-plan.mjs";
import {
  assertCurrentSource,
  assertPayload,
  captureReleaseSource,
  copyReceiptLogs,
  hashFile,
  loadReleaseBuild,
  pathWithin,
  sourceIdentity,
  writeJson,
} from "./release-provenance.mjs";
import { runReleaseCommand } from "./run-release-command.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { packaged: { type: "boolean" } } });
const parent = pathWithin(repository, ".arc-verification/mvp");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(
  join(parent, values.packaged ? "packaged-" : "source-"),
);
const release = pathWithin(repository, "apps/desktop/release");
const receiptPath = values.packaged
  ? join(release, "packaged-verification.json")
  : join(parent, "source-verification.json");
await unlink(receiptPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
assert.equal(
  process.platform,
  "win32",
  "The MVP verification gate targets native Windows.",
);
const frozen = values.packaged ? await loadReleaseBuild(release) : null;
const source = frozen?.source ?? (await captureReleaseSource(repository));
await assertCurrentSource(repository, source);
if (frozen) await assertPayload(join(release, "win-unpacked"), frozen.payload);
const steps = [];
for (const step of values.packaged
  ? packagedVerificationPlan
  : sourceVerificationPlan) {
  const log = join(root, `${step.id}.log`);
  await runReleaseCommand(
    repository,
    step.args,
    log,
    values.packaged
      ? { TEMP: root, TMP: root, ARC_REQUIRE_NSIS_TESTS: "1" }
      : {},
  );
  steps.push({
    ...step,
    logPath: relative(parent, log).replaceAll("\\", "/"),
    logSha256: await hashFile(log),
  });
}
await assertCurrentSource(repository, source);
if (frozen) {
  const current = await loadReleaseBuild(release);
  assert.equal(
    current.buildSha256,
    frozen.buildSha256,
    "Release build changed during packaged verification.",
  );
  await assertPayload(join(release, "win-unpacked"), frozen.payload);
  const receipt = {
    schemaVersion: 1,
    kind: "packaged",
    status: "passed",
    buildSha256: frozen.buildSha256,
    payloadDigest: frozen.payload.digest,
    steps,
  };
  await copyReceiptLogs(parent, join(release, "verification-logs"), receipt);
  await writeJson(receiptPath, receipt);
} else {
  await writeJson(receiptPath, {
    schemaVersion: 1,
    kind: "source",
    status: "passed",
    source: sourceIdentity(source),
    steps,
  });
}
console.log(`MVP verification receipt: ${receiptPath}`);

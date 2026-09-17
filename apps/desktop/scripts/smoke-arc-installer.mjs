import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { requireWithin, runSmoke } from "./smoke-arc-windows.mjs";
import {
  assertCurrentSource,
  assertPayload,
  loadReleaseBuild,
  readJson,
  verifyPackagedReceipt,
  verifyReceiptLogs,
  writeJson,
} from "./release-provenance.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../../..");
const execFileAsync = promisify(execFile);
const registrySchema = z.object({
  installations: z.array(
    z.object({
      hive: z.string(),
      view: z.string(),
      key: z.string(),
      location: z.string(),
    }),
  ),
  uninstallEntries: z.array(
    z.object({
      hive: z.string(),
      view: z.string(),
      key: z.string(),
      displayName: z.string(),
    }),
  ),
  shortcuts: z.array(z.object({ path: z.string(), target: z.string() })),
  processes: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      executablePath: z.string().nullable(),
    }),
  ),
  profiles: z.array(z.string()),
});

function assert(value, message) {
  if (!value) throw new Error(message);
}
const equalPath = (first, second) =>
  resolve(first).toLowerCase() === resolve(second).toLowerCase();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function installerGuid(appId) {
  const namespace = Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(appId, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertSafeInstallationState(
  raw,
  appGuid,
  ownedDirectory = null,
) {
  const state = registrySchema.parse(raw);
  assert(
    state.processes.length === 0,
    "A ARC process is already running; the NSIS installer may terminate it. No installation action was started.",
  );
  if (ownedDirectory === null) {
    assert(
      state.installations.length === 0 &&
        state.uninstallEntries.length === 0 &&
        state.shortcuts.length === 0,
      "A ARC installation, registry entry or shortcut already exists. This harness will not overwrite it.",
    );
    return state;
  }
  assert(
    state.installations.length > 0 && state.uninstallEntries.length > 0,
    "The test installation has no complete per-user registration.",
  );
  assert(
    state.installations.every(
      (entry) =>
        entry.hive === "CurrentUser" &&
        entry.key.toLowerCase() === appGuid.toLowerCase() &&
        equalPath(entry.location, ownedDirectory),
    ),
    "ARC installation registration points outside the exact test-owned directory.",
  );
  assert(
    state.uninstallEntries.every(
      (entry) =>
        entry.hive === "CurrentUser" &&
        entry.key.toLowerCase() === appGuid.toLowerCase(),
    ),
    "Another ARC installation appeared during the test.",
  );
  assert(
    state.shortcuts.every(
      (entry) =>
        entry.target &&
        equalPath(entry.target, join(ownedDirectory, "ARC IDE.exe")),
    ),
    "A ARC shortcut points outside the test-owned installation.",
  );
  return state;
}

export function nsisArguments(directory = null) {
  if (directory === null) return ["/S", "/currentuser"];
  assert(
    isAbsolute(directory) && !/["\r\n\0]/u.test(directory),
    "NSIS requires an absolute directory without quote or control characters.",
  );
  return ["/S", "/currentuser", `/D=${directory}`];
}

export function requireValidSignature(metadata) {
  const value = z
    .object({
      signatureStatus: z.literal("Valid"),
      signerThumbprint: z.string().min(1),
    })
    .safeParse(metadata);
  assert(
    value.success,
    "Public release verification requires a valid Authenticode signature on the installer and installed executable.",
  );
}

export function parseInstallerMetadata(raw, expectedVersion = null) {
  const metadata = z
    .object({
      product: z.literal("ARC"),
      version: z
        .string()
        .regex(/^\d+\.\d+\.\d+(?:\.0|[-+][\w.-]+)?$/u)
        .transform((version) => version.replace(/^(\d+\.\d+\.\d+)\.0$/u, "$1")),
      fileVersion: z.string().min(1),
      signatureStatus: z.string(),
      signerThumbprint: z.string().nullable(),
    })
    .parse(raw);
  assert(
    expectedVersion === null || metadata.version === expectedVersion,
    "Installed executable version differs from the installer's Windows metadata.",
  );
  return metadata;
}

export function installerUninstallerName(config) {
  const value = z
    .object({
      appId: z.literal("dev.arc.desktop"),
      productName: z.literal("ARC"),
      win: z.object({ executableName: z.literal("ARC IDE") }),
      nsis: z.object({
        perMachine: z.literal(false),
        oneClick: z.literal(false),
        deleteAppDataOnUninstall: z.literal(false),
      }),
    })
    .safeParse(config);
  assert(
    value.success,
    "The installer configuration does not match this bounded per-user preservation test.",
  );
  return `Uninstall ${value.data.win.executableName}.exe`;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function snapshotProfiles(directories) {
  const files = {};
  let bytes = 0;
  async function visit(directory) {
    const stat = await lstat(directory);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Profile preservation check refuses linked or non-directory profiles.",
    );
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = requireWithin(directory, join(directory, entry.name));
      assert(
        !entry.isSymbolicLink(),
        "Profile preservation check refuses symbolic links.",
      );
      if (entry.isDirectory()) await visit(file);
      else {
        assert(
          entry.isFile(),
          "Profile preservation check found an unsupported file type.",
        );
        bytes += (await lstat(file)).size;
        assert(
          bytes <= 1024 ** 3 && Object.keys(files).length < 25_000,
          "Existing profile exceeds this bounded verification check. Use a clean Windows verification machine.",
        );
        files[file] = await hashFile(file);
      }
    }
  }
  const roots = {};
  for (const directory of directories) {
    try {
      await lstat(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      roots[directory] = false;
      continue;
    }
    await visit(directory);
    roots[directory] = true;
  }
  return { roots, files };
}

function requireSameSnapshot(before, after, label) {
  assert(
    JSON.stringify(before.roots) === JSON.stringify(after.roots),
    `${label} changed profile directory existence.`,
  );
  const names = Object.keys(before.files).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(Object.keys(after.files).sort()) &&
      names.every((name) => before.files[name] === after.files[name]),
    `${label} changed preserved profile or project bytes.`,
  );
}

async function queryState(powerShell, guid) {
  const result = await execFileAsync(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(scriptDirectory, "query-arc-installation.ps1"),
      "-AppGuid",
      guid,
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return registrySchema.parse(
    JSON.parse(result.stdout.replace(/^\uFEFF/u, "").trim()),
  );
}

async function runNsis(executable, arguments_, temporaryDirectory, log) {
  assert(
    isAbsolute(executable) && !/["\r\n\0]/u.test(executable),
    "Invalid NSIS executable path.",
  );
  const child = spawn(executable, arguments_, {
    argv0: `"${executable}"`,
    windowsVerbatimArguments: true,
    windowsHide: true,
    cwd: temporaryDirectory,
    env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (bytes) => log.push(bytes.toString()));
  child.stderr.on("data", (bytes) => log.push(bytes.toString()));
  await new Promise((done, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `NSIS timed out; test-owned installer PID ${child.pid} may still be running.`,
          ),
        ),
      600_000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? done() : reject(new Error(`NSIS exited with code ${code}.`));
    });
  });
}

async function waitForRemoval(directory, query, guid) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let removed = false;
    try {
      await access(directory);
    } catch (error) {
      if (error.code === "ENOENT") removed = true;
      else throw error;
    }
    if (removed) {
      assertSafeInstallationState(await query(), guid);
      return;
    }
    await delay(500);
  }
  throw new Error(
    "The uninstaller did not remove its exact owned installation directory within two minutes.",
  );
}

export async function runInstallerSmoke(installer, options = {}) {
  assert(
    process.platform === "win32" && process.arch === "x64",
    "Installer verification requires native Windows x64.",
  );
  const config = JSON.parse(
    await readFile(
      resolve(scriptDirectory, "../electron-builder.config.json"),
      "utf8",
    ),
  );
  const uninstallerName = installerUninstallerName(config);
  const guid = config.nsis.guid ?? installerGuid(config.appId);
  installer = resolve(installer);
  await access(installer);
  const release = options.releaseManifest
    ? dirname(resolve(options.releaseManifest))
    : null;
  const frozen = release ? await loadReleaseBuild(release) : null;
  let packagedVerificationSha256 = null;
  if (frozen) {
    assert(
      equalPath(options.releaseManifest, join(release, "release-build.json")),
      "Expected the exact release-build.json manifest.",
    );
    assert(
      !options.upgradeInstaller,
      "A release receipt requires a same-build install and reinstall; cross-version tests remain separate.",
    );
    assert(
      equalPath(
        installer,
        join(release, `ARC-${frozen.build.version}-x64.exe`),
      ),
      "Installer path differs from the frozen release build.",
    );
    for (const name of ["installer-verification.json", "installer-result.json"])
      await unlink(join(release, name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await assertCurrentSource(repository, frozen.source);
    await assertPayload(join(release, "win-unpacked"), frozen.payload);
    const packagedReceipt = verifyPackagedReceipt(
      await readJson(join(release, "packaged-verification.json")),
      frozen.buildSha256,
      frozen.payload.digest,
    );
    await verifyReceiptLogs(
      join(release, "verification-logs"),
      packagedReceipt,
    );
    packagedVerificationSha256 = await hashFile(
      join(release, "packaged-verification.json"),
    );
  }
  const windows = Object.entries(process.env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  assert(windows && isAbsolute(windows), "SystemRoot is unavailable.");
  const powerShell = join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const inspectInstaller = async (file, expectedVersion = null) => {
    const result = await execFileAsync(
      powerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(scriptDirectory, "inspect-arc-installer.ps1"),
        "-Installer",
        file,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 30_000 },
    );
    const metadata = parseInstallerMetadata(
      JSON.parse(result.stdout),
      expectedVersion,
    );
    if (options.requireSignature) requireValidSignature(metadata);
    return { path: file, sha256: await hashFile(file), ...metadata };
  };
  const baseline = await inspectInstaller(
    installer,
    frozen?.build.version ?? null,
  );
  const nextInstaller = options.upgradeInstaller
    ? resolve(options.upgradeInstaller)
    : installer;
  const next = options.upgradeInstaller
    ? await inspectInstaller(nextInstaller)
    : baseline;
  assert(
    !options.upgradeInstaller ||
      (next.version !== baseline.version && next.sha256 !== baseline.sha256),
    "Cross-version verification requires two different real installer versions and hashes.",
  );
  const query = () => queryState(powerShell, guid);
  const initial = assertSafeInstallationState(await query(), guid);
  const preservedProfiles = await snapshotProfiles(initial.profiles);
  const parent = requireWithin(
    repository,
    join(repository, ".arc-verification"),
  );
  await mkdir(parent, { recursive: true });
  assert(
    !(await lstat(parent)).isSymbolicLink(),
    "Verification root cannot be a linked directory.",
  );
  const root = await mkdtemp(join(parent, "NSIS install Δ "));
  const installation = requireWithin(root, join(root, "Installed ARC 東京"));
  const temporary = requireWithin(root, join(root, "t"));
  await mkdir(temporary);
  const log = [];
  const report = {
    status: "running",
    root,
    installer,
    installerSha256: baseline.sha256,
    signatureRequired: options.requireSignature === true,
    baseline,
    next,
    transition: options.upgradeInstaller
      ? "cross-version upgrade"
      : "same-version reinstall",
    installation,
    appGuid: guid,
    checks: [],
    limitations: [
      "Executed on this existing development machine; not clean-Windows certification.",
      ...(options.requireSignature
        ? []
        : [
            "Authenticode status recorded without enforcing the public signature gate.",
          ]),
      ...(options.upgradeInstaller
        ? []
        : [
            "Reinstalls the same installer version; does not prove a cross-version upgrade.",
          ]),
      "Provider authentication, signed public updates and rollback remain separate release gates.",
    ],
  };
  let installed = false;
  let smokeArtifacts;
  let beforeUninstall;
  const check = (name) => {
    report.checks.push(name);
    console.log(`Verified: ${name}`);
  };
  const uninstall = async () => {
    requireWithin(root, installation);
    assertSafeInstallationState(await query(), guid, installation);
    const uninstaller = requireWithin(
      installation,
      join(installation, uninstallerName),
    );
    await access(uninstaller);
    await runNsis(uninstaller, nsisArguments(), temporary, log);
    await waitForRemoval(installation, query, guid);
    installed = false;
  };
  console.log(`ARC installer smoke artifacts: ${root}`);
  try {
    assertSafeInstallationState(await query(), guid);
    assert(
      (await hashFile(installer)) === baseline.sha256,
      "Installer bytes changed before installation.",
    );
    await runNsis(installer, nsisArguments(installation), temporary, log);
    assertSafeInstallationState(await query(), guid, installation);
    installed = true;
    report.installedExecutable = await inspectInstaller(
      join(installation, "ARC IDE.exe"),
      baseline.version,
    );
    if (frozen) {
      const payload = await assertPayload(installation, frozen.payload, true);
      report.installedPayloadDigest = payload.digest;
      check(
        "Installed payload matches every immutable file in the frozen release build",
      );
    }
    requireSameSnapshot(
      preservedProfiles,
      await snapshotProfiles(initial.profiles),
      "Installation",
    );
    check(
      "Silent per-user install used only the owned Unicode path and preserved existing profiles",
    );
    const first = await runSmoke(join(installation, "ARC IDE.exe"), {
      artifactsParent: root,
    });
    assert(
      first.status === "passed",
      `Installed application smoke failed. See ${first.artifacts}/result.json.`,
    );
    assert(
      first.applicationVersion === baseline.version,
      "Installed application version differs from the baseline installer's Windows metadata.",
    );
    await writeFile(
      join(root, "baseline-application-result.json"),
      `${JSON.stringify(first, null, 2)}\n`,
    );
    smokeArtifacts = requireWithin(root, z.string().parse(first.artifacts));
    if (frozen) await assertPayload(installation, frozen.payload, true);
    report.projectId = first.projectId;
    report.smokeArtifacts = smokeArtifacts;
    const beforeReinstall = await snapshotProfiles([smokeArtifacts]);
    assertSafeInstallationState(await query(), guid, installation);
    assert(
      (await hashFile(nextInstaller)) === next.sha256,
      "Installer bytes changed before reinstallation.",
    );
    await runNsis(nextInstaller, nsisArguments(installation), temporary, log);
    assertSafeInstallationState(await query(), guid, installation);
    report.upgradedExecutable = await inspectInstaller(
      join(installation, "ARC IDE.exe"),
      next.version,
    );
    if (frozen) {
      const payload = await assertPayload(installation, frozen.payload, true);
      report.reinstalledPayloadDigest = payload.digest;
      check("Reinstalled payload matches the same frozen release build");
    }
    requireSameSnapshot(
      beforeReinstall,
      await snapshotProfiles([smokeArtifacts]),
      "Reinstallation",
    );
    requireSameSnapshot(
      preservedProfiles,
      await snapshotProfiles(initial.profiles),
      "Reinstallation",
    );
    const second = await runSmoke(join(installation, "ARC IDE.exe"), {
      resume: smokeArtifacts,
    });
    assert(
      second.status === "passed",
      `Reinstalled application smoke failed: ${second.error ?? `see ${smokeArtifacts}/result.json`}.`,
    );
    assert(
      second.projectId === first.projectId,
      "Reinstalled application reopened a different QA project.",
    );
    assert(
      second.applicationVersion === next.version,
      "The relaunched application version differs from the second installer's Windows metadata.",
    );
    await writeFile(
      join(root, "next-application-result.json"),
      `${JSON.stringify(second, null, 2)}\n`,
    );
    check(
      `${options.upgradeInstaller ? `Cross-version upgrade ${baseline.version} to ${next.version}` : `Same-version reinstall ${baseline.version}`} preserved the exact QA project, data and host workspace binding`,
    );
    if (frozen) await assertPayload(installation, frozen.payload, true);
    beforeUninstall = await snapshotProfiles([smokeArtifacts]);
    await uninstall();
    requireSameSnapshot(
      beforeUninstall,
      await snapshotProfiles([smokeArtifacts]),
      "Uninstallation",
    );
    requireSameSnapshot(
      preservedProfiles,
      await snapshotProfiles(initial.profiles),
      "Uninstallation",
    );
    check(
      "Silent uninstall removed the owned installation, registry entries and shortcuts while preserving project and profile bytes",
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (installed) {
      try {
        await uninstall();
        report.ownedInstallationCleanup = "removed";
      } catch (cleanupError) {
        report.cleanupError = String(cleanupError);
      }
    }
    process.exitCode = 1;
  } finally {
    await writeFile(
      join(root, "installer.log"),
      log.join("").slice(-4 * 1024 * 1024),
    );
    await writeFile(
      join(root, "installer-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  }
  if (frozen && report.status === "passed") {
    await assertCurrentSource(repository, frozen.source);
    const current = await loadReleaseBuild(release);
    assert(
      current.buildSha256 === frozen.buildSha256,
      "Release build changed during installer verification.",
    );
    assert(
      (await hashFile(join(release, "packaged-verification.json"))) ===
        packagedVerificationSha256,
      "Packaged verification receipt changed during installer verification.",
    );
    await writeJson(join(release, "installer-result.json"), report);
    await writeJson(join(release, "installer-verification.json"), {
      schemaVersion: 1,
      kind: "installer",
      status: "passed",
      buildSha256: frozen.buildSha256,
      payloadDigest: frozen.payload.digest,
      installerSha256: baseline.sha256,
      installedPayloadDigest: report.installedPayloadDigest,
      reinstalledPayloadDigest: report.reinstalledPayloadDigest,
      packagedVerificationSha256,
      reportSha256: await hashFile(join(release, "installer-result.json")),
    });
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      installer: { type: "string" },
      "upgrade-installer": { type: "string" },
      "require-signature": { type: "boolean" },
      "release-manifest": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-installer.mjs [--installer C:\\path\\ARC-baseline-x64.exe] [--upgrade-installer C:\\path\\ARC-next-x64.exe] [--require-signature] [--release-manifest C:\\path\\release-build.json]\nDefaults to the desktop package's current version. Refuses an existing ARC installation, shortcut or running process. Uses a new workspace .arc-verification directory; performs silent per-user install, reinstall or explicit cross-version upgrade, and uninstall. Preserves all QA projects and verification artifacts. --release-manifest verifies all installed payload bytes against a frozen build and emits a receipt only after lifecycle success. Public signed-release verification must use --require-signature.",
    );
  else {
    const desktopPackage = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/u) })
      .parse(
        JSON.parse(
          await readFile(resolve(scriptDirectory, "../package.json"), "utf8"),
        ),
      );
    await runInstallerSmoke(
      values.installer ??
        resolve(
          scriptDirectory,
          `../release/ARC-${desktopPackage.version}-x64.exe`,
        ),
      {
        upgradeInstaller: values["upgrade-installer"],
        requireSignature: values["require-signature"],
        releaseManifest: values["release-manifest"],
      },
    ).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

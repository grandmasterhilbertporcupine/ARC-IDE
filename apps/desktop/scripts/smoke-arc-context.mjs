import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function within(root, path) {
  const suffix = relative(resolve(root), resolve(path));
  assert(
    suffix !== "" &&
      suffix !== ".." &&
      !suffix.startsWith("..\\") &&
      !suffix.startsWith("../") &&
      !isAbsolute(suffix),
    "Smoke path escaped its explicit boundary",
  );
  return resolve(path);
}

function packagedContextPath(executable) {
  assert(
    isAbsolute(executable),
    "Select an absolute packaged ARC executable path",
  );
  return within(
    dirname(executable),
    join(
      dirname(executable),
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "bb-app",
      "host-daemon",
      "dist",
      "context",
    ),
  );
}

function isolatedEnvironment(root) {
  const allowed = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        allowed.has(key.toUpperCase()) && typeof value === "string",
    ),
  );
  const windows = Object.entries(inherited).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  assert(windows && isAbsolute(windows), "Windows SystemRoot is unavailable");
  return {
    ...inherited,
    PATH: [join(windows, "System32"), windows].join(";"),
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "test",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "roaming"),
    LOCALAPPDATA: join(root, "local"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
}

async function childProcesses(parentPid) {
  assert(Number.isInteger(parentPid) && parentPid > 0);
  const windows = Object.entries(process.env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  assert(windows && isAbsolute(windows));
  const powershell = join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command = `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;
  const request = execFileAsync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  const ownProbePid = request.child.pid;
  const { stdout } = await request;
  const value = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/u, "")) : [];
  return (Array.isArray(value) ? value : [value]).filter(
    (item) => item.ProcessId !== ownProbePid,
  );
}

async function verifyInventory(root) {
  const bytes = await readFile(join(root, "manifest.json"));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.target, { platform: "win32", arch: "x64" });
  assert.equal(manifest.model, "Xenova/all-MiniLM-L6-v2");
  assert.equal(manifest.revision, "751bff37182d3f1213fa05d7196b954e230abad9");
  assert.equal(manifest.dimension, 384);
  assert.equal(manifest.dtype, "q8");
  assert.equal(manifest.pooling, "mean");
  assert.equal(manifest.normalize, true);
  assert(
    Array.isArray(manifest.files) &&
      manifest.files.length >= 10 &&
      manifest.files.length <= 10000,
  );
  const names = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    assert(typeof file.path === "string" && !names.has(file.path));
    names.add(file.path);
    const path = within(root, join(root, file.path));
    assert.equal(
      await realpath(path),
      path,
      "Packaged Context assets must be real files inside the selected package",
    );
    const content = await readFile(path);
    assert.equal(content.length, file.bytes);
    assert.equal(sha256(content), file.sha256);
    totalBytes += content.length;
  }
  for (const name of [
    "client.mjs",
    "worker.mjs",
    "models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
  ])
    assert(names.has(name));
  assert([...names].some((name) => name.startsWith("notices/")));
  return {
    manifest,
    manifestDigest: sha256(bytes),
    totalBytes,
    fileCount: names.size,
  };
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    assert.equal(error.code, code);
    return { code: error.code, message: error.message };
  }
  throw new Error(`Expected ${code} rejection`);
}

function verifyVectors(result, input, digest) {
  assert.equal(result.requestId, input.requestId);
  assert.equal(result.manifestDigest, digest);
  assert.equal(result.generation, input.expectedGeneration);
  assert.deepEqual(
    result.items.map((item) => item.id),
    input.items.map((item) => item.id),
  );
  for (const item of result.items) {
    assert(
      Number.isInteger(item.tokenCount) &&
        item.tokenCount > 0 &&
        item.tokenCount <= 256,
    );
    assert.equal(item.vector.length, 384);
    assert(item.vector.every(Number.isFinite));
    assert(Math.abs(Math.hypot(...item.vector) - 1) < 0.0001);
  }
}

async function runFixture(config) {
  assert.deepEqual(
    Object.keys(config).sort(),
    ["executable", "artifacts", "case", "manifestDigest"].sort(),
  );
  assert(isAbsolute(config.artifacts));
  assert.match(config.manifestDigest, /^[a-f0-9]{64}$/);
  assert(
    process.versions.electron,
    "The selected runtime must be actual Electron running as Node",
  );
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(
    (await realpath(process.execPath)).toLowerCase(),
    (await realpath(config.executable)).toLowerCase(),
  );
  const packageRoot = packagedContextPath(config.executable);
  const contextRoot =
    config.case === "normal"
      ? packageRoot
      : within(
          config.artifacts,
          join(config.artifacts, "Context assets Δ with spaces"),
        );
  assert(["normal", "unicode", "missing", "corrupt"].includes(config.case));
  const { ContextEmbeddingClient } = await import(
    pathToFileURL(join(contextRoot, "client.mjs")).href
  );
  assert.equal(typeof ContextEmbeddingClient, "function");
  const result = {
    case: config.case,
    passed: false,
    runner: {
      pid: process.pid,
      execPath: process.execPath,
      versions: process.versions,
    },
    network: {
      libraryPolicy: null,
      osNetworkDenial:
        "not tested; fetch guards and local assets do not constitute OS network isolation",
    },
    checks: [],
  };
  const send = (value) => {
    if (process.send) process.send(value);
  };
  send({ kind: "runner", ...result.runner });
  const client = new ContextEmbeddingClient();
  try {
    const began = performance.now();
    result.status = await client.status();
    result.coldStatusMs = performance.now() - began;
    send({
      kind: "status",
      case: config.case,
      status: result.status,
      coldStatusMs: result.coldStatusMs,
    });
    if (config.case === "missing" || config.case === "corrupt") {
      assert.equal(result.status.state, "unavailable");
      assert.equal(result.status.error.code, "asset_mismatch");
      result.checks.push({
        name: `${config.case} asset rejected without fallback`,
        passed: true,
        error: result.status.error,
      });
    } else {
      assert.equal(result.status.state, "ready");
      const { descriptor, process: worker } = result.status;
      assert.equal(descriptor.manifestDigest, config.manifestDigest);
      assert.equal(descriptor.dimension, 384);
      assert.equal(descriptor.tokenizer.totalTokens, 256);
      assert.equal(worker.remoteModels, false);
      assert.equal(worker.caches, false);
      assert.equal(worker.fetch, "rejected");
      assert.equal(worker.cpuThreads, 2);
      assert(
        Number.isInteger(worker.pid) &&
          worker.pid > 0 &&
          worker.pid !== process.pid,
      );
      assert.equal(worker.electron, process.versions.electron);
      assert.equal(worker.node, process.versions.node);
      assert.equal(
        resolve(worker.execPath).toLowerCase(),
        resolve(config.executable).toLowerCase(),
      );
      result.network.libraryPolicy = {
        remoteModels: worker.remoteModels,
        caches: worker.caches,
        fetch: worker.fetch,
      };
      send({ kind: "worker", ...worker });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "CREATE VIRTUAL TABLE context_smoke USING fts5(id UNINDEXED, content)",
        );
        const insert = db.prepare("INSERT INTO context_smoke VALUES(?,?)");
        insert.run(
          "pricing",
          "The pricing function multiplies integer cents by quantity",
        );
        insert.run("unicode", "A café has Unicode text and a blue door");
        const matches = db
          .prepare(
            "SELECT id FROM context_smoke WHERE context_smoke MATCH ? ORDER BY rank",
          )
          .all("pricing");
        assert.deepEqual(
          matches.map((row) => row.id),
          ["pricing"],
        );
        result.fts5 = {
          passed: true,
          matches,
          sqliteVersion: db.prepare("SELECT sqlite_version() AS version").get()
            .version,
        };
      } finally {
        db.close();
      }
      const items = [
        {
          id: "prose",
          text: "A developer is reviewing a small JavaScript application.",
        },
        {
          id: "code",
          text: "export function totalPrice(unitCents, quantity) { return unitCents * quantity; }",
        },
        {
          id: "unicode",
          text: "A café displays prices in euros. Unicode path: équipe Δ.",
        },
      ];
      const input = {
        requestId: randomUUID(),
        expectedManifestDigest: descriptor.manifestDigest,
        expectedGeneration: result.status.generation,
        items,
      };
      result.generationMismatch = {};
      for (const method of ["countTokens", "embed"]) {
        result.generationMismatch[method] = await expectCode(
          () =>
            client[method]({
              ...input,
              requestId: randomUUID(),
              expectedGeneration: `stale-${randomUUID()}`,
            }),
          "worker_stopped",
        );
      }
      const afterMismatch = await client.status();
      assert.equal(afterMismatch.state, "ready");
      assert.equal(afterMismatch.generation, result.status.generation);
      assert.equal(afterMismatch.process.pid, worker.pid);
      result.checks.push({
        name: "wrong generation rejected by count and embed without replacing the helper",
        passed: true,
      });
      const firstStart = performance.now();
      result.first = await client.embed(input);
      result.firstBatchMs = performance.now() - firstStart;
      verifyVectors(result.first, input, descriptor.manifestDigest);
      const countInput = { ...input, requestId: randomUUID() };
      result.tokenCounts = await client.countTokens(countInput);
      assert.equal(result.tokenCounts.requestId, countInput.requestId);
      assert.equal(result.tokenCounts.generation, result.first.generation);
      assert.equal(
        result.tokenCounts.manifestDigest,
        descriptor.manifestDigest,
      );
      assert.deepEqual(
        result.tokenCounts.items,
        result.first.items.map(({ id, tokenCount }) => ({ id, tokenCount })),
      );
      result.longTokenCount = await client.countTokens({
        requestId: randomUUID(),
        expectedManifestDigest: descriptor.manifestDigest,
        expectedGeneration: result.status.generation,
        items: [{ id: "over-limit", text: "token ".repeat(300) }],
      });
      assert(result.longTokenCount.items[0].tokenCount > 256);
      result.checks.push({
        name: "real tokenizer counts match embedding and retain over-limit counts without truncation",
        passed: true,
      });
      const repeatInput = { ...input, requestId: randomUUID() };
      const warmStart = performance.now();
      result.repeat = await client.embed(repeatInput);
      result.warmBatchMs = performance.now() - warmStart;
      verifyVectors(result.repeat, repeatInput, descriptor.manifestDigest);
      result.repeatMaxDelta = Math.max(
        ...result.first.items.flatMap((item, index) =>
          item.vector.map((value, column) =>
            Math.abs(value - result.repeat.items[index].vector[column]),
          ),
        ),
      );
      assert(result.repeatMaxDelta <= 0.00001);
      assert(
        result.first.items[0].vector.some(
          (value, index) =>
            Math.abs(value - result.first.items[1].vector[index]) > 0.001,
        ),
        "Distinct real texts must not return a constant vector",
      );
      result.manifestMismatch = await expectCode(
        () =>
          client.embed({
            ...input,
            requestId: randomUUID(),
            expectedManifestDigest: "0".repeat(64),
          }),
        "manifest_mismatch",
      );
      result.tokenLimit = await expectCode(
        () =>
          client.embed({
            ...input,
            requestId: randomUUID(),
            items: [
              { id: "too-long", text: "different token words ".repeat(300) },
            ],
          }),
        "token_limit",
      );
      result.checks.push({
        name: "real normalized embeddings, repeat tolerance and typed input failures",
        passed: true,
      });
      const cancelledId = randomUUID();
      const pending = client
        .embed({
          requestId: cancelledId,
          expectedManifestDigest: descriptor.manifestDigest,
          expectedGeneration: result.status.generation,
          items: Array.from({ length: 8 }, (_, index) => ({
            id: `cancel-${index}`,
            text: "The exact cancellation fixture checks a bounded active embedding request. ".repeat(
              14,
            ),
          })),
        })
        .then(
          (value) => ({ state: "completed", value }),
          (error) => ({
            state: "rejected",
            code: error.code,
            message: error.message,
          }),
        );
      await new Promise((done) => setImmediate(done));
      result.cancel = await client.cancel(cancelledId);
      result.cancelledRequest = await pending;
      assert.equal(result.cancelledRequest.state, "rejected");
      assert.equal(result.cancelledRequest.code, "cancelled");
      result.childrenAfterCancel = await childProcesses(process.pid);
      assert.deepEqual(result.childrenAfterCancel, []);
      result.stoppedGeneration = {};
      for (const method of ["countTokens", "embed"]) {
        result.stoppedGeneration[method] = await expectCode(
          () => client[method]({ ...input, requestId: randomUUID() }),
          "worker_stopped",
        );
      }
      result.childrenAfterStaleRequests = await childProcesses(process.pid);
      assert.deepEqual(result.childrenAfterStaleRequests, []);
      result.checks.push({
        name: "cancelled request produced no successful late vector reply and stale requests started no replacement helper",
        passed: true,
      });
    }
  } finally {
    const began = performance.now();
    await client.dispose();
    result.disposeMs = performance.now() - began;
    result.childrenAfterDispose = await childProcesses(process.pid);
    assert.deepEqual(result.childrenAfterDispose, []);
    send({
      kind: "disposed",
      case: config.case,
      children: result.childrenAfterDispose,
      disposeMs: result.disposeMs,
    });
  }
  result.passed = true;
  return result;
}

async function runChild(
  executable,
  artifacts,
  caseName,
  manifestDigest,
  report,
  save,
) {
  const config = { executable, artifacts, case: caseName, manifestDigest };
  const input = join(artifacts, `${caseName}-input.json`),
    output = join(artifacts, `${caseName}-result.json`);
  await writeFile(input, JSON.stringify(config, null, 2), { flag: "wx" });
  const stdout = [],
    stderr = [],
    messages = [];
  const child = spawn(
    executable,
    [scriptPath, "--fixture-input", input, "--fixture-output", output],
    {
      cwd: artifacts,
      env: isolatedEnvironment(artifacts),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  exited.catch(() => {});
  const evidence = {
    case: caseName,
    pid: child.pid ?? null,
    messages,
    startedAt: new Date().toISOString(),
    exit: null,
  };
  report.processes.push(evidence);
  child.stdout.on("data", (value) => stdout.push(value));
  child.stderr.on("data", (value) => stderr.push(value));
  child.on("message", (message) => {
    messages.push({ at: Date.now(), message });
    save().catch(() => {});
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 180000);
  try {
    await save();
    evidence.exit = await exited;
  } finally {
    clearTimeout(timer);
    await writeFile(
      join(artifacts, `${caseName}-stdout.log`),
      Buffer.concat(stdout),
    );
    await writeFile(
      join(artifacts, `${caseName}-stderr.log`),
      Buffer.concat(stderr),
    );
    evidence.finishedAt = new Date().toISOString();
    evidence.timedOut = timedOut;
    await save();
  }
  if (child.pid !== undefined) {
    const deadline = Date.now() + 10000;
    let remaining = [];
    do {
      remaining = await childProcesses(child.pid);
      if (remaining.length === 0) break;
      await delay(200);
    } while (Date.now() < deadline);
    evidence.remainingChildren = remaining;
    await save();
    assert.deepEqual(
      remaining,
      [],
      "Private Context children remain; preserve the exact PID evidence for cleanup",
    );
  }
  assert.equal(
    timedOut,
    false,
    "Packaged Context fixture exceeded its bounded execution window",
  );
  assert.equal(evidence.exit.code, 0, Buffer.concat(stderr).toString("utf8"));
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.passed, true);
  return result;
}

export async function runContextSmoke(executable) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert(
    isAbsolute(executable),
    "--executable must be an absolute packaged ARC executable path",
  );
  executable = await realpath(executable);
  assert((await stat(executable)).isFile());
  const contextRoot = packagedContextPath(executable);
  const artifacts = await realpath(
    await mkdtemp(join(tmpdir(), "ARC Context smoke Δ ")),
  );
  const report = {
    schemaVersion: 1,
    scope: "One explicitly selected packaged Electron-as-Node Context runtime",
    passed: false,
    executable,
    executableSha256: sha256(await readFile(executable)),
    smokeSha256: sha256(await readFile(scriptPath)),
    contextRoot,
    artifacts,
    startedAt: new Date().toISOString(),
    processes: [],
    cases: [],
    limitations: [
      "OS network denial was not applied or tested; only local asset loading and library fetch rejection are evaluated.",
      "This is not clean-machine, installation, signing, retrieval quality or full Phase5 acceptance.",
      "No provider, application UI, daemon or server is started.",
    ],
  };
  const reportPath = join(artifacts, "result.json");
  let saves = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(report, null, 2);
    const next = saves.then(() => writeFile(reportPath, bytes));
    saves = next.catch(() => {});
    return next;
  };
  console.log(`ARC Context smoke artifacts: ${artifacts}`);
  try {
    for (const name of ["home", "roaming", "local", "tmp"])
      await mkdir(join(artifacts, name));
    report.package = await verifyInventory(contextRoot);
    await save();
    report.cases.push(
      await runChild(
        executable,
        artifacts,
        "normal",
        report.package.manifestDigest,
        report,
        save,
      ),
    );
    await save();
    const copied = within(
      artifacts,
      join(artifacts, "Context assets Δ with spaces"),
    );
    await cp(contextRoot, copied, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    assert.equal(
      (await verifyInventory(copied)).manifestDigest,
      report.package.manifestDigest,
    );
    report.cases.push(
      await runChild(
        executable,
        artifacts,
        "unicode",
        report.package.manifestDigest,
        report,
        save,
      ),
    );
    await save();
    const target = within(
      copied,
      join(copied, "models", "Xenova", "all-MiniLM-L6-v2", "config.json"),
    );
    const retained = within(artifacts, join(artifacts, "retained-config.json"));
    await rename(target, retained);
    try {
      report.cases.push(
        await runChild(
          executable,
          artifacts,
          "missing",
          report.package.manifestDigest,
          report,
          save,
        ),
      );
    } finally {
      await rename(retained, target);
    }
    const pristine = await readFile(target);
    const corrupted = Buffer.from(pristine);
    corrupted[0] ^= 1;
    await writeFile(target, corrupted);
    try {
      report.cases.push(
        await runChild(
          executable,
          artifacts,
          "corrupt",
          report.package.manifestDigest,
          report,
          save,
        ),
      );
    } finally {
      await writeFile(target, pristine);
    }
    assert.equal(
      (await verifyInventory(contextRoot)).manifestDigest,
      report.package.manifestDigest,
    );
    assert.equal(sha256(await readFile(executable)), report.executableSha256);
    assert.equal(sha256(await readFile(scriptPath)), report.smokeSha256);
    report.passed = true;
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    await writeFile(
      join(artifacts, "final-result.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx" },
    );
    await writeFile(
      join(artifacts, "final-result.sha256"),
      sha256(await readFile(join(artifacts, "final-result.json"))) + "\n",
      { flag: "wx" },
    );
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "fixture-input": { type: "string" },
      "fixture-output": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      'Usage: node apps/desktop/scripts/smoke-arc-context.mjs --executable "C:\\absolute\\package\\ARC IDE.exe"\nRuns only the fixed packaged Context client/worker using this exact Electron executable as Node. Retains disposable artifacts. No services/providers/UI. Does not establish actual OS network denial, signing or clean-machine acceptance.',
    );
  else if (values["fixture-input"]) {
    try {
      assert(process.send, "Private fixture requires an owned IPC parent");
      assert(!values.executable);
      assert(values["fixture-output"]);
      const config = JSON.parse(
        await readFile(values["fixture-input"], "utf8"),
      );
      assert.equal(
        resolve(values["fixture-input"]),
        within(
          config.artifacts,
          join(config.artifacts, `${config.case}-input.json`),
        ),
      );
      assert.equal(
        resolve(values["fixture-output"]),
        within(
          config.artifacts,
          join(config.artifacts, `${config.case}-result.json`),
        ),
      );
      const result = await runFixture(config);
      await writeFile(
        values["fixture-output"],
        JSON.stringify(result, null, 2),
        { flag: "wx" },
      );
      if (process.connected) process.disconnect();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  } else {
    try {
      assert(
        !values["fixture-output"],
        "Private fixture output requires its owned fixture input",
      );
      assert(values.executable, "An explicit --executable is required");
      const report = await runContextSmoke(values.executable);
      console.log(
        JSON.stringify({
          passed: report.passed,
          artifacts: report.artifacts,
          cases: report.cases.length,
        }),
      );
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

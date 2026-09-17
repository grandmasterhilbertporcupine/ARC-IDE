import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createNodeBbSdk } from "../packages/sdk/src/node.ts";
import { arcAgentsRpcContract } from "../plugins/arc/contract.ts";
import {
  defaultAgentMetadata,
  serializeAgentDocument,
} from "../plugins/arc/document.ts";
import { arcRunsRpcContract } from "../plugins/arc/runtime/contract.ts";
import { runtimeReceiptSchema } from "../plugins/arc/runtime/receipt.ts";

const [mode, argument, overrideUrl] = process.argv.slice(2);
if (mode === "--help" || mode === "help") {
  console.log(
    "Usage: pnpm.cmd exec tsx scripts/arc-team-runtime-smoke.mjs start-pause [http://127.0.0.1:20008]\n       pnpm.cmd exec tsx scripts/arc-team-runtime-smoke.mjs resume <report-path> [http://127.0.0.1:20008]\nThe first command exits only after an actual owned run is durably paused. Restart the same ARC server/daemon/profile before running resume. This harness does not start services or delete fixtures.",
  );
  process.exit(0);
}
assert(
  ["start-pause", "resume"].includes(mode),
  "Choose start-pause or resume; use --help for exact commands",
);
assert.equal(
  process.platform,
  "win32",
  "This harness verifies real native Windows execution",
);
const artifactRoot = resolve(".arc-verification", "team-runtime");
const within = (root, path) => {
  const value = relative(root, path);
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..\\`) &&
    !value.startsWith("../") &&
    !isAbsolute(value)
  );
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stamp = () => new Date().toISOString();
const newId = (purpose) => `arc-team-${purpose}-${randomUUID()}`;
let reportPath;
let report;
if (mode === "resume") {
  assert(argument, "Resume requires the report path emitted by start-pause");
  reportPath = resolve(argument);
  assert(
    within(artifactRoot, reportPath),
    "Resume only this harness's owned verification artifacts",
  );
  report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.harness, "ARC_TEAM_RUNTIME_SMOKE_V1");
  assert.equal(
    report.stage,
    "paused",
    "Resume requires a successfully recorded durable pause",
  );
  assert.equal(report.passed, false);
  assert.equal(resolve(report.artifactDir), dirname(reportPath));
  assert(within(report.artifactDir, resolve(report.workspace)));
  assert(report.runId && report.workflowRunId && report.pauseReceipt);
} else {
  const artifactDir = resolve(
    artifactRoot,
    `${stamp().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  reportPath = resolve(artifactDir, "result.json");
  report = {
    harness: "ARC_TEAM_RUNTIME_SMOKE_V1",
    stage: "creating",
    passed: false,
    startedAt: stamp(),
    artifactDir,
    workspace: resolve(artifactDir, "Native team project Δ with spaces"),
    providerId: "codex",
    model: "gpt-5.6-sol",
    hostId: null,
    projectId: null,
    originThreadId: null,
    runId: null,
    workflowRunId: null,
    agents: [],
    effects: [],
    history: [],
    transcripts: {},
    operations: {
      start: newId("start"),
      pause: newId("pause"),
      resume: newId("resume"),
      cancel: newId("cancel"),
    },
    fixtureMarker: `ARC_TEAM_FIXTURE_${randomUUID()}`,
  };
  await mkdir(report.workspace, { recursive: true });
}
const baseUrl =
  (mode === "resume" ? (overrideUrl ?? report.baseUrl) : argument) ??
  "http://127.0.0.1:20008";
const parsedUrl = new URL(baseUrl);
assert.equal(parsedUrl.protocol, "http:");
assert.equal(
  parsedUrl.hostname,
  "127.0.0.1",
  "Use only the local ARC acceptance installation",
);
assert.equal(
  parsedUrl.username + parsedUrl.password + parsedUrl.search + parsedUrl.hash,
  "",
);
report.baseUrl = baseUrl;
const sdk = createNodeBbSdk({ baseUrl, timeoutMs: 45_000 });
const rpc = (contract, method, input) =>
  sdk.plugins.callRpc({
    pluginId: "arc",
    method,
    input,
    outputSchema: contract[method].output,
  });
const agentsRpc = (method, input) => rpc(arcAgentsRpcContract, method, input);
const runsRpc = (method, input) => rpc(arcRunsRpcContract, method, input);
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let stoppedBySignal = null;
const stop = (signal) => {
  stoppedBySignal = signal;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const checkSignal = () => {
  if (stoppedBySignal !== null)
    throw new Error(`Harness interrupted by ${stoppedBySignal}`);
};
const gitAt = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
const git = (...args) => gitAt(report.workspace, ...args);

const checkSource = `
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
console.log("ARC_TEAM_CHECK_STARTED");
const {renderPage} = await import(pathToFileURL(resolve("src/frontend.mjs")).href);
const {quoteOrder} = await import(pathToFileURL(resolve("src/backend.mjs")).href);
const html = renderPage({count: 2, total: 200, currency: "USD"});
assert.equal(typeof html, "string");
assert.match(html, /<h1>ARC Shop<\\/h1>/);
assert.match(html, /data-testid=["']product-count["'][^>]*>2</);
assert.match(html, /data-testid=["']order-total["'][^>]*>200</);
assert.throws(() => quoteOrder(0), /quantity/i);
assert.throws(() => quoteOrder(1.5), /quantity/i);
assert.deepEqual(quoteOrder(2), {count: 2, total: 200, currency: "USD"}, "ARC_PRICING_ASSERT: existing shared pricing must charge exactly 100 cents per item");
assert.deepEqual(quoteOrder(3), {count: 3, total: 300, currency: "USD"}, "ARC_PRICING_ASSERT: quantity three must cost 300 cents");
assert((await readFile("shared/pricing.mjs", "utf8")).includes("totalPrice"));
const server = spawn(process.execPath, ["server.mjs", "0"], {cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
let timer;
try {
  const address = await new Promise((resolveAddress, reject) => {
    let output = "";
    timer = setTimeout(() => reject(new Error("HTTP server did not announce its loopback address")), 10000);
    server.stdout.on("data", chunk => { output += chunk.toString(); const match = /ARC_SERVER_PORT=(\\d+)/.exec(output); if (match) resolveAddress("http://127.0.0.1:" + match[1]); });
    server.once("error", reject);
    server.once("exit", code => reject(new Error("HTTP server exited early: " + code)));
  });
  clearTimeout(timer);
  const quote = await fetch(address + "/quote?count=3", {signal: AbortSignal.timeout(5000)});
  assert.equal(quote.status, 200);
  assert.deepEqual(await quote.json(), {count: 3, total: 300, currency: "USD"});
  const page = await fetch(address + "/", {signal: AbortSignal.timeout(5000)});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>ARC Shop<\\/h1>/);
  const invalid = await fetch(address + "/quote?count=0", {signal: AbortSignal.timeout(5000)});
  assert.equal(invalid.status, 400);
  console.log("ARC_TEAM_CHECK_PASSED");
} finally {
  clearTimeout(timer);
  if (server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
}
`;

async function originalFingerprint() {
  assert.equal(
    await realpath(git("rev-parse", "--show-toplevel")),
    await realpath(report.workspace),
    "Fixture must be its own Git repository",
  );
  const paths = git("ls-files", "-z").split("\0").filter(Boolean).sort();
  const files = {};
  for (const path of paths)
    files[path] = hash(await readFile(resolve(report.workspace, path)));
  return {
    head: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
    files,
  };
}

async function assertOriginalUnchanged() {
  const current = await originalFingerprint();
  assert.deepEqual(
    current,
    report.original,
    "The original checkout, HEAD, branch, index and working files must remain unchanged",
  );
  assert(
    (await readFile(resolve(report.workspace, "README.md"), "utf8")).includes(
      report.fixtureMarker,
    ),
  );
  return current;
}

async function createFixture() {
  const files = {
    "README.md": `# Disposable ARC team acceptance\n\n${report.fixtureMarker}\n\nThe frontend writer owns only src/frontend.mjs. The backend writer owns only src/backend.mjs. Both must leave shared/pricing.mjs untouched; the integrated required check and admitted repair stage own the existing pricing defect. No network installs, credentials or unrelated repositories are needed.\n`,
    "package.json":
      JSON.stringify(
        {
          name: "arc-team-native-fixture",
          private: true,
          type: "module",
          scripts: { start: "node server.mjs" },
        },
        null,
        2,
      ) + "\n",
    "src/frontend.mjs":
      "export function renderPage() { return '<main>ARC fixture awaiting frontend implementation</main>'; }\n",
    "src/backend.mjs":
      "export function quoteOrder() { throw new Error('ARC fixture awaiting backend implementation'); }\n",
    "shared/pricing.mjs":
      "export function totalPrice(quantity) { return quantity * 100 + 1; }\n",
    "server.mjs": `import {createServer} from "node:http";\nimport {renderPage} from "./src/frontend.mjs";\nimport {quoteOrder} from "./src/backend.mjs";\nconst server = createServer((request, response) => {\n  try {\n    const url = new URL(request.url, "http://127.0.0.1");\n    if (url.pathname === "/quote") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(quoteOrder(Number(url.searchParams.get("count"))))); }\n    else if (url.pathname === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(renderPage(quoteOrder(2))); }\n    else { response.statusCode = 404; response.end("Not found"); }\n  } catch (error) { response.statusCode = 400; response.end(error.message); }\n});\nserver.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log("ARC_SERVER_PORT=" + server.address().port));\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(report.workspace, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "ARC Team Acceptance Fixture");
  git("config", "--local", "user.email", "arc-team-fixture@example.invalid");
  git("config", "--local", "commit.gpgSign", "false");
  git("config", "--local", "core.autocrlf", "false");
  git("config", "--local", "core.hooksPath", ".git/disabled-hooks");
  git("add", "--", ".");
  git("commit", "-m", "Initialize disposable native ARC team fixture");
  report.original = await originalFingerprint();
  assert.equal(report.original.status, "");
  report.check = {
    executable: process.execPath,
    args: ["--input-type=module", "--eval", checkSource],
    timeoutMs: 30_000,
  };
  report.checkSourceHash = hash(checkSource);
  await writeFile(
    resolve(report.artifactDir, "required-check-source.mjs"),
    checkSource,
    "utf8",
  );
  await save();
}

function agentInstructions() {
  return `You are a real ARC runtime acceptance agent in one disposable local Git fixture. Read arc_run_snapshot first. Work only in the assigned worktree. Do not inspect credentials, accounts, environment variables or unrelated files/repositories. Do not install dependencies, access the public network, create subagents, commit, merge, push or deploy. Do not change required-check configuration.\n\nWhen assigned a writer task, edit only its named source file and leave the existing shared/pricing.mjs defect untouched. To make actual pause verification observable, on writer attempt 1 only, after reading arc_run_snapshot run one bounded native command: powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 45". Wait for it before editing. On later writer attempts skip this wait entirely; never rerun a cancelled probe. Inspect any retained edits in your worktree and finish only the assigned file.\n\nWhen assigned repair, diagnose the actual required-check receipt. Preserve both writers' work and fix shared/pricing.mjs so totalPrice(quantity) returns exactly quantity * 100. Verify with built-in Node only.\n\nWhen assigned review, do not edit any files. Inspect the exact candidate, confirm the frontend, backend and pricing behavior, and use arc_run_review with the actual candidate HEAD and your genuine approved or changes-requested verdict. Completing chat without this tool is not approval. Do not invent checks, native output or verdict receipts.`;
}

async function prepareProject() {
  const hosts = (await sdk.hosts.list()).filter(
    (host) => host.status === "connected",
  );
  assert.equal(
    hosts.length,
    1,
    "Exactly one connected local acceptance host is required",
  );
  report.hostId = hosts[0].id;
  const catalog = await sdk.providers.models({
    hostId: report.hostId,
    providerId: report.providerId,
  });
  assert.equal(catalog.modelLoadError, null);
  const selected = catalog.models.find((model) => model.model === report.model);
  assert(
    selected,
    "The real Codex catalog must advertise gpt-5.6-sol; no model substitution is allowed",
  );
  report.execution = {
    providerId: report.providerId,
    model: report.model,
    reasoningLevel: selected.supportedReasoningEfforts.some(
      (value) => value.reasoningEffort === "low",
    )
      ? "low"
      : selected.defaultReasoningEffort,
    serviceTier: "default",
    permissionMode: "full",
  };
  const project = await sdk.projects.create({
    name: `ARC team native ${report.fixtureMarker.slice(-12)}`,
    source: {
      type: "local_path",
      hostId: report.hostId,
      path: report.workspace,
    },
  });
  report.projectId = project.id;
  await save();
  const scope = { kind: "project", projectId: project.id };
  for (const role of ["Frontend", "Backend"]) {
    const metadata = defaultAgentMetadata(`ARC native ${role}`);
    metadata.description =
      "Published agent for actual isolated-writer, repair and review verification";
    metadata.role = `${role} engineer and assigned reviewer`;
    metadata.execution = report.execution;
    let { agent } = await agentsRpc("createAgent", {
      scope,
      document: serializeAgentDocument(metadata, agentInstructions()),
    });
    ({ agent } = await agentsRpc("publishAgentRevision", {
      scope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
    }));
    assert.equal(agent.currentRevision, 1);
    const { revision } = await agentsRpc("getAgentRevision", {
      scope,
      agentId: agent.id,
      revision: 1,
    });
    report.agents.push({
      role,
      agentId: agent.id,
      revision: 1,
      contentHash: revision.contentHash,
    });
    await save();
  }
  const thread = await sdk.threads.spawn({
    projectId: project.id,
    environment: {
      type: "host",
      hostId: report.hostId,
      workspace: { type: "unmanaged", path: report.workspace },
    },
    title: "ARC native team orchestrator",
    ...report.execution,
    prompt: `This is the parent conversation for a disposable ARC team run. Reply only ARC_TEAM_PARENT_READY. Do not call tools, read files, change files, delegate or start work. The harness will start the owned team run through ARC.`,
  });
  report.originThreadId = thread.id;
  await save();
  await poll("parent-ready", 180_000, async () => {
    const current = await sdk.threads.get({ threadId: thread.id });
    await captureThread(thread.id);
    if (["error", "blocked"].includes(current.status))
      throw new Error(`Parent reached ${current.status}`);
    return (
      current.status === "idle" &&
      report.transcripts[thread.id].completed.some(
        (event) => event.status === "completed",
      )
    );
  });
  await assertOriginalUnchanged();
  const setup = await runsRpc("getRunSetup", {
    projectId: report.projectId,
    hostId: report.hostId,
  });
  assert.equal(resolve(setup.selected.path), resolve(report.workspace));
  assert.equal(setup.selected.head, report.original.head);
  assert.equal(setup.selected.clean, true);
  const [frontend, backend] = report.agents;
  const selection = ({ agentId, revision }) => ({ agentId, revision });
  report.request = {
    operationId: report.operations.start,
    projectId: report.projectId,
    originThreadId: report.originThreadId,
    hostId: report.hostId,
    path: setup.selected.path,
    expectedHead: setup.selected.head,
    goal: "Build the tiny dependency-free ARC Shop Node app: render its order summary and serve validated quantity quotes at exactly 100 cents per item. Writers own separate files; required native checks must reveal the existing shared pricing defect, and the admitted repair stage must fix that defect. The final reviewer must inspect and approve the exact integrated candidate with arc_run_review.",
    writers: [
      {
        agent: selection(frontend),
        task: 'Edit only src/frontend.mjs. Export renderPage({count,total,currency}) returning an HTML string with exactly <h1>ARC Shop</h1>, an element data-testid="product-count" containing the numeric count, and an element data-testid="order-total" containing the numeric total in cents. Reflect the supplied values. Do not modify shared/pricing.mjs, src/backend.mjs, server.mjs or package.json. The deliberate shared pricing bug belongs to the later repair stage.',
      },
      {
        agent: selection(backend),
        task: 'Edit only src/backend.mjs. Import totalPrice from ../shared/pricing.mjs. Export quoteOrder(quantity), reject non-integer or non-positive quantities with an Error whose message contains quantity, and return {count:quantity,total:totalPrice(quantity),currency:"USD"}. Do not modify shared/pricing.mjs, src/frontend.mjs, server.mjs or package.json. Preserve the deliberately faulty shared price calculation for the required check and later repair stage.',
      },
    ],
    reviewer: selection(frontend),
    repairer: selection(backend),
    check: report.check,
  };
  report.requestHash = hash(JSON.stringify(report.request));
  report.stage = "prepared";
  await save();
}

function boundedEvent(row) {
  const serialized = JSON.stringify(row);
  return serialized.length <= 16_000
    ? serialized
    : JSON.stringify({
        id: row.id,
        seq: row.seq,
        type: row.type,
        createdAt: row.createdAt,
        truncated: true,
        prefix: serialized.slice(0, 15_000),
      });
}

async function captureThread(threadId) {
  let transcript = report.transcripts[threadId];
  if (!transcript) {
    transcript = report.transcripts[threadId] = {
      cursor: 0,
      count: 0,
      retainedBytes: 0,
      truncated: false,
      file: `thread-${Object.keys(report.transcripts).length + 1}.jsonl`,
      accepted: [],
      started: [],
      completed: [],
      tools: [],
    };
  }
  for (let page = 0; page < 4; page++) {
    const rows = await sdk.threads.events.list({
      threadId,
      afterSeq: String(transcript.cursor),
      order: "asc",
      limit: "500",
    });
    if (rows.length === 0) break;
    const output = [];
    for (const row of rows) {
      transcript.cursor = Math.max(transcript.cursor, row.seq);
      transcript.count++;
      if (row.type === "turn/input/accepted")
        transcript.accepted.push({
          id: row.id,
          seq: row.seq,
          clientRequestId: row.data.clientRequestId,
          createdAt: row.createdAt,
        });
      if (row.type === "turn/started")
        transcript.started.push({
          id: row.id,
          seq: row.seq,
          providerThreadId: row.data.providerThreadId,
          createdAt: row.createdAt,
        });
      if (row.type === "turn/completed")
        transcript.completed.push({
          id: row.id,
          seq: row.seq,
          status: row.data.status,
          createdAt: row.createdAt,
        });
      if (row.type === "item/completed" && row.data.item.type === "toolCall")
        transcript.tools.push({
          seq: row.seq,
          tool: row.data.item.tool,
          status: row.data.item.status,
          item: JSON.stringify(row.data.item).slice(0, 12_000),
        });
      for (const key of ["accepted", "started", "completed", "tools"])
        if (transcript[key].length > 200)
          transcript[key].splice(0, transcript[key].length - 200);
      const line = boundedEvent(row) + "\n";
      if (transcript.retainedBytes + Buffer.byteLength(line) <= 1024 * 1024) {
        output.push(line);
        transcript.retainedBytes += Buffer.byteLength(line);
      } else transcript.truncated = true;
    }
    if (output.length)
      await appendFile(
        resolve(report.artifactDir, transcript.file),
        output.join(""),
        "utf8",
      );
    if (rows.length < 500) break;
  }
}

async function snapshot() {
  const view = await runsRpc("getRun", { runId: report.runId });
  assert.equal(view.definition.request.operationId, report.operations.start);
  assert.equal(view.summary.projectId, report.projectId);
  assert.equal(view.summary.workflowRunId, report.workflowRunId);
  const listed = [];
  for (let offset = 0; ; offset += 100) {
    const page = await runsRpc("listRunEffects", {
      runId: report.runId,
      offset,
      limit: 100,
    });
    assert(
      page.total <= 256,
      "This bounded acceptance must not produce more than 256 effects",
    );
    listed.push(...page.effects);
    if (listed.length >= page.total) break;
  }
  report.effects = await Promise.all(
    listed.map((effect) =>
      runsRpc("getRunEffect", {
        runId: report.runId,
        effectId: effect.effectId,
      }),
    ),
  );
  const threads = [
    ...new Set(
      listed.flatMap((effect) =>
        effect.resource?.kind === "agent" ? [effect.resource.threadId] : [],
      ),
    ),
  ];
  await Promise.all(threads.map(captureThread));
  report.latest = view;
  const stateKey = JSON.stringify([
    view.workflow?.state,
    view.workflow?.desiredControl,
    view.workflow?.controlVersion,
    view.workflow?.agentCalls,
    listed.map((effect) => [
      effect.effectId,
      effect.state,
      effect.resource?.kind === "agent" ? effect.resource.turnRequestId : null,
    ]),
  ]);
  if (stateKey !== report.lastStateKey) {
    report.lastStateKey = stateKey;
    report.history.push({
      at: stamp(),
      state: view.workflow?.state,
      controlVersion: view.workflow?.controlVersion,
      agentCalls: view.workflow?.agentCalls,
      activeAgents: view.workflow?.activeAgents,
      effects: listed.map(
        ({ effectId, nodeId, iteration, attempt, state }) => ({
          effectId,
          nodeId,
          iteration,
          attempt,
          state,
        }),
      ),
    });
    if (report.history.length > 256) report.history.shift();
    console.log(
      JSON.stringify({
        phase: report.stage,
        state: view.workflow?.state,
        agentCalls: view.workflow?.agentCalls,
        activeAgents: view.workflow?.activeAgents,
        effects: listed.length,
      }),
    );
  }
  await save();
  return view;
}

async function poll(label, timeoutMs, test) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkSignal();
    if (await test()) return;
    await delay(500);
  }
  throw new Error(
    `${label} did not meet its actual acceptance gate within ${timeoutMs} ms`,
  );
}

function assertLiveState(view) {
  assert(view.workflow, "Owned workflow must have been submitted");
  if (
    ["failed", "cancelled"].includes(view.workflow.state) ||
    (view.workflow.state === "needs-reconciliation" &&
      view.workflow.desiredControl !== "run")
  )
    throw new Error(
      `Run reached ${view.workflow.state}: ${view.workflow.error ?? view.summary.submissionError ?? "No additional reason"}`,
    );
}

async function startAndPause() {
  await createFixture();
  await prepareProject();
  report.stage = "starting";
  await save();
  const view = await runsRpc("startRun", report.request);
  report.runId = view.summary.runId;
  report.workflowRunId = view.summary.workflowRunId;
  assert(report.workflowRunId);
  report.planHash = view.summary.planHash;
  report.stage = "waiting-for-native-writers";
  await save();
  await poll("two accepted native writer turns", 240_000, async () => {
    const current = await snapshot();
    assertLiveState(current);
    if (current.workflow.state === "succeeded")
      throw new Error("Run completed before the required native pause gate");
    const writers = ["writer-0", "writer-1"].map((nodeId) =>
      report.effects.find(
        (item) => item.effect.nodeId === nodeId && item.effect.attempt === 1,
      ),
    );
    if (
      writers.some(
        (item) =>
          !item ||
          item.effect.resource?.kind !== "agent" ||
          !item.effect.resource.turnRequestId,
      )
    )
      return false;
    if (
      writers.some(
        (item) =>
          item.observation &&
          ["succeeded", "failed", "interrupted"].includes(
            item.observation.state,
          ),
      )
    )
      throw new Error("A writer finished before both native turns overlapped");
    const proof = writers.map((item) => {
      const resource = item.effect.resource;
      const transcript = report.transcripts[resource.threadId];
      return {
        effectId: item.effect.effectId,
        nodeId: item.effect.nodeId,
        resource,
        accepted: transcript?.accepted.find(
          (event) => event.clientRequestId === resource.turnRequestId,
        ),
        started: transcript?.started[0],
      };
    });
    if (proof.some((item) => !item.accepted || !item.started)) return false;
    assert.equal(current.workflow.activeAgents, 2);
    report.acceptedWriters = proof;
    report.pauseInput = {
      runId: report.runId,
      operationId: report.operations.pause,
      expectedVersion: current.workflow.controlVersion,
      action: "pause",
    };
    return true;
  });
  report.stage = "pausing";
  await save();
  await runsRpc("controlRun", report.pauseInput);
  await poll("durable native pause", 120_000, async () => {
    const current = await snapshot();
    if (["failed", "cancelled", "succeeded"].includes(current.workflow.state))
      throw new Error(`Pause ended unexpectedly in ${current.workflow.state}`);
    return current.workflow.state === "paused";
  });
  assert.equal(report.latest.workflow.desiredControl, "pause");
  assert.equal(report.latest.workflow.activeAgents, 0);
  for (const writer of report.acceptedWriters) {
    const effect = report.effects.find(
      (item) => item.effect.effectId === writer.effectId,
    );
    assert.equal(
      effect.observation?.state,
      "interrupted",
      "Each accepted first writer must have an actual interrupted receipt",
    );
    const receipt = runtimeReceiptSchema.parse(effect.observation.receipt);
    assert.equal(receipt.kind, "agent");
    assert.equal(receipt.turnRequestId, writer.resource.turnRequestId);
    assert.equal(receipt.terminalStatus, "interrupted");
  }
  await assertOriginalUnchanged();
  report.pauseReceipt = report.latest.workflow;
  report.pausedEffects = report.effects.map(({ effect, observation }) => ({
    ...effect,
    receiptHash:
      observation && "receiptHash" in observation
        ? observation.receiptHash
        : null,
  }));
  report.pausedAt = stamp();
  report.stage = "paused";
  await save();
}

function successful(nodeId, iteration) {
  return report.effects.find(
    (item) =>
      item.effect.nodeId === nodeId &&
      (iteration === undefined || item.effect.iteration === iteration) &&
      item.observation?.state === "succeeded",
  );
}

function nativeReceipt(item, type) {
  assert(item, `Missing actual ${type} effect`);
  const receipt = runtimeReceiptSchema.parse(item.observation.receipt);
  assert.equal(receipt.kind, "native");
  assert.equal(receipt.request.operation.type, type);
  return receipt;
}

async function verifyFinal() {
  const view = report.latest;
  assert.equal(view.workflow.state, "succeeded");
  assert.equal(view.verification.state, "current");
  assert.equal(view.summary.planHash, report.planHash);
  assert.equal(view.workflow.activeAgents, 0);
  assert(
    view.workflow.repairRounds.some((stage) => stage.rounds > 0),
    "A real failed-check repair round is required",
  );
  assert(
    view.workflow.agentCalls > report.pauseReceipt.agentCalls,
    "Resumed interrupted workers must consume new admitted calls",
  );
  const failedCheck = report.effects.find(
    (item) =>
      item.effect.nodeId === "check" &&
      item.effect.iteration === 0 &&
      item.observation?.state === "failed",
  );
  const failedReceipt = nativeReceipt(failedCheck, "check");
  const failedProcess = failedReceipt.receipt.processes.find(
    (process) =>
      process.executable === report.check.executable &&
      JSON.stringify(process.args) === JSON.stringify(report.check.args),
  );
  assert(
    failedProcess &&
      failedProcess.exitCode !== null &&
      failedProcess.exitCode !== 0,
  );
  assert(
    failedProcess.stderr.includes("ARC_PRICING_ASSERT"),
    "Check0 must fail because of the preserved third-file pricing bug",
  );
  const finalCheck = report.effects
    .filter(
      (item) =>
        item.effect.nodeId === "check" &&
        item.observation?.state === "succeeded",
    )
    .sort((a, b) => b.effect.iteration - a.effect.iteration)[0];
  assert(finalCheck && finalCheck.effect.iteration > 0);
  const checked = nativeReceipt(finalCheck, "check");
  const checkedProcess = checked.receipt.processes.find(
    (process) =>
      process.executable === report.check.executable &&
      JSON.stringify(process.args) === JSON.stringify(report.check.args),
  );
  assert.equal(checkedProcess?.exitCode, 0);
  assert(checkedProcess.stdout.includes("ARC_TEAM_CHECK_PASSED"));
  const review = successful("review", finalCheck.effect.iteration);
  const verdict = runtimeReceiptSchema.parse(review?.observation?.receipt);
  assert.equal(verdict.kind, "agent");
  assert.equal(verdict.review?.outcome, "approved");
  assert.equal(verdict.review.candidateHead, checked.receipt.after.head);
  assert(
    report.transcripts[verdict.threadId].tools.some(
      (tool) =>
        tool.tool.includes("arc_run_review") && tool.status !== "failed",
    ),
    "Approval must come from an actual arc_run_review tool invocation",
  );
  const verified = nativeReceipt(
    successful("verify", finalCheck.effect.iteration),
    "snapshot",
  );
  for (const state of [
    checked.receipt.before,
    checked.receipt.after,
    verdict.workspace,
    verified.receipt.after,
  ]) {
    assert(state);
    assert.equal(state.head, view.verification.head);
    assert.equal(
      state.stateDigest,
      verified.receipt.after.stateDigest,
      "Final check, review and snapshot must bind the same exact candidate",
    );
  }
  const writerPaths = [];
  for (const index of [0, 1]) {
    const writer = successful(`writer-${index}`);
    assert(
      writer && writer.effect.attempt > 1,
      "Each interrupted writer must resume as a new physical attempt",
    );
    const receipt = runtimeReceiptSchema.parse(writer.observation.receipt);
    assert.equal(receipt.kind, "agent");
    const committed = nativeReceipt(
      successful(`writer-${index}-commit`),
      "commit",
    );
    const changed = gitAt(
      receipt.workspace.path,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      committed.receipt.artifact.commitSha,
    )
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(
      changed,
      [index === 0 ? "src/frontend.mjs" : "src/backend.mjs"],
      "Each writer must change only its assigned source file",
    );
    assert.equal(
      gitAt(
        receipt.workspace.path,
        "show",
        `${committed.receipt.artifact.commitSha}:shared/pricing.mjs`,
      ),
      git("show", `${report.original.head}:shared/pricing.mjs`),
    );
    writerPaths.push(await realpath(receipt.workspace.path));
    nativeReceipt(successful(`integrate-${index}`), "integrate");
  }
  const integrationPath = await realpath(view.verification.workspacePath);
  assert.equal(
    new Set([...writerPaths, integrationPath, await realpath(report.workspace)])
      .size,
    4,
    "Two writers, integration and original must be distinct worktrees",
  );
  const originalCommon = await realpath(
    resolve(report.workspace, git("rev-parse", "--git-common-dir")),
  );
  for (const path of [...writerPaths, integrationPath])
    assert.equal(
      await realpath(
        resolve(path, gitAt(path, "rev-parse", "--git-common-dir")),
      ),
      originalCommon,
    );
  assert.equal(
    gitAt(integrationPath, "rev-parse", "HEAD"),
    view.verification.head,
  );
  assert.equal(
    gitAt(integrationPath, "status", "--porcelain=v1", "--untracked-files=all"),
    "",
  );
  const repairCommit = nativeReceipt(
    successful("repair-commit", finalCheck.effect.iteration),
    "commit",
  );
  const repairChanges = gitAt(
    integrationPath,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    repairCommit.receipt.artifact.commitSha,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  assert(
    repairChanges.includes("shared/pricing.mjs"),
    "The admitted repair must change the pre-existing pricing implementation",
  );
  await assertOriginalUnchanged();
  assert.equal(
    hash(
      await readFile(resolve(report.artifactDir, "required-check-source.mjs")),
    ),
    report.checkSourceHash,
  );
  assert.deepEqual(view.definition.request.check, report.check);
  report.finalEvidence = {
    head: view.verification.head,
    integrationPath,
    writerPaths,
    failedCheckEffectId: failedCheck.effect.effectId,
    repairIteration: finalCheck.effect.iteration,
    finalCheckEffectId: finalCheck.effect.effectId,
    reviewerThreadId: verdict.threadId,
    review: verdict.review,
    verificationEffectId: successful("verify", finalCheck.effect.iteration)
      .effect.effectId,
    originalUnchanged: true,
    checkSourceHash: report.checkSourceHash,
  };
}

async function resumeRun() {
  await assertOriginalUnchanged();
  assert.equal(hash(JSON.stringify(report.request)), report.requestHash);
  const host = (await sdk.hosts.list()).find(
    (value) => value.id === report.hostId,
  );
  assert.equal(
    host?.status,
    "connected",
    "Reconnect the same retained host after the actual restart",
  );
  const before = await snapshot();
  assert.equal(before.workflow.state, "paused");
  assert.equal(before.workflow.desiredControl, "pause");
  assert.equal(before.summary.planHash, report.planHash);
  assert.equal(before.workflow.agentCalls, report.pauseReceipt.agentCalls);
  assert.equal(
    before.workflow.controlVersion,
    report.pauseReceipt.controlVersion,
  );
  assert(
    before.workflow.dispatchGeneration > report.pauseReceipt.dispatchGeneration,
    "The actual workflow worker must have restarted between commands",
  );
  for (const retained of report.pausedEffects) {
    const current = report.effects.find(
      (item) => item.effect.effectId === retained.effectId,
    );
    assert(current, "All pre-restart effect identities must survive");
    if (retained.receiptHash !== null)
      assert.equal(
        current.observation?.receiptHash,
        retained.receiptHash,
        "Restart must preserve immutable terminal receipts",
      );
  }
  report.restartEvidence = {
    beforeGeneration: report.pauseReceipt.dispatchGeneration,
    afterGeneration: before.workflow.dispatchGeneration,
    callsPreserved: before.workflow.agentCalls,
    at: stamp(),
  };
  report.resumeInput = {
    runId: report.runId,
    operationId: report.operations.resume,
    expectedVersion: before.workflow.controlVersion,
    action: "resume",
  };
  report.stage = "resuming";
  await save();
  await runsRpc("controlRun", report.resumeInput);
  await poll(
    "native integrated check, repair, reviewer and final verification",
    20 * 60_000,
    async () => {
      const current = await snapshot();
      assertLiveState(current);
      return current.workflow.state === "succeeded";
    },
  );
  await verifyFinal();
  report.passed = true;
  report.stage = "passed";
  report.finishedAt = stamp();
  await save();
}

async function cancelOnlyOwnedRun() {
  if (!report.runId && report.projectId && report.request) {
    const page = await runsRpc("listRuns", {
      projectId: report.projectId,
      offset: 0,
      limit: 50,
    });
    for (const summary of page.runs) {
      const candidate = await runsRpc("getRun", { runId: summary.runId });
      if (
        candidate.definition.request.operationId === report.operations.start
      ) {
        report.runId = summary.runId;
        report.workflowRunId = summary.workflowRunId;
        break;
      }
    }
  }
  if (!report.runId) return;
  const current = await runsRpc("getRun", { runId: report.runId });
  assert.equal(
    current.definition.request.operationId,
    report.operations.start,
    "Never cancel another run",
  );
  assert.equal(current.summary.projectId, report.projectId);
  if (
    !current.workflow ||
    ["succeeded", "failed", "cancelled"].includes(current.workflow.state)
  ) {
    report.failureCleanup = {
      state: current.workflow?.state ?? "unsubmitted",
      cancellationSent: false,
    };
    return;
  }
  report.cancelInput ??= {
    runId: report.runId,
    operationId: report.operations.cancel,
    expectedVersion: current.workflow.controlVersion,
    action: "cancel",
  };
  await save();
  await runsRpc("controlRun", report.cancelInput);
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = await runsRpc("getRun", { runId: report.runId });
    if (["cancelled", "failed", "succeeded"].includes(last.workflow?.state))
      break;
    await delay(500);
  }
  report.failureCleanup = {
    state: last?.workflow?.state ?? "unknown",
    cancellationSent: true,
    activeAgents: last?.workflow?.activeAgents ?? null,
  };
}

try {
  if (mode === "start-pause") await startAndPause();
  else await resumeRun();
} catch (error) {
  report.failedStage = report.stage;
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.stage = "failed";
  report.failedAt = stamp();
  await save();
  try {
    await cancelOnlyOwnedRun();
  } catch (cleanupError) {
    report.failureCleanup = {
      error:
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
    };
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await save();
  console.log(
    JSON.stringify({
      mode,
      stage: report.stage,
      passed: report.passed,
      reportPath,
      runId: report.runId,
      workflowRunId: report.workflowRunId,
      failure: report.failure ?? null,
      next:
        report.stage === "paused"
          ? `Restart the same ARC server and daemon, then run: pnpm.cmd exec tsx scripts/arc-team-runtime-smoke.mjs resume "${reportPath}" "${baseUrl}"`
          : null,
    }),
  );
}

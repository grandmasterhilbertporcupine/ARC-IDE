import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createNodeBbSdk } from "../packages/sdk/src/node.ts";
import { arcAgentsRpcContract } from "../plugins/arc/contract.ts";
import {
  defaultAgentMetadata,
  serializeAgentDocument,
} from "../plugins/arc/document.ts";
import { arcRunsRpcContract } from "../plugins/arc/runtime/contract.ts";
import { runtimeReceiptSchema } from "../plugins/arc/runtime/receipt.ts";
import { workspaceViewSchema } from "../plugins/arc/workspace/contract.ts";

const [sourceArgument, serverArgument] = process.argv.slice(2);
if (sourceArgument === "--help") {
  console.log(
    "Usage: node --conditions=source --import tsx scripts/arc-workspace-smoke.mjs [phase3-result.json] [http://127.0.0.1:20008]\nRuns an actual two-turn Codex Workspace acceptance in the retained disposable Phase 3 project. Requires an already stable ARC app at http://127.0.0.1:12008. It does not start services or delete fixtures.",
  );
  process.exit(0);
}
assert.equal(process.platform, "win32");
const root = resolve(".arc-verification");
const sourcePath = resolve(
  sourceArgument ??
    ".arc-verification/team-runtime/2026-09-10T07-29-14-289Z-43a94d2a/result.json",
);
const within = (parent, path) => {
  const value = relative(parent, path);
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith("..\\") &&
    !value.startsWith("../") &&
    !isAbsolute(value)
  );
};
assert(
  within(resolve(root, "team-runtime"), sourcePath),
  "Use this checkout's retained Phase 3 fixture report",
);
const source = JSON.parse(await readFile(sourcePath, "utf8"));
assert.equal(source.harness, "ARC_TEAM_RUNTIME_SMOKE_V1");
assert(source.passed && source.stage === "passed");
assert(within(dirname(sourcePath), resolve(source.workspace)));
const baseUrl = serverArgument ?? "http://127.0.0.1:20008";
assert.equal(
  baseUrl,
  "http://127.0.0.1:20008",
  "Use the coordinated local ARC acceptance server",
);
const appUrl = "http://127.0.0.1:12008";
const stamp = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const artifactDir = resolve(
  root,
  "workspace-native",
  `${stamp().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
);
await mkdir(artifactDir, { recursive: true });
const reportPath = resolve(artifactDir, "result.json");
const report = {
  harness: "ARC_WORKSPACE_NATIVE_SMOKE_V1",
  passed: false,
  stage: "preflight",
  startedAt: stamp(),
  artifactDir,
  sourcePath,
  baseUrl,
  appUrl,
  workspace: source.workspace,
  original: source.original,
  projectId: source.projectId,
  originThreadId: source.originThreadId,
  hostId: source.hostId,
  providerId: "codex",
  model: "gpt-5.6-sol",
  runId: null,
  workflowRunId: null,
  operations: Object.fromEntries(
    ["start", "pause", "resume", "cancel"].map((key) => [
      key,
      `workspace-${key}-${randomUUID()}`,
    ]),
  ),
  errors: [],
  screenshots: [],
  workspaceResponses: [],
  transcripts: {},
  effects: [],
  history: [],
};
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
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
let browser;
let page;
let latestWorkspace = null;
let observedRunId = source.runId;
let documentEpoch = 0;
const requestEpochs = new WeakMap();
let stopSignal = null;
const responseTasks = new Set();
const stop = (signal) => {
  stopSignal = signal;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function poll(label, timeoutMs, test) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopSignal) throw new Error(`Harness interrupted by ${stopSignal}`);
    if (await test()) return;
    await delay(600);
  }
  throw new Error(
    `${label} did not meet the actual acceptance gate within ${timeoutMs} ms`,
  );
}

async function assertOriginal() {
  assert.equal(
    await realpath(git(source.workspace, "rev-parse", "--show-toplevel")),
    await realpath(source.workspace),
  );
  assert.equal(
    git(source.workspace, "rev-parse", "HEAD"),
    source.original.head,
  );
  assert.equal(
    git(source.workspace, "branch", "--show-current"),
    source.original.branch,
  );
  assert.equal(
    git(source.workspace, "status", "--porcelain=v1", "--untracked-files=all"),
    source.original.status,
  );
  const tracked = git(source.workspace, "ls-files", "-z")
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.deepEqual(tracked, Object.keys(source.original.files).sort());
  for (const [path, digest] of Object.entries(source.original.files))
    assert.equal(
      hash(await readFile(resolve(source.workspace, path))),
      digest,
      `Original file changed: ${path}`,
    );
}

async function parentEvidence() {
  const rows = [];
  let afterSeq = "0";
  for (let index = 0; index < 5; index++) {
    const batch = await sdk.threads.events.list({
      threadId: report.originThreadId,
      types: ["turn/input/accepted", "turn/completed", "system/operation"],
      afterSeq,
      order: "asc",
      limit: "1000",
    });
    rows.push(...batch);
    if (batch.length < 1000) break;
    assert(
      index < 4,
      "Parent event evidence must remain complete within its bounded five-page read",
    );
    afterSeq = String(batch.at(-1).seq);
  }
  const accepted = rows
    .filter((row) => row.type === "turn/input/accepted")
    .map((row) => ({
      eventId: row.id,
      seq: row.seq,
      createdAt: row.createdAt,
      scope: row.scope,
      clientRequestId: row.data.clientRequestId,
      providerThreadId: row.data.providerThreadId,
    }));
  const completed = rows
    .filter((row) => row.type === "turn/completed")
    .map((row) => ({
      eventId: row.id,
      seq: row.seq,
      createdAt: row.createdAt,
      scope: row.scope,
      status: row.data.status,
      providerThreadId: row.data.providerThreadId,
      clientRequestId:
        row.scope.kind === "turn"
          ? (accepted.find(
              (event) =>
                event.scope.kind === "turn" &&
                event.scope.turnId === row.scope.turnId,
            )?.clientRequestId ?? null)
          : null,
    }));
  const passive = rows
    .filter(
      (row) =>
        row.type === "system/operation" &&
        row.data.operation === "owned_child_notice",
    )
    .map((row) => ({
      eventId: row.id,
      seq: row.seq,
      createdAt: row.createdAt,
      scope: row.scope,
      operationId: row.data.operationId,
      status: row.data.status,
      metadata: row.data.metadata,
    }));
  const [thread, queue] = await Promise.all([
    sdk.threads.get({ threadId: report.originThreadId }),
    sdk.threads.queuedMessages.list({ threadId: report.originThreadId }),
  ]);
  assert.equal(thread.projectId, report.projectId);
  return {
    at: stamp(),
    threadId: report.originThreadId,
    status: thread.status,
    accepted,
    completed,
    passive,
    queuedMessageIds: queue.map((row) => row.id).sort(),
  };
}

function assertParentUnchanged(current) {
  assert.deepEqual(
    current.accepted,
    report.parentBaseline.accepted,
    "Worker notifications must not cause extra native parent input acceptance",
  );
  assert.deepEqual(
    current.completed,
    report.parentBaseline.completed,
    "The parent's native completed-event set must remain unchanged",
  );
  assert.deepEqual(
    current.queuedMessageIds,
    report.parentBaseline.queuedMessageIds,
    "Owner-controlled worker notices must not add automatic parent queued messages",
  );
  assert.equal(
    current.status,
    "idle",
    "The retained main conversation must remain idle",
  );
}

async function baselineParent() {
  report.parentBaseline = await parentEvidence();
  assert.equal(report.parentBaseline.status, "idle");
  await save();
}

async function screenshot(name) {
  if (!page) return;
  const path = resolve(artifactDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}

async function captureResponse(response) {
  if (response.status() >= 400)
    report.errors.push({
      type: "http",
      status: response.status(),
      url: response.url(),
      at: stamp(),
    });
  if (!response.url().includes("/rpc/getWorkspace") || !response.ok()) return;
  const body = await response.json();
  const view = workspaceViewSchema.parse(body?.result ?? body);
  const responseEpoch = requestEpochs.get(response.request());
  if (
    view.run.summary.runId !== observedRunId ||
    responseEpoch !== documentEpoch
  )
    return;
  latestWorkspace = view;
  report.workspaceResponses.push({
    at: stamp(),
    documentEpoch: responseEpoch,
    runId: view.run.summary.runId,
    state: view.run.workflow?.state,
    verification: view.run.verification,
    workers: view.workers,
    events: view.events,
    cursor: view.cursor,
    hasMoreEvents: view.hasMoreEvents,
  });
  if (report.workspaceResponses.length > 400) report.workspaceResponses.shift();
}

async function openBrowser() {
  const require = createRequire(
    resolve(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json",
    ),
  );
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  page.on("pageerror", (error) =>
    report.errors.push({
      type: "pageerror",
      message: error.message,
      at: stamp(),
    }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      report.errors.push({
        type: "console",
        message: message.text().slice(0, 1500),
        at: stamp(),
      });
  });
  page.on("response", (response) => {
    const task = captureResponse(response).catch((error) =>
      report.errors.push({
        type: "capture",
        message: error.message,
        url: response.url(),
        at: stamp(),
      }),
    );
    responseTasks.add(task);
    void task.finally(() => responseTasks.delete(task));
  });
  page.on("request", (request) => requestEpochs.set(request, documentEpoch));
  await page.addInitScript(() => {
    window.__arcWorkspaceDocument = crypto.randomUUID();
    window.__arcWorkspaceAnimations = [];
    const nativeAnimate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = Reflect.apply(nativeAnimate, this, args);
      const key = this.getAttribute("data-handoff");
      if (key) {
        const record = {
          key,
          at: Date.now(),
          document: window.__arcWorkspaceDocument,
          visibility: document.visibilityState,
          keyframes: args[0],
          options: args[1],
          finished: false,
          cancelled: false,
        };
        window.__arcWorkspaceAnimations.push(record);
        animation.finished.then(
          () => {
            record.finished = true;
          },
          () => {
            record.cancelled = true;
          },
        );
      }
      return animation;
    };
  });
  documentEpoch++;
  await page.goto(`${appUrl}/plugins/arc/workspace/${source.runId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .getByRole("heading", { name: "Workspace", exact: true })
    .waitFor({ timeout: 120_000 });
  await page
    .getByRole("region", {
      name: "Main orchestrator conversation",
      exact: true,
    })
    .waitFor({ timeout: 60_000 });
  await poll(
    "prewarmed actual Workspace response",
    45_000,
    async () => latestWorkspace?.run.summary.runId === source.runId,
  );
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
  report.prewarm = {
    sourceRunId: source.runId,
    at: stamp(),
    errors: report.errors.length,
  };
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
}

async function createAgentAndRequest() {
  const project = await sdk.projects.get({ projectId: source.projectId });
  const registered = project.sources.find(
    (item) => item.hostId === source.hostId,
  );
  assert(registered);
  assert.equal(
    await realpath(registered.path),
    await realpath(source.workspace),
  );
  const parent = await sdk.threads.get({ threadId: source.originThreadId });
  assert.equal(parent.projectId, project.id);
  assert.equal(
    parent.status,
    "idle",
    "The retained main conversation must be idle",
  );
  const host = (await sdk.hosts.list()).find(
    (item) => item.id === source.hostId,
  );
  assert.equal(host?.status, "connected");
  const catalog = await sdk.providers.models({
    hostId: source.hostId,
    providerId: "codex",
  });
  assert.equal(catalog.modelLoadError, null);
  const model = catalog.models.find((item) => item.model === report.model);
  assert(model, "The actual Codex catalog must advertise gpt-5.6-sol");
  report.execution = {
    providerId: "codex",
    model: report.model,
    reasoningLevel: model.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === "low",
    )
      ? "low"
      : model.defaultReasoningEffort,
    serviceTier: "default",
    permissionMode: "full",
  };
  const metadata = defaultAgentMetadata("Workspace native proof");
  metadata.description =
    "Neutral coding and review agent for the actual Workspace acceptance";
  metadata.role = "Assigned implementation or review";
  metadata.execution = report.execution;
  const body =
    "Read arc_run_snapshot before acting. Work only in the assigned detached worktree and follow this run's specific task. Do not create subagents, access credentials, inspect unrelated files or repositories, use public networking, install dependencies, commit, merge, push or deploy. ARC performs commits, checks and integration. For a writer assignment, create only the requested workspace-proof.txt file with exact UTF-8 contents and leave all pre-existing files unchanged. For a review assignment, inspect the exact candidate without editing, confirm the requested proof file and recorded required check, then submit your genuine verdict with arc_run_review and the actual candidate HEAD. Do not infer approval from conversation completion. There are no artificial waiting commands or planted pricing repairs in this assignment.";
  const scope = { kind: "project", projectId: project.id };
  let { agent } = await agentsRpc("createAgent", {
    scope,
    document: serializeAgentDocument(metadata, body),
  });
  report.agent = { agentId: agent.id, stage: "draft" };
  await save();
  ({ agent } = await agentsRpc("publishAgentRevision", {
    scope,
    agentId: agent.id,
    expectedDraftVersion: agent.draft.version,
  }));
  const { revision } = await agentsRpc("getAgentRevision", {
    scope,
    agentId: agent.id,
    revision: 1,
  });
  assert.equal(agent.currentRevision, 1);
  report.agent = {
    agentId: agent.id,
    revision: 1,
    contentHash: revision.contentHash,
  };
  const selected = { agentId: agent.id, revision: 1 };
  report.check = {
    executable: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync("workspace-proof.txt", "utf8"), "ARC_WORKSPACE_NATIVE_OK\\n"); console.log("ARC_WORKSPACE_CHECK_PASSED");',
    ],
    timeoutMs: 15_000,
  };
  report.request = {
    operationId: report.operations.start,
    projectId: source.projectId,
    originThreadId: source.originThreadId,
    hostId: source.hostId,
    path: source.workspace,
    expectedHead: source.original.head,
    goal: "Create only workspace-proof.txt containing ARC_WORKSPACE_NATIVE_OK followed by one LF newline, UTF-8 without a BOM. Preserve every existing file. The required check verifies exact contents. Review this specific file and exact integrated candidate; unrelated unfinished fixture app code is outside this assignment.",
    writers: [
      {
        agent: selected,
        task: "Create only workspace-proof.txt with exact UTF-8 text ARC_WORKSPACE_NATIVE_OK followed by one LF newline (no BOM, no CRLF). Keep all existing files unchanged. Use built-in local tools only. Do not commit; ARC owns commits and verification.",
      },
    ],
    reviewer: selected,
    repairer: selected,
    check: report.check,
  };
  report.requestHash = hash(JSON.stringify(report.request));
  await save();
}

async function snapshot() {
  const view = await runsRpc("getRun", { runId: report.runId });
  assert.equal(view.definition.request.operationId, report.operations.start);
  assert.equal(view.summary.projectId, report.projectId);
  assert.equal(view.summary.workflowRunId, report.workflowRunId);
  assert.equal(view.summary.planHash, report.planHash);
  const list = await runsRpc("listRunEffects", {
    runId: report.runId,
    offset: 0,
    limit: 100,
  });
  assert(list.total <= 100);
  report.effects = await Promise.all(
    list.effects.map((effect) =>
      runsRpc("getRunEffect", {
        runId: report.runId,
        effectId: effect.effectId,
      }),
    ),
  );
  report.latest = view;
  const key = JSON.stringify([
    view.workflow?.state,
    view.workflow?.agentCalls,
    list.effects.map((effect) => [effect.effectId, effect.state]),
  ]);
  if (key !== report.lastStateKey) {
    report.lastStateKey = key;
    report.history.push({
      at: stamp(),
      state: view.workflow?.state,
      agentCalls: view.workflow?.agentCalls,
      activeAgents: view.workflow?.activeAgents,
      effects: list.effects.map(
        ({ effectId, nodeId, iteration, attempt, state }) => ({
          effectId,
          nodeId,
          iteration,
          attempt,
          state,
        }),
      ),
    });
    console.log(
      JSON.stringify({
        stage: report.stage,
        state: view.workflow?.state,
        agentCalls: view.workflow?.agentCalls,
        effects: list.total,
      }),
    );
  }
  await save();
  return view;
}

async function startPaused() {
  report.stage = "starting";
  await save();
  const started = await runsRpc("startRun", report.request);
  report.runId = started.summary.runId;
  report.workflowRunId = started.summary.workflowRunId;
  report.planHash = started.summary.planHash;
  assert(started.workflow);
  report.pauseInput = {
    runId: report.runId,
    operationId: report.operations.pause,
    expectedVersion: started.workflow.controlVersion,
    action: "pause",
  };
  report.stage = "pausing";
  await save();
  await runsRpc("controlRun", report.pauseInput);
  await poll("durably paused Workspace run", 120_000, async () => {
    const view = await snapshot();
    if (["succeeded", "failed", "cancelled"].includes(view.workflow.state))
      throw new Error(`Unexpected pause outcome ${view.workflow.state}`);
    return view.workflow.state === "paused";
  });
  assert.equal(report.latest.workflow.activeAgents, 0);
  assert.equal(
    report.latest.workflow.agentCalls,
    0,
    "No provider turn may be admitted before the browser baseline",
  );
  report.pauseReceipt = report.latest.workflow;
  report.stage = "browser-baseline";
  await save();
  observedRunId = report.runId;
  latestWorkspace = null;
  documentEpoch++;
  await page.goto(`${appUrl}/plugins/arc/workspace/${report.runId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .getByRole("heading", { name: "Workspace", exact: true })
    .waitFor({ timeout: 60_000 });
  await page
    .getByRole("region", {
      name: "Main orchestrator conversation",
      exact: true,
    })
    .waitFor({ timeout: 60_000 });
  await poll(
    "paused browser Workspace baseline",
    60_000,
    async () =>
      latestWorkspace?.run.summary.runId === report.runId &&
      latestWorkspace.run.workflow?.state === "paused",
  );
  assert.equal(latestWorkspace.events.length, 0);
  report.baseline = await page.evaluate(() => ({
    document: window.__arcWorkspaceDocument,
    animations: window.__arcWorkspaceAnimations,
    visibility: document.visibilityState,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  assert.equal(report.baseline.visibility, "visible");
  assert.equal(report.baseline.reducedMotion, false);
  assert.deepEqual(report.baseline.animations, []);
  await screenshot("paused-baseline-1920");
  report.parentPaused = await parentEvidence();
  assertParentUnchanged(report.parentPaused);
  await assertOriginal();
}

async function resumeAndObserve() {
  const current = await runsRpc("getRun", { runId: report.runId });
  assert.equal(current.workflow.state, "paused");
  report.resumeInput = {
    runId: report.runId,
    operationId: report.operations.resume,
    expectedVersion: current.workflow.controlVersion,
    action: "resume",
  };
  report.stage = "observing-live-handoffs";
  await save();
  await runsRpc("controlRun", report.resumeInput);
  await poll(
    "actual completed two-turn Workspace run",
    10 * 60_000,
    async () => {
      const view = await snapshot();
      if (["failed", "cancelled"].includes(view.workflow.state))
        throw new Error(`Run ${view.workflow.state}: ${view.workflow.error}`);
      if (view.workflow.agentCalls > 2)
        throw new Error(
          "This bounded run admitted more than the intended writer and reviewer",
        );
      if (
        report.effects.some(
          (effect) =>
            effect.effect.nodeId === "check" &&
            effect.observation?.state === "failed",
        )
      )
        throw new Error(
          "The exact proof check failed; preserve evidence and stop this owned run",
        );
      return view.workflow.state === "succeeded";
    },
  );
  await poll(
    "browser's completed Workspace projection",
    45_000,
    async () =>
      latestWorkspace?.run.workflow?.state === "succeeded" &&
      latestWorkspace.run.verification.state === "current",
  );
  await page.waitForTimeout(1000);
  report.animations = await page.evaluate(
    () => window.__arcWorkspaceAnimations,
  );
  assert.equal(
    await page.evaluate(() => window.__arcWorkspaceDocument),
    report.baseline.document,
  );
  assert.equal(report.latest.workflow.agentCalls, 2);
  assert.equal(report.latest.workflow.activeAgents, 0);
  assert.deepEqual(report.latest.workflow.repairRounds, []);
  const workers = report.effects.filter(
    (effect) => effect.observation?.receipt?.kind === "agent",
  );
  assert.equal(workers.length, 2);
  const keys = [];
  for (const item of workers) {
    const receipt = runtimeReceiptSchema.parse(item.observation.receipt);
    assert.equal(receipt.kind, "agent");
    assert.equal(receipt.terminalStatus, "completed");
    const rows = await sdk.threads.events.list({
      threadId: receipt.threadId,
      order: "asc",
      limit: "1000",
    });
    assert(
      rows.length < 1000,
      "Keep this acceptance's transcript bounded and complete",
    );
    const accepted = rows.find(
      (row) =>
        row.type === "turn/input/accepted" &&
        row.data.clientRequestId === receipt.turnRequestId &&
        row.scope.kind === "turn",
    );
    assert(accepted);
    const completed = rows.find(
      (row) =>
        row.id === receipt.terminalEventId &&
        row.type === "turn/completed" &&
        row.scope.kind === "turn" &&
        row.scope.turnId === accepted.scope.turnId &&
        row.data.status === "completed",
    );
    assert(completed);
    const key = `${item.effect.effectId}:native-accepted:${receipt.turnRequestId}`;
    keys.push(key);
    const animation = report.animations.filter((value) => value.key === key);
    assert.equal(
      animation.length,
      1,
      `Exactly one actual Element.animate handoff is required for ${item.effect.nodeId}`,
    );
    assert.equal(animation[0].document, report.baseline.document);
    assert.equal(animation[0].visibility, "visible");
    assert(animation[0].at >= accepted.createdAt);
    assert.equal(animation[0].options.duration, 650);
    assert.equal(animation[0].finished, true);
    assert.equal(animation[0].cancelled, false);
    assert(
      animation[0].keyframes.some(
        (frame) =>
          typeof frame.transform === "string" &&
          frame.transform.startsWith("translate(") &&
          frame.transform !== "translate(0, 0)",
      ),
    );
    assert(
      report.workspaceResponses.some(
        (response) =>
          response.runId === report.runId &&
          response.events.some(
            (event) =>
              event.key === key && event.milestone === "native-accepted",
          ),
      ),
    );
    const filename = `${item.effect.nodeId}-transcript.json`;
    const serialized = JSON.stringify(rows, null, 2);
    assert(Buffer.byteLength(serialized) <= 2 * 1024 * 1024);
    await writeFile(resolve(artifactDir, filename), serialized, "utf8");
    report.transcripts[receipt.threadId] = {
      file: filename,
      count: rows.length,
      accepted,
      completed,
      dispatchKey: key,
    };
    if (item.effect.nodeId === "review") {
      const verdict = rows.find(
        (row) =>
          row.type === "item/completed" &&
          row.data.item.type === "toolCall" &&
          row.data.item.tool === "arc_run_review" &&
          row.data.item.status === "completed",
      );
      assert(verdict, "An actual completed review tool call is required");
      assert.equal(receipt.review?.outcome, "approved");
      assert.equal(
        receipt.review.candidateHead,
        report.latest.verification.head,
      );
      report.review = {
        threadId: receipt.threadId,
        eventId: verdict.id,
        receipt,
      };
    }
  }
  assert.equal(
    report.animations.length,
    2,
    "No unrelated or repeated handoff animation is allowed",
  );
  report.handoffKeys = keys;
  const check = report.effects.find(
    (item) => item.effect.nodeId === "check" && item.effect.iteration === 0,
  );
  assert.equal(check.observation.state, "succeeded");
  const checked = runtimeReceiptSchema.parse(check.observation.receipt);
  assert.equal(checked.kind, "native");
  const checkProcess = checked.receipt.processes.find(
    (value) =>
      value.executable === report.check.executable &&
      JSON.stringify(value.args) === JSON.stringify(report.check.args),
  );
  assert.equal(checkProcess?.exitCode, 0);
  assert(checkProcess.stdout.includes("ARC_WORKSPACE_CHECK_PASSED"));
  const verify = report.effects.find(
    (item) =>
      item.effect.nodeId === "verify" &&
      item.observation?.state === "succeeded",
  );
  const verified = runtimeReceiptSchema.parse(verify.observation.receipt);
  assert.equal(verified.kind, "native");
  for (const state of [
    checked.receipt.before,
    checked.receipt.after,
    report.review.receipt.workspace,
    verified.receipt.after,
  ]) {
    assert.equal(state.head, report.latest.verification.head);
    assert.equal(state.stateDigest, verified.receipt.after.stateDigest);
  }
  const integrated = report.latest.verification.workspacePath;
  assert.equal(
    git(integrated, "rev-parse", "HEAD"),
    report.latest.verification.head,
  );
  assert.equal(
    git(integrated, "status", "--porcelain=v1", "--untracked-files=all"),
    "",
  );
  assert.equal(
    await readFile(resolve(integrated, "workspace-proof.txt"), "utf8"),
    "ARC_WORKSPACE_NATIVE_OK\n",
  );
  assert.deepEqual(
    git(integrated, "diff", "--name-only", source.original.head, "HEAD")
      .split(/\r?\n/)
      .filter(Boolean),
    ["workspace-proof.txt"],
  );
  await assertOriginal();
  assert.equal(hash(JSON.stringify(report.request)), report.requestHash);
  await screenshot("completed-live-handoffs-1920");
  await save();
}

async function verifyReload() {
  report.stage = "reload-verification";
  await save();
  latestWorkspace = null;
  documentEpoch++;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .getByRole("region", {
      name: "Main orchestrator conversation",
      exact: true,
    })
    .waitFor({ timeout: 60_000 });
  await poll(
    "retained completed Workspace after reload",
    60_000,
    async () =>
      latestWorkspace?.run.workflow?.state === "succeeded" &&
      latestWorkspace.run.verification.state === "current",
  );
  await page.waitForTimeout(7000);
  report.reload = await page.evaluate(() => ({
    document: window.__arcWorkspaceDocument,
    animations: window.__arcWorkspaceAnimations,
    visibility: document.visibilityState,
  }));
  assert.notEqual(report.reload.document, report.baseline.document);
  assert.equal(report.reload.visibility, "visible");
  assert.deepEqual(report.reload.animations, []);
  const reloadResponses = report.workspaceResponses.filter(
    (item) => item.documentEpoch === documentEpoch,
  );
  assert(reloadResponses.length >= 2);
  assert(reloadResponses.every((item) => item.events.length === 0));
  assert.deepEqual(
    latestWorkspace.workers.map((worker) => worker.dispatchKey).sort(),
    [...report.handoffKeys].sort(),
  );
  assert.equal(
    latestWorkspace.run.verification.head,
    report.latest.verification.head,
  );
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  await screenshot("completed-reloaded-no-handoffs-1920");
  await assertOriginal();
}

async function verifyPassiveParent() {
  report.stage = "parent-notification-verification";
  await save();
  const childThreadIds = Object.keys(report.transcripts);
  assert.equal(childThreadIds.length, 2);
  const baselineIds = new Set(
    report.parentBaseline.passive.map((event) => event.eventId),
  );
  const completedNotices = (evidence) =>
    evidence.passive.filter(
      (event) =>
        !baselineIds.has(event.eventId) &&
        event.status === "completed" &&
        event.scope.kind === "thread" &&
        event.metadata?.delivery === "owner-controlled" &&
        event.metadata?.kind === "child-completed" &&
        Array.isArray(event.metadata.children) &&
        event.metadata.children.some(
          (child) =>
            child !== null &&
            typeof child === "object" &&
            child.ownerPluginId === "arc" &&
            childThreadIds.includes(child.childThreadId),
        ),
    );
  await poll(
    "recorded passive completion notices for both owned workers",
    30_000,
    async () => {
      report.parentAfter = await parentEvidence();
      assertParentUnchanged(report.parentAfter);
      const notices = completedNotices(report.parentAfter);
      return childThreadIds.every((threadId) =>
        notices.some((notice) =>
          notice.metadata.children.some(
            (child) =>
              child?.childThreadId === threadId &&
              child.ownerPluginId === "arc",
          ),
        ),
      );
    },
  );
  report.parentDrain = [];
  for (let interval = 0; interval < 3; interval++) {
    await delay(2000);
    const evidence = await parentEvidence();
    report.parentDrain.push(evidence);
    assertParentUnchanged(evidence);
    report.parentAfter = evidence;
  }
  const notices = completedNotices(report.parentAfter);
  assert.equal(
    notices.length,
    2,
    "Each worker completion must create one passive notice",
  );
  assert.equal(new Set(notices.map((event) => event.operationId)).size, 2);
  report.parentPolicy = {
    baselineAcceptedCount: report.parentBaseline.accepted.length,
    finalAcceptedCount: report.parentAfter.accepted.length,
    baselineCompletedCount: report.parentBaseline.completed.length,
    finalCompletedCount: report.parentAfter.completed.length,
    extraNativeParentTurns: 0,
    drainIntervals: 3,
    drainIntervalMs: 2000,
    passiveNotices: notices,
  };
  await save();
}

async function cancelOwnedRun() {
  if (!report.runId && report.request) {
    const page = await runsRpc("listRuns", {
      projectId: report.projectId,
      limit: 100,
      offset: 0,
    });
    for (const candidate of page.runs) {
      const view = await runsRpc("getRun", { runId: candidate.runId });
      if (view.definition.request.operationId === report.operations.start) {
        report.runId = candidate.runId;
        report.workflowRunId = candidate.workflowRunId;
        break;
      }
    }
  }
  if (!report.runId) return;
  const view = await runsRpc("getRun", { runId: report.runId });
  assert.equal(view.summary.projectId, report.projectId);
  assert.equal(view.definition.request.operationId, report.operations.start);
  if (
    !view.workflow ||
    ["succeeded", "failed", "cancelled"].includes(view.workflow.state)
  ) {
    report.cleanup = {
      cancellationSent: false,
      state: view.workflow?.state ?? "unsubmitted",
    };
    return;
  }
  report.cancelInput = {
    runId: report.runId,
    operationId: report.operations.cancel,
    expectedVersion: view.workflow.controlVersion,
    action: "cancel",
  };
  await save();
  await runsRpc("controlRun", report.cancelInput);
  const deadline = Date.now() + 30_000;
  let last = view;
  while (Date.now() < deadline) {
    last = await runsRpc("getRun", { runId: report.runId });
    if (["succeeded", "failed", "cancelled"].includes(last.workflow?.state))
      break;
    await delay(500);
  }
  report.cleanup = {
    cancellationSent: true,
    state: last.workflow?.state,
    activeAgents: last.workflow?.activeAgents,
  };
}

try {
  await save();
  await assertOriginal();
  await openBrowser();
  await createAgentAndRequest();
  await baselineParent();
  await startPaused();
  await resumeAndObserve();
  await verifyReload();
  await verifyPassiveParent();
  report.passed = true;
  report.stage = "passed";
  report.finishedAt = stamp();
} catch (error) {
  report.failedStage = report.stage;
  report.stage = "failed";
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.failedAt = stamp();
  await save();
  try {
    await cancelOwnedRun();
  } catch (cleanupError) {
    report.cleanup = { error: cleanupError.message };
  }
  try {
    await screenshot("failure");
  } catch (screenshotError) {
    report.screenshotFailure = screenshotError.message;
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await Promise.allSettled([...responseTasks]);
  if (browser) await browser.close();
  await save();
  console.log(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      runId: report.runId,
      reportPath,
      failure: report.failure ?? null,
    }),
  );
}

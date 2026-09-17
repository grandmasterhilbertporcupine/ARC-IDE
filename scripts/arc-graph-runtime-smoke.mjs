import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createNodeBbSdk } from "../packages/sdk/src/node.ts";
import {
  resolveDataDirDatabasePath,
  resolveRuntimeDataDir,
} from "../packages/config/src/runtime.ts";
import { arcAgentsRpcContract } from "../plugins/arc/contract.ts";
import {
  defaultAgentMetadata,
  serializeAgentDocument,
} from "../plugins/arc/document.ts";
import { arcRunsRpcContract } from "../plugins/arc/runtime/contract.ts";
import { runtimeReceiptSchema } from "../plugins/arc/runtime/receipt.ts";
import { compileArcGraphRun } from "../plugins/arc/runtime/graph-compiler.ts";
import { compileArcOrchestratedRun } from "../plugins/arc/runtime/orchestrated-compiler.ts";
import { orchestratorReceiptSchema } from "../plugins/arc/runtime/orchestrated-receipt.ts";
import { runtimeHash } from "../plugins/arc/runtime/hash.ts";
import { runtimeNodeKey } from "../plugins/arc/runtime/compiler.ts";
import { arcWorkspaceRpcContract } from "../plugins/arc/workspace/contract.ts";
import { arcTeamsRpcContract } from "../plugins/arc/teams/contract.ts";
import {
  arcPolicyRpcContract,
  defaultRunPolicy,
} from "../plugins/arc/policy/contract.ts";

const [requestedMode, argument, overrideUrl] = process.argv.slice(2);
const orchestrated = requestedMode?.startsWith("orchestrator-") ?? false;
const mode = orchestrated
  ? requestedMode.slice("orchestrator-".length)
  : requestedMode;
const harnessIdentity = orchestrated
  ? "ARC_GRAPH_RUNTIME_SMOKE_V3"
  : "ARC_GRAPH_RUNTIME_SMOKE_V2";
const expectedAgentCalls = orchestrated ? 5 : 4;
if (mode === "--help" || mode === "help") {
  console.log(
    "Usage: node --conditions=source --import tsx scripts/arc-graph-runtime-smoke.mjs start-pause [http://127.0.0.1:20008]\n       node --conditions=source --import tsx scripts/arc-graph-runtime-smoke.mjs resume <report-path> [http://127.0.0.1:20008]\nThe first command exits only after an actual owned run is durably paused. Restart the same ARC server/daemon/profile before running resume. This harness does not start services or delete fixtures.",
  );
  console.log(
    "Use orchestrator-start-pause and orchestrator-resume for V3 main-tool admission and its counted completion. V2 modes retain their original assertions.",
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
const artifactRoot = resolve(
  ".arc-verification",
  orchestrated ? "orchestrator-runtime" : "graph-runtime",
);
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
const newId = (purpose) => `arc-graph-${purpose}-${randomUUID()}`;
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
  assert.equal(report.harness, harnessIdentity);
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
    harness: harnessIdentity,
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
const teamsRpc = (method, input) => rpc(arcTeamsRpcContract, method, input);
const policyRpc = (method, input) => rpc(arcPolicyRpcContract, method, input);
let browser;
let page;
let workspacePage;
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
  return `You are a real ARC graph execution acceptance agent in one disposable local Git fixture. Read arc_run_snapshot first. Work only in the assigned worktree. Do not inspect credentials, accounts, environment variables or unrelated files/repositories. Do not install dependencies, access the public network, create subagents, commit, merge, push or deploy. Do not change required-check configuration.\n\nWhen assigned a writer task, edit only its named source file and leave the existing shared/pricing.mjs defect untouched. Complete the assigned implementation.\n\nWhen assigned repair, diagnose the actual failed check from arc_run_snapshot. Preserve both writers' work and fix shared/pricing.mjs so totalPrice(quantity) returns exactly quantity * 100. Verify with built-in Node only.\n\nWhen assigned review, do not edit any files. Inspect the exact candidate, confirm frontend, backend and pricing behavior, and use arc_run_review with the actual candidate HEAD and your genuine approved or changes-requested verdict. Completing chat without this tool is not approval. Do not invent checks, native output or verdict receipts.`;
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
  const legacy = report.request;
  const edge = (
    source,
    target,
    requiredOutcome = "succeeded",
    sourceHandle = "next",
  ) => ({
    id: `${source}-${sourceHandle}-${target}`,
    source,
    target,
    requiredOutcome,
    sourceHandle,
  });
  const candidate = (nodeId) => ({ kind: "node", nodeId });
  const definition = {
    schemaVersion: 1,
    name: "Native graph · build, repair and verify",
    description:
      "Actual published parallel frontend/backend graph with a planted check failure and one bounded repair.",
    groups: [
      { id: "blue", name: "Frontend", color: "#4c8ce8", parentGroupId: null },
      {
        id: "red",
        name: "Backend and repair",
        color: "#d55e68",
        parentGroupId: null,
      },
      { id: "white", name: "Review", color: "#d7e1e8", parentGroupId: null },
    ],
    members: [
      { id: "frontend", ...selection(frontend), groupId: "blue" },
      { id: "backend", ...selection(backend), groupId: "red" },
      { id: "reviewer", ...selection(frontend), groupId: "white" },
    ],
    permissions: [
      {
        id: "review-frontend",
        fromMemberId: "reviewer",
        toMemberId: "frontend",
        action: "review",
      },
      {
        id: "review-backend",
        fromMemberId: "reviewer",
        toMemberId: "backend",
        action: "review",
      },
    ],
    graph: {
      entryNodeIds: ["parallel"],
      nodes: [
        { id: "parallel", label: "Build in parallel", kind: "parallel" },
        ...legacy.writers.map((writer, index) => ({
          id: index === 0 ? "frontend" : "backend",
          label: index === 0 ? "Frontend" : "Backend",
          kind: "agent",
          memberId: index === 0 ? "frontend" : "backend",
          access: "write",
          candidate: { kind: "source" },
          task: writer.task,
        })),
        {
          id: "join",
          label: "Both writers complete",
          kind: "join",
          mode: "all",
          decisionNodeId: null,
        },
        {
          id: "integrate",
          label: "Integrate both candidates",
          kind: "integration",
          writerNodeIds: ["frontend", "backend"],
          baseCandidate: { kind: "source" },
        },
        {
          id: "check",
          label: "Required app check",
          kind: "check",
          candidate: candidate("integrate"),
          command: report.check,
        },
        {
          id: "repair",
          label: "Repair and recheck",
          kind: "repair",
          body: {
            memberId: "backend",
            task: "Use the actual failed-check evidence to repair only shared/pricing.mjs. Preserve both writer files and make totalPrice(quantity) return exactly quantity * 100. Do not modify the check.",
          },
          checkNodeId: "check",
          maxRounds: 1,
        },
        {
          id: "final-check",
          label: "Check final candidate",
          kind: "check",
          candidate: candidate("repair"),
          command: report.check,
        },
        {
          id: "review",
          label: "Review final candidate",
          kind: "review",
          memberId: "reviewer",
          candidate: candidate("repair"),
          task: "Inspect the exact checked candidate and confirm frontend, backend and pricing behavior. Do not change files. Record an honest explicit arc_run_review verdict using the actual candidate HEAD.",
        },
      ],
      edges: [
        edge("parallel", "frontend"),
        edge("parallel", "backend"),
        edge("frontend", "join"),
        edge("backend", "join"),
        edge("join", "integrate"),
        edge("integrate", "check"),
        edge("check", "repair", "failed"),
        edge("repair", "final-check", "succeeded", "repaired"),
        edge("final-check", "review"),
      ],
      requiredGates: [
        {
          id: "final-verification",
          mode: "all",
          nodeIds: ["final-check", "review"],
        },
      ],
    },
    presentation: {
      groups: [],
      nodes: [
        { nodeId: "parallel", x: 0, y: 180 },
        { nodeId: "frontend", x: 300, y: 60 },
        { nodeId: "backend", x: 300, y: 300 },
        { nodeId: "join", x: 600, y: 180 },
        { nodeId: "integrate", x: 900, y: 180 },
        { nodeId: "check", x: 1200, y: 180 },
        { nodeId: "repair", x: 1500, y: 180 },
        { nodeId: "final-check", x: 1800, y: 180 },
        { nodeId: "review", x: 2100, y: 180 },
      ],
    },
  };
  let { team } = await teamsRpc("createTeam", { scope, definition });
  ({ team } = await teamsRpc("publishTeamRevision", {
    scope,
    teamId: team.id,
    expectedDraftVersion: team.draft.version,
  }));
  report.team = { teamId: team.id, revision: team.currentRevision };
  if (orchestrated) {
    ({ team } = await teamsRpc("saveTeamDraft", {
      scope,
      teamId: team.id,
      expectedDraftVersion: team.draft.version,
      definition: {
        ...definition,
        description:
          "A newer published revision exists; the exact preferred first version remains the selected acceptance plan.",
      },
    }));
    ({ team } = await teamsRpc("publishTeamRevision", {
      scope,
      teamId: team.id,
      expectedDraftVersion: team.draft.version,
    }));
    assert.equal(team.currentRevision, 2);
    report.latestTeamRevision = 2;
  }
  const policy = await policyRpc("saveProjectPolicy", {
    projectId: project.id,
    expectedVersion: 0,
    policy: {
      ...defaultRunPolicy(),
      autonomy: "collaborative",
      preferredTeams: [report.team],
      restrictedTeams: [report.team],
      limits: {
        maxConcurrentAgents: 2,
        maxAgentCalls: expectedAgentCalls,
        maxRepairRounds: 1,
        maxActiveMs: 1200000,
      },
    },
  });
  report.request = {
    operationId: legacy.operationId,
    projectId: legacy.projectId,
    originThreadId: legacy.originThreadId,
    hostId: legacy.hostId,
    path: legacy.path,
    expectedHead: legacy.expectedHead,
    goal: legacy.goal,
    team: report.team,
    expectedProjectPolicyVersion: policy.version,
    expectedSessionPolicyVersion: 0,
  };
  report.requestHash = hash(JSON.stringify(report.request));
  await captureThread(report.originThreadId);
  report.parentBaseline = structuredClone(
    report.transcripts[report.originThreadId],
  );
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
      requested: [],
      accepted: [],
      started: [],
      completed: [],
      tools: [],
      passive: [],
      provisioning: [],
    };
  }
  transcript.requested ??= [];
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
      if (row.type === "client/turn/requested")
        transcript.requested.push({
          id: row.id,
          seq: row.seq,
          requestId: row.data.requestId,
          createdAt: row.createdAt,
          source: row.data.source,
          initiator: row.data.initiator,
          senderThreadId: row.data.senderThreadId,
          inputHash: runtimeHash(row.data.input),
          execution: row.data.execution,
          target: row.data.target,
        });
      if (row.type === "turn/input/accepted")
        transcript.accepted.push({
          id: row.id,
          seq: row.seq,
          clientRequestId: row.data.clientRequestId,
          providerThreadId: row.data.providerThreadId,
          createdAt: row.createdAt,
          scope: row.scope,
        });
      if (row.type === "turn/started")
        transcript.started.push({
          id: row.id,
          seq: row.seq,
          providerThreadId: row.data.providerThreadId,
          createdAt: row.createdAt,
          scope: row.scope,
        });
      if (row.type === "turn/completed")
        transcript.completed.push({
          id: row.id,
          seq: row.seq,
          status: row.data.status,
          providerThreadId: row.data.providerThreadId,
          createdAt: row.createdAt,
          scope: row.scope,
        });
      if (row.type === "system/thread-provisioning")
        (transcript.provisioning ??= []).push({
          id: row.id,
          seq: row.seq,
          createdAt: row.createdAt,
          ...row.data,
        });
      if (row.type === "item/completed" && row.data.item.type === "toolCall")
        transcript.tools.push({
          id: row.id,
          seq: row.seq,
          itemId: row.data.item.id,
          scope: row.scope,
          providerThreadId: row.data.providerThreadId,
          tool: row.data.item.tool,
          status: row.data.item.status,
          item: JSON.stringify(row.data.item).slice(0, 12_000),
        });
      if (
        row.type === "system/operation" &&
        row.data.operation === "owned_child_notice"
      )
        transcript.passive.push({ id: row.id, scope: row.scope, ...row.data });
      for (const key of [
        "requested",
        "accepted",
        "started",
        "completed",
        "tools",
      ])
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
    ...new Set([
      report.originThreadId,
      ...new Set(
        listed.flatMap((effect) =>
          effect.resource?.kind === "agent" ? [effect.resource.threadId] : [],
        ),
      ),
    ]),
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

async function pendingPlan() {
  const listed = await runsRpc("listRunControls", {
    runId: report.runId,
    limit: 100,
    offset: 0,
  });
  assert(listed.total <= 100);
  report.controls = listed.controls;
  const plans = listed.controls.filter(
    (control) =>
      control.context.operation.type === "approval" &&
      control.context.candidate === null,
  );
  assert(
    plans.length <= 1,
    "Exactly one Collaborative plan decision may be allocated",
  );
  return plans[0] ?? null;
}

function assertNoWork(view, control, { allowUnobservedPlan = false } = {}) {
  assert.equal(
    view.workflow.agentCalls,
    0,
    "Plan approval must precede every agent admission",
  );
  assert.equal(view.workflow.activeAgents, 0);
  assert.equal(
    report.effects.length,
    1,
    "No native source/worktree effect may start before plan approval",
  );
  const { effect, observation } = report.effects[0];
  assert.equal(effect.nodeId, "arcg_plan_approval");
  assert.equal(effect.iteration, 0);
  assert.equal(effect.attempt, 1);
  assert(
    control,
    "The sealed plan decision must exist independently of observation state",
  );
  assert.equal(control.controlId, effect.effectId);
  assert.equal(control.effectId, effect.effectId);
  assert.equal(control.runId, view.summary.runId);
  assert.equal(control.state, "pending");
  assert.equal(control.decision, null);
  assert.equal(control.operationId, null);
  assert.equal(control.contextHash, runtimeHash(control.context));
  assert.equal(control.context.runId, view.summary.runId);
  assert.equal(control.context.effectId, effect.effectId);
  assert.equal(control.context.nodeId, effect.nodeId);
  assert.equal(control.context.iteration, effect.iteration);
  assert.equal(control.context.planHash, view.summary.planHash);
  assert.equal(control.context.planHash, view.workflow.planHash);
  assert.equal(control.context.policyHash, runtimeHash(view.definition.policy));
  assert.equal(
    control.context.teamContentHash,
    view.definition.team.contentHash,
  );
  assert.equal(control.context.candidate, null);
  assert.deepEqual(control.context.dependencyReceipts, []);
  const compiled =
    view.definition.schemaVersion === 3
      ? compileArcOrchestratedRun(view.definition)
      : compileArcGraphRun(view.definition);
  assert.equal(compiled.workflow.planHash, view.summary.planHash);
  const node = compiled.nodes[runtimeNodeKey(effect)];
  assert.equal(node.kind, "control");
  assert.equal(node.operation.type, "approval");
  assert.equal(node.operation.candidate, null);
  assert.deepEqual(control.context.operation, node.operation);
  if (effect.resource === null) {
    assert(
      allowUnobservedPlan,
      "Initial and resumed approval must have an observed owner-control resource",
    );
    assert.equal(effect.state, "needs-reconciliation");
    assert.equal(observation?.state, "needs-reconciliation");
    assert(
      !("receipt" in observation),
      "An interrupted observation is not a native receipt",
    );
    return false;
  }
  assert.deepEqual(effect.resource, {
    kind: "owner-control",
    controlId: control.controlId,
  });
  return true;
}

function executionTuple(providerId, execution) {
  return {
    providerId,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
    permissionMode: execution.permissionMode,
  };
}

function nativeRequestChain(transcript, requestId) {
  const requests = transcript.requested.filter(
    (event) => event.requestId === requestId,
  );
  assert.equal(requests.length, 1, "One exact persisted request is required");
  const requested = requests[0];
  const acceptedEvents = transcript.accepted.filter(
    (event) => event.clientRequestId === requestId,
  );
  assert(
    acceptedEvents.length <= 1,
    "A request cannot have ambiguous native acceptance",
  );
  const accepted = acceptedEvents[0];
  if (!accepted)
    return { requested, accepted: null, started: null, completed: null };
  assert.equal(accepted.scope.kind, "turn");
  assert(accepted.scope.turnId && accepted.providerThreadId);
  const startedEvents = transcript.started.filter(
    (event) => event.scope.turnId === accepted.scope.turnId,
  );
  const completedEvents = transcript.completed.filter(
    (event) => event.scope.turnId === accepted.scope.turnId,
  );
  assert(startedEvents.length <= 1 && completedEvents.length <= 1);
  const started = startedEvents[0] ?? null;
  const completed = completedEvents[0] ?? null;
  assert(requested.seq < accepted.seq);
  for (const event of [started, completed]) {
    if (!event) continue;
    assert.equal(event.providerThreadId, accepted.providerThreadId);
    assert.equal(event.scope.kind, "turn");
    assert(requested.seq < event.seq);
  }
  if (completed) {
    assert(started, "Native completion needs the matching native start");
    assert(completed.seq > accepted.seq && completed.seq > started.seq);
  }
  return { requested, accepted, started, completed };
}

function mainRequestProof(transcript, intent) {
  const requests = transcript.requested.filter(
    (event) => event.seq > intent.baselineCursor,
  );
  assert(
    requests.length <= 1,
    "The owned initial send must not be mixed with another request",
  );
  if (requests.length === 0) return null;
  const requested = requests[0];
  assert.equal(requested.inputHash, intent.inputHash);
  assert.equal(requested.initiator, "user");
  assert.equal(requested.senderThreadId, null);
  assert.equal(requested.execution.source, "client/turn/requested");
  assert.deepEqual(
    executionTuple(intent.providerId, requested.execution),
    intent.execution,
  );
  return nativeRequestChain(transcript, requested.requestId);
}

function assertMainRunOwnership(
  view,
  intent,
  proof,
  tools,
  requireSuccessfulTool = true,
) {
  assert.equal(view.definition.schemaVersion, 3);
  assert.equal(view.summary.projectId, intent.projectId);
  const request = view.definition.request;
  const { operationId: _initialOperationId, ...expected } = intent.runRequest;
  const { operationId, invocation, ...actual } = request;
  assert.deepEqual(
    actual,
    expected,
    "The admitted run must match the immutable pre-send request",
  );
  assert(invocation && proof.accepted && proof.started);
  assert.equal(invocation.providerThreadId, proof.accepted.providerThreadId);
  assert.equal(invocation.turnId, proof.accepted.scope.turnId);
  assert.equal(proof.started.providerThreadId, invocation.providerThreadId);
  const matching = tools.filter(
    (tool) =>
      tool.tool === "arc_team_run_request" &&
      tool.itemId === invocation.callId &&
      tool.scope?.turnId === invocation.turnId &&
      tool.providerThreadId === invocation.providerThreadId,
  );
  assert.equal(
    matching.length,
    1,
    "Run admission needs its exact native tool item",
  );
  if (requireSuccessfulTool) assert.equal(matching[0].status, "completed");
  assert(matching[0].seq > proof.accepted.seq);
  if (proof.completed) assert(matching[0].seq < proof.completed.seq);
  assert.equal(
    operationId,
    `main_${runtimeHash({ projectId: intent.projectId, originThreadId: intent.threadId, invocation: { providerThreadId: invocation.providerThreadId, turnId: invocation.turnId, callId: invocation.callId } })}`,
  );
  assert.deepEqual(view.definition.completion.execution, intent.execution);
  assert.equal(view.definition.completion.threadId, intent.threadId);
  assert.equal(
    view.definition.completion.environment.environmentId,
    intent.environmentId,
  );
  assert.equal(
    view.definition.completion.environment.hostId,
    intent.runRequest.hostId,
  );
  assert.equal(
    view.definition.completion.environment.path,
    intent.runRequest.path,
  );
  return matching[0];
}

async function requestFromMainConversation() {
  report.mainRequestTransport =
    "SDK threads.send into the actual main conversation";
  report.mainRequestPrompt = `Now request actual team work for this disposable project. Use arc_orchestration_context first. Its exact preferred team version is the configured choice even if a newer published revision exists. Use arc_team_run_request exactly once with that preferred team, the returned source and policy versions, and this exact goal: ${report.request.goal}\nDo not implement, edit files, call shell/network tools, spawn threads, modify policy or approve controls yourself. After the tool records the run, briefly report the run and its required approval, then finish this turn. The user will inspect and approve the real Workspace control. Do not poll or start another run. If admission fails, explain the real error and finish without creating replacement work.`;
  await captureThread(report.originThreadId);
  report.seedParentBaseline = structuredClone(
    report.transcripts[report.originThreadId],
  );
  const parentBefore = await sdk.threads.get({
    threadId: report.originThreadId,
  });
  const queueBefore = await sdk.threads.queuedMessages.list({
    threadId: report.originThreadId,
  });
  const runsBefore = await runsRpc("listRuns", {
    projectId: report.projectId,
    limit: 10,
    offset: 0,
  });
  assert.equal(parentBefore.projectId, report.projectId);
  assert.equal(parentBefore.providerId, report.execution.providerId);
  assert.equal(parentBefore.status, "idle");
  assert.deepEqual(queueBefore, []);
  assert.deepEqual(runsBefore.runs, []);
  const { providerId: _providerId, ...sendExecution } = report.execution;
  const sendInput = {
    threadId: report.originThreadId,
    mode: "start",
    input: [{ type: "text", text: report.mainRequestPrompt, mentions: [] }],
    ...sendExecution,
  };
  report.mainSendIntent = {
    id: newId("main-send-intent"),
    savedAt: stamp(),
    state: "prepared",
    projectId: report.projectId,
    threadId: report.originThreadId,
    environmentId: parentBefore.environmentId,
    providerId: parentBefore.providerId,
    execution: structuredClone(report.execution),
    inputHash: runtimeHash(sendInput.input),
    sendInput,
    baselineCursor: report.seedParentBaseline.cursor,
    baseline: structuredClone(report.seedParentBaseline),
    queuedBefore: queueBefore,
    runIdsBefore: runsBefore.runs.map((run) => run.runId),
    runRequest: structuredClone(report.request),
    parentBefore,
  };
  await save();
  report.mainSendIntent.state = "sending";
  await save();
  report.mainSend = await sdk.threads.send(sendInput);
  report.mainSendIntent.state = "replied";
  await save();
  assert.equal(
    report.mainSend.delivery,
    "sent",
    "The initial idle main request must dispatch immediately",
  );
  let admitted;
  await poll(
    "native main tool admission and completed initial reply",
    300_000,
    async () => {
      await captureThread(report.originThreadId);
      const parent = await sdk.threads.get({ threadId: report.originThreadId });
      assert.equal(parent.projectId, report.mainSendIntent.projectId);
      assert.equal(parent.providerId, report.mainSendIntent.providerId);
      assert.equal(parent.environmentId, report.mainSendIntent.environmentId);
      const transcript = report.transcripts[report.originThreadId];
      const proof = mainRequestProof(transcript, report.mainSendIntent);
      report.mainRequestObserved = proof;
      await save();
      const listed = await runsRpc("listRuns", {
        projectId: report.projectId,
        limit: 10,
        offset: 0,
      });
      assert(
        listed.runs.length <= 1,
        "The main request must not create duplicate team runs",
      );
      if (listed.runs.length === 1) {
        const candidate = await runsRpc("getRun", {
          runId: listed.runs[0].runId,
        });
        report.mainCandidateRunId = candidate.summary.runId;
        if (proof?.completed) {
          assertMainRunOwnership(
            candidate,
            report.mainSendIntent,
            proof,
            transcript.tools,
          );
          admitted = candidate;
          report.runId = admitted.summary.runId;
          report.workflowRunId = admitted.summary.workflowRunId;
          report.operations.start = admitted.definition.request.operationId;
        }
      }
      if (["error", "blocked"].includes(parent.status))
        throw new Error(`Main request reached ${parent.status}`);
      if (parent.status !== "idle") return false;
      if (!proof?.completed) return false;
      assert(
        admitted,
        "The native main turn ended without admitting a run; inspect its recorded tool output",
      );
      return true;
    },
  );
  assert.equal(admitted.definition.schemaVersion, 3);
  assert.deepEqual(admitted.definition.request.team, report.team);
  assert.equal(admitted.definition.request.goal, report.request.goal);
  assert.equal(
    admitted.definition.request.expectedProjectPolicyVersion,
    report.request.expectedProjectPolicyVersion,
  );
  assert.equal(admitted.definition.request.expectedSessionPolicyVersion, 0);
  const invocation = admitted.definition.request.invocation;
  assert(
    invocation,
    "Actual tool admission must seal its authoritative native identity",
  );
  const { providerThreadId, turnId, callId } = invocation;
  assert.equal(
    admitted.definition.request.operationId,
    `main_${runtimeHash({ projectId: report.projectId, originThreadId: report.originThreadId, invocation: { providerThreadId, turnId, callId } })}`,
  );
  const parent = report.transcripts[report.originThreadId];
  for (const kind of ["accepted", "started", "completed"])
    assert.equal(
      parent[kind].length,
      report.seedParentBaseline[kind].length + 1,
    );
  const proof = mainRequestProof(parent, report.mainSendIntent);
  assert(proof?.completed);
  assert.equal(proof.completed.status, "completed");
  const tools = parent.tools.filter(
    (tool) => tool.seq > report.seedParentBaseline.cursor,
  );
  assert(
    tools.some(
      (tool) =>
        tool.tool === "arc_orchestration_context" &&
        tool.status === "completed",
    ),
  );
  assert.equal(
    tools.filter(
      (tool) =>
        tool.tool === "arc_team_run_request" && tool.status === "completed",
    ).length,
    1,
  );
  assert(
    tools.every(
      (tool) =>
        tool.tool === "arc_orchestration_context" ||
        tool.tool === "arc_team_run_request",
    ),
    "Acceptance main request may only discover and admit the requested team",
  );
  for (const tool of tools) {
    assert.equal(tool.scope.turnId, turnId);
    assert.equal(tool.providerThreadId, providerThreadId);
    assert(tool.seq > proof.accepted.seq && tool.seq < proof.completed.seq);
  }
  const admissionTool = assertMainRunOwnership(
    admitted,
    report.mainSendIntent,
    proof,
    tools,
  );
  report.mainAdmission = {
    invocation,
    tools,
    admissionTool,
    ...proof,
    requestedExecution: executionTuple(
      report.mainSendIntent.providerId,
      proof.requested.execution,
    ),
    providerEvidence: report.mainSendIntent.parentBefore,
  };
  report.mainSendIntent.state = "settled";
  report.request = admitted.definition.request;
  report.requestHash = runtimeHash(report.request);
  report.parentBaseline = structuredClone(parent);
  await save();
  return admitted;
}

async function startAndPause() {
  await createFixture();
  await prepareProject();
  report.stage = "starting";
  await save();
  const view = orchestrated
    ? await requestFromMainConversation()
    : await runsRpc("startTeamRun", report.request);
  report.runId = view.summary.runId;
  report.workflowRunId = view.summary.workflowRunId;
  assert(report.workflowRunId);
  assert.equal(view.definition.schemaVersion, orchestrated ? 3 : 2);
  report.planHash = view.summary.planHash;
  report.teamContentHash = view.definition.team.contentHash;
  report.stage = "waiting-for-plan-approval";
  await poll(
    "real Collaborative approval before all work",
    120_000,
    async () => {
      const current = await snapshot();
      assertLiveState(current);
      assert.equal(current.workflow.agentCalls, 0);
      const control = await pendingPlan();
      if (!control || control.state !== "pending") return false;
      assertNoWork(current, control);
      report.pendingPlan = structuredClone(control);
      report.pauseInput = {
        runId: report.runId,
        operationId: report.operations.pause,
        expectedVersion: current.workflow.controlVersion,
        action: "pause",
      };
      return true;
    },
  );
  report.stage = "pausing";
  await save();
  await runsRpc("controlRun", report.pauseInput);
  await poll(
    "durable pause while awaiting the same plan decision",
    120_000,
    async () => {
      const current = await snapshot();
      const control = await pendingPlan();
      assert.deepEqual(control, report.pendingPlan);
      assertNoWork(current, control, { allowUnobservedPlan: true });
      return current.workflow.state === "paused";
    },
  );
  assert.equal(report.latest.workflow.desiredControl, "pause");
  assert.deepEqual(await pendingPlan(), report.pendingPlan);
  await assertOriginalUnchanged();
  report.pauseReceipt = structuredClone(report.latest.workflow);
  report.pausedEffects = report.effects.map(({ effect, observation }) => ({
    effect,
    observation,
  }));
  report.pausedAt = stamp();
  report.stage = "paused";
  await save();
}

async function screenshot(target, name) {
  const filename = `${name}.png`;
  await target.screenshot({
    path: resolve(report.artifactDir, filename),
    fullPage: true,
  });
  report.screenshots ??= [];
  report.screenshots.push(filename);
  await save();
}

async function openApprovalBrowser() {
  const require = createRequire(
    resolve(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json",
    ),
  );
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: "no-preference",
  });
  report.browserErrors = [];
  for (const name of ["approval", "workspace"]) {
    const target = await context.newPage();
    target.on("pageerror", (error) =>
      report.browserErrors.push({
        page: name,
        type: "pageerror",
        message: error.message,
        at: stamp(),
      }),
    );
    target.on("console", (message) => {
      if (message.type() === "error")
        report.browserErrors.push({
          page: name,
          type: "console",
          message: message.text().slice(0, 2000),
          at: stamp(),
        });
    });
    target.on("response", (response) => {
      if (response.status() >= 400)
        report.browserErrors.push({
          page: name,
          type: "http",
          status: response.status(),
          url: response.url(),
          at: stamp(),
        });
    });
    if (name === "approval") page = target;
    else workspacePage = target;
  }
  await workspacePage.addInitScript(() => {
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
  const appUrl = process.env.ARC_APP_URL ?? "http://127.0.0.1:12008";
  const parsed = new URL(appUrl);
  assert.equal(parsed.protocol, "http:");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(
    parsed.username + parsed.password + parsed.search + parsed.hash,
    "",
  );
  await page.goto(`${appUrl}/plugins/arc/runs/${report.runId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .getByRole("heading", { name: "Plan approval", exact: true })
    .waitFor({ timeout: 120_000 });
  await screenshot(page, "pending-plan-after-restart-1920");
  await workspacePage.goto(`${appUrl}/plugins/arc/workspace/${report.runId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await workspacePage
    .getByRole("region", {
      name: "Main orchestrator conversation",
      exact: true,
    })
    .waitFor({ timeout: 120_000 });
  report.browserBaseline = await workspacePage.evaluate(() => ({
    document: window.__arcWorkspaceDocument,
    animations: window.__arcWorkspaceAnimations,
    visibility: document.visibilityState,
  }));
  assert.equal(report.browserBaseline.visibility, "visible");
  assert.deepEqual(report.browserBaseline.animations, []);
  await screenshot(workspacePage, "workspace-before-approval-1920");
}

function effectFor(ref) {
  const matches = report.effects.filter(
    (item) =>
      item.effect.nodeId === ref.nodeId &&
      item.effect.iteration === ref.iteration,
  );
  assert.equal(
    matches.length,
    1,
    `Exactly one physical attempt is required for ${runtimeNodeKey(ref)}`,
  );
  return matches[0];
}

function nativeReceipt(item, type) {
  assert(item, `Missing ${type} effect`);
  const receipt = runtimeReceiptSchema.parse(item.observation?.receipt);
  assert.equal(receipt.kind, "native");
  assert.equal(receipt.request.operation.type, type);
  return receipt;
}

async function preparedWorkerProvisioning(item, receipt, thread, chain) {
  const provisioning = report.transcripts[receipt.threadId].provisioning ?? [];
  if (provisioning.length > 0) {
    const latest = [
      ...new Map(
        provisioning.map((event) => [event.provisioningId, event]),
      ).values(),
    ];
    for (const event of latest) {
      assert.equal(
        event.status,
        "completed",
        "Every actual provisioning attempt must finish before native acceptance",
      );
      assert.equal(event.environmentId, thread.environmentId);
      assert(event.seq < chain.accepted.seq);
    }
    return { kind: "provisioned", events: latest };
  }
  const databasePath = resolveDataDirDatabasePath({
    dataDir: resolveRuntimeDataDir({
      mode: "dev",
      env: process.env,
      homeDir: homedir(),
      repoRoot: resolve("."),
    }),
  });
  if (report.coreDatabasePath)
    assert.equal(databasePath, report.coreDatabasePath);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const preparation = db
      .prepare(
        "SELECT p.operation_id,p.thread_id,p.request_hash,p.request_json,p.environment_json,p.client_turn_request_id,p.turn_policy,p.created_at,t.project_id,t.provider_id,t.environment_id,e.host_id,e.path,e.status,e.created_at AS environment_created_at FROM thread_preparations p JOIN threads t ON t.id=p.thread_id JOIN environments e ON e.id=t.environment_id WHERE p.owner_plugin_id=? AND p.operation_id=? AND p.thread_id=? AND t.project_id=?",
      )
      .get("arc", item.effect.effectId, receipt.threadId, report.projectId);
    assert(
      preparation,
      "Absent provisioning needs an exact retained core preparation",
    );
    const sealed = JSON.parse(preparation.request_json);
    const environment = JSON.parse(preparation.environment_json);
    assert.equal(preparation.request_hash, runtimeHash(sealed));
    assert.equal(preparation.thread_id, thread.id);
    assert.equal(preparation.project_id, thread.projectId);
    assert.equal(sealed.operationId, item.effect.effectId);
    assert.equal(sealed.projectId, report.projectId);
    assert.equal(sealed.parentThreadId, report.originThreadId);
    assert.equal(sealed.executionContextId, receipt.executionContextId);
    assert.equal(sealed.turnPolicy, "single");
    assert.equal(preparation.turn_policy, "single");
    assert.equal(preparation.client_turn_request_id, receipt.turnRequestId);
    assert.equal(chain.requested.requestId, receipt.turnRequestId);
    assert.equal(runtimeHash(sealed.input), chain.requested.inputHash);
    assert.deepEqual(
      sealed.execution,
      executionTuple(thread.providerId, chain.requested.execution),
    );
    assert.equal(preparation.provider_id, thread.providerId);
    assert.equal(preparation.environment_id, thread.environmentId);
    assert.equal(environment.environmentId, thread.environmentId);
    assert.equal(environment.environmentId, item.effect.resource.environmentId);
    assert.equal(environment.path, receipt.workspace.path);
    assert.equal(environment.path, preparation.path);
    assert.equal(environment.hostId, report.hostId);
    assert.equal(environment.hostId, preparation.host_id);
    assert.equal(preparation.status, "ready");
    assert(preparation.created_at <= chain.requested.createdAt);
    assert(
      preparation.environment_created_at < preparation.created_at,
      "The reused environment must predate this worker preparation",
    );
    if (sealed.environment.type === "reuse") {
      assert.equal(sealed.environment.environmentId, environment.environmentId);
    } else {
      assert.equal(sealed.environment.type, "host");
      assert.equal(sealed.environment.hostId, environment.hostId);
      assert.deepEqual(sealed.environment.workspace, {
        type: "unmanaged",
        path: environment.path,
      });
    }
    const earlier = report.effects.filter(
      (candidate) =>
        candidate.effect.effectId !== item.effect.effectId &&
        candidate.observation?.receipt?.kind === "agent" &&
        candidate.effect.resource?.kind === "agent" &&
        candidate.effect.resource.environmentId === environment.environmentId &&
        candidate.effect.createdAt < item.effect.createdAt,
    );
    const priorProvisioning = earlier.flatMap((candidate) => {
      const earlierThread = candidate.observation.receipt.threadId;
      const previous = db
        .prepare(
          "SELECT p.environment_json FROM thread_preparations p JOIN threads t ON t.id=p.thread_id WHERE p.owner_plugin_id=? AND p.operation_id=? AND p.thread_id=? AND t.project_id=? AND t.environment_id=?",
        )
        .get(
          "arc",
          candidate.effect.effectId,
          earlierThread,
          report.projectId,
          environment.environmentId,
        );
      assert(previous);
      assert.deepEqual(JSON.parse(previous.environment_json), environment);
      const events = report.transcripts[earlierThread].provisioning ?? [];
      const latest = [
        ...new Map(
          events.map((event) => [event.provisioningId, event]),
        ).values(),
      ];
      return latest
        .filter(
          (event) =>
            event.environmentId === environment.environmentId &&
            event.status === "completed" &&
            event.createdAt < preparation.created_at,
        )
        .map((event) => {
          const stored = db
            .prepare(
              "SELECT data,created_at FROM events WHERE id=? AND thread_id=? AND type='system/thread-provisioning'",
            )
            .get(event.id, earlierThread);
          assert(stored);
          const data = JSON.parse(stored.data);
          assert.equal(data.status, "completed");
          assert.equal(data.environmentId, environment.environmentId);
          assert.equal(data.provisioningId, event.provisioningId);
          assert.equal(stored.created_at, event.createdAt);
          return { threadId: earlierThread, event };
        });
    });
    assert(
      priorProvisioning.length > 0,
      "Reuse needs actual earlier completed provisioning for this same owned environment",
    );
    report.coreDatabasePath = databasePath;
    return {
      kind: "reused-ready-environment",
      databasePath,
      readOnly: true,
      operationId: preparation.operation_id,
      requestHash: preparation.request_hash,
      executionContextId: sealed.executionContextId,
      inputHash: runtimeHash(sealed.input),
      requestId: preparation.client_turn_request_id,
      preparedAt: preparation.created_at,
      environmentCreatedAt: preparation.environment_created_at,
      environment,
      priorProvisioning,
    };
  } finally {
    db.close();
  }
}

async function verifyFinal() {
  const view = report.latest;
  assert.equal(view.workflow.state, "succeeded");
  assert.equal(view.verification.state, "current");
  assert.equal(view.summary.planHash, report.planHash);
  assert.equal(view.definition.team.contentHash, report.teamContentHash);
  assert.deepEqual(view.definition.request, report.request);
  assert.equal(view.definition.policy.autonomy, "collaborative");
  assert.equal(view.workflow.activeAgents, 0);
  assert.equal(view.workflow.agentCalls, expectedAgentCalls);
  assert.equal(view.workflow.repairRounds.length, 1);
  assert.equal(view.workflow.repairRounds[0].rounds, 1);
  const compiled = orchestrated
    ? compileArcOrchestratedRun(view.definition)
    : compileArcGraphRun(view.definition);
  assert.equal(compiled.workflow.planHash, report.planHash);
  const natives = report.effects
    .filter((item) => item.observation?.receipt?.kind === "native")
    .map((item) => ({
      item,
      ...runtimeReceiptSchema.parse(item.observation.receipt),
    }));
  const failed = nativeReceipt(
    effectFor(compiled.references.outputs.check.outcome),
    "check",
  );
  assert.equal(failed.receipt.outcome, "failed");
  const checkProcess = (receipt) =>
    receipt.processes.find(
      (child) =>
        child.executable === report.check.executable &&
        JSON.stringify(child.args) === JSON.stringify(report.check.args),
    );
  const failedProcess = checkProcess(failed.receipt);
  assert(
    failedProcess &&
      failedProcess.exitCode !== null &&
      failedProcess.exitCode !== 0,
  );
  assert(
    failedProcess.stderr.includes("ARC_PRICING_ASSERT"),
    "The real planted pricing failure must trigger repair",
  );
  const checked = nativeReceipt(
    effectFor(compiled.references.outputs["final-check"].outcome),
    "check",
  );
  assert.equal(checked.receipt.outcome, "succeeded");
  assert.equal(checkProcess(checked.receipt)?.exitCode, 0);
  assert(
    checkProcess(checked.receipt).stdout.includes("ARC_TEAM_CHECK_PASSED"),
  );
  const successfulChecks = natives.filter(
    (value) =>
      value.request.operation.type === "check" &&
      value.receipt.outcome === "succeeded",
  );
  assert.equal(
    successfulChecks.length,
    2,
    "Repair's actual recheck and the final required check must both succeed",
  );
  const reviewer = effectFor(compiled.references.outputs.review.outcome);
  const verdict = runtimeReceiptSchema.parse(reviewer.observation?.receipt);
  assert.equal(verdict.kind, "agent");
  assert.equal(verdict.review?.outcome, "approved");
  assert.equal(verdict.review.candidateHead, view.verification.head);
  assert(
    report.transcripts[verdict.threadId].tools.some(
      (tool) =>
        tool.tool.includes("arc_run_review") && tool.status === "completed",
    ),
  );
  const verified = compiled.references.finalGates.map((gate) =>
    nativeReceipt(effectFor(gate.verify), "snapshot"),
  );
  assert(verified.length > 0);
  const states = [
    checked.receipt.before,
    checked.receipt.after,
    verdict.workspace,
    ...verified.map((value) => value.receipt.after),
  ];
  for (const state of states) {
    assert(state);
    assert.equal(state.head, view.verification.head);
    assert.equal(state.path, view.verification.workspacePath);
    assert.equal(state.stateDigest, checked.receipt.after.stateDigest);
    assert.equal(state.clean, true);
  }
  const workers = report.effects.filter(
    (item) => item.observation?.receipt?.kind === "agent",
  );
  assert.equal(workers.length, 4);
  const writerEvidence = [];
  report.nativeWorkers = [];
  for (const item of workers) {
    const receipt = runtimeReceiptSchema.parse(item.observation.receipt);
    const node = compiled.nodes[runtimeNodeKey(item.effect)];
    assert.equal(node.kind, "agent");
    assert.equal(item.effect.attempt, 1);
    assert.equal(receipt.terminalStatus, "completed");
    const transcript = report.transcripts[receipt.threadId];
    assert.equal(transcript.accepted.length, 1);
    assert.equal(transcript.completed.length, 1);
    const accepted = transcript.accepted.find(
      (event) => event.clientRequestId === receipt.turnRequestId,
    );
    const completed = transcript.completed.find(
      (event) => event.id === receipt.terminalEventId,
    );
    assert.equal(accepted?.scope.kind, "turn");
    assert.equal(completed?.scope.kind, "turn");
    assert.equal(completed.scope.turnId, accepted.scope.turnId);
    assert.equal(completed.status, "completed");
    let dispatchProof = null;
    if (orchestrated) {
      const chain = nativeRequestChain(transcript, receipt.turnRequestId);
      assert(chain.started && chain.completed);
      assert.equal(chain.completed.id, receipt.terminalEventId);
      const thread = await sdk.threads.get({ threadId: receipt.threadId });
      assert.equal(thread.projectId, report.projectId);
      assert.deepEqual(
        executionTuple(thread.providerId, chain.requested.execution),
        report.execution,
      );
      assert.equal(chain.requested.execution.source, "client/turn/requested");
      assert.equal(item.effect.resource.threadId, receipt.threadId);
      assert.equal(item.effect.resource.turnRequestId, receipt.turnRequestId);
      assert.equal(
        item.effect.resource.executionContextId,
        receipt.executionContextId,
      );
      dispatchProof = {
        ...chain,
        providerEvidence: thread,
        provisioning: await preparedWorkerProvisioning(
          item,
          receipt,
          thread,
          chain,
        ),
      };
    }
    const key = `${item.effect.effectId}:native-accepted:${receipt.turnRequestId}`;
    report.nativeWorkers.push({
      effectId: item.effect.effectId,
      memberId: node.memberId,
      purpose: node.purpose,
      threadId: receipt.threadId,
      key,
      accepted,
      completed,
      ...(orchestrated ? { dispatchProof } : {}),
    });
    if (node.purpose === "writer" || node.purpose === "repair") {
      const commit = natives.find(
        (value) =>
          value.request.operation.type === "commit" &&
          value.receipt.after?.path === receipt.workspace.path,
      );
      assert(commit);
      const expectedPath =
        node.purpose === "repair"
          ? "shared/pricing.mjs"
          : node.memberId === "frontend"
            ? "src/frontend.mjs"
            : "src/backend.mjs";
      const changed = gitAt(
        receipt.workspace.path,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        commit.receipt.artifact.commitSha,
      )
        .split(/\r?\n/)
        .filter(Boolean);
      assert.deepEqual(changed, [expectedPath]);
      if (node.purpose === "writer") {
        assert.equal(
          gitAt(
            receipt.workspace.path,
            "show",
            `${commit.receipt.artifact.commitSha}:shared/pricing.mjs`,
          ),
          git("show", `${report.original.head}:shared/pricing.mjs`),
        );
        writerEvidence.push({
          path: receipt.workspace.path,
          sha: commit.receipt.artifact.commitSha,
          accepted,
          completed,
        });
      }
    }
  }
  assert.equal(writerEvidence.length, 2);
  assert(
    Math.max(...writerEvidence.map((value) => value.accepted.createdAt)) <
      Math.min(...writerEvidence.map((value) => value.completed.createdAt)),
    "Actual writer turn intervals must overlap",
  );
  const merges = natives
    .filter((value) => value.request.operation.type === "merge-candidate")
    .sort((a, b) => a.item.effect.createdAt - b.item.effect.createdAt);
  assert.equal(merges.length, 2);
  assert.equal(merges[1].receipt.before.head, merges[0].receipt.after.head);
  for (const merge of merges) assert.equal(merge.receipt.outcome, "succeeded");
  assert.equal(failed.receipt.after.head, merges[1].receipt.after.head);
  const forks = natives.filter(
    (value) =>
      value.request.operation.type === "fork-worktree" &&
      value.receipt.source?.path === failed.receipt.after.path,
  );
  assert.equal(
    forks.length,
    1,
    "Repair must fork the exact failed candidate without changing its historical evidence",
  );
  assert.equal(forks[0].receipt.source.head, failed.receipt.after.head);
  assert.equal(
    forks[0].receipt.source.stateDigest,
    failed.receipt.after.stateDigest,
  );
  assert.notEqual(forks[0].receipt.after.path, failed.receipt.after.path);
  assert.equal(
    gitAt(failed.receipt.after.path, "rev-parse", "HEAD"),
    failed.receipt.after.head,
  );
  assert.equal(
    gitAt(
      failed.receipt.after.path,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    "",
  );
  assert.equal(
    await readFile(
      resolve(failed.receipt.after.path, "shared/pricing.mjs"),
      "utf8",
    ),
    await readFile(resolve(report.workspace, "shared/pricing.mjs"), "utf8"),
  );
  const finalPath = view.verification.workspacePath;
  assert.equal(gitAt(finalPath, "rev-parse", "HEAD"), view.verification.head);
  assert.equal(
    gitAt(finalPath, "status", "--porcelain=v1", "--untracked-files=all"),
    "",
  );
  assert.equal(gitAt(finalPath, "branch", "--show-current"), "");
  for (const writer of writerEvidence)
    gitAt(
      finalPath,
      "merge-base",
      "--is-ancestor",
      writer.sha,
      view.verification.head,
    );
  assert.equal(
    new Set([
      report.workspace,
      ...writerEvidence.map((value) => value.path),
      failed.receipt.after.path,
      finalPath,
    ]).size,
    5,
  );
  assert.deepEqual(
    gitAt(finalPath, "diff", "--name-only", report.original.head, "HEAD")
      .split(/\r?\n/)
      .filter(Boolean),
    ["shared/pricing.mjs", "src/backend.mjs", "src/frontend.mjs"],
  );
  await assertOriginalUnchanged();
  assert.equal(
    hash(
      await readFile(resolve(report.artifactDir, "required-check-source.mjs")),
    ),
    report.checkSourceHash,
  );
  const cliText = execFileSync(
    process.execPath,
    [resolve("apps/cli/dist/index.js"), "arc", "runs", "show", report.runId],
    {
      cwd: resolve("."),
      env: { ...process.env, BB_SERVER_URL: baseUrl },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const cli = JSON.parse(cliText);
  await writeFile(
    resolve(report.artifactDir, "cli-run.json"),
    JSON.stringify(cli, null, 2),
  );
  assert.deepEqual(cli.definition, view.definition);
  assert.deepEqual(cli.summary, view.summary);
  assert.deepEqual(cli.verification, view.verification);
  assert.equal(cli.workflow.agentCalls, expectedAgentCalls);
  assert.equal(cli.workflow.state, "succeeded");
  if (orchestrated) {
    const completions = report.effects.filter(
      (item) => item.observation?.receipt?.kind === "orchestrator",
    );
    assert.equal(
      completions.length,
      1,
      "The same run must contain exactly one admitted main response",
    );
    const item = completions[0];
    const receipt = orchestratorReceiptSchema.parse(item.observation.receipt);
    assert.equal(receipt.kind, "orchestrator");
    assert.equal(item.effect.attempt, 1);
    assert.equal(receipt.operationId, item.effect.effectId);
    assert.equal(receipt.threadId, report.originThreadId);
    assert.equal(
      receipt.executionContextId,
      item.effect.resource?.executionContextId,
    );
    assert.equal(receipt.terminalStatus, "completed");
    assert.equal(
      receipt.definitionHash,
      runtimeHash(compiled.nodes[runtimeNodeKey(item.effect)]),
    );
    const node = compiled.nodes[runtimeNodeKey(item.effect)];
    assert.equal(node.kind, "orchestrator");
    assert.deepEqual(item.effect.resource, {
      kind: "agent",
      threadId: receipt.threadId,
      executionContextId: receipt.executionContextId,
      environmentId: node.completion.environment.environmentId,
      turnRequestId: receipt.turnRequestId,
    });
    const parent = report.transcripts[report.originThreadId];
    const { requested, accepted, started, completed } = nativeRequestChain(
      parent,
      receipt.turnRequestId,
    );
    assert(accepted && started && completed);
    assert.equal(accepted.id, receipt.acceptedEventId);
    assert.equal(completed.id, receipt.terminalEventId);
    assert(requested.seq > report.parentBaseline.cursor);
    assert.equal(requested.execution.source, "client/turn/requested");
    const parentThread = await sdk.threads.get({
      threadId: report.originThreadId,
    });
    assert.equal(parentThread.projectId, report.projectId);
    assert.equal(
      parentThread.environmentId,
      node.completion.environment.environmentId,
    );
    assert.deepEqual(
      executionTuple(parentThread.providerId, requested.execution),
      node.completion.execution,
    );
    assert.deepEqual(node.completion.execution, report.execution);
    assert.notEqual(
      requested.requestId,
      report.mainAdmission.requested.requestId,
    );
    assert.equal(accepted.clientRequestId, receipt.turnRequestId);
    assert.equal(accepted.scope.turnId, receipt.turnId);
    assert.equal(started.providerThreadId, receipt.providerThreadId);
    assert.equal(completed.scope.turnId, receipt.turnId);
    assert.equal(completed.status, "completed");
    assert(
      accepted.createdAt >=
        Math.max(
          ...report.nativeWorkers.map((worker) => worker.completed.createdAt),
        ),
      "The main response must follow settled worker evidence",
    );
    report.mainCompletion = {
      effectId: item.effect.effectId,
      receipt,
      requested,
      accepted,
      started,
      completed,
      requestedExecution: executionTuple(
        parentThread.providerId,
        requested.execution,
      ),
      providerEvidence: parentThread,
    };
    assert.deepEqual(
      parent.tools.filter((tool) => tool.seq > accepted.seq),
      [],
      "This completion must report retained evidence without dispatching more work",
    );
  }
  report.finalEvidence = {
    head: view.verification.head,
    finalPath,
    writerEvidence,
    failedCandidate: failed.receipt.after,
    repairedCandidate: checked.receipt.after,
    review: verdict.review,
    mergeEffectIds: merges.map((value) => value.item.effect.effectId),
    originalUnchanged: true,
    cliParity: true,
  };
}

function assertParentNativeEvents(parent) {
  for (const kind of orchestrated
    ? ["requested", "accepted", "started", "completed"]
    : ["accepted", "started", "completed"]) {
    const expected = [...report.parentBaseline[kind]];
    if (orchestrated) {
      assert(
        report.mainCompletion,
        "The automatic response needs exact native evidence",
      );
      expected.push(report.mainCompletion[kind]);
    }
    assert.deepEqual(
      parent[kind],
      expected,
      "Only the separately counted response may follow the initial main request",
    );
  }
}

async function verifyWorkspaceAndParent() {
  await poll(
    "four completed graph workers in the live Workspace",
    60_000,
    async () => {
      const view = await rpc(arcWorkspaceRpcContract, "getWorkspace", {
        runId: report.runId,
        cursor: null,
        eventLimit: 100,
      });
      report.workspaceView = view;
      return (
        view.workers.length === 4 &&
        view.workers.every((worker) => worker.state === "succeeded")
      );
    },
  );
  await delay(1500);
  report.animations = await workspacePage.evaluate(
    () => window.__arcWorkspaceAnimations,
  );
  assert.equal(
    await workspacePage.evaluate(() => window.__arcWorkspaceDocument),
    report.browserBaseline.document,
  );
  for (const worker of report.nativeWorkers) {
    const animations = report.animations.filter(
      (animation) => animation.key === worker.key,
    );
    assert.equal(
      animations.length,
      1,
      `Exactly one real handoff is required for ${worker.purpose} ${worker.memberId}`,
    );
    assert.equal(animations[0].document, report.browserBaseline.document);
    assert.equal(animations[0].visibility, "visible");
    assert.equal(animations[0].finished, true);
    assert.equal(animations[0].cancelled, false);
    assert(animations[0].at >= worker.accepted.createdAt);
  }
  assert.equal(report.animations.length, 4);
  report.workerColors = [];
  for (const worker of report.workspaceView.workers) {
    assert.equal(worker.execution.providerId, report.providerId);
    assert.equal(worker.execution.model, report.model);
    assert(worker.group);
    const purposeLabel =
      worker.purpose === "review"
        ? "Reviewer"
        : worker.purpose === "repair"
          ? "Repair"
          : "Builder";
    const card = workspacePage.getByRole("region", {
      name: `${worker.name} ${purposeLabel} conversation`,
      exact: true,
    });
    await card.waitFor({ timeout: 30_000 });
    const border = await card.evaluate((element) => ({
      color: getComputedStyle(element).borderColor,
      inline: element.style.borderColor,
      text: element.innerText,
    }));
    const expected = await workspacePage.evaluate((value) => {
      const element = document.createElement("div");
      element.style.color = value;
      return element.style.color;
    }, worker.group.color);
    assert.equal(border.color, expected);
    assert(border.text.includes(report.model));
    const providerIcon = card.locator('header [role="img"]').first();
    await providerIcon.waitFor({ timeout: 30_000 });
    const icon = await providerIcon.evaluate((element) => ({
      label: element.getAttribute("aria-label"),
      mask: getComputedStyle(element).maskImage,
    }));
    assert.match(icon.label, /codex/i);
    assert.notEqual(icon.mask, "none");
    assert.equal(await card.locator('[contenteditable="true"]').count(), 0);
    report.workerColors.push({
      effectId: worker.effectId,
      group: worker.group,
      border: border.color,
      icon,
    });
  }
  assert.equal(
    await workspacePage
      .getByRole("region", {
        name: "Main orchestrator conversation",
        exact: true,
      })
      .locator('[contenteditable="true"]')
      .count(),
    1,
  );
  await screenshot(workspacePage, "completed-live-graph-workspace-1920");
  await workspacePage.reload({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await workspacePage
    .getByRole("region", {
      name: "Main orchestrator conversation",
      exact: true,
    })
    .waitFor({ timeout: 60_000 });
  await delay(7000);
  report.reload = await workspacePage.evaluate(() => ({
    document: window.__arcWorkspaceDocument,
    animations: window.__arcWorkspaceAnimations,
    visibility: document.visibilityState,
  }));
  assert.notEqual(report.reload.document, report.browserBaseline.document);
  assert.deepEqual(report.reload.animations, []);
  assert.equal(report.reload.visibility, "visible");
  await screenshot(workspacePage, "completed-reloaded-no-handoff-1920");
  await poll(
    "passive completion notices for all four workers",
    60_000,
    async () => {
      await captureThread(report.originThreadId);
      const parent = report.transcripts[report.originThreadId];
      assertParentNativeEvents(parent);
      const baselineIds = new Set(
        report.parentBaseline.passive.map((event) => event.id),
      );
      const notices = parent.passive.filter(
        (event) => !baselineIds.has(event.id),
      );
      report.passiveNotices = notices;
      return report.nativeWorkers.every((worker) =>
        notices.some(
          (notice) =>
            notice.status === "completed" &&
            notice.scope.kind === "thread" &&
            notice.metadata?.delivery === "owner-controlled" &&
            notice.metadata.kind === "child-completed" &&
            Array.isArray(notice.metadata.children) &&
            notice.metadata.children.some(
              (child) =>
                child?.ownerPluginId === "arc" &&
                child.childThreadId === worker.threadId,
            ),
        ),
      );
    },
  );
  for (let interval = 0; interval < 3; interval++) {
    await delay(2000);
    await captureThread(report.originThreadId);
    const parent = report.transcripts[report.originThreadId];
    assertParentNativeEvents(parent);
  }
  const completionNotices = report.passiveNotices.filter(
    (notice) => notice.metadata?.kind === "child-completed",
  );
  assert.equal(completionNotices.length, 4);
  assert.equal(
    new Set(completionNotices.map((notice) => notice.operationId)).size,
    4,
  );
  assert.equal(
    (await sdk.threads.get({ threadId: report.originThreadId })).status,
    "idle",
  );
  report.parentFinal = structuredClone(
    report.transcripts[report.originThreadId],
  );
  assert.equal(
    report.browserErrors.length,
    0,
    JSON.stringify(report.browserErrors),
  );
}

async function resumeRun() {
  await assertOriginalUnchanged();
  assert.equal(
    orchestrated
      ? runtimeHash(report.request)
      : hash(JSON.stringify(report.request)),
    report.requestHash,
  );
  const host = (await sdk.hosts.list()).find(
    (value) => value.id === report.hostId,
  );
  assert.equal(host?.status, "connected");
  const before = await snapshot();
  assert.equal(before.workflow.state, "paused");
  assert.equal(before.workflow.desiredControl, "pause");
  assert.equal(before.summary.planHash, report.planHash);
  assert.equal(
    before.workflow.controlVersion,
    report.pauseReceipt.controlVersion,
  );
  assert(
    before.workflow.dispatchGeneration > report.pauseReceipt.dispatchGeneration,
    "The actual workflow worker must have restarted between commands",
  );
  const retained = await pendingPlan();
  assertNoWork(before, retained, { allowUnobservedPlan: true });
  assert.deepEqual(
    retained,
    report.pendingPlan,
    "Restart must preserve the exact pending decision context and revision",
  );
  for (const retainedEffect of report.pausedEffects) {
    const current = report.effects.find(
      (item) => item.effect.effectId === retainedEffect.effect.effectId,
    );
    assert(current);
    assert.equal(current.effect.nodeId, retainedEffect.effect.nodeId);
    assert.equal(current.effect.iteration, retainedEffect.effect.iteration);
    assert.equal(current.effect.attempt, retainedEffect.effect.attempt);
    for (const resource of [
      current.effect.resource,
      retainedEffect.effect.resource,
    ])
      if (resource !== null)
        assert.deepEqual(resource, {
          kind: "owner-control",
          controlId: retained.controlId,
        });
  }
  report.restartEvidence = {
    beforeGeneration: report.pauseReceipt.dispatchGeneration,
    afterGeneration: before.workflow.dispatchGeneration,
    controlId: retained.controlId,
    contextHash: retained.contextHash,
    revision: retained.revision,
    agentCalls: before.workflow.agentCalls,
    at: stamp(),
  };
  report.resumeInput = {
    runId: report.runId,
    operationId: report.operations.resume,
    expectedVersion: before.workflow.controlVersion,
    action: "resume",
  };
  report.stage = "resuming-to-plan-approval";
  await save();
  await runsRpc("controlRun", report.resumeInput);
  await poll("same pending plan after explicit resume", 60_000, async () => {
    const current = await snapshot();
    assertLiveState(current);
    const control = await pendingPlan();
    assert.deepEqual(control, report.pendingPlan);
    const observedPlan = assertNoWork(current, control, {
      allowUnobservedPlan: true,
    });
    return (
      current.workflow.desiredControl === "run" &&
      current.workflow.state !== "paused" &&
      observedPlan
    );
  });
  await openApprovalBrowser();
  report.stage = "approving-in-browser";
  await save();
  const approval = page.getByRole("article", {
    name: "Plan or task approval",
    exact: true,
  });
  await approval.getByRole("button", { name: "Approve", exact: true }).click();
  await workspacePage.bringToFront();
  await poll("actual browser plan decision persisted", 30_000, async () => {
    const control = await pendingPlan();
    if (control?.state !== "resolved") return false;
    assert.equal(control.decision, "approved");
    assert.equal(control.contextHash, report.pendingPlan.contextHash);
    assert.deepEqual(control.context, report.pendingPlan.context);
    assert.equal(control.revision, report.pendingPlan.revision + 1);
    report.approvalReceipt = control;
    return true;
  });
  report.stage = "running-native-graph";
  await save();
  await poll(
    "real parallel writers, native integration, failed check, repair and review",
    20 * 60_000,
    async () => {
      const current = await snapshot();
      assertLiveState(current);
      assert(current.workflow.agentCalls <= expectedAgentCalls);
      return current.workflow.state === "succeeded";
    },
  );
  report.stage = "verifying-native-graph";
  await verifyFinal();
  await verifyWorkspaceAndParent();
  await assertOriginalUnchanged();
  report.passed = true;
  report.stage = "completed";
  report.completedAt = stamp();
  await save();
}

async function drainMainSendIntent() {
  const intent = report.mainSendIntent;
  assert.equal(intent.threadId, report.originThreadId);
  assert.equal(intent.projectId, report.projectId);
  assert.equal(intent.inputHash, runtimeHash(intent.sendInput.input));
  assert.deepEqual(intent.runIdsBefore, []);
  assert.deepEqual(intent.queuedBefore, []);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await captureThread(intent.threadId);
    const transcript = report.transcripts[intent.threadId];
    const parent = await sdk.threads.get({ threadId: intent.threadId });
    assert.equal(parent.projectId, intent.projectId);
    assert.equal(parent.providerId, intent.providerId);
    assert.equal(parent.environmentId, intent.environmentId);
    const proof = mainRequestProof(
      report.mainAdmission
        ? {
            ...transcript,
            requested: transcript.requested.filter(
              (event) => event.seq <= report.mainAdmission.completed.seq,
            ),
          }
        : transcript,
      intent,
    );
    report.mainRequestDrain = {
      at: stamp(),
      intentId: intent.id,
      sendReply: report.mainSend ?? null,
      parentStatus: parent.status,
      proof,
      settled: Boolean(proof?.completed),
    };
    await save();
    if (
      proof?.completed &&
      (report.mainAdmission ||
        ["idle", "error", "blocked"].includes(parent.status))
    )
      return proof;
    const queued = await sdk.threads.queuedMessages.list({
      threadId: intent.threadId,
    });
    for (const entry of queued) {
      assert.equal(entry.threadId, intent.threadId);
      assert.equal(
        runtimeHash(entry.content),
        intent.inputHash,
        "Never drain or remove another queued input",
      );
      assert.deepEqual(
        executionTuple(intent.providerId, entry),
        intent.execution,
      );
    }
    assert(
      queued.length <= 1,
      "An uncertain send must not have duplicate queue entries",
    );
    report.mainRequestDrain.queued = queued;
    await delay(500);
  }
  throw new Error(
    "The exact main send has no proven terminal drain within 90000 ms; no guessed thread stop or run cancellation was issued",
  );
}

async function cancelOnlyOwnedRun() {
  if (orchestrated) {
    if (!report.mainSendIntent) return;
    const proof = await drainMainSendIntent();
    const listed = await runsRpc("listRuns", {
      projectId: report.projectId,
      offset: 0,
      limit: 50,
    });
    assert(
      listed.runs.length < 50,
      "Cleanup cannot establish ownership from a truncated run list",
    );
    const matches = [];
    for (const summary of listed.runs) {
      const candidate = await runsRpc("getRun", { runId: summary.runId });
      const invocation = candidate.definition.request.invocation;
      if (
        candidate.definition.schemaVersion !== 3 ||
        !invocation ||
        invocation.providerThreadId !== proof.accepted?.providerThreadId ||
        invocation.turnId !== proof.accepted?.scope.turnId
      )
        continue;
      const tool = assertMainRunOwnership(
        candidate,
        report.mainSendIntent,
        proof,
        report.transcripts[report.originThreadId].tools,
        false,
      );
      matches.push({ candidate, tool });
    }
    assert(
      matches.length <= 1,
      "Ambiguous native admission cannot authorize cleanup",
    );
    if (report.runId)
      assert.equal(matches[0]?.candidate.summary.runId, report.runId);
    if (matches.length === 0) {
      report.failureCleanup = {
        state: "no-run-from-settled-request",
        cancellationSent: false,
        requestId: proof.requested.requestId,
      };
      return;
    }
    const { candidate, tool } = matches[0];
    report.runId = candidate.summary.runId;
    report.workflowRunId = candidate.summary.workflowRunId;
    report.operations.start = `main_${runtimeHash({ projectId: report.projectId, originThreadId: report.originThreadId, invocation: { providerThreadId: proof.accepted.providerThreadId, turnId: proof.accepted.scope.turnId, callId: tool.itemId } })}`;
    report.mainRunRecovery = {
      requestId: proof.requested.requestId,
      acceptedEventId: proof.accepted.id,
      terminalEventId: proof.completed.id,
      toolItemId: tool.itemId,
      runId: report.runId,
      workflowRunId: report.workflowRunId,
      operationId: report.operations.start,
    };
    await save();
  } else if (!report.runId && report.projectId && report.request) {
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
  assert.equal(current.summary.workflowRunId, report.workflowRunId);
  assert.equal(
    current.definition.request.originThreadId,
    report.originThreadId,
  );
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
  for (const [name, target] of [
    ["approval", page],
    ["workspace", workspacePage],
  ]) {
    if (target && !target.isClosed()) {
      try {
        await screenshot(target, `failed-${name}`);
      } catch (captureError) {
        report.screenshotFailure = String(captureError);
      }
    }
  }
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
  if (browser) await browser.close();
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
          ? `Restart the same ARC server and daemon, then run: node --conditions=source --import tsx scripts/arc-graph-runtime-smoke.mjs ${orchestrated ? "orchestrator-resume" : "resume"} "${reportPath}" "${baseUrl}"`
          : null,
    }),
  );
}

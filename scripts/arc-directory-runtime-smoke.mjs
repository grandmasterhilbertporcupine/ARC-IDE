import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  appendFile,
  lstat,
  readdir,
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
import { directoryRuntimeReceiptSchema } from "../plugins/arc/runtime/directory-receipt.ts";
import { directoryEffectRequestHash } from "../plugins/arc/host/hash.ts";
import { compileArcDirectoryRun } from "../plugins/arc/runtime/directory-compiler.ts";
import { orchestratorReceiptSchema } from "../plugins/arc/runtime/orchestrated-receipt.ts";
import { runtimeHash } from "../plugins/arc/runtime/hash.ts";
import { runtimeNodeKey } from "../plugins/arc/runtime/compiler.ts";
import { arcWorkspaceRpcContract } from "../plugins/arc/workspace/contract.ts";
import { arcTeamsRpcContract } from "../plugins/arc/teams/contract.ts";
import {
  arcPolicyRpcContract,
  defaultRunPolicy,
} from "../plugins/arc/policy/contract.ts";

const [mode, argument, overrideUrl] = process.argv.slice(2);
const harnessIdentity = "ARC_DIRECTORY_RUNTIME_SMOKE_V4";
const expectedAgentCalls = 4;
const expectedWorkerCalls = 3;
if (mode === "--help" || mode === "help") {
  console.log(
    "Usage: node --conditions=source --import tsx scripts/arc-directory-runtime-smoke.mjs start-pause [http://127.0.0.1:20008]\n       node --conditions=source --import tsx scripts/arc-directory-runtime-smoke.mjs resume <report-path> [http://127.0.0.1:20008]\nThe first command creates an ordinary temporary directory outside Git and exits after an actual owned run is durably paused. Restart the same ARC server/daemon/profile before resume. This harness does not start services or delete fixtures. It launches real provider turns only in these explicit modes.",
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
  "This harness verifies native Windows directory execution",
);
const artifactRoot = resolve(".arc-verification", "directory-runtime");
const fixtureRoot = resolve(
  await realpath(tmpdir()),
  "arc-directory-acceptance",
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
const newId = (purpose) => `arc-directory-${purpose}-${randomUUID()}`;
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
  assert.equal(report.fixtureRoot, fixtureRoot);
  assert(within(fixtureRoot, resolve(report.workspace)));
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
    fixtureRoot,
    workspace: resolve(fixtureRoot, `Native directory Δ ${randomUUID()}`),
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
  await assertOutsideGit(fixtureRoot);
  await mkdir(report.workspace, { recursive: true });
  await mkdir(report.artifactDir, { recursive: true });
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
async function assertOutsideGit(path) {
  for (let parent = resolve(path); ; parent = dirname(parent)) {
    try {
      await lstat(resolve(parent, ".git"));
      throw new Error(
        `The acceptance fixture must not have Git metadata in an ancestor: ${parent}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (parent === dirname(parent)) break;
  }
  let existing = resolve(path);
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
  let failure;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: existing,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(
    failure?.status,
    128,
    "Git must explicitly identify the fixture ancestor as a non-repository",
  );
  assert.match(String(failure.stderr), /not a git repository/i);
}

async function directoryFingerprint(path) {
  await assertOutsideGit(path);
  const root = await realpath(path);
  const rootStat = await lstat(root, { bigint: true });
  const entries = [];
  let fileBytes = 0;
  const visit = async (absolute, relativePath) => {
    const before = await lstat(absolute, { bigint: true });
    assert.equal(
      before.isSymbolicLink(),
      false,
      `Unexpected link in accepted candidate: ${absolute}`,
    );
    assert.equal(await realpath(absolute), absolute);
    if (before.isDirectory()) {
      entries.push({
        kind: "directory",
        path: relativePath,
        mode: Number(before.mode & 0o777n),
      });
      for (const name of (await readdir(absolute)).sort()) {
        assert.notEqual(name.toLowerCase(), ".git");
        await visit(
          resolve(absolute, name),
          relativePath === "." ? name : `${relativePath}/${name}`,
        );
      }
    } else {
      assert(before.isFile(), `Unexpected special entry: ${absolute}`);
      const bytes = await readFile(absolute);
      assert.equal(BigInt(bytes.length), before.size);
      fileBytes += bytes.length;
      entries.push({
        kind: "file",
        path: relativePath,
        mode: Number(before.mode & 0o777n),
        bytes: bytes.length,
        contentDigest: hash(bytes),
      });
    }
    const after = await lstat(absolute, { bigint: true });
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"])
      assert.equal(
        after[key],
        before[key],
        `Entry changed during independent inventory: ${absolute}`,
      );
  };
  await visit(root, ".");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { version: 1, entries };
  return {
    state: {
      kind: "directory",
      path: root,
      rootIdentity: {
        deviceId: rootStat.dev.toString(),
        fileId: rootStat.ino.toString(),
      },
      manifestDigest: hash(JSON.stringify(manifest)),
      entryCount: entries.length,
      fileBytes,
    },
    manifest,
  };
}

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
  return directoryFingerprint(report.workspace);
}

async function assertOriginalUnchanged() {
  const current = await originalFingerprint();
  assert.deepEqual(
    current,
    report.original,
    "The full original folder inventory, file bytes, root identity and manifest must remain unchanged",
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
    "README.md": `# Disposable ARC team acceptance\n\n${report.fixtureMarker}\n\nThe builder owns src/frontend.mjs and src/backend.mjs. It must leave shared/pricing.mjs untouched; the required check and admitted repair stage own the existing pricing defect. No network installs, credentials or unrelated repositories are needed.\n`,
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
    ".persistent-context.md":
      "Persistent context is part of every complete directory snapshot.\n",
    "node_modules/fixture-sentinel/index.mjs":
      "export const retainedDependency = true;\n",
    "server.mjs": `import {createServer} from "node:http";\nimport {renderPage} from "./src/frontend.mjs";\nimport {quoteOrder} from "./src/backend.mjs";\nconst server = createServer((request, response) => {\n  try {\n    const url = new URL(request.url, "http://127.0.0.1");\n    if (url.pathname === "/quote") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(quoteOrder(Number(url.searchParams.get("count"))))); }\n    else if (url.pathname === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(renderPage(quoteOrder(2))); }\n    else { response.statusCode = 404; response.end("Not found"); }\n  } catch (error) { response.statusCode = 400; response.end(error.message); }\n});\nserver.listen(Number(process.argv[2] ?? 0), "127.0.0.1", () => console.log("ARC_SERVER_PORT=" + server.address().port));\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(report.workspace, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  await mkdir(resolve(report.workspace, "empty directory Δ"));
  await mkdir(resolve(report.workspace, ".cache", "empty"), {
    recursive: true,
  });
  report.workspace = await realpath(report.workspace);
  report.original = await originalFingerprint();
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
  return `You are an actual ARC serial directory execution acceptance agent. Read arc_run_snapshot first. This is an ordinary folder with NO Git repository. Work only in the assigned directory. Do not run git init or any Git command. Do not inspect credentials, accounts, environment variables or unrelated files. Do not install dependencies, access the public network, create subagents, commit, merge, push or deploy. Do not change required-check configuration, hidden files, dependency files or empty folders.\n\nWhen assigned the writer task, edit only src/frontend.mjs and src/backend.mjs, leaving shared/pricing.mjs untouched. The deliberately planted pricing defect belongs to the required check and admitted repair stage.\n\nWhen assigned repair, diagnose the actual failed check from arc_run_snapshot. Preserve both builder files and fix only shared/pricing.mjs so totalPrice(quantity) returns exactly quantity * 100. Verify with built-in Node only, without writing check caches.\n\nWhen assigned review, do not edit any files. Inspect the exact candidate snapshot, confirm frontend, backend and pricing behavior, and use arc_run_review with kind directory, the actual snapshotId and manifestDigest from arc_run_snapshot, and your genuine approved or changes-requested verdict. No Git HEAD exists. Completing chat without this tool is not approval. Do not invent checks, native output or verdict receipts.`;
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
  for (const role of ["Builder", "Repair", "Reviewer"]) {
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
  const setup = await runsRpc("getProjectRunSetup", {
    projectId: report.projectId,
    hostId: report.hostId,
  });
  assert.equal(resolve(setup.selected.path), resolve(report.workspace));
  assert.equal(setup.selected.kind, "directory");
  assert.equal("head" in setup.selected, false);
  const [builder, repairer, reviewer] = report.agents;
  const selection = ({ agentId, revision }) => ({ agentId, revision });
  const goal =
    "Build the tiny dependency-free ARC Shop Node app: render its order summary and serve validated quantity quotes at exactly 100 cents per item. The builder owns only the two src files, required native checks must reveal the existing shared pricing defect, and the admitted repair stage must fix that defect in a fresh copy. The final reviewer must inspect and approve the exact retained directory snapshot with arc_run_review.";
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
    name: "Native directory · build, repair and verify",
    description:
      "Actual serial directory graph with complete inventories, a planted check failure and one bounded fresh-copy repair.",
    groups: [
      { id: "blue", name: "Builder", color: "#4c8ce8", parentGroupId: null },
      { id: "red", name: "Repair", color: "#d55e68", parentGroupId: null },
      { id: "white", name: "Review", color: "#d7e1e8", parentGroupId: null },
    ],
    members: [
      { id: "builder", ...selection(builder), groupId: "blue" },
      { id: "repairer", ...selection(repairer), groupId: "red" },
      { id: "reviewer", ...selection(reviewer), groupId: "white" },
    ],
    permissions: [
      {
        id: "review-builder",
        fromMemberId: "reviewer",
        toMemberId: "builder",
        action: "review",
      },
      {
        id: "review-repairer",
        fromMemberId: "reviewer",
        toMemberId: "repairer",
        action: "review",
      },
    ],
    graph: {
      entryNodeIds: ["build"],
      nodes: [
        {
          id: "build",
          label: "Build app",
          kind: "agent",
          memberId: "builder",
          access: "write",
          candidate: { kind: "source" },
          task: 'Edit only src/frontend.mjs and src/backend.mjs. In frontend export renderPage({count,total,currency}) returning HTML with exactly <h1>ARC Shop</h1>, an element data-testid="product-count" whose direct text is only the numeric count, and an element data-testid="order-total" whose direct text is only the numeric total in cents. These two elements must contain digits only, with no whitespace, nested markup, unit suffix or currency label; put any unit or currency label outside them. For count 2 and total 200, use <span data-testid="product-count">2</span> and <span data-testid="order-total">200</span>. In backend import totalPrice from ../shared/pricing.mjs and export quoteOrder(quantity), reject non-integer or non-positive quantities with an Error mentioning quantity, and return {count:quantity,total:totalPrice(quantity),currency:"USD"}. Do not modify any other file. Preserve the deliberately faulty shared pricing calculation for the required check and later repair stage.',
        },
        {
          id: "check",
          label: "Required app check",
          kind: "check",
          candidate: candidate("build"),
          command: report.check,
        },
        {
          id: "repair",
          label: "Repair and recheck",
          kind: "repair",
          body: {
            memberId: "repairer",
            task: "Use the actual failed-check evidence to repair only shared/pricing.mjs. Preserve both builder files and make totalPrice(quantity) return exactly quantity * 100. Do not modify the check or other files.",
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
          label: "Review final snapshot",
          kind: "review",
          memberId: "reviewer",
          candidate: candidate("repair"),
          task: "Inspect the exact checked directory snapshot and confirm frontend, backend and pricing behavior. Do not change any file. Record an honest explicit arc_run_review verdict using kind directory and the actual snapshotId and manifestDigest from arc_run_snapshot.",
        },
      ],
      edges: [
        edge("build", "check"),
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
      nodes: ["build", "check", "repair", "final-check", "review"].map(
        (nodeId, index) => ({ nodeId, x: index * 300, y: 100 }),
      ),
    },
  };
  let { team } = await teamsRpc("createTeam", { scope, definition });
  ({ team } = await teamsRpc("publishTeamRevision", {
    scope,
    teamId: team.id,
    expectedDraftVersion: team.draft.version,
  }));
  report.team = { teamId: team.id, revision: team.currentRevision };
  {
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
        maxConcurrentAgents: 1,
        maxAgentCalls: expectedAgentCalls,
        maxRepairRounds: 1,
        maxActiveMs: 1200000,
      },
    },
  });
  report.request = {
    operationId: report.operations.start,
    projectId: report.projectId,
    originThreadId: report.originThreadId,
    hostId: report.hostId,
    path: setup.selected.path,
    goal,
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
    "No native source capture or working-copy effect may start before plan approval",
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
  const compiled = compileArcDirectoryRun(view.definition);
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
  assert.equal(view.definition.schemaVersion, 4);
  assert.equal(view.summary.projectId, intent.projectId);
  const request = view.definition.request;
  const { operationId: _initialOperationId, ...expected } = intent.runRequest;
  const {
    operationId,
    invocation,
    expectedSource,
    sourceInspectionId,
    ...actual
  } = request;
  assert.deepEqual(expectedSource, {
    rootIdentity: report.original.state.rootIdentity,
    manifestDigest: report.original.state.manifestDigest,
  });
  assert(sourceInspectionId);
  assert.deepEqual(view.definition.source, report.original.state);
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
      tool.tool === "arc_directory_team_run_request" &&
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
  report.mainRequestPrompt = `Now request actual serial team work for this ordinary non-Git project. Use arc_orchestration_context first. Its exact preferred team version is configured even when a newer published revision exists. The source kind must be directory. Use arc_directory_source_inspect with the returned hostId; retain the returned operationId and call that same inspection operation again while pending until it is ready. Never invent or replace an inspection ID. Then use arc_directory_team_run_request exactly once with that preferred team, the returned sourceInspectionId, exact expectedSource rootIdentity and manifestDigest, returned source and policy versions, and this exact goal: ${report.request.goal}\nDo not implement, edit files, call shell/network tools, create Git metadata, spawn threads, modify policy or approve controls yourself. After the tool records the run, briefly report the run and its required approval, then finish this turn. The user will approve the actual Workspace control. Do not poll the run or start another run. If inspection or admission fails, explain the actual error and finish without replacement work.`;
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
  assert.equal(admitted.definition.schemaVersion, 4);
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
        tool.tool === "arc_directory_team_run_request" &&
        tool.status === "completed",
    ).length,
    1,
  );
  assert(
    tools.every(
      (tool) =>
        tool.tool === "arc_orchestration_context" ||
        tool.tool === "arc_directory_source_inspect" ||
        tool.tool === "arc_directory_team_run_request",
    ),
    "Acceptance main request may only discover and admit the requested team",
  );
  for (const tool of tools) {
    assert.equal(tool.scope.turnId, turnId);
    assert.equal(tool.providerThreadId, providerThreadId);
    assert(tool.seq > proof.accepted.seq && tool.seq < proof.completed.seq);
  }
  assert(
    tools.some(
      (tool) =>
        tool.tool === "arc_directory_source_inspect" &&
        tool.status === "completed",
    ),
    "Admission requires actual native source inspection",
  );
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
  const view = await requestFromMainConversation();
  report.runId = view.summary.runId;
  report.workflowRunId = view.summary.workflowRunId;
  assert(report.workflowRunId);
  assert.equal(view.definition.schemaVersion, 4);
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
  const receipt = directoryRuntimeReceiptSchema.parse(
    item.observation?.receipt,
  );
  assert.equal(receipt.kind, "directory-native");
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
        candidate.observation?.receipt?.kind === "directory-agent" &&
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
  assert.equal(view.definition.schemaVersion, 4);
  assert.equal(view.workflow.state, "succeeded");
  assert.equal(view.verification.kind, "directory");
  assert.equal(view.verification.state, "current");
  assert.equal(view.summary.planHash, report.planHash);
  assert.equal(view.definition.team.contentHash, report.teamContentHash);
  assert.deepEqual(view.definition.request, report.request);
  assert.equal(view.definition.policy.autonomy, "collaborative");
  assert.equal(view.workflow.activeAgents, 0);
  assert.equal(view.workflow.agentCalls, expectedAgentCalls);
  assert.equal(view.workflow.repairRounds.length, 1);
  assert.equal(view.workflow.repairRounds[0].rounds, 1);
  const compiled = compileArcDirectoryRun(view.definition);
  assert.equal(compiled.workflow.planHash, report.planHash);
  for (const item of report.effects) {
    assert.equal(item.effect.attempt, 1);
    assert(item.observation && "receipt" in item.observation);
    assert.equal(
      item.observation.receiptHash,
      runtimeHash(item.observation.receipt),
      "Every retained receipt must match its actual content hash",
    );
  }
  const natives = report.effects
    .filter((item) => item.observation?.receipt?.kind === "directory-native")
    .map((item) => ({
      item,
      ...directoryRuntimeReceiptSchema.parse(item.observation.receipt),
    }));
  assert(natives.length > 0);
  assert.equal(
    report.effects.some((item) =>
      ["native", "agent"].includes(item.observation?.receipt?.kind),
    ),
    false,
    "Directory execution cannot fabricate Git receipts",
  );
  for (const native of natives) {
    assert.equal(native.request.runId, report.runId);
    assert.equal(native.request.effectId, native.item.effect.effectId);
    assert.equal(native.receipt.kind, "directory");
    assert.equal(native.receipt.operationType, native.request.operation.type);
    if (native.request.operation.type !== "scan-directory")
      assert(
        native.request.lane,
        "Every copy/capture/check needs the owned serial lane",
      );
    assert.equal("head" in native.receipt, false);
  }
  const failed = nativeReceipt(
    effectFor(compiled.references.outputs.check.outcome),
    "check-directory",
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
    "The actual planted pricing failure must trigger repair",
  );
  const checked = nativeReceipt(
    effectFor(compiled.references.outputs["final-check"].outcome),
    "check-directory",
  );
  assert.equal(checked.receipt.outcome, "succeeded");
  assert.equal(checkProcess(checked.receipt)?.exitCode, 0);
  assert(
    checkProcess(checked.receipt).stdout.includes("ARC_TEAM_CHECK_PASSED"),
  );
  assert.equal(
    natives.filter(
      (value) =>
        value.request.operation.type === "check-directory" &&
        value.receipt.outcome === "succeeded",
    ).length,
    2,
    "Actual repair recheck and final required check must both pass",
  );
  for (const check of [
    failed,
    ...natives.filter(
      (value) =>
        value.request.operation.type === "check-directory" &&
        value.receipt.outcome === "succeeded",
    ),
  ]) {
    assert.deepEqual(
      check.receipt.before,
      check.receipt.after,
      "Checks must leave their full candidate inventory unchanged",
    );
    assert.equal(
      check.candidate.manifestDigest,
      check.receipt.after.manifestDigest,
    );
  }
  const reviewer = effectFor(compiled.references.outputs.review.outcome);
  const verdict = directoryRuntimeReceiptSchema.parse(
    reviewer.observation?.receipt,
  );
  assert.equal(verdict.kind, "directory-agent");
  assert.equal(verdict.review?.kind, "directory");
  assert.equal(verdict.review.outcome, "approved");
  assert.equal(verdict.review.snapshotId, view.verification.snapshotId);
  assert.equal(verdict.review.manifestDigest, view.verification.manifestDigest);
  assert(
    report.transcripts[verdict.threadId].tools.some(
      (tool) =>
        tool.tool.includes("arc_run_review") && tool.status === "completed",
    ),
  );
  assert.equal(checked.candidate.snapshotId, verdict.review.snapshotId);
  assert.equal(checked.candidate.manifestDigest, verdict.review.manifestDigest);
  assert.notEqual(verdict.workspace.path, checked.receipt.after.path);
  assert.notEqual(verdict.workspace.path, checked.candidate.workspace.path);
  const finalPath = view.verification.workspacePath;
  const finalFingerprint = await directoryFingerprint(finalPath);
  assert.equal(
    finalFingerprint.state.manifestDigest,
    view.verification.manifestDigest,
  );
  assert.deepEqual(
    finalFingerprint.state.rootIdentity,
    checked.candidate.workspace.rootIdentity,
  );
  assert.equal(finalPath, checked.candidate.workspace.path);
  for (const gate of compiled.references.finalGates) {
    const item = effectFor(gate.verify);
    assert.equal(item.effect.state, "succeeded");
    assert.equal(item.observation.validity?.state, "current");
    assert(
      item.observation.validity.validationId,
      "Final verification requires retained tagged scan evidence",
    );
    const receipt = directoryRuntimeReceiptSchema.parse(
      item.observation.receipt,
    );
    assert.equal(receipt.kind, "directory-native");
    assert.equal(receipt.request.operation.type, "scan-directory");
    assert.equal(receipt.receipt.artifact.kind, "inspection");
    assert.equal(receipt.candidate.snapshotId, verdict.review.snapshotId);
    assert.equal(
      receipt.candidate.manifestDigest,
      verdict.review.manifestDigest,
    );
  }
  const workers = report.effects.filter(
    (item) => item.observation?.receipt?.kind === "directory-agent",
  );
  assert.equal(workers.length, expectedWorkerCalls);
  report.nativeWorkers = [];
  const workerEvidence = [];
  for (const item of workers) {
    const receipt = directoryRuntimeReceiptSchema.parse(
      item.observation.receipt,
    );
    const node = compiled.nodes[runtimeNodeKey(item.effect)];
    assert.equal(node.kind, "agent");
    assert.equal(item.effect.attempt, 1);
    assert.equal(receipt.terminalStatus, "completed");
    const transcript = report.transcripts[receipt.threadId];
    assert.equal(transcript.accepted.length, 1);
    assert.equal(transcript.completed.length, 1);
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
    const dispatchProof = {
      ...chain,
      providerEvidence: thread,
      provisioning: await preparedWorkerProvisioning(
        item,
        receipt,
        thread,
        chain,
      ),
    };
    const key = `${item.effect.effectId}:native-accepted:${receipt.turnRequestId}`;
    report.nativeWorkers.push({
      effectId: item.effect.effectId,
      memberId: node.memberId,
      purpose: node.purpose,
      threadId: receipt.threadId,
      key,
      accepted: chain.accepted,
      completed: chain.completed,
      dispatchProof,
    });
    const output = await directoryFingerprint(receipt.workspace.path);
    assert.deepEqual(
      output.state,
      receipt.observed,
      "Settled worker evidence remains independently inspectable",
    );
    const input = await directoryFingerprint(receipt.snapshot.workspace.path);
    assert.equal(input.state.manifestDigest, receipt.snapshot.manifestDigest);
    const inputEntries = new Map(
      input.manifest.entries.map((entry) => [entry.path, entry]),
    );
    const outputEntries = new Map(
      output.manifest.entries.map((entry) => [entry.path, entry]),
    );
    const changed = [
      ...new Set([...inputEntries.keys(), ...outputEntries.keys()]),
    ]
      .filter(
        (path) =>
          JSON.stringify(inputEntries.get(path)) !==
          JSON.stringify(outputEntries.get(path)),
      )
      .sort();
    assert.deepEqual(
      changed,
      node.purpose === "writer"
        ? ["src/backend.mjs", "src/frontend.mjs"]
        : node.purpose === "repair"
          ? ["shared/pricing.mjs"]
          : [],
    );
    workerEvidence.push({
      purpose: node.purpose,
      path: receipt.workspace.path,
      sourceSnapshot: receipt.snapshot,
      observed: receipt.observed,
      changed,
      accepted: chain.accepted,
      completed: chain.completed,
    });
  }
  workerEvidence.sort((a, b) => a.accepted.createdAt - b.accepted.createdAt);
  assert.deepEqual(
    workerEvidence.map((worker) => worker.purpose),
    ["writer", "repair", "review"],
  );
  for (let index = 1; index < workerEvidence.length; index++)
    assert(
      workerEvidence[index - 1].completed.createdAt <=
        workerEvidence[index].accepted.createdAt,
      "Actual directory worker turns must be serial",
    );
  const repair = workerEvidence.find((worker) => worker.purpose === "repair");
  assert.equal(repair.sourceSnapshot.snapshotId, failed.candidate.snapshotId);
  assert.equal(
    repair.sourceSnapshot.manifestDigest,
    failed.candidate.manifestDigest,
  );
  assert.notEqual(
    repair.path,
    failed.candidate.workspace.path,
    "Repair requires a fresh working copy",
  );
  const failedFingerprint = await directoryFingerprint(
    failed.candidate.workspace.path,
  );
  assert.equal(
    failedFingerprint.state.manifestDigest,
    failed.candidate.manifestDigest,
  );
  assert.equal(
    await readFile(
      resolve(failed.candidate.workspace.path, "shared/pricing.mjs"),
      "utf8",
    ),
    await readFile(resolve(report.workspace, "shared/pricing.mjs"), "utf8"),
  );
  const sourceEntries = new Map(
    report.original.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const finalEntries = new Map(
    finalFingerprint.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const finalChanges = [
    ...new Set([...sourceEntries.keys(), ...finalEntries.keys()]),
  ]
    .filter(
      (path) =>
        JSON.stringify(sourceEntries.get(path)) !==
        JSON.stringify(finalEntries.get(path)),
    )
    .sort();
  assert.deepEqual(finalChanges, [
    "shared/pricing.mjs",
    "src/backend.mjs",
    "src/frontend.mjs",
  ]);
  const snapshots = natives.filter(
    (value) => value.receipt.artifact?.kind === "snapshot",
  );
  assert.equal(
    snapshots.length,
    3,
    "Original capture, builder capture and repaired capture must be immutable distinct snapshots",
  );
  assert.equal(
    new Set(
      snapshots.map((value) => value.receipt.artifact.snapshot.snapshotId),
    ).size,
    3,
  );
  for (const entry of snapshots) {
    const candidate = entry.receipt.artifact.snapshot;
    const actual = await directoryFingerprint(candidate.workspace.path);
    assert.equal(actual.state.manifestDigest, candidate.manifestDigest);
    assert.deepEqual(
      actual.state.rootIdentity,
      candidate.workspace.rootIdentity,
    );
  }
  await assertOriginalUnchanged();
  assert.equal(
    hash(
      await readFile(resolve(report.artifactDir, "required-check-source.mjs")),
    ),
    report.checkSourceHash,
  );
  await verifySetupInspection();
  const cliText = execFileSync(
    process.execPath,
    [resolve("apps/cli/dist/index.js"), "arc", "runs", "show", report.runId],
    {
      cwd: resolve("."),
      env: { ...process.env, BB_SERVER_URL: baseUrl },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
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
  report.finalEvidence = {
    snapshotId: view.verification.snapshotId,
    manifestDigest: view.verification.manifestDigest,
    finalPath,
    workerEvidence,
    failedCandidate: failed.candidate,
    repairedCandidate: checked.candidate,
    review: verdict.review,
    immutableSnapshots: snapshots.map(
      (value) => value.receipt.artifact.snapshot,
    ),
    finalChanges,
    originalUnchanged: true,
    cliParity: true,
  };
}

async function verifySetupInspection() {
  const dataDir = resolveRuntimeDataDir({
    mode: "dev",
    env: process.env,
    homeDir: homedir(),
    repoRoot: resolve("."),
  });
  const databasePath = resolve(dataDir, "plugins", "arc", "data.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT * FROM arc_directory_setups WHERE project_id=? AND validation_id=?",
      )
      .get(report.projectId, report.request.sourceInspectionId);
    assert(row);
    const intent = JSON.parse(row.intent_json);
    const job = JSON.parse(row.job_json);
    const record = JSON.parse(row.record_json);
    const consumed = JSON.parse(row.consumed_json);
    assert.equal(row.request_hash, runtimeHash(intent));
    assert.equal(intent.originThreadId, report.originThreadId);
    assert.equal(intent.hostId, report.hostId);
    assert.equal(intent.path, report.workspace);
    assert.equal(intent.providerId, report.providerId);
    assert.equal(job.operation.type, "scan-directory");
    assert.equal(job.operation.validationId, report.request.sourceInspectionId);
    assert.equal(record.requestHash, directoryEffectRequestHash(job));
    assert.equal(record.state, "terminal");
    assert.equal(record.receipt.outcome, "succeeded");
    assert.equal(record.receipt.artifact.kind, "inspection");
    assert.deepEqual(record.receipt.artifact.state, report.original.state);
    assert.equal(consumed.runId, report.runId);
    assert.equal(consumed.requestHash, runtimeHash(report.request));
    const finalValidations = [];
    const compiled = compileArcDirectoryRun(report.latest.definition);
    const finalRefs = compiled.references.finalGates.map((gate) => gate.verify);
    const selectedFinal = db
      .prepare(
        `SELECT effect_id AS effectId FROM arc_run_effects WHERE run_id=? AND (${finalRefs.map(() => "(node_id=? AND iteration=?)").join(" OR ")}) AND json_extract(observation_json, '$.state')='succeeded' ORDER BY created_at DESC, attempt DESC LIMIT 1`,
      )
      .get(
        report.runId,
        ...finalRefs.flatMap((ref) => [ref.nodeId, ref.iteration]),
      );
    assert(
      selectedFinal,
      "The public verification needs an exact retained final effect",
    );
    const publicVerification = report.latest.verification;
    assert.equal(typeof publicVerification.checkedAt, "string");
    assert(Number.isFinite(Date.parse(publicVerification.checkedAt)));
    let selectedProof = null;
    for (const gate of compiled.references.finalGates) {
      const item = effectFor(gate.verify);
      const validationId = item.observation.validity.validationId;
      const validation = db
        .prepare(
          "SELECT * FROM arc_directory_validations WHERE validation_id=? AND effect_id=?",
        )
        .get(validationId, item.effect.effectId);
      assert(validation, "Final proof must have exact retained scan jobs");
      assert.equal(validation.quiescent, 0);
      const validationIntent = JSON.parse(validation.intent_json);
      const jobs = JSON.parse(validation.jobs_json);
      const records = JSON.parse(validation.records_json);
      assert.equal(validationIntent.runId, report.runId);
      assert.equal(validationIntent.effectId, item.effect.effectId);
      assert.equal(
        validationIntent.generation,
        report.latest.workflow.dispatchGeneration,
      );
      assert.equal(jobs.length, validationIntent.targets.length);
      const states = [];
      const timestamps = [];
      for (const [index, job] of jobs.entries()) {
        const record = records[job.effectId];
        assert.equal(record.state, "terminal");
        assert.equal(record.requestHash, directoryEffectRequestHash(job));
        assert.equal(record.receipt.outcome, "succeeded");
        const artifact = record.receipt.artifact;
        assert.equal(artifact.kind, "inspection");
        assert.equal(artifact.validationId, validationId);
        assert.equal(artifact.consumer.effectId, item.effect.effectId);
        assert.equal(
          artifact.consumer.dispatchGeneration,
          validationIntent.generation,
        );
        assert.equal(
          artifact.state.path,
          validationIntent.targets[index].expected.path,
        );
        assert.deepEqual(
          artifact.state.rootIdentity,
          validationIntent.targets[index].expected.rootIdentity,
        );
        assert.equal(
          artifact.state.manifestDigest,
          validationIntent.targets[index].expected.manifestDigest,
        );
        const actual = await directoryFingerprint(artifact.state.path);
        assert.deepEqual(actual.state, artifact.state);
        states.push(artifact.state);
        timestamps.push(artifact.checkedAt);
      }
      assert.equal(
        item.observation.validity.identityHash,
        runtimeHash({ contextHash: validation.context_hash, states }),
      );
      if (item.effect.effectId === selectedFinal.effectId) {
        const candidate = item.observation.receipt.candidate;
        assert.equal(candidate.snapshotId, publicVerification.snapshotId);
        assert.equal(
          candidate.manifestDigest,
          publicVerification.manifestDigest,
        );
        assert.equal(
          candidate.workspace.path,
          publicVerification.workspacePath,
        );
        for (const target of [
          report.latest.definition.source,
          {
            path: candidate.workspace.path,
            rootIdentity: candidate.workspace.rootIdentity,
            manifestDigest: candidate.manifestDigest,
          },
        ])
          assert(
            validationIntent.targets.some(
              ({ expected }) =>
                expected.path === target.path &&
                runtimeHash(expected.rootIdentity) ===
                  runtimeHash(target.rootIdentity) &&
                expected.manifestDigest === target.manifestDigest,
            ),
            "The selected timestamp proof must cover the original source and exact final candidate",
          );
        const checkedAt = timestamps.sort().at(-1) ?? null;
        assert.equal(publicVerification.checkedAt, checkedAt);
        selectedProof = {
          effectId: item.effect.effectId,
          validationId,
          checkedAt,
        };
      }
      finalValidations.push({ validationId, validationIntent, jobs, records });
    }
    assert(
      selectedProof,
      "The public timestamp must match one exact retained proof",
    );
    report.finalVerificationProof = selectedProof;
    report.setupInspection = {
      databasePath,
      readOnly: true,
      intent,
      job,
      record,
      consumed,
    };
    report.finalValidations = finalValidations;
  } finally {
    db.close();
  }
}

function assertParentNativeEvents(parent) {
  for (const kind of ["requested", "accepted", "started", "completed"]) {
    assert(
      report.mainCompletion,
      "The automatic response needs exact native evidence",
    );
    assert.deepEqual(
      parent[kind],
      [...report.parentBaseline[kind], report.mainCompletion[kind]],
      "Only the separately counted response may follow the initial main request",
    );
  }
}

async function verifyWorkspaceAndParent() {
  await poll(
    "three completed directory workers in the live Workspace",
    60_000,
    async () => {
      const view = await rpc(arcWorkspaceRpcContract, "getWorkspace", {
        runId: report.runId,
        cursor: null,
        eventLimit: 100,
      });
      report.workspaceView = view;
      return (
        view.workers.length === expectedWorkerCalls &&
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
  assert.equal(report.animations.length, expectedWorkerCalls);
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
    "passive completion notices for all three directory workers",
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
  assert.equal(completionNotices.length, expectedWorkerCalls);
  assert.equal(
    new Set(completionNotices.map((notice) => notice.operationId)).size,
    expectedWorkerCalls,
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
  assert.equal(runtimeHash(report.request), report.requestHash);
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
    "actual serial builder, failed check, fresh-copy repair, snapshot review and counted main response",
    20 * 60_000,
    async () => {
      const current = await snapshot();
      assertLiveState(current);
      assert(current.workflow.agentCalls <= expectedAgentCalls);
      return (
        current.workflow.state === "succeeded" &&
        current.verification.state === "current"
      );
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
  {
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
        candidate.definition.schemaVersion !== 4 ||
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
          ? `Restart the same ARC server and daemon, then run: node --conditions=source --import tsx scripts/arc-directory-runtime-smoke.mjs resume "${reportPath}" "${baseUrl}"`
          : null,
    }),
  );
}

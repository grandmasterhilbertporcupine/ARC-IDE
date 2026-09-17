import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute } from "node:path";
import { createNodeBbSdk } from "../packages/sdk/src/node.ts";
import { arcAgentsRpcContract } from "../plugins/arc/contract.ts";
import {
  defaultAgentMetadata,
  serializeAgentDocument,
} from "../plugins/arc/document.ts";
import {
  arcTeamsRpcContract,
  arcTeamAssistantRpcContract,
} from "../plugins/arc/teams/contract.ts";
import { canonicalTeamDefinition } from "../plugins/arc/teams/validation.ts";

if (process.argv[2] === "--help") {
  console.log(
    "Usage: node --conditions=source --import tsx scripts/arc-team-authoring-smoke.mjs [phase3-result.json]\nVerifies Team authoring through the real UI, SDK, CLI and one native Codex assistant in the retained disposable Phase 3 project. Requires stable ARC app/API on 12008/20008. Retains all records and evidence.",
  );
  process.exit(0);
}
assert.equal(process.platform, "win32");
const sourcePath = resolve(
  process.argv[2] ??
    ".arc-verification/team-runtime/2026-09-10T07-29-14-289Z-43a94d2a/result.json",
);
const relativeSource = relative(
  resolve(".arc-verification/team-runtime"),
  sourcePath,
);
assert(
  relativeSource &&
    !relativeSource.startsWith("..") &&
    !isAbsolute(relativeSource),
);
const source = JSON.parse(await readFile(sourcePath, "utf8"));
assert.equal(source.harness, "ARC_TEAM_RUNTIME_SMOKE_V1");
assert(source.passed);
const baseUrl = "http://127.0.0.1:20008";
const appUrl = "http://127.0.0.1:12008";
const artifactDir = resolve(
  ".arc-verification/team-authoring-native",
  `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
);
await mkdir(artifactDir, { recursive: true });
const report = {
  harness: "ARC_TEAM_AUTHORING_SMOKE_V1",
  passed: false,
  startedAt: new Date().toISOString(),
  stage: "preflight",
  sourcePath,
  artifactDir,
  projectId: source.projectId,
  teamId: null,
  threadId: null,
  errors: [],
  screenshots: [],
};
const save = () =>
  writeFile(
    resolve(artifactDir, "result.json"),
    JSON.stringify(report, null, 2),
  );
const sdk = createNodeBbSdk({ baseUrl, timeoutMs: 45000 });
const contracts = {
  ...arcAgentsRpcContract,
  ...arcTeamsRpcContract,
  ...arcTeamAssistantRpcContract,
};
const rpc = (method, input) =>
  sdk.plugins.callRpc({
    pluginId: "arc",
    method,
    input,
    outputSchema: contracts[method].output,
  });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: source.workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  }).trim();
const original = async () => {
  assert.equal(git("rev-parse", "HEAD"), source.original.head);
  assert.equal(
    git("status", "--porcelain=v1", "--untracked-files=all"),
    source.original.status,
  );
  for (const [path, hash] of Object.entries(source.original.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(resolve(source.workspace, path)))
        .digest("hex"),
      hash,
    );
};
const scope = { kind: "library" };
const target = () => ({ teamId: report.teamId, scope });
const marker = `ARC_TEAM_CONTEXT_${randomUUID()}`;
const addition =
  " Review checklist: report changed files and the tests actually run.";
let browser;
let page;
let settled = false;
let rows = [];
async function poll(label, test, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(750);
  }
  throw new Error(`${label} did not pass within ${timeout} ms`);
}
async function screenshot(name) {
  const path = resolve(artifactDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}
function cli(args) {
  const env = { ...process.env, BB_SERVER_URL: baseUrl };
  for (const key of ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_CLI"])
    delete env[key];
  const result = spawnSync(
    process.execPath,
    [resolve("apps/cli/dist/index.js"), "arc", "teams", ...args],
    {
      env,
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

try {
  await save();
  await original();
  const project = await sdk.projects.get({ projectId: source.projectId });
  assert.equal(project.id, source.projectId);
  const metadata = defaultAgentMetadata("Team authoring acceptance builder");
  metadata.role = "Frontend builder and reviewer";
  let { agent } = await rpc("createAgent", {
    scope,
    document: serializeAgentDocument(
      metadata,
      "Build accessible interfaces and review the requested code. Report the actual verification evidence.",
    ),
  });
  ({ agent } = await rpc("publishAgentRevision", {
    scope,
    agentId: agent.id,
    expectedDraftVersion: agent.draft.version,
  }));
  const definition = {
    schemaVersion: 1,
    name: `Authoring acceptance ${randomUUID().slice(0, 6)}`,
    description: `Team source reference ${marker}.`,
    groups: [
      { id: "blue", name: "Blue team", color: "#4477bb", parentGroupId: null },
    ],
    members: [
      { id: "builder", agentId: agent.id, revision: 1, groupId: "blue" },
    ],
    permissions: [],
    graph: {
      nodes: [
        {
          id: "build",
          label: "Build interface",
          kind: "agent",
          memberId: "builder",
          task: "Build the requested interface.",
          access: "write",
          candidate: { kind: "source" },
        },
        {
          id: "check",
          label: "Test interface",
          kind: "check",
          command: { executable: "node", args: ["--test"], timeoutMs: 60000 },
          candidate: { kind: "node", nodeId: "build" },
        },
        {
          id: "review",
          label: "Review interface",
          kind: "review",
          memberId: "builder",
          task: "Review the exact checked candidate.",
          candidate: { kind: "node", nodeId: "build" },
        },
      ],
      edges: [
        {
          id: "build-check",
          source: "build",
          target: "check",
          sourceHandle: "next",
          requiredOutcome: "succeeded",
        },
        {
          id: "check-review",
          source: "check",
          target: "review",
          sourceHandle: "next",
          requiredOutcome: "succeeded",
        },
      ],
      entryNodeIds: ["build"],
      requiredGates: [
        { id: "verification", mode: "all", nodeIds: ["check", "review"] },
      ],
    },
    presentation: {
      nodes: [
        { nodeId: "build", x: 40, y: 80 },
        { nodeId: "check", x: 330, y: 80 },
        { nodeId: "review", x: 620, y: 80 },
      ],
      groups: [],
    },
  };
  const require = createRequire(
    "C:/Users/Collin Chen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json",
  );
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (error) =>
    report.errors.push({ kind: "page", message: error.message }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      report.errors.push({ kind: "console", message: message.text() });
  });
  report.stage = "ui-create-edit-publish";
  await save();
  await page.goto(`${appUrl}/plugins/arc/teams/library`, {
    waitUntil: "domcontentloaded",
  });
  const nameInput = page.getByRole("textbox", {
    name: "New team name",
    exact: true,
  });
  await nameInput.waitFor({ timeout: 120000 });
  await nameInput.fill(definition.name);
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await poll(
    "team created from the UI",
    async () => {
      const matches = await rpc("listTeams", {
        scope,
        search: definition.name,
        limit: 10,
        offset: 0,
      });
      if (matches.total === 0) return false;
      assert.equal(matches.total, 1);
      report.teamId = matches.teams[0].id;
      return true;
    },
    30000,
  );
  let { team } = await rpc("getTeam", target());
  assert.equal(team.draft.definition.graph.nodes.length, 0);
  await page.getByRole("button", { name: "Definition", exact: true }).click();
  await page
    .getByText("Canonical definition · advanced", { exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Canonical team JSON", exact: true })
    .fill(JSON.stringify(definition, null, 2));
  await page
    .getByRole("button", { name: "Apply JSON to draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await poll(
    "canonical definition saved from the UI",
    async () => {
      team = (await rpc("getTeam", target())).team;
      return team.draft.definition.graph.nodes.length === 3;
    },
    30000,
  );
  assert.equal(team.validation.valid, true, JSON.stringify(team.validation));
  assert.deepEqual(team.draft.definition, canonicalTeamDefinition(definition));
  await page
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await poll(
    "first published version from the UI",
    async () => {
      team = (await rpc("getTeam", target())).team;
      return team.currentRevision === 1;
    },
    30000,
  );
  const before = team;
  report.before = before;
  report.agentId = agent.id;
  report.uiAuthoring = {
    created: true,
    editSurface: "canonical-definition",
    saved: true,
    publishedRevision: 1,
  };
  report.stage = "ui-assistant-start";
  await save();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page
    .getByRole("button", { name: "Ask assistant", exact: true })
    .waitFor({ timeout: 120000 });
  await page
    .getByRole("button", { name: "Ask assistant", exact: true })
    .click();
  const prompt = page.getByRole("textbox", {
    name: "Ask the team assistant",
    exact: true,
  });
  await prompt.waitFor({ timeout: 60000 });
  await page
    .getByRole("combobox", { name: "Team assistant project", exact: true })
    .selectOption(source.projectId);
  await prompt.fill(
    `Help edit this selected team. First call arc_team_snapshot to inspect the exact bound draft, then arc_team_read for the latest saved draft. Use arc_team_propose to store exactly one proposed edit: append exactly this sentence to the existing description, preserving every other definition field: ${JSON.stringify(addition)}. Include evidence citing the current team description. Do not apply, publish, modify code or files, run shell commands, read unrelated material, inspect credentials or create other tasks. After the proposal succeeds, quote the original description and return the actual proposal ID.`,
  );
  await screenshot("assistant-ready-1920");
  await page
    .getByRole("button", { name: "Start assistant", exact: true })
    .click();
  await poll(
    "bound assistant session",
    async () => {
      const value = await rpc("listTeamSessions", {
        ...target(),
        limit: 10,
        offset: 0,
      });
      report.sessions = value;
      const bound = value.sessions.find((session) => session.threadId);
      if (!bound) return false;
      report.threadId = bound.threadId;
      report.executionContextId = bound.executionContextId;
      assert.equal(bound.draftVersion, before.draft.version);
      return true;
    },
    60000,
  );
  report.stage = "native-assistant";
  await save();
  console.log(
    JSON.stringify({
      stage: report.stage,
      teamId: team.id,
      threadId: report.threadId,
      artifactDir,
    }),
  );
  await poll(
    "native assistant completion",
    async () => {
      const batch = await sdk.threads.events.list({
        threadId: report.threadId,
        afterSeq: String(rows.at(-1)?.seq ?? 0),
        order: "asc",
        limit: "1000",
      });
      assert(
        batch.length < 1000,
        "Acceptance transcript must remain bounded and complete",
      );
      rows.push(...batch);
      await writeFile(
        resolve(artifactDir, "assistant-events.json"),
        JSON.stringify(rows, null, 2),
      );
      const thread = await sdk.threads.get({ threadId: report.threadId });
      report.thread = thread;
      if (["error", "blocked"].includes(thread.status))
        throw new Error(`Assistant reached ${thread.status}`);
      return (
        thread.status === "idle" &&
        rows.some(
          (row) =>
            row.type === "turn/completed" && row.data.status === "completed",
        )
      );
    },
    240000,
  );
  settled = true;
  const accepted = rows.filter((row) => row.type === "turn/input/accepted");
  const completed = rows.filter((row) => row.type === "turn/completed");
  assert.equal(accepted.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(accepted[0].scope.kind, "turn");
  assert.equal(completed[0].scope.kind, "turn");
  assert.equal(completed[0].scope.turnId, accepted[0].scope.turnId);
  assert.equal(completed[0].data.status, "completed");
  assert(accepted[0].data.clientRequestId);
  const requested = rows.find(
    (row) =>
      row.type === "client/turn/requested" &&
      row.data.requestId === accepted[0].data.clientRequestId,
  );
  assert(requested);
  report.nativeTurn = {
    turnId: accepted[0].scope.turnId,
    clientRequestId: accepted[0].data.clientRequestId,
    acceptedEventId: accepted[0].id,
    completedEventId: completed[0].id,
    providerId: report.thread.providerId,
    requestedEventId: requested.id,
    requestedExecution: requested.data.execution,
  };
  assert.equal(report.thread.originPluginId, "arc");
  assert.equal(
    report.thread.experimental_executionContextId,
    report.executionContextId,
  );
  assert.equal(report.thread.projectId, source.projectId);
  const tools = rows
    .filter(
      (row) =>
        row.type === "item/completed" && row.data.item.type === "toolCall",
    )
    .map((row) => ({ seq: row.seq, ...row.data.item }));
  report.tools = tools;
  assert(
    tools.every((tool) =>
      ["arc_team_snapshot", "arc_team_read", "arc_team_propose"].some((name) =>
        tool.tool.endsWith(name),
      ),
    ),
    "This acceptance permits only the three requested Team tools",
  );
  for (const name of ["arc_team_snapshot", "arc_team_read", "arc_team_propose"])
    assert(
      tools.some(
        (tool) => tool.tool.endsWith(name) && tool.status === "completed",
      ),
      `Missing successful native ${name}`,
    );
  assert(
    JSON.stringify(
      tools.find((tool) => tool.tool.endsWith("arc_team_snapshot")),
    ).includes(before.draft.contentHash),
  );
  report.output = (
    await sdk.threads.output({ threadId: report.threadId })
  ).output;
  assert(
    report.output.includes(marker),
    "Provider must report the context marker absent from its user prompt",
  );
  const proposals = await rpc("listTeamProposals", {
    ...target(),
    limit: 20,
    offset: 0,
    status: null,
  });
  assert.equal(proposals.total, 1);
  const proposal = proposals.proposals[0];
  assert.equal(proposal.authorThreadId, report.threadId);
  assert.equal(proposal.baseDraftVersion, before.draft.version);
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.beforeDefinition, before.draft.definition);
  assert.deepEqual(proposal.definition, {
    ...before.draft.definition,
    description: `${before.draft.definition.description}${addition}`,
  });
  assert.deepEqual((await rpc("getTeam", target())).team.draft, before.draft);
  report.proposal = proposal;
  report.streamedDeltas = rows.filter(
    (row) => row.type === "item/agentMessage/delta",
  ).length;
  assert(report.streamedDeltas > 0);
  await screenshot("assistant-completed-1920");
  report.stage = "review-apply-publish";
  await save();
  await page.getByRole("button", { name: "Suggestions", exact: true }).click();
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByText("Before", { exact: true }).click();
  await page.getByText("Proposed team", { exact: true }).click();
  await screenshot("review-exact-change-1920");
  await page
    .getByRole("button", { name: "Apply to draft", exact: true })
    .click();
  await poll(
    "reviewed proposal application",
    async () => {
      team = (await rpc("getTeam", target())).team;
      return (
        team.draft.version > before.draft.version &&
        team.draft.definition.description === proposal.definition.description
      );
    },
    30000,
  );
  await page
    .getByRole("button", { name: "Publish version", exact: true })
    .click();
  await poll(
    "second immutable revision",
    async () => {
      team = (await rpc("getTeam", target())).team;
      return team.currentRevision === 2;
    },
    30000,
  );
  assert.deepEqual(
    (await rpc("getTeamRevision", { ...target(), revision: 1 })).revision
      .definition,
    before.draft.definition,
  );
  report.after = team;
  report.cliShow = cli(["show", team.id]);
  assert.deepEqual(report.cliShow, { team });
  report.cliHistory = cli(["history", team.id]);
  const history = await rpc("listTeamRevisions", {
    ...target(),
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(report.cliHistory, history);
  const copy = await rpc("copyTeamToProject", {
    ...target(),
    revision: 2,
    projectId: source.projectId,
  });
  report.copy = copy;
  assert.equal(copy.team.scope.projectId, source.projectId);
  assert.equal(copy.team.sourceTeamId, team.id);
  assert.equal(copy.team.sourceRevision, 2);
  assert.notEqual(copy.team.draft.definition.members[0].agentId, agent.id);
  const copiedAgent = await rpc("getAgentRevision", {
    scope: copy.team.scope,
    agentId: copy.team.draft.definition.members[0].agentId,
    revision: 1,
  });
  const originalAgent = await rpc("getAgentRevision", {
    scope,
    agentId: agent.id,
    revision: 1,
  });
  assert.equal(
    copiedAgent.revision.contentHash,
    originalAgent.revision.contentHash,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "History", exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("heading", { name: `Version 2 · ${team.name}`, exact: true })
    .waitFor({ timeout: 30000 });
  await screenshot("published-history-reloaded-1920");
  await original();
  assert.deepEqual(report.errors, []);
  report.originalUnchanged = true;
  report.passed = true;
  report.stage = "passed";
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
  if (page) {
    try {
      await screenshot("failure");
    } catch {}
  }
} finally {
  if (report.threadId && !settled) {
    try {
      await sdk.threads.stop({ threadId: report.threadId });
      report.stoppedAfterFailure = true;
    } catch (error) {
      report.stopError = String(error);
    }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  await browser?.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      stage: report.stage,
      artifactDir,
      failure: report.failure ?? null,
    }),
  );
}

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createNodeBbSdk } from "../packages/sdk/src/node.ts";
import { arcAgentsRpcContract } from "../plugins/arc/contract.ts";
import {
  defaultAgentMetadata,
  serializeAgentDocument,
} from "../plugins/arc/document.ts";

const providerId = process.argv[2];
assert(
  ["codex", "claude-code"].includes(providerId),
  "Choose codex or claude-code explicitly for a real authenticated provider acceptance run.",
);
assert.equal(
  process.platform,
  "win32",
  "This harness verifies native Windows.",
);
const baseUrl = process.argv[3] ?? "http://127.0.0.1:20008";
assert.equal(
  new URL(baseUrl).hostname,
  "127.0.0.1",
  "Use only the local ARC verification installation.",
);
const sdk = createNodeBbSdk({ baseUrl, timeoutMs: 45_000 });
const artifactRoot = resolve(".arc-verification", `provider-${providerId}`);
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const artifactDir = resolve(artifactRoot, runId);
const workspace = resolve(artifactDir, "Native project Δ with spaces");
const inside = relative(artifactRoot, workspace);
assert(
  !inside.startsWith("..") && !isAbsolute(inside),
  "Verification workspace must stay inside its provider artifact directory.",
);
await mkdir(workspace, { recursive: true });
await writeFile(
  resolve(workspace, "README.md"),
  "# ARC provider acceptance fixture\n\nThis disposable repository contains no application data or credentials.\n",
  "utf8",
);
const git = (...args) =>
  execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
git("init", "--initial-branch=main");
git("add", "--", "README.md");
git(
  "-c",
  "core.hooksPath=.git/disabled-hooks",
  "-c",
  "user.name=ARC Acceptance Fixture",
  "-c",
  "user.email=arc-fixture@example.invalid",
  "-c",
  "commit.gpgSign=false",
  "commit",
  "-m",
  "Initialize disposable ARC provider fixture",
);
assert.equal(
  resolve(git("rev-parse", "--show-toplevel")),
  workspace,
  "Provider verification must never inherit ARC's own repository",
);
const reportPath = resolve(artifactDir, "result.json");
const report = {
  providerId,
  baseUrl,
  workspace,
  startedAt: new Date().toISOString(),
  projectId: null,
  agentId: null,
  model: null,
  sessions: [],
  phases: [],
  passed: false,
  fixtureCommit: git("rev-parse", "HEAD"),
};
const save = async () => {
  const json = JSON.stringify(report, null, 2);
  await writeFile(reportPath, json, "utf8");
  await writeFile(resolve(artifactRoot, "latest-result.json"), json, "utf8");
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const rpc = (method, input) =>
  sdk.plugins.callRpc({
    pluginId: "arc",
    method,
    input,
    outputSchema: arcAgentsRpcContract[method].output,
  });
const textInput = (text) => [{ type: "text", text, mentions: [] }];
const token = (name) => `ARC_${name}_${randomBytes(10).toString("hex")}`;
const identityMarker = token("PINNED");
const replacementMarker = token("REPLACED");
const referenceMarker = token("REFERENCE");
const replacementReference = token("NEW_REFERENCE");
const referenceName = "Guide Δ with spaces.md";
const streams = new Map();
const disposers = [];

function stream(threadId) {
  let state = streams.get(threadId);
  if (!state) {
    state = { rows: [], cursor: 0, changes: 0 };
    streams.set(threadId, state);
    disposers.push(
      sdk.subscribe({
        event: "thread:changed",
        threadId,
        callback: () => {
          state.changes += 1;
        },
      }),
    );
  }
  return state;
}

async function events(threadId) {
  const state = stream(threadId);
  const rows = await sdk.threads.events.list({
    threadId,
    afterSeq: String(state.cursor),
    order: "asc",
    limit: "1000",
  });
  state.rows.push(...rows);
  if (rows.length)
    state.cursor = Math.max(state.cursor, ...rows.map((row) => row.seq));
  return state;
}

function tools(rows) {
  return rows
    .filter(
      (row) =>
        row.type === "item/completed" && row.data.item.type === "toolCall",
    )
    .map((row) => ({ seq: row.seq, ...row.data.item }));
}

function agentText(rows) {
  return rows
    .filter((row) => row.type === "item/agentMessage/delta")
    .map((row) => row.data.delta ?? "")
    .join("");
}

async function settle(threadId, label, afterSeq = 0) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await events(threadId);
    const rows = state.rows.filter((row) => row.seq > afterSeq);
    const thread = await sdk.threads.get({ threadId });
    if (
      thread.status === "idle" &&
      rows.some((row) => row.type === "turn/completed")
    ) {
      const output = (await sdk.threads.output({ threadId })).output ?? "";
      const phase = {
        label,
        threadId,
        status: thread.status,
        streamedDeltas: rows.filter(
          (row) => row.type === "item/agentMessage/delta",
        ).length,
        realtimeChanges: state.changes,
        tools: tools(rows).map(({ seq, tool, status }) => ({
          seq,
          tool,
          status,
        })),
        output,
      };
      report.phases.push(phase);
      await writeFile(
        resolve(artifactDir, `${label}-events.json`),
        JSON.stringify(
          rows.filter(
            (row) =>
              row.type === "item/agentMessage/delta" ||
              (row.type === "item/completed" &&
                row.data.item.type === "toolCall") ||
              row.type === "turn/completed",
          ),
          null,
          2,
        ),
        "utf8",
      );
      await save();
      console.log(
        JSON.stringify({
          phase: label,
          threadId,
          status: thread.status,
          streamedDeltas: phase.streamedDeltas,
          tools: phase.tools,
        }),
      );
      return { rows, output };
    }
    if (["error", "blocked"].includes(thread.status)) {
      report.phases.push({
        label,
        threadId,
        status: thread.status,
        errors: rows
          .filter((row) => row.type === "system/error")
          .map((row) => row.data),
        tools: tools(rows).map(({ seq, tool, status }) => ({
          seq,
          tool,
          status,
        })),
      });
      await writeFile(
        resolve(artifactDir, `${label}-failure-events.json`),
        JSON.stringify(rows, null, 2),
        "utf8",
      );
      throw new Error(`${label} reached ${thread.status}`);
    }
    await delay(500);
  }
  await writeFile(
    resolve(artifactDir, `${label}-timeout-events.json`),
    JSON.stringify(stream(threadId).rows, null, 2),
    "utf8",
  );
  throw new Error(`${label} did not finish within 180 seconds`);
}

function requireTool(rows, name) {
  const found = tools(rows).find((item) => item.tool.includes(name));
  assert(found, `Expected an actual ${name} tool invocation`);
  assert.notEqual(found.status, "failed", `${name} failed`);
  return found;
}

function instructions(marker) {
  const longDefinition = Array.from(
    { length: 48 },
    (_, index) =>
      `Initial-check boundary ${index + 1}: use only the pinned ARC snapshot and reference tools for evidence; do not invent results or inspect unrelated sources.`,
  ).join("\n");
  return `You are an ARC acceptance agent in a disposable project. Do not inspect credentials, account information, environment variables, unrelated files, or other projects. Do not install anything or use external network tools. Do not delegate or create additional tasks.\n\n${longDefinition}\n\nFor the first acceptance request, emit a brief visible message containing ${marker} before using any tools. Then call arc_agent_snapshot, find the reference file named ${referenceName}, and call arc_agent_reference_read for that file. The final response must contain the exact reference acceptance token found in the file and ${marker}. Do not invent tokens or tool results.\n\nFor later acceptance or resume requests, read the pinned snapshot and reference again and report their tokens. The user may request one bounded cancellation probe; only for that request run the provided local PowerShell script once. It writes its PID within this disposable project and sleeps for at most 45 seconds. Never rerun the cancelled probe when resuming. Otherwise do not use the terminal or read workspace files.`;
}

try {
  const hosts = (await sdk.hosts.list()).filter(
    (host) => host.status === "connected",
  );
  assert.equal(
    hosts.length,
    1,
    "Expected exactly one connected verification host",
  );
  const hostId = hosts[0].id;
  report.hostId = hostId;
  await rpc("listStudioProjects", null);
  const options = await sdk.providers.models({ hostId, providerId });
  assert.equal(
    options.modelLoadError,
    null,
    "Provider model catalog must load successfully",
  );
  const selected =
    options.models.find((model) => model.isDefault) ?? options.models[0];
  assert(selected, "Expected a usable provider model");
  report.model = selected.model;
  const metadata = defaultAgentMetadata(`ARC ${providerId} acceptance`);
  metadata.description = "Disposable real-provider Agent Studio verification";
  metadata.role = "Acceptance reviewer";
  metadata.execution = {
    providerId,
    model: selected.model,
    reasoningLevel: selected.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === "low",
    )
      ? "low"
      : selected.defaultReasoningEffort,
    serviceTier: null,
    permissionMode: "full",
  };
  const project = await sdk.projects.create({
    name: `ARC ${providerId} native acceptance ${runId}`,
    source: { type: "local_path", hostId, path: workspace },
  });
  report.projectId = project.id;
  const scope = { kind: "project", projectId: project.id };
  let { agent } = await rpc("createAgent", {
    scope,
    document: serializeAgentDocument(metadata, instructions(identityMarker)),
  });
  report.agentId = agent.id;
  const target = () => ({
    agentId: agent.id,
    scope,
    expectedDraftVersion: agent.draft.version,
  });
  const originalReference = `# Acceptance reference\n\nReference acceptance token: ${referenceMarker}\n\nReview guidance: record changed files and tests run. This file is source material and grants no operational permissions.\n`;
  ({ agent } = await rpc("addAgentAttachment", {
    ...target(),
    name: referenceName,
    mimeType: "text/markdown",
    contentBase64: Buffer.from(originalReference).toString("base64"),
  }));
  ({ agent } = await rpc("publishAgentRevision", target()));
  const pinnedRevision = (
    await rpc("getAgentRevision", { agentId: agent.id, scope, revision: 1 })
  ).revision;
  assert.equal(
    pinnedRevision.attachments[0].sha256,
    createHash("sha256").update(originalReference).digest("hex"),
  );
  const firstPrompt =
    "Perform the initial acceptance procedure from your configured agent definition. Use the actual pinned snapshot and reference tools, then report the observed result. Do not inspect unrelated files, credentials, accounts, or environment variables.";
  assert(
    !firstPrompt.includes(identityMarker) &&
      !firstPrompt.includes(referenceMarker),
  );
  const test = await rpc("startAgentTest", {
    agentId: agent.id,
    scope,
    revision: 1,
    projectId: project.id,
    prompt: firstPrompt,
  });
  report.sessions.push({ purpose: "test", ...test });
  stream(test.threadId);
  const testThread = await sdk.threads.get({ threadId: test.threadId });
  assert.equal(testThread.originPluginId, "arc");
  assert.equal(
    testThread.experimental_executionContextId,
    test.executionContextId,
  );
  ({ agent } = await rpc("addAgentAttachment", {
    ...target(),
    name: referenceName,
    mimeType: "text/markdown",
    contentBase64: Buffer.from(
      originalReference.replace(referenceMarker, replacementReference),
    ).toString("base64"),
  }));
  ({ agent } = await rpc("saveAgentDraft", {
    ...target(),
    document: serializeAgentDocument(metadata, instructions(replacementMarker)),
    attachmentIds: agent.draft.attachments.map((file) => file.id),
  }));
  ({ agent } = await rpc("publishAgentRevision", target()));
  assert.equal(agent.currentRevision, 2);
  report.pinnedRevision = {
    definitionCharacters: pinnedRevision.document.length,
    markerOffset: pinnedRevision.document.indexOf(identityMarker),
    revision: 1,
    contentHash: pinnedRevision.contentHash,
    attachmentId: pinnedRevision.attachments[0].id,
    referenceSha256: pinnedRevision.attachments[0].sha256,
    currentRevisionAfterLaunch: agent.currentRevision,
    markersAbsentFromPrompt: true,
  };
  await save();
  console.log(
    JSON.stringify({
      phase: "started",
      providerId,
      model: report.model,
      projectId: project.id,
      threadId: test.threadId,
    }),
  );
  const first = await settle(test.threadId, "pinned-first-turn");
  const snapshotTool = requireTool(first.rows, "arc_agent_snapshot");
  const firstReferenceTool = requireTool(
    first.rows,
    "arc_agent_reference_read",
  );
  assert(
    JSON.stringify(firstReferenceTool).includes(referenceMarker),
    "The actual reference tool result must contain the original reference token",
  );
  assert(
    first.output.includes(identityMarker) &&
      first.output.includes(referenceMarker),
    "Provider must report the tokens available only from the pinned definition and reference",
  );
  assert(
    !first.output.includes(replacementMarker) &&
      !first.output.includes(replacementReference),
    "Existing test must not use newer draft or reference content",
  );
  const beforeSnapshot = agentText(
    first.rows.filter((row) => row.seq < snapshotTool.seq),
  );
  assert(
    beforeSnapshot.includes(identityMarker),
    "Expected the configured identity token in provider text before the snapshot tool result",
  );
  report.pinnedRevision.identityBeforeSnapshotResult = true;
  assert(
    report.phases[0].streamedDeltas > 0,
    "Expected actual streamed provider deltas",
  );
  const probePath = resolve(workspace, "cancel-probe.ps1");
  const pidPath = resolve(workspace, "cancel-pid.txt");
  await writeFile(
    probePath,
    "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'cancel-pid.txt'), [string]$PID)\nStart-Sleep -Seconds 45\n",
    "utf8",
  );
  const cancelAfter = stream(test.threadId).cursor;
  await sdk.threads.send({
    threadId: test.threadId,
    mode: "auto",
    input: textInput(
      `Run this single bounded cancellation probe once: powershell.exe -NoProfile -NonInteractive -File "${probePath}". The script writes its own PID inside this disposable project and sleeps for 45 seconds. Do not read the script, inspect any other files, or run any other command. Wait for the command; I will cancel this turn.`,
    ),
  });
  let commandPid = null;
  const startDeadline = Date.now() + 75_000;
  while (Date.now() < startDeadline) {
    try {
      const value = Number(await readFile(pidPath, "utf8"));
      if (Number.isSafeInteger(value) && value > 0) {
        commandPid = value;
        break;
      }
    } catch {}
    await events(test.threadId);
    const current = await sdk.threads.get({ threadId: test.threadId });
    if (["error", "blocked"].includes(current.status))
      throw new Error(`Cancellation probe reached ${current.status}`);
    await delay(400);
  }
  assert(commandPid, "Provider did not start the bounded cancellation probe");
  process.kill(commandPid, 0);
  const stoppedAt = Date.now();
  await sdk.threads.stop({ threadId: test.threadId });
  let stopped = false;
  while (Date.now() - stoppedAt < 10_000) {
    try {
      process.kill(commandPid, 0);
    } catch {
      stopped = true;
      break;
    }
    await delay(150);
  }
  await events(test.threadId);
  report.phases.push({
    label: "cancellation",
    threadId: test.threadId,
    commandDescendantStopped: stopped,
    stoppedInMs: Date.now() - stoppedAt,
    interruptedEvent: stream(test.threadId).rows.some(
      (row) =>
        row.seq > cancelAfter && row.type === "system/thread/interrupted",
    ),
  });
  await save();
  assert(stopped, "The cancelled probe process survived runtime stop");
  const resumeAfter = stream(test.threadId).cursor;
  await sdk.threads.send({
    threadId: test.threadId,
    mode: "auto",
    input: textInput(
      "Resume the pinned acceptance check. Do not rerun the cancelled probe. Call the pinned snapshot and reference tools again, then report their original acceptance tokens. Do not use the terminal.",
    ),
  });
  const resumed = await settle(test.threadId, "resume", resumeAfter);
  requireTool(resumed.rows, "arc_agent_snapshot");
  requireTool(resumed.rows, "arc_agent_reference_read");
  assert(
    resumed.output.includes(identityMarker) &&
      resumed.output.includes(referenceMarker),
    "Resume must retain the original pinned revision and reference",
  );
  const assistantPrompt =
    "Help edit the selected saved agent. Read its latest draft and its attached reference using actual ARC tools. Propose appending a short Review checklist section requiring changed files and tests run. Preserve every JSON metadata value and the existing instructions. Include evidence citing the attached guide. Store exactly one real proposal using arc_agent_propose. Do not apply, publish, change execution settings, run shell commands, read unrelated files, inspect credentials/accounts/environment variables, or create other tasks. Return the proposal ID after the tool succeeds.";
  const assistant = await rpc("startAgentAssistant", {
    ...target(),
    projectId: project.id,
    prompt: assistantPrompt,
  });
  report.sessions.push({ purpose: "assistant", ...assistant });
  stream(assistant.threadId);
  await save();
  const authored = await settle(assistant.threadId, "assistant-proposal");
  requireTool(authored.rows, "arc_agent_read");
  requireTool(authored.rows, "arc_agent_snapshot");
  const assistantReferenceTool = requireTool(
    authored.rows,
    "arc_agent_reference_read",
  );
  assert(
    JSON.stringify(assistantReferenceTool).includes(replacementReference),
    "The assistant must read its newer pinned reference before proposing",
  );
  requireTool(authored.rows, "arc_agent_propose");
  const proposals = await rpc("listAgentProposals", {
    agentId: agent.id,
    scope,
    status: "pending",
  });
  const proposal = proposals.proposals.find(
    (item) => item.authorThreadId === assistant.threadId,
  );
  assert(
    proposal,
    "Expected a persisted pending proposal from the real assistant task",
  );
  assert.deepEqual(
    proposal.operationalChanges,
    [],
    "The assistant must preserve operational settings",
  );
  assert(
    proposal.evidence.length > 0,
    "Expected source evidence on the real proposal",
  );
  assert.equal(
    (await rpc("getAgent", { agentId: agent.id, scope })).agent.draft.document,
    agent.draft.document,
    "Proposal must not silently alter the draft",
  );
  ({ agent } = await rpc("applyAgentProposal", {
    ...target(),
    proposalId: proposal.id,
    confirmOperationalChanges: false,
  }));
  assert.equal(
    agent.currentRevision,
    2,
    "Applying a proposal must not publish it",
  );
  assert.equal(
    (
      await rpc("getAgentProposal", {
        agentId: agent.id,
        scope,
        proposalId: proposal.id,
      })
    ).proposal.status,
    "applied",
  );
  assert.equal(agent.draft.document, proposal.document);
  report.proposal = {
    id: proposal.id,
    authorThreadId: proposal.authorThreadId,
    status: "applied",
    changedFields: proposal.changedFields,
    evidence: proposal.evidence,
    publishedRevisionUnchanged: true,
    newDraftVersion: agent.draft.version,
  };
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const session of report.sessions)
    await sdk.threads.stop({ threadId: session.threadId }).catch(() => {});
  for (const dispose of disposers) dispose();
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      providerId,
      passed: report.passed,
      failure: report.failure ?? null,
      reportPath,
      phases: report.phases.map((phase) => phase.label),
    }),
  );
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { runSmoke } from "./smoke-arc-windows.mjs";
import { verifyTeamBuilderUi } from "./smoke-arc-team-ui.mjs";
import { verifyProviderHtml } from "./smoke-arc-provider-html.mjs";
import { approveOwnedFixturePlan } from "./smoke-arc-plan-approval.mjs";

const execute = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const textInput = (text) => [{ type: "text", text, mentions: [] }];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const inside = (root, path) => {
  const value = relative(resolve(root), resolve(path));
  assert(
    value &&
      !isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith(`..\\`) &&
      !value.startsWith("../"),
    "Provider acceptance must stay inside its owned smoke directory",
  );
  return resolve(path);
};
const instructions =
  "You are verifying ARC in a disposable fixture. Read arc_run_snapshot first. Work only in your assigned workspace and on explicitly assigned files. Do not inspect accounts, credentials, environment variables or unrelated repositories. Do not access the network, install dependencies, create subagents, commit, merge, push or deploy. Preserve check.mjs. Read assigned skills when relevant. When reviewing, remain read-only and call arc_run_review with the exact candidate HEAD and an honest verdict. Use arc_run_reports for dependency handoffs; never infer an unobserved report. Finish in one bounded turn.";

export async function verifyProviderTeams(context, options = {}) {
  const { baseUrl, root, daemon, pass, check, cli } = context;
  if (options.withUi && pass > 0) await verifyTeamBuilderUi(context);
  assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
  const artifacts = inside(root, join(root, "provider-team-acceptance"));
  await mkdir(artifacts, { recursive: true });
  const reportFile = join(artifacts, "result.json");
  const model = options.model ?? "gpt-5.6-sol";
  const gitExecutable = options.gitExecutable ?? "git";
  const nodeExecutable = options.nodeExecutable ?? cli.runtime;
  assert(
    isAbsolute(nodeExecutable),
    "Choose the absolute packaged or installed Node runtime",
  );
  const commandEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const checkScript = `$env:ELECTRON_RUN_AS_NODE='1'\n& '${nodeExecutable.replaceAll("'", "''")}' 'check.mjs' | Out-Default\nif ($null -eq $LASTEXITCODE) { exit 1 }\nexit $LASTEXITCODE`;
  const checkCommand = {
    executable: join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(checkScript, "utf16le").toString("base64"),
    ],
    timeoutMs: 30_000,
  };
  const json = async (path, body) => {
    const response = await fetch(`${baseUrl}/api/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    assert(
      response.ok,
      `${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`,
    );
    return text ? JSON.parse(text) : null;
  };
  const rpc = async (method, input) => {
    const result = await json(`plugins/arc/rpc/${method}`, input);
    assert.equal(
      result.ok,
      true,
      `${method}: ${JSON.stringify(result).slice(0, 2000)}`,
    );
    return result.result;
  };
  const git = async (workspace, ...args) =>
    (
      await execute(gitExecutable, args, {
        cwd: workspace,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  let report;
  const save = () =>
    writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (pass > 0) {
    report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(
      report.status,
      "passed",
      "First-pass provider acceptance did not finish",
    );
    const retained = await rpc("getRun", { runId: report.runId });
    assert.equal(retained.workflow.state, "succeeded");
    assert.equal(retained.verification.state, "current");
    assert.equal(retained.verification.head, report.finalHead);
    assert.equal(
      sha256(JSON.stringify(retained.definition)),
      report.definitionHash,
    );
    assert.equal(
      await git(report.workspace, "rev-parse", "HEAD"),
      report.sourceHead,
    );
    assert.equal(await git(report.workspace, "status", "--porcelain"), "");
    report.restarts ??= [];
    report.restarts.push({
      pass,
      verifiedAt: new Date().toISOString(),
      runId: report.runId,
      head: report.finalHead,
    });
    await save();
    check(
      "Packaged restart retained provider run identity, immutable definitions, verified candidate and untouched source",
    );
    return report;
  }
  report = {
    status: "running",
    providerId: "codex",
    model,
    startedAt: new Date().toISOString(),
    workspace: inside(artifacts, join(artifacts, "Team project Δ")),
    runId: null,
    projectId: null,
    ownedThreads: [],
    comparison:
      "Recovery stress comparison with asymmetric constraints, not a controlled efficiency baseline or savings benchmark",
    comparisonAsymmetry: {
      team: "Writers must preserve the deliberate pricing defect until a failed check triggers the required separate repair turn.",
      baseline:
        "The solo agent may repair every required file in its first turn and is not forced through a failing check or separate recovery turn.",
    },
  };
  await save();
  async function poll(label, duration, read) {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      const result = await read();
      if (result) return result;
      await sleep(2000);
    }
    throw new Error(
      `${label} exceeded its bounded ${duration / 1000}s deadline`,
    );
  }
  async function events(threadId) {
    const rows = [];
    let afterSeq = 0;
    for (let page = 0; page < 30; page++) {
      const next = await json(
        `threads/${encodeURIComponent(threadId)}/events?afterSeq=${afterSeq}&order=asc&limit=1000`,
      );
      assert(Array.isArray(next), "Expected native event array");
      rows.push(...next);
      if (next.length < 1000) return rows;
      afterSeq = Math.max(...next.map((event) => event.seq));
    }
    throw new Error(
      "Native event evidence exceeded the acceptance pagination bound",
    );
  }
  async function settleThread(threadId, label) {
    return poll(label, 240_000, async () => {
      const thread = await json(`threads/${encodeURIComponent(threadId)}`);
      if (["error", "blocked"].includes(thread.status))
        throw new Error(
          `${label} is ${thread.status}; inspect the retained owned conversation`,
        );
      if (thread.status !== "idle") return null;
      const rows = await events(threadId);
      if (!rows.some((row) => row.type === "turn/completed")) return null;
      await writeFile(
        join(artifacts, `${label}-events.json`),
        JSON.stringify(rows, null, 2),
      );
      assert(
        rows.some(
          (row) =>
            row.type === "turn/completed" && row.data.status === "completed",
        ),
        `${label} did not complete successfully`,
      );
      return rows;
    });
  }
  try {
    const catalog = await json(
      `system/execution-options?hostId=${encodeURIComponent(daemon.hostId)}&providerId=codex`,
    );
    assert.equal(
      catalog.modelLoadError,
      null,
      `Codex unavailable: ${JSON.stringify(catalog.modelLoadError)}`,
    );
    const selected = catalog.models.find((entry) => entry.model === model);
    assert(
      selected,
      `The connected Codex provider does not advertise requested model ${model}; no substitution was made`,
    );
    const execution = {
      providerId: "codex",
      model,
      reasoningLevel: selected.supportedReasoningEfforts.some(
        (entry) => entry.reasoningEffort === "low",
      )
        ? "low"
        : selected.defaultReasoningEffort,
      serviceTier: "default",
      permissionMode: "full",
    };
    report.execution = execution;
    check("Native Codex catalog advertises the exact requested provider model");
    if (options.withUi)
      await verifyTeamBuilderUi(context, { templateExecution: execution });
    const marker = `ARC_RECEIPT_${randomUUID().replaceAll("-", "")}`;
    const files = {
      ".gitattributes": "check.mjs text eol=lf\n",
      "README.md":
        "# Disposable ARC provider fixture\nRead docs/spec.md for the receipt label. Implement the two source modules, retaining check.mjs.\n",
      "docs/spec.md": Array.from({ length: 900 }, (_, line) =>
        line === 611
          ? `RECEIPT_LABEL=${marker}\nUnit price is 100 cents. A quote contains quantity, total and label.\n`
          : `Reference ${line + 1}: Unrelated historical note; it does not define receipt behavior.\n`,
      ).join(""),
      "src/format.mjs":
        "export function receiptLabel() { throw new Error('not implemented'); }\n",
      "src/quote.mjs":
        "export function quote(quantity) { throw new Error('not implemented'); }\n",
      "shared/pricing.mjs":
        "export const totalPrice = quantity => quantity * 100 + 1;\n",
      "check.mjs": `import assert from 'node:assert/strict';\nimport {receiptLabel} from './src/format.mjs';\nimport {quote} from './src/quote.mjs';\nassert.equal(receiptLabel(), ${JSON.stringify(marker)});\nassert.deepEqual(quote(2), {quantity:2,total:200,label:${JSON.stringify(marker)}});\nassert.throws(()=>quote(0));\nassert.throws(()=>quote(1.5));\nconsole.log('ARC_COMBINED_CHECK_OK');\n`,
    };
    for (const [path, contents] of Object.entries(files)) {
      const destination = inside(
        report.workspace,
        join(report.workspace, path),
      );
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, contents);
    }
    await git(report.workspace, "init", "--initial-branch=main");
    for (const [key, value] of Object.entries({
      "user.name": "ARC acceptance",
      "user.email": "arc-acceptance@example.invalid",
      "commit.gpgSign": "false",
    }))
      await git(report.workspace, "config", "--local", key, value);
    await git(report.workspace, "add", "--", ".");
    await git(
      report.workspace,
      "-c",
      "core.hooksPath=.git/disabled-hooks",
      "commit",
      "-m",
      "Initialize disposable native team fixture",
    );
    assert.equal(
      resolve(await git(report.workspace, "rev-parse", "--show-toplevel")),
      report.workspace,
    );
    report.sourceHead = await git(report.workspace, "rev-parse", "HEAD");
    report.checkHash = sha256(files["check.mjs"]);
    const project = await json("projects", {
      name: "ARC native visual team acceptance",
      source: {
        type: "local_path",
        hostId: daemon.hostId,
        path: report.workspace,
      },
    });
    report.projectId = project.id;
    const scope = { kind: "project", projectId: project.id };
    const spawn = async (path, title, prompt) => {
      const thread = await json("threads", {
        projectId: project.id,
        title,
        environment: {
          type: "host",
          hostId: daemon.hostId,
          workspace: { type: "unmanaged", path },
        },
        ...execution,
        origin: "sdk",
        startedOnBehalfOf: null,
        originKind: null,
        input: textInput(prompt),
      });
      report.ownedThreads.push(thread.id);
      await save();
      return thread;
    };
    const skillProof = `ARC_SKILL_PROOF_${randomUUID().replaceAll("-", "")}`;
    const skill = (
      await rpc("saveAgentSkillBundle", {
        files: [
          {
            path: "SKILL.md",
            contentBase64: Buffer.from(
              "---\nname: bounded-reading\ndescription: Use when assigned to inspect large source or specification files.\n---\n\nSearch for the requested symbols first. Read only matching ranges. Report files, covered ranges, omissions and exact source evidence. Read this skill's references/proof.txt and include its exact proof phrase in your report's omissions field to verify that the assigned supporting file was available. Publish a bounded arc_run_report before completing.\n",
            ).toString("base64"),
            executable: false,
          },
          {
            path: "references/proof.txt",
            contentBase64: Buffer.from(skillProof).toString("base64"),
            executable: false,
          },
        ],
      })
    ).skill;
    const agents = {};
    for (const role of ["reader", "format", "quote", "reviewer"]) {
      const metadata = {
        schemaVersion: 2,
        name: `Acceptance ${role}`,
        description: "Disposable native verification",
        specialty: "",
        role,
        execution,
        skills: role === "reader" ? [{ id: skill.id, name: skill.name }] : [],
      };
      let { agent } = await rpc("createAgent", {
        scope,
        document: `---\n${JSON.stringify(metadata)}\n---\n\n${instructions}\n`,
      });
      ({ agent } = await rpc("publishAgentRevision", {
        scope,
        agentId: agent.id,
        expectedDraftVersion: agent.draft.version,
      }));
      agents[role] = {
        id: role,
        agentId: agent.id,
        revision: agent.currentRevision,
        groupId: null,
        role,
        responsibility:
          role === "reader"
            ? "Read and publish source evidence"
            : role === "reviewer"
              ? "Independently review the combined candidate"
              : `Own src/${role}.mjs`,
        leaderMemberId: null,
        skills: [],
      };
    }
    const candidate = (nodeId) => ({ kind: "node", nodeId });
    const edge = (
      source,
      target,
      requiredOutcome = "succeeded",
      sourceHandle = "next",
    ) => ({
      id: `${source}-${target}`,
      source,
      target,
      sourceHandle,
      requiredOutcome,
    });
    const nodes = [
      {
        id: "read",
        kind: "agent",
        label: "Read source",
        memberId: "reader",
        access: "read",
        candidate: { kind: "source" },
        task: "Inspect only docs/spec.md and the source/check files. Find RECEIPT_LABEL by a targeted search and bounded context read. Use arc_run_report with the exact label, required quote behavior, relevant file paths, covered line ranges, omissions and questions. Explain that shared/pricing.mjs deliberately has a one-cent defect reserved for repair. Do not edit files.",
      },
      {
        id: "format",
        kind: "agent",
        label: "Build formatting",
        memberId: "format",
        access: "write",
        candidate: { kind: "source" },
        task: "Call arc_run_reports and use the reader's source-pinned label. Edit only src/format.mjs to export receiptLabel() returning that exact label. Do not read docs/spec.md again or edit check.mjs or pricing. Finish after this one file.",
      },
      {
        id: "quote",
        kind: "agent",
        label: "Build quotes",
        memberId: "quote",
        access: "write",
        candidate: { kind: "source" },
        task: "Call arc_run_reports and use the reader's evidence. Edit only src/quote.mjs. Import totalPrice from ../shared/pricing.mjs and receiptLabel from ./format.mjs; export quote(quantity) that rejects nonpositive/noninteger quantities and returns {quantity,total:totalPrice(quantity),label:receiptLabel()}. Do not edit shared/pricing.mjs: preserve its deliberate one-cent bug for the check and repair phase. Do not read docs/spec.md again.",
      },
      {
        id: "integrate",
        kind: "integration",
        label: "Combine writers",
        writerNodeIds: ["format", "quote"],
        baseCandidate: { kind: "source" },
      },
      {
        id: "check",
        kind: "check",
        label: "Required failing check",
        candidate: candidate("integrate"),
        command: checkCommand,
      },
      {
        id: "repair",
        kind: "repair",
        label: "Repair one cent",
        body: {
          memberId: "quote",
          task: "The required combined check exposed the deliberate pricing error. Edit only shared/pricing.mjs so totalPrice(quantity) equals quantity * 100. Preserve all other files and check.mjs. ARC performs the native recheck.",
        },
        checkNodeId: "check",
        maxRounds: 1,
      },
      {
        id: "final-check",
        kind: "check",
        label: "Check repaired candidate",
        candidate: candidate("repair"),
        command: checkCommand,
      },
      {
        id: "review",
        kind: "review",
        label: "Independent combined review",
        memberId: "reviewer",
        candidate: candidate("repair"),
        task: "Inspect both source modules, pricing and check.mjs on this exact combined candidate. Verify exact required label, quote result and invalid inputs. Remain read-only; call arc_run_review with actual candidate HEAD, approved only if correct, findings otherwise. Do not rely on another member's approval.",
      },
    ];
    let { team } = await rpc("createTeam", {
      scope,
      definition: {
        schemaVersion: 2,
        name: "Native handoff and repair acceptance",
        description:
          "Actual provider turns with required source handoff, staged failure and independent review",
        leaderMemberId: null,
        groups: [],
        members: Object.values(agents),
        permissions: ["format", "quote"].map((member) => ({
          id: `review-${member}`,
          fromMemberId: "reviewer",
          toMemberId: member,
          action: "review",
        })),
        graph: {
          nodes,
          edges: [
            edge("read", "format"),
            edge("read", "quote"),
            edge("format", "integrate"),
            edge("quote", "integrate"),
            edge("integrate", "check"),
            edge("check", "repair", "failed"),
            edge("repair", "final-check", "succeeded", "repaired"),
            edge("final-check", "review"),
          ],
          entryNodeIds: ["read"],
          requiredGates: [
            {
              id: "final-evidence",
              mode: "all",
              nodeIds: ["final-check", "review"],
            },
          ],
        },
        presentation: {
          nodes: nodes.map((node, index) => ({
            nodeId: node.id,
            x: index * 260,
            y: 0,
          })),
          groups: [],
          members: [],
        },
      },
    });
    ({ team } = await rpc("publishTeamRevision", {
      scope,
      teamId: team.id,
      expectedDraftVersion: team.draft.version,
    }));
    const pin = { teamId: team.id, revision: team.currentRevision };
    const policy = await rpc("saveProjectPolicy", {
      projectId: project.id,
      expectedVersion: 0,
      policy: {
        schemaVersion: 1,
        autonomy: "collaborative",
        preferredTeams: [pin],
        restrictedTeams: [pin],
        limits: {
          maxConcurrentAgents: 1,
          maxAgentCalls: 6,
          maxRepairRounds: 1,
          maxActiveMs: 1_200_000,
        },
      },
    });
    const setup = await rpc("getRunSetup", {
      projectId: project.id,
      hostId: daemon.hostId,
    });
    assert.equal(setup.selected.head, report.sourceHead);
    assert.equal(setup.selected.clean, true);
    const goal =
      "Build the receipt fixture using a bounded reader handoff, independently combine two writers, observe the deliberate failing check, repair exactly one cent, and independently review the exact checked combined candidate. In the final response, report the observed verification, candidate identity and any remaining limitations. Do not start additional work or change the source checkout.";
    const addressing = {
      operationId: randomUUID(),
      recipients: [
        {
          pluginId: "arc",
          kind: "team",
          entityId: team.id,
          versionId: team.currentRevision,
          scopeKey: `project:${project.id}`,
          label: team.draft.definition.name,
        },
      ],
    };
    const addressedRequest = {
      projectId: project.id,
      title: "ARC addressed provider acceptance",
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: report.workspace },
      },
      ...execution,
      origin: "sdk",
      startedOnBehalfOf: null,
      originKind: null,
      input: textInput(goal),
      experimental_addressing: addressing,
    };
    const startedAt = Date.now();
    const attempts = await Promise.allSettled([
      json("threads", addressedRequest),
      json("threads", addressedRequest),
    ]);
    report.ownedThreads.push(
      ...new Set(
        attempts.flatMap((attempt) =>
          attempt.status === "fulfilled" ? [attempt.value.id] : [],
        ),
      ),
    );
    await save();
    for (const attempt of attempts)
      if (attempt.status === "rejected") throw attempt.reason;
    const [parent, duplicate] = attempts.map((attempt) => attempt.value);
    assert.equal(
      parent.id,
      duplicate.id,
      "Duplicate addressed spawn created two owner conversations",
    );
    report.originThreadId = parent.id;
    report.addressing = addressing;
    await save();
    const dispatch = await poll(
      "authoritative addressed dispatch",
      120_000,
      async () => {
        const rows = await events(parent.id);
        const operations = rows.filter(
          (row) =>
            row.type === "system/operation" &&
            row.data.operation === "addressed_dispatch" &&
            row.data.operationId === addressing.operationId,
        );
        const failed = operations.find((row) => row.data.status === "failed");
        assert(!failed, `Addressed dispatch failed: ${failed?.data.message}`);
        return (
          operations.find((row) => row.data.status === "completed") ?? null
        );
      },
    );
    report.runId = dispatch.data.metadata.result.runId;
    const duplicatedSend = await json(`threads/${parent.id}/send`, {
      mode: "auto",
      input: textInput(goal),
      experimental_addressing: addressing,
    });
    assert.equal(
      duplicatedSend.experimental_addressed.runId,
      report.runId,
      "Duplicate Send changed the admitted run",
    );
    const admitted = await rpc("getRun", { runId: report.runId });
    assert.equal(admitted.summary.runId, report.runId);
    assert.equal(admitted.definition.request.originThreadId, parent.id);
    assert.equal(admitted.definition.source.head, report.sourceHead);
    assert.equal(
      admitted.definition.request.expectedProjectPolicyVersion,
      policy.version,
    );
    assert.deepEqual(
      admitted.definition.request.addressedRecipients,
      addressing.recipients.map(
        ({ pluginId: _plugin, label: _label, ...pin }) => pin,
      ),
    );
    await writeFile(
      join(artifacts, "addressed-dispatch.json"),
      JSON.stringify(
        {
          request: addressedRequest,
          storedEvent: dispatch,
          duplicateSpawnThreadId: duplicate.id,
          duplicateSend: duplicatedSend,
        },
        null,
        2,
      ),
    );
    check(
      "Actual addressed spawn and duplicate Send resolved one retained run with exact published team, source and policy pins",
    );
    report.runId = admitted.summary.runId;
    report.definitionHash = sha256(JSON.stringify(admitted.definition));
    assert.deepEqual(
      admitted.definition.members.reader.definition.metadata.skills,
      [{ id: skill.id, name: skill.name }],
    );
    for (const member of Object.values(admitted.definition.members)) {
      assert.equal(member.execution.providerId, "codex");
      assert.equal(member.execution.model, model);
    }
    report.initialPlanApproval = await approveOwnedFixturePlan(
      rpc,
      admitted,
      artifacts,
    );
    await save();
    const complete = await poll("owned provider team", 1_200_000, async () => {
      const view = await rpc("getRun", { runId: report.runId });
      if (
        ["failed", "cancelled", "needs-reconciliation", "paused"].includes(
          view.workflow?.state,
        )
      )
        throw new Error(
          `Owned team stopped at ${view.workflow.state}; no replacement run will be created`,
        );
      return view.workflow?.state === "succeeded" ? view : null;
    });
    assert.equal(complete.verification.state, "current");
    assert.equal(complete.workflow.agentCalls, 6);
    assert(complete.workflow.repairRounds.some((entry) => entry.rounds === 1));
    report.finalHead = complete.verification.head;
    assert.equal(
      sha256(JSON.stringify(complete.definition)),
      report.definitionHash,
    );
    const effects = [];
    for (let offset = 0; ; offset += 100) {
      const page = await rpc("listRunEffects", {
        runId: report.runId,
        offset,
        limit: 100,
      });
      effects.push(...page.effects);
      if (offset + page.effects.length >= page.total) break;
      assert(offset < 1000, "Effect evidence exceeded the harness bound");
    }
    const retained = [];
    for (const effect of effects)
      retained.push(
        await rpc("getRunEffect", {
          runId: report.runId,
          effectId: effect.effectId,
        }),
      );
    await writeFile(
      join(artifacts, "effects.json"),
      JSON.stringify(retained, null, 2),
    );
    const receipts = retained
      .map((item) => item.observation?.receipt)
      .filter(Boolean);
    const mainReceipts = receipts.filter(
      (receipt) => receipt.kind === "orchestrator",
    );
    assert.equal(
      mainReceipts.length,
      1,
      "Expected one counted main-conversation completion",
    );
    assert.equal(mainReceipts[0].threadId, parent.id);
    assert.equal(mainReceipts[0].terminalStatus, "completed");
    const mainEvents = await settleThread(parent.id, "main-completion");
    assert.equal(
      mainEvents.filter(
        (row) =>
          row.type === "turn/completed" && row.data.status === "completed",
      ).length,
      1,
      "The owner consumed an unbudgeted provider turn",
    );
    const finalMessages = mainEvents.filter(
      (row) =>
        row.type === "item/completed" && row.data.item.type === "agentMessage",
    );
    assert(
      finalMessages.some((row) => row.data.item.text.trim()),
      "Counted main completion produced no visible assistant response",
    );
    report.mainCompletion = {
      receipt: mainReceipts[0],
      messages: finalMessages.map((row) => row.data.item),
    };
    report.teamElapsedMs = Date.now() - startedAt;
    const checks = receipts
      .filter((receipt) => receipt.kind === "native")
      .flatMap((receipt) => receipt.receipt.processes)
      .filter(
        (process) =>
          JSON.stringify(process.args) === JSON.stringify(checkCommand.args),
      );
    assert(
      checks.some(
        (process) => process.exitCode !== null && process.exitCode !== 0,
      ),
      "No actual failing check was retained",
    );
    assert(
      checks.filter((process) => process.exitCode === 0).length >= 2,
      "Repair recheck and final check must both succeed",
    );
    const workers = receipts.filter((receipt) => receipt.kind === "agent");
    assert.equal(
      workers.length,
      5,
      "Expected only reader, two writers, one repair and one reviewer",
    );
    const reviewed = workers.filter(
      (receipt) => receipt.review?.outcome === "approved",
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].review.candidateHead, report.finalHead);
    const reports = await rpc("listRunCollaboration", {
      runId: report.runId,
      kind: "reports",
      cursor: null,
      limit: 20,
    });
    assert(
      reports.reports.some(
        (entry) =>
          entry.memberId === "reader" &&
          entry.source.head === report.sourceHead &&
          entry.report.findings.includes(marker) &&
          entry.report.omissions.includes(skillProof),
      ),
      "No native source-pinned reader handoff carried both the source label and proof available only inside the pinned assigned skill",
    );
    await writeFile(
      join(artifacts, "handoffs.json"),
      JSON.stringify(reports, null, 2),
    );
    const workspaceView = await rpc("getWorkspace", {
      runId: report.runId,
      cursor: null,
      eventLimit: 100,
    });
    assert.equal(workspaceView.workersTruncated, false);
    const writers = workspaceView.workers.filter((worker) =>
      ["format", "quote"].includes(worker.graphNodeId),
    );
    assert.equal(writers.length, 2);
    const reviewWorker = workspaceView.workers.find(
      (worker) => worker.graphNodeId === "review",
    );
    assert.equal(reviewWorker?.agentId, agents.reviewer.agentId);
    assert(writers.every((worker) => worker.agentId !== reviewWorker.agentId));
    let handoffReaders = 0;
    for (const worker of workers) {
      const rows = await events(worker.threadId);
      assert.equal(
        rows.filter(
          (row) =>
            row.type === "turn/completed" && row.data.status === "completed",
        ).length,
        1,
        "Each admitted worker must consume one native turn",
      );
      await writeFile(
        join(artifacts, `worker-${worker.threadId}.json`),
        JSON.stringify(rows, null, 2),
      );
      if (
        writers.some((writer) => writer.threadId === worker.threadId) &&
        rows.some(
          (row) =>
            row.type === "item/completed" &&
            row.data.item.type === "toolCall" &&
            row.data.item.tool.includes("arc_run_reports") &&
            row.data.item.status === "completed",
        )
      )
        handoffReaders++;
    }
    assert(
      handoffReaders === 2,
      "Both real writers must inspect their dependency handoff",
    );
    const candidatePath = complete.verification.workspacePath;
    assert(candidatePath, "Missing final candidate workspace");
    inside(root, candidatePath);
    assert.equal(
      await git(candidatePath, "rev-parse", "HEAD"),
      report.finalHead,
    );
    assert.equal(
      sha256(await readFile(join(candidatePath, "check.mjs"))),
      report.checkHash,
    );
    await execute(nodeExecutable, ["check.mjs"], {
      cwd: candidatePath,
      env: commandEnv,
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(
      await git(report.workspace, "rev-parse", "HEAD"),
      report.sourceHead,
    );
    assert.equal(await git(report.workspace, "status", "--porcelain"), "");
    report.teamUsage = [];
    let nextOffset = 0;
    do {
      const page = await rpc("getRunUsage", {
        runId: report.runId,
        offset: nextOffset,
        limit: 50,
      });
      report.teamUsage.push(...page.workers);
      nextOffset = page.nextOffset;
    } while (nextOffset !== null);
    assert.equal(
      report.teamUsage.length,
      6,
      "Usage must include five workers and the counted main response",
    );
    assert(
      report.teamUsage.some(
        (worker) =>
          worker.threadId === parent.id && worker.name === "Main conversation",
      ),
      "Main completion usage was omitted",
    );
    const baselinePath = inside(
      artifacts,
      join(artifacts, "Baseline project Δ"),
    );
    await git(
      artifacts,
      "clone",
      "--no-hardlinks",
      "--",
      report.workspace,
      baselinePath,
    );
    for (const [key, value] of Object.entries({
      "user.name": "ARC acceptance",
      "user.email": "arc-acceptance@example.invalid",
      "commit.gpgSign": "false",
    }))
      await git(baselinePath, "config", "--local", key, value);
    check(
      "Five admitted Codex worker turns completed with source handoff, failing check, repair and independent combined review",
    );
    const baselineStarted = Date.now();
    const baseline = await spawn(
      baselinePath,
      "ARC matched fixture baseline",
      `In this disposable workspace, read docs/spec.md and implement src/format.mjs receiptLabel(), src/quote.mjs quote(quantity) and shared/pricing.mjs totalPrice(quantity). Return the exact required label, reject nonpositive/noninteger quantities, and charge 100 cents per unit. Run the packaged Node check through PowerShell: ${checkScript}. Preserve check.mjs. Work in one turn; do not use ARC tools, create subagents, inspect credentials or unrelated files, install dependencies, access network, commit or push. This is the single-agent baseline for the same required result.`,
    );
    const baselineEvents = await settleThread(baseline.id, "baseline");
    assert.equal(
      sha256(await readFile(join(baselinePath, "check.mjs"))),
      report.checkHash,
    );
    await execute(nodeExecutable, ["check.mjs"], {
      cwd: baselinePath,
      env: commandEnv,
      windowsHide: true,
      timeout: 30_000,
    });
    const usage = baselineEvents
      .filter((row) => row.type === "thread/tokenUsage/updated")
      .at(-1)?.data.tokenUsage.total;
    report.baseline = {
      threadId: baseline.id,
      elapsedMs: Date.now() - baselineStarted,
      checksPassed: true,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
    };
    assert.equal(
      baselineEvents.filter(
        (row) =>
          row.type === "turn/completed" && row.data.status === "completed",
      ).length,
      1,
    );
    report.usageAvailable =
      report.teamUsage.every(
        (worker) => worker.inputTokens !== null && worker.outputTokens !== null,
      ) &&
      report.baseline.inputTokens !== null &&
      report.baseline.outputTokens !== null;
    report.nativeProviderTurns = 7;
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await save();
    check(
      "Real Codex source-pinned reader handoff, two writer integration, failed check, bounded repair, independent exact-candidate review and baseline check passed",
    );
    return report;
  } catch (error) {
    report.status = report.runId === null ? "blocked" : "failed";
    report.error = error instanceof Error ? error.message : String(error);
    report.finishedAt = new Date().toISOString();
    const cleanupRuns = new Set(report.runId ? [report.runId] : []);
    for (const threadId of report.ownedThreads) {
      try {
        const rows = await events(threadId);
        for (const row of rows)
          if (
            row.type === "system/operation" &&
            row.data.operation === "addressed_dispatch" &&
            row.data.status === "completed" &&
            row.data.metadata?.result?.runId
          )
            cleanupRuns.add(row.data.metadata.result.runId);
      } catch {}
    }
    report.cleanupRuns = [];
    for (const runId of cleanupRuns) {
      const cleanup = {
        runId,
        status: "checking",
        cancellationRequested: false,
        lastObservedState: null,
        agentCalls: null,
        startedAt: new Date().toISOString(),
      };
      report.cleanupRuns.push(cleanup);
      try {
        const view = await rpc("getRun", { runId });
        assert(view.workflow, "Run has no observable workflow state");
        cleanup.lastObservedState = view.workflow.state;
        if (
          !["succeeded", "failed", "cancelled"].includes(view.workflow.state)
        ) {
          await rpc("controlRun", {
            runId,
            operationId: `stop-${randomUUID()}`,
            expectedVersion: view.workflow.controlVersion,
            action: "cancel",
          });
          cleanup.cancellationRequested = true;
        }
        const settled = await poll(
          "cancelled workflow settlement",
          30_000,
          async () => {
            const current = (await rpc("getRun", { runId })).workflow;
            cleanup.lastObservedState = current?.state ?? null;
            cleanup.agentCalls = current?.agentCalls ?? null;
            return current &&
              ["succeeded", "failed", "cancelled"].includes(current.state)
              ? current
              : null;
          },
        );
        cleanup.status = "settled";
        cleanup.controlVersion = settled.controlVersion;
      } catch (failure) {
        cleanup.status = "uncertain";
        cleanup.error =
          failure instanceof Error ? failure.message : String(failure);
        report.cleanupUncertain = true;
        report.cleanupError =
          failure instanceof Error ? failure.message : String(failure);
      } finally {
        cleanup.finishedAt = new Date().toISOString();
      }
    }
    for (const threadId of report.ownedThreads) {
      try {
        const thread = await json(`threads/${encodeURIComponent(threadId)}`);
        if (thread.status === "running")
          await json(`threads/${encodeURIComponent(threadId)}/stop`, {});
      } catch {}
    }
    await save();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "artifacts-parent": { type: "string" },
      "codex-bin": { type: "string" },
      "codex-home": { type: "string" },
      "git-bin": { type: "string" },
      model: { type: "string" },
      "with-ui": { type: "boolean" },
      "with-html-pair": { type: "boolean" },
      "html-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-provider-teams.mjs --executable <packaged ARC IDE.exe> [--model gpt-5.6-sol] [--with-ui] [--with-html-pair | --html-only] [--artifacts-parent <directory>] [--codex-bin <native codex.exe directory>] [--codex-home <existing authenticated Codex home>] [--git-bin <git.exe directory>]\nRuns seven actual bounded Codex turns: reader, two writers, repair, independent review, counted main completion and a matched-fixture baseline. --with-ui first exercises real Team/Workflow controls, skills, template copies and persistent recipients without extra provider turns. --with-html-pair adds a distinct five-turn HTML disclosure pair with real native Preview keyboard checks (twelve total turns). --html-only runs just that five-turn pair in a fresh owned profile. Uses isolated ARC data and fixture directories; no Node is added to PATH. Existing provider authentication is referenced in place, never copied or logged. Does not install, publish, push or replace a failed run.",
    );
  else {
    assert(
      !values["html-only"] || (!values["with-html-pair"] && !values["with-ui"]),
      "--html-only cannot be combined with --with-html-pair or --with-ui",
    );
    const nativeBin = resolve(
      values["codex-bin"] ??
        join(
          process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
        ),
    );
    const gitBin = resolve(values["git-bin"] ?? "C:/Program Files/Git/cmd");
    const codexHome = resolve(
      values["codex-home"] ??
        process.env.CODEX_HOME ??
        join(homedir(), ".codex"),
    );
    await access(join(nativeBin, "codex.exe"));
    await access(join(gitBin, "git.exe"));
    await runSmoke(
      values.executable ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../release/win-unpacked/ARC IDE.exe",
        ),
      {
        artifactsParent: values["artifacts-parent"],
        configureEnvironment: (env) => ({
          ...env,
          CODEX_HOME: codexHome,
          PATH: [env.PATH, nativeBin, gitBin].join(";"),
        }),
        verifyFeatures: async (context) => {
          if (!values["html-only"])
            await verifyProviderTeams(context, {
              model: values.model ?? "gpt-5.6-sol",
              gitExecutable: join(gitBin, "git.exe"),
              withUi: values["with-ui"] ?? false,
            });
          if (values["with-html-pair"] || values["html-only"])
            await verifyProviderHtml(context, {
              model: values.model ?? "gpt-5.6-sol",
              gitExecutable: join(gitBin, "git.exe"),
            });
        },
      },
    ).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

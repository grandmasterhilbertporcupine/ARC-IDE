import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { requireWithin } from "./smoke-arc-windows.mjs";
import { approveOwnedFixturePlan } from "./smoke-arc-plan-approval.mjs";

const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const input = (text) => [{ type: "text", text, mentions: [] }];

async function bounded(label, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(300);
  }
  throw Error(`${label} exceeded ${timeout / 1000}s`);
}

async function withCdp(connection, work) {
  const endpoint = new URL(connection.wsEndpoint);
  assert.equal(endpoint.protocol, "ws:");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let sequence = 0;
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.addEventListener("message", ({ data }) => {
    try {
      const message = JSON.parse(data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message));
      else request.resolve(message.result);
    } catch (error) {
      fail(error);
    }
  });
  socket.addEventListener("close", () =>
    fail(Error("Native preview CDP connection closed")),
  );
  socket.addEventListener("error", () =>
    fail(Error("Native preview CDP connection failed")),
  );
  let timeout;
  try {
    await Promise.race([
      new Promise((done, reject) => {
        socket.addEventListener("open", done, { once: true });
        socket.addEventListener("error", reject, { once: true });
      }),
      delay(10_000).then(() => {
        throw Error("Native preview CDP connection timed out");
      }),
    ]);
    return await Promise.race([
      work(
        (method, params = {}, sessionId) =>
          new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            socket.send(
              JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
              }),
            );
          }),
      ),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(Error("Native preview check exceeded 30s")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    fail(Error("Native preview check ended"));
    socket.close();
  }
}

export async function verifyProviderHtml(context, options) {
  const { baseUrl, root, daemon, pass, check, cli, debuggerClient } = context;
  const artifacts = requireWithin(root, join(root, "provider-html-acceptance"));
  await mkdir(artifacts, { recursive: true });
  const reportFile = join(artifacts, "result.json");
  const request = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45_000),
    });
    const value = await response.json();
    assert(
      response.ok,
      `${path}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 1000)}`,
    );
    return value;
  };
  const rpc = async (method, body) => {
    const result = await request(`/plugins/arc/rpc/${method}`, body);
    assert(result.ok, JSON.stringify(result).slice(0, 1000));
    return result.result;
  };
  const git = async (cwd, ...args) =>
    (
      await execute(options.gitExecutable, args, {
        cwd,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  const events = async (threadId) => {
    const values = [];
    let afterSeq = 0;
    for (let page = 0; page < 30; page++) {
      const rows = await request(
        `/threads/${threadId}/events?afterSeq=${afterSeq}&order=asc&limit=1000`,
      );
      values.push(...rows);
      if (rows.length < 1000) return values;
      afterSeq = Math.max(...rows.map((row) => row.seq));
    }
    throw Error("HTML native event evidence exceeded its bound");
  };
  if (pass > 0) {
    const previous = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(previous.status, "passed");
    const run = await rpc("getRun", { runId: previous.runId });
    assert.equal(run.workflow.state, "succeeded");
    assert.equal(run.verification.head, previous.finalHead);
    assert.equal(run.verification.state, "current");
    assert.equal(hash(JSON.stringify(run.definition)), previous.definitionHash);
    assert.equal(
      await git(previous.workspace, "rev-parse", "HEAD"),
      previous.sourceHead,
    );
    assert.equal(await git(previous.workspace, "status", "--porcelain"), "");
    check(
      "HTML paired acceptance retained exact verified run and source across packaged restart without another model call",
    );
    return previous;
  }
  const report = {
    status: "running",
    startedAt: new Date().toISOString(),
    comparison:
      "Second distinct matched fixture; two task pairs do not establish a general savings claim",
    checks: [],
    ownedThreads: [],
    previews: [],
    runId: null,
  };
  const save = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const node = cli.runtime;
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const workspace = requireWithin(
    artifacts,
    join(artifacts, "Disclosure project Δ"),
  );
  await mkdir(workspace, { recursive: true });
  report.workspace = workspace;
  let checkServer;
  let checking = false;
  let browserScope;
  let previewThread;
  let execution;
  const proof = `ARC_DISCLOSURE_${randomUUID().replaceAll("-", "")}`;
  const verifyPreview = async (candidatePath, label) => {
    const checkedPath = requireWithin(root, resolve(candidatePath));
    assert.equal(
      hash(await readFile(join(checkedPath, "check.mjs"))),
      report.checkHash,
      "Candidate weakened the native preview check",
    );
    let tab;
    let lease;
    const evidence = { label, candidatePath: checkedPath, passed: false };
    try {
      const html = await request("/files/previews", {
        hostId: daemon.hostId,
        rootPath: checkedPath,
      });
      const url = `${baseUrl}${html.baseUrl}/index.html`;
      tab = (
        await request("/desktop-browsers/create", {
          ...browserScope,
          url,
          presentation: "reveal",
        })
      ).tab;
      lease = await request("/desktop-browsers/acquire", {
        ...browserScope,
        tabIds: [tab.tabId],
        controllerLabel: "HTML acceptance keyboard check",
        ttlMs: 60_000,
      });
      const connection = await request("/desktop-browsers/connection", {
        ...browserScope,
        leaseId: lease.leaseId,
      });
      await withCdp(connection, async (send) => {
        const target = await bounded("native HTML target", async () =>
          (await send("Target.getTargets")).targetInfos.find(
            (item) => item.type === "page" && item.url === url,
          ),
        );
        const { sessionId } = await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        const command = (method, params = {}) =>
          send(method, params, sessionId);
        const evaluate = async (expression) => {
          const result = await command("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          assert(!result.exceptionDetails, "Native HTML evaluation failed");
          return result.result.value;
        };
        const press = async (key, code, keyCode, text) => {
          await command("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
            ...(text ? { text, unmodifiedText: text } : {}),
          });
          await command("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          });
        };
        await bounded("native disclosure document", () =>
          evaluate(
            "document.readyState==='complete'&&!!document.querySelector('#toggle')",
          ),
        );
        evidence.initial = await evaluate(
          "(()=>{const b=document.querySelector('#toggle'),p=document.querySelector('#details');return {tag:b.tagName,label:b.textContent.trim(),expanded:b.getAttribute('aria-expanded'),controls:b.getAttribute('aria-controls'),hidden:p.hidden,visible:!!p.getBoundingClientRect().height,proof:p.textContent.includes(" +
            JSON.stringify(proof) +
            "),font:getComputedStyle(document.body).fontFamily};})()",
        );
        const image = await command("Page.captureScreenshot", {
          format: "png",
        });
        const screenshot = requireWithin(
          artifacts,
          join(artifacts, `preview-${report.previews.length + 1}-${label}.png`),
        );
        await writeFile(screenshot, Buffer.from(image.data, "base64"));
        evidence.screenshot = screenshot;
        assert.equal(evidence.initial.tag, "BUTTON");
        assert.equal(evidence.initial.controls, "details");
        assert.equal(evidence.initial.expanded, "false");
        assert.equal(evidence.initial.hidden, true);
        assert.equal(evidence.initial.visible, false);
        assert.equal(evidence.initial.proof, true);
        await press("Tab", "Tab", 9);
        assert.equal(
          await evaluate("document.activeElement.id"),
          "toggle",
          "Tab must reach the native disclosure button",
        );
        await press("Enter", "Enter", 13, "\r");
        await bounded("Enter opens disclosure", () =>
          evaluate(
            "document.querySelector('#toggle').getAttribute('aria-expanded')==='true'&&!document.querySelector('#details').hidden&&document.querySelector('#details').getBoundingClientRect().height>0",
          ),
        );
        await press(" ", "Space", 32, " ");
        await bounded("Space closes disclosure", () =>
          evaluate(
            "document.querySelector('#toggle').getAttribute('aria-expanded')==='false'&&document.querySelector('#details').hidden",
          ),
        );
        await press("Enter", "Enter", 13, "\r");
        await bounded("second Enter opens disclosure", () =>
          evaluate("!document.querySelector('#details').hidden"),
        );
        await press("Escape", "Escape", 27);
        await bounded("Escape closes and retains focus", () =>
          evaluate(
            "document.querySelector('#toggle').getAttribute('aria-expanded')==='false'&&document.querySelector('#details').hidden&&document.activeElement.id==='toggle'",
          ),
        );
        await press("Tab", "Tab", 9);
        assert.equal(
          await evaluate("document.activeElement.id"),
          "after",
          "Tab must move to the next link without trapping focus",
        );
        evidence.passed = true;
        evidence.keys = ["Tab", "Enter", "Space", "Enter", "Escape", "Tab"];
      });
      return evidence;
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      report.previews.push(evidence);
      if (lease)
        await request("/desktop-browsers/release", {
          ...browserScope,
          leaseId: lease.leaseId,
        }).catch(() => {});
      if (tab)
        await request("/desktop-browsers/close", {
          ...browserScope,
          tabId: tab.tabId,
        }).catch(() => {});
      await save();
    }
  };
  try {
    const catalog = await request(
      `/system/execution-options?hostId=${daemon.hostId}&providerId=codex`,
    );
    assert.equal(catalog.modelLoadError, null);
    const selected = catalog.models.find(
      (entry) => entry.model === options.model,
    );
    assert(selected, `Provider does not advertise ${options.model}`);
    execution = {
      providerId: "codex",
      model: options.model,
      reasoningLevel: selected.supportedReasoningEfforts.some(
        (entry) => entry.reasoningEffort === "low",
      )
        ? "low"
        : selected.defaultReasoningEffort,
      serviceTier: "default",
      permissionMode: "full",
    };
    report.execution = execution;
    const endpointToken = randomUUID();
    checkServer = createServer(async (req, res) => {
      if (
        req.method !== "POST" ||
        req.url !== `/${endpointToken}` ||
        checking
      ) {
        res.writeHead(409).end();
        return;
      }
      checking = true;
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          assert(body.length <= 4096);
        }
        const { path } = JSON.parse(body);
        const result = await verifyPreview(path, "native-check");
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ passed: result.passed, keys: result.keys }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        checking = false;
      }
    });
    await new Promise((done, reject) => {
      checkServer.once("error", reject);
      checkServer.listen(0, "127.0.0.1", done);
    });
    const checkProgram = `import assert from 'node:assert/strict';\nconst r=await fetch(${JSON.stringify(`http://127.0.0.1:${checkServer.address().port}/${endpointToken}`)},{method:'POST',body:JSON.stringify({path:process.cwd()}),signal:AbortSignal.timeout(55000)});const result=await r.json();assert(r.ok&&result.passed,JSON.stringify(result));console.log('ARC_NATIVE_DISCLOSURE_KEYBOARD_OK');\n`;
    report.checkHash = hash(checkProgram);
    const files = {
      ".gitattributes": "* text eol=lf\n",
      "index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ARC disclosure fixture</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Project details</h1><div id="toggle" onclick="document.querySelector('#details').hidden=false">Show details</div><section id="details" hidden><h2>Build evidence</h2><p>${proof}</p></section><a id="after" href="#summary">Next section</a><p id="summary">End of fixture.</p></main></body></html>\n`,
      "style.css":
        "body{font:18px system-ui;padding:36px;background:#17202b;color:#e0e7ef}main{max-width:640px}#toggle{padding:12px 18px;background:#25486c;color:inherit;border:1px solid #6a8caa;border-radius:8px;cursor:pointer}#details{padding:16px 0}a{color:#a8d6ff}[hidden]{display:none!important}\n",
      "requirements.md": `# Disclosure behavior\n\nUse a native button with id toggle, aria-controls details and aria-expanded false initially. Keep the existing panel content (${proof}), layout and link. Enter and Space toggle panel hidden and aria-expanded together. Escape closes it and leaves focus on the button. Tab moves from the button to link id after, with no trap. Only edit index.html; preserve style.css, requirements.md and check.mjs.\n`,
      "check.mjs": checkProgram,
    };
    for (const [name, content] of Object.entries(files))
      await writeFile(join(workspace, name), content);
    await git(workspace, "init");
    for (const [key, value] of Object.entries({
      "user.name": "ARC acceptance",
      "user.email": "arc-acceptance@example.invalid",
      "commit.gpgSign": "false",
    }))
      await git(workspace, "config", "--local", key, value);
    await git(workspace, "add", ".");
    await git(
      workspace,
      "commit",
      "-m",
      "Initialize disposable disclosure fixture",
    );
    report.sourceHead = await git(workspace, "rev-parse", "HEAD");
    const project = await request("/projects", {
      name: "ARC native HTML paired acceptance",
      source: { type: "local_path", hostId: daemon.hostId, path: workspace },
    });
    report.projectId = project.id;
    const scope = { kind: "project", projectId: project.id };
    previewThread = await request("/threads", {
      projectId: project.id,
      origin: "sdk",
      ...execution,
      title: "HTML verification preview only",
      input: input("Cancel this deferred preview fixture before dispatch."),
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: workspace },
      },
      sendAt: Date.now() + 86_400_000,
    });
    const queued = await request(
      `/threads/${previewThread.id}/queued-messages`,
    );
    assert.equal(queued.length, 1);
    await request(
      `/threads/${previewThread.id}/queued-messages/${queued[0].id}`,
      undefined,
      "DELETE",
    );
    const instances = await request("/desktop-browsers/instances", {
      hostId: daemon.hostId,
    });
    assert.equal(instances.instances.length, 1);
    browserScope = {
      hostId: daemon.hostId,
      instanceId: instances.instances[0].instanceId,
      generation: instances.instances[0].generation,
      threadId: previewThread.id,
    };
    await debuggerClient.evaluate(
      `(async()=>{await globalThis.__arcSmokeRendererDiagnostics?.release();const c=process.mainModule.require('electron').BrowserWindow.getAllWindows().map(window=>window.webContents).find(c=>c.getURL().startsWith(${JSON.stringify(baseUrl + "/")}));await c.loadURL(${JSON.stringify(`${baseUrl}/projects/${project.id}/threads/${previewThread.id}`)});return true;})()`,
    );
    await assert.rejects(() => verifyPreview(workspace, "before-fix"));
    assert.equal(
      report.previews.at(-1).initial?.tag,
      "DIV",
      "Expected baseline failure at the observed non-keyboard disclosure control",
    );
    const checkScript = `$env:ELECTRON_RUN_AS_NODE='1'\n& '${node.replaceAll("'", "''")}' 'check.mjs' | Out-Default\nif ($null -eq $LASTEXITCODE) { exit 1 }\nexit $LASTEXITCODE`;
    const command = {
      executable: join(
        process.env.SystemRoot ?? "C:/Windows",
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
      timeoutMs: 60_000,
    };
    const members = [];
    for (const role of ["reader", "builder", "reviewer"]) {
      const metadata = {
        schemaVersion: 2,
        name: `HTML ${role}`,
        role,
        specialty: "",
        description: "Owned HTML keyboard verification",
        execution,
        skills: [],
      };
      let { agent } = await rpc("createAgent", {
        scope,
        document: `---\n${JSON.stringify(metadata)}\n---\n\nRead arc_run_snapshot first. Work only in the admitted fixture and assigned files. Do not use the network, inspect credentials or unrelated files, install packages, create subagents, commit, push or deploy. Preserve check.mjs and all files not assigned for editing. Use source-linked reports. ARC invokes the native keyboard check. Reviewers must remain read-only and call arc_run_review for the exact candidate HEAD. Finish in one turn.\n`,
      });
      ({ agent } = await rpc("publishAgentRevision", {
        scope,
        agentId: agent.id,
        expectedDraftVersion: agent.draft.version,
      }));
      members.push({
        id: role,
        agentId: agent.id,
        revision: agent.currentRevision,
        groupId: null,
        role,
        responsibility: role,
        leaderMemberId: null,
        skills: [],
      });
    }
    const nodes = [
      {
        id: "read",
        kind: "agent",
        label: "Read disclosure requirements",
        memberId: "reader",
        access: "read",
        candidate: { kind: "source" },
        task: "Read requirements.md and inspect index.html. Use arc_run_report to describe exact native button, ARIA, keyboard and preserved-content requirements with source-linked evidence. Do not change files.",
      },
      {
        id: "build",
        kind: "agent",
        label: "Implement keyboard disclosure",
        memberId: "builder",
        access: "write",
        candidate: { kind: "source" },
        task: "Call arc_run_reports for the reader handoff. Edit only index.html to implement all reported accessibility and keyboard requirements, preserving current content and visual styling. Do not change or weaken check.mjs; ARC runs the actual native Preview keyboard check.",
      },
      {
        id: "check",
        kind: "check",
        label: "Native Preview keyboard check",
        candidate: { kind: "node", nodeId: "build" },
        command,
      },
      {
        id: "review",
        kind: "review",
        label: "Independent HTML review",
        memberId: "reviewer",
        candidate: { kind: "node", nodeId: "build" },
        task: "Independently inspect the exact checked HTML candidate against requirements.md. Verify button semantics, ARIA state, keyboard behavior and preserved content. Remain read-only and call arc_run_review with actual candidate HEAD, approving only correct behavior. Do not claim testing not observed.",
      },
    ];
    let { team } = await rpc("createTeam", {
      scope,
      definition: {
        schemaVersion: 2,
        name: "Native HTML disclosure acceptance",
        description:
          "Second paired task with actual native Preview keyboard gate",
        leaderMemberId: null,
        groups: [],
        members,
        permissions: [
          {
            id: "independent-review",
            fromMemberId: "reviewer",
            toMemberId: "builder",
            action: "review",
          },
        ],
        graph: {
          nodes,
          edges: [
            ["read", "build"],
            ["build", "check"],
            ["check", "review"],
          ].map(([source, target]) => ({
            id: `${source}-${target}`,
            source,
            target,
            sourceHandle: "next",
            requiredOutcome: "succeeded",
          })),
          entryNodeIds: ["read"],
          requiredGates: [
            {
              id: "native-and-review",
              mode: "all",
              nodeIds: ["check", "review"],
            },
          ],
        },
        presentation: { nodes: [], groups: [], members: [] },
      },
    });
    ({ team } = await rpc("publishTeamRevision", {
      scope,
      teamId: team.id,
      expectedDraftVersion: team.draft.version,
    }));
    const pin = { teamId: team.id, revision: team.currentRevision };
    await rpc("saveProjectPolicy", {
      projectId: project.id,
      expectedVersion: 0,
      policy: {
        schemaVersion: 1,
        autonomy: "collaborative",
        preferredTeams: [pin],
        restrictedTeams: [pin],
        limits: {
          maxConcurrentAgents: 1,
          maxAgentCalls: 4,
          maxRepairRounds: 0,
          maxActiveMs: 720_000,
        },
      },
    });
    const goal =
      "Fix the disclosure using the published team's reader handoff, one builder, actual Preview keyboard check and independent review. Report the observed checked candidate and limitations in the main response. Do not start extra work or change the source checkout.";
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
    const start = Date.now();
    const parent = await request("/threads", {
      projectId: project.id,
      origin: "sdk",
      ...execution,
      title: "HTML addressed acceptance",
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: workspace },
      },
      input: input(goal),
      experimental_addressing: addressing,
    });
    report.ownedThreads.push(parent.id);
    report.originThreadId = parent.id;
    const dispatch = await bounded(
      "HTML addressed admission",
      async () => {
        const rows = (await events(parent.id)).filter(
          (row) =>
            row.type === "system/operation" &&
            row.data.operation === "addressed_dispatch" &&
            row.data.operationId === addressing.operationId,
        );
        assert(
          !rows.some((row) => row.data.status === "failed"),
          JSON.stringify(rows).slice(0, 2000),
        );
        return rows.find((row) => row.data.status === "completed");
      },
      120_000,
    );
    report.runId = dispatch.data.metadata.result.runId;
    await save();
    const admitted = await rpc("getRun", { runId: report.runId });
    assert.equal(admitted.definition.source.head, report.sourceHead);
    report.definitionHash = hash(JSON.stringify(admitted.definition));
    report.initialPlanApproval = await approveOwnedFixturePlan(
      rpc,
      admitted,
      artifacts,
    );
    const complete = await bounded(
      "HTML team completion",
      async () => {
        const run = await rpc("getRun", { runId: report.runId });
        assert(
          !["failed", "cancelled", "paused", "needs-reconciliation"].includes(
            run.workflow?.state,
          ),
          `HTML run stopped at ${run.workflow?.state}`,
        );
        return run.workflow?.state === "succeeded" ? run : null;
      },
      720_000,
    );
    assert.equal(complete.workflow.agentCalls, 4);
    assert.equal(complete.verification.state, "current");
    assert.equal(
      hash(JSON.stringify(complete.definition)),
      report.definitionHash,
    );
    report.finalHead = complete.verification.head;
    report.teamElapsedMs = Date.now() - start;
    const effects = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const page = await rpc("listRunEffects", {
        runId: report.runId,
        offset,
        limit: 100,
      });
      for (const effect of page.effects)
        effects.push(
          await rpc("getRunEffect", {
            runId: report.runId,
            effectId: effect.effectId,
          }),
        );
      if (offset + page.effects.length >= page.total) break;
    }
    const receipts = effects
      .map((effect) => effect.observation?.receipt)
      .filter(Boolean);
    const workers = receipts.filter((receipt) => receipt.kind === "agent");
    const main = receipts.filter((receipt) => receipt.kind === "orchestrator");
    assert.equal(workers.length, 3);
    assert.equal(main.length, 1);
    assert.equal(main[0].threadId, parent.id);
    assert.equal(main[0].terminalStatus, "completed");
    assert(
      workers.some(
        (receipt) =>
          receipt.review?.outcome === "approved" &&
          receipt.review.candidateHead === report.finalHead,
      ),
    );
    assert(
      receipts
        .filter((receipt) => receipt.kind === "native")
        .some((receipt) =>
          receipt.receipt.processes.some(
            (process) =>
              process.exitCode === 0 &&
              JSON.stringify(process.args) === JSON.stringify(command.args),
          ),
        ),
    );
    for (const worker of [...workers, main[0]]) {
      const rows = await events(worker.threadId);
      assert.equal(
        rows.filter(
          (row) =>
            row.type === "turn/completed" && row.data.status === "completed",
        ).length,
        1,
      );
      await writeFile(
        join(artifacts, `events-${worker.threadId}.json`),
        JSON.stringify(rows, null, 2),
      );
    }
    const mainRows = await events(parent.id);
    assert(
      mainRows.some(
        (row) =>
          row.type === "item/completed" &&
          row.data.item.type === "agentMessage" &&
          row.data.item.text.trim(),
      ),
    );
    const candidate = requireWithin(root, complete.verification.workspacePath);
    assert.equal(await git(candidate, "rev-parse", "HEAD"), report.finalHead);
    assert.equal(
      hash(await readFile(join(candidate, "check.mjs"))),
      report.checkHash,
    );
    assert.equal(
      await readFile(join(candidate, "style.css"), "utf8"),
      files["style.css"],
    );
    assert.equal(
      await readFile(join(candidate, "requirements.md"), "utf8"),
      files["requirements.md"],
    );
    await verifyPreview(candidate, "verified-team");
    const usage = await rpc("getRunUsage", {
      runId: report.runId,
      offset: 0,
      limit: 50,
    });
    assert.equal(usage.nextOffset, null);
    assert.equal(usage.workers.length, 4);
    assert(
      usage.workers.some(
        (worker) =>
          worker.threadId === parent.id && worker.name === "Main conversation",
      ),
    );
    report.teamUsage = usage.workers;
    await writeFile(
      join(artifacts, "effects.json"),
      JSON.stringify(effects, null, 2),
    );
    const handoffs = await rpc("listRunCollaboration", {
      runId: report.runId,
      kind: "reports",
      cursor: null,
      limit: 20,
    });
    assert(
      handoffs.reports.some(
        (entry) =>
          entry.memberId === "reader" &&
          entry.source.head === report.sourceHead,
      ),
    );
    report.handoffs = handoffs;
    const baselinePath = requireWithin(
      artifacts,
      join(artifacts, "Baseline disclosure Δ"),
    );
    await git(
      artifacts,
      "clone",
      "--no-hardlinks",
      "--",
      workspace,
      baselinePath,
    );
    for (const [key, value] of Object.entries({
      "user.name": "ARC acceptance",
      "user.email": "arc-acceptance@example.invalid",
      "commit.gpgSign": "false",
    }))
      await git(baselinePath, "config", "--local", key, value);
    const baselineStart = Date.now();
    const baseline = await request("/threads", {
      projectId: project.id,
      origin: "sdk",
      ...execution,
      title: "HTML matched solo baseline",
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: baselinePath },
      },
      input: input(
        `Read requirements.md and fix only index.html. Preserve all other files. Implement native accessible disclosure keyboard behavior and preserved content. Run the existing actual native Preview check through PowerShell: ${checkScript}. This one local check may call its owned loopback verifier. Do not create agents, inspect credentials or unrelated files, install dependencies, access other network sites, commit or push. Complete in one turn.`,
      ),
    });
    report.ownedThreads.push(baseline.id);
    await save();
    const baselineRows = await bounded(
      "HTML solo baseline",
      async () => {
        const thread = await request(`/threads/${baseline.id}`);
        assert(
          !["error", "blocked"].includes(thread.status),
          `HTML baseline is ${thread.status}`,
        );
        if (thread.status !== "idle") return null;
        const rows = await events(baseline.id);
        return rows.some((row) => row.type === "turn/completed") ? rows : null;
      },
      240_000,
    );
    assert.equal(
      baselineRows.filter(
        (row) =>
          row.type === "turn/completed" && row.data.status === "completed",
      ).length,
      1,
    );
    await execute(node, ["check.mjs"], {
      cwd: baselinePath,
      env: environment,
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(
      await readFile(join(baselinePath, "style.css"), "utf8"),
      files["style.css"],
    );
    assert.equal(
      await readFile(join(baselinePath, "requirements.md"), "utf8"),
      files["requirements.md"],
    );
    const baselineUsage = baselineRows
      .filter((row) => row.type === "thread/tokenUsage/updated")
      .at(-1)?.data.tokenUsage.total;
    report.baseline = {
      threadId: baseline.id,
      elapsedMs: Date.now() - baselineStart,
      checksPassed: true,
      inputTokens: baselineUsage?.inputTokens ?? null,
      outputTokens: baselineUsage?.outputTokens ?? null,
      cachedInputTokens: baselineUsage?.cachedInputTokens ?? null,
    };
    await writeFile(
      join(artifacts, "baseline-events.json"),
      JSON.stringify(baselineRows, null, 2),
    );
    assert.equal(await git(workspace, "rev-parse", "HEAD"), report.sourceHead);
    assert.equal(await git(workspace, "status", "--porcelain"), "");
    assert.equal(
      (await events(previewThread.id)).filter(
        (row) => row.type === "turn/input/accepted",
      ).length,
      0,
    );
    report.nativeProviderTurns = 5;
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    check(
      "Second addressed task passed real native Preview Tab/Enter/Space/Escape checks, independent exact-candidate review, counted main response and matched solo baseline in five provider turns",
    );
    return report;
  } catch (error) {
    report.status = report.runId ? "failed" : "blocked";
    report.error = error instanceof Error ? error.stack : String(error);
    if (report.runId) {
      report.cleanupRun = {
        runId: report.runId,
        status: "checking",
        cancellationRequested: false,
        lastObservedState: null,
        agentCalls: null,
        startedAt: new Date().toISOString(),
      };
      try {
        const run = await rpc("getRun", { runId: report.runId });
        assert(run.workflow, "Run has no observable workflow state");
        report.cleanupRun.lastObservedState = run.workflow.state;
        if (
          !["succeeded", "failed", "cancelled"].includes(run.workflow.state)
        ) {
          await rpc("controlRun", {
            runId: report.runId,
            operationId: `cancel-${randomUUID()}`,
            expectedVersion: run.workflow.controlVersion,
            action: "cancel",
          });
          report.cleanupRun.cancellationRequested = true;
        }
        const settled = await bounded(
          "cancelled workflow settlement",
          async () => {
            const current = (await rpc("getRun", { runId: report.runId }))
              .workflow;
            report.cleanupRun.lastObservedState = current?.state ?? null;
            report.cleanupRun.agentCalls = current?.agentCalls ?? null;
            return current &&
              ["succeeded", "failed", "cancelled"].includes(current.state)
              ? current
              : null;
          },
          30_000,
        );
        report.cleanupRun.status = "settled";
        report.cleanupRun.controlVersion = settled.controlVersion;
      } catch (cleanup) {
        report.cleanupRun.status = "uncertain";
        report.cleanupRun.error = String(cleanup);
        report.cleanupUncertain = true;
        report.cleanupError = String(cleanup);
      } finally {
        report.cleanupRun.finishedAt = new Date().toISOString();
      }
    }
    for (const threadId of report.ownedThreads) {
      try {
        const thread = await request(`/threads/${threadId}`);
        if (thread.status === "running")
          await request(`/threads/${threadId}/stop`, {});
      } catch {}
    }
    throw error;
  } finally {
    if (checkServer) {
      checkServer.closeAllConnections();
      await new Promise((done) => checkServer.close(done));
    }
    await save();
  }
}

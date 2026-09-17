import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { runSmoke, requireWithin } from "./smoke-arc-windows.mjs";

const execute = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function cleanupFixtureProcesses({
  root,
  identityDirectory,
  serverFile,
  executable,
  token,
}) {
  requireWithin(root, identityDirectory);
  const scriptSha256 = createHash("sha256")
    .update(await readFile(serverFile))
    .digest("hex");
  const names = await readdir(identityDirectory);
  assert(
    names.length <= 16,
    "Unexpected fixture identity count; refusing process cleanup",
  );
  const processes = [];
  const errors = [];
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  for (const name of names) {
    try {
      assert(
        /^fixture-\d+-\d+\.json$/u.test(name),
        "Unexpected fixture identity filename",
      );
      const identity = JSON.parse(
        await readFile(
          requireWithin(identityDirectory, join(identityDirectory, name)),
          "utf8",
        ),
      );
      assert(
        Number.isSafeInteger(identity.pid) && identity.pid > 0,
        "Invalid fixture PID",
      );
      assert(
        typeof identity.startTicks === "string" &&
          /^\d{15,20}$/u.test(identity.startTicks),
        "Invalid fixture start identity",
      );
      assert.equal(identity.token, token);
      assert.equal(
        resolve(identity.executable).toLowerCase(),
        resolve(executable).toLowerCase(),
      );
      assert.equal(
        resolve(identity.script).toLowerCase(),
        resolve(serverFile).toLowerCase(),
      );
      assert.equal(identity.scriptSha256, scriptSha256);
      assert.equal(name, `fixture-${identity.pid}-${identity.startTicks}.json`);
      const script = [
        "$ErrorActionPreference='Stop'",
        `$fixturePid=${identity.pid}`,
        `$expectedTicks=${quote(identity.startTicks)}`,
        `$expectedExe=${quote(resolve(executable))}`,
        `$expectedScript=${quote(resolve(serverFile))}`,
        "$native=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$fixturePid)",
        "if ($null -eq $native) { @{pid=$fixturePid;state='already-exited'}|ConvertTo-Json -Compress; exit 0 }",
        "$owned=Get-Process -Id $fixturePid -ErrorAction SilentlyContinue",
        "if ($null -eq $owned) { @{pid=$fixturePid;state='already-exited'}|ConvertTo-Json -Compress; exit 0 }",
        "$null=$owned.Handle",
        "$actualTicks=$owned.StartTime.ToUniversalTime().Ticks.ToString()",
        "if ($actualTicks -ne $expectedTicks) { @{pid=$fixturePid;state='original-exited-pid-reused';currentStartTicks=$actualTicks}|ConvertTo-Json -Compress; exit 0 }",
        "if (-not [string]::Equals($native.ExecutablePath,$expectedExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture executable identity mismatch; refusing cleanup' }",
        "$commandPattern='^\\s*(?:\"'+[regex]::Escape($expectedExe)+'\"|'+[regex]::Escape($expectedExe)+')\\s+(?:\"'+[regex]::Escape($expectedScript)+'\"|'+[regex]::Escape($expectedScript)+')\\s*$'",
        "if ($native.CommandLine -notmatch $commandPattern) { throw 'Fixture command identity mismatch; refusing cleanup' }",
        "$owned.Kill()",
        "if (-not $owned.WaitForExit(8000)) { throw 'Verified fixture process did not exit after cleanup' }",
        "@{pid=$fixturePid;state='terminated-owned-fixture';startTicks=$actualTicks;executable=$native.ExecutablePath;commandLine=$native.CommandLine}|ConvertTo-Json -Compress",
      ].join("\n");
      const result = await execute(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
        },
      );
      processes.push({ identity, cleanup: JSON.parse(result.stdout.trim()) });
    } catch (error) {
      const message = `${name}: ${error.message ?? String(error)}`;
      errors.push(message);
      processes.push({
        identityFile: name,
        cleanup: { state: "failed", error: message },
      });
    }
  }
  return { scriptSha256, processes, errors };
}

async function until(label, probe, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      failure = error;
    }
    await delay(500);
  }
  throw new Error(
    `${label} did not complete${failure ? `: ${failure.message}` : ""}`,
  );
}

export async function verifyPreviewFeatures(context) {
  const {
    debuggerClient,
    baseUrl,
    root,
    saved,
    daemon,
    check,
    pass,
    captureRenderer,
    executable,
    env,
    cli,
  } = context;
  const artifacts = requireWithin(root, join(root, `preview-pass-${pass + 1}`));
  const threadTitle = `Preview acceptance ${pass + 1}`;
  const site = requireWithin(
    saved.workspace,
    join(saved.workspace, `preview-fixture-${pass + 1}`),
  );
  await mkdir(artifacts);
  await mkdir(site);
  const evidence = {
    status: "running",
    screenshots: [],
    checks: [],
    limitations: [
      "Fixture exercises an actual SSE hot-update connection; framework-specific Vite/Next integration is not separately certified.",
    ],
  };
  const record = (name) => {
    evidence.checks.push(name);
    check(`Preview pass ${pass + 1}: ${name}`);
  };
  const request = async (
    path,
    body,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json();
    assert(
      response.ok,
      `${path}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 1000)}`,
    );
    return value;
  };
  const previewPath = `/projects/${encodeURIComponent(saved.project.id)}/preview`;
  const readPreview = async () => {
    const value = await request(previewPath);
    evidence.lastPreview = {
      status: value.status,
      error: value.error,
      url: value.url,
      terminal: value.terminal
        ? {
            id: value.terminal.id,
            status: value.terminal.status,
            exitCode: value.terminal.exitCode,
            closeReason: value.terminal.closeReason,
          }
        : null,
      logs: value.logs.slice(-32768),
    };
    return value;
  };
  const mainContents = `process.mainModule.require('electron').BrowserWindow.getAllWindows().map(window=>window.webContents).find(c=>c.getURL().startsWith(${JSON.stringify(baseUrl + "/")}))`;
  const renderer = async (expression) =>
    (
      await debuggerClient.evaluate(
        `(async()=>{const c=${mainContents};if(!c)throw Error('Owned renderer is missing');return c.executeJavaScript(${JSON.stringify(expression)});})()`,
      )
    ).result.value;
  const rendererThreadState = () =>
    renderer(`(()=>{
      const visible=e=>e.checkVisibility()&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      return {
        path:location.pathname,
        readyState:document.readyState,
        visibleComposer:[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].some(visible),
        visibleExpectedTitle:[...document.querySelectorAll('p')].some(e=>e.textContent.trim()===${JSON.stringify(threadTitle)}&&visible(e)),
        visiblePanelTabLabels:[...document.querySelectorAll('[aria-label="Right panel views"] button[aria-pressed]')].filter(visible).map(e=>({label:e.getAttribute('aria-label')||e.textContent.trim(),active:e.getAttribute('aria-pressed')==='true'})),
        visibleBrowserCount:[...document.querySelectorAll('[data-app-browser]')].filter(visible).length
      };
    })()`);
  const pageContents = (url) =>
    `process.mainModule.require('electron').webContents.getAllWebContents().find(c=>c.getURL().startsWith(${JSON.stringify(url)}))`;
  const page = async (url, expression) =>
    (
      await debuggerClient.evaluate(
        `(async()=>{const c=${pageContents(url)};return c?c.executeJavaScript(${JSON.stringify(expression)}):null;})()`,
      )
    ).result.value;
  const click = async (label) =>
    renderer(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.innerText.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')?.startsWith(${JSON.stringify(label)}))&&!b.disabled&&b.getBoundingClientRect().width>0);if(!b)return false;b.click();return true;})()`,
    );
  const cliEntry = requireWithin(
    dirname(executable),
    join(dirname(cli.path), "bb"),
  );
  const runCli = async (args) => {
    const result = await execute(executable, [cliEntry, ...args], {
      cwd: site,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        BB_CLI_REEXEC: "1",
        BB_SERVER_URL: baseUrl,
      },
      windowsHide: true,
      timeout: 35_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return JSON.parse(result.stdout.trim());
  };
  const serverFile = requireWithin(site, join(site, "preview-server.cjs"));
  const identityDirectory = requireWithin(
    site,
    join(site, "process-identities"),
  );
  await mkdir(identityDirectory);
  await writeFile(
    join(site, "style.css"),
    "body { color: rgb(24, 90, 120); background: rgb(240, 244, 248); font: 18px system-ui; padding: 32px; } button { padding: 12px; }\n",
  );
  await writeFile(
    join(site, "index.htm"),
    `<!doctype html><html><head><title>ARC Preview ${saved.token}</title><link rel="stylesheet" href="style.css"></head><body><h1>ARC live preview</h1><button id="inspect-target">Inspect this element</button><p id="hot-value">initial</p><script>window.arcBootId=Date.now()+':'+Math.random();console.log('ARC_PREVIEW_READY');fetch('probe.json?token=private-query');if(location.protocol.startsWith('http')&&!location.pathname.includes('file-previews')){const events=new EventSource('/events');events.onmessage=event=>{document.querySelector('#hot-value').textContent=event.data;};}</script></body></html>`,
  );
  await writeFile(join(site, "probe.json"), '{"ok":true}');
  await writeFile(join(site, "hot.txt"), "initial");
  await writeFile(
    serverFile,
    `const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const crypto=require('node:crypto');const powershell=path.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');const startTicks=cp.execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command','[Diagnostics.Process]::GetProcessById('+process.pid+').StartTime.ToUniversalTime().Ticks.ToString()'],{windowsHide:true,timeout:5000,encoding:'utf8'}).trim();fs.writeFileSync(path.join(__dirname,'process-identities','fixture-'+process.pid+'-'+startTicks+'.json'),JSON.stringify({pid:process.pid,startTicks,executable:process.execPath,script:__filename,scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),token:${JSON.stringify(saved.token)}}),{flag:'wx'});const clients=new Set();const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write('data: '+fs.readFileSync(path.join(__dirname,'hot.txt'),'utf8')+'\\n\\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}const names={'/':'index.htm','/index.htm':'index.htm','/style.css':'style.css','/probe.json':'probe.json'};const name=names[pathname];if(!name){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':name.endsWith('.htm')?'text/html':name.endsWith('.css')?'text/css':'application/json','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,name)));});const watcher=fs.watch(path.join(__dirname,'hot.txt'),()=>{for(const res of clients)res.write('data: '+fs.readFileSync(path.join(__dirname,'hot.txt'),'utf8')+'\\n\\n');});server.listen(0,'127.0.0.1',()=>console.log('ARC_PREVIEW_URL http://127.0.0.1:'+server.address().port+'/'));process.on('SIGTERM',()=>{watcher.close();for(const res of clients)res.end();server.close(()=>process.exit(0));});`,
  );
  const command = `$ErrorActionPreference='Stop'; $env:ELECTRON_RUN_AS_NODE='1'; & $env:BB_CLI_RUNTIME '${serverFile.replaceAll("'", "''")}' | Out-Default; exit $LASTEXITCODE`;
  let scope;
  let tabId;
  let htmlTabId;
  let lease;
  let unrelated;
  let threadId;
  let started = false;
  let launchAttempts = 0;
  const failures = [];
  try {
    const before = await readPreview();
    if (pass > 0)
      assert(
        before.config?.command.includes("preview-server.cjs"),
        "The saved preview command was lost after application restart",
      );
    await request(`${previewPath}/configure`, {
      expectedRevision: before.revision,
      config: { hostId: daemon.hostId, cwd: site, command, url: "" },
    });
    const configured = await readPreview();
    assert.equal(configured.status, "stopped");
    assert.equal(configured.terminal, null);
    launchAttempts += 1;
    const start = await request(`${previewPath}/start`, {});
    started = true;
    const running = await until("owned HTTP readiness", async () => {
      const current = await readPreview();
      if (current.status === "failed") throw Error(current.error);
      return current.status === "running" ? current : false;
    });
    evidence.managed = {
      firstTerminalId: running.terminal.id,
      firstUrl: running.url,
      initialStatus: start.status,
    };
    assert((await (await fetch(running.url)).text()).includes(saved.token));
    record(
      "saved command stayed stopped until Start; owned packaged ConPTY server responded before Running",
    );
    await debuggerClient.evaluate(
      "(async()=>{await globalThis.__arcSmokeRendererDiagnostics?.release();return true;})()",
    );
    const thread = await request("/threads", {
      projectId: saved.project.id,
      origin: "sdk",
      providerId: "codex",
      model: "gpt-6-astra",
      title: threadTitle,
      input: [
        {
          type: "text",
          text: "Deferred preview fixture; this message must be cancelled before dispatch.",
        },
      ],
      environment: {
        type: "host",
        hostId: daemon.hostId,
        workspace: { type: "unmanaged", path: saved.workspace },
      },
      sendAt: Date.now() + 86_400_000,
    });
    threadId = thread.id;
    const queued = await request(`/threads/${threadId}/queued-messages`);
    assert.equal(queued.length, 1);
    assert.equal(
      (
        await request(
          `/threads/${threadId}/events?types=turn%2Finput%2Faccepted&limit=1`,
        )
      ).length,
      0,
      "A model turn started before the fixture queue was cancelled",
    );
    await request(
      `/threads/${threadId}/queued-messages/${queued[0].id}`,
      undefined,
      "DELETE",
    );
    assert.equal(
      (await request(`/threads/${threadId}/queued-messages`)).length,
      0,
    );
    assert.equal(
      (
        await request(
          `/threads/${threadId}/events?types=turn%2Finput%2Faccepted&limit=1`,
        )
      ).length,
      0,
    );
    const instances = await request("/desktop-browsers/instances", {
      hostId: daemon.hostId,
    });
    assert.equal(instances.instances.length, 1);
    scope = {
      hostId: daemon.hostId,
      instanceId: instances.instances[0].instanceId,
      generation: instances.instances[0].generation,
      threadId,
    };
    const threadPath = `/projects/${saved.project.id}/threads/${threadId}`;
    await debuggerClient.evaluate(
      `(async()=>{await ${mainContents}.loadURL(${JSON.stringify(`${baseUrl}${threadPath}`)});return true;})()`,
    );
    evidence.threadReady = await until(
      "owned thread UI before browser reveal",
      async () => {
        const state = await rendererThreadState();
        return state.path === threadPath &&
          state.visibleComposer &&
          state.visibleExpectedTitle
          ? state
          : false;
      },
    );
    evidence.threadEffectSettle = await renderer(`new Promise(resolve=>{
      let firstFrame;let secondFrame;let complete=false;
      const finish=reason=>{if(complete)return;complete=true;clearTimeout(timer);cancelAnimationFrame(firstFrame);cancelAnimationFrame(secondFrame);resolve(reason);};
      const timer=setTimeout(()=>finish('timeout-fallback'),500);
      firstFrame=requestAnimationFrame(()=>{secondFrame=requestAnimationFrame(()=>finish('animation-frames'));});
    })`);
    const created = await request("/desktop-browsers/create", {
      ...scope,
      url: running.url,
      presentation: "reveal",
    });
    tabId = created.tab.tabId;
    await until("native preview page", () =>
      page(
        running.url,
        "document.querySelector('#inspect-target')?.textContent==='Inspect this element'",
      ),
    );
    await until("visible native browser controls", async () => {
      if (await renderer("document.body.innerText.includes('Select element')"))
        return true;
      await click("Show right panel");
      return false;
    });
    const bootId = await page(running.url, "window.arcBootId");
    await writeFile(join(site, "hot.txt"), `updated-${saved.token}`);
    await until(
      "native hot update without reload",
      async () =>
        (await page(
          running.url,
          "document.querySelector('#hot-value').textContent",
        )) === `updated-${saved.token}`,
    );
    assert.equal(await page(running.url, "window.arcBootId"), bootId);
    record(
      "native localhost kept the live update connection and changed content without reloading",
    );
    const flags = [
      "--host",
      scope.hostId,
      "--instance",
      scope.instanceId,
      "--generation",
      scope.generation,
      "--thread",
      threadId,
    ];
    lease = await request("/desktop-browsers/acquire", {
      ...scope,
      tabIds: [tabId],
      controllerLabel: "Packaged acceptance",
      ttlMs: 60_000,
    });
    const targets = await runCli([
      "browser",
      "targets",
      lease.leaseId,
      ...flags,
    ]);
    assert.equal(targets.targets.length, 1);
    const evaluated = await runCli([
      "browser",
      "evaluate",
      lease.leaseId,
      ...flags,
      "--target",
      targets.targets[0].targetId,
      "--expression",
      "({title:document.title,hot:document.querySelector('#hot-value').textContent})",
    ]);
    assert.equal(evaluated.result.hot, `updated-${saved.token}`);
    assert(evaluated.result.title.includes(saved.token));
    evidence.cdp = evaluated.result;
    await until("takeover button", () => click("Take over"));
    await until("takeover revoked native control", async () => {
      const tabs = await request("/desktop-browsers/tabs", scope);
      return tabs.tabs.find((tab) => tab.tabId === tabId)?.control === null;
    });
    await assert.rejects(
      runCli(["browser", "targets", lease.leaseId, ...flags]),
      (error) => {
        const rejection = String(error.stderr || error.message);
        evidence.takeover = {
          leaseId: lease.leaseId,
          rejection: rejection.slice(0, 2000),
        };
        return rejection.includes("Browser lease is unavailable");
      },
      "The old CDP control must be rejected after Take over",
    );
    lease = null;
    record(
      "packaged CLI inspected the scoped Electron page on Windows and Take over revoked it",
    );
    await until("element selection action", () => click("Select element"));
    await until(
      "native isolated element picker",
      async () =>
        (
          await debuggerClient.evaluate(
            `(async()=>{const c=${pageContents(running.url)};return c.executeJavaScriptInIsolatedWorld(1007,[{code:'typeof globalThis.__arcCancelPreviewSelection === "function"'}]);})()`,
          )
        ).result.value,
    );
    await debuggerClient.evaluate(
      `(async()=>{const c=${pageContents(running.url)};const p=await c.executeJavaScript("(()=>{const b=document.querySelector('#inspect-target').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()");c.sendInputEvent({type:'mouseMove',...p});c.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});c.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});return true;})()`,
    );
    await until("screenshot feedback attached to draft", () =>
      renderer(
        "document.body.innerText.includes('Screenshot and feedback added to your draft.') && [...document.querySelectorAll('[contenteditable=true],textarea')].some(e=>(e.innerText||e.value||'').includes('Selected element: #inspect-target'))",
      ),
    );
    const capture = await renderer(
      `window.bbDesktop.browser.captureFeedback({threadId:${JSON.stringify(threadId)},tabId:${JSON.stringify(tabId)},mode:'capture'})`,
    );
    assert(capture.screenshot.length > 100);
    assert(capture.console.length <= 50 && capture.network.length <= 100);
    assert(
      capture.network.every((entry) => !entry.url.includes("private-query")),
    );
    await writeFile(
      join(artifacts, "native-localhost.jpg"),
      Buffer.from(capture.screenshot, "base64"),
    );
    evidence.screenshots.push(join(artifacts, "native-localhost.jpg"));
    evidence.feedback = {
      consoleCount: capture.console.length,
      networkCount: capture.network.length,
      selected: "#inspect-target",
    };
    evidence.screenshots.push(
      await captureRenderer(
        debuggerClient,
        baseUrl,
        join(artifacts, "draft-with-preview-feedback.png"),
      ),
    );
    record(
      "actual native click selected an element and uploaded its screenshot into the unsent composer draft",
    );
    launchAttempts += 1;
    const restarted = await request(`${previewPath}/restart`, {});
    const afterRestart = await until("restarted owned preview", async () => {
      const value = await readPreview();
      return value.status === "running" ? value : false;
    });
    assert.notEqual(afterRestart.terminal.id, running.terminal.id);
    assert.equal(
      (await request(`/terminals/${running.terminal.id}`)).status,
      "exited",
    );
    evidence.managed.restartedTerminalId = restarted.terminal.id;
    await request(`${previewPath}/stop`, {});
    started = false;
    assert.equal((await readPreview()).terminal.status, "exited");
    await until(
      "preview listener stopped",
      async () =>
        fetch(afterRestart.url, { signal: AbortSignal.timeout(1000) }).then(
          () => false,
          () => true,
        ),
      15_000,
    );
    record(
      "Restart replaced only its owned terminal, and Stop closed its listening server",
    );
    unrelated = createServer((_req, res) => res.end("unrelated-owned-fixture"));
    await new Promise((done, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(0, "127.0.0.1", done);
    });
    const conflictUrl = `http://127.0.0.1:${unrelated.address().port}/`;
    const stopped = await readPreview();
    await request(`${previewPath}/configure`, {
      expectedRevision: stopped.revision,
      config: { ...stopped.config, url: conflictUrl },
    });
    launchAttempts += 1;
    await request(`${previewPath}/start`, {});
    started = true;
    const conflict = await until("foreign listener rejected", async () => {
      const value = await readPreview();
      return value.status === "failed" ? value : false;
    });
    assert(conflict.error.includes("another process"));
    await request(`${previewPath}/stop`, {});
    started = false;
    assert.equal(
      await (await fetch(conflictUrl)).text(),
      "unrelated-owned-fixture",
    );
    const conflictStopped = await readPreview();
    await request(`${previewPath}/configure`, {
      expectedRevision: conflictStopped.revision,
      config: { ...conflictStopped.config, url: "" },
    });
    record(
      "a configured port owned by another process was rejected and remained alive after Stop",
    );
    const htmlLease = await request("/files/previews", {
      hostId: daemon.hostId,
      rootPath: site,
    });
    const htmlUrl = `${baseUrl}${htmlLease.baseUrl}/index.htm`;
    const htmlResponse = await fetch(htmlUrl);
    assert(
      htmlResponse.headers
        .get("content-security-policy")
        ?.includes("sandbox allow-scripts"),
    );
    assert((await htmlResponse.text()).includes(saved.token));
    await fetch(`${baseUrl}${htmlLease.baseUrl}/style.css`);
    await writeFile(
      join(site, "style.css"),
      "body { color: rgb(120, 20, 70); background: rgb(240, 244, 248); font: 18px system-ui; padding: 32px; } button { padding: 12px; }\n",
    );
    const refreshed = await request(
      htmlLease.baseUrl.replace("/api/v1", "") + "/refresh",
      {},
    );
    assert(
      refreshed.changed &&
        refreshed.trackedFiles >= 2 &&
        refreshed.expiresAtMs >= htmlLease.expiresAtMs,
    );
    const traversal = await fetch(
      `${baseUrl}${htmlLease.baseUrl}/..%2Fpreserve-project.txt`,
    );
    assert(traversal.status >= 400);
    record(
      "HTML lease served its relative stylesheet, detected its change, renewed and rejected traversal",
    );
    await request("/desktop-browsers/close", { ...scope, tabId });
    tabId = null;
    const tabState = await request(`/threads/${threadId}/tabs`);
    htmlTabId = `browser:qa-html-${pass}:none`;
    await request(
      `/threads/${threadId}/tabs`,
      {
        expectedRevision: tabState.revision,
        tabs: [
          ...tabState.tabs,
          {
            id: htmlTabId,
            kind: "browser",
            environmentId: null,
            title: "Live HTML preview",
            url: `${baseUrl}/api/v1/file-previews/expired/index.htm`,
            htmlSource: {
              hostId: daemon.hostId,
              rootPath: site,
              filePath: "index.htm",
            },
          },
        ],
      },
      "PUT",
    );
    await until("HTML preview tab selection", async () => {
      if (await click("Live HTML preview")) return true;
      await click("Show right panel");
      return false;
    });
    const nativeHtml = await until(
      "independently owned native HTML lease",
      async () => {
        const tabs = await request("/desktop-browsers/tabs", scope);
        return tabs.tabs.find(
          (tab) =>
            tab.tabId === htmlTabId &&
            tab.url.includes("/file-previews/") &&
            !tab.url.includes("/expired/"),
        );
      },
    );
    await until(
      "native HTML stylesheet",
      async () =>
        (await page(
          nativeHtml.url,
          "getComputedStyle(document.body).color",
        )) === "rgb(120, 20, 70)",
    );
    await writeFile(
      join(site, "style.css"),
      "body { color: rgb(10, 100, 40); background: rgb(240, 244, 248); font: 18px system-ui; padding: 32px; } button { padding: 12px; }\n",
    );
    await until(
      "native HTML automatic relative asset reload",
      async () =>
        (await page(
          nativeHtml.url,
          "getComputedStyle(document.body).color",
        )) === "rgb(10, 100, 40)",
      20_000,
    );
    const htmlCapture = await renderer(
      `window.bbDesktop.browser.captureFeedback({threadId:${JSON.stringify(threadId)},tabId:${JSON.stringify(htmlTabId)},mode:'capture'})`,
    );
    await writeFile(
      join(artifacts, "native-html.jpg"),
      Buffer.from(htmlCapture.screenshot, "base64"),
    );
    evidence.screenshots.push(join(artifacts, "native-html.jpg"));
    record(
      "persisted HTML source replaced an expired URL, loaded relative CSS and reloaded it without the original file tab",
    );
    assert.equal(
      (
        await request(
          `/threads/${threadId}/events?types=turn%2Finput%2Faccepted&limit=1`,
        )
      ).length,
      0,
      "The Preview fixture unexpectedly admitted a model turn",
    );
    evidence.modelTurnsAdmitted = 0;
    evidence.status = "passed";
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.stack ?? String(error);
    const diagnostics = await Promise.allSettled([
      rendererThreadState(),
      threadId ? request(`/threads/${threadId}/tabs`) : Promise.resolve(null),
      scope ? request("/desktop-browsers/tabs", scope) : Promise.resolve(null),
    ]);
    evidence.failureDiagnostics = Object.fromEntries(
      ["rendererThread", "threadTabs", "desktopBrowserTabs"].map(
        (key, index) => {
          const result = diagnostics[index];
          return [
            key,
            result.status === "fulfilled"
              ? result.value
              : { error: String(result.reason) },
          ];
        },
      ),
    );
    await captureRenderer(
      debuggerClient,
      baseUrl,
      join(artifacts, "failure.png"),
    ).catch(() => {});
    throw error;
  } finally {
    if (started)
      await request(`${previewPath}/stop`, {}).catch((error) =>
        failures.push(String(error)),
      );
    try {
      evidence.fixtureProcessCleanup = await cleanupFixtureProcesses({
        root,
        identityDirectory,
        serverFile,
        executable,
        token: saved.token,
      });
      failures.push(...evidence.fixtureProcessCleanup.errors);
      evidence.fixtureProcessCleanup.launchAttempts = launchAttempts;
      if (evidence.fixtureProcessCleanup.processes.length < launchAttempts)
        failures.push(
          `Only ${evidence.fixtureProcessCleanup.processes.length} fixture process identities were recorded for ${launchAttempts} launch attempts; cleanup cannot be fully confirmed`,
        );
      if (
        evidence.status === "passed" &&
        evidence.fixtureProcessCleanup.processes.some(
          (entry) => entry.cleanup.state === "terminated-owned-fixture",
        )
      )
        failures.push(
          "A fixture process survived its verified Preview Stop and required guarded harness cleanup",
        );
    } catch (error) {
      failures.push(
        `Fixture process cleanup: ${error.message ?? String(error)}`,
      );
      evidence.fixtureProcessCleanup = { errors: [String(error)] };
    }
    if (lease)
      await request("/desktop-browsers/release", {
        ...scope,
        leaseId: lease.leaseId,
      }).catch((error) => failures.push(String(error)));
    for (const id of [tabId, htmlTabId].filter(Boolean))
      await request("/desktop-browsers/close", { ...scope, tabId: id }).catch(
        (error) => failures.push(String(error)),
      );
    if (unrelated) {
      unrelated.closeAllConnections();
      await new Promise((done) => unrelated.close(done));
    }
    if (threadId) {
      const queued = await request(
        `/threads/${threadId}/queued-messages`,
      ).catch(() => []);
      for (const item of queued)
        await request(
          `/threads/${threadId}/queued-messages/${item.id}`,
          undefined,
          "DELETE",
        ).catch((error) => failures.push(String(error)));
    }
    evidence.cleanupErrors = failures;
    await writeFile(
      join(artifacts, "result.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    assert.equal(
      failures.length,
      0,
      `Preview cleanup failed: ${failures.join("; ")}`,
    );
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
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-visual-teams.mjs --executable <packaged ARC IDE.exe> [--artifacts-parent <directory>]\nRuns guarded isolated Windows startup/restart acceptance plus real managed preview, hot updates, native feedback and scoped CLI inspection. No provider messages are dispatched; the temporary future-queued fixture is cancelled. Does not publish or install.",
    );
  else
    await runSmoke(
      values.executable ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../release/win-unpacked/ARC IDE.exe",
        ),
      {
        artifactsParent: values["artifacts-parent"],
        verifyFeatures: verifyPreviewFeatures,
      },
    ).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

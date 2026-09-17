import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify, stripVTControlCharacters } from "node:util";
import WebSocket from "ws";
import { z } from "zod";

const requiredProviders = [
  "codex",
  "claude-code",
  "acp-cursor",
  "pi",
  "acp-opencode",
  "acp-omp",
  "acp-grok",
  "acp-hermes-agent",
];
const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  sources: z.array(
    z.object({
      id: z.string().min(1),
      type: z.literal("local_path"),
      hostId: z.string().min(1),
      path: z.string(),
    }),
  ),
});
const runtimeSchema = z.object({
  pid: z.number().int().positive(),
  bridgePath: z.string(),
  serverUrl: z.string(),
  startedAt: z.string(),
});
const fixtureSchema = z.object({
  project: projectSchema,
  workspace: z.string(),
  sentinel: z.string(),
  token: z.string().uuid(),
});
const processSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    id: z.number().int().positive(),
    executablePath: z.string().min(1),
    startedAt: z.string().min(1),
  }),
]);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function requireWithin(root, candidate) {
  const suffix = relative(resolve(root), resolve(candidate));
  assert(
    suffix !== "" &&
      suffix !== ".." &&
      !suffix.startsWith("..\\") &&
      !suffix.startsWith("../") &&
      !isAbsolute(suffix),
    `Path is outside the smoke boundary: ${candidate}`,
  );
  return resolve(candidate);
}

export function verifyOwnedApplicationProcess(raw, expected) {
  const current = processSchema.parse(raw);
  if (!current.exists) return null;
  assert(
    current.id === expected.pid &&
      isAbsolute(current.executablePath) &&
      resolve(current.executablePath).toLowerCase() ===
        resolve(expected.executable).toLowerCase(),
    "Refusing to stop a process outside the exact selected ARC executable.",
  );
  requireWithin(dirname(expected.executable), current.executablePath);
  assert(
    expected.startedAt === undefined ||
      current.startedAt === expected.startedAt,
    "Refusing to stop a reused application PID.",
  );
  return current;
}

async function readOwnedApplicationProcess(env, expected) {
  const windows = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  assert(
    windows && isAbsolute(windows),
    "SystemRoot is unavailable for process ownership verification.",
  );
  const powershell = join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = await execFileAsync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(dirname(fileURLToPath(import.meta.url)), "inspect-arc-process.ps1"),
      "-ProcessId",
      String(expected.pid),
    ],
    { windowsHide: true, encoding: "utf8", timeout: 15_000 },
  );
  return verifyOwnedApplicationProcess(
    JSON.parse(result.stdout.replace(/^\uFEFF/u, "")),
    expected,
  );
}

export function createSmokeEnvironment(original, root, serverPort, daemonPort) {
  const allowed = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "LOCALAPPDATA",
  ]);
  const env = Object.fromEntries(
    Object.entries(original).filter(
      ([key, value]) =>
        allowed.has(key.toUpperCase()) && typeof value === "string",
    ),
  );
  const windows = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  assert(
    windows && isAbsolute(windows),
    "Windows SystemRoot must be an absolute directory.",
  );
  return {
    ...env,
    PATH: [
      join(windows, "System32"),
      windows,
      join(windows, "System32", "WindowsPowerShell", "v1.0"),
    ].join(";"),
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "roaming"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    BB_DATA_DIR: join(root, "data"),
    BB_SERVER_PORT: String(serverPort),
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_DESKTOP_AUTO_UPDATE: "0",
    BB_DESKTOP_VERSION_CHECK: "0",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
  };
}

export function validateSmokeEnvironment(original, configured) {
  assert(
    configured && typeof configured === "object",
    "Smoke environment customization must return an environment",
  );
  for (const [key, value] of Object.entries(original)) {
    if (key !== "PATH")
      assert(
        configured[key] === value,
        `Smoke environment must preserve its owned ${key}`,
      );
  }
  for (const key of Object.keys(configured)) {
    assert(
      key in original || key === "CODEX_HOME",
      `Unsupported smoke environment addition: ${key}`,
    );
  }
  assert(typeof configured.PATH === "string", "Smoke PATH must be a string");
  const paths = new Set(
    configured.PATH.split(";").map((path) => path.toLowerCase()),
  );
  assert(
    original.PATH.split(";").every((path) => paths.has(path.toLowerCase())),
    "Smoke PATH must retain its Windows system directories",
  );
  if (configured.CODEX_HOME !== undefined)
    assert(isAbsolute(configured.CODEX_HOME), "CODEX_HOME must be absolute");
  return configured;
}

async function waitFor(label, check, timeoutMs = 120_000, retryErrors = true) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== false && value !== null && value !== undefined)
        return value;
    } catch (error) {
      if (!retryErrors) throw error;
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  assert(
    response.ok,
    `${url}: HTTP ${response.status}: ${JSON.stringify(value).slice(0, 2000)}`,
  );
  return value;
}

export function verifyProjectBinding(raw, expected) {
  const project = projectSchema.parse(raw);
  assert(
    project.id === expected.projectId && project.name === expected.name,
    "Project identity changed after restart.",
  );
  const source = project.sources.find(
    (entry) => entry.hostId === expected.hostId,
  );
  assert(
    source &&
      resolve(source.path).toLowerCase() ===
        resolve(expected.workspace).toLowerCase(),
    "Project source moved outside its original host workspace.",
  );
  return project;
}

async function reservePorts(preferred = [0, 0, 0]) {
  const servers = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const server = createServer();
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(preferred[index], "127.0.0.1", done);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((done) => server.close(done))),
    );
  }
}

async function inspector(port, child) {
  const targets = await waitFor(
    "the test application's inspector",
    async () => {
      assert(
        child.exitCode === null && child.signalCode === null,
        "ARC exited during startup.",
      );
      return json(`http://127.0.0.1:${port}/json/list`);
    },
  );
  const endpoint = new URL(
    z
      .array(z.object({ webSocketDebuggerUrl: z.string() }))
      .length(1)
      .parse(targets)[0].webSocketDebuggerUrl,
  );
  assert(
    endpoint.protocol === "ws:" &&
      endpoint.hostname === "127.0.0.1" &&
      endpoint.port === String(port),
    "Inspector returned an unexpected endpoint.",
  );
  const socket = new WebSocket(endpoint);
  await new Promise((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (bytes) => {
    const response = JSON.parse(bytes.toString());
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error || response.result?.exceptionDetails)
      request.reject(
        new Error(
          JSON.stringify(response.error ?? response.result.exceptionDetails),
        ),
      );
    else request.done(response.result);
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Test application inspector closed."));
    }
    pending.clear();
  });
  const evaluate = (expression, awaitPromise = true) =>
    new Promise((done, reject) => {
      const requestId = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Inspector command timed out."));
      }, 10_000);
      pending.set(requestId, { done, reject, timer });
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise },
        }),
      );
    });
  try {
    const identity = await waitFor(
      "the owned Electron application to initialize",
      async () => {
        assert(
          child.exitCode === null && child.signalCode === null,
          "ARC exited before its main module initialized.",
        );
        const response = await evaluate(
          "typeof process.mainModule?.require === 'function' && process.mainModule.require('electron').app.isReady() ? JSON.stringify({pid:process.pid,execPath:process.execPath,userData:process.mainModule.require('electron').app.getPath('userData'),version:process.mainModule.require('electron').app.getVersion()}) : null",
          false,
        );
        return response.result.value == null ? null : response;
      },
      30_000,
      false,
    );
    const facts = z
      .object({
        pid: z.number().int(),
        execPath: z.string(),
        userData: z.string(),
        version: z.string().min(1),
      })
      .parse(JSON.parse(identity.result.value));
    assert(
      facts.pid === child.pid,
      "Inspector is not attached to the process started by this test.",
    );
    return { facts, evaluate, close: () => socket.close() };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function isClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return false;
  } catch (error) {
    return error.cause?.code === "ECONNREFUSED";
  }
}

async function verifyPayload(baseUrl, appDirectory) {
  const plugins = z
    .object({
      plugins: z.array(
        z.object({ id: z.string(), rootDir: z.string(), status: z.string() }),
      ),
    })
    .parse(await json(`${baseUrl}/api/v1/plugins`));
  assert(
    !plugins.plugins.some((entry) => entry.id === "wndr-forecast"),
    "The forecasting plugin is still bundled.",
  );
  const required = [
    "provider-codex",
    "provider-claude-code",
    "provider-pi",
    "provider-acp",
  ];
  for (const id of required) {
    const plugin = plugins.plugins.find((entry) => entry.id === id);
    assert(
      plugin?.status === "running",
      `Bundled provider plugin ${id} is not running.`,
    );
    requireWithin(appDirectory, plugin.rootDir);
  }
  try {
    await access(join(appDirectory, "resources", "wndr-python"));
    throw new Error("The forecasting Python payload is still packaged.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { providerPlugins: required, forecastingAbsent: true };
}

function appContentsExpression(baseUrl) {
  return `process.mainModule.require('electron').BrowserWindow.getAllWindows().map(window => window.webContents).find(contents => contents.getURL().startsWith(${JSON.stringify(`${baseUrl}/`)}))`;
}

async function captureRenderer(debuggerClient, baseUrl, screenshot) {
  const capture = await waitFor(
    "the packaged renderer screenshot",
    async () => {
      const response = await debuggerClient.evaluate(
        `(async () => { const contents = ${appContentsExpression(baseUrl)}; const image = await contents.capturePage(undefined, {stayHidden:true,stayAwake:true}); return {png:image.toPNG().toString('base64'),...image.getSize()}; })()`,
      );
      return z
        .object({
          png: z.string().min(1),
          width: z.number().min(320),
          height: z.number().min(200),
        })
        .parse(response.result.value);
    },
    15_000,
  );
  await writeFile(screenshot, Buffer.from(capture.png, "base64"));
  return screenshot;
}

async function pluginAttention(baseUrl) {
  const registry = z
    .object({
      plugins: z.array(
        z.object({
          id: z.string(),
          enabled: z.boolean(),
          status: z.string(),
          statusDetail: z.string().nullable().optional(),
        }),
      ),
    })
    .parse(await json(`${baseUrl}/api/v1/plugins`));
  return registry.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      ["error", "incompatible", "missing"].includes(plugin.status),
  );
}

async function startRendererDiagnostics(debuggerClient, root, pass) {
  const eventsFile = requireWithin(
    root,
    join(root, `renderer-events-pass-${pass + 1}.jsonl`),
  );
  const response = await debuggerClient.evaluate(`(async () => {
    const electron = process.mainModule.require('electron');
    const fs = process.mainModule.require('node:fs');
    const file = ${JSON.stringify(eventsFile)};
    let writtenBytes = 0;
    let captureFull = false;
    const log = event => {
      if (captureFull) return;
      let line = JSON.stringify({at:new Date().toISOString(), ...event});
      if (line.length > 16384) line = JSON.stringify({kind:'event-truncated', preview:line.slice(0, 16000)});
      writtenBytes += Buffer.byteLength(line);
      if (writtenBytes > 2 * 1024 * 1024) {
        captureFull = true;
        line = JSON.stringify({kind:'capture-limit', bytes:writtenBytes});
      }
      fs.appendFileSync(file, line + '\\n');
    };
    const owned = new Map();
    let firstReadyResolve;
    let firstReadyReject;
    const firstReady = new Promise((resolve, reject) => {
      firstReadyResolve = resolve;
      firstReadyReject = reject;
    });
    const attach = async contents => {
      if (owned.has(contents.id)) return;
      if (contents.debugger.isAttached()) throw new Error('Renderer debugger already has a controller.');
      const previousBackgroundThrottling = contents.getBackgroundThrottling();
      contents.debugger.attach('1.3');
      owned.set(contents.id, {contents, previousBackgroundThrottling});
      log({kind:'attached', contentsId:contents.id, url:contents.getURL().slice(0,256), previousBackgroundThrottling});
      contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
          log({contentsId:contents.id, method, type:params.type, args:params.args.map(argument => argument.value ?? argument.description), stack:params.stackTrace});
        } else if (method === 'Runtime.exceptionThrown' || method === 'Network.loadingFailed') {
          log({contentsId:contents.id, method, params});
        } else if (method === 'Network.responseReceived' && params.response.status >= 400) {
          log({contentsId:contents.id, method, url:params.response.url, status:params.response.status, timestamp:params.timestamp});
        } else if (method === 'Network.webSocketCreated' || method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameError') {
          log({contentsId:contents.id, method, params});
        }
      });
      contents.setBackgroundThrottling(false);
      await Promise.all([
        contents.debugger.sendCommand('Runtime.enable'),
        contents.debugger.sendCommand('Network.enable'),
        contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true}),
      ]);
      log({kind:'diagnostic-focus-ready', contentsId:contents.id});
      firstReadyResolve();
    };
    const onCreated = (_event, contents) => {
      void attach(contents).catch(error => {
        log({kind:'attach-error', contentsId:contents.id, error:String(error)});
        firstReadyReject(error);
      });
    };
    electron.app.on('web-contents-created', onCreated);
    globalThis.__arcSmokeRendererDiagnostics = {
      async release() {
        electron.app.off('web-contents-created', onCreated);
        for (const {contents, previousBackgroundThrottling} of owned.values()) {
          if (contents.isDestroyed()) continue;
          contents.setBackgroundThrottling(previousBackgroundThrottling);
          if (contents.debugger.isAttached()) {
            await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:false});
            contents.debugger.detach();
          }
          log({kind:'diagnostic-focus-restored', contentsId:contents.id, backgroundThrottling:contents.getBackgroundThrottling()});
        }
      },
    };
    await Promise.all(electron.webContents.getAllWebContents().map(attach));
    await firstReady;
    return {eventsFile:file, attached:owned.size};
  })()`);
  return z
    .object({ eventsFile: z.string(), attached: z.number().int().positive() })
    .parse(response.result.value);
}

async function verifyRenderer(debuggerClient, baseUrl, root, pass) {
  const contentsExpression = appContentsExpression(baseUrl);
  const inspection =
    "(() => { const visible=element=>{const box=element.getBoundingClientRect();return box.width>0&&box.height>0&&box.top<innerHeight&&box.bottom>0&&box.left<innerWidth&&box.right>0&&!element.closest('[aria-hidden=true],[inert]')&&getComputedStyle(element).visibility!=='hidden';}; const hasComposer=()=>Array.from(document.querySelectorAll('[contenteditable=true],textarea')).some(visible); let openedWelcome=false; if(!hasComposer()) { const start=Array.from(document.querySelectorAll('button')).find(button=>button.innerText.includes('Start a new conversation') && visible(button) && !button.disabled); if(start) { start.click(); openedWelcome=true; } } return {title:document.title,dark:document.documentElement.classList.contains('dark'),rootChildren:document.querySelector('#root')?.childElementCount ?? 0,body:document.body.innerText,composer:hasComposer(),openedWelcome,pluginAttention:document.querySelector('[data-testid=sidebar-plugin-attention-glyph]')?.getAttribute('aria-label') ?? null,visibility:document.visibilityState,focused:document.hasFocus(),width:innerWidth,height:innerHeight}; })()";
  let openedWelcome = false;
  const facts = await waitFor("the actual packaged app renderer", async () => {
    const response = await debuggerClient.evaluate(
      `(async () => { const contents = ${contentsExpression}; return contents ? await contents.executeJavaScript(${JSON.stringify(inspection)}) : null; })()`,
    );
    const result = z
      .object({
        title: z.literal("ARC"),
        dark: z.literal(true),
        rootChildren: z.number().int().positive(),
        body: z.string().min(1),
        composer: z.boolean(),
        openedWelcome: z.boolean(),
        pluginAttention: z.string().nullable(),
        visibility: z.literal("visible"),
        focused: z.literal(true),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .parse(response.result.value);
    openedWelcome ||= result.openedWelcome;
    assert(
      result.body.includes("New thread"),
      "The packaged app shell did not render its navigation.",
    );
    assert(
      result.composer,
      "The packaged app did not open its composer from the welcome action.",
    );
    const attention = await pluginAttention(baseUrl);
    assert(
      attention.length === 0,
      `Enabled packaged plugins require attention: ${JSON.stringify(attention)}`,
    );
    assert(
      result.pluginAttention === null,
      `The packaged sidebar retained stale plugin attention: ${result.pluginAttention}`,
    );
    return result;
  });
  const screenshot = requireWithin(
    root,
    join(root, `renderer-pass-${pass + 1}.png`),
  );
  await captureRenderer(debuggerClient, baseUrl, screenshot);
  return { ...facts, openedWelcome, screenshot };
}

async function verifyAgentStudio(debuggerClient, baseUrl, root) {
  const contents = appContentsExpression(baseUrl);
  const inspect = async (script) => {
    const response = await debuggerClient.evaluate(
      `${contents}.executeJavaScript(${JSON.stringify(script)})`,
    );
    return response.result.value;
  };
  const click = async (label) =>
    z
      .boolean()
      .parse(
        await inspect(
          `(() => { const button=Array.from(document.querySelectorAll('button,a')).find(element=>element.textContent.trim()===${JSON.stringify(label)} && !element.disabled && !element.closest('[aria-hidden=true],[inert]') && element.getBoundingClientRect().width>0); if(!button)return false; button.scrollIntoView({block:'nearest'}); button.click(); return true; })()`,
        ),
      );
  await waitFor("the packaged Agents navigation", () => click("Agents"));
  await waitFor("the packaged Agent Studio view", async () =>
    z
      .boolean()
      .parse(
        await inspect(
          "!!document.querySelector('[data-arc-agent-studio] h1') && document.querySelector('[data-arc-agent-studio] h1').textContent==='Agent Studio'",
        ),
      ),
  );
  await waitFor("the packaged Create agent action", () =>
    click("Create agent"),
  );
  await waitFor("the packaged Studio guide editor", async () =>
    z
      .boolean()
      .parse(
        await inspect(
          "(() => { const input=document.querySelector('[aria-label=\"Agent name\"]'); if(!input || input.getBoundingClientRect().width===0)return false; input.focus(); input.select(); return true; })()",
        ),
      ),
  );
  const name = `Packaged Studio ${randomUUID().slice(0, 8)}`;
  await debuggerClient.evaluate(
    `${contents}.insertText(${JSON.stringify(name)})`,
  );
  await waitFor("the packaged Save draft action", () => click("Save draft"));
  const saved = await waitFor(
    "the Studio draft to reach packaged storage",
    async () => {
      const response = z
        .object({
          ok: z.literal(true),
          result: z.object({
            agents: z.array(
              z.object({ id: z.string().min(1), name: z.string() }),
            ),
          }),
        })
        .parse(
          await json(`${baseUrl}/api/v1/plugins/arc/rpc/listAgents`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: baseUrl },
            body: JSON.stringify({ scope: { kind: "library" }, search: name }),
          }),
        );
      return (
        response.result.agents.find((agent) => agent.name === name) ?? false
      );
    },
  );
  const savedDefinition = z
    .object({
      ok: z.literal(true),
      result: z.object({
        agent: z.object({
          id: z.literal(saved.id),
          draft: z.object({
            version: z.number().int().min(2),
            document: z.string().min(1),
          }),
        }),
      }),
    })
    .parse(
      await json(`${baseUrl}/api/v1/plugins/arc/rpc/getAgent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ scope: { kind: "library" }, agentId: saved.id }),
      }),
    );
  assert(
    savedDefinition.result.agent.draft.document.includes(name),
    "The packaged Studio did not save the canonical definition.",
  );
  await debuggerClient.evaluate(`${contents}.reload(); true`);
  const facts = await waitFor(
    "the saved packaged Studio editor after reload",
    async () => {
      const result = z
        .object({
          url: z.string(),
          name: z.literal(name),
          guide: z.literal(true),
          display: z.literal("flex"),
          background: z.string(),
          loadingAgent: z.literal(false),
          width: z.number().min(320),
          height: z.number().min(200),
        })
        .parse(
          await inspect(
            "(() => { const studio=document.querySelector('[data-arc-agent-studio]'); if(!studio)return null; const box=studio.getBoundingClientRect(); const style=getComputedStyle(studio); const loadingAgent=Array.from(document.querySelectorAll('[role=status]')).some(element=>element.textContent.includes('Loading agent…')&&element.getBoundingClientRect().width>0&&!element.closest('[aria-hidden=true],[inert]')); return {url:location.href,name:document.querySelector('[aria-label=\"Agent name\"]')?.value,guide:document.querySelector('#arc-tab-guide')?.getAttribute('aria-selected')==='true',display:style.display,background:style.backgroundColor,loadingAgent,width:box.width,height:box.height}; })()",
          ),
        );
      assert(
        result.background !== "rgba(0, 0, 0, 0)" &&
          result.background !== "transparent",
        "The packaged Studio background styles are missing.",
      );
      return result;
    },
  );
  const screenshot = requireWithin(root, join(root, "agent-studio.png"));
  await captureRenderer(debuggerClient, baseUrl, screenshot);
  return {
    ...facts,
    agentId: saved.id,
    draftVersion: savedDefinition.result.agent.draft.version,
    screenshot,
  };
}

async function terminalRoundtrip(
  baseUrl,
  hostId,
  root,
  workspace,
  projectId,
  executable,
) {
  requireWithin(root, workspace);
  const physicalWorkspace = (await realpath(workspace)).toLowerCase();
  const token = randomUUID();
  const filename = `terminal Δ ${token}.json`;
  const sentinel = requireWithin(workspace, join(workspace, filename));
  const post = (route, body) =>
    json(`${baseUrl}/api/v1/terminals${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify(body),
    });
  const sessionSchema = z.object({
    id: z.string().min(1),
    hostId: z.string().min(1),
    initialCwd: z.string(),
    status: z.string(),
  });
  const session = sessionSchema.parse(
    await post("", {
      cols: 120,
      rows: 30,
      title: "Packaged ConPTY verification",
      start: { mode: "shell" },
      target: { kind: "host_path", hostId, cwd: workspace },
    }),
  );
  let terminalFacts;
  try {
    assert(
      session.hostId === hostId &&
        (await realpath(session.initialCwd)).toLowerCase() ===
          physicalWorkspace,
      "Packaged terminal started outside the owned project.",
    );
    const quotedProjectId = projectId.replaceAll("'", "''");
    const command = `$arcTerminalToken = '${token}'; $arcCliVersion = (& $env:BB_CLI --version | Out-String).Trim(); $arcCliVersionExit = $LASTEXITCODE; $arcCliProject = (& $env:BB_CLI project show '${quotedProjectId}' --json | Out-String); $arcCliProjectExit = $LASTEXITCODE; @{ token = $arcTerminalToken; cwd = (Get-Location).Path; shell = $PSVersionTable.PSVersion.ToString(); pid = $PID; cliPath = $env:BB_CLI; cliRuntime = $env:BB_CLI_RUNTIME; cliVersion = $arcCliVersion; cliVersionExit = $arcCliVersionExit; cliProject = $arcCliProject; cliProjectExit = $arcCliProjectExit; nodeOnPath = [bool](Get-Command node -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress | Set-Content -LiteralPath '${filename}' -Encoding UTF8; Write-Output ('ARC_TERMINAL_' + $arcTerminalToken)\r`;
    await post(`/${encodeURIComponent(session.id)}/input`, {
      dataBase64: Buffer.from(command, "utf8").toString("base64"),
    });
    terminalFacts = await waitFor(
      "packaged PowerShell to write its Unicode workspace sentinel",
      async () => {
        const facts = z
          .object({
            token: z.literal(token),
            cwd: z.string(),
            shell: z.string().min(1),
            pid: z.number().int().positive(),
            cliPath: z.string().min(1),
            cliRuntime: z.string().min(1),
            cliVersion: z.string().regex(/^\d+\.\d+\.\d+/u),
            cliVersionExit: z.literal(0),
            cliProject: z.string().min(1),
            cliProjectExit: z.literal(0),
            nodeOnPath: z.literal(false),
          })
          .parse(
            JSON.parse(
              (await readFile(sentinel, "utf8")).replace(/^\uFEFF/u, ""),
            ),
          );
        assert(
          (await realpath(facts.cwd)).toLowerCase() === physicalWorkspace,
          "PowerShell changed the requested workspace.",
        );
        requireWithin(dirname(executable), facts.cliPath);
        assert(
          facts.cliPath.toLowerCase().endsWith("\\bb.cmd") &&
            resolve(facts.cliRuntime).toLowerCase() ===
              resolve(executable).toLowerCase(),
          "The terminal does not use the packaged Windows CLI and Electron runtime.",
        );
        const project = projectSchema.parse(JSON.parse(facts.cliProject));
        verifyProjectBinding(project, {
          projectId,
          name: project.name,
          hostId,
          workspace,
        });
        return facts;
      },
      30_000,
    );
    const terminalOutput = await waitFor(
      "packaged ConPTY output",
      async () => {
        const result = z
          .object({ chunks: z.array(z.object({ dataBase64: z.string() })) })
          .parse(
            await json(
              `${baseUrl}/api/v1/terminals/${encodeURIComponent(session.id)}/output?tailBytes=131072`,
            ),
          );
        const output = stripVTControlCharacters(
          Buffer.concat(
            result.chunks.map((chunk) =>
              Buffer.from(chunk.dataBase64, "base64"),
            ),
          ).toString("utf8"),
        );
        return output.includes(`ARC_TERMINAL_${token}`) ? output : false;
      },
      30_000,
    );
    await writeFile(
      requireWithin(root, join(root, `terminal-${token}.log`)),
      terminalOutput,
    );
  } finally {
    await post(`/${encodeURIComponent(session.id)}/close`, {
      mode: "force",
      reason: "user",
    });
  }
  await waitFor(
    "the owned terminal process to exit",
    () => {
      try {
        process.kill(terminalFacts.pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    },
    15_000,
    false,
  );
  return {
    terminalId: session.id,
    shell: terminalFacts.shell,
    processId: terminalFacts.pid,
    sentinel,
    cli: {
      path: terminalFacts.cliPath,
      runtime: terminalFacts.cliRuntime,
      version: terminalFacts.cliVersion,
      nodeOnPath: terminalFacts.nodeOnPath,
      projectId,
    },
  };
}

export function parseSmokeResume(raw) {
  const prior = z
    .object({
      status: z.literal("passed"),
      projectId: z.string().min(1),
      serverPort: z.number().int().min(1024).max(65535),
      daemonPort: z.number().int().min(1024).max(65535),
      context: z
        .array(
          z.object({
            pass: z.number().int().positive(),
            reference: z.object({
              id: z.string().min(1),
              revision: z.number().int().positive(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            }),
          }),
        )
        .min(1),
    })
    .parse(raw);
  return {
    projectId: prior.projectId,
    serverPort: prior.serverPort,
    daemonPort: prior.daemonPort,
    previousContext: prior.context.at(-1),
  };
}

export async function verifyProjectContext(
  baseUrl,
  saved,
  hostId,
  pass,
  previous,
) {
  const target = { projectId: saved.project.id, hostId, environmentId: null };
  const call = async (method, input) => {
    const result = await json(`${baseUrl}/api/v1/plugins/arc/rpc/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify(input),
    });
    assert(result.ok === true, `Context ${method} did not succeed`);
    return result.result;
  };
  const referenceText = `Shared project note ${saved.token}. The orbital dispatch limit is three.`;
  if (pass > 0) {
    assert(
      previous?.reference,
      "The first-pass Context reference identity is missing",
    );
    const retained = await call("listContextReferences", {
      projectId: saved.project.id,
    });
    assert(
      retained.sources.length === 1 &&
        retained.sources[0].id === previous.reference.id &&
        retained.sources[0].revision === previous.reference.revision &&
        retained.sources[0].sha256 === previous.reference.sha256,
      "Application restart lost or changed the saved Context reference",
    );
    const priorOriginal = await call("readContextReference", {
      projectId: saved.project.id,
      sourceId: previous.reference.id,
      revision: previous.reference.revision,
    });
    assert(
      priorOriginal.text === referenceText &&
        priorOriginal.source.sha256 === previous.reference.sha256,
      "Context original was not preserved before the import retry",
    );
  }
  const imported = await call("importContextSource", {
    target,
    operationId: `packaged-reference-${saved.token}`,
    sourceId: null,
    expectedRevision: null,
    name: "Project notes.md",
    text: referenceText,
  });
  assert(
    imported.outcome === "applied",
    "Packaged Context reference was rejected",
  );
  if (previous)
    assert(
      imported.reference.id === previous.reference.id &&
        imported.reference.revision === previous.reference.revision &&
        imported.reference.sha256 === previous.reference.sha256,
      "The import retry replaced the first-pass reference identity",
    );
  assert(
    pass > 0 || imported.indexError === null,
    `Packaged Context index could not start: ${imported.indexError}`,
  );
  const original = await call("readContextReference", {
    projectId: saved.project.id,
    sourceId: imported.reference.id,
    revision: 1,
  });
  assert(
    original.text === referenceText,
    "Context original changed after import or restart",
  );
  await call("reindexContext", {
    target,
    operationId: `packaged-index-${pass}-${saved.token}`,
  });
  const status = await waitFor(
    "packaged native Context index",
    async () => {
      const value = await call("getContextStatus", { target });
      assert(
        value.state !== "failed",
        `Context indexing failed: ${value.reason}`,
      );
      return value.state === "ready" ? value : false;
    },
    120_000,
    false,
  );
  assert(
    status.semantic === "ready",
    `Context semantic mode is ${status.semantic}`,
  );
  assert(
    status.counts.embeddedChunks >= 2,
    "Packaged model did not embed project and reference sources",
  );
  assert(
    status.coverage === "complete",
    "Packaged Context scan did not finish",
  );
  const results = await call("searchContext", {
    target,
    query: saved.token,
    limit: 8,
  });
  assert(
    results.mode === "hybrid",
    "Packaged Context search did not use the native model",
  );
  const hit = results.hits.find(
    (value) => value.relativePath === "preserve-project.txt",
  );
  assert(
    hit?.text === saved.token,
    "Context did not retrieve exact source bytes",
  );
  assert(
    hit.sha256 === createHash("sha256").update(saved.token).digest("hex"),
    "Context source hash differs from the packaged workspace",
  );
  const excerpt = await call("readContextExcerpt", {
    target,
    indexId: hit.indexId,
    chunkId: hit.chunkId,
    sourceGeneration: hit.sourceGeneration,
    sha256: hit.sha256,
  });
  assert(
    excerpt.state === "current" && excerpt.hit?.text === saved.token,
    "Packaged Context excerpt failed its freshness check",
  );
  const references = await call("listContextReferences", {
    projectId: saved.project.id,
  });
  assert(
    references.sources.length === 1 &&
      references.sources[0].id === imported.reference.id,
    "Context retry duplicated or replaced the persistent reference",
  );
  const stopped = await call("cancelContextIndexing", {
    target,
    operationId: status.operationId,
  });
  assert(
    stopped.state === "cancelled",
    "Packaged Context watching did not stop",
  );
  const cancelledExcerpt = await call("readContextExcerpt", {
    target,
    indexId: hit.indexId,
    chunkId: hit.chunkId,
    sourceGeneration: hit.sourceGeneration,
    sha256: hit.sha256,
  });
  assert(
    cancelledExcerpt.state === "stale" && cancelledExcerpt.hit === null,
    "Cancelled Context still exposed a current cached excerpt",
  );
  return {
    pass: pass + 1,
    target,
    importIndexError: imported.indexError,
    reference: imported.reference,
    status,
    hit,
    stopped,
    cancelledExcerpt,
  };
}

export async function runSmoke(executable, options = {}) {
  assert(
    process.platform === "win32" && process.arch === "x64",
    "This smoke test requires native Windows x64.",
  );
  executable = resolve(executable);
  await access(executable);
  const root = options.resume
    ? resolve(options.resume)
    : await mkdtemp(
        join(
          options.artifactsParent ? resolve(options.artifactsParent) : tmpdir(),
          "ARC packaged smoke Δ ",
        ),
      );
  const profile = join(root, "desktop-profile");
  const resumed = options.resume
    ? parseSmokeResume(
        JSON.parse(await readFile(join(root, "result.json"), "utf8")),
      )
    : null;
  const [serverPort, daemonPort, inspectorPort] = await reservePorts(
    resumed ? [resumed.serverPort, resumed.daemonPort, 0] : undefined,
  );
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const defaultEnvironment = createSmokeEnvironment(
    process.env,
    root,
    serverPort,
    daemonPort,
  );
  const env = options.configureEnvironment
    ? validateSmokeEnvironment(
        defaultEnvironment,
        await options.configureEnvironment({ ...defaultEnvironment }),
      )
    : defaultEnvironment;
  await Promise.all(
    [profile, env.HOME, env.APPDATA, env.TEMP, env.BB_DATA_DIR].map(
      (directory) => mkdir(directory, { recursive: true }),
    ),
  );
  const report = {
    status: "running",
    mode: options.diagnosticReload ? "diagnostic-reload" : "acceptance",
    executable,
    artifacts: root,
    serverPort,
    daemonPort,
    checks: [],
    limitations: [
      "Executed on this machine; not clean-Windows certification.",
      "Provider catalog only; authentication, streaming, tool calls and provider recovery require provider credentials.",
      "Does not install, upgrade or uninstall the installer.",
      "Does not certify Authenticode signing, public updates or provider workflows.",
    ],
  };
  let child;
  let ownedProcess;
  let debuggerClient;
  let output = "";
  let saved;
  if (options.resume) {
    saved = fixtureSchema.parse(
      JSON.parse(await readFile(join(root, "project-fixture.json"), "utf8")),
    );
    assert(
      saved.project.id === resumed.projectId,
      "The resumed report belongs to a different QA project.",
    );
    requireWithin(root, saved.workspace);
    requireWithin(saved.workspace, saved.sentinel);
    assert(
      (await readFile(saved.sentinel, "utf8")) === saved.token,
      "The resumed QA project sentinel differs from the original.",
    );
    report.projectId = saved.project.id;
    report.resumedProject = true;
  }
  let marker;
  console.log(`ARC Windows smoke artifacts: ${root}`);
  const check = (name) => {
    report.checks.push(name);
    console.log(`Verified: ${name}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    assert(
      ownedProcess,
      "Application process ownership was not recorded; refusing cleanup.",
    );
    assert(
      await readOwnedApplicationProcess(env, {
        pid: child.pid,
        executable,
        startedAt: ownedProcess.startedAt,
      }),
      "The owned application exited before normal quit.",
    );
    assert(debuggerClient, "Inspector is unavailable for normal app cleanup.");
    await debuggerClient.evaluate(
      "globalThis.__arcSmokeRendererDiagnostics?.release()",
    );
    await debuggerClient.evaluate(
      "setTimeout(() => process.mainModule.require('electron').app.quit(), 100); true",
    );
    debuggerClient.close();
    debuggerClient = null;
    await waitFor(
      "ARC to quit",
      () => child.exitCode !== null || child.signalCode !== null,
      20_000,
      false,
    );
    await waitFor(
      "owned server and daemon shutdown",
      async () => (await isClosed(serverPort)) && (await isClosed(daemonPort)),
      15_000,
    );
    await waitFor(
      "owned runtime marker cleanup",
      async () => {
        try {
          await access(join(profile, "owned-runtime.json"));
          return false;
        } catch (error) {
          if (error.code === "ENOENT") return true;
          throw error;
        }
      },
      10_000,
    );
    if (marker) {
      let alive = true;
      try {
        process.kill(marker.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else throw error;
      }
      assert(
        !alive,
        "The owned runtime supervisor survived application shutdown.",
      );
    }
  };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      console.log(`Starting packaged ARC (pass ${pass + 1}/2).`);
      ownedProcess = null;
      child = spawn(
        executable,
        [`--user-data-dir=${profile}`, `--inspect=127.0.0.1:${inspectorPort}`],
        {
          cwd: root,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4 * 1024 * 1024);
      });
      child.stderr.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4 * 1024 * 1024);
      });
      await new Promise((done, reject) => {
        child.once("spawn", done);
        child.once("error", reject);
      });
      ownedProcess = await readOwnedApplicationProcess(env, {
        pid: child.pid,
        executable,
      });
      assert(
        ownedProcess,
        "The selected application exited before process ownership could be verified.",
      );
      debuggerClient = await inspector(inspectorPort, child);
      const lifecyclePath = requireWithin(
        root,
        join(root, `lifecycle-pass-${pass + 1}.jsonl`),
      );
      await debuggerClient.evaluate(`(()=>{
        if(globalThis.__arcSmokeLifecycleObserved)return true;
        globalThis.__arcSmokeLifecycleObserved=true;
        const electron=process.mainModule.require('electron');
        const fs=process.mainModule.require('node:fs');
        const path=${JSON.stringify(lifecyclePath)};
        let bytes=0;
        const record=(event,details={})=>{
          if(bytes>1024*1024)return;
          try{const line=JSON.stringify({at:new Date().toISOString(),pid:process.pid,event,...details})+'\\n';bytes+=Buffer.byteLength(line);fs.appendFileSync(path,line);}catch{}
        };
        const windowIds=()=>electron.BrowserWindow.getAllWindows().map(window=>window.id);
        const attach=window=>{
          record('window-observed',{windowId:window.id,webContentsId:window.webContents.id});
          window.on('close',()=>record('window-close',{windowId:window.id}));
          window.on('closed',()=>record('window-closed',{windowId:window.id}));
        };
        for(const window of electron.BrowserWindow.getAllWindows())attach(window);
        electron.app.on('browser-window-created',(_event,window)=>attach(window));
        for(const event of ['before-quit','will-quit','window-all-closed'])electron.app.on(event,()=>record(event,{windowIds:windowIds()}));
        electron.app.on('quit',(_event,exitCode)=>record('quit',{exitCode}));
        electron.app.on('render-process-gone',(_event,contents,details)=>record('render-process-gone',{webContentsId:contents.id,reason:details.reason,exitCode:details.exitCode}));
        electron.app.on('child-process-gone',(_event,details)=>record('child-process-gone',{type:details.type,reason:details.reason,exitCode:details.exitCode}));
        process.on('exit',exitCode=>record('process-exit',{exitCode}));
        process.on('uncaughtExceptionMonitor',error=>record('uncaught-exception',{name:error.name,code:error.code??null}));
        for(const signal of ['SIGINT','SIGTERM'])if(process.listenerCount(signal)>0)process.on(signal,()=>record('signal',{signal}));
        record('attached',{windowIds:windowIds()});
        return true;
      })()`);
      assert(
        report.applicationVersion === undefined ||
          report.applicationVersion === debuggerClient.facts.version,
        "Application version changed between restart passes.",
      );
      report.applicationVersion = debuggerClient.facts.version;
      assert(
        resolve(debuggerClient.facts.execPath).toLowerCase() ===
          executable.toLowerCase(),
        "The inspector belongs to a different executable.",
      );
      assert(
        resolve(debuggerClient.facts.userData).toLowerCase() ===
          resolve(profile).toLowerCase(),
        "ARC did not honor the isolated --user-data-dir; stopping before application data changes.",
      );
      report.rendererDiagnostics ??= [];
      report.rendererDiagnostics.push(
        await startRendererDiagnostics(debuggerClient, root, pass),
      );
      marker = runtimeSchema.parse(
        await waitFor("the isolated owned runtime marker", async () =>
          JSON.parse(
            await readFile(join(profile, "owned-runtime.json"), "utf8"),
          ),
        ),
      );
      assert(
        marker.serverUrl.replace(/\/$/, "") === baseUrl,
        "The desktop connected to a server outside the smoke test.",
      );
      requireWithin(dirname(executable), marker.bridgePath);
      await waitFor("the packaged server", async () => {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok;
      });
      const config = await json(`${baseUrl}/api/v1/system/config`);
      assert(
        typeof config.dataDir === "string" &&
          resolve(config.dataDir).toLowerCase() ===
            resolve(env.BB_DATA_DIR).toLowerCase(),
        "The server does not use the isolated smoke data directory.",
      );
      const daemon = await waitFor("the packaged host daemon", async () => {
        const status = await json(`http://127.0.0.1:${daemonPort}/status`);
        return status.connected === true &&
          status.serverUrl?.replace(/\/$/, "") === baseUrl
          ? z
              .object({
                hostId: z.string().min(1),
                platform: z.string(),
                protocolVersion: z.number().int().positive(),
              })
              .parse(status)
          : false;
      });
      report.hostDaemon = daemon;
      assert(
        daemon.platform === "win32",
        "The native Windows daemon does not identify its platform correctly.",
      );
      const providers = z
        .array(z.object({ id: z.string(), displayName: z.string() }))
        .parse(await json(`${baseUrl}/api/v1/system/providers`));
      assert(
        requiredProviders.every((provider) =>
          providers.some((entry) => entry.id === provider),
        ),
        "At least one of the eight required providers is missing from the catalog.",
      );
      report.providers = providers;
      report.payload = await verifyPayload(baseUrl, dirname(executable));
      check(
        `Pass ${pass + 1}: Electron, server, native host daemon, provider catalog and forecast-free package`,
      );
      if (options.diagnosticReload) {
        await waitFor(
          "plugin startup to finish before the diagnostic reload",
          async () => (await pluginAttention(baseUrl)).length === 0,
        );
        await debuggerClient.evaluate(
          `${appContentsExpression(baseUrl)}.reload(); true`,
        );
        check(
          `Pass ${pass + 1}: diagnostic page reload after backend startup; this run is not first-launch acceptance`,
        );
      }
      report.renderers ??= [];
      report.renderers.push(
        await verifyRenderer(debuggerClient, baseUrl, root, pass),
      );
      check(
        `Pass ${pass + 1}: actual packaged renderer, ARC title, dark theme, navigation and composer`,
      );
      if (!saved) {
        const workspace = requireWithin(
          root,
          join(root, "Project workspace 東京"),
        );
        await mkdir(workspace);
        const sentinel = requireWithin(
          workspace,
          join(workspace, "preserve-project.txt"),
        );
        const token = randomUUID();
        await writeFile(sentinel, token);
        const project = projectSchema.parse(
          await json(`${baseUrl}/api/v1/projects`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: baseUrl },
            body: JSON.stringify({
              name: "Packaged Windows smoke Δ",
              source: {
                type: "local_path",
                hostId: daemon.hostId,
                path: workspace,
              },
            }),
          }),
        );
        verifyProjectBinding(project, {
          projectId: project.id,
          name: project.name,
          hostId: daemon.hostId,
          workspace,
        });
        saved = { project, workspace, sentinel, token };
        await writeFile(
          join(root, "project-fixture.json"),
          `${JSON.stringify(saved, null, 2)}\n`,
        );
        report.projectId = project.id;
        check(
          "Created a persisted IDE project bound to its native Unicode workspace",
        );
      } else {
        const project = await json(
          `${baseUrl}/api/v1/projects/${encodeURIComponent(saved.project.id)}`,
        );
        verifyProjectBinding(project, {
          projectId: saved.project.id,
          name: saved.project.name,
          hostId: daemon.hostId,
          workspace: saved.workspace,
        });
        assert(
          (await readFile(saved.sentinel, "utf8")) === saved.token,
          "Restart changed a user project file.",
        );
        check(
          "Restart preserved project identity, host workspace binding and original file bytes",
        );
      }
      report.context ??= [];
      report.context.push(
        await verifyProjectContext(
          baseUrl,
          saved,
          daemon.hostId,
          pass + (resumed?.previousContext.pass ?? 0),
          report.context.at(-1) ?? resumed?.previousContext,
        ),
      );
      check(
        `Pass ${pass + 1}: packaged Context capability, native model, hybrid retrieval, exact provenance, persistent reference retry and settled watch cancellation`,
      );
      report.terminals ??= [];
      report.terminals.push(
        await terminalRoundtrip(
          baseUrl,
          daemon.hostId,
          root,
          saved.workspace,
          saved.project.id,
          executable,
        ),
      );
      check(
        `Pass ${pass + 1}: packaged CLI with Electron and no Node on PATH, project SDK request, PowerShell ConPTY input/output, Unicode workspace write and owned terminal cleanup`,
      );
      if (pass === 1) {
        report.agentStudio = await verifyAgentStudio(
          debuggerClient,
          baseUrl,
          root,
        );
        check(
          "Packaged Agent Studio navigation, styled guide editor, native input, canonical draft save and reload",
        );
      }
      if (options.verifyFeatures) {
        report.features ??= [];
        report.features.push(
          await options.verifyFeatures({
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
            cli: report.terminals.at(-1).cli,
          }),
        );
      }
      await stop();
      check(
        `Pass ${pass + 1}: graceful application quit cleaned up its server, daemon and runtime supervisor`,
      );
    }
    report.status = options.diagnosticReload ? "diagnostic-only" : "passed";
  } catch (error) {
    report.status = "failed";
    report.error =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      await stop();
    } catch (cleanupError) {
      report.cleanupError = String(cleanupError);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const windows = Object.entries(env).find(
        ([key]) => key.toUpperCase() === "SYSTEMROOT",
      )[1];
      try {
        assert(
          ownedProcess,
          "Application ownership was not recorded; refusing forced cleanup.",
        );
        assert(
          await readOwnedApplicationProcess(env, {
            pid: child.pid,
            executable,
            startedAt: ownedProcess.startedAt,
          }),
          "The owned application is no longer running; forced cleanup is unnecessary.",
        );
        await execFileAsync(
          join(windows, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 15_000 },
        );
        report.forcedTestProcessCleanup = true;
      } catch (cleanupError) {
        report.cleanupError = `${report.cleanupError ?? ""} Exact test-owned application PID ${child.pid} cleanup failed: ${cleanupError}`;
      }
    }
    process.exitCode = 1;
  } finally {
    debuggerClient?.close();
    child?.unref();
    child?.stdout?.unref();
    child?.stderr?.unref();
    await writeFile(join(root, "electron.log"), output);
    await writeFile(
      join(root, "result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-windows.mjs [--executable C:\\path\\to\\ARC IDE.exe]\nDefaults to apps/desktop/release/win-unpacked/ARC IDE.exe. Uses temporary data and ports; retains its result.json and logs. Does not certify clean Windows, provider authentication or installer lifecycle.",
    );
  else
    await runSmoke(
      values.executable ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../release/win-unpacked/ARC IDE.exe",
        ),
    ).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

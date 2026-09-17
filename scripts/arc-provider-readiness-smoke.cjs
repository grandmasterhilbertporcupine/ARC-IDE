const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { createInterface } = require("node:readline");

if (process.platform !== "win32") throw new Error("This smoke probe targets native Windows.");

const command = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
const taskkill = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
const results = {};
function readCli(provider, args) {
  const child = spawnSync(command, ["/d", "/s", "/c", `${provider} ${args}`], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
  return child.stdout?.trim() ?? "";
}
for (const provider of ["codex", "claude"]) {
  results[provider] = { version: readCli(provider, "--version") };
}
try {
  const state = JSON.parse(readCli("claude", "auth status"));
  results.claude.authenticated = state.loggedIn === true;
  results.claude.statusReadable = typeof state.loggedIn === "boolean";
} catch {
  results.claude.statusReadable = false;
}

const child = spawn(command, ["/d", "/s", "/c", "codex app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
const pending = new Map();
let nextId = 0;
const reader = createInterface({ input: child.stdout });
reader.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error("RPC rejected"));
  else waiter.resolve(message.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function stop() {
  reader.close();
  if (child.pid && child.exitCode === null) spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
}
const timeout = setTimeout(() => {
  stop();
  for (const waiter of pending.values()) waiter.reject(new Error("Timed out"));
}, 20_000);
child.on("error", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("Spawn failed"));
});
(async () => {
  try {
    await request("initialize", { clientInfo: { name: "arc-smoke", title: "ARC readiness check", version: "0.1.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const state = await request("account/read", { refreshToken: false });
    results.codex.statusReadable = typeof state.requiresOpenaiAuth === "boolean";
    results.codex.authenticated = state.account !== null || state.requiresOpenaiAuth === false;
    results.codex.accountType = state.account?.type ?? null;
    if (state.account?.type === "chatgpt") {
      const usage = await request("account/rateLimits/read", {});
      results.codex.usageReadable = usage.rateLimits !== null || Object.keys(usage.rateLimitsByLimitId ?? {}).length > 0;
    }
  } catch {
    results.codex.statusReadable = false;
  } finally {
    clearTimeout(timeout);
    stop();
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  }
})();

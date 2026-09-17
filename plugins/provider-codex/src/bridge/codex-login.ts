import { gzipSync } from "node:zlib";

async function codexLoginRuntime(
  openBrowser: boolean,
  modules: {
    childProcess: typeof import("node:child_process");
    readline: typeof import("node:readline");
    path: typeof import("node:path");
  },
): Promise<void> {
  const { spawn, spawnSync } = modules.childProcess;
  const { createInterface } = modules.readline;
  const { win32 } = modules.path;
  const windows = process.platform === "win32";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const command = windows
    ? win32.join(systemRoot, "System32", "cmd.exe")
    : "codex";
  const args = windows
    ? ["/d", "/s", "/c", "codex app-server"]
    : ["app-server"];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    detached: !windows,
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let requestId = 0;
  let loginId: string | null = null;
  let finished = false;
  let loginCompleted: Record<string, unknown> | null = null;
  let completionResolve: () => void = () => {};
  let completionReject: (error: Error) => void = () => {};
  const completion = new Promise<void>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  void completion.catch(() => {});
  function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
  function request(method: string, params: object): Promise<unknown> {
    if (finished || child.stdin.destroyed)
      return Promise.reject(new Error("Codex login connection closed."));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  function fail(message: string) {
    const error = new Error(message);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    completionReject(error);
  }
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message: Record<string, unknown> | null;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }
    if (message === null) return;
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error)
          waiter.reject(
            new Error("Codex app-server rejected the authentication request."),
          );
        else waiter.resolve(message.result);
      }
    }
    if (message.method === "account/login/completed") {
      loginCompleted = object(message.params);
      completeIfExpected();
    }
  });
  function completeIfExpected() {
    if (loginId === null || loginCompleted?.loginId !== loginId) return;
    if (loginCompleted?.success === true) completionResolve();
    else
      completionReject(
        new Error(
          "Codex authentication was cancelled or failed. Run Sign in again.",
        ),
      );
  }
  child.on("error", () =>
    fail("Codex could not start. Install Codex and retry Sign in."),
  );
  child.on("exit", () => {
    if (!finished) fail("Codex closed before authentication completed.");
  });
  child.stdin.on("error", () => fail("Codex login connection closed."));
  const cancel = () => {
    if (loginId !== null)
      void request("account/login/cancel", { loginId }).catch(() => {});
    fail("Codex authentication cancelled.");
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = setTimeout(cancel, 15 * 60_000);
  try {
    await request("initialize", {
      clientInfo: { name: "arc", title: "ARC", version: "0.1.0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n",
    );
    const login = object(
      await request("account/login/start", { type: "chatgpt" }),
    );
    if (
      login?.type !== "chatgpt" ||
      typeof login.loginId !== "string" ||
      typeof login.authUrl !== "string"
    )
      throw new Error("Codex returned an unsupported authentication flow.");
    const url = new URL(login.authUrl);
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "auth.openai.com" ||
        url.hostname.endsWith(".openai.com") ||
        url.hostname === "chatgpt.com"
      )
    )
      throw new Error("Codex returned an unexpected authentication address.");
    loginId = login.loginId;
    completeIfExpected();
    process.stdout.write(
      `Complete your sign-in with OpenAI:\n${url.href}\nWaiting for Codex authentication…\n`,
    );
    if (openBrowser) {
      const browser = windows
        ? spawn(
            win32.join(
              systemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Start-Process -FilePath '${url.href.replaceAll("'", "''")}'`,
            ],
            { stdio: "ignore", windowsHide: true },
          )
        : spawn(
            process.platform === "darwin" ? "open" : "xdg-open",
            [url.href],
            { stdio: "ignore" },
          );
      browser.on("error", () => {});
      browser.unref();
    }
    await completion;
    const status = object(
      await request("account/read", { refreshToken: false }),
    );
    const account = object(status?.account);
    if (account?.type !== "chatgpt")
      throw new Error("Codex did not confirm a signed-in ChatGPT account.");
    process.stdout.write(
      "Codex sign-in verified. Return to ARC and refresh provider status.\n",
    );
  } finally {
    finished = true;
    clearTimeout(timeout);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    reader.close();
    if (child.pid && child.exitCode === null) {
      if (windows)
        spawnSync(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", timeout: 5_000 },
        );
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    }
  }
}

export function codexLoginCommand(openBrowser = true): string {
  const script = `(${codexLoginRuntime.toString()})(${JSON.stringify(openBrowser)}, { childProcess: require('node:child_process'), readline: require('node:readline'), path: require('node:path') }).catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; })`;
  return `node -e "eval(require('node:zlib').gunzipSync(Buffer.from('${gzipSync(script).toString("base64")}','base64')).toString())"`;
}

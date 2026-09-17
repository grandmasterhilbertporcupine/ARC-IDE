import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { experimental_resolveWindowsPowerShell as resolveWindowsPowerShell } from "@get-bb/plugin-sdk/provider-bridge";
import { codexLoginCommand } from "./codex-login.js";

const execFileAsync = promisify(execFile);

describe("Codex app-server login", () => {
  it("completes and verifies the documented login handshake through the native shell", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arc auth 空間 "));
    try {
      const fixture = `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.AUTH_TEST_LOG, m.method + '\\n');
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ userAgent: 'test' });
  if (m.method === 'account/login/start') {
    reply({ type: 'chatgpt', loginId: 'test-login', authUrl: 'https://auth.openai.com/authorize?test=true' });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'account/login/completed', params: { loginId: 'test-login', success: true } }) + '\\n');
  }
  if (m.method === 'account/read') reply({ account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' }, requiresOpenaiAuth: true });
});`;
      await writeFile(path.join(root, "fake.cjs"), fixture);
      const windows = process.platform === "win32";
      await writeFile(
        path.join(root, windows ? "codex.cmd" : "codex"),
        windows
          ? '@echo off\r\nnode "%~dp0fake.cjs"\r\n'
          : '#!/bin/sh\nexec node "$(dirname "$0")/fake.cjs"\n',
        { mode: 0o755 },
      );
      const login = codexLoginCommand(false);
      expect(login.length).toBeLessThan(10_000);
      const log = path.join(root, "methods.log");
      const output = await execFileAsync(
        windows ? resolveWindowsPowerShell() : "sh",
        windows
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", login]
          : ["-c", login],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
            AUTH_TEST_LOG: log,
          },
          windowsHide: true,
          timeout: 20_000,
        },
      );
      expect(output.stdout).toContain("Codex sign-in verified");
      expect(await readFile(log, "utf8")).toBe(
        "initialize\ninitialized\naccount/login/start\naccount/read\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});

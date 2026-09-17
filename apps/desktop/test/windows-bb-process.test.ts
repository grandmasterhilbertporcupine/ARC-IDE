import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessGroup } from "@bb/process-utils";
import { expect, it } from "vitest";
import { z } from "zod";
import { startBbAppProcess } from "../src/bb-process.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.skipIf(process.platform !== "win32")(
  "stops the native desktop runtime and descendants without stopping an unrelated process",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ARC runtime Δ "));
    const script = join(root, "runtime.cjs");
    await writeFile(
      script,
      `const { spawn } = require('node:child_process');
if (process.argv[2] === 'leaf') { console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000); }
else { const child = spawn(process.execPath, [__filename, process.argv[2] === 'middle' ? 'leaf' : 'middle'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); child.stdout.on('data', chunk => process.stdout.write(chunk)); console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000); }
`,
      "utf8",
    );
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    const runtime = await startBbAppProcess({
      bridgePath: script,
      cwd: root,
      env: process.env,
      logLineLimit: 100,
      runtime: {
        kind: "direct",
        mode: "node",
        executablePath: process.execPath,
      },
    });
    try {
      await expect
        .poll(() => runtime.logs.text().split("\n").filter(Boolean).length, {
          timeout: 10000,
        })
        .toBe(3);
      const pids = runtime.logs
        .text()
        .split("\n")
        .map(
          (line) =>
            z
              .object({ pid: z.number().int().positive() })
              .parse(JSON.parse(line)).pid,
        );
      expect(pids).toContain(runtime.pid);
      expect(pids.every(alive)).toBe(true);
      await runtime.stop({
        signal: "SIGTERM",
        timeoutMs: 1000,
        killSignal: "SIGKILL",
        killTimeoutMs: 5000,
      });
      expect(pids.some(alive)).toBe(false);
      expect(sentinel.pid).toBeDefined();
      expect(alive(sentinel.pid!)).toBe(true);
    } finally {
      await runtime.stop({
        signal: "SIGTERM",
        timeoutMs: 1000,
        killSignal: "SIGKILL",
        killTimeoutMs: 5000,
      });
      if (sentinel.pid && alive(sentinel.pid))
        killProcessGroup({ child: sentinel, signal: "SIGKILL" });
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  },
  20000,
);

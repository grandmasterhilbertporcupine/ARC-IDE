import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killProcessGroup } from "@bb/process-utils";
import {
  commandOutput,
  readCliVersion,
  resolveExecutablePath,
} from "./provider-maintenance-kit.js";

describe.skipIf(process.platform !== "win32")(
  "Windows provider runtime probes",
  () => {
    it("terminates a timed-out command shim and all of its probe descendants", async () => {
      const directory = await mkdtemp(join(tmpdir(), "WNDR stalled probe Δ "));
      const command = join(directory, "stalled.cmd");
      const pidFile = join(directory, "pids.jsonl");
      const pids: number[] = [];
      function alive(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
      try {
        await writeFile(
          command,
          `@echo off\r\n"${process.execPath}" "%~dp0stalled.cjs"\r\n`,
          "utf8",
        );
        await writeFile(
          join(directory, "stalled.cjs"),
          `const fs = require('node:fs');
fs.appendFileSync(require('node:path').join(__dirname, 'pids.jsonl'), JSON.stringify(process.pid) + '\\n');
if (process.argv[2] !== 'leaf') require('node:child_process').spawn(process.execPath, [__filename, 'leaf'], { windowsHide: true, stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
          "utf8",
        );
        expect(await readCliVersion(command)).toBeNull();
        pids.push(
          ...(await readFile(pidFile, "utf8")).trim().split("\n").map(Number),
        );
        expect(pids).toHaveLength(2);
        expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(
          true,
        );
        expect(pids.some(alive)).toBe(false);
      } finally {
        for (const pid of pids)
          if (alive(pid))
            killProcessGroup({
              child: { pid, kill: (signal) => process.kill(pid, signal) },
              signal: "SIGKILL",
            });
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    }, 15000);

    it("detects and executes command shims in Unicode paths containing spaces", async () => {
      const directory = await mkdtemp(join(tmpdir(), "WNDR 予測 provider "));
      const command = join(directory, "test-provider.cmd");
      try {
        await writeFile(
          command,
          "@echo off\r\necho provider-cli 1.2.3\r\n",
          "utf8",
        );
        expect(await resolveExecutablePath(command)).toBe(command);
        expect(await readCliVersion(command)).toBe("1.2.3");
        expect(await commandOutput(command, ["--version"])).toContain(
          "provider-cli 1.2.3",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 15000);
  },
);

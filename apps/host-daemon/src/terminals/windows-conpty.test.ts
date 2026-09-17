import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";
import { resolveWindowsPowerShell } from "@bb/process-utils";

describe.skipIf(process.platform !== "win32")("native Windows ConPTY", () => {
  it("runs PowerShell in a path containing spaces and Unicode and closes cleanly", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "WNDR 予測 ")));
    const terminal = spawn(
      resolveWindowsPowerShell(),
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::WriteLine('__WNDR_CWD__' + (Get-Location).Path); exit 0",
      ],
      {
        cwd,
        cols: 100,
        rows: 30,
        name: "xterm-256color",
        env: process.env,
        useConpty: true,
      },
    );
    let output = "";
    const data = terminal.onData((chunk) => {
      output += chunk;
    });
    try {
      const result = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ConPTY exit timed out")),
          10000,
        );
        terminal.onExit((event) => {
          clearTimeout(timer);
          resolve(event.exitCode);
        });
      });
      expect(result).toBe(0);
      expect(output).toContain(`__WNDR_CWD__${cwd}`);
    } finally {
      data.dispose();
      terminal.kill();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);
});

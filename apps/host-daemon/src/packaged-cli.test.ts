import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnPortableSyncProcess } from "@bb/process-utils";
import { prepareRuntimeShellEnv } from "./runtime-shell-env.js";

describe.runIf(process.platform === "win32")("packaged Windows CLI", () => {
  it("uses its scoped runtime without Node on PATH and preserves arguments and exit status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ARC's CLI Δ & spaced-"));
    const parentElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    try {
      await copyFile(
        fileURLToPath(new URL("../scripts/bb.cmd", import.meta.url)),
        join(directory, "bb.cmd"),
      );
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      await writeFile(
        join(directory, "bb"),
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), reexec: process.env.BB_CLI_REEXEC, electron: process.env.ELECTRON_RUN_AS_NODE })); process.exitCode = 7;",
      );
      const shellEnv = prepareRuntimeShellEnv({
        bbExecutableDirectory: directory,
        inheritedPath: win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
        ),
        serverUrl: "http://127.0.0.1:1",
      });
      const args = ["hello world", "O'Reilly", "x&y", "%literal%", 'a"b', "Δ"];
      const result = spawnPortableSyncProcess({
        command: join(directory, "bb.cmd"),
        args,
        cwd: directory,
        env: { ...process.env, ...shellEnv },
        stdio: "pipe",
      });
      expect(result.error).toBeFalsy();
      expect(result.stderr.toString()).toBe("");
      expect(result.status).toBe(7);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        args,
        reexec: "1",
        electron: "1",
      });
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe(parentElectronMode);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

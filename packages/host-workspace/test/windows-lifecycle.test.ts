import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSetupScriptCommand,
  runSetupScript,
} from "../src/provisioning.js";

describe.skipIf(process.platform !== "win32")(
  "native Windows worktree hooks",
  () => {
    it("builds a direct PowerShell invocation without interpolating project paths", () => {
      const scriptPath = "C:\\Users\\Collin Chen\\予測\\.bb-env-setup.ps1";
      expect(
        buildSetupScriptCommand({ platform: "win32", scriptPath }).args,
      ).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        scriptPath,
      ]);
    });

    it("rejects a POSIX-only hook instead of silently skipping required setup", async () => {
      const directory = await mkdtemp(join(tmpdir(), "WNDR 予測 hook "));
      try {
        await writeFile(
          join(directory, ".bb-env-setup.sh"),
          "#!/bin/sh\nexit 0\n",
        );
        await expect(
          runSetupScript({ workspacePath: directory, timeoutMs: 10000 }),
        ).rejects.toThrow("Add .bb-env-setup.ps1");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("executes a native hook in its workspace with the inherited Windows execution policy", async () => {
      const directory = await mkdtemp(join(tmpdir(), "WNDR 予測 hook "));
      try {
        await writeFile(
          join(directory, ".bb-env-setup.ps1"),
          "Set-Content -LiteralPath (Join-Path (Get-Location) 'ready.txt') -Value 'ready'\n",
          "utf8",
        );
        const result = await runSetupScript({
          workspacePath: directory,
          timeoutMs: 10000,
        });
        expect(result.exitCode).toBe(0);
        expect(
          (await readFile(join(directory, "ready.txt"), "utf8")).trim(),
        ).toBe("ready");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 15000);
  },
);

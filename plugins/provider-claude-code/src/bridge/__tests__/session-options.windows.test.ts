import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveClaudeCodeExecutable } from "../session-options.js";

it.skipIf(process.platform !== "win32")(
  "resolves native Claude shims and user installs instead of the coexisting POSIX shim",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ARC Claude Δ "));
    try {
      await writeFile(join(root, "claude"), "#!/bin/sh\nexit 0\n");
      const shim = join(root, "claude.cmd");
      await writeFile(shim, "@echo off\r\nexit /b 0\r\n");
      expect(resolveClaudeCodeExecutable({ env: { PATH: root } })).toBe(shim);
      expect(resolveClaudeCodeExecutable({ env: { Path: `"${root}"` } })).toBe(
        shim,
      );
      const native = join(root, ".local", "bin", "claude.exe");
      await mkdir(join(root, ".local", "bin"), { recursive: true });
      await writeFile(native, "MZ");
      expect(
        resolveClaudeCodeExecutable({ env: { USERPROFILE: root, PATH: "" } }),
      ).toBe(native);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

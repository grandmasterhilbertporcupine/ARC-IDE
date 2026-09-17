import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  killProcessGroup,
  spawnPortablePipedProcess,
  stopProcessGroupLeaderFirst,
} from "../src/index.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "win32")(
  "native Windows child lifecycle",
  () => {
    it.each(["group", "leader-first"])(
      "terminates owned descendants using %s shutdown without affecting an unrelated process",
      async (mode) => {
        const cwd = await mkdtemp(join(tmpdir(), "arc 予測 process "));
        const unrelated = spawnPortablePipedProcess({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        });
        const child = spawnPortablePipedProcess({
          command: process.execPath,
          args: [
            "-e",
            "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(() => {},1000)",
          ],
          cwd,
        });
        let descendant = 0;
        try {
          descendant = Number(
            String((await once(child.stdout, "data"))[0]).trim(),
          );
          expect(alive(descendant)).toBe(true);
          const closed = once(child, "close");
          if (mode === "group") killProcessGroup({ child, signal: "SIGTERM" });
          else
            await stopProcessGroupLeaderFirst({
              child,
              timeoutMs: 1000,
              killGraceMs: 1000,
            });
          await closed;
          expect(alive(descendant)).toBe(false);
          expect(alive(unrelated.pid ?? 0)).toBe(true);
        } finally {
          if (child.exitCode === null)
            killProcessGroup({ child, signal: "SIGKILL" });
          if (descendant > 0 && alive(descendant))
            process.kill(descendant, "SIGKILL");
          killProcessGroup({ child: unrelated, signal: "SIGKILL" });
          await rm(cwd, { recursive: true, force: true });
        }
      },
      15000,
    );
  },
);

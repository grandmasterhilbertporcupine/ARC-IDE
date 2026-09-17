import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createNodeVerifiedProcessOps,
  stopVerifiedProcess,
} from "../src/verified-process-stop.js";

describe.skipIf(process.platform !== "win32")(
  "Windows process identity",
  () => {
    it("verifies command and start time before stopping a Windows process", async () => {
      const marker = "arc-native-stop-test";
      const child = spawn(
        process.execPath,
        ["-e", `console.log('${marker}');setInterval(() => {},1000)`],
        { windowsHide: true },
      );
      try {
        if (!child.stdout || !child.pid)
          throw new Error("Test process did not start");
        await once(child.stdout, "data");
        const ops = createNodeVerifiedProcessOps();
        expect(await ops.readCommand(child.pid)).toContain(marker);
        expect(await ops.readElapsedSeconds(child.pid)).toBeGreaterThanOrEqual(
          0,
        );
        const common = {
          pid: child.pid,
          verifyTokens: [marker],
          signal: "SIGTERM" as const,
          timeoutMs: 1000,
          killTimeoutMs: 1000,
        };
        expect(
          await stopVerifiedProcess({
            ...common,
            startedAt: "2000-01-01T00:00:00Z",
          }),
        ).toMatchObject({ kind: "unverified", reason: "start-time" });
        expect(ops.isRunning(child.pid)).toBe(true);
        expect(
          await stopVerifiedProcess({
            ...common,
            startedAt: new Date().toISOString(),
          }),
        ).toMatchObject({ kind: "stopped" });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }, 30000);
  },
);

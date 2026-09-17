import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextFixture,
  processIsAbsent,
  waitForPhase,
} from "./test-fixture.js";

const fixtures: Awaited<ReturnType<typeof contextFixture>>[] = [];
async function fixture(mode: "normal" | "initializing" = "normal") {
  const result = await contextFixture(mode);
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) await entry.dispose();
});

describe.runIf(process.platform === "win32" && process.arch === "x64")(
  "Context client real child lifecycle",
  () => {
    it("refuses count and embedding admission without initializing an expected helper", async () => {
      const { client, digest, events } = await fixture();
      for (const operation of ["countTokens", "embed"] as const)
        await expect(
          client[operation]({
            requestId: operation,
            expectedManifestDigest: digest,
            expectedGeneration: "never-initialized",
            items: [{ id: "source", text: "source" }],
          }),
        ).rejects.toMatchObject({ code: "worker_stopped" });
      await expect(readFile(events)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rejects an old generation before and after explicit replacement without dispatching native work", async () => {
      const { client, digest, events } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      const input = {
        requestId: "hold",
        expectedManifestDigest: digest,
        expectedGeneration: ready.generation,
        items: [{ id: "hold", text: "hold" }],
      };
      const active = client.embed(input).catch((error: unknown) => error);
      await waitForPhase(events, "embedding");
      await client.cancel(input.requestId);
      expect(await active).toMatchObject({ code: "cancelled" });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
      const stoppedEvents = await readFile(events, "utf8");
      for (const operation of ["countTokens", "embed"] as const)
        await expect(
          client[operation]({ ...input, requestId: operation }),
        ).rejects.toMatchObject({ code: "worker_stopped" });
      expect(await readFile(events, "utf8")).toBe(stoppedEvents);
      const replacement = await client.status();
      if (replacement.state !== "ready")
        throw new Error("Expected replacement helper");
      expect(replacement.generation).not.toBe(ready.generation);
      const replacementEvents = await readFile(events, "utf8");
      for (const operation of ["countTokens", "embed"] as const)
        await expect(
          client[operation]({ ...input, requestId: operation }),
        ).rejects.toMatchObject({ code: "worker_stopped" });
      expect(await readFile(events, "utf8")).toBe(replacementEvents);
      expect(
        await client.countTokens({
          ...input,
          expectedGeneration: replacement.generation,
          items: [{ id: "source", text: "source" }],
        }),
      ).toMatchObject({
        generation: replacement.generation,
        items: [{ id: "source", tokenCount: 3 }],
      });
    });

    it("never attributes a replacement helper's unresolved stop to an older generation", async () => {
      const { client, digest, events } = await fixture();
      const first = await client.status();
      if (first.state !== "ready") throw new Error("Expected first helper");
      const firstWork = client
        .embed({
          requestId: "first",
          expectedManifestDigest: digest,
          expectedGeneration: first.generation,
          items: [{ id: "source", text: "source" }],
        })
        .catch((error: unknown) => error);
      await client.cancel("first");
      expect(await firstWork).toMatchObject({ code: "cancelled" });
      const ready = await client.status();
      if (ready.state !== "ready")
        throw new Error("Expected replacement helper");
      const input = {
        requestId: "hold",
        expectedManifestDigest: digest,
        expectedGeneration: ready.generation,
        items: [{ id: "hold", text: "hold" }],
      };
      const active = client.embed(input).catch((error: unknown) => error);
      await waitForPhase(events, "embedding");
      const originalKill = ChildProcess.prototype.kill;
      const held: { child: ChildProcess | null } = { child: null };
      ChildProcess.prototype.kill = function (signal) {
        if (this.pid !== ready.process.pid)
          return originalKill.call(this, signal);
        held.child = this;
        return false;
      };
      try {
        await expect(client.cancel(input.requestId)).rejects.toMatchObject({
          code: "stop_unresolved",
        });
        expect(await active).toMatchObject({ code: "stop_unresolved" });
        expect(processIsAbsent(ready.process.pid)).toBe(false);
        const before = await readFile(events, "utf8");
        for (const operation of ["countTokens", "embed"] as const) {
          await expect(
            client[operation]({
              ...input,
              requestId: operation,
              expectedGeneration: first.generation,
            }),
          ).rejects.toMatchObject({ code: "worker_stopped" });
          await expect(
            client[operation]({ ...input, requestId: operation }),
          ).rejects.toMatchObject({ code: "stop_unresolved" });
        }
        expect(await client.status()).toMatchObject({
          state: "unavailable",
          error: { code: "stop_unresolved" },
        });
        expect(await readFile(events, "utf8")).toBe(before);
      } finally {
        ChildProcess.prototype.kill = originalKill;
        if (held.child) {
          const exited = once(held.child, "exit");
          held.child.kill("SIGKILL");
          await exited;
        }
      }
    });

    it("binds ready and ordered results to the exact child, manifest and generation", async () => {
      const { client, digest } = await fixture();
      const ready = await client.status();
      expect(ready.state).toBe("ready");
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      expect(ready.process).toMatchObject({
        execPath: process.execPath,
        remoteModels: false,
        caches: false,
        cpuThreads: 2,
      });
      expect(ready.process.pid).not.toBe(process.pid);
      expect(ready.descriptor.manifestDigest).toBe(digest);
      const result = await client.embed({
        requestId: "batch",
        expectedManifestDigest: digest,
        expectedGeneration: ready.generation,
        items: [
          { id: "unicode", text: "Δ source" },
          { id: "code", text: "export const value = 1;" },
        ],
      });
      expect(result).toMatchObject({
        requestId: "batch",
        generation: ready.generation,
        manifestDigest: digest,
        items: [
          { id: "unicode", tokenCount: 4 },
          { id: "code", tokenCount: 7 },
        ],
      });
      expect(
        result.items.every(
          (item) =>
            item.vector.length === 384 &&
            Math.abs(Math.hypot(...item.vector) - 1) < 0.0001,
        ),
      ).toBe(true);
      await client.dispose();
      expect(processIsAbsent(ready.process.pid)).toBe(true);
      expect(await client.status()).toMatchObject({
        state: "unavailable",
        error: { code: "disposed" },
      });
    });

    it("cancels a queued request without stopping the active child and enforces queue bounds", async () => {
      const { client, digest, events } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      const active = client
        .embed({
          requestId: "active",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "hold", text: "hold" }],
        })
        .catch((error: unknown) => error);
      await waitForPhase(events, "embedding");
      const queued = Array.from({ length: 4 }, (_, index) =>
        client
          .embed({
            requestId: `queued-${index}`,
            expectedManifestDigest: digest,
            expectedGeneration: ready.generation,
            items: [{ id: "code", text: "text" }],
          })
          .catch((error: unknown) => error),
      );
      await expect(
        client.embed({
          requestId: "overflow",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "text" }],
        }),
      ).rejects.toMatchObject({ code: "queue_full" });
      expect(await client.cancel("queued-1")).toEqual({ state: "cancelled" });
      expect(await queued[1]).toMatchObject({ code: "cancelled" });
      expect(processIsAbsent(ready.process.pid)).toBe(false);
      expect(await client.cancel("active")).toEqual({ state: "cancelled" });
      expect(await active).toMatchObject({ code: "cancelled" });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
      for (const index of [0, 2, 3])
        expect(await queued[index]).toMatchObject({ code: "worker_stopped" });
    });

    it("stops only its active child, rejects late success and gives explicit new work a new generation", async () => {
      const { client, digest, events } = await fixture();
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      const unrelatedExit = once(unrelated, "exit");
      try {
        const ready = await client.status();
        if (ready.state !== "ready" || !unrelated.pid)
          throw new Error("Expected owned processes");
        const pending = client
          .embed({
            requestId: "cancel-me",
            expectedManifestDigest: digest,
            expectedGeneration: ready.generation,
            items: [{ id: "hold", text: "hold" }],
          })
          .catch((error: unknown) => error);
        await waitForPhase(events, "embedding");
        await client.cancel("cancel-me");
        expect(await pending).toMatchObject({ code: "cancelled" });
        expect(processIsAbsent(ready.process.pid)).toBe(true);
        expect(processIsAbsent(unrelated.pid)).toBe(false);
        const next = await client.status();
        if (next.state !== "ready")
          throw new Error("Expected replacement child");
        expect(next.generation).not.toBe(ready.generation);
        expect(next.process.pid).not.toBe(ready.process.pid);
        expect(
          (
            await client.embed({
              requestId: "new",
              expectedManifestDigest: digest,
              expectedGeneration: next.generation,
              items: [{ id: "code", text: "new text" }],
            })
          ).generation,
        ).toBe(next.generation);
      } finally {
        unrelated.kill("SIGKILL");
        await unrelatedExit;
      }
    });

    it("cancels immediate active work even while its ready promise continuation is pending", async () => {
      const { client, digest } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      const result = client
        .embed({
          requestId: "immediate",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "short text" }],
        })
        .catch((error: unknown) => error);
      await client.cancel("immediate");
      expect(await result).toMatchObject({ code: "cancelled" });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
    });

    it("disposes during actual initialization and observes child exit before returning", async () => {
      const { client, events } = await fixture("initializing");
      const status = client.status();
      const pid = await waitForPhase(events, "initializing");
      await client.dispose();
      expect(processIsAbsent(pid)).toBe(true);
      expect(await status).toMatchObject({
        state: "unavailable",
        error: { code: "disposed" },
      });
      await expect(
        client.embed({
          requestId: "late",
          expectedManifestDigest: "a".repeat(64),
          expectedGeneration: "not-admitted",
          items: [{ id: "code", text: "text" }],
        }),
      ).rejects.toMatchObject({ code: "disposed" });
    });

    it("does not retry queued work after a real unexpected child exit", async () => {
      const { client, digest } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      const active = client
        .embed({
          requestId: "crash",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "crash" }],
        })
        .catch((error: unknown) => error);
      const queued = client
        .embed({
          requestId: "queued",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "text" }],
        })
        .catch((error: unknown) => error);
      expect(await active).toMatchObject({ code: "worker_exit" });
      expect(await queued).toMatchObject({ code: "worker_stopped" });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
    });
  },
);

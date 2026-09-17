import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextFixture, processIsAbsent } from "./test-fixture.js";

const fixtures: Awaited<ReturnType<typeof contextFixture>>[] = [];
const children: ChildProcess[] = [];
async function fixture() {
  const result = await contextFixture();
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  for (const entry of fixtures.splice(0)) await entry.dispose();
});

describe.runIf(process.platform === "win32" && process.arch === "x64")(
  "Context worker verified asset boundary",
  () => {
    it.each(["missing", "corrupt", "undeclared"] as const)(
      "rejects %s assets before importing any runtime code",
      async (failure) => {
        const { client, context, events } = await fixture();
        const asset = join(
          context,
          "models/Xenova/all-MiniLM-L6-v2/config.json",
        );
        if (failure === "missing") await rm(asset);
        else if (failure === "corrupt")
          await writeFile(asset, "tampered model data");
        else
          await writeFile(
            join(context, "node_modules", "unexpected.mjs"),
            "throw new Error('must not execute')",
          );
        expect(await client.status()).toMatchObject({
          state: "unavailable",
          error: { code: "asset_mismatch" },
        });
        await expect(readFile(events)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("rejects an altered tokenizer policy in the manifest before importing native libraries", async () => {
      const { client, context, events, manifest } = await fixture();
      await writeFile(
        join(context, "manifest.json"),
        JSON.stringify({
          ...manifest,
          tokenizer: { policy: "minilm-total-tokens-v1", totalTokens: 512 },
        }),
      );
      expect(await client.status()).toMatchObject({
        state: "unavailable",
        error: { code: "invalid_manifest" },
      });
      await expect(readFile(events)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("checks token counts including special tokens and refuses stale manifest and malformed vectors", async () => {
      const { client, digest } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      await expect(
        client.embed({
          requestId: "stale",
          expectedManifestDigest: "b".repeat(64),
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "text" }],
        }),
      ).rejects.toMatchObject({ code: "manifest_mismatch" });
      await expect(
        client.embed({
          requestId: "over-token",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: Array(255).fill("token").join(" ") }],
        }),
      ).rejects.toMatchObject({ code: "token_limit" });
      expect(
        (
          await client.embed({
            requestId: "exact-token",
            expectedManifestDigest: digest,
            expectedGeneration: ready.generation,
            items: [{ id: "code", text: Array(254).fill("token").join(" ") }],
          })
        ).items[0]!.tokenCount,
      ).toBe(256);
      await expect(
        client.embed({
          requestId: "bad",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "code", text: "bad-vector" }],
        }),
      ).rejects.toMatchObject({ code: "inference_failed" });
      expect(processIsAbsent(ready.process.pid)).toBe(false);
    });

    it("counts over-budget text with the exact loaded tokenizer without running inference", async () => {
      const { client, digest, events } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready fixture");
      const input = {
        requestId: "count",
        expectedManifestDigest: digest,
        expectedGeneration: ready.generation,
        items: [
          { id: "long", text: Array(300).fill("token").join(" ") },
          { id: "unicode", text: "Δ source" },
        ],
      };
      const counts = await client.countTokens(input);
      expect(counts).toMatchObject({
        requestId: "count",
        manifestDigest: digest,
        items: [
          { id: "long", tokenCount: 302 },
          { id: "unicode", tokenCount: 4 },
        ],
      });
      expect(await readFile(events, "utf8")).not.toContain('"embedding"');
      await expect(
        client.embed({ ...input, requestId: "embed-long" }),
      ).rejects.toMatchObject({ code: "token_limit" });
      expect(await readFile(events, "utf8")).not.toContain('"embedding"');
    });

    it("terminates its real IPC child for caller-chosen paths and work before initialization", async () => {
      const { context } = await fixture();
      for (const message of [
        {
          schemaVersion: 3,
          generation: "one",
          requestId: "init",
          type: "initialize",
          modelPath: "outside",
        },
        {
          schemaVersion: 3,
          generation: "two",
          requestId: "wrong-first",
          type: "embed",
          expectedManifestDigest: "a".repeat(64),
          expectedGeneration: "two",
          items: [{ id: "code", text: "text" }],
        },
      ]) {
        const child = spawn(process.execPath, [join(context, "worker.mjs")], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
        });
        children.push(child);
        const exited = once(child, "exit");
        child.send(message);
        const [code] = await exited;
        expect(code).toBe(1);
        expect(child.pid && processIsAbsent(child.pid)).toBe(true);
      }
    });

    it("rejects a different generation after a real successful initialization", async () => {
      const { context, digest, events } = await fixture();
      const child = spawn(process.execPath, [join(context, "worker.mjs")], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
      children.push(child);
      const ready = once(child, "message");
      child.send({
        schemaVersion: 3,
        generation: "first",
        requestId: "init",
        type: "initialize",
      });
      expect((await ready)[0]).toMatchObject({
        type: "ready",
        generation: "first",
      });
      const before = await readFile(events, "utf8");
      for (const type of ["countTokens", "embed"] as const) {
        const rejected = once(child, "message");
        child.send({
          schemaVersion: 3,
          generation: "first",
          requestId: type,
          type,
          expectedManifestDigest: digest,
          expectedGeneration: "stale",
          items: [{ id: "code", text: "text" }],
        });
        expect((await rejected)[0]).toMatchObject({
          type: "error",
          error: { code: "worker_stopped" },
        });
      }
      expect(await readFile(events, "utf8")).toBe(before);
      const exited = once(child, "exit");
      child.send({
        schemaVersion: 3,
        generation: "stale",
        requestId: "embed",
        type: "embed",
        expectedManifestDigest: digest,
        expectedGeneration: "stale",
        items: [{ id: "code", text: "text" }],
      });
      expect((await exited)[0]).toBe(1);
      expect(child.pid && processIsAbsent(child.pid)).toBe(true);
    });
  },
);

it.skipIf(process.platform === "win32" && process.arch === "x64")(
  "reports unsupported targets before attempting to load the Windows assets",
  async () => {
    const { client } = await fixture();
    expect(await client.status()).toMatchObject({
      state: "unavailable",
      error: { code: "unsupported_target" },
    });
  },
);

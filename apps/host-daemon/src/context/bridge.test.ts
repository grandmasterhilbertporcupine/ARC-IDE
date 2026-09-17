import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHostManager } from "../plugin-host-manager.js";
import { ContextEmbeddingBridge } from "./bridge.js";
import { ContextEmbeddingProxy } from "./proxy.js";
import { ContextRuntimeError } from "./contract.js";
import {
  contextFixture,
  processIsAbsent,
  waitForPhase,
} from "./test-fixture.js";
import type {
  ContextBridgeRequest,
  ContextBridgeResult,
} from "./bridge-contract.js";

const fixtures: Awaited<ReturnType<typeof contextFixture>>[] = [];
const managers: PluginHostManager[] = [];
const bridges: ContextEmbeddingBridge[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const bridge of bridges.splice(0)) await bridge.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
async function fixture(mode: "normal" | "initializing" = "normal") {
  const result = await contextFixture(mode);
  fixtures.push(result);
  const bridge = new ContextEmbeddingBridge(async () => result.client);
  bridges.push(bridge);
  return { ...result, bridge };
}

function connected(bridge: ContextEmbeddingBridge, owner = {}) {
  const lifecycle = new AbortController();
  const proxy = new ContextEmbeddingProxy(lifecycle.signal, (value) => {
    if (
      "type" in value &&
      value.type === "context.cancel" &&
      "requestId" in value &&
      typeof value.requestId === "string"
    ) {
      const requestId = value.requestId;
      void bridge.cancel(owner, requestId).then((result) =>
        proxy.receive({
          type: "context.cancelled",
          requestId,
          state: result.state,
          error: null,
        }),
      );
    } else
      bridge.handle(
        owner,
        value,
        (result) => proxy.receive(result),
        () => {},
      );
  });
  return { owner, lifecycle, capability: proxy.capability("call") };
}

describe.runIf(process.platform === "win32" && process.arch === "x64")(
  "Context bridge with real inference child lifecycle",
  () => {
    it("permits an explicit retry after fixed runtime loading failed", async () => {
      const native = await contextFixture();
      fixtures.push(native);
      let attempts = 0;
      const bridge = new ContextEmbeddingBridge(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Packaged runtime was not staged");
        return native.client;
      });
      bridges.push(bridge);
      const { capability } = connected(bridge);
      const options = { signal: new AbortController().signal };
      expect(await capability.status(options)).toMatchObject({
        state: "unavailable",
        error: { code: "runtime_unavailable" },
      });
      expect(await capability.status(options)).toMatchObject({
        state: "ready",
        descriptor: { manifestDigest: native.digest },
      });
      expect(attempts).toBe(2);
    });

    it("refuses new bound work during bridge reset without attributing the unbound stop to its generation", async () => {
      const native = await contextFixture();
      fixtures.push(native);
      const ready = await native.client.status();
      if (ready.state !== "ready") throw new Error("Expected ready helper");
      let releaseStatus!: () => void;
      let statusStarted!: () => void;
      let releaseStop!: () => void;
      let stopStarted!: () => void;
      const statusGate = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      const enteredStatus = new Promise<void>((resolve) => {
        statusStarted = resolve;
      });
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const enteredStop = new Promise<void>((resolve) => {
        stopStarted = resolve;
      });
      const bridge = new ContextEmbeddingBridge(async () => ({
        status: async () => {
          const status = await native.client.status();
          statusStarted();
          await statusGate;
          return status;
        },
        countTokens: (input) => native.client.countTokens(input),
        embed: (input) => native.client.embed(input),
        cancel: (requestId) => native.client.cancel(requestId),
        dispose: async () => {
          stopStarted();
          await stopGate;
          await native.client.dispose();
        },
      }));
      bridges.push(bridge);
      const { capability } = connected(bridge);
      const controller = new AbortController();
      const pending = capability.status({ signal: controller.signal });
      try {
        await enteredStatus;
        controller.abort();
        await enteredStop;
        const options = { signal: new AbortController().signal };
        for (const operation of ["countTokens", "embed"] as const)
          expect(
            await capability[operation](
              {
                requestId: operation,
                expectedManifestDigest: native.digest,
                expectedGeneration: ready.generation,
                items: [{ id: "source", text: "source" }],
              },
              options,
            ),
          ).toMatchObject({
            state: "failed",
            error: { code: "worker_stopped" },
          });
        expect(await capability.status(options)).toMatchObject({
          state: "unavailable",
          error: { code: "stop_unresolved" },
        });
        expect(await readFile(native.events, "utf8")).not.toContain(
          '"counting"',
        );
      } finally {
        releaseStop();
        releaseStatus();
        expect(await pending).toMatchObject({
          state: "unavailable",
          error: { code: "cancelled" },
        });
      }
      expect(processIsAbsent(ready.process.pid)).toBe(true);
    });

    it("preserves an unresolved request failure when a later cancellation reports absent", async () => {
      const native = await contextFixture();
      fixtures.push(native);
      const ready = await native.client.status();
      if (ready.state !== "ready") throw new Error("Expected ready helper");
      let rejectCount!: (error: ContextRuntimeError) => void;
      let countStarted!: () => void;
      let cancelFinished!: () => void;
      const started = new Promise<void>((resolve) => {
        countStarted = resolve;
      });
      const cancelled = new Promise<void>((resolve) => {
        cancelFinished = resolve;
      });
      const bridge = new ContextEmbeddingBridge(async () => ({
        status: () => native.client.status(),
        countTokens: () => {
          countStarted();
          return new Promise((_resolve, reject) => {
            rejectCount = reject;
          });
        },
        embed: (input) => native.client.embed(input),
        cancel: async (requestId) => {
          const result = await native.client.cancel(requestId);
          expect(result.state).toBe("absent");
          cancelFinished();
          return result;
        },
        dispose: () => native.client.dispose(),
      }));
      bridges.push(bridge);
      const { capability } = connected(bridge);
      const controller = new AbortController();
      const pending = capability.countTokens(
        {
          requestId: "failed",
          expectedManifestDigest: native.digest,
          expectedGeneration: ready.generation,
          items: [{ id: "source", text: "source" }],
        },
        { signal: controller.signal },
      );
      await started;
      controller.abort();
      await cancelled;
      rejectCount(
        new ContextRuntimeError(
          "stop_unresolved",
          "The original request stop is unconfirmed",
        ),
      );
      expect(await pending).toMatchObject({
        state: "failed",
        error: {
          code: "stop_unresolved",
          message: "The original request stop is unconfirmed",
        },
      });
    });

    it("keeps count/embed identity while stripping private process diagnostics", async () => {
      const { bridge, digest } = await fixture();
      const { capability } = connected(bridge);
      const signal = new AbortController().signal;
      const status = await capability.status({ signal });
      expect(status).toMatchObject({
        state: "ready",
        descriptor: { manifestDigest: digest },
      });
      expect(status).not.toHaveProperty("process");
      if (status.state !== "ready") throw new Error("Expected ready helper");
      const input = {
        requestId: "public-id",
        expectedManifestDigest: digest,
        expectedGeneration: status.generation,
        items: [{ id: "code", text: "const answer = 42;" }],
      };
      expect(await capability.countTokens(input, { signal })).toMatchObject({
        state: "completed",
        requestId: "public-id",
        manifestDigest: digest,
        items: [{ id: "code", tokenCount: 6 }],
      });
      expect(await capability.embed(input, { signal })).toMatchObject({
        state: "completed",
        requestId: "public-id",
        items: [{ id: "code", tokenCount: 6 }],
      });
    });

    it("cannot cancel another owner by guessing its bridge request ID", async () => {
      const { bridge, digest, client, events } = await fixture();
      const ready = await client.status();
      if (ready.state !== "ready")
        throw new Error("Expected native fixture ready");
      const owner = {};
      const wrongOwner = {};
      let completed!: (result: ContextBridgeResult) => void;
      const result = new Promise<ContextBridgeResult>((resolve) => {
        completed = resolve;
      });
      const request: ContextBridgeRequest = {
        type: "context.request",
        callId: "call",
        requestId: "same-id",
        operation: "embed",
        input: {
          requestId: "input",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "hold", text: "hold" }],
        },
      };
      bridge.handle(owner, request, completed, () => {});
      await waitForPhase(events, "embedding");
      await bridge.cancel(wrongOwner, "same-id");
      expect(bridge.has(owner)).toBe(true);
      expect(processIsAbsent(ready.process.pid)).toBe(false);
      await bridge.retire(owner);
      expect((await result).output).toMatchObject({
        state: "failed",
        error: { code: "cancelled" },
      });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
      let refused: ContextBridgeResult | null = null;
      bridge.handle(
        owner,
        { ...request, requestId: "late" },
        (value) => {
          refused = value;
        },
        () => {},
      );
      expect(refused).toMatchObject({
        output: { state: "failed", error: { code: "disposed" } },
      });
    });

    it("waits for child exit when the request signal aborts during active native work", async () => {
      const { bridge, digest, events, client } = await fixture();
      const { capability } = connected(bridge);
      const ready = await client.status();
      if (ready.state !== "ready")
        throw new Error("Expected native fixture ready");
      const controller = new AbortController();
      const result = capability.embed(
        {
          requestId: "active",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "hold", text: "hold" }],
        },
        { signal: controller.signal },
      );
      await waitForPhase(events, "embedding");
      controller.abort();
      expect(await result).toMatchObject({
        state: "failed",
        error: { code: "cancelled" },
      });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
    });

    it("aborts initialization through lifecycle disposal before returning unavailable", async () => {
      const { bridge, events } = await fixture("initializing");
      const { capability, lifecycle } = connected(bridge);
      const result = capability.status({
        signal: new AbortController().signal,
      });
      const pid = await waitForPhase(events, "initializing");
      lifecycle.abort();
      expect(await result).toMatchObject({
        state: "unavailable",
        error: { code: "cancelled" },
      });
      expect(processIsAbsent(pid)).toBe(true);
    });

    it("refuses token-count admission before explicit status without starting a child", async () => {
      const { bridge, digest, events } = await fixture();
      const { capability } = connected(bridge);
      expect(
        await capability.countTokens(
          {
            requestId: "count",
            expectedManifestDigest: digest,
            expectedGeneration: "never-initialized",
            items: [{ id: "source", text: "source" }],
          },
          { signal: new AbortController().signal },
        ),
      ).toMatchObject({
        state: "failed",
        error: { code: "worker_stopped" },
      });
      await expect(readFile(events)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("cancels a real token-count request only after observing its exact helper exit", async () => {
      const { bridge, digest, events, client } = await fixture();
      const { capability } = connected(bridge);
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready helper");
      const controller = new AbortController();
      const result = capability.countTokens(
        {
          requestId: "count",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "source", text: "hold-count" }],
        },
        { signal: controller.signal },
      );
      const pid = await waitForPhase(events, "counting");
      expect(pid).toBe(ready.process.pid);
      controller.abort();
      expect(await result).toMatchObject({
        state: "failed",
        error: { code: "cancelled" },
      });
      expect(processIsAbsent(pid)).toBe(true);
    });

    it("connects the real plugin-host capability and preserves the plugin PID after Context cancellation", async () => {
      const { bridge, root, digest, events, client } = await fixture();
      const source = Buffer.from(`
const schema = { "~standard": { validate(value) { return { value }; } } };
export default { experimental_apiVersion: 1, contract: { context: { input: schema, output: schema }, identity: { input: schema, output: schema } }, handlers: {
  identity() { return { pid: process.pid }; },
  async context(input, context) { return await context.experimental_contextEmbeddings[input.operation](input.operation === "status" ? { signal: context.signal } : input.value, ...(input.operation === "status" ? [] : [{ signal: context.signal }])); }
} };
`);
      const manager = new PluginHostManager({
        dataDir: join(root, "daemon"),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        fetchArtifact: async () => source,
        contextEmbeddings: bridge,
      });
      managers.push(manager);
      const base = {
        type: "plugin.host.call" as const,
        pluginId: "arc-context-fixture",
        generation: "published-one",
        artifact: {
          digest: createHash("sha256").update(source).digest("hex"),
          byteLength: source.byteLength,
        },
        timeoutMs: 15_000,
      };
      const before = await manager.call({
        ...base,
        callId: randomUUID(),
        method: "identity",
        input: {},
      });
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready helper");
      const count = await manager.call({
        ...base,
        callId: randomUUID(),
        method: "context",
        input: {
          operation: "countTokens",
          value: {
            requestId: "count",
            expectedManifestDigest: digest,
            expectedGeneration: ready.generation,
            items: [{ id: "source", text: "actual bridge" }],
          },
        },
      });
      expect(count.output).toMatchObject({
        state: "completed",
        items: [{ id: "source", tokenCount: 4 }],
      });
      const callId = randomUUID();
      const active = manager
        .call({
          ...base,
          callId,
          method: "context",
          input: {
            operation: "embed",
            value: {
              requestId: "active",
              expectedManifestDigest: digest,
              expectedGeneration: ready.generation,
              items: [{ id: "hold", text: "hold" }],
            },
          },
        })
        .catch((error: unknown) => error);
      await waitForPhase(events, "embedding");
      manager.cancel({
        type: "plugin.host.cancel",
        pluginId: base.pluginId,
        generation: base.generation,
        callId,
      });
      expect(await active).toMatchObject({ name: "AbortError" });
      expect(processIsAbsent(ready.process.pid)).toBe(true);
      expect(
        (
          await manager.call({
            ...base,
            callId: randomUUID(),
            method: "identity",
            input: {},
          })
        ).output,
      ).toEqual(before.output);
    });

    it("cleans up retained background Context work after a real plugin crash and admits a fresh generation", async () => {
      const { bridge, root, digest, events, client } = await fixture();
      const source = Buffer.from(`
const schema = { "~standard": { validate(value) { return { value }; } } };
export default { experimental_apiVersion: 1, contract: { background: { input: schema, output: schema }, count: { input: schema, output: schema }, crash: { input: schema, output: schema } }, handlers: {
  background(input, context) {
    const lease = context.experimental_retainWorker();
    void context.experimental_contextEmbeddings.embed(input, { signal: context.lifecycle.signal }).finally(() => lease.dispose());
    return { pid: process.pid };
  },
  count(input, context) { return context.experimental_contextEmbeddings.countTokens(input, { signal: context.signal }); },
  crash() { process.exit(17); }
} };
`);
      const manager = new PluginHostManager({
        dataDir: join(root, "daemon"),
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        fetchArtifact: async () => source,
        contextEmbeddings: bridge,
      });
      managers.push(manager);
      const base = {
        type: "plugin.host.call" as const,
        pluginId: "arc-context-background",
        generation: "old-generation",
        artifact: {
          digest: createHash("sha256").update(source).digest("hex"),
          byteLength: source.byteLength,
        },
        timeoutMs: 15_000,
      };
      const ready = await client.status();
      if (ready.state !== "ready") throw new Error("Expected ready helper");
      const background = await manager.call({
        ...base,
        callId: randomUUID(),
        method: "background",
        input: {
          requestId: "background",
          expectedManifestDigest: digest,
          expectedGeneration: ready.generation,
          items: [{ id: "hold", text: "hold" }],
        },
      });
      expect(background.output).toHaveProperty("pid");
      await waitForPhase(events, "embedding");
      expect(processIsAbsent(ready.process.pid)).toBe(false);
      await expect(
        manager.call({
          ...base,
          callId: randomUUID(),
          method: "crash",
          input: {},
        }),
      ).rejects.toThrow("exited (17)");
      await expect
        .poll(() => processIsAbsent(ready.process.pid), { timeout: 5_000 })
        .toBe(true);
      await expect
        .poll(() => client.status(), { timeout: 5_000 })
        .toMatchObject({ state: "ready" });
      const replacement = await client.status();
      if (replacement.state !== "ready")
        throw new Error("Expected replacement helper");
      const resumed = await manager.call({
        ...base,
        generation: "new-generation",
        callId: randomUUID(),
        method: "count",
        input: {
          requestId: "fresh",
          expectedManifestDigest: digest,
          expectedGeneration: replacement.generation,
          items: [{ id: "source", text: "fresh source" }],
        },
      });
      expect(resumed.output).toMatchObject({
        state: "completed",
        requestId: "fresh",
        items: [{ id: "source", tokenCount: 4 }],
      });
      expect(replacement.process.pid).not.toBe(ready.process.pid);
      expect(replacement.generation).not.toBe(ready.generation);
    });
  },
);

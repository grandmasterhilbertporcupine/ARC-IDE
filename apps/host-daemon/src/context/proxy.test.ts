import { describe, expect, it } from "vitest";
import { ContextEmbeddingProxy } from "./proxy.js";
import {
  contextBridgeRequestSchema,
  contextBridgeCancelSchema,
} from "./bridge-contract.js";

const input = {
  requestId: "public",
  expectedManifestDigest: "a".repeat(64),
  expectedGeneration: "generation",
  items: [{ id: "source", text: "const value = 1" }],
};
const completed = {
  state: "completed",
  generation: "generation",
  requestId: input.requestId,
  manifestDigest: input.expectedManifestDigest,
  items: [{ id: "source", tokenCount: 6 }],
};

function fixture() {
  const frames: object[] = [];
  const lifecycle = new AbortController();
  const proxy = new ContextEmbeddingProxy(lifecycle.signal, (frame) =>
    frames.push(frame),
  );
  return { frames, lifecycle, proxy, capability: proxy.capability("call") };
}

describe("Context proxy acknowledgement boundaries", () => {
  it.each([
    "request",
    "manifest",
    "generation",
    "order",
    "operation",
    "schema",
  ])(
    "waits for authoritative absence after an invalid %s reply",
    async (mismatch) => {
      const { proxy, capability, frames } = fixture();
      const result = capability.countTokens(input, {
        signal: new AbortController().signal,
      });
      const request = contextBridgeRequestSchema.parse(frames[0]);
      const output = {
        ...completed,
        ...(mismatch === "request"
          ? { requestId: "other" }
          : mismatch === "manifest"
            ? { manifestDigest: "b".repeat(64) }
            : mismatch === "generation"
              ? { generation: "other" }
              : mismatch === "order"
                ? { items: [{ id: "other", tokenCount: 6 }] }
                : mismatch === "schema"
                  ? { items: [] }
                  : {}),
      };
      proxy.receive({
        type: "context.result",
        requestId: request.requestId,
        operation: mismatch === "operation" ? "embed" : "countTokens",
        output,
      });
      expect(contextBridgeCancelSchema.parse(frames[1]).requestId).toBe(
        request.requestId,
      );
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      proxy.receive({
        type: "context.cancelled",
        requestId: request.requestId,
        state: "absent",
        error: null,
      });
      expect(await result).toMatchObject({
        state: "failed",
        error: { code: "protocol_error" },
      });
    },
  );

  it("ignores late completion after abort until exact cancellation acknowledgement", async () => {
    const { proxy, capability, frames } = fixture();
    const controller = new AbortController();
    const result = capability.countTokens(input, { signal: controller.signal });
    const request = contextBridgeRequestSchema.parse(frames[0]);
    controller.abort();
    proxy.receive({
      type: "context.result",
      requestId: request.requestId,
      operation: "countTokens",
      output: completed,
    });
    proxy.receive({
      type: "context.cancelled",
      requestId: "foreign",
      state: "absent",
      error: null,
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    proxy.receive({
      type: "context.cancelled",
      requestId: request.requestId,
      state: "cancelled",
      error: null,
    });
    expect(await result).toMatchObject({
      state: "failed",
      error: { code: "cancelled" },
    });
  });

  it("preserves unresolved stop evidence instead of claiming cancellation", async () => {
    const { proxy, capability, frames, lifecycle } = fixture();
    const result = capability.status({ signal: new AbortController().signal });
    const request = contextBridgeRequestSchema.parse(frames[0]);
    lifecycle.abort();
    proxy.receive({
      type: "context.cancelled",
      requestId: request.requestId,
      state: "cancelled",
      error: { code: "stop_unresolved", message: "The child is still live" },
    });
    expect(await result).toMatchObject({
      state: "unavailable",
      error: { code: "stop_unresolved" },
    });
  });

  it("reports missing cancellation acknowledgement without claiming child exit", async () => {
    const { capability } = fixture();
    const controller = new AbortController();
    const result = capability.countTokens(input, { signal: controller.signal });
    controller.abort();
    expect(await result).toMatchObject({
      state: "failed",
      error: { code: "stop_unresolved" },
    });
  }, 20_000);

  it("rejects invalid identity and oversized input before sending a frame", async () => {
    const { proxy, capability, frames } = fixture();
    const signal = new AbortController().signal;
    expect(
      await proxy.capability("x".repeat(129)).status({ signal }),
    ).toMatchObject({
      state: "unavailable",
      error: { code: "invalid_request" },
    });
    expect(
      await capability.countTokens(
        { ...input, items: [{ id: "source", text: "💠".repeat(8193) }] },
        { signal },
      ),
    ).toMatchObject({ state: "failed", error: { code: "invalid_request" } });
    expect(frames).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  experimental_defineHostEntry,
  experimental_contextEmbeddingInputSchema,
  experimental_contextTokenCountResultSchema,
  type ExperimentalHostContextEmbeddings,
  type ExperimentalContextTokenCountResult,
} from "../../index.js";
import { experimental_createHostEntryHarness } from "../host.js";

const input = {
  requestId: "count",
  expectedManifestDigest: "a".repeat(64),
  expectedGeneration: "generation",
  items: [{ id: "source", text: "source material" }],
};
const completed: ExperimentalContextTokenCountResult = {
  state: "completed",
  requestId: input.requestId,
  generation: "generation",
  manifestDigest: input.expectedManifestDigest,
  items: [{ id: "source", tokenCount: 300 }],
};

function fixture(runtime?: ExperimentalHostContextEmbeddings) {
  let retained: ExperimentalHostContextEmbeddings | null = null;
  const entry = experimental_defineHostEntry({
    contract: defineRpcContract({
      count: {
        input: experimental_contextEmbeddingInputSchema,
        output: experimental_contextTokenCountResultSchema,
      },
      retain: { input: z.strictObject({}), output: z.boolean() },
    }),
    handlers: {
      count(value, context) {
        return context.experimental_contextEmbeddings.countTokens(value, {
          signal: context.signal,
        });
      },
      retain(_value, context) {
        retained = context.experimental_contextEmbeddings;
        return true;
      },
    },
  });
  return {
    harness: experimental_createHostEntryHarness(entry, {
      experimental_contextEmbeddings: runtime,
    }),
    retained: () => {
      if (!retained) throw new Error("Expected captured capability");
      return retained;
    },
  };
}

function runtime(
  countTokens: ExperimentalHostContextEmbeddings["countTokens"],
): ExperimentalHostContextEmbeddings {
  return {
    status: async () => ({
      state: "unavailable",
      error: { code: "runtime_unavailable", message: "Explicit test fixture" },
    }),
    embed: async () => ({
      state: "failed",
      error: { code: "runtime_unavailable", message: "Explicit test fixture" },
    }),
    countTokens,
  };
}

describe("Context SDK host harness", () => {
  it("reports unavailable without inventing embeddings or counts", async () => {
    const { harness } = fixture();
    expect(await harness.experimental_call("count", input)).toMatchObject({
      state: "failed",
      error: { code: "runtime_unavailable" },
    });
    await harness.experimental_dispose();
  });

  it("keeps full counts above the embedding budget and validates exact ordered identity", async () => {
    const good = fixture(runtime(async () => completed));
    expect(await good.harness.experimental_call("count", input)).toEqual(
      completed,
    );
    await good.harness.experimental_dispose();
    const wrong = fixture(
      runtime(async () => ({
        ...completed,
        state: "completed",
        items: [{ id: "other", tokenCount: 300 }],
      })),
    );
    expect(await wrong.harness.experimental_call("count", input)).toMatchObject(
      { state: "failed", error: { code: "protocol_error" } },
    );
    await wrong.harness.experimental_dispose();
  });

  it("rejects an otherwise valid result from a different helper generation", async () => {
    const { harness } = fixture(
      runtime(async () => ({ ...completed, generation: "other" })),
    );
    expect(await harness.experimental_call("count", input)).toMatchObject({
      state: "failed",
      error: { code: "protocol_error" },
    });
    await harness.experimental_dispose();
  });

  it("retains the capability after its initiating call and waits for an aborted operation to settle", async () => {
    let release: (result: ExperimentalContextTokenCountResult) => void = () => {
      throw new Error("Count operation has not started");
    };
    let observedSignal: AbortSignal | null = null;
    const { harness, retained } = fixture(
      runtime((_value, { signal }) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      }),
    );
    await harness.experimental_call("retain", {});
    const controller = new AbortController();
    const pending = retained().countTokens(input, {
      signal: controller.signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await harness.experimental_dispose();
    expect(observedSignal).toMatchObject({ aborted: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(completed);
    expect(await pending).toMatchObject({
      state: "failed",
      error: { code: "cancelled" },
    });
    expect(
      await retained().countTokens(input, { signal: controller.signal }),
    ).toMatchObject({ state: "failed", error: { code: "cancelled" } });
  });

  it("preserves unresolved cancellation evidence from the supplied runtime", async () => {
    const controller = new AbortController();
    const { harness, retained } = fixture(
      runtime(async () => {
        controller.abort();
        return {
          state: "failed",
          error: {
            code: "stop_unresolved",
            message: "Child exit was not observed",
          },
        };
      }),
    );
    await harness.experimental_call("retain", {});
    expect(
      await retained().countTokens(input, { signal: controller.signal }),
    ).toMatchObject({ state: "failed", error: { code: "stop_unresolved" } });
    await harness.experimental_dispose();
  });
});

import { describe, expect, it } from "vitest";
import {
  contextEmbeddingInputSchema,
  contextTokenCountResultSchema,
  contextEmbeddingResultSchema,
  contextEmbeddingStatusSchema,
} from "../src/context-embeddings.js";

describe("fixed Context capability wire", () => {
  it("allows a full token count to exceed the embedding limit without accepting over-budget vectors", () => {
    const result = {
      state: "completed",
      requestId: "request",
      generation: "generation",
      manifestDigest: "a".repeat(64),
      items: [{ id: "source", tokenCount: 300 }],
    };
    expect(contextTokenCountResultSchema.safeParse(result).success).toBe(true);
    expect(
      contextEmbeddingResultSchema.safeParse({
        ...result,
        items: [
          { ...result.items[0], vector: [1, ...Array<number>(383).fill(0)] },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects caller model selection, duplicate identities and actual UTF-8 overflow", () => {
    const input = {
      requestId: "request",
      expectedManifestDigest: "a".repeat(64),
      expectedGeneration: "generation",
      items: [{ id: "source", text: "source" }],
    };
    expect(contextEmbeddingInputSchema.safeParse(input).success).toBe(true);
    expect(
      contextEmbeddingInputSchema.safeParse({
        ...input,
        expectedGeneration: undefined,
      }).success,
    ).toBe(false);
    expect(
      contextEmbeddingInputSchema.safeParse({
        ...input,
        modelPath: "elsewhere",
      }).success,
    ).toBe(false);
    expect(
      contextEmbeddingInputSchema.safeParse({
        ...input,
        items: [...input.items, ...input.items],
      }).success,
    ).toBe(false);
    expect(
      contextEmbeddingInputSchema.safeParse({
        ...input,
        items: [{ id: "source", text: "𐀀".repeat(8193) }],
      }).success,
    ).toBe(false);
  });

  it("keeps public failures bounded and refuses private diagnostics on the wire", () => {
    const status = {
      state: "unavailable",
      error: {
        code: "runtime_unavailable",
        message: "The packaged runtime is unavailable",
      },
    };
    expect(contextEmbeddingStatusSchema.safeParse(status).success).toBe(true);
    expect(
      contextEmbeddingStatusSchema.safeParse({
        ...status,
        process: { pid: 10, execPath: "private" },
      }).success,
    ).toBe(false);
    expect(
      contextEmbeddingStatusSchema.safeParse({
        ...status,
        error: { code: "invented", message: "error" },
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  boundedContextMessage,
  CONTEXT_LIMITS,
  contextEmbedInputSchema,
  contextEmbeddingSchema,
  contextRequestSchema,
  contextResponseSchema,
} from "./contract.js";

const input = {
  requestId: "one",
  expectedManifestDigest: "a".repeat(64),
  expectedGeneration: "generation",
  items: [{ id: "code", text: "const answer = 42;" }],
};

describe("Context private boundaries", () => {
  it("requires the exact-generation private protocol and admission binding", () => {
    const request = {
      ...input,
      type: "countTokens",
      generation: "generation",
      schemaVersion: 3,
    };
    expect(contextRequestSchema.safeParse(request).success).toBe(true);
    expect(
      contextRequestSchema.safeParse({ ...request, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      contextRequestSchema.safeParse({
        ...request,
        expectedGeneration: undefined,
      }).success,
    ).toBe(false);
  });

  it("rejects caller-selected modules, missing bindings and duplicate items", () => {
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        modulePath: "arbitrary.mjs",
      }).success,
    ).toBe(false);
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        expectedManifestDigest: "",
      }).success,
    ).toBe(false);
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        items: [...input.items, ...input.items],
      }).success,
    ).toBe(false);
    expect(
      contextRequestSchema.safeParse({ type: "embed", ...input }).success,
    ).toBe(false);
  });

  it("bounds actual UTF-8 item and batch bytes rather than character estimates", () => {
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        items: [{ id: "unicode", text: "😀".repeat(9000) }],
      }).success,
    ).toBe(false);
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 3 }, (_, index) => ({
          id: String(index),
          text: "a".repeat(25_000),
        })),
      }).success,
    ).toBe(false);
    expect(
      contextEmbedInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 9 }, (_, index) => ({
          id: String(index),
          text: "a",
        })),
      }).success,
    ).toBe(false);
    expect(
      boundedContextMessage({ text: "x".repeat(CONTEXT_LIMITS.messageBytes) }),
    ).toBe(false);
  });

  it("rejects malformed, nonfinite and nonnormalized embedding vectors", () => {
    for (const vector of [
      Array(383).fill(0),
      Array(384).fill(0),
      Array(384).fill(Infinity),
      Array(384).fill(NaN),
    ])
      expect(
        contextEmbeddingSchema.safeParse({ id: "code", tokenCount: 12, vector })
          .success,
      ).toBe(false);
    expect(
      contextEmbeddingSchema.safeParse({
        id: "code",
        tokenCount: 257,
        vector: [1, ...Array(383).fill(0)],
      }).success,
    ).toBe(false);
    expect(
      contextResponseSchema.safeParse({
        schemaVersion: 3,
        generation: "g",
        requestId: "r",
        type: "embedded",
        manifestDigest: "a".repeat(64),
        items: [],
      }).success,
    ).toBe(false);
  });
});

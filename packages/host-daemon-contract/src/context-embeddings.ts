import { z } from "zod";

export const contextEmbeddingLimits = {
  batchItems: 8,
  itemBytes: 32_768,
  batchBytes: 65_536,
  queuedRequests: 4,
  messageBytes: 262_144,
  tokens: 256,
  dimensions: 384,
} as const;
export const contextEmbeddingIdSchema = z.string().min(1).max(128);
export const contextEmbeddingDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = (text: string) => new TextEncoder().encode(text).length;

export const contextEmbeddingErrorCodeSchema = z.enum([
  "unsupported_target",
  "invalid_manifest",
  "asset_mismatch",
  "runtime_unavailable",
  "host_upgrade_required",
  "invalid_request",
  "manifest_mismatch",
  "token_limit",
  "queue_full",
  "cancelled",
  "worker_stopped",
  "worker_exit",
  "worker_timeout",
  "stop_unresolved",
  "disposed",
  "protocol_error",
  "inference_failed",
]);
export const contextEmbeddingFailureSchema = z.strictObject({
  code: contextEmbeddingErrorCodeSchema,
  message: z.string().min(1).max(2048),
});
export type ContextEmbeddingFailure = z.infer<
  typeof contextEmbeddingFailureSchema
>;

export const contextEmbeddingDescriptorSchema = z.strictObject({
  manifestDigest: contextEmbeddingDigestSchema,
  model: z.literal("Xenova/all-MiniLM-L6-v2"),
  revision: z.literal("751bff37182d3f1213fa05d7196b954e230abad9"),
  runtime: z.strictObject({
    transformers: z.literal("4.2.0"),
    onnx: z.literal("1.24.3"),
    sharp: z.literal("0.35.4"),
  }),
  target: z.strictObject({
    platform: z.literal("win32"),
    arch: z.literal("x64"),
  }),
  tokenizer: z.strictObject({
    policy: z.literal("minilm-total-tokens-v1"),
    totalTokens: z.literal(256),
  }),
  dimension: z.literal(384),
  dtype: z.literal("q8"),
  pooling: z.literal("mean"),
  normalize: z.literal(true),
});
export type ContextEmbeddingDescriptor = z.infer<
  typeof contextEmbeddingDescriptorSchema
>;
export const contextEmbeddingStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    generation: contextEmbeddingIdSchema,
    descriptor: contextEmbeddingDescriptorSchema,
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    error: contextEmbeddingFailureSchema,
  }),
]);
export type ContextEmbeddingStatus = z.infer<
  typeof contextEmbeddingStatusSchema
>;

export const contextEmbeddingInputSchema = z
  .strictObject({
    requestId: contextEmbeddingIdSchema,
    expectedManifestDigest: contextEmbeddingDigestSchema,
    expectedGeneration: contextEmbeddingIdSchema,
    items: z
      .array(
        z.strictObject({
          id: contextEmbeddingIdSchema,
          text: z
            .string()
            .min(1)
            .max(contextEmbeddingLimits.itemBytes)
            .refine(
              (value) => bytes(value) <= contextEmbeddingLimits.itemBytes,
              "Text exceeds UTF-8 byte limit",
            ),
        }),
      )
      .min(1)
      .max(contextEmbeddingLimits.batchItems),
  })
  .superRefine((input, context) => {
    if (new Set(input.items.map((item) => item.id)).size !== input.items.length)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item IDs must be unique",
      });
    if (
      input.items.reduce((sum, item) => sum + bytes(item.text), 0) >
      contextEmbeddingLimits.batchBytes
    )
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Batch exceeds UTF-8 byte limit",
      });
  });
export type ContextEmbeddingInput = z.infer<typeof contextEmbeddingInputSchema>;
export const contextTokenCountSchema = z.strictObject({
  id: contextEmbeddingIdSchema,
  tokenCount: z
    .number()
    .int()
    .positive()
    .max(contextEmbeddingLimits.itemBytes + 2),
});
export const contextEmbeddingSchema = z.strictObject({
  id: contextEmbeddingIdSchema,
  tokenCount: z.number().int().positive().max(contextEmbeddingLimits.tokens),
  vector: z
    .array(z.number().finite())
    .length(contextEmbeddingLimits.dimensions)
    .refine(
      (values) => Math.abs(Math.hypot(...values) - 1) < 0.0001,
      "Vector must be normalized",
    ),
});
export type ContextEmbedding = z.infer<typeof contextEmbeddingSchema>;
const binding = {
  generation: contextEmbeddingIdSchema,
  requestId: contextEmbeddingIdSchema,
  manifestDigest: contextEmbeddingDigestSchema,
};
export const contextTokenCountOutputSchema = z.strictObject({
  ...binding,
  items: z
    .array(contextTokenCountSchema)
    .min(1)
    .max(contextEmbeddingLimits.batchItems),
});
export const contextEmbeddingOutputSchema = z.strictObject({
  ...binding,
  items: z
    .array(contextEmbeddingSchema)
    .min(1)
    .max(contextEmbeddingLimits.batchItems),
});
export type ContextTokenCountOutput = z.infer<
  typeof contextTokenCountOutputSchema
>;
export type ContextEmbeddingOutput = z.infer<
  typeof contextEmbeddingOutputSchema
>;
const failed = z.strictObject({
  state: z.literal("failed"),
  error: contextEmbeddingFailureSchema,
});
export const contextTokenCountResultSchema = z.discriminatedUnion("state", [
  contextTokenCountOutputSchema.extend({ state: z.literal("completed") }),
  failed,
]);
export const contextEmbeddingResultSchema = z.discriminatedUnion("state", [
  contextEmbeddingOutputSchema.extend({ state: z.literal("completed") }),
  failed,
]);
export type ContextTokenCountResult = z.infer<
  typeof contextTokenCountResultSchema
>;
export type ContextEmbeddingResult = z.infer<
  typeof contextEmbeddingResultSchema
>;

export interface ContextEmbeddingOptions {
  readonly signal: AbortSignal;
}
export interface HostContextEmbeddings {
  status(options: ContextEmbeddingOptions): Promise<ContextEmbeddingStatus>;
  countTokens(
    input: ContextEmbeddingInput,
    options: ContextEmbeddingOptions,
  ): Promise<ContextTokenCountResult>;
  embed(
    input: ContextEmbeddingInput,
    options: ContextEmbeddingOptions,
  ): Promise<ContextEmbeddingResult>;
}

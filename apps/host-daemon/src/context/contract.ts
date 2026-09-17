import { z } from "zod";
import {
  contextEmbeddingLimits,
  contextEmbeddingErrorCodeSchema as contextErrorCodeSchema,
  contextEmbeddingFailureSchema as contextFailureSchema,
  contextEmbeddingDescriptorSchema as contextDescriptorSchema,
  contextEmbeddingInputSchema as contextEmbedInputSchema,
  contextEmbeddingSchema,
  contextTokenCountSchema,
} from "@bb/host-daemon-contract";

export const CONTEXT_LIMITS = {
  ...contextEmbeddingLimits,
  initializeMs: 60_000,
  requestMs: 30_000,
  stopMs: 5_000,
} as const;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(128);
const assetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== ".."),
  );

export const contextManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    target: z.strictObject({
      platform: z.literal("win32"),
      arch: z.literal("x64"),
    }),
    model: z.literal("Xenova/all-MiniLM-L6-v2"),
    revision: z.literal("751bff37182d3f1213fa05d7196b954e230abad9"),
    runtime: z.strictObject({
      transformers: z.literal("4.2.0"),
      onnx: z.literal("1.24.3"),
      sharp: z.literal("0.35.4"),
    }),
    tokenizer: z.strictObject({
      policy: z.literal("minilm-total-tokens-v1"),
      totalTokens: z.literal(256),
    }),
    dimension: z.literal(384),
    dtype: z.literal("q8"),
    pooling: z.literal("mean"),
    normalize: z.literal(true),
    files: z
      .array(
        z.strictObject({
          path: assetPathSchema,
          bytes: z.number().int().positive().max(536_870_912),
          sha256: digestSchema,
        }),
      )
      .min(10)
      .max(10_000),
  })
  .superRefine((manifest, context) => {
    const paths = manifest.files.map((file) => file.path);
    if (paths.some((path, index) => index > 0 && path <= paths[index - 1]!)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Asset paths must be unique and sorted",
      });
    }
    if (
      manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 1_073_741_824
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Asset inventory exceeds one GiB",
      });
    }
    for (const path of paths) {
      if (
        path !== "client.mjs" &&
        path !== "worker.mjs" &&
        !["models/", "node_modules/", "notices/"].some((prefix) =>
          path.startsWith(prefix),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "Unexpected asset location",
        });
      }
    }
    const required = [
      "client.mjs",
      "worker.mjs",
      "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
      "node_modules/@huggingface/transformers/package.json",
      "node_modules/onnxruntime-node/package.json",
      "node_modules/sharp/package.json",
      ...[
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
        "README.md",
        "onnx/model_quantized.onnx",
      ].map((path) => `models/Xenova/all-MiniLM-L6-v2/${path}`),
    ];
    if (
      required.some((path) => !paths.includes(path)) ||
      !paths.some((path) => path.startsWith("notices/"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Required runtime, model or notice asset is missing",
      });
    }
  });

export type ContextManifest = z.infer<typeof contextManifestSchema>;

export {
  contextEmbeddingErrorCodeSchema as contextErrorCodeSchema,
  contextEmbeddingFailureSchema as contextFailureSchema,
  contextEmbeddingDescriptorSchema as contextDescriptorSchema,
  contextEmbeddingInputSchema as contextEmbedInputSchema,
  contextEmbeddingSchema,
} from "@bb/host-daemon-contract";
export type {
  ContextEmbeddingInput as ContextEmbedInput,
  ContextEmbedding,
  ContextEmbeddingDescriptor as ContextDescriptor,
} from "@bb/host-daemon-contract";
export type ContextErrorCode = z.infer<typeof contextErrorCodeSchema>;
export class ContextRuntimeError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextRuntimeError";
  }
}
export const contextProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  execPath: z.string().min(1),
  node: z.string().min(1),
  electron: z.string().nullable(),
  modules: z.string().min(1),
  cpuThreads: z.literal(2),
  remoteModels: z.literal(false),
  caches: z.literal(false),
  fetch: z.literal("rejected"),
});

export const contextStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    generation: idSchema,
    descriptor: contextDescriptorSchema,
    process: contextProcessSchema,
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    error: contextFailureSchema,
  }),
]);
export type ContextStatus = z.infer<typeof contextStatusSchema>;

const envelope = {
  schemaVersion: z.literal(3),
  generation: idSchema,
  requestId: idSchema,
};
export const contextRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("initialize") }),
  z.strictObject({
    ...envelope,
    type: z.literal("embed"),
    expectedManifestDigest: digestSchema,
    expectedGeneration: idSchema,
    items: contextEmbedInputSchema.shape.items,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("countTokens"),
    expectedManifestDigest: digestSchema,
    expectedGeneration: idSchema,
    items: contextEmbedInputSchema.shape.items,
  }),
  z.strictObject({ ...envelope, type: z.literal("dispose") }),
]);
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export const contextResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("ready"),
    descriptor: contextDescriptorSchema,
    process: contextProcessSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("embedded"),
    manifestDigest: digestSchema,
    items: z
      .array(contextEmbeddingSchema)
      .min(1)
      .max(CONTEXT_LIMITS.batchItems),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("counted"),
    manifestDigest: digestSchema,
    items: z
      .array(contextTokenCountSchema)
      .min(1)
      .max(CONTEXT_LIMITS.batchItems),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("error"),
    error: contextFailureSchema,
  }),
  z.strictObject({ ...envelope, type: z.literal("disposed") }),
]);
export type ContextResponse = z.infer<typeof contextResponseSchema>;

export function boundedContextMessage(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized, "utf8") <= CONTEXT_LIMITS.messageBytes
    );
  } catch {
    return false;
  }
}

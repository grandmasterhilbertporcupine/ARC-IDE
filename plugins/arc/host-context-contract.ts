import { z } from "zod";
import { directoryRootSchema } from "./host-directory-contract.js";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative();
export const hostContextLimits = Object.freeze({
  maxFileBytes: 1_048_576,
  maxReferenceBytes: 65_536,
  maxReferenceTotalBytes: 524_288,
  maxReferences: 32,
  maxWatchedIndexes: 4,
  maxDepth: 128,
  maxChunksPerSource: 4096,
  maxExcerptCharacters: 8000,
  maxSearchResults: 20,
  vectorPageSize: 128,
  maxSemanticScanMs: 5000,
});

export const hostContextScopeSchema = z
  .object({
    projectId: id,
    hostId: id,
    environmentId: id.nullable(),
    path: z.string().min(1).max(32_768),
    referenceDigest: digest,
  })
  .strict();
export type HostContextScope = z.infer<typeof hostContextScopeSchema>;
export const hostContextReferenceSchema = z
  .object({
    id,
    name: z.string().min(1).max(240),
    sha256: digest,
    text: z.string().max(hostContextLimits.maxReferenceBytes),
    revision: z.number().int().positive(),
  })
  .strict();
export type HostContextReference = z.infer<typeof hostContextReferenceSchema>;

export const hostContextStatusSchema = z
  .object({
    scope: hostContextScopeSchema,
    indexId: id.nullable(),
    generation: integer,
    operationId: id.nullable(),
    state: z.enum([
      "absent",
      "indexing",
      "ready",
      "stale",
      "cancelled",
      "failed",
    ]),
    coverage: z.enum(["unknown", "partial", "complete"]),
    root: directoryRootSchema.nullable(),
    git: z
      .object({
        topLevel: z.string(),
        gitDir: z.string(),
        commonGitDir: z.string(),
        head: z.string().nullable(),
      })
      .strict()
      .nullable(),
    counts: z
      .object({
        discovered: integer,
        indexed: integer,
        stale: integer,
        skipped: integer,
        failed: integer,
        chunks: integer,
        embeddedChunks: integer,
      })
      .strict(),
    semantic: z.enum(["unavailable", "pending", "partial", "ready"]),
    manifestDigest: digest.nullable(),
    reason: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type HostContextStatus = z.infer<typeof hostContextStatusSchema>;

export const hostContextSourceSchema = z
  .object({
    id,
    name: z.string(),
    kind: z.enum(["file", "reference"]),
    relativePath: z.string().nullable(),
    revision: z.number().int().positive(),
    generation: integer,
    sha256: digest.nullable(),
    state: z.enum([
      "pending",
      "indexed",
      "stale",
      "skipped",
      "failed",
      "deleted",
    ]),
    reason: z.string().nullable(),
    sizeBytes: integer,
    chunks: integer,
    embeddedChunks: integer,
  })
  .strict();
export type HostContextSource = z.infer<typeof hostContextSourceSchema>;

export const hostContextHitSchema = z
  .object({
    indexId: id,
    indexGeneration: integer,
    chunkId: id,
    sourceId: id,
    sourceGeneration: integer,
    sourceRevision: z.number().int().positive(),
    sha256: digest,
    name: z.string(),
    kind: z.enum(["file", "reference"]),
    relativePath: z.string().nullable(),
    authority: z.literal("reference"),
    startOffset: integer,
    endOffset: integer,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    tokenCount: integer.nullable(),
    text: z.string().max(hostContextLimits.maxExcerptCharacters),
    lexicalRank: z.number().int().positive().nullable(),
    semanticRank: z.number().int().positive().nullable(),
    score: z.number().finite(),
  })
  .strict();
export type HostContextHit = z.infer<typeof hostContextHitSchema>;

export const hostContextStartInputSchema = z
  .object({
    scope: hostContextScopeSchema,
    operationId: id,
    references: z
      .array(hostContextReferenceSchema)
      .max(hostContextLimits.maxReferences),
  })
  .strict();
export type HostContextStartInput = z.infer<typeof hostContextStartInputSchema>;
export const hostContextStatusInputSchema = z
  .object({ scope: hostContextScopeSchema })
  .strict();
export const hostContextSourcesInputSchema = z
  .object({
    scope: hostContextScopeSchema,
    cursor: z.string().max(1000).nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export const hostContextSourcesOutputSchema = z
  .object({
    status: hostContextStatusSchema,
    sources: z.array(hostContextSourceSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const hostContextSearchInputSchema = z
  .object({
    scope: hostContextScopeSchema,
    query: z.string().trim().min(1).max(4000),
    limit: z.number().int().min(1).max(hostContextLimits.maxSearchResults),
  })
  .strict();
export const hostContextSearchOutputSchema = z
  .object({
    status: hostContextStatusSchema,
    mode: z.enum(["hybrid", "lexical"]),
    reason: z.string().nullable(),
    semanticTruncated: z.boolean(),
    hits: z.array(hostContextHitSchema),
  })
  .strict();
export const hostContextExcerptInputSchema = z
  .object({
    scope: hostContextScopeSchema,
    indexId: id,
    chunkId: id,
    sourceGeneration: integer,
    sha256: digest,
  })
  .strict();
export const hostContextExcerptOutputSchema = z
  .object({
    status: hostContextStatusSchema,
    state: z.enum(["current", "stale"]),
    hit: hostContextHitSchema.nullable(),
  })
  .strict();
export const hostContextCancelInputSchema = z
  .object({
    scope: hostContextScopeSchema,
    operationId: id,
  })
  .strict();

export const contextHostRpcMethods = {
  startContextIndex: {
    input: hostContextStartInputSchema,
    output: hostContextStatusSchema,
  },
  getContextIndexStatus: {
    input: hostContextStatusInputSchema,
    output: hostContextStatusSchema,
  },
  listContextIndexSources: {
    input: hostContextSourcesInputSchema,
    output: hostContextSourcesOutputSchema,
  },
  searchContextIndex: {
    input: hostContextSearchInputSchema,
    output: hostContextSearchOutputSchema,
  },
  readContextIndexExcerpt: {
    input: hostContextExcerptInputSchema,
    output: hostContextExcerptOutputSchema,
  },
  cancelContextIndex: {
    input: hostContextCancelInputSchema,
    output: hostContextStatusSchema,
  },
};

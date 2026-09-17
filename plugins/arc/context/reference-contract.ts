import { z } from "zod";

export const CONTEXT_REFERENCE_LIMITS = {
  itemBytes: 65_536,
  totalBytes: 524_288,
  count: 32,
} as const;

export const contextReferenceIdSchema = z
  .string()
  .regex(/^context_[a-f0-9-]{36}$/);
export const contextDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const contextReferenceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !/[\\/\u0000-\u001f]/u.test(name) && name !== "." && name !== "..",
    "Use a file name without directory separators",
  );
export const contextReferenceTextSchema = z
  .string()
  .min(1)
  .max(CONTEXT_REFERENCE_LIMITS.itemBytes)
  .refine(
    (text) =>
      !text.includes("\u0000") &&
      new TextEncoder().encode(text).byteLength <=
        CONTEXT_REFERENCE_LIMITS.itemBytes &&
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        new TextEncoder().encode(text),
      ) === text,
    "Reference text must be UTF-8, without null bytes, and at most 64 KiB",
  );
export const contextReferenceSchema = z.strictObject({
  id: contextReferenceIdSchema,
  name: contextReferenceNameSchema,
  sha256: contextDigestSchema,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(CONTEXT_REFERENCE_LIMITS.itemBytes),
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const contextImportSchema = z
  .strictObject({
    projectId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(128),
    sourceId: contextReferenceIdSchema.nullable(),
    expectedRevision: z.number().int().positive().nullable(),
    name: contextReferenceNameSchema,
    text: contextReferenceTextSchema,
  })
  .refine(
    (input) => (input.sourceId === null) === (input.expectedRevision === null),
    "Replacing a reference requires its exact current revision",
  );
export type ContextReference = z.infer<typeof contextReferenceSchema>;
export type ContextImport = z.infer<typeof contextImportSchema>;
export const contextArchiveSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(128),
  sourceId: contextReferenceIdSchema,
  expectedRevision: z.number().int().positive(),
});

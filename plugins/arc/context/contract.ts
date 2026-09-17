import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContextStatusSchema,
  hostContextSourcesInputSchema,
  hostContextSourcesOutputSchema,
  hostContextSearchInputSchema,
  hostContextSearchOutputSchema,
  hostContextExcerptInputSchema,
  hostContextExcerptOutputSchema,
} from "../host-context-contract.js";
import {
  contextReferenceSchema,
  contextReferenceIdSchema,
  contextReferenceNameSchema,
  contextReferenceTextSchema,
  contextArchiveSchema,
} from "./reference-contract.js";

const id = z.string().min(1).max(200);
const operationId = z.string().min(1).max(200);
export const contextTargetSchema = z.strictObject({
  projectId: id,
  hostId: id,
  environmentId: id.nullable(),
});
export type ContextTarget = z.infer<typeof contextTargetSchema>;
export const contextMutationRejectionCodeSchema = z.enum([
  "source_changed",
  "source_missing",
  "reference_limit",
  "operation_conflict",
]);
const contextMutationResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    reference: contextReferenceSchema,
    status: hostContextStatusSchema.nullable(),
    indexError: z.string().nullable(),
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    error: z.strictObject({
      code: contextMutationRejectionCodeSchema,
      message: z.string(),
    }),
  }),
]);
export const arcContextRpcContract = defineRpcContract({
  getContextSetup: {
    input: z.strictObject({ projectId: id, hostId: id.nullable() }),
    output: z.strictObject({
      project: z.strictObject({ id, name: z.string() }),
      sources: z.array(z.strictObject({ hostId: id, path: z.string() })),
      target: contextTargetSchema,
    }),
  },
  getContextStatus: {
    input: z.strictObject({ target: contextTargetSchema }),
    output: hostContextStatusSchema,
  },
  listContextSources: {
    input: hostContextSourcesInputSchema
      .omit({ scope: true })
      .extend({ target: contextTargetSchema }),
    output: hostContextSourcesOutputSchema,
  },
  reindexContext: {
    input: z.strictObject({ target: contextTargetSchema, operationId }),
    output: hostContextStatusSchema,
  },
  cancelContextIndexing: {
    input: z.strictObject({ target: contextTargetSchema, operationId }),
    output: hostContextStatusSchema,
  },
  searchContext: {
    input: hostContextSearchInputSchema
      .omit({ scope: true })
      .extend({ target: contextTargetSchema }),
    output: hostContextSearchOutputSchema,
  },
  readContextExcerpt: {
    input: hostContextExcerptInputSchema
      .omit({ scope: true })
      .extend({ target: contextTargetSchema }),
    output: hostContextExcerptOutputSchema,
  },
  listContextReferences: {
    input: z.strictObject({ projectId: id }),
    output: z.strictObject({ sources: z.array(contextReferenceSchema) }),
  },
  readContextReference: {
    input: z.strictObject({
      projectId: id,
      sourceId: contextReferenceIdSchema,
      revision: z.number().int().positive(),
    }),
    output: z.strictObject({
      source: contextReferenceSchema.omit({
        createdAt: true,
        updatedAt: true,
        sizeBytes: true,
      }),
      text: contextReferenceTextSchema,
    }),
  },
  importContextSource: {
    input: z
      .strictObject({
        target: contextTargetSchema,
        operationId: z.string().min(1).max(128),
        sourceId: contextReferenceIdSchema.nullable(),
        expectedRevision: z.number().int().positive().nullable(),
        name: contextReferenceNameSchema,
        text: contextReferenceTextSchema,
      })
      .refine(
        (input) =>
          (input.sourceId === null) === (input.expectedRevision === null),
        "Replacing a reference requires its exact current revision",
      ),
    output: contextMutationResultSchema,
  },
  archiveContextReference: {
    input: contextArchiveSchema
      .omit({ projectId: true })
      .extend({ target: contextTargetSchema }),
    output: contextMutationResultSchema,
  },
});

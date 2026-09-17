import { z } from "zod";
export const addressedAttachmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("image"),
      url: z
        .string()
        .url()
        .max(8 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("localImage"),
      path: z.string().min(1).max(32768),
    })
    .strict(),
  z
    .object({
      type: z.literal("localFile"),
      path: z.string().min(1).max(32768),
      name: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      mimeType: z.string().optional(),
    })
    .strict(),
]);
import {
  graphRunDefinitionSchema,
  graphRunRequestSchema,
} from "./graph-contract.js";
import {
  resolvedExecutionSchema,
  runtimeIdSchema,
  runtimePathSchema,
} from "./definition.js";

export const orchestratedRunRequestSchema = graphRunRequestSchema.extend({
  addressedAttachments: z.array(addressedAttachmentSchema).max(16).optional(),
  addressedRecipients: z
    .array(
      z
        .object({
          kind: z.enum(["agent", "team"]),
          entityId: runtimeIdSchema,
          versionId: z.number().int().positive(),
          scopeKey: runtimeIdSchema,
        })
        .strict(),
    )
    .min(1)
    .max(20)
    .optional(),
  invocation: z
    .object({
      providerThreadId: runtimeIdSchema,
      turnId: runtimeIdSchema,
      callId: runtimeIdSchema,
    })
    .strict()
    .nullable(),
});
export type OrchestratedRunRequest = z.infer<
  typeof orchestratedRunRequestSchema
>;

export const orchestratorCompletionSchema = z
  .object({
    threadId: runtimeIdSchema,
    environment: z
      .object({
        hostId: runtimeIdSchema,
        environmentId: runtimeIdSchema,
        path: runtimePathSchema,
      })
      .strict(),
    execution: resolvedExecutionSchema,
  })
  .strict();

export const orchestratedRunDefinitionSchema = graphRunDefinitionSchema.extend({
  schemaVersion: z.literal(3),
  request: orchestratedRunRequestSchema,
  completion: orchestratorCompletionSchema,
});
export type OrchestratedRunDefinition = z.infer<
  typeof orchestratedRunDefinitionSchema
>;

export const orchestratorRuntimeNodeSchema = z
  .object({
    kind: z.literal("orchestrator"),
    purpose: z.literal("completion"),
    completion: orchestratorCompletionSchema,
  })
  .strict();
export type OrchestratorRuntimeNode = z.infer<
  typeof orchestratorRuntimeNodeSchema
>;

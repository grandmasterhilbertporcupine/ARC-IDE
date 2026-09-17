import { z } from "zod";
import {
  contextEmbeddingIdSchema,
  contextEmbeddingInputSchema,
  contextEmbeddingStatusSchema,
  contextEmbeddingResultSchema,
  contextTokenCountResultSchema,
  contextEmbeddingFailureSchema,
} from "@bb/host-daemon-contract";

const identity = {
  requestId: contextEmbeddingIdSchema,
  callId: contextEmbeddingIdSchema,
};
export const contextBridgeRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...identity,
    type: z.literal("context.request"),
    operation: z.literal("status"),
    input: z.null(),
  }),
  z.strictObject({
    ...identity,
    type: z.literal("context.request"),
    operation: z.literal("countTokens"),
    input: contextEmbeddingInputSchema,
  }),
  z.strictObject({
    ...identity,
    type: z.literal("context.request"),
    operation: z.literal("embed"),
    input: contextEmbeddingInputSchema,
  }),
]);
export type ContextBridgeRequest = z.infer<typeof contextBridgeRequestSchema>;
export const contextBridgeCancelSchema = z.strictObject({
  type: z.literal("context.cancel"),
  requestId: contextEmbeddingIdSchema,
});
export const contextBridgeCancelledSchema = z.strictObject({
  type: z.literal("context.cancelled"),
  requestId: contextEmbeddingIdSchema,
  state: z.enum(["cancelled", "absent"]),
  error: contextEmbeddingFailureSchema.nullable(),
});
export const contextBridgeResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    type: z.literal("context.result"),
    requestId: contextEmbeddingIdSchema,
    operation: z.literal("status"),
    output: contextEmbeddingStatusSchema,
  }),
  z.strictObject({
    type: z.literal("context.result"),
    requestId: contextEmbeddingIdSchema,
    operation: z.literal("countTokens"),
    output: contextTokenCountResultSchema,
  }),
  z.strictObject({
    type: z.literal("context.result"),
    requestId: contextEmbeddingIdSchema,
    operation: z.literal("embed"),
    output: contextEmbeddingResultSchema,
  }),
]);
export type ContextBridgeResult = z.infer<typeof contextBridgeResultSchema>;

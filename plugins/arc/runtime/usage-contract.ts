import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { runIdSchema, runtimeIdSchema } from "./definition.js";
import {
  readerReportSchema,
  runMessageSchema,
} from "./collaboration-contract.js";

export const collaborationCursorSchema = z
  .object({ createdAt: z.number().int().nonnegative(), id: runtimeIdSchema })
  .strict();
export type CollaborationCursor = z.infer<typeof collaborationCursorSchema>;
const pageInput = z
  .object({
    runId: runIdSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const usageWorkerSchema = z
  .object({
    effectId: runtimeIdSchema,
    threadId: runtimeIdSchema.nullable(),
    name: z.string(),
    role: z.string(),
    purpose: z.string(),
    providerId: z.string(),
    model: z.string(),
    inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(),
    cachedInputTokens: z.number().nonnegative().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type RunUsageWorker = z.infer<typeof usageWorkerSchema>;
export const resultReceiptSchema = z
  .object({
    effectId: runtimeIdSchema,
    nodeId: runtimeIdSchema,
    state: z.string(),
    validity: z.string().nullable(),
    reason: z.string().nullable(),
    changes: z.string().nullable(),
    checks: z
      .array(
        z
          .object({
            command: z.string(),
            exitCode: z.number().int().nullable(),
            interrupted: z.boolean(),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(20),
    checksTruncated: z.boolean(),
    review: z
      .object({
        outcome: z.string(),
        summary: z.string(),
        findings: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    artifact: z
      .object({ path: z.string().nullable(), identity: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type RunResultReceipt = z.infer<typeof resultReceiptSchema>;
export const runDialogueStateSchema = z
  .object({
    unansweredQuestions: z.number().int().nonnegative(),
    remainingCheckpoints: z.number().int().nonnegative(),
    remainingAgentCalls: z.number().int().nonnegative().nullable(),
    remainingActiveMs: z.number().nonnegative().nullable(),
    state: z.enum([
      "answered",
      "pending-work",
      "limits-exhausted",
      "no-further-checkpoint",
      "unavailable",
    ]),
    nextAction: z.string(),
  })
  .strict();
export type RunDialogueState = z.infer<typeof runDialogueStateSchema>;
export const arcRunUsageRpcContract = defineRpcContract({
  getRunUsage: {
    input: pageInput,
    output: z
      .object({
        workers: z.array(usageWorkerSchema).max(50),
        effectsTotal: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  },
  getRunResults: {
    input: pageInput,
    output: z
      .object({
        receipts: z.array(resultReceiptSchema).max(50),
        dialogue: runDialogueStateSchema,
        effectsTotal: z.number().int().nonnegative(),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  },
  listRunCollaboration: {
    input: z
      .object({
        runId: runIdSchema,
        kind: z.enum(["reports", "messages"]),
        cursor: collaborationCursorSchema.nullable().default(null),
        limit: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    output: z
      .object({
        reports: z.array(readerReportSchema).max(20),
        messages: z.array(runMessageSchema).max(20),
        nextCursor: collaborationCursorSchema.nullable(),
      })
      .strict(),
  },
});

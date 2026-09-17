import { defineRpcContract } from "@get-bb/plugin-sdk";
import { ownedRunStateSchema } from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import {
  runtimeIdSchema,
  runIdSchema,
  runtimeHashSchema,
} from "../runtime/definition.js";
import { teamGroupSchema } from "../teams/contract.js";

export const threadRunSchema = z
  .object({
    runId: runIdSchema,
    originThreadId: runtimeIdSchema,
    goal: z.string(),
    planHash: runtimeHashSchema,
    createdAt: z.number().int().nonnegative(),
    state: ownedRunStateSchema.nullable(),
    submission: z.enum(["reserved", "submitted", "needs-reconciliation"]),
    team: z
      .object({
        teamId: runtimeIdSchema,
        revision: z.number().int().positive(),
        name: z.string(),
      })
      .strict()
      .nullable(),
    workerThreadsTotal: z.number().int().nonnegative(),
    predecessorRunId: runIdSchema.nullable(),
    successor: z
      .object({ runId: runIdSchema, state: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type ArcThreadRun = z.infer<typeof threadRunSchema>;

export const threadWorkerBindingSchema = z
  .object({
    threadId: runtimeIdSchema,
    originThreadId: runtimeIdSchema,
    runId: runIdSchema,
    effectId: runtimeIdSchema,
    agentId: runtimeIdSchema,
    revision: z.number().int().positive(),
    name: z.string(),
    role: z.string(),
    purpose: z.enum(["writer", "reader", "repair", "review", "delegation"]),
    providerId: z.string(),
    model: z.string(),
    group: teamGroupSchema.nullable(),
    team: threadRunSchema.shape.team,
  })
  .strict();

export const threadBindingsSchema = z
  .object({
    origins: z
      .array(
        z
          .object({
            threadId: runtimeIdSchema,
            runs: z.array(threadRunSchema).max(20),
            runsTotal: z.number().int().nonnegative(),
            defaultRun: threadRunSchema.nullable(),
            activeLookup: z.enum(["available", "unavailable"]),
            nextOffset: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(100),
    workers: z.array(threadWorkerBindingSchema).max(100),
  })
  .strict();
export type ArcThreadBindings = z.infer<typeof threadBindingsSchema>;

export const arcThreadBrowserRpcContract = defineRpcContract({
  listThreadBindings: {
    input: z
      .object({
        projectId: runtimeIdSchema,
        threadIds: z.array(runtimeIdSchema).min(1).max(100),
        runLimit: z.number().int().min(1).max(20).default(1),
        runOffset: z.number().int().nonnegative().default(0),
      })
      .strict()
      .refine(
        (input) => input.threadIds.length * input.runLimit <= 100,
        "Request at most 100 run summaries per batch",
      ),
    output: threadBindingsSchema,
  },
});

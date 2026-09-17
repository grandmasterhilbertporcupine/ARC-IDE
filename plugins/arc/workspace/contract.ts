import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { arcRunUsageRpcContract } from "../runtime/usage-contract.js";
import { teamGroupSchema } from "../teams/contract.js";
import { arcThreadBrowserRpcContract } from "../threads/contract.js";
import {
  runEffectViewSchema,
  runIdSchema,
  runViewSchema,
  runtimeHashSchema,
  runtimeIdSchema,
} from "../runtime/contract.js";

export const workspaceCursorSchema = z
  .object({
    runId: runIdSchema,
    planHash: runtimeHashSchema,
    seenKeys: z.array(z.string().min(1).max(1024)).max(300),
  })
  .strict();
export type ArcWorkspaceCursor = z.infer<typeof workspaceCursorSchema>;

export const workspaceWorkerSchema = z
  .object({
    effectId: runtimeIdSchema,
    nodeId: runtimeIdSchema,
    graphNodeId: runtimeIdSchema.nullable(),
    iteration: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    state: z.enum([
      "admitted",
      "preparing",
      "prepared",
      "dispatch-requested",
      "native-accepted",
      "succeeded",
      "failed",
      "interrupted",
      "needs-reconciliation",
      "unavailable",
    ]),
    threadId: runtimeIdSchema.nullable(),
    executionContextId: runtimeIdSchema,
    environmentId: runtimeIdSchema.nullable(),
    turnRequestId: runtimeIdSchema.nullable(),
    name: z.string(),
    role: z.string(),
    purpose: z.enum(["writer", "reader", "repair", "review", "delegation"]),
    execution: z.object({ providerId: z.string(), model: z.string() }).strict(),
    task: z.string(),
    agentId: runtimeIdSchema,
    revision: z.number().int().positive(),
    group: teamGroupSchema.nullable(),
    dispatchKey: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type ArcWorkspaceWorker = z.infer<typeof workspaceWorkerSchema>;

export const workspaceEventSchema = z
  .object({
    key: z.string(),
    effectId: runtimeIdSchema,
    milestone: z.enum(["admitted", "prepared", "native-accepted"]),
    threadId: runtimeIdSchema.nullable(),
    turnRequestId: runtimeIdSchema.nullable(),
  })
  .strict();

export const workspaceViewSchema = z
  .object({
    run: runViewSchema,
    origin: z
      .object({
        threadId: runtimeIdSchema,
        title: z.string().nullable(),
        providerId: z.string().nullable(),
        model: z.string().nullable(),
      })
      .strict(),
    workers: z.array(workspaceWorkerSchema).max(100),
    workersTotal: z.number().int().nonnegative(),
    workersTruncated: z.boolean(),
    effects: z.array(runEffectViewSchema).max(100),
    effectsTotal: z.number().int().nonnegative(),
    events: z.array(workspaceEventSchema).max(100),
    cursor: workspaceCursorSchema,
    hasMoreEvents: z.boolean(),
  })
  .strict();
export type ArcWorkspaceView = z.infer<typeof workspaceViewSchema>;

export const arcWorkspaceRpcContract = defineRpcContract({
  ...arcThreadBrowserRpcContract,
  ...arcRunUsageRpcContract,
  getWorkspace: {
    input: z
      .object({
        runId: runIdSchema,
        cursor: workspaceCursorSchema.nullable().default(null),
        eventLimit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    output: workspaceViewSchema,
  },
});

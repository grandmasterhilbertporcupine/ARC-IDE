import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { contextHostRpcMethods } from "./host-context-contract.js";
import { boundedReadingHostMethods } from "./host-reading-contract.js";
import {
  hostLaneSchema,
  hostProcessReceiptSchema,
} from "./host-shared-contract.js";
import { directoryHostRpcMethods } from "./host-directory-contract.js";
export {
  hostLaneSchema,
  hostProcessReceiptSchema,
} from "./host-shared-contract.js";
export * from "./host-directory-contract.js";

const id = z.string().min(1).max(200);
const absolutePath = z.string().min(1).max(32_768);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export const hostWorkspaceStateSchema = z
  .object({
    path: absolutePath,
    topLevel: absolutePath,
    gitDir: absolutePath,
    commonGitDir: absolutePath,
    head: sha,
    currentBranch: z.string().nullable(),
    clean: z.boolean(),
    trackedDigest: digest,
    untrackedDigest: digest,
    contentDigest: digest,
    stateDigest: digest,
  })
  .strict();
export type HostWorkspaceState = z.infer<typeof hostWorkspaceStateSchema>;

export const hostWorkspaceBindingSchema = z
  .object({
    path: absolutePath,
    commonGitDir: absolutePath,
    originalPath: absolutePath,
    expectedHead: sha,
    expectedStateDigest: digest.nullable(),
  })
  .strict();
export type HostWorkspaceBinding = z.infer<typeof hostWorkspaceBindingSchema>;

export const hostOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }).strict(),
  z
    .object({
      type: z.literal("prepare-worktree"),
      workspaceId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("fork-worktree"),
      workspaceId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("commit"),
      message: z.string().min(1).max(16_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("integrate"),
      source: hostWorkspaceBindingSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("merge-candidate"),
      source: hostWorkspaceBindingSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("check"),
      executable: z.string().min(1).max(32_768),
      args: z.array(z.string().max(32_768)).max(256),
      timeoutMs: z.number().int().min(100).max(7_200_000),
    })
    .strict(),
]);

export const hostEffectRequestSchema = z
  .object({
    runId: id,
    effectId: id,
    workspace: hostWorkspaceBindingSchema,
    lane: hostLaneSchema.nullable(),
    operation: hostOperationSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.operation.type === "integrate" ||
        request.operation.type === "merge-candidate") &&
      request.lane === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message: "Integration requires a durable lane fence.",
      });
    }
    if (
      request.operation.type === "merge-candidate" &&
      (request.workspace.expectedStateDigest === null ||
        request.operation.source.expectedStateDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspace", "expectedStateDigest"],
        message:
          "Candidate merge requires exact observed source and target workspace states.",
      });
    }
    if (
      (request.operation.type === "commit" ||
        request.operation.type === "fork-worktree") &&
      request.workspace.expectedStateDigest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspace", "expectedStateDigest"],
        message: `${request.operation.type === "commit" ? "Commit" : "Worktree fork"} requires the exact observed workspace state.`,
      });
    }
  });
export type HostEffectRequest = z.infer<typeof hostEffectRequestSchema>;

export type HostProcessReceipt = z.infer<typeof hostProcessReceiptSchema>;

export const hostEffectReceiptSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "interrupted", "invalid"]),
    reason: z.string().nullable(),
    before: hostWorkspaceStateSchema.nullable(),
    after: hostWorkspaceStateSchema.nullable(),
    source: hostWorkspaceStateSchema.nullable(),
    processes: z.array(hostProcessReceiptSchema),
    artifact: z
      .object({
        workspacePath: absolutePath.nullable(),
        commitSha: sha.nullable(),
        treeSha: sha.nullable(),
      })
      .strict(),
    finishedAt: z.string(),
  })
  .strict();
export type HostEffectReceipt = z.infer<typeof hostEffectReceiptSchema>;

export const hostEffectRecordSchema = z
  .object({
    runId: id,
    effectId: id,
    requestHash: digest,
    state: z.enum(["running", "terminal", "needs-reconciliation"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    receipt: hostEffectReceiptSchema.nullable(),
    receiptValidity: z
      .object({
        status: z.enum(["current", "stale", "unavailable"]),
        reason: z.string().nullable(),
        checkedAt: z.string(),
        currentState: hostWorkspaceStateSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HostEffectRecord = z.infer<typeof hostEffectRecordSchema>;

export const hostEffectIdentitySchema = z
  .object({
    runId: id,
    effectId: id,
    requestHash: digest,
  })
  .strict();
export type HostEffectIdentity = z.infer<typeof hostEffectIdentitySchema>;

export const arcHostContract = defineRpcContract({
  ...boundedReadingHostMethods,
  ...contextHostRpcMethods,
  ...directoryHostRpcMethods,
  inspectWorkspace: {
    input: z
      .object({
        path: absolutePath,
        expected: hostWorkspaceBindingSchema.nullable(),
      })
      .strict(),
    output: hostWorkspaceStateSchema,
  },
  startEffect: {
    input: hostEffectRequestSchema,
    output: hostEffectRecordSchema,
  },
  observeEffect: {
    input: hostEffectIdentitySchema,
    output: hostEffectRecordSchema.nullable(),
  },
  interruptEffect: {
    input: hostEffectIdentitySchema,
    output: hostEffectRecordSchema.nullable(),
  },
});

import { z } from "zod";
import { ownedDependencyReceiptSchema } from "bb-plugin-workflows/owned-contract";
import {
  directoryBindingSchema,
  directoryEffectReceiptSchema,
  directoryEffectRequestSchema,
  directorySnapshotSchema,
  directoryStateSchema,
  type DirectorySnapshot,
} from "../host-directory-contract.js";
import { runtimeHashSchema, runtimeIdSchema } from "./definition.js";
import { graphControlDecisionSchema } from "./graph-control-decision.js";

export const directoryReviewVerdictSchema = z
  .object({
    kind: z.literal("directory"),
    snapshotId: runtimeIdSchema,
    manifestDigest: runtimeHashSchema,
    outcome: z.enum(["approved", "changes-requested"]),
    summary: z.string().trim().min(1).max(8000),
    findings: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            detail: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type DirectoryReviewVerdict = z.infer<
  typeof directoryReviewVerdictSchema
>;

export const directoryWorkerBindingSchema = z
  .object({
    kind: z.literal("directory"),
    workspace: directoryBindingSchema,
    snapshot: directorySnapshotSchema,
    prompt: z.string().min(1).max(65_536),
  })
  .strict();
export type DirectoryWorkerBinding = z.infer<
  typeof directoryWorkerBindingSchema
>;

export const directoryControlReceiptSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    selectedOutputs: z.array(z.string().min(1)).min(1).max(100),
    data: z
      .object({
        snapshot: directorySnapshotSchema.nullable(),
        decision: graphControlDecisionSchema,
        check: ownedDependencyReceiptSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type DirectoryControlReceipt = z.infer<
  typeof directoryControlReceiptSchema
>;

export const directoryRuntimeReceiptSchema = z.union([
  z
    .object({
      kind: z.literal("directory-native"),
      request: directoryEffectRequestSchema,
      receipt: directoryEffectReceiptSchema,
      candidate: directorySnapshotSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory-agent"),
      threadId: runtimeIdSchema,
      executionContextId: runtimeIdSchema,
      turnRequestId: runtimeIdSchema,
      terminalEventId: runtimeIdSchema,
      terminalStatus: z.enum(["completed", "failed", "interrupted"]),
      workspace: directoryBindingSchema,
      snapshot: directorySnapshotSchema,
      observed: directoryStateSchema.nullable(),
      review: directoryReviewVerdictSchema.nullable(),
      definitionHash: runtimeHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory-preparation"),
      operationId: runtimeIdSchema,
      threadId: runtimeIdSchema,
      revision: z.number().int().nonnegative(),
      state: z.enum(["cancelled", "failed"]),
      reason: z.string(),
    })
    .strict(),
  directoryControlReceiptSchema,
]);
export type DirectoryRuntimeReceipt = z.infer<
  typeof directoryRuntimeReceiptSchema
>;

export function directoryReceiptSnapshot(
  receipt: DirectoryRuntimeReceipt,
): DirectorySnapshot | null {
  if ("data" in receipt) return receipt.data.snapshot;
  if (receipt.kind === "directory-preparation") return null;
  return receipt.kind === "directory-native"
    ? receipt.candidate
    : receipt.snapshot;
}

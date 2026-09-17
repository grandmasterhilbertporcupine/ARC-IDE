import { z } from "zod";
import {
  hostEffectReceiptSchema,
  hostEffectRequestSchema,
  hostWorkspaceStateSchema,
  type HostWorkspaceState,
} from "../host-contract.js";
import { reviewVerdictSchema } from "./contract.js";

export const runtimeReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preparation"),
      operationId: z.string(),
      threadId: z.string(),
      revision: z.number(),
      state: z.enum(["cancelled", "failed"]),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      request: hostEffectRequestSchema,
      receipt: hostEffectReceiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      threadId: z.string(),
      executionContextId: z.string(),
      turnRequestId: z.string(),
      terminalEventId: z.string(),
      terminalStatus: z.enum(["completed", "failed", "interrupted"]),
      workspace: hostWorkspaceStateSchema,
      review: reviewVerdictSchema.nullable(),
      definitionHash: z.string(),
    })
    .strict(),
]);
export type RuntimeReceipt = z.infer<typeof runtimeReceiptSchema>;

export function sameWorkspaceIdentity(
  left: HostWorkspaceState,
  right: HostWorkspaceState,
) {
  return (
    left.path === right.path &&
    left.topLevel === right.topLevel &&
    left.gitDir === right.gitDir &&
    left.commonGitDir === right.commonGitDir
  );
}

export function sameWorkspaceState(
  left: HostWorkspaceState,
  right: HostWorkspaceState,
) {
  return (
    sameWorkspaceIdentity(left, right) &&
    left.head === right.head &&
    left.stateDigest === right.stateDigest
  );
}

export function receiptWorkspace(receipt: RuntimeReceipt) {
  if (receipt.kind === "preparation")
    throw new Error("This worker never started and has no execution receipt");
  const workspace =
    receipt.kind === "agent" ? receipt.workspace : receipt.receipt.after;
  if (workspace === null)
    throw new Error(
      "The native operation did not produce a verified workspace",
    );
  return workspace;
}

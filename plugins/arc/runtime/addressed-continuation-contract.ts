import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const scope = z
  .object({ projectId: z.string().min(1), threadId: z.string().min(1) })
  .strict();
const mutation = scope.extend({
  operationId: z.string().uuid(),
  expectedUpdatedAt: z.number().int().nonnegative(),
});
export const addressedFollowupSchema = z
  .object({
    operationId: z.string().uuid(),
    goal: z.string(),
    predecessorRunId: z.string().nullable(),
    successorRunId: z.string(),
    state: z.enum([
      "queued",
      "checking",
      "starting",
      "applied",
      "action-required",
      "cancelled",
    ]),
    error: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export const arcAddressedFollowupsRpcContract = defineRpcContract({
  getAddressedFollowups: {
    input: scope,
    output: z.object({ followups: z.array(addressedFollowupSchema) }).strict(),
  },
  retryAddressedFollowup: { input: mutation, output: addressedFollowupSchema },
  cancelAddressedFollowup: { input: mutation, output: addressedFollowupSchema },
});

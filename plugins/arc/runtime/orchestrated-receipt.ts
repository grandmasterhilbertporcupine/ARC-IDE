import { z } from "zod";
import { runtimeHashSchema, runtimeIdSchema } from "./definition.js";

export const orchestratorReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("orchestrator"),
      operationId: runtimeIdSchema,
      threadId: runtimeIdSchema,
      executionContextId: runtimeIdSchema,
      turnRequestId: runtimeIdSchema,
      providerThreadId: runtimeIdSchema,
      turnId: runtimeIdSchema,
      acceptedEventId: runtimeIdSchema,
      terminalEventId: runtimeIdSchema,
      terminalStatus: z.enum(["completed", "failed", "interrupted"]),
      definitionHash: runtimeHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("orchestrator-preparation"),
      operationId: runtimeIdSchema,
      threadId: runtimeIdSchema,
      executionContextId: runtimeIdSchema,
      revision: z.number().int().nonnegative(),
      state: z.enum(["cancelled", "failed"]),
      reason: z.string().nullable(),
    })
    .strict(),
]);

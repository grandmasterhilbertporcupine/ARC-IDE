import { z } from "zod";
import { ownedStepRefSchema } from "bb-plugin-workflows/owned-contract";

export const graphControlDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message-response"),
      messageId: z.string().min(1).nullable(),
      memberId: z.string().min(1).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("barrier") }).strict(),
  z.object({ kind: z.literal("condition"), value: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("approval"),
      value: z.enum(["approved", "rejected"]),
      operationId: z.string().min(1),
      contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repair"),
      value: z.enum(["repaired", "exhausted"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delegation"),
      assignments: z
        .array(
          z
            .object({
              slot: z.number().int().nonnegative().max(99),
              memberId: z.string().min(1),
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delegation-slot"),
      slot: z.number().int().nonnegative().max(99),
      memberId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("candidate"), source: ownedStepRefSchema })
    .strict(),
]);

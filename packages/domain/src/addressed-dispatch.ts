import { z } from "zod";

export const experimentalRecipientIdentitySchema = z.strictObject({
  kind: z.enum(["agent", "team"]),
  entityId: z.string().min(1).max(256),
  versionId: z.number().int().positive(),
  scopeKey: z.string().min(1).max(512),
});

export const experimentalAddressedRecipientSchema =
  experimentalRecipientIdentitySchema.extend({
    pluginId: z.string().min(1).max(128),
    label: z.string().trim().min(1).max(256),
  });

export const experimentalAddressingSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    recipients: z.array(experimentalAddressedRecipientSchema).min(1).max(12),
  })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const recipient of value.recipients) {
      const key = `${recipient.pluginId}:${recipient.kind}:${recipient.entityId}`;
      if (keys.has(key))
        context.addIssue({
          code: "custom",
          message: "Recipients must be unique",
        });
      keys.add(key);
    }
    if (
      new Set(value.recipients.map((recipient) => recipient.pluginId)).size !==
      1
    )
      context.addIssue({
        code: "custom",
        message: "Recipients must use the same coordinator",
      });
  });

export const experimentalAddressedDispatchResultSchema = z.strictObject({
  runId: z.string().min(1).max(256),
  status: z.enum(["started", "continued"]),
  summary: z.string().min(1).max(4000),
  path: z
    .string()
    .max(2048)
    .regex(/^\/plugins\/[a-zA-Z0-9_-]+\/[^\s\\]+$/)
    .optional(),
});

export type ExperimentalRecipientIdentity = z.infer<
  typeof experimentalRecipientIdentitySchema
>;
export type ExperimentalAddressedRecipient = z.infer<
  typeof experimentalAddressedRecipientSchema
>;
export type ExperimentalAddressing = z.infer<
  typeof experimentalAddressingSchema
>;
export type ExperimentalAddressedDispatchResult = z.infer<
  typeof experimentalAddressedDispatchResultSchema
>;

import { z } from "zod";
import { agentScopeSchema } from "../contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const compositionOriginSchema = z
  .object({
    kind: z.enum(["team", "agent"]),
    scope: agentScopeSchema,
    entityId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    contentHash: hash,
  })
  .strict()
  .superRefine((origin, context) => {
    if (!new RegExp(`^${origin.kind}_[a-f0-9-]{36}$`).test(origin.entityId))
      context.addIssue({
        code: "custom",
        path: ["entityId"],
        message:
          "The composition origin must identify its exact published kind",
      });
  });
export type CompositionOrigin = z.infer<typeof compositionOriginSchema>;
export const compositionOriginKey = (origin: CompositionOrigin) =>
  JSON.stringify([
    origin.kind,
    origin.scope.kind,
    origin.scope.kind === "project" ? origin.scope.projectId : null,
    origin.entityId,
    origin.revision,
  ]);
export const compositionAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(256),
    bindingHash: hash,
    origins: z.array(compositionOriginSchema).min(1).max(200),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.origins.map(compositionOriginKey)).size ===
      value.origins.length,
    "Composition origins must be unique",
  );
export type CompositionAuthorization = z.infer<
  typeof compositionAuthorizationSchema
>;

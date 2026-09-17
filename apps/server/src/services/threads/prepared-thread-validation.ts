import { z } from "zod";
import {
  permissionModeSchema,
  promptInputSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  threadVisibilitySchema,
} from "@bb/domain";
import {
  unmanagedWorkspaceSchema,
  managedWorktreeWorkspaceSchema,
  personalWorkspaceSchema,
  baseBranchSpecSchema,
} from "@bb/server-contract";

const identifier = z.string().trim().min(1).max(256);
const workspaceArgsSchema = z.discriminatedUnion("type", [
  unmanagedWorkspaceSchema.strict(),
  managedWorktreeWorkspaceSchema
    .extend({
      baseBranch: z.discriminatedUnion("kind", [
        baseBranchSpecSchema.options[0].strict(),
        baseBranchSpecSchema.options[1].strict(),
      ]),
    })
    .strict(),
  personalWorkspaceSchema.strict(),
]);
export const preparedThreadEnvironmentSchema = z.strictObject({
  hostId: identifier,
  environmentId: identifier,
  path: z.string().min(1),
});
export const preparedThreadRequestSchema = z
  .strictObject({
    operationId: identifier,
    projectId: identifier,
    parentThreadId: identifier.nullable(),
    parentNotification: z.literal("owner-controlled").optional(),
    executionContextId: identifier,
    title: z.string().trim().min(1),
    visibility: threadVisibilitySchema,
    turnPolicy: z.enum(["single", "conversation"]),
    environment: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("reuse"), environmentId: identifier }),
      z.strictObject({
        type: z.literal("host"),
        hostId: identifier,
        workspace: workspaceArgsSchema,
      }),
    ]),
    execution: z.strictObject({
      providerId: identifier,
      model: identifier,
      reasoningLevel: reasoningLevelSchema,
      serviceTier: serviceTierSchema,
      permissionMode: permissionModeSchema,
    }),
    input: z.array(promptInputSchema).min(1),
  })
  .refine(
    (request) =>
      request.parentNotification === undefined ||
      request.parentThreadId !== null,
    "Owner-controlled parent notification requires a parent thread",
  );
export const preparedThreadLookupSchema = z.strictObject({
  operationId: identifier,
});
export const preparedThreadStartSchema = z.strictObject({
  operationId: identifier,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  environment: preparedThreadEnvironmentSchema,
});

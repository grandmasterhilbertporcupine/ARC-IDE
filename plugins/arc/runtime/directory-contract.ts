import { z } from "zod";
import { ownedStepRefSchema } from "bb-plugin-workflows/owned-contract";
import {
  directoryRootIdentitySchema,
  directoryStateSchema,
} from "../host-directory-contract.js";
import { resolvedRunPolicySchema } from "../policy/contract.js";
import { teamRevisionSchema } from "../teams/contract.js";
import { compositionAuthorizationSchema } from "./composition-authorization-contract.js";
import {
  runAgentSnapshotSchema,
  runIdSchema,
  runtimeHashSchema,
  runtimeIdSchema,
  runtimePathSchema,
} from "./definition.js";
import {
  graphRunRequestSchema,
  graphRuntimeNodeSchema,
} from "./graph-contract.js";
import {
  orchestratorCompletionSchema,
  orchestratedRunRequestSchema,
  orchestratorRuntimeNodeSchema,
} from "./orchestrated-contract.js";

export const directoryExpectedSourceSchema = z
  .object({
    rootIdentity: directoryRootIdentitySchema,
    manifestDigest: runtimeHashSchema,
  })
  .strict();

export const directoryRunRequestSchema = graphRunRequestSchema
  .omit({ expectedHead: true })
  .extend({
    sourceInspectionId: runtimeIdSchema,
    expectedSource: directoryExpectedSourceSchema,
    invocation: orchestratedRunRequestSchema.shape.invocation,
    addressedRecipients: orchestratedRunRequestSchema.shape.addressedRecipients,
    addressedAttachments:
      orchestratedRunRequestSchema.shape.addressedAttachments,
  });
export type DirectoryRunRequest = z.infer<typeof directoryRunRequestSchema>;

export const directoryRunDefinitionSchema = z
  .object({
    schemaVersion: z.literal(4),
    runId: runIdSchema,
    request: directoryRunRequestSchema,
    source: directoryStateSchema,
    team: teamRevisionSchema,
    members: z.record(z.string().min(1).max(200), runAgentSnapshotSchema),
    compositionAuthorization: compositionAuthorizationSchema.optional(),
    policy: resolvedRunPolicySchema,
    completion: orchestratorCompletionSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DirectoryRunDefinition = z.infer<
  typeof directoryRunDefinitionSchema
>;

export const directoryRuntimeNodeSchema = z.union([
  z
    .object({
      kind: z.literal("capture-source"),
      workspaceKey: runtimeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("materialize-directory"),
      workspaceKey: runtimeIdSchema,
      candidate: ownedStepRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("capture-directory"),
      workspace: ownedStepRefSchema,
      worker: ownedStepRefSchema,
      workspaceKey: runtimeIdSchema,
    })
    .strict(),
  graphRuntimeNodeSchema.options[2],
  graphRuntimeNodeSchema.options[5],
  graphRuntimeNodeSchema.options[6],
  graphRuntimeNodeSchema.options[7],
  orchestratorRuntimeNodeSchema,
]);
export type DirectoryRuntimeNode = z.infer<typeof directoryRuntimeNodeSchema>;

export const directorySetupIntentSchema = z
  .object({
    operationId: runtimeIdSchema,
    projectId: runtimeIdSchema,
    originThreadId: runtimeIdSchema,
    hostId: runtimeIdSchema,
    path: runtimePathSchema,
    originEnvironment: orchestratorCompletionSchema.shape.environment,
    providerId: runtimeIdSchema,
  })
  .strict();
export type DirectorySetupIntent = z.infer<typeof directorySetupIntentSchema>;

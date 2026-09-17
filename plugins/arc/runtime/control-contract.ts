import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ownedDependencyReceiptSchema } from "bb-plugin-workflows/owned-contract";
import { hostWorkspaceStateSchema } from "../host-contract.js";
import { directorySnapshotSchema } from "../host-directory-contract.js";
import {
  runtimeHashSchema,
  runtimeIdSchema,
  runIdSchema,
} from "./definition.js";
import { graphControlOperationSchema } from "./graph-contract.js";

export const delegationAssignmentsSchema = z
  .array(z.object({ memberId: runtimeIdSchema }).strict())
  .min(1)
  .max(100);
export const runControlContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: runIdSchema,
    effectId: runtimeIdSchema,
    planHash: runtimeHashSchema,
    requestHash: runtimeHashSchema,
    nodeId: runtimeIdSchema,
    iteration: z.number().int().nonnegative(),
    operation: graphControlOperationSchema,
    candidate: hostWorkspaceStateSchema.nullable(),
    policyHash: runtimeHashSchema,
    teamContentHash: runtimeHashSchema,
    dependencyReceipts: z.array(ownedDependencyReceiptSchema).max(4096),
    proposedAssignments: delegationAssignmentsSchema.nullable(),
  })
  .strict();
export type RunControlContext = z.infer<typeof runControlContextSchema>;
export const directoryRunControlContextSchema = runControlContextSchema.extend({
  schemaVersion: z.literal(2),
  candidate: directorySnapshotSchema.nullable(),
});
export const runControlContextInputSchema = z.union([
  runControlContextSchema,
  directoryRunControlContextSchema,
]);
export type RunControlContextInput = z.infer<
  typeof runControlContextInputSchema
>;
export const runControlSchema = z
  .object({
    controlId: runtimeIdSchema,
    runId: runIdSchema,
    effectId: runtimeIdSchema,
    contextHash: runtimeHashSchema,
    context: runControlContextInputSchema,
    revision: z.number().int().positive(),
    state: z.enum(["pending", "resolved", "cancelled"]),
    decision: z.enum(["approved", "rejected"]).nullable(),
    operationId: runtimeIdSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RunControl = z.infer<typeof runControlSchema>;
export const resolveRunControlSchema = z
  .object({
    runId: runIdSchema,
    controlId: runtimeIdSchema,
    operationId: runtimeIdSchema,
    expectedRevision: z.number().int().positive(),
    contextHash: runtimeHashSchema,
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();
export const arcRunControlsRpcContract = defineRpcContract({
  listRunControls: {
    input: z
      .object({
        runId: runIdSchema,
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    output: z
      .object({
        controls: z.array(runControlSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getRunControl: {
    input: z
      .object({ runId: runIdSchema, controlId: runtimeIdSchema })
      .strict(),
    output: runControlSchema,
  },
  resolveRunControl: {
    input: resolveRunControlSchema,
    output: runControlSchema,
  },
  resolveDirectoryRunControl: {
    input: resolveRunControlSchema,
    output: z
      .object({
        state: z.enum(["checking", "resolved"]),
        control: runControlSchema,
      })
      .strict(),
  },
});

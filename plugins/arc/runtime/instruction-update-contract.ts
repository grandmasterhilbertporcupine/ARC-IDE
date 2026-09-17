import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  runIdSchema,
  runtimeHashSchema,
  runtimeIdSchema,
} from "./definition.js";

const team = z
  .object({
    teamId: runtimeIdSchema,
    revision: z.number().int().positive(),
    name: z.string(),
  })
  .strict();
export const instructionUpdatePreviewSchema = z
  .object({
    previewId: runtimeIdSchema,
    previewHash: runtimeHashSchema,
    runId: runIdSchema,
    projectId: runtimeIdSchema,
    planHash: runtimeHashSchema,
    controlVersion: z.number().int().nonnegative(),
    oldTeam: team,
    newTeam: team,
    changes: z.array(
      z
        .object({
          memberId: runtimeIdSchema,
          agentId: runtimeIdSchema,
          name: z.string(),
          oldRevision: z.number().int().positive(),
          newRevision: z.number().int().positive(),
          before: z.string(),
          after: z.string(),
        })
        .strict(),
    ),
    affectedNodes: z.array(
      z
        .object({
          nodeId: runtimeIdSchema,
          label: z.string(),
          kind: z.string(),
        })
        .strict(),
    ),
    rerun: z.literal("entire-team-from-original"),
    source: z
      .object({
        kind: z.enum(["git", "directory"]),
        path: z.string(),
        identityHash: runtimeHashSchema,
      })
      .strict(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type InstructionUpdatePreview = z.infer<
  typeof instructionUpdatePreviewSchema
>;

export const instructionUpdateApplicationSchema = z
  .object({
    operationId: runtimeIdSchema,
    runId: runIdSchema,
    successorRunId: runIdSchema,
    preview: instructionUpdatePreviewSchema,
    state: z.enum([
      "pausing",
      "checking",
      "starting",
      "applied",
      "cancelling",
      "cancelled",
      "failed",
    ]),
    reason: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type InstructionUpdateApplication = z.infer<
  typeof instructionUpdateApplicationSchema
>;
const key = z
  .object({ runId: runIdSchema, operationId: runtimeIdSchema })
  .strict();
export const arcInstructionUpdatesRpcContract = defineRpcContract({
  previewRunInstructionUpdate: {
    input: z
      .object({ runId: runIdSchema, team: team.omit({ name: true }) })
      .strict(),
    output: instructionUpdatePreviewSchema,
  },
  applyRunInstructionUpdate: {
    input: z
      .object({
        operationId: runtimeIdSchema,
        previewId: runtimeIdSchema,
        previewHash: runtimeHashSchema,
      })
      .strict(),
    output: instructionUpdateApplicationSchema,
  },
  pollRunInstructionUpdate: {
    input: key,
    output: instructionUpdateApplicationSchema,
  },
  cancelRunInstructionUpdate: {
    input: key.extend({
      previewId: runtimeIdSchema,
      previewHash: runtimeHashSchema,
    }),
    output: instructionUpdateApplicationSchema,
  },
  getRunInstructionUpdateState: {
    input: z.object({ runId: runIdSchema }).strict(),
    output: z
      .object({
        incoming: instructionUpdateApplicationSchema.nullable(),
        outgoing: instructionUpdateApplicationSchema.nullable(),
      })
      .strict(),
  },
});

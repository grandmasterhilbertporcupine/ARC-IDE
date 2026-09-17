import { z } from "zod";
import { ownedStepRefSchema } from "bb-plugin-workflows/owned-contract";
import { resolvedRunPolicySchema } from "../policy/contract.js";
import { teamRevisionSchema } from "../teams/contract.js";
import {
  gitOidSchema,
  runAgentSnapshotSchema,
  runIdSchema,
  runSourceSchema,
  runtimeIdSchema,
  runtimePathSchema,
} from "./definition.js";

const reference = ownedStepRefSchema;
const memberId = z.string().min(1).max(200);
const output = z.string().min(1).max(256);
const command = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(16000)
          .refine((value) => !value.includes("\0")),
      )
      .max(100),
    timeoutMs: z.number().int().min(1000).max(3_600_000),
  })
  .strict();

export const graphRunRequestSchema = z
  .object({
    operationId: runtimeIdSchema,
    projectId: runtimeIdSchema,
    originThreadId: runtimeIdSchema,
    hostId: runtimeIdSchema,
    path: runtimePathSchema,
    expectedHead: gitOidSchema,
    goal: z.string().trim().min(1).max(16_384),
    team: z
      .object({
        teamId: z.string().regex(/^team_[a-f0-9-]{36}$/),
        revision: z.number().int().positive(),
      })
      .strict(),
    expectedProjectPolicyVersion: z.number().int().nonnegative(),
    expectedSessionPolicyVersion: z.number().int().nonnegative(),
  })
  .strict();
export type GraphRunRequest = z.infer<typeof graphRunRequestSchema>;

export const graphRunDefinitionSchema = z
  .object({
    schemaVersion: z.literal(2),
    runId: runIdSchema,
    request: graphRunRequestSchema,
    source: runSourceSchema,
    team: teamRevisionSchema,
    members: z.record(memberId, runAgentSnapshotSchema),
    policy: resolvedRunPolicySchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type GraphRunDefinition = z.infer<typeof graphRunDefinitionSchema>;

export const graphPredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("outcome"),
      source: reference,
      equals: z.enum(["succeeded", "failed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check-exit"),
      source: reference,
      operator: z.enum(["eq", "ne"]),
      value: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review-verdict"),
      source: reference,
      equals: z.enum(["approved", "rejected"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval"),
      source: reference,
      equals: z.enum(["approved", "rejected"]),
    })
    .strict(),
]);

export const graphControlOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message-response"),
      candidate: reference,
      candidateMemberIds: z.array(memberId).min(1).max(100),
    })
    .strict(),
  z.object({ type: z.literal("barrier") }).strict(),
  z
    .object({ type: z.literal("condition"), predicate: graphPredicateSchema })
    .strict(),
  z
    .object({
      type: z.literal("approval"),
      message: z.string().min(1).max(32_768),
      candidate: reference.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("repair-result"),
      decision: reference.nullable(),
      candidate: reference,
      check: reference,
      next: reference.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delegation"),
      requester: reference,
      candidate: reference,
      candidateMemberIds: z.array(memberId).min(1).max(100),
      maxChildCalls: z.number().int().min(1).max(100),
      task: z.string().min(1).max(16_384),
      access: z.enum(["read", "write"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("delegation-slot"),
      decision: reference,
      slot: z.number().int().nonnegative().max(99),
      candidateMemberIds: z.array(memberId).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("candidate-choice"),
      decision: reference,
      branches: z
        .array(
          z
            .object({
              output,
              candidate: reference,
              check: reference.nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(101),
    })
    .strict(),
]);
export type GraphControlOperation = z.infer<typeof graphControlOperationSchema>;

export const graphRuntimeNodeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepare-worktree"),
      workspaceKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fork-worktree"),
      workspaceKey: z.string().min(1),
      candidate: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      purpose: z.enum(["writer", "reader", "repair", "review", "delegation"]),
      memberId,
      access: z.enum(["read", "write"]),
      agent: runAgentSnapshotSchema,
      task: z.string().min(1).max(32_768),
      workspace: reference,
      candidate: reference,
      failure: reference.nullable(),
      delegationPoint: z.string().min(1).nullable(),
      replyDecision: reference.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      workspace: reference,
      worker: reference,
      message: z.string().min(1).max(16_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("integrate"),
      strategy: z.literal("merge-candidate"),
      workspace: reference,
      candidate: reference,
      commit: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      workspace: reference,
      candidate: reference,
      command,
    })
    .strict(),
  z
    .object({
      kind: z.literal("verify"),
      workspace: reference,
      check: reference,
      review: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal("control"),
      operation: graphControlOperationSchema,
    })
    .strict(),
]);
export type GraphRuntimeNode = z.infer<typeof graphRuntimeNodeSchema>;

export const graphNodeOutputSchema = z
  .object({
    outcome: reference,
    candidate: reference.nullable(),
    checks: z.array(reference).max(4096),
  })
  .strict();
export type GraphNodeOutput = z.infer<typeof graphNodeOutputSchema>;

export const graphCompilerReferencesSchema = z
  .object({
    source: reference,
    outputs: z.record(z.string(), graphNodeOutputSchema),
    origins: z.record(
      z.string(),
      z
        .object({
          graphNodeId: z.string().nullable(),
          memberId: memberId.nullable(),
        })
        .strict(),
    ),
    consumedFailures: z
      .array(
        z
          .object({
            failure: reference,
            consumer: reference,
            candidate: reference,
          })
          .strict(),
      )
      .max(4096),
    finalGates: z
      .array(
        z
          .object({
            candidate: reference,
            check: reference,
            review: reference,
            verify: reference,
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
export type GraphCompilerReferences = z.infer<
  typeof graphCompilerReferencesSchema
>;

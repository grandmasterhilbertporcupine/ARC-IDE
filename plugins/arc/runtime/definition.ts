import { z } from "zod";
import { agentExecutionSchema, agentRevisionSchema } from "../contract.js";

export const runIdSchema = z.string().regex(/^run_[a-f0-9-]{36}$/);
export const runtimeIdSchema = z.string().trim().min(1).max(256);
export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const runtimeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      (/^[A-Za-z]:[\\/]/.test(value) ||
        /^\\\\[^\\]+\\[^\\]+/.test(value) ||
        value.startsWith("/")),
    "Choose an absolute path on the project's host",
  );

export const runAgentSelectionSchema = z
  .object({
    agentId: z.string().regex(/^agent_[a-f0-9-]{36}$/),
    revision: z.number().int().positive(),
  })
  .strict();

export const runCheckSchema = z
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
          .max(16_384)
          .refine((value) => !value.includes("\0")),
      )
      .max(128),
    timeoutMs: z.number().int().min(1000).max(1_800_000),
  })
  .strict();

export const runRequestSchema = z
  .object({
    operationId: runtimeIdSchema,
    projectId: runtimeIdSchema,
    originThreadId: runtimeIdSchema,
    hostId: runtimeIdSchema,
    path: runtimePathSchema,
    expectedHead: gitOidSchema,
    goal: z.string().trim().min(1).max(16_384),
    writers: z
      .array(
        z
          .object({
            agent: runAgentSelectionSchema,
            task: z.string().trim().min(1).max(16_384),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    reviewer: runAgentSelectionSchema,
    repairer: runAgentSelectionSchema,
    check: runCheckSchema,
  })
  .strict();
export type ArcRunRequest = z.infer<typeof runRequestSchema>;

export const resolvedExecutionSchema = z
  .object({
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    reasoningLevel: agentExecutionSchema.shape.reasoningLevel.unwrap(),
    serviceTier: agentExecutionSchema.shape.serviceTier.unwrap(),
    permissionMode: agentExecutionSchema.shape.permissionMode.unwrap(),
  })
  .strict();

export const runAgentSnapshotSchema = z
  .object({
    definition: agentRevisionSchema,
    execution: resolvedExecutionSchema,
  })
  .strict();
export type RunAgentSnapshot = z.infer<typeof runAgentSnapshotSchema>;

export const runSourceSchema = z
  .object({
    path: runtimePathSchema,
    commonGitDir: runtimePathSchema,
    head: gitOidSchema,
    branch: z.string().min(1).max(1024).nullable(),
    stateHash: runtimeHashSchema,
  })
  .strict();

export const runDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: runIdSchema,
    request: runRequestSchema,
    source: runSourceSchema,
    writers: z.array(runAgentSnapshotSchema).min(1).max(4),
    reviewer: runAgentSnapshotSchema,
    repairer: runAgentSnapshotSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ArcRunDefinition = z.infer<typeof runDefinitionSchema>;

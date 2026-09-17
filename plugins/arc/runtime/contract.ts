import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  ownedRunViewSchema,
  ownedStepResourceV2Schema,
  ownedStepObservationInputSchema,
} from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import {
  graphRunDefinitionSchema,
  graphRunRequestSchema,
} from "./graph-contract.js";
import { arcRunControlsRpcContract } from "./control-contract.js";
import { arcInstructionUpdatesRpcContract } from "./instruction-update-contract.js";
import { arcRuleUpdatesRpcContract } from "./rule-update-contract.js";
import { arcAddressedFollowupsRpcContract } from "./addressed-continuation-contract.js";
import { teamDiagnosticSchema } from "../teams/contract.js";
import { orchestratedRunDefinitionSchema } from "./orchestrated-contract.js";
import { directoryRunDefinitionSchema } from "./directory-contract.js";
import {
  directorySetupRequestSchema,
  directorySetupSchema,
  projectRunSetupRequestSchema,
  projectRunSetupSchema,
} from "./source-contract.js";
import {
  gitOidSchema,
  runDefinitionSchema,
  runIdSchema,
  runRequestSchema,
  runtimeHashSchema,
  runtimeIdSchema,
} from "./definition.js";
export * from "./definition.js";

export const runReviewAuthoritySchema = z
  .object({
    state: z.enum(["authorized", "invalid", "legacy"]),
    diagnostics: z.array(teamDiagnosticSchema),
  })
  .strict();
export const runSummarySchema = z
  .object({
    runId: runIdSchema,
    projectId: runtimeIdSchema,
    goal: z.string(),
    planHash: runtimeHashSchema,
    createdAt: z.number(),
    workflowRunId: z.string().nullable(),
    submission: z.enum(["reserved", "submitted", "needs-reconciliation"]),
    submissionError: z.string().nullable(),
  })
  .strict();
export type ArcRunSummary = z.infer<typeof runSummarySchema>;

export const runViewSchema = z
  .object({
    summary: runSummarySchema,
    definition: z.union([
      runDefinitionSchema,
      graphRunDefinitionSchema,
      orchestratedRunDefinitionSchema,
      directoryRunDefinitionSchema,
    ]),
    workflow: ownedRunViewSchema.nullable(),
    verification: z.union([
      z
        .object({
          state: z.enum(["pending", "current", "stale", "unavailable"]),
          reason: z.string().nullable(),
          head: gitOidSchema.nullable(),
          workspacePath: z.string().nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("directory"),
          state: z.enum([
            "pending",
            "checking",
            "current",
            "stale",
            "unavailable",
          ]),
          reason: z.string().nullable(),
          snapshotId: runtimeIdSchema.nullable(),
          manifestDigest: runtimeHashSchema.nullable(),
          checkedAt: z.iso.datetime().nullable(),
          workspacePath: z.string().nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
export type ArcRunView = z.infer<typeof runViewSchema>;

export const runEffectViewSchema = z
  .object({
    effectId: z.string(),
    nodeId: z.string(),
    iteration: z.number(),
    attempt: z.number(),
    createdAt: z.number(),
    state: z.string(),
    resource: ownedStepResourceV2Schema.nullable(),
  })
  .strict();

export const arcRunsRpcContract = defineRpcContract({
  ...arcRunControlsRpcContract,
  ...arcInstructionUpdatesRpcContract,
  ...arcRuleUpdatesRpcContract,
  ...arcAddressedFollowupsRpcContract,
  getRunReviewAuthority: {
    input: z.object({ runId: runIdSchema }).strict(),
    output: runReviewAuthoritySchema,
  },
  getProjectRunSetup: {
    input: projectRunSetupRequestSchema,
    output: projectRunSetupSchema,
  },
  getDirectoryRunSetup: {
    input: directorySetupRequestSchema,
    output: directorySetupSchema,
  },
  startTeamRun: { input: graphRunRequestSchema, output: runViewSchema },
  discardTeamRunRequest: {
    input: graphRunRequestSchema,
    output: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("discarded"),
          operationId: runtimeIdSchema,
          requestHash: runtimeHashSchema,
        })
        .strict(),
      z.object({ state: z.literal("reserved"), run: runViewSchema }).strict(),
    ]),
  },
  getRunSetup: {
    input: z
      .object({
        projectId: runtimeIdSchema,
        hostId: runtimeIdSchema.nullable().default(null),
      })
      .strict(),
    output: z
      .object({
        sources: z.array(
          z.object({ hostId: z.string(), path: z.string() }).strict(),
        ),
        selected: z
          .object({
            hostId: z.string(),
            path: z.string(),
            head: gitOidSchema,
            clean: z.boolean(),
          })
          .strict(),
        threads: z.array(
          z.object({ id: z.string(), title: z.string().nullable() }).strict(),
        ),
      })
      .strict(),
  },
  startRun: { input: runRequestSchema, output: runViewSchema },
  getRun: {
    input: z.object({ runId: runIdSchema }).strict(),
    output: runViewSchema,
  },
  listRunEffects: {
    input: z
      .object({
        runId: runIdSchema,
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    output: z
      .object({ effects: z.array(runEffectViewSchema), total: z.number() })
      .strict(),
  },
  getRunEffect: {
    input: z.object({ runId: runIdSchema, effectId: runtimeIdSchema }).strict(),
    output: z
      .object({
        effect: runEffectViewSchema,
        observation: ownedStepObservationInputSchema.nullable(),
      })
      .strict(),
  },
  listRuns: {
    input: z
      .object({
        projectId: runtimeIdSchema,
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    output: z
      .object({
        runs: z.array(runSummarySchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  controlRun: {
    input: z
      .object({
        runId: runIdSchema,
        operationId: runtimeIdSchema,
        expectedVersion: z.number().int().nonnegative(),
        action: z.enum(["pause", "resume", "cancel"]),
      })
      .strict(),
    output: runViewSchema,
  },
});

export const reviewVerdictSchema = z
  .object({
    candidateHead: gitOidSchema,
    outcome: z.enum(["approved", "changes-requested"]),
    summary: z.string().trim().min(1).max(8000),
    findings: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            detail: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

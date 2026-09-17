import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { policyViewSchema, teamPinSchema } from "../policy/contract.js";
import { graphRunRequestSchema } from "../runtime/graph-contract.js";
import { directoryRunRequestSchema } from "../runtime/directory-contract.js";
import { directorySetupRequestSchema } from "../runtime/source-contract.js";
import {
  arcRunsRpcContract,
  gitOidSchema,
  runtimeIdSchema,
} from "../runtime/contract.js";

export const orchestratorTargetSchema = z
  .object({
    projectId: runtimeIdSchema,
    threadId: runtimeIdSchema,
  })
  .strict();

export const orchestratorContextRequestSchema = orchestratorTargetSchema.extend(
  {
    search: z.string().trim().max(200).default(""),
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().nonnegative().default(0),
  },
);

export const orchestratorSourceSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("directory"),
      hostId: runtimeIdSchema,
      path: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal("ready"),
      hostId: runtimeIdSchema,
      path: z.string(),
      head: gitOidSchema,
      clean: z.boolean(),
    })
    .strict(),
  z.object({ state: z.literal("unavailable"), reason: z.string() }).strict(),
]);

export const orchestratorTeamSchema = teamPinSchema.extend({
  latestRevision: z.number().int().positive(),
  preferred: z.boolean(),
  name: z.string(),
  description: z.string(),
  roles: z.array(z.string()),
  memberCount: z.number().int().nonnegative(),
  execution: z
    .object({ available: z.boolean(), blockers: z.array(z.string()) })
    .strict(),
});

export const arcOrchestratorRpcContract = defineRpcContract({
  requestDirectoryTeamRun: {
    input: directoryRunRequestSchema.omit({ invocation: true }),
    output: arcRunsRpcContract.startTeamRun.output,
  },
  discardDirectoryRunRequest: {
    input: directoryRunRequestSchema.omit({ invocation: true }),
    output: arcRunsRpcContract.discardTeamRunRequest.output,
  },
  reconcileOrchestratedRun: {
    input: z.object({ runId: runtimeIdSchema }).strict(),
    output: arcRunsRpcContract.startTeamRun.output,
  },
  requestTeamRun: {
    input: graphRunRequestSchema,
    output: arcRunsRpcContract.startTeamRun.output,
  },
  discardOrchestratedRunRequest: {
    input: graphRunRequestSchema,
    output: arcRunsRpcContract.discardTeamRunRequest.output,
  },
  getOrchestratorContext: {
    input: orchestratorContextRequestSchema,
    output: orchestratorTargetSchema.extend({
      policy: policyViewSchema,
      source: orchestratorSourceSchema,
      teams: z
        .object({
          versions: z.array(orchestratorTeamSchema),
          total: z.number().int().nonnegative(),
        })
        .strict(),
      runs: arcRunsRpcContract.listRuns.output,
    }),
  },
});

export const orchestratorToolRequestSchema = graphRunRequestSchema.omit({
  operationId: true,
  projectId: true,
  originThreadId: true,
});

export const orchestratorToolContextSchema =
  orchestratorContextRequestSchema.omit({ projectId: true, threadId: true });

export const directoryToolRequestSchema = directoryRunRequestSchema.omit({
  operationId: true,
  projectId: true,
  originThreadId: true,
  invocation: true,
});
export const directoryToolInspectionSchema = directorySetupRequestSchema
  .omit({ projectId: true, originThreadId: true })
  .extend({ operationId: runtimeIdSchema.nullable().default(null) });

export type OrchestratorContext = z.infer<
  typeof arcOrchestratorRpcContract.getOrchestratorContext.output
>;

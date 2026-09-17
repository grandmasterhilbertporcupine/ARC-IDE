import { defineRpcContract } from "@get-bb/plugin-sdk";
import { ownedRunLimitsSchema } from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import { agentExecutionSchema } from "../contract.js";
import {
  autonomySchema,
  resolvedRunPolicySchema,
  teamPinSchema,
} from "../policy/contract.js";
import {
  teamDefinitionSchema,
  teamGrantSchema,
  teamCheckCommandSchema,
} from "../teams/contract.js";
import {
  resolvedExecutionSchema,
  runIdSchema,
  runtimeHashSchema,
  runtimeIdSchema,
} from "./definition.js";
import {
  instructionUpdateApplicationSchema,
  instructionUpdatePreviewSchema,
} from "./instruction-update-contract.js";

const id = runtimeIdSchema;
const counter = z.number().int().nonnegative();
const impact = z.enum([
  "increases-authority",
  "reduces-authority",
  "mixed-authority",
  "behavior",
  "future-only",
]);
const node = { nodeId: id, label: z.string() };
const gate = teamDefinitionSchema.shape.graph.shape.requiredGates.element;
const presentation = teamDefinitionSchema.pick({
  name: true,
  description: true,
  groups: true,
  presentation: true,
});
const checkCommand = teamCheckCommandSchema;
const member = {
  memberId: id,
  agentId: id,
  name: z.string(),
  oldRevision: counter.min(1),
  newRevision: counter.min(1),
};
export const ruleChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("autonomy"),
      impact,
      before: autonomySchema,
      after: autonomySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("limits"),
      impact,
      before: ownedRunLimitsSchema,
      after: ownedRunLimitsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("restricted-teams"),
      impact,
      before: z.array(teamPinSchema).nullable(),
      after: z.array(teamPinSchema).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("preferred-teams"),
      impact,
      before: z.array(teamPinSchema),
      after: z.array(teamPinSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collaboration-grant"),
      impact,
      grantId: id,
      before: teamGrantSchema.nullable(),
      after: teamGrantSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delegation-roster"),
      impact,
      ...node,
      before: z.array(id),
      after: z.array(id),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-check"),
      impact,
      ...node,
      before: checkCommand,
      after: checkCommand,
    })
    .strict(),
  z
    .object({
      kind: z.literal("required-gate"),
      impact,
      gateId: id,
      before: gate.nullable(),
      after: gate.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("repair-ceiling"),
      impact,
      ...node,
      beforeNodeMaxRounds: counter,
      afterNodeMaxRounds: counter,
      beforeMaxRounds: counter,
      afterMaxRounds: counter,
    })
    .strict(),
  z
    .object({
      kind: z.literal("execution"),
      impact,
      ...member,
      before: z
        .object({
          configured: agentExecutionSchema,
          resolved: resolvedExecutionSchema,
        })
        .strict(),
      after: z
        .object({
          configured: agentExecutionSchema,
          resolved: resolvedExecutionSchema.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("instructions"),
      impact,
      ...member,
      before: z.string(),
      after: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("presentation"),
      impact,
      before: presentation,
      after: presentation,
    })
    .strict(),
]);
export type RuleChange = z.infer<typeof ruleChangeSchema>;
export const ruleBlockerSchema = z
  .object({
    code: z.enum([
      "unsupported-structure",
      "unsupported-agent-metadata",
      "team-restricted",
      "review-grant-required",
      "delegation-grant-required",
      "budget-below-usage",
      "repair-cap-below-usage",
      "invalid-team",
      "execution-unavailable",
      "run-not-active",
    ]),
    message: z.string(),
    nodeIds: z.array(id),
    memberIds: z.array(id),
  })
  .strict();
export type RuleBlocker = z.infer<typeof ruleBlockerSchema>;
const policy = z
  .object({
    projectVersion: counter,
    sessionVersion: counter,
    effective: resolvedRunPolicySchema,
  })
  .strict();
export const ruleReviewSchema = z
  .object({
    runId: runIdSchema,
    projectId: id,
    planHash: runtimeHashSchema,
    controlVersion: counter,
    oldTeam: instructionUpdatePreviewSchema.shape.oldTeam,
    newTeam: instructionUpdatePreviewSchema.shape.newTeam,
    oldPolicy: policy,
    newPolicy: policy,
    changes: z.array(ruleChangeSchema),
    affectedNodes: instructionUpdatePreviewSchema.shape.affectedNodes,
    repairStages: z.array(
      z
        .object({
          stageId: id,
          label: z.string(),
          beforeNodeMaxRounds: counter,
          afterNodeMaxRounds: counter,
          beforeMaxRounds: counter,
          afterMaxRounds: counter,
        })
        .strict(),
    ),
    usage: z
      .object({
        checkedAt: counter,
        agentCalls: counter,
        chargedActiveMs: counter,
        repairRounds: z.array(
          z.object({ stageId: id, rounds: counter }).strict(),
        ),
      })
      .strict(),
    source: instructionUpdatePreviewSchema.shape.source,
    createdAt: counter,
  })
  .strict();
export type RuleReview = z.infer<typeof ruleReviewSchema>;
export const ruleUpdatePreviewSchema = ruleReviewSchema
  .extend({
    kind: z.literal("rules"),
    schemaVersion: z.literal(1),
    previewId: id,
    previewHash: runtimeHashSchema,
    rerun: z.literal("entire-team-from-original"),
  })
  .superRefine((value, ctx) => {
    if (
      value.changes.some(
        (change) =>
          change.kind === "execution" && change.after.resolved === null,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Resolve every execution setting before applying rules",
        path: ["changes"],
      });
  });
export type RuleUpdatePreview = z.infer<typeof ruleUpdatePreviewSchema>;
export const ruleUpdatePreviewResultSchema = z.discriminatedUnion(
  "disposition",
  [
    z
      .object({
        disposition: z.literal("no-running-change"),
        review: ruleReviewSchema,
        reason: z.string(),
      })
      .strict(),
    z
      .object({
        disposition: z.literal("blocked"),
        review: ruleReviewSchema,
        blockers: z.array(ruleBlockerSchema).min(1),
      })
      .strict(),
    z
      .object({
        disposition: z.literal("restart"),
        preview: ruleUpdatePreviewSchema,
      })
      .strict(),
  ],
);
export type RuleUpdatePreviewResult = z.infer<
  typeof ruleUpdatePreviewResultSchema
>;
export const ruleUpdateApplicationSchema =
  instructionUpdateApplicationSchema.extend({
    preview: ruleUpdatePreviewSchema,
  });
export type RuleUpdateApplication = z.infer<typeof ruleUpdateApplicationSchema>;
export const runUpdatePreviewSchema = z.union([
  instructionUpdatePreviewSchema,
  ruleUpdatePreviewSchema,
]);
export type RunUpdatePreview = z.infer<typeof runUpdatePreviewSchema>;
export const runUpdateApplicationSchema = z.union([
  instructionUpdateApplicationSchema,
  ruleUpdateApplicationSchema,
]);
export type RunUpdateApplication = z.infer<typeof runUpdateApplicationSchema>;
export const runUpdateStateEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("instructions"),
      application: instructionUpdateApplicationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rules"),
      application: ruleUpdateApplicationSchema,
    })
    .strict(),
]);
export const runUpdateStateSchema = z
  .object({
    incoming: runUpdateStateEntrySchema.nullable(),
    outgoing: runUpdateStateEntrySchema.nullable(),
  })
  .strict();
export const arcRuleUpdatesRpcContract = defineRpcContract({
  previewRunRuleUpdate: {
    input: z
      .object({
        runId: runIdSchema,
        team: teamPinSchema,
        expectedProjectPolicyVersion: counter,
        expectedSessionPolicyVersion: counter,
      })
      .strict(),
    output: ruleUpdatePreviewResultSchema,
  },
  applyRunRuleUpdate: {
    input: z
      .object({
        operationId: id,
        previewId: id,
        previewHash: runtimeHashSchema,
      })
      .strict(),
    output: ruleUpdateApplicationSchema,
  },
  pollRunRuleUpdate: {
    input: z.object({ runId: runIdSchema, operationId: id }).strict(),
    output: ruleUpdateApplicationSchema,
  },
  cancelRunRuleUpdate: {
    input: z
      .object({
        runId: runIdSchema,
        operationId: id,
        previewId: id,
        previewHash: runtimeHashSchema,
      })
      .strict(),
    output: ruleUpdateApplicationSchema,
  },
  getRunUpdateState: {
    input: z.object({ runId: runIdSchema }).strict(),
    output: runUpdateStateSchema,
  },
});
export type RuleUpdateInput = z.infer<
  typeof arcRuleUpdatesRpcContract.previewRunRuleUpdate.input
>;

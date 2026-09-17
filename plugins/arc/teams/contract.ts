import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  agentExecutionSchema,
  agentScopeSchema,
  agentSkillReferencesSchema,
  proposalEvidenceSchema,
} from "../contract.js";

export const MAX_TEAM_NODES = 200;
export const MAX_TEAM_EDGES = 1000;
export const MAX_TEAM_MEMBERS = 100;
export const MAX_TEAM_DEFINITION_BYTES = 1024 * 1024;

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const teamId = z.string().regex(/^team_[a-f0-9-]{36}$/);
const agentId = z.string().regex(/^agent_[a-f0-9-]{36}$/);
const proposalId = z.string().regex(/^teamproposal_[a-f0-9-]{36}$/);
const revision = z.number().int().positive();
const label = z.string().trim().max(100);
const task = z.string().trim().max(16000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueIds = z.array(id).max(MAX_TEAM_NODES);

export const teamGroupSchema = z
  .object({
    id,
    name: label,
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    parentGroupId: id.nullable(),
  })
  .strict();

export const teamMemberSchema = z
  .object({
    id,
    agentId,
    revision,
    groupId: id.nullable(),
    role: label.optional(),
    responsibility: task.optional(),
    leaderMemberId: id.nullable().optional(),
    skills: agentSkillReferencesSchema.optional(),
    modelOverride: z
      .object({
        providerId: agentExecutionSchema.shape.providerId.unwrap(),
        model: agentExecutionSchema.shape.model.unwrap(),
        reasoningLevel: agentExecutionSchema.shape.reasoningLevel.unwrap(),
        serviceTier: agentExecutionSchema.shape.serviceTier.unwrap(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const teamGrantSchema = z
  .object({
    id,
    fromMemberId: id,
    toMemberId: id,
    action: z.enum(["delegate", "review", "message"]),
  })
  .strict();

export const teamConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("outcome"),
      sourceNodeId: id,
      equals: z.enum(["succeeded", "failed"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("check-exit"),
      sourceNodeId: id,
      operator: z.enum(["eq", "ne"]),
      value: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review-verdict"),
      sourceNodeId: id,
      equals: z.enum(["approved", "rejected"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval"),
      sourceNodeId: id,
      equals: z.enum(["approved", "rejected"]),
    })
    .strict(),
]);

const nodeBase = { id, label };
export const teamCheckCommandSchema = z
  .object({
    executable: z.string().trim().max(4096),
    args: z.array(z.string().max(16000)).max(100),
    timeoutMs: z.number().int().min(1000).max(3600000),
  })
  .strict();
export const teamCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source") }).strict(),
  z.object({ kind: z.literal("node"), nodeId: id }).strict(),
]);
export const teamNodeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...nodeBase,
      kind: z.literal("agent"),
      memberId: id,
      task,
      access: z.enum(["read", "write"]),
      candidate: teamCandidateSchema,
    })
    .strict(),
  z.object({ ...nodeBase, kind: z.literal("parallel") }).strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("join"),
      mode: z.enum(["all", "selected"]),
      decisionNodeId: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("check"),
      candidate: teamCandidateSchema,
      command: teamCheckCommandSchema,
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("review"),
      memberId: id,
      task,
      candidate: teamCandidateSchema,
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("condition"),
      predicate: teamConditionSchema,
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("repair"),
      body: z.object({ memberId: id, task }).strict(),
      checkNodeId: id,
      maxRounds: z.number().int().min(1).max(3),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("approval"),
      message: task,
      approver: z.literal("user"),
      candidate: teamCandidateSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("integration"),
      writerNodeIds: uniqueIds,
      baseCandidate: teamCandidateSchema,
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("release"),
      target: z.enum(["pull-request", "deploy"]),
      candidate: teamCandidateSchema,
      configurationRef: z.string().trim().min(1).max(200).nullable(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("delegation"),
      requesterMemberId: id,
      candidateMemberIds: z.array(id).max(MAX_TEAM_MEMBERS),
      task,
      access: z.enum(["read", "write"]),
      candidate: teamCandidateSchema,
      maxChildCalls: z.number().int().min(1).max(100),
    })
    .strict(),
]);

export const teamEdgeSchema = z
  .object({
    id,
    source: id,
    target: id,
    sourceHandle: z.enum(["next", "true", "false", "repaired", "exhausted"]),
    requiredOutcome: z.enum(["succeeded", "failed", "completed"]),
  })
  .strict();

export const teamDefinitionSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    name: label,
    description: z.string().trim().max(2000),
    leaderMemberId: id.nullable().optional(),
    groups: z.array(teamGroupSchema).max(100),
    members: z.array(teamMemberSchema).max(MAX_TEAM_MEMBERS),
    permissions: z.array(teamGrantSchema).max(1000),
    graph: z
      .object({
        nodes: z.array(teamNodeSchema).max(MAX_TEAM_NODES),
        edges: z.array(teamEdgeSchema).max(MAX_TEAM_EDGES),
        entryNodeIds: uniqueIds,
        requiredGates: z
          .array(
            z
              .object({ id, mode: z.enum(["all", "any"]), nodeIds: uniqueIds })
              .strict(),
          )
          .max(MAX_TEAM_NODES),
      })
      .strict(),
    presentation: z
      .object({
        color: z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .optional(),
        members: z
          .array(
            z
              .object({
                memberId: id,
                x: z.number().finite().min(-100000).max(100000),
                y: z.number().finite().min(-100000).max(100000),
              })
              .strict(),
          )
          .max(MAX_TEAM_MEMBERS)
          .optional(),
        nodes: z
          .array(
            z
              .object({
                nodeId: id,
                x: z.number().finite().min(-100000).max(100000),
                y: z.number().finite().min(-100000).max(100000),
              })
              .strict(),
          )
          .max(MAX_TEAM_NODES),
        groups: z
          .array(
            z
              .object({
                groupId: id,
                x: z.number().finite().min(-100000).max(100000),
                y: z.number().finite().min(-100000).max(100000),
                width: z.number().finite().min(1).max(100000),
                height: z.number().finite().min(1).max(100000),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  })
  .strict();

export const teamDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    nodeIds: z.array(id),
    path: z.string(),
  })
  .strict();

export const teamValidationSchema = z
  .object({
    valid: z.boolean(),
    diagnostics: z.array(teamDiagnosticSchema),
    execution: z
      .object({
        available: z.boolean(),
        blockers: z.array(teamDiagnosticSchema),
      })
      .strict(),
  })
  .strict();

export const teamDraftSchema = z
  .object({
    version: revision,
    baseRevision: revision.nullable(),
    definition: teamDefinitionSchema,
    contentHash: hash,
    operationalHash: hash,
    updatedAt: z.number(),
  })
  .strict();

export const teamSummarySchema = z
  .object({
    id: teamId,
    scope: agentScopeSchema,
    name: z.string(),
    description: z.string(),
    currentRevision: revision.nullable(),
    draftVersion: revision,
    hasUnpublishedChanges: z.boolean(),
    sourceTeamId: teamId.nullable(),
    sourceRevision: revision.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().nullable(),
  })
  .strict();

export const teamDetailSchema = teamSummarySchema.extend({
  draft: teamDraftSchema,
  validation: teamValidationSchema,
});
export const teamRevisionSchema = z
  .object({
    teamId,
    revision,
    definition: teamDefinitionSchema,
    contentHash: hash,
    operationalHash: hash,
    createdAt: z.number(),
  })
  .strict();
export const teamProposalSchema = z
  .object({
    id: proposalId,
    teamId,
    baseDraftVersion: revision,
    beforeDefinition: teamDefinitionSchema,
    definition: teamDefinitionSchema,
    summary: z.string().trim().min(1).max(2000),
    evidence: z.array(proposalEvidenceSchema).max(30),
    authorThreadId: z.string().nullable(),
    status: z.enum(["pending", "applied", "rejected"]),
    changedFields: z.array(z.string()),
    operationalChanges: z.boolean(),
    validation: teamValidationSchema,
    createdAt: z.number(),
    resolvedAt: z.number().nullable(),
  })
  .strict();

export const teamTargetSchema = z
  .object({ teamId, scope: agentScopeSchema })
  .strict();
export const teamDraftTargetSchema = teamTargetSchema.extend({
  expectedDraftVersion: revision,
});
const page = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
};
const teamOutput = z.object({ team: teamDetailSchema }).strict();
const proposalOutput = z.object({ proposal: teamProposalSchema }).strict();

export const arcTeamsRpcContract = defineRpcContract({
  listTeams: {
    input: z
      .object({
        scope: agentScopeSchema,
        search: z.string().trim().max(200).default(""),
        includeArchived: z.boolean().default(false),
        ...page,
      })
      .strict(),
    output: z
      .object({
        teams: z.array(teamSummarySchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getTeam: { input: teamTargetSchema, output: teamOutput },
  createTeam: {
    input: z
      .object({ scope: agentScopeSchema, definition: teamDefinitionSchema })
      .strict(),
    output: teamOutput,
  },
  saveTeamDraft: {
    input: teamDraftTargetSchema.extend({ definition: teamDefinitionSchema }),
    output: teamOutput,
  },
  validateTeamDraft: { input: teamTargetSchema, output: teamValidationSchema },
  publishTeamRevision: { input: teamDraftTargetSchema, output: teamOutput },
  restoreTeamRevision: {
    input: teamDraftTargetSchema.extend({ revision }),
    output: teamOutput,
  },
  copyTeamToProject: {
    input: teamTargetSchema.extend({
      revision,
      projectId: z.string().trim().min(1).max(200),
    }),
    output: teamOutput,
  },
  setTeamArchived: {
    input: teamDraftTargetSchema.extend({ archived: z.boolean() }),
    output: teamOutput,
  },
  listTeamRevisions: {
    input: teamTargetSchema.extend(page),
    output: z
      .object({
        revisions: z.array(teamRevisionSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getTeamRevision: {
    input: teamTargetSchema.extend({ revision }),
    output: z.object({ revision: teamRevisionSchema }).strict(),
  },
  proposeTeamDraft: {
    input: teamDraftTargetSchema.extend({
      definition: teamDefinitionSchema,
      summary: z.string().trim().min(1).max(2000),
      evidence: z.array(proposalEvidenceSchema).max(30).default([]),
    }),
    output: proposalOutput,
  },
  listTeamProposals: {
    input: teamTargetSchema.extend({
      status: z
        .enum(["pending", "applied", "rejected"])
        .nullable()
        .default(null),
      ...page,
    }),
    output: z
      .object({
        proposals: z.array(teamProposalSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getTeamProposal: {
    input: teamTargetSchema.extend({ proposalId }),
    output: proposalOutput,
  },
  applyTeamProposal: {
    input: teamDraftTargetSchema.extend({ proposalId }),
    output: teamOutput,
  },
  rejectTeamProposal: {
    input: teamDraftTargetSchema.extend({ proposalId }),
    output: proposalOutput,
  },
});

export const teamSessionSchema = z
  .object({
    executionContextId: z.string(),
    teamId,
    scope: agentScopeSchema,
    projectId: z.string(),
    draftVersion: revision,
    threadId: z.string().nullable(),
    createdAt: z.number(),
  })
  .strict();
export const arcTeamAssistantRpcContract = defineRpcContract({
  startTeamAssistant: {
    input: teamDraftTargetSchema.extend({
      projectId: z.string().trim().min(1).max(200),
      prompt: z.string().trim().min(1).max(100000),
    }),
    output: z
      .object({ threadId: z.string(), executionContextId: z.string() })
      .strict(),
  },
  listTeamSessions: {
    input: teamTargetSchema.extend(page),
    output: z
      .object({
        sessions: z.array(teamSessionSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
});

export type ArcTeamsRpcContract = typeof arcTeamsRpcContract;
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
export type TeamNode = z.infer<typeof teamNodeSchema>;
export type TeamEdge = z.infer<typeof teamEdgeSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamGroup = z.infer<typeof teamGroupSchema>;
export type TeamGrant = z.infer<typeof teamGrantSchema>;
export type TeamDetail = z.infer<typeof teamDetailSchema>;
export type TeamSummary = z.infer<typeof teamSummarySchema>;
export type TeamRevision = z.infer<typeof teamRevisionSchema>;
export type TeamProposal = z.infer<typeof teamProposalSchema>;
export type TeamValidation = z.infer<typeof teamValidationSchema>;
export type TeamDiagnostic = z.infer<typeof teamDiagnosticSchema>;
export type TeamTarget = z.infer<typeof teamTargetSchema>;
export type TeamDraftTarget = z.infer<typeof teamDraftTargetSchema>;
export type ArcTeamAssistantRpcContract = typeof arcTeamAssistantRpcContract;
export type TeamSession = z.infer<typeof teamSessionSchema>;

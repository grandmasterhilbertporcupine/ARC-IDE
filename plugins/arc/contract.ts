import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  agentSkillReferenceSchema,
  agentSkillReferencesSchema,
  agentSkillBundleSchema,
  agentSkillFilesSchema,
  skillAuthoringFieldsSchema,
} from "./skill-contract.js";
export {
  agentSkillReferenceSchema,
  agentSkillReferencesSchema,
  type AgentSkillReference,
  type AgentSkillBundle,
} from "./skill-contract.js";

export const ARC_PLUGIN_ID = "arc";
export const MAX_AGENT_DOCUMENT_CHARS = 65_536;
export const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_AGENT_ATTACHMENT_COUNT = 32;
export const MAX_AGENT_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;

const nullableSelection = z.string().trim().min(1).max(200).nullable();
export const agentExecutionSchema = z
  .object({
    providerId: nullableSelection,
    model: nullableSelection,
    reasoningLevel: z
      .enum([
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "ultracode",
        "max",
        "ultra",
      ])
      .nullable(),
    serviceTier: z.enum(["default", "fast"]).nullable(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).nullable(),
  })
  .strict()
  .refine(
    (value) => (value.providerId === null) === (value.model === null),
    "Choose both a provider and a model, or inherit both",
  );

export const agentMetadataSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    skills: agentSkillReferencesSchema.optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500),
    specialty: z.string().trim().max(100),
    role: z.string().trim().max(100),
    execution: agentExecutionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.schemaVersion === 1 && value.skills !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Skill assignments require agent schema version 2",
      });
    if (value.schemaVersion === 2 && value.skills === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Agent schema version 2 requires skills",
      });
  });

export const agentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentMetadata = z.infer<typeof agentMetadataSchema>;

const agentIdSchema = z.string().regex(/^agent_[a-f0-9-]{36}$/);
const attachmentIdSchema = z.string().regex(/^file_[a-f0-9-]{36}$/);
const proposalIdSchema = z.string().regex(/^proposal_[a-f0-9-]{36}$/);
const documentSchema = z.string().min(1).max(MAX_AGENT_DOCUMENT_CHARS);
const revisionNumberSchema = z.number().int().positive();
const attachmentIdsSchema = z
  .array(attachmentIdSchema)
  .max(MAX_AGENT_ATTACHMENT_COUNT)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Attachment references must be unique",
  );

export const agentAttachmentSchema = z
  .object({
    id: attachmentIdSchema,
    agentId: agentIdSchema,
    name: z.string(),
    mimeType: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.number(),
  })
  .strict();
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>;

export const agentDraftSchema = z
  .object({
    version: revisionNumberSchema,
    baseRevision: revisionNumberSchema.nullable(),
    document: documentSchema,
    metadata: agentMetadataSchema,
    attachments: z.array(agentAttachmentSchema),
    contentHash: z.string(),
    updatedAt: z.number(),
  })
  .strict();

export const agentSummarySchema = z
  .object({
    id: agentIdSchema,
    scope: agentScopeSchema,
    name: z.string(),
    description: z.string(),
    specialty: z.string(),
    role: z.string(),
    currentRevision: revisionNumberSchema.nullable(),
    draftVersion: revisionNumberSchema,
    hasUnpublishedChanges: z.boolean(),
    sourceAgentId: agentIdSchema.nullable(),
    sourceRevision: revisionNumberSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().nullable(),
  })
  .strict();

export const agentDetailSchema = agentSummarySchema.extend({
  draft: agentDraftSchema,
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentRevisionSchema = z
  .object({
    agentId: agentIdSchema,
    revision: revisionNumberSchema,
    document: documentSchema,
    metadata: agentMetadataSchema,
    attachments: z.array(agentAttachmentSchema),
    contentHash: z.string(),
    createdAt: z.number(),
  })
  .strict();
export type AgentRevision = z.infer<typeof agentRevisionSchema>;

export const proposalEvidenceSchema = z
  .object({
    source: z.string().trim().min(1).max(500),
    detail: z.string().trim().min(1).max(2_000),
  })
  .strict();
export const agentProposalSchema = z
  .object({
    id: proposalIdSchema,
    agentId: agentIdSchema,
    baseDraftVersion: revisionNumberSchema,
    beforeDocument: documentSchema,
    document: documentSchema,
    summary: z.string(),
    evidence: z.array(proposalEvidenceSchema),
    authorThreadId: z.string().nullable(),
    status: z.enum(["pending", "applied", "rejected"]),
    changedFields: z.array(z.string()),
    operationalChanges: z.array(z.string()),
    createdAt: z.number(),
    resolvedAt: z.number().nullable(),
  })
  .strict();
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export const agentTargetSchema = z
  .object({ agentId: agentIdSchema, scope: agentScopeSchema })
  .strict();
export const agentDraftTargetSchema = agentTargetSchema.extend({
  expectedDraftVersion: revisionNumberSchema,
});
const agentOutput = z.object({ agent: agentDetailSchema }).strict();
export const agentSessionSchema = z
  .object({
    executionContextId: z.string(),
    threadId: z.string().nullable(),
    projectId: z.string(),
    purpose: z.enum(["assistant", "test"]),
    revision: revisionNumberSchema.nullable(),
    draftVersion: revisionNumberSchema,
    createdAt: z.number(),
  })
  .strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;
const launchFields = {
  projectId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
};
const sessionOutput = z
  .object({ threadId: z.string(), executionContextId: z.string() })
  .strict();

export const arcAgentsRpcContract = defineRpcContract({
  parseAgentSkillMarkdown: {
    input: z.object({ markdown: z.string().max(1000000) }).strict(),
    output: z.object({ fields: skillAuthoringFieldsSchema }).strict(),
  },
  renderAgentSkillMarkdown: {
    input: z
      .object({
        markdown: z.string().max(1000000),
        fields: skillAuthoringFieldsSchema,
      })
      .strict(),
    output: z.object({ markdown: z.string().max(1000000) }).strict(),
  },
  saveAgentSkillBundle: {
    input: z.object({ files: agentSkillFilesSchema }).strict(),
    output: z.object({ skill: agentSkillBundleSchema }).strict(),
  },
  readAgentSkillBundle: {
    input: z.object({ id: agentSkillReferenceSchema.shape.id }).strict(),
    output: z.object({ skill: agentSkillBundleSchema }).strict(),
  },
  listAssignedSkillCatalog: {
    input: z
      .object({
        projectId: z.string().min(1),
        environmentId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z
      .object({
        skills: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable(),
              scope: z.string(),
              provider: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  importInstalledAgentSkill: {
    input: z
      .object({
        projectId: z.string().min(1),
        environmentId: z.string().min(1).nullable(),
        skillId: z.string().min(1),
      })
      .strict(),
    output: z.object({ skill: agentSkillBundleSchema }).strict(),
  },
  startAgentAssistant: {
    input: agentDraftTargetSchema.extend(launchFields),
    output: sessionOutput,
  },
  startAgentTest: {
    input: agentTargetSchema.extend({
      ...launchFields,
      revision: revisionNumberSchema,
    }),
    output: sessionOutput,
  },
  listAgentSessions: {
    input: agentTargetSchema.extend({
      purpose: z.enum(["assistant", "test"]).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    }),
    output: z
      .object({
        sessions: z.array(agentSessionSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  listStudioProjects: {
    input: z.null(),
    output: z
      .object({
        projects: z.array(
          z.object({ id: z.string(), name: z.string() }).strict(),
        ),
        personalProjectId: z.string().nullable(),
      })
      .strict(),
  },
  listAgents: {
    input: z
      .object({
        scope: agentScopeSchema,
        search: z.string().trim().max(200).default(""),
        includeArchived: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    output: z
      .object({
        agents: z.array(agentSummarySchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getAgent: { input: agentTargetSchema, output: agentOutput },
  createAgent: {
    input: z
      .object({ scope: agentScopeSchema, document: documentSchema })
      .strict(),
    output: agentOutput,
  },
  saveAgentDraft: {
    input: agentDraftTargetSchema.extend({
      document: documentSchema,
      attachmentIds: attachmentIdsSchema,
    }),
    output: agentOutput,
  },
  publishAgentRevision: { input: agentDraftTargetSchema, output: agentOutput },
  restoreAgentRevision: {
    input: agentDraftTargetSchema.extend({ revision: revisionNumberSchema }),
    output: agentOutput,
  },
  copyAgentToProject: {
    input: agentTargetSchema.extend({
      revision: revisionNumberSchema,
      projectId: z.string().trim().min(1).max(200),
    }),
    output: agentOutput,
  },
  setAgentArchived: {
    input: agentDraftTargetSchema.extend({ archived: z.boolean() }),
    output: agentOutput,
  },
  listAgentRevisions: {
    input: agentTargetSchema.extend({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    }),
    output: z
      .object({
        revisions: z.array(agentRevisionSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getAgentRevision: {
    input: agentTargetSchema.extend({ revision: revisionNumberSchema }),
    output: z.object({ revision: agentRevisionSchema }).strict(),
  },
  addAgentAttachment: {
    input: agentDraftTargetSchema.extend({
      name: z.string().trim().min(1).max(255),
      mimeType: z.string().trim().min(1).max(200),
      contentBase64: z
        .string()
        .max(Math.ceil(MAX_AGENT_ATTACHMENT_BYTES / 3) * 4),
    }),
    output: agentOutput,
  },
  readAgentAttachment: {
    input: agentTargetSchema.extend({ attachmentId: attachmentIdSchema }),
    output: z
      .object({ attachment: agentAttachmentSchema, contentBase64: z.string() })
      .strict(),
  },
  proposeAgentDraft: {
    input: agentDraftTargetSchema.extend({
      document: documentSchema,
      summary: z.string().trim().min(1).max(2_000),
      evidence: z.array(proposalEvidenceSchema).max(20).default([]),
    }),
    output: z.object({ proposal: agentProposalSchema }).strict(),
  },
  listAgentProposals: {
    input: agentTargetSchema.extend({
      status: z
        .enum(["pending", "applied", "rejected"])
        .nullable()
        .default(null),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().nonnegative().default(0),
    }),
    output: z
      .object({
        proposals: z.array(agentProposalSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
  getAgentProposal: {
    input: agentTargetSchema.extend({ proposalId: proposalIdSchema }),
    output: z.object({ proposal: agentProposalSchema }).strict(),
  },
  applyAgentProposal: {
    input: agentDraftTargetSchema.extend({
      proposalId: proposalIdSchema,
      confirmOperationalChanges: z.boolean().default(false),
    }),
    output: agentOutput,
  },
  rejectAgentProposal: {
    input: agentTargetSchema.extend({ proposalId: proposalIdSchema }),
    output: z.object({ proposal: agentProposalSchema }).strict(),
  },
});

export type ArcAgentsRpcContract = typeof arcAgentsRpcContract;

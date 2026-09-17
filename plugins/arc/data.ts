import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createAssignedSkillStore } from "./assigned-skills.js";
import {
  agentMetadataSchema,
  agentProposalSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  MAX_AGENT_ATTACHMENT_COUNT,
  MAX_AGENT_ATTACHMENT_TOTAL_BYTES,
  type AgentAttachment,
  type AgentDetail,
  type AgentProposal,
  type AgentRevision,
  type AgentScope,
  type AgentSummary,
} from "./contract.js";
import {
  describeAgentDocumentChanges,
  parseAgentDocument,
} from "./document.js";

export class AgentStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentStoreError";
  }
}

export const migrations = [
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('library', 'project')),
    project_id TEXT,
    current_revision INTEGER,
    source_agent_id TEXT REFERENCES agents(id),
    source_revision INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    CHECK((scope_kind = 'library' AND project_id IS NULL) OR (scope_kind = 'project' AND project_id IS NOT NULL))
  )`,
  `CREATE TABLE agent_drafts (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    version INTEGER NOT NULL CHECK(version > 0),
    base_revision INTEGER,
    document TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE agent_revisions (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    document TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, revision)
  )`,
  `CREATE TABLE agent_attachment_blobs (
    sha256 TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    size_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE agent_attachments (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES agent_attachment_blobs(sha256),
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE agent_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    base_draft_version INTEGER NOT NULL,
    before_document TEXT NOT NULL,
    document TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    author_thread_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  "CREATE INDEX agents_by_scope ON agents(scope_kind, project_id, updated_at DESC)",
  "CREATE INDEX agent_attachments_by_agent ON agent_attachments(agent_id)",
  "CREATE INDEX agent_proposals_by_agent ON agent_proposals(agent_id, status, created_at DESC)",
  `CREATE TABLE agent_execution_contexts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    scope_json TEXT NOT NULL,
    project_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('assistant', 'test')),
    revision INTEGER,
    draft_version INTEGER NOT NULL,
    document TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    thread_id TEXT UNIQUE
  )`,
  "CREATE INDEX agent_execution_contexts_by_agent ON agent_execution_contexts(agent_id, purpose, created_at DESC)",
];

interface StoredAgent {
  id: string;
  scopeKind: "library" | "project";
  projectId: string | null;
  currentRevision: number | null;
  sourceAgentId: string | null;
  sourceRevision: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  draftVersion: number;
  baseRevision: number | null;
  document: string;
  metadataJson: string;
  attachmentIdsJson: string;
  contentHash: string;
  draftUpdatedAt: number;
  publishedHash: string | null;
}

interface StoredRevision {
  agentId: string;
  revision: number;
  document: string;
  attachmentIdsJson: string;
  contentHash: string;
  createdAt: number;
}

interface StoredProposal {
  id: string;
  agentId: string;
  baseDraftVersion: number;
  beforeDocument: string;
  document: string;
  summary: string;
  evidenceJson: string;
  authorThreadId: string | null;
  status: "pending" | "applied" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
}

interface AgentTarget {
  agentId: string;
  scope: AgentScope;
}

interface DraftTarget extends AgentTarget {
  expectedDraftVersion: number;
}

const AGENT_SELECT = `SELECT a.id, a.scope_kind AS scopeKind, a.project_id AS projectId,
  a.current_revision AS currentRevision, a.source_agent_id AS sourceAgentId,
  a.source_revision AS sourceRevision, a.created_at AS createdAt, a.updated_at AS updatedAt,
  a.archived_at AS archivedAt, d.version AS draftVersion, d.base_revision AS baseRevision,
  d.document, d.metadata_json AS metadataJson, d.attachment_ids_json AS attachmentIdsJson,
  d.content_hash AS contentHash, d.updated_at AS draftUpdatedAt, r.content_hash AS publishedHash
  FROM agents a JOIN agent_drafts d ON d.agent_id = a.id
  LEFT JOIN agent_revisions r ON r.agent_id = a.id AND r.revision = a.current_revision`;

const REVISION_SELECT = `SELECT agent_id AS agentId, revision, document,
  attachment_ids_json AS attachmentIdsJson, content_hash AS contentHash, created_at AS createdAt
  FROM agent_revisions`;

const ATTACHMENT_SELECT = `SELECT id, agent_id AS agentId, name, mime_type AS mimeType,
  sha256, size_bytes AS sizeBytes, created_at AS createdAt FROM agent_attachments`;

const PROPOSAL_SELECT = `SELECT id, agent_id AS agentId, base_draft_version AS baseDraftVersion,
  before_document AS beforeDocument, document, summary, evidence_json AS evidenceJson,
  author_thread_id AS authorThreadId, status, created_at AS createdAt, resolved_at AS resolvedAt
  FROM agent_proposals`;

function scopeProject(scope: AgentScope): string | null {
  return scope.kind === "project" ? scope.projectId : null;
}

function decodeJson(value: string): unknown {
  return JSON.parse(value);
}

function fileIds(value: string): string[] {
  return z.array(z.string()).parse(decodeJson(value));
}

function summary(row: StoredAgent): AgentSummary {
  const metadata = agentMetadataSchema.parse(decodeJson(row.metadataJson));
  if (row.scopeKind === "project" && row.projectId === null)
    throw new Error("Project agent is missing its project reference");
  return {
    id: row.id,
    scope:
      row.projectId === null
        ? { kind: "library" }
        : { kind: "project", projectId: row.projectId },
    name: metadata.name,
    description: metadata.description,
    specialty: metadata.specialty,
    role: metadata.role,
    currentRevision: row.currentRevision,
    draftVersion: row.draftVersion,
    hasUnpublishedChanges: row.publishedHash !== row.contentHash,
    sourceAgentId: row.sourceAgentId,
    sourceRevision: row.sourceRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

function validFileName(name: string): string {
  const normalized = name.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(normalized) ||
    /[. ]$/u.test(normalized) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new AgentStoreError(
      "invalid_filename",
      "Use a filename without paths, reserved characters, or Windows device names",
    );
  }
  return normalized;
}

function contentHash(
  document: string,
  attachments: readonly AgentAttachment[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        document,
        attachments: attachments.map(
          ({ name, mimeType, sha256, sizeBytes }) => ({
            name,
            mimeType,
            sha256,
            sizeBytes,
          }),
        ),
      }),
    )
    .digest("hex");
}

export function createAgentStore(db: Database.Database) {
  const assignedSkills = createAssignedSkillStore(db);
  db.pragma("foreign_keys = ON");

  function requireRow(target: AgentTarget): StoredAgent {
    const row = db
      .prepare<[string, string, string | null], StoredAgent>(
        `${AGENT_SELECT} WHERE a.id = ? AND a.scope_kind = ? AND a.project_id IS ?`,
      )
      .get(target.agentId, target.scope.kind, scopeProject(target.scope));
    if (!row)
      throw new AgentStoreError(
        "agent_not_found",
        "Agent is not available in this scope",
      );
    return row;
  }

  function requireWritable(target: DraftTarget): StoredAgent {
    const row = requireRow(target);
    if (row.archivedAt !== null)
      throw new AgentStoreError(
        "agent_archived",
        "Restore this agent before editing it",
      );
    if (row.draftVersion !== target.expectedDraftVersion)
      throw new AgentStoreError(
        "draft_conflict",
        `Draft changed; reload version ${row.draftVersion} before applying this edit`,
      );
    return row;
  }

  function attachmentsFor(
    agentId: string,
    ids: readonly string[],
  ): AgentAttachment[] {
    if (
      ids.length > MAX_AGENT_ATTACHMENT_COUNT ||
      new Set(ids).size !== ids.length
    )
      throw new AgentStoreError(
        "invalid_manifest",
        "Attachment manifest exceeds its limit or contains duplicate references",
      );
    const read = db.prepare<[string, string], AgentAttachment>(
      `${ATTACHMENT_SELECT} WHERE id = ? AND agent_id = ?`,
    );
    const attachments = ids.map((id) => {
      const file = read.get(id, agentId);
      if (!file)
        throw new AgentStoreError(
          "attachment_not_found",
          "An attachment is not owned by this agent",
        );
      return file;
    });
    if (
      attachments.reduce((total, file) => total + file.sizeBytes, 0) >
      MAX_AGENT_ATTACHMENT_TOTAL_BYTES
    )
      throw new AgentStoreError(
        "attachment_limit",
        "An agent's reference files cannot exceed 100 MB",
      );
    const names = attachments.map((file) =>
      file.name.toLocaleLowerCase("en-US"),
    );
    if (new Set(names).size !== names.length)
      throw new AgentStoreError(
        "duplicate_filename",
        "Reference filenames must be unique",
      );
    return attachments;
  }

  function detail(row: StoredAgent): AgentDetail {
    return {
      ...summary(row),
      draft: {
        version: row.draftVersion,
        baseRevision: row.baseRevision,
        document: row.document,
        metadata: agentMetadataSchema.parse(decodeJson(row.metadataJson)),
        attachments: attachmentsFor(row.id, fileIds(row.attachmentIdsJson)),
        contentHash: row.contentHash,
        updatedAt: row.draftUpdatedAt,
      },
    };
  }

  function getAgent(target: AgentTarget): AgentDetail {
    return detail(requireRow(target));
  }

  function getRevision(
    target: AgentTarget & { revision: number },
  ): AgentRevision {
    requireRow(target);
    const row = db
      .prepare<[string, number], StoredRevision>(
        `${REVISION_SELECT} WHERE agent_id = ? AND revision = ?`,
      )
      .get(target.agentId, target.revision);
    if (!row)
      throw new AgentStoreError(
        "revision_not_found",
        "Agent revision does not exist",
      );
    return {
      agentId: row.agentId,
      revision: row.revision,
      document: row.document,
      metadata: parseAgentDocument(row.document).metadata,
      attachments: attachmentsFor(row.agentId, fileIds(row.attachmentIdsJson)),
      contentHash: row.contentHash,
      createdAt: row.createdAt,
    };
  }

  function createAgent(input: {
    scope: AgentScope;
    document: string;
    sourceAgentId?: string;
    sourceRevision?: number;
  }): AgentDetail {
    return db.transaction(() => {
      const parsed = parseAgentDocument(input.document);
      assignedSkills.resolve(parsed.metadata.skills ?? []);
      const id = `agent_${randomUUID()}`;
      const now = Date.now();
      db.prepare(`INSERT INTO agents (id, scope_kind, project_id, source_agent_id, source_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.scope.kind,
        scopeProject(input.scope),
        input.sourceAgentId ?? null,
        input.sourceRevision ?? null,
        now,
        now,
      );
      db.prepare(`INSERT INTO agent_drafts (agent_id, version, document, metadata_json, attachment_ids_json, content_hash, updated_at)
        VALUES (?, 1, ?, ?, '[]', ?, ?)`).run(
        id,
        parsed.document,
        JSON.stringify(parsed.metadata),
        contentHash(parsed.document, []),
        now,
      );
      return getAgent({ agentId: id, scope: input.scope });
    })();
  }

  function writeDraft(
    row: StoredAgent,
    document: string,
    attachmentIds: string[],
  ): void {
    const parsed = parseAgentDocument(document);
    assignedSkills.resolve(parsed.metadata.skills ?? []);
    const files = attachmentsFor(row.id, attachmentIds);
    const hash = contentHash(parsed.document, files);
    if (hash === row.contentHash) return;
    const now = Date.now();
    db.prepare(`UPDATE agent_drafts SET version = version + 1, document = ?, metadata_json = ?,
      attachment_ids_json = ?, content_hash = ?, updated_at = ? WHERE agent_id = ?`).run(
      parsed.document,
      JSON.stringify(parsed.metadata),
      JSON.stringify(attachmentIds),
      hash,
      now,
      row.id,
    );
    db.prepare("UPDATE agents SET updated_at = ? WHERE id = ?").run(
      now,
      row.id,
    );
  }

  function saveDraft(
    input: DraftTarget & { document: string; attachmentIds: string[] },
  ): AgentDetail {
    return db.transaction(() => {
      writeDraft(requireWritable(input), input.document, input.attachmentIds);
      return getAgent(input);
    })();
  }

  function publish(input: DraftTarget): AgentDetail {
    return db.transaction(() => {
      const row = requireWritable(input);
      assignedSkills.resolve(
        parseAgentDocument(row.document).metadata.skills ?? [],
      );
      if (!parseAgentDocument(row.document).body.trim())
        throw new AgentStoreError(
          "instructions_required",
          "Add instructions before publishing this agent",
        );
      if (row.publishedHash === row.contentHash) return detail(row);
      const revision = (row.currentRevision ?? 0) + 1;
      const now = Date.now();
      db.prepare(`INSERT INTO agent_revisions (agent_id, revision, document, attachment_ids_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        row.id,
        revision,
        row.document,
        row.attachmentIdsJson,
        row.contentHash,
        now,
      );
      db.prepare(
        "UPDATE agents SET current_revision = ?, updated_at = ? WHERE id = ?",
      ).run(revision, now, row.id);
      db.prepare(
        "UPDATE agent_drafts SET base_revision = ?, version = version + 1, updated_at = ? WHERE agent_id = ?",
      ).run(revision, now, row.id);
      return getAgent(input);
    })();
  }

  function proposalView(row: StoredProposal): AgentProposal {
    const { evidenceJson, ...values } = row;
    return agentProposalSchema.parse({
      ...values,
      evidence: decodeJson(evidenceJson),
      ...describeAgentDocumentChanges(row.beforeDocument, row.document),
    });
  }

  function getProposal(
    input: AgentTarget & { proposalId: string },
  ): AgentProposal {
    requireRow(input);
    const row = db
      .prepare<[string, string], StoredProposal>(
        `${PROPOSAL_SELECT} WHERE id = ? AND agent_id = ?`,
      )
      .get(input.proposalId, input.agentId);
    if (!row)
      throw new AgentStoreError(
        "proposal_not_found",
        "Proposal is not available for this agent",
      );
    return proposalView(row);
  }

  return {
    getAttachment(
      input: AgentTarget & { attachmentId: string },
    ): AgentAttachment {
      requireRow(input);
      const attachment = attachmentsFor(input.agentId, [input.attachmentId])[0];
      if (!attachment)
        throw new AgentStoreError(
          "attachment_not_found",
          "Reference file does not exist",
        );
      return attachment;
    },
    assignedSkills,
    getAgent,
    createAgent,
    saveDraft,
    publish,
    getRevision,
    getProposal,
    listAgents(input: {
      scope: AgentScope;
      search: string;
      includeArchived: boolean;
      limit: number;
      offset: number;
    }) {
      const where =
        "a.scope_kind = ? AND a.project_id IS ? AND (? = 1 OR a.archived_at IS NULL) AND (? = '' OR d.metadata_json LIKE ? ESCAPE '\\')";
      const search = input.search.replace(/[\\%_]/g, "\\$&");
      const args = [
        input.scope.kind,
        scopeProject(input.scope),
        Number(input.includeArchived),
        input.search,
        `%${search}%`,
      ];
      const rows = db
        .prepare<Array<string | number | null>, StoredAgent>(
          `${AGENT_SELECT} WHERE ${where} ORDER BY a.updated_at DESC, a.id LIMIT ? OFFSET ?`,
        )
        .all(...args, input.limit, input.offset);
      const total =
        db
          .prepare<Array<string | number | null>, { total: number }>(
            `SELECT count(*) AS total FROM agents a JOIN agent_drafts d ON d.agent_id = a.id WHERE ${where}`,
          )
          .get(...args)?.total ?? 0;
      return { agents: rows.map(summary), total };
    },
    listRevisions(input: AgentTarget & { limit: number; offset: number }) {
      requireRow(input);
      const rows = db
        .prepare<[string, number, number], { revision: number }>(
          "SELECT revision FROM agent_revisions WHERE agent_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?",
        )
        .all(input.agentId, input.limit, input.offset);
      const total =
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM agent_revisions WHERE agent_id = ?",
          )
          .get(input.agentId)?.total ?? 0;
      return {
        revisions: rows.map(({ revision }) =>
          getRevision({ ...input, revision }),
        ),
        total,
      };
    },
    restore(input: DraftTarget & { revision: number }): AgentDetail {
      return db.transaction(() => {
        const row = requireWritable(input);
        const revision = getRevision(input);
        writeDraft(
          row,
          revision.document,
          revision.attachments.map((file) => file.id),
        );
        const draft = getAgent(input);
        return publish({ ...input, expectedDraftVersion: draft.draft.version });
      })();
    },
    copyToProject(
      input: AgentTarget & { revision: number; projectId: string },
    ): AgentDetail {
      return db.transaction(() => {
        const source = getRevision(input);
        const scope: AgentScope = {
          kind: "project",
          projectId: input.projectId,
        };
        const created = createAgent({
          scope,
          document: source.document,
          sourceAgentId: source.agentId,
          sourceRevision: source.revision,
        });
        const ids = source.attachments.map((file) => {
          const id = `file_${randomUUID()}`;
          db.prepare(
            "INSERT INTO agent_attachments (id, agent_id, name, mime_type, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            created.id,
            file.name,
            file.mimeType,
            file.sha256,
            file.sizeBytes,
            Date.now(),
          );
          return id;
        });
        const target = { agentId: created.id, scope };
        const draft = saveDraft({
          ...target,
          expectedDraftVersion: created.draft.version,
          document: created.draft.document,
          attachmentIds: ids,
        });
        return publish({
          ...target,
          expectedDraftVersion: draft.draft.version,
        });
      })();
    },
    setArchived(input: DraftTarget & { archived: boolean }): AgentDetail {
      return db.transaction(() => {
        const row = requireRow(input);
        if (row.draftVersion !== input.expectedDraftVersion)
          throw new AgentStoreError(
            "draft_conflict",
            "Draft changed; reload before changing archive state",
          );
        if ((row.archivedAt !== null) === input.archived) return detail(row);
        const now = Date.now();
        db.prepare(
          "UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ?",
        ).run(input.archived ? now : null, now, row.id);
        db.prepare(
          "UPDATE agent_drafts SET version = version + 1, updated_at = ? WHERE agent_id = ?",
        ).run(now, row.id);
        return getAgent(input);
      })();
    },
    addAttachment(
      input: DraftTarget & {
        name: string;
        mimeType: string;
        content: Uint8Array;
      },
    ): AgentDetail {
      return db.transaction(() => {
        const row = requireWritable(input);
        const name = validFileName(input.name);
        if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(input.mimeType))
          throw new AgentStoreError(
            "invalid_mime",
            "Attachment MIME type is invalid",
          );
        if (input.content.byteLength > MAX_AGENT_ATTACHMENT_BYTES)
          throw new AgentStoreError(
            "attachment_limit",
            "Each reference file must be 25 MB or smaller",
          );
        const existing = attachmentsFor(row.id, fileIds(row.attachmentIdsJson));
        const previous = existing.find(
          (file) =>
            file.name.toLocaleLowerCase("en-US") ===
            name.toLocaleLowerCase("en-US"),
        );
        const sha256 = createHash("sha256").update(input.content).digest("hex");
        if (
          previous?.sha256 === sha256 &&
          previous.name === name &&
          previous.mimeType === input.mimeType
        )
          return detail(row);
        const id = `file_${randomUUID()}`;
        const ids = previous
          ? existing.map((file) => (file.id === previous.id ? id : file.id))
          : [...existing.map((file) => file.id), id];
        if (ids.length > MAX_AGENT_ATTACHMENT_COUNT)
          throw new AgentStoreError(
            "attachment_limit",
            "An agent can have at most 32 reference files",
          );
        db.prepare(
          "INSERT OR IGNORE INTO agent_attachment_blobs (sha256, content, size_bytes) VALUES (?, ?, ?)",
        ).run(sha256, Buffer.from(input.content), input.content.byteLength);
        db.prepare(
          "INSERT INTO agent_attachments (id, agent_id, name, mime_type, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          row.id,
          name,
          input.mimeType,
          sha256,
          input.content.byteLength,
          Date.now(),
        );
        writeDraft(row, row.document, ids);
        return getAgent(input);
      })();
    },
    readAttachment(input: AgentTarget & { attachmentId: string }): {
      attachment: AgentAttachment;
      content: Uint8Array;
    } {
      requireRow(input);
      const attachment = attachmentsFor(input.agentId, [input.attachmentId])[0];
      if (!attachment)
        throw new AgentStoreError(
          "attachment_not_found",
          "Reference file does not exist",
        );
      const blob = db
        .prepare<[string], { content: Buffer }>(
          "SELECT content FROM agent_attachment_blobs WHERE sha256 = ?",
        )
        .get(attachment.sha256);
      if (
        !blob ||
        createHash("sha256").update(blob.content).digest("hex") !==
          attachment.sha256
      )
        throw new AgentStoreError(
          "attachment_corrupt",
          "Reference file bytes failed their integrity check",
        );
      return { attachment, content: blob.content };
    },
    propose(
      input: DraftTarget & {
        document: string;
        summary: string;
        evidence: AgentProposal["evidence"];
        authorThreadId: string | null;
      },
    ): AgentProposal {
      return db.transaction(() => {
        const row = requireWritable(input);
        const document = parseAgentDocument(input.document).document;
        if (
          describeAgentDocumentChanges(row.document, document).changedFields
            .length === 0
        )
          throw new AgentStoreError(
            "no_changes",
            "Proposal does not change the agent document",
          );
        const id = `proposal_${randomUUID()}`;
        db.prepare(`INSERT INTO agent_proposals (id, agent_id, base_draft_version, before_document, document,
          summary, evidence_json, author_thread_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
          id,
          row.id,
          row.draftVersion,
          row.document,
          document,
          input.summary,
          JSON.stringify(input.evidence),
          input.authorThreadId,
          Date.now(),
        );
        return getProposal({ ...input, proposalId: id });
      })();
    },
    listProposals(
      input: AgentTarget & {
        status: AgentProposal["status"] | null;
        limit: number;
        offset: number;
      },
    ) {
      requireRow(input);
      const rows = db
        .prepare<
          [string, string | null, string | null, number, number],
          StoredProposal
        >(
          `${PROPOSAL_SELECT} WHERE agent_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(
          input.agentId,
          input.status,
          input.status,
          input.limit,
          input.offset,
        );
      const total =
        db
          .prepare<[string, string | null, string | null], { total: number }>(
            "SELECT count(*) AS total FROM agent_proposals WHERE agent_id = ? AND (? IS NULL OR status = ?)",
          )
          .get(input.agentId, input.status, input.status)?.total ?? 0;
      return { proposals: rows.map(proposalView), total };
    },
    applyProposal(
      input: DraftTarget & {
        proposalId: string;
        confirmOperationalChanges: boolean;
      },
    ): AgentDetail {
      return db.transaction(() => {
        const row = requireWritable(input);
        const proposal = getProposal(input);
        if (proposal.status !== "pending")
          throw new AgentStoreError(
            "proposal_resolved",
            "This proposal has already been resolved",
          );
        if (
          proposal.baseDraftVersion !== row.draftVersion ||
          proposal.beforeDocument !== row.document
        )
          throw new AgentStoreError(
            "draft_conflict",
            "This proposal targets an older draft; ask for an updated proposal",
          );
        if (
          proposal.operationalChanges.length > 0 &&
          !input.confirmOperationalChanges
        )
          throw new AgentStoreError(
            "operational_confirmation_required",
            "Review and explicitly confirm provider, model, or permission changes before applying this proposal",
          );
        writeDraft(row, proposal.document, fileIds(row.attachmentIdsJson));
        db.prepare(
          "UPDATE agent_proposals SET status = 'applied', resolved_at = ? WHERE id = ?",
        ).run(Date.now(), proposal.id);
        return getAgent(input);
      })();
    },
    rejectProposal(input: AgentTarget & { proposalId: string }): AgentProposal {
      return db.transaction(() => {
        const proposal = getProposal(input);
        if (proposal.status === "applied")
          throw new AgentStoreError(
            "proposal_resolved",
            "An applied proposal cannot be rejected; restore an earlier revision instead",
          );
        if (proposal.status === "pending")
          db.prepare(
            "UPDATE agent_proposals SET status = 'rejected', resolved_at = ? WHERE id = ?",
          ).run(Date.now(), proposal.id);
        return getProposal(input);
      })();
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;

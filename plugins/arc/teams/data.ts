import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentScope } from "../contract.js";
import { AgentStoreError, type AgentStore } from "../data.js";
import type { TeamPin } from "../policy/contract.js";
import {
  teamDefinitionSchema,
  teamProposalSchema,
  type TeamDefinition,
  type TeamDetail,
  type TeamDraftTarget,
  type TeamProposal,
  type TeamRevision,
  type TeamSummary,
  type TeamTarget,
} from "./contract.js";
import {
  describeTeamChanges,
  teamHashes,
  validateTeamDefinition,
} from "./validation.js";

export class TeamStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "TeamStoreError";
  }
}

export const teamMigrations = [
  `CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('library', 'project')),
    project_id TEXT,
    current_revision INTEGER,
    source_team_id TEXT REFERENCES teams(id),
    source_revision INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    CHECK((scope_kind = 'library' AND project_id IS NULL) OR (scope_kind = 'project' AND project_id IS NOT NULL))
  )`,
  `CREATE TABLE team_drafts (
    team_id TEXT PRIMARY KEY REFERENCES teams(id),
    version INTEGER NOT NULL CHECK(version > 0),
    base_revision INTEGER,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    operational_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE team_revisions (
    team_id TEXT NOT NULL REFERENCES teams(id),
    revision INTEGER NOT NULL CHECK(revision > 0),
    definition_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    operational_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(team_id, revision)
  )`,
  `CREATE TABLE team_proposals (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    base_draft_version INTEGER NOT NULL,
    before_json TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    author_thread_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  "CREATE INDEX teams_by_scope ON teams(scope_kind, project_id, updated_at DESC)",
  "CREATE INDEX team_proposals_by_team ON team_proposals(team_id, status, created_at DESC)",
];

interface StoredTeam {
  id: string;
  scopeKind: "library" | "project";
  projectId: string | null;
  currentRevision: number | null;
  sourceTeamId: string | null;
  sourceRevision: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  draftVersion: number;
  baseRevision: number | null;
  name: string;
  description: string;
  definitionJson: string;
  contentHash: string;
  operationalHash: string;
  draftUpdatedAt: number;
  publishedHash: string | null;
}

interface StoredRevision {
  teamId: string;
  revision: number;
  definitionJson: string;
  contentHash: string;
  operationalHash: string;
  createdAt: number;
}

interface StoredProposal {
  id: string;
  teamId: string;
  baseDraftVersion: number;
  beforeJson: string;
  definitionJson: string;
  summary: string;
  evidenceJson: string;
  authorThreadId: string | null;
  status: "pending" | "applied" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
}

const TEAM_SELECT = `SELECT t.id, t.scope_kind AS scopeKind, t.project_id AS projectId,
  t.current_revision AS currentRevision, t.source_team_id AS sourceTeamId, t.source_revision AS sourceRevision,
  t.created_at AS createdAt, t.updated_at AS updatedAt, t.archived_at AS archivedAt,
  d.version AS draftVersion, d.base_revision AS baseRevision, d.name, d.description,
  d.definition_json AS definitionJson, d.content_hash AS contentHash, d.operational_hash AS operationalHash,
  d.updated_at AS draftUpdatedAt, r.content_hash AS publishedHash
  FROM teams t JOIN team_drafts d ON d.team_id = t.id
  LEFT JOIN team_revisions r ON r.team_id = t.id AND r.revision = t.current_revision`;
const REVISION_SELECT = `SELECT team_id AS teamId, revision, definition_json AS definitionJson,
  content_hash AS contentHash, operational_hash AS operationalHash, created_at AS createdAt FROM team_revisions`;
const PROPOSAL_SELECT = `SELECT id, team_id AS teamId, base_draft_version AS baseDraftVersion,
  before_json AS beforeJson, definition_json AS definitionJson, summary, evidence_json AS evidenceJson,
  author_thread_id AS authorThreadId, status, created_at AS createdAt, resolved_at AS resolvedAt FROM team_proposals`;

const project = (scope: AgentScope) =>
  scope.kind === "project" ? scope.projectId : null;
const decode = (value: string): unknown => JSON.parse(value);

export function createTeamStore(db: Database.Database, agents: AgentStore) {
  function requireRow(input: TeamTarget): StoredTeam {
    const row = db
      .prepare<[string, string, string | null], StoredTeam>(
        `${TEAM_SELECT} WHERE t.id = ? AND t.scope_kind = ? AND t.project_id IS ?`,
      )
      .get(input.teamId, input.scope.kind, project(input.scope));
    if (!row)
      throw new TeamStoreError(
        "team_not_found",
        "Team is not available in this scope",
      );
    return row;
  }
  function writable(input: TeamDraftTarget, allowArchived = false): StoredTeam {
    const row = requireRow(input);
    if (row.archivedAt !== null && !allowArchived)
      throw new TeamStoreError(
        "team_archived",
        "Restore this team before editing it",
      );
    if (row.draftVersion !== input.expectedDraftVersion)
      throw new TeamStoreError(
        "draft_conflict",
        `Draft changed; reload version ${row.draftVersion} before applying this change`,
      );
    return row;
  }
  function summary(row: StoredTeam): TeamSummary {
    if (row.scopeKind === "project" && row.projectId === null)
      throw new Error("Project team is missing its project reference");
    return {
      id: row.id,
      scope:
        row.projectId === null
          ? { kind: "library" }
          : { kind: "project", projectId: row.projectId },
      name: row.name,
      description: row.description,
      currentRevision: row.currentRevision,
      draftVersion: row.draftVersion,
      hasUnpublishedChanges: row.contentHash !== row.publishedHash,
      sourceTeamId: row.sourceTeamId,
      sourceRevision: row.sourceRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
  function validation(definition: TeamDefinition, scope: AgentScope) {
    return validateTeamDefinition(definition, (agentId, revision) => {
      try {
        agents.getRevision({ scope, agentId, revision });
        return true;
      } catch (error) {
        if (
          error instanceof AgentStoreError &&
          ["agent_not_found", "revision_not_found"].includes(error.code)
        )
          return false;
        throw error;
      }
    });
  }
  function detail(row: StoredTeam): TeamDetail {
    const info = summary(row);
    const definition = teamDefinitionSchema.parse(decode(row.definitionJson));
    return {
      ...info,
      draft: {
        version: row.draftVersion,
        baseRevision: row.baseRevision,
        definition,
        contentHash: row.contentHash,
        operationalHash: row.operationalHash,
        updatedAt: row.draftUpdatedAt,
      },
      validation: validation(definition, info.scope),
    };
  }
  function getTeam(input: TeamTarget): TeamDetail {
    return detail(requireRow(input));
  }
  function getRevision(input: TeamTarget & { revision: number }): TeamRevision {
    requireRow(input);
    const row = db
      .prepare<[string, number], StoredRevision>(
        `${REVISION_SELECT} WHERE team_id = ? AND revision = ?`,
      )
      .get(input.teamId, input.revision);
    if (!row)
      throw new TeamStoreError(
        "revision_not_found",
        "Team revision does not exist",
      );
    return {
      teamId: row.teamId,
      revision: row.revision,
      definition: teamDefinitionSchema.parse(decode(row.definitionJson)),
      contentHash: row.contentHash,
      operationalHash: row.operationalHash,
      createdAt: row.createdAt,
    };
  }
  function createTeam(input: {
    scope: AgentScope;
    definition: TeamDefinition;
    sourceTeamId?: string;
    sourceRevision?: number;
  }): TeamDetail {
    return db.transaction(() => {
      const value = teamHashes(input.definition);
      const id = `team_${randomUUID()}`;
      const now = Date.now();
      db.prepare(
        "INSERT INTO teams (id, scope_kind, project_id, source_team_id, source_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.scope.kind,
        project(input.scope),
        input.sourceTeamId ?? null,
        input.sourceRevision ?? null,
        now,
        now,
      );
      db.prepare(
        "INSERT INTO team_drafts (team_id, version, name, description, definition_json, content_hash, operational_hash, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        value.definition.name,
        value.definition.description,
        JSON.stringify(value.definition),
        value.contentHash,
        value.operationalHash,
        now,
      );
      return getTeam({ teamId: id, scope: input.scope });
    })();
  }
  function writeDraft(row: StoredTeam, definition: TeamDefinition) {
    const value = teamHashes(definition);
    if (row.contentHash === value.contentHash) return;
    const now = Date.now();
    db.prepare(
      "UPDATE team_drafts SET version = version + 1, name = ?, description = ?, definition_json = ?, content_hash = ?, operational_hash = ?, updated_at = ? WHERE team_id = ? AND version = ?",
    ).run(
      value.definition.name,
      value.definition.description,
      JSON.stringify(value.definition),
      value.contentHash,
      value.operationalHash,
      now,
      row.id,
      row.draftVersion,
    );
    db.prepare("UPDATE teams SET updated_at = ? WHERE id = ?").run(now, row.id);
  }
  function saveDraft(
    input: TeamDraftTarget & { definition: TeamDefinition },
  ): TeamDetail {
    return db.transaction(() => {
      writeDraft(writable(input), input.definition);
      return getTeam(input);
    })();
  }
  function publish(input: TeamDraftTarget): TeamDetail {
    return db.transaction(() => {
      const row = writable(input);
      const value = detail(row);
      for (const member of value.draft.definition.members)
        if (member.skills?.length) agents.assignedSkills.resolve(member.skills);
      if (!value.validation.valid)
        throw new TeamStoreError(
          "invalid_team",
          value.validation.diagnostics.map((item) => item.message).join(" "),
        );
      if (row.publishedHash === row.contentHash) return value;
      const revision = (row.currentRevision ?? 0) + 1;
      const now = Date.now();
      db.prepare(
        "INSERT INTO team_revisions (team_id, revision, definition_json, content_hash, operational_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        row.id,
        revision,
        row.definitionJson,
        row.contentHash,
        row.operationalHash,
        now,
      );
      db.prepare(
        "UPDATE teams SET current_revision = ?, updated_at = ? WHERE id = ?",
      ).run(revision, now, row.id);
      db.prepare(
        "UPDATE team_drafts SET base_revision = ?, version = version + 1, updated_at = ? WHERE team_id = ?",
      ).run(revision, now, row.id);
      return getTeam(input);
    })();
  }
  function getProposal(
    input: TeamTarget & { proposalId: string },
  ): TeamProposal {
    requireRow(input);
    const row = db
      .prepare<[string, string], StoredProposal>(
        `${PROPOSAL_SELECT} WHERE team_id = ? AND id = ?`,
      )
      .get(input.teamId, input.proposalId);
    if (!row)
      throw new TeamStoreError(
        "proposal_not_found",
        "Proposal is not available for this team",
      );
    const beforeDefinition = teamDefinitionSchema.parse(decode(row.beforeJson));
    const definition = teamDefinitionSchema.parse(decode(row.definitionJson));
    return teamProposalSchema.parse({
      id: row.id,
      teamId: row.teamId,
      baseDraftVersion: row.baseDraftVersion,
      beforeDefinition,
      definition,
      summary: row.summary,
      evidence: decode(row.evidenceJson),
      authorThreadId: row.authorThreadId,
      status: row.status,
      ...describeTeamChanges(beforeDefinition, definition),
      validation: validation(definition, input.scope),
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    });
  }
  function copyToProject(
    input: TeamTarget & { revision: number; projectId: string },
  ): TeamDetail {
    return db.transaction(() => {
      if (input.scope.kind !== "library")
        throw new TeamStoreError(
          "library_team_required",
          "Copy a published personal-library team into a project",
        );
      const source = getRevision(input);
      const scope: AgentScope = { kind: "project", projectId: input.projectId };
      const copied = new Map<string, { agentId: string; revision: number }>();
      const definition = teamDefinitionSchema.parse(source.definition);
      for (const member of definition.members) {
        const key = `${member.agentId}:${member.revision}`;
        let reference = copied.get(key);
        if (!reference) {
          const agent = agents.copyToProject({
            scope: input.scope,
            agentId: member.agentId,
            revision: member.revision,
            projectId: input.projectId,
          });
          if (agent.currentRevision === null)
            throw new TeamStoreError(
              "copy_failed",
              "Copied agent did not produce a published revision",
            );
          reference = { agentId: agent.id, revision: agent.currentRevision };
          copied.set(key, reference);
        }
        member.agentId = reference.agentId;
        member.revision = reference.revision;
      }
      const created = createTeam({
        scope,
        definition,
        sourceTeamId: input.teamId,
        sourceRevision: input.revision,
      });
      return publish({
        scope,
        teamId: created.id,
        expectedDraftVersion: created.draft.version,
      });
    })();
  }
  return {
    getTeam,
    getRevision,
    createTeam,
    saveDraft,
    publish,
    getProposal,
    copyToProject,
    listTeams(input: {
      scope: AgentScope;
      search: string;
      includeArchived: boolean;
      limit: number;
      offset: number;
    }) {
      const where =
        "t.scope_kind = ? AND t.project_id IS ? AND (? = 1 OR t.archived_at IS NULL) AND (? = '' OR d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\')";
      const search = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      const args = [
        input.scope.kind,
        project(input.scope),
        Number(input.includeArchived),
        input.search,
        search,
        search,
      ];
      const rows = db
        .prepare<Array<string | number | null>, StoredTeam>(
          `${TEAM_SELECT} WHERE ${where} ORDER BY t.updated_at DESC, t.id LIMIT ? OFFSET ?`,
        )
        .all(...args, input.limit, input.offset);
      const total =
        db
          .prepare<Array<string | number | null>, { total: number }>(
            `SELECT count(*) AS total FROM teams t JOIN team_drafts d ON d.team_id = t.id WHERE ${where}`,
          )
          .get(...args)?.total ?? 0;
      return { teams: rows.map(summary), total };
    },
    listRevisions(input: TeamTarget & { limit: number; offset: number }) {
      requireRow(input);
      const rows = db
        .prepare<[string, number, number], { revision: number }>(
          "SELECT revision FROM team_revisions WHERE team_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?",
        )
        .all(input.teamId, input.limit, input.offset);
      const total =
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM team_revisions WHERE team_id = ?",
          )
          .get(input.teamId)?.total ?? 0;
      return {
        revisions: rows.map(({ revision }) =>
          getRevision({ ...input, revision }),
        ),
        total,
      };
    },
    listRunCandidates(input: {
      projectId: string;
      preferredTeams: TeamPin[];
      restrictedTeams: TeamPin[] | null;
      search: string;
      limit: number;
      offset: number;
    }) {
      const base = `WITH preferences AS (SELECT value, CAST(key AS INTEGER) AS rank FROM json_each(?)),
        allowed AS (SELECT value FROM json_each(?))
        SELECT t.id AS teamId, r.revision, t.current_revision AS latestRevision,
          CASE WHEN json_extract(p.value, '$.revision') = r.revision THEN p.rank ELSE 2147483647 END AS preferenceRank
        FROM teams t
        LEFT JOIN preferences p ON json_extract(p.value, '$.teamId') = t.id
        LEFT JOIN allowed a ON json_extract(a.value, '$.teamId') = t.id
        JOIN team_revisions r ON r.team_id = t.id AND r.revision = CASE WHEN ? = 1
          THEN json_extract(a.value, '$.revision')
          ELSE COALESCE(json_extract(p.value, '$.revision'), t.current_revision) END
        WHERE t.scope_kind = 'project' AND t.project_id = ? AND t.archived_at IS NULL
          AND (? = '' OR json_extract(r.definition_json, '$.name') LIKE ? ESCAPE '\\'
            OR json_extract(r.definition_json, '$.description') LIKE ? ESCAPE '\\')`;
      const search = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
      const args = [
        JSON.stringify(input.preferredTeams),
        JSON.stringify(input.restrictedTeams ?? []),
        Number(input.restrictedTeams !== null),
        input.projectId,
        input.search,
        search,
        search,
      ];
      const rows = db
        .prepare<
          Array<string | number>,
          {
            teamId: string;
            revision: number;
            latestRevision: number;
            preferenceRank: number;
          }
        >(
          `${base} ORDER BY preferenceRank, t.updated_at DESC, t.id LIMIT ? OFFSET ?`,
        )
        .all(...args, input.limit, input.offset);
      const total =
        db
          .prepare<Array<string | number>, { total: number }>(
            `SELECT count(*) AS total FROM (${base})`,
          )
          .get(...args)?.total ?? 0;
      return {
        versions: rows.map((row) => ({
          snapshot: getRevision({
            scope: { kind: "project", projectId: input.projectId },
            teamId: row.teamId,
            revision: row.revision,
          }),
          latestRevision: row.latestRevision,
          preferred: row.preferenceRank !== 2147483647,
        })),
        total,
      };
    },
    restore(input: TeamDraftTarget & { revision: number }): TeamDetail {
      return db.transaction(() => {
        const row = writable(input);
        writeDraft(row, getRevision(input).definition);
        return publish({
          ...input,
          expectedDraftVersion: getTeam(input).draft.version,
        });
      })();
    },
    setArchived(input: TeamDraftTarget & { archived: boolean }): TeamDetail {
      return db.transaction(() => {
        const row = writable(input, true);
        if ((row.archivedAt !== null) === input.archived) return detail(row);
        const now = Date.now();
        db.prepare(
          "UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?",
        ).run(input.archived ? now : null, now, row.id);
        db.prepare(
          "UPDATE team_drafts SET version = version + 1, updated_at = ? WHERE team_id = ?",
        ).run(now, row.id);
        return getTeam(input);
      })();
    },
    propose(
      input: TeamDraftTarget & {
        definition: TeamDefinition;
        summary: string;
        evidence: Array<{ source: string; detail: string }>;
        authorThreadId: string | null;
      },
    ): TeamProposal {
      return db.transaction(() => {
        const row = writable(input);
        const definition = teamHashes(input.definition).definition;
        const evidence = z
          .array(
            z
              .object({
                source: z.string().trim().min(1).max(500),
                detail: z.string().trim().min(1).max(2000),
              })
              .strict(),
          )
          .max(30)
          .parse(input.evidence);
        const summary = z.string().trim().min(1).max(2000).parse(input.summary);
        const id = `teamproposal_${randomUUID()}`;
        db.prepare(
          "INSERT INTO team_proposals (id, team_id, base_draft_version, before_json, definition_json, summary, evidence_json, author_thread_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        ).run(
          id,
          row.id,
          row.draftVersion,
          row.definitionJson,
          JSON.stringify(definition),
          summary,
          JSON.stringify(evidence),
          input.authorThreadId,
          Date.now(),
        );
        return getProposal({ ...input, proposalId: id });
      })();
    },
    listProposals(
      input: TeamTarget & {
        status: TeamProposal["status"] | null;
        limit: number;
        offset: number;
      },
    ) {
      requireRow(input);
      const where = "team_id = ? AND (? IS NULL OR status = ?)";
      const rows = db
        .prepare<
          [string, string | null, string | null, number, number],
          { id: string }
        >(
          `SELECT id FROM team_proposals WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(
          input.teamId,
          input.status,
          input.status,
          input.limit,
          input.offset,
        );
      const total =
        db
          .prepare<[string, string | null, string | null], { total: number }>(
            `SELECT count(*) AS total FROM team_proposals WHERE ${where}`,
          )
          .get(input.teamId, input.status, input.status)?.total ?? 0;
      return {
        proposals: rows.map(({ id }) =>
          getProposal({ ...input, proposalId: id }),
        ),
        total,
      };
    },
    applyProposal(input: TeamDraftTarget & { proposalId: string }): TeamDetail {
      return db.transaction(() => {
        const row = writable(input);
        const proposal = getProposal(input);
        if (proposal.status !== "pending")
          throw new TeamStoreError(
            "proposal_resolved",
            "This proposal has already been resolved",
          );
        if (proposal.baseDraftVersion !== row.draftVersion)
          throw new TeamStoreError(
            "draft_conflict",
            "The draft changed after this proposal; request a new proposal against the current version",
          );
        writeDraft(row, proposal.definition);
        db.prepare(
          "UPDATE team_proposals SET status = 'applied', resolved_at = ? WHERE id = ? AND status = 'pending'",
        ).run(Date.now(), proposal.id);
        return getTeam(input);
      })();
    },
    rejectProposal(
      input: TeamDraftTarget & { proposalId: string },
    ): TeamProposal {
      return db.transaction(() => {
        writable(input);
        const proposal = getProposal(input);
        if (proposal.status !== "pending")
          throw new TeamStoreError(
            "proposal_resolved",
            "This proposal has already been resolved",
          );
        db.prepare(
          "UPDATE team_proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'",
        ).run(Date.now(), proposal.id);
        return getProposal(input);
      })();
    },
  };
}

export type TeamStore = ReturnType<typeof createTeamStore>;

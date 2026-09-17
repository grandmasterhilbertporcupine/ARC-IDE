import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import { arcTeamsRpcContract, type TeamDefinition } from "./contract.js";
import { createTeamTestStore, teamTarget } from "./testing.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const value = createTeamTestStore();
  databases.push(value.db);
  return value;
}

describe("versioned team authoring with real SQLite", () => {
  it("retains incomplete drafts with diagnostics and blocks publish without losing an existing revision", () => {
    const { store, scope, definition } = setup();
    let team = store.createTeam({ scope, definition });
    team = store.publish(teamTarget(team));
    const original = store.getRevision({ ...teamTarget(team), revision: 1 });
    const unfinished: TeamDefinition = structuredClone(definition);
    unfinished.name = "";
    unfinished.graph.nodes.push({
      id: "draft",
      label: "",
      kind: "agent",
      memberId: "unassigned",
      task: "",
      access: "read",
      candidate: { kind: "source" },
    });
    team = store.saveDraft({ ...teamTarget(team), definition: unfinished });
    expect(team.validation.valid).toBe(false);
    expect(team.validation.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "name_required",
        "label_required",
        "task_required",
        "missing_member",
        "unreachable_node",
      ]),
    );
    expect(() => store.publish(teamTarget(team))).toThrow("invalid_team");
    expect(store.getRevision({ ...teamTarget(team), revision: 1 })).toEqual(
      original,
    );
    expect(store.getTeam(teamTarget(team)).draft.definition.name).toBe("");
  });

  it("rejects stale save/publish/archive actions and restores into a new immutable revision", () => {
    const { store, scope, definition } = setup();
    let team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const initial = store.getRevision({ ...teamTarget(team), revision: 1 });
    const stale = teamTarget(team);
    team = store.saveDraft({
      ...teamTarget(team),
      definition: { ...definition, description: "Changed" },
    });
    expect(() => store.saveDraft({ ...stale, definition })).toThrow(
      "draft_conflict",
    );
    expect(() => store.publish(stale)).toThrow("draft_conflict");
    expect(() => store.setArchived({ ...stale, archived: true })).toThrow(
      "draft_conflict",
    );
    team = store.publish(teamTarget(team));
    expect(team.currentRevision).toBe(2);
    team = store.restore({ ...teamTarget(team), revision: 1 });
    expect(team.currentRevision).toBe(3);
    expect(team.draft.definition).toEqual(initial.definition);
    expect(store.getRevision({ ...teamTarget(team), revision: 1 })).toEqual(
      initial,
    );
    expect(
      store.listRevisions({ ...teamTarget(team), limit: 1, offset: 1 })
        .revisions[0]?.revision,
    ).toBe(2);
    expect(
      store.listRevisions({ ...teamTarget(team), limit: 1, offset: 1 }).total,
    ).toBe(3);
    team = store.setArchived({ ...teamTarget(team), archived: true });
    expect(() => store.saveDraft({ ...teamTarget(team), definition })).toThrow(
      "team_archived",
    );
    expect(() => store.publish(teamTarget(team))).toThrow("team_archived");
    expect(store.getRevision({ ...teamTarget(team), revision: 1 })).toEqual(
      initial,
    );
    team = store.setArchived({ ...teamTarget(team), archived: false });
    expect(team.archivedAt).toBeNull();
  });

  it("keeps cosmetic revisions separate from operational identity and canonicalizes collection order", () => {
    const { store, scope, definition } = setup();
    let team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const operationalHash = team.draft.operationalHash;
    const originalVersion = team.draft.version;
    const reordered = structuredClone(definition);
    reordered.graph.nodes.reverse();
    reordered.graph.edges.reverse();
    reordered.graph.requiredGates[0]?.nodeIds.reverse();
    team = store.saveDraft({ ...teamTarget(team), definition: reordered });
    expect(team.draft.version).toBe(originalVersion);
    reordered.name = "New name";
    reordered.presentation.color = "#ABCDEF";
    reordered.groups[0] = {
      id: "blue",
      name: "White team",
      color: "#ffffff",
      parentGroupId: null,
    };
    reordered.presentation.nodes[0] = { nodeId: "write", x: -200, y: 123 };
    team = store.saveDraft({ ...teamTarget(team), definition: reordered });
    expect(team.draft.operationalHash).toBe(operationalHash);
    expect(team.draft.definition.presentation.color).toBe("#abcdef");
    expect(store.getTeam(teamTarget(team)).draft.definition.name).toBe(
      "New name",
    );
    expect(team.hasUnpublishedChanges).toBe(true);
    const writer = reordered.graph.nodes.find((node) => node.kind === "agent");
    if (!writer || writer.kind !== "agent")
      throw new Error("Fixture writer missing");
    writer.task = "A materially different task";
    team = store.saveDraft({ ...teamTarget(team), definition: reordered });
    expect(team.draft.operationalHash).not.toBe(operationalHash);
  });

  it("copies exact published agent references and owned attachments once per dependency atomically", () => {
    const { store, agents, scope, definition, agent: initialAgent } = setup();
    let agent = agents.addAttachment({
      agentId: initialAgent.id,
      scope,
      expectedDraftVersion: initialAgent.draft.version,
      name: "reference.md",
      mimeType: "text/markdown",
      content: Buffer.from("Pinned context"),
    });
    agent = agents.publish({
      agentId: agent.id,
      scope,
      expectedDraftVersion: agent.draft.version,
    });
    definition.members[0] = {
      id: "builder",
      agentId: agent.id,
      revision: 2,
      groupId: "blue",
    };
    definition.members.push({
      id: "second-role",
      agentId: agent.id,
      revision: 2,
      groupId: null,
    });
    const team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const copy = store.copyToProject({
      ...teamTarget(team),
      revision: 1,
      projectId: "project-copy",
    });
    expect(copy.sourceTeamId).toBe(team.id);
    expect(copy.sourceRevision).toBe(1);
    expect(copy.currentRevision).toBe(1);
    expect(copy.validation.valid).toBe(true);
    const members = copy.draft.definition.members;
    expect(new Set(members.map((member) => member.agentId)).size).toBe(1);
    const member = members[0];
    if (!member) throw new Error("Copied member missing");
    expect(member.agentId).not.toBe(agent.id);
    expect(member.revision).toBe(1);
    const copiedAgent = agents.getRevision({
      scope: copy.scope,
      agentId: member.agentId,
      revision: 1,
    });
    expect(copiedAgent.document).toBe(agent.draft.document);
    expect(copiedAgent.attachments[0]?.id).not.toBe(
      agent.draft.attachments[0]?.id,
    );
    const file = copiedAgent.attachments[0];
    if (!file) throw new Error("Copied attachment missing");
    expect(file.agentId).toBe(member.agentId);
    expect(
      Buffer.from(
        agents.readAttachment({
          scope: copy.scope,
          agentId: member.agentId,
          attachmentId: file.id,
        }).content,
      ).toString(),
    ).toBe("Pinned context");
    agent = agents.saveDraft({
      scope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
      document: serializeAgentDocument(
        defaultAgentMetadata("Changed library name"),
        "Changed library instructions",
      ),
      attachmentIds: [],
    });
    agents.publish({
      scope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
    });
    expect(
      agents.getRevision({
        scope: copy.scope,
        agentId: member.agentId,
        revision: 1,
      }),
    ).toEqual(copiedAgent);
    expect(
      store.getRevision({ ...teamTarget(copy), revision: 1 }).definition
        .members,
    ).toEqual(members);
  });

  it("rolls back copied agents, files and team rows when final team publication fails", () => {
    const { store, db, scope, definition } = setup();
    const team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const count = (table: string) =>
      db
        .prepare<[], { total: number }>(
          `SELECT count(*) AS total FROM ${table}`,
        )
        .get()?.total;
    const before = [
      count("agents"),
      count("agent_revisions"),
      count("teams"),
      count("team_revisions"),
    ];
    db.exec(
      "CREATE TRIGGER reject_copied_revision BEFORE INSERT ON team_revisions WHEN (SELECT scope_kind FROM teams WHERE id = NEW.team_id) = 'project' BEGIN SELECT RAISE(ABORT, 'copy publication rejected'); END",
    );
    expect(() =>
      store.copyToProject({
        ...teamTarget(team),
        revision: 1,
        projectId: "project-copy",
      }),
    ).toThrow("copy publication rejected");
    expect([
      count("agents"),
      count("agent_revisions"),
      count("teams"),
      count("team_revisions"),
    ]).toEqual(before);
  });

  it("rejects cross-scope agent references and hides teams, proposals and revisions from wrong projects", () => {
    const { store, scope, definition } = setup();
    const team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const otherScope = { kind: "project", projectId: "other-project" } as const;
    const draft = store.createTeam({ scope: otherScope, definition });
    expect(draft.validation.diagnostics.map((item) => item.code)).toContain(
      "agent_revision_unavailable",
    );
    expect(() => store.publish(teamTarget(draft))).toThrow("invalid_team");
    expect(() => store.getTeam({ teamId: team.id, scope: otherScope })).toThrow(
      "team_not_found",
    );
    expect(() =>
      store.getRevision({ teamId: team.id, scope: otherScope, revision: 1 }),
    ).toThrow("team_not_found");
    expect(() =>
      store.copyToProject({
        ...teamTarget(draft),
        revision: 1,
        projectId: "target",
      }),
    ).toThrow("library_team_required");
  });

  it("retains proposal snapshots, rejects competing versions, and applies only to the reviewed draft", () => {
    const { store, scope, definition } = setup();
    let team = store.publish(
      teamTarget(store.createTeam({ scope, definition })),
    );
    const input = {
      ...teamTarget(team),
      definition: { ...definition, description: "Proposed" },
      summary: "Rename the description",
      evidence: [],
      authorThreadId: "assistant-thread",
    };
    const first = store.propose(input);
    const second = store.propose({
      ...input,
      definition: { ...definition, name: "Another proposal" },
    });
    expect(first.beforeDefinition).toEqual(team.draft.definition);
    expect(first.operationalChanges).toBe(false);
    team = store.applyProposal({ ...teamTarget(team), proposalId: first.id });
    expect(team.draft.definition.description).toBe("Proposed");
    expect(team.currentRevision).toBe(1);
    expect(
      store.getRevision({ ...teamTarget(team), revision: 1 }).definition
        .description,
    ).toBe(definition.description);
    expect(() =>
      store.applyProposal({ ...teamTarget(team), proposalId: second.id }),
    ).toThrow("draft_conflict");
    expect(
      store.getProposal({ ...teamTarget(team), proposalId: second.id }).status,
    ).toBe("pending");
    expect(
      store.rejectProposal({ ...teamTarget(team), proposalId: second.id })
        .status,
    ).toBe("rejected");
    expect(() =>
      store.applyProposal({ ...teamTarget(team), proposalId: first.id }),
    ).toThrow("proposal_resolved");
    expect(
      store.listProposals({
        ...teamTarget(team),
        status: null,
        limit: 1,
        offset: 1,
      }).total,
    ).toBe(2);
    expect(
      store.listProposals({
        ...teamTarget(team),
        status: "applied",
        limit: 10,
        offset: 0,
      }).proposals[0]?.authorThreadId,
    ).toBe("assistant-thread");
  });

  it("keeps capabilities server reported and bounds searchable scope pages", () => {
    const { store, scope, definition } = setup();
    const team = store.publish(
      teamTarget(
        store.createTeam({
          scope,
          definition: { ...definition, name: "100% done" },
        }),
      ),
    );
    store.createTeam({
      scope,
      definition: { ...definition, name: "100x done" },
    });
    expect(
      store
        .listTeams({
          scope,
          search: "%",
          includeArchived: false,
          limit: 1,
          offset: 0,
        })
        .teams.map((item) => item.id),
    ).toEqual([team.id]);
    expect(
      store.listTeams({
        scope,
        search: "",
        includeArchived: false,
        limit: 1,
        offset: 1,
      }).total,
    ).toBe(2);
    store.setArchived({ ...teamTarget(team), archived: true });
    expect(
      store.listTeams({
        scope,
        search: "%",
        includeArchived: false,
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(0);
    expect(
      store.listTeams({
        scope,
        search: "%",
        includeArchived: true,
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(1);
    expect(team.validation.execution.available).toBe(true);
    expect(
      arcTeamsRpcContract.getTeam.output.parse({ team }).team.validation
        .execution.blockers,
    ).toEqual([]);
    expect(() =>
      arcTeamsRpcContract.createTeam.input.parse({
        scope,
        definition,
        execution: { available: true },
      }),
    ).toThrow();
  });
});

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { arcTeamsRpcContract } from "./contract.js";
import { createArcTeamService } from "./service.js";
import { createTeamTestStore, teamTarget } from "./testing.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(projectId: string | null = null) {
  const fixture = createTeamTestStore(
    projectId === null ? { kind: "library" } : { kind: "project", projectId },
  );
  databases.push(fixture.db);
  const changes: string[] = [];
  const copiedAgents: string[][] = [];
  let authoringTeam: string | null = null;
  const service = createArcTeamService(fixture.store, {
    async requireProject(id) {
      if (id === "missing") throw new Error("project_not_found");
    },
    async authoringTeam() {
      return authoringTeam;
    },
    changed(event) {
      changes.push(event.teamId);
      copiedAgents.push([...event.copiedAgentIds]);
    },
  });
  return {
    ...fixture,
    service,
    changes,
    copiedAgents,
    bind(id: string) {
      authoringTeam = id;
    },
  };
}

describe("Team Builder SDK and CLI service boundary", () => {
  it("routes create/save/validate/publish/history/archive through parsed contracts and change events", async () => {
    const { service, scope, definition, changes, copiedAgents } = setup();
    const created = arcTeamsRpcContract.createTeam.output.parse(
      await service.call("createTeam", { scope, definition }),
    );
    const saved = arcTeamsRpcContract.saveTeamDraft.output.parse(
      await service.call("saveTeamDraft", {
        ...teamTarget(created.team),
        definition: { ...definition, name: "Service edit" },
      }),
    );
    const validation = arcTeamsRpcContract.validateTeamDraft.output.parse(
      await service.call("validateTeamDraft", { scope, teamId: saved.team.id }),
    );
    expect(validation.valid).toBe(true);
    expect(validation.execution.available).toBe(true);
    const published = arcTeamsRpcContract.publishTeamRevision.output.parse(
      await service.call("publishTeamRevision", teamTarget(saved.team)),
    );
    const revisions = arcTeamsRpcContract.listTeamRevisions.output.parse(
      await service.call("listTeamRevisions", {
        scope,
        teamId: published.team.id,
      }),
    );
    expect(revisions.total).toBe(1);
    expect(revisions.revisions[0]?.definition.name).toBe("Service edit");
    const archived = arcTeamsRpcContract.setTeamArchived.output.parse(
      await service.call("setTeamArchived", {
        ...teamTarget(published.team),
        archived: true,
      }),
    );
    expect(archived.team.archivedAt).not.toBeNull();
    expect(changes).toHaveLength(4);
    expect(copiedAgents).toEqual([[], [], [], []]);
    await expect(service.call("startTeamRun", { scope })).rejects.toThrow(
      "unknown_method",
    );
    await expect(
      service.call("getTeam", {
        scope,
        teamId: archived.team.id,
        projectId: "forged",
      }),
    ).rejects.toThrow();
  });

  it("reports each actually copied agent once and emits no copy notification after a failed copy", async () => {
    const { service, scope, definition, copiedAgents, changes, agents, agent } =
      setup();
    definition.members.push({
      id: "second-role",
      agentId: agent.id,
      revision: 1,
      groupId: null,
    });
    const created = arcTeamsRpcContract.createTeam.output.parse(
      await service.call("createTeam", { scope, definition }),
    );
    const published = arcTeamsRpcContract.publishTeamRevision.output.parse(
      await service.call("publishTeamRevision", teamTarget(created.team)),
    );
    const copyInput = {
      scope,
      teamId: published.team.id,
      revision: 1,
      projectId: "copy-project",
    };
    const copied = arcTeamsRpcContract.copyTeamToProject.output.parse(
      await service.call("copyTeamToProject", copyInput),
    );
    const member = copied.team.draft.definition.members[0];
    if (!member) throw new Error("Copied team member missing");
    expect(member.agentId).not.toBe(agent.id);
    expect(copiedAgents).toEqual([[], [], [member.agentId]]);
    expect(changes.at(-1)).toBe(copied.team.id);
    expect(
      agents.getRevision({
        scope: copied.team.scope,
        agentId: member.agentId,
        revision: member.revision,
      }).agentId,
    ).toBe(member.agentId);
    await expect(
      service.call("copyTeamToProject", { ...copyInput, projectId: "missing" }),
    ).rejects.toThrow("project_not_found");
    expect(copiedAgents).toEqual([[], [], [member.agentId]]);
  });

  it("permits same-project proposals but denies agent operational mutations and cross-project queries", async () => {
    const { service, scope, definition, store } = setup("project-a");
    const team = store.createTeam({ scope, definition });
    const actor = {
      kind: "agent",
      threadId: "worker",
      projectId: "project-a",
    } as const;
    const input = {
      ...teamTarget(team),
      definition: { ...definition, name: "Proposed by agent" },
      summary: "Name clarification",
    };
    const proposal = arcTeamsRpcContract.proposeTeamDraft.output.parse(
      await service.call("proposeTeamDraft", input, actor),
    );
    expect(proposal.proposal.authorThreadId).toBe("worker");
    expect(store.getTeam(teamTarget(team)).draft.definition.name).toBe(
      definition.name,
    );
    for (const [method, args] of [
      ["createTeam", { scope, definition }],
      ["saveTeamDraft", { ...teamTarget(team), definition }],
      ["publishTeamRevision", teamTarget(team)],
      ["restoreTeamRevision", { ...teamTarget(team), revision: 1 }],
      [
        "copyTeamToProject",
        { scope, teamId: team.id, revision: 1, projectId: "project-b" },
      ],
      ["setTeamArchived", { ...teamTarget(team), archived: true }],
      [
        "applyTeamProposal",
        { ...teamTarget(team), proposalId: proposal.proposal.id },
      ],
      [
        "rejectTeamProposal",
        { ...teamTarget(team), proposalId: proposal.proposal.id },
      ],
    ] as const)
      await expect(service.call(method, args, actor)).rejects.toThrow(
        "proposal_required",
      );
    for (const method of [
      "getTeam",
      "validateTeamDraft",
      "listTeams",
      "listTeamRevisions",
      "listTeamProposals",
    ])
      await expect(
        service.call(
          method,
          {
            scope: { kind: "project", projectId: "project-a" },
            ...(method === "listTeams" ? {} : { teamId: team.id }),
          },
          { ...actor, projectId: "project-b" },
        ),
      ).rejects.toThrow("scope_denied");
    await expect(
      service.call("copyTeamToProject", {
        scope: { kind: "library" },
        teamId: team.id,
        revision: 1,
        projectId: "missing",
      }),
    ).rejects.toThrow("project_not_found");
  });

  it("requires the exact bound library assistant and user review before applying a proposal", async () => {
    const { service, store, scope, definition, bind } = setup();
    const team = store.createTeam({ scope, definition });
    const actor = {
      kind: "agent",
      threadId: "assistant",
      projectId: "personal-project",
    } as const;
    const input = {
      ...teamTarget(team),
      definition: { ...definition, description: "Proposed" },
      summary: "Description change",
      evidence: [{ source: "user brief", detail: "Clarifies purpose" }],
    };
    await expect(
      service.call("proposeTeamDraft", input, actor),
    ).rejects.toThrow("scope_denied");
    bind(team.id);
    const proposed = arcTeamsRpcContract.proposeTeamDraft.output.parse(
      await service.call("proposeTeamDraft", input, actor),
    );
    expect(proposed.proposal.status).toBe("pending");
    const applied = arcTeamsRpcContract.applyTeamProposal.output.parse(
      await service.call("applyTeamProposal", {
        ...teamTarget(team),
        proposalId: proposed.proposal.id,
      }),
    );
    expect(applied.team.draft.definition.description).toBe("Proposed");
    const copiedProposalId = proposed.proposal.id;
    const other = store.createTeam({ scope, definition });
    await expect(
      service.call("getTeamProposal", {
        scope,
        teamId: other.id,
        proposalId: copiedProposalId,
      }),
    ).rejects.toThrow("proposal_not_found");
  });
});

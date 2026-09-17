import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentStore, migrations, type AgentStore } from "./data.js";
import {
  defaultAgentMetadata,
  parseAgentDocument,
  serializeAgentDocument,
} from "./document.js";
import type { AgentDetail } from "./contract.js";

const library = { kind: "library" } as const;
const project = { kind: "project", projectId: "project-a" } as const;
const document = (body = "Review implementation and report evidence.") =>
  serializeAgentDocument(defaultAgentMetadata("Reviewer"), body);
const target = (agent: AgentDetail) => ({
  agentId: agent.id,
  scope: agent.scope,
  expectedDraftVersion: agent.draft.version,
});
let db: Database.Database;
let store: AgentStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(migrations.join(";\n"));
  store = createAgentStore(db);
});
afterEach(() => db.close());

describe("canonical agent documents", () => {
  it("round trips form metadata and Markdown without losing code or trailing spaces", () => {
    const body =
      "# Review\n\n```ts\nconst example = '---';\n```\nTwo spaces  \nNext line";
    const canonical = document(body);
    const parsed = parseAgentDocument(canonical.replaceAll("\n", "\r\n"));
    expect(parsed.document).toBe(canonical);
    expect(parsed.body).toBe(body);
    expect(serializeAgentDocument(parsed.metadata, parsed.body)).toBe(
      canonical,
    );
  });

  it("rejects invalid, unknown, and inconsistent operational metadata", () => {
    expect(() => parseAgentDocument("# No metadata")).toThrow();
    expect(() =>
      parseAgentDocument("---\nname: invalid\n---\n\nBody"),
    ).toThrow();
    expect(() =>
      parseAgentDocument(
        document().replace(
          '"schemaVersion": 1',
          '"schemaVersion": 1, "permissions": "admin"',
        ),
      ),
    ).toThrow();
    expect(() =>
      serializeAgentDocument(
        {
          ...defaultAgentMetadata(),
          execution: {
            ...defaultAgentMetadata().execution,
            providerId: "codex",
          },
        },
        "Body",
      ),
    ).toThrow();
  });
});

describe("agent revisions and scope", () => {
  it("persists drafts independently, detects competing edits, and restores without changing history", () => {
    let agent = store.createAgent({
      scope: library,
      document: document("Version one"),
    });
    agent = store.publish(target(agent));
    const original = store.getRevision({ ...target(agent), revision: 1 });
    const stale = target(agent);
    agent = store.saveDraft({
      ...target(agent),
      document: document("Version two"),
      attachmentIds: [],
    });
    expect(agent.currentRevision).toBe(1);
    expect(agent.hasUnpublishedChanges).toBe(true);
    expect(() =>
      store.saveDraft({
        ...stale,
        document: document("Overwrite"),
        attachmentIds: [],
      }),
    ).toThrow(/draft_conflict/);
    agent = store.publish(target(agent));
    agent = store.restore({ ...target(agent), revision: 1 });
    expect(agent.currentRevision).toBe(3);
    expect(agent.hasUnpublishedChanges).toBe(false);
    expect(store.getRevision({ ...target(agent), revision: 1 })).toEqual(
      original,
    );
    expect(store.getRevision({ ...target(agent), revision: 2 }).document).toBe(
      document("Version two"),
    );
    expect(store.getRevision({ ...target(agent), revision: 3 }).document).toBe(
      original.document,
    );
    expect(store.publish(target(agent)).currentRevision).toBe(3);
    expect(createAgentStore(db).getAgent(target(agent))).toEqual(agent);
  });

  it("requires publishable instructions and enforces exact project and archive state", () => {
    let agent = store.createAgent({ scope: project, document: document("") });
    expect(() => store.publish(target(agent))).toThrow(/instructions_required/);
    expect(() => store.getAgent({ agentId: agent.id, scope: library })).toThrow(
      /agent_not_found/,
    );
    expect(() =>
      store.getAgent({
        agentId: agent.id,
        scope: { kind: "project", projectId: "project-b" },
      }),
    ).toThrow(/agent_not_found/);
    agent = store.setArchived({ ...target(agent), archived: true });
    expect(() =>
      store.saveDraft({
        ...target(agent),
        document: document(),
        attachmentIds: [],
      }),
    ).toThrow(/agent_archived/);
    expect(
      store.listAgents({
        scope: project,
        search: "",
        includeArchived: false,
        limit: 50,
        offset: 0,
      }).total,
    ).toBe(0);
    agent = store.setArchived({ ...target(agent), archived: false });
    expect(
      store.listAgents({
        scope: project,
        search: "Review",
        includeArchived: false,
        limit: 50,
        offset: 0,
      }).agents[0]?.id,
    ).toBe(agent.id);
    expect(
      store.listAgents({
        scope: project,
        search: "%",
        includeArchived: false,
        limit: 50,
        offset: 0,
      }).total,
    ).toBe(0);
  });

  it("copies a selected revision and its files without later library edits changing the project copy", () => {
    let source = store.createAgent({
      scope: library,
      document: document("Original"),
    });
    source = store.addAttachment({
      ...target(source),
      name: "rules.md",
      mimeType: "text/markdown",
      content: Buffer.from("old rules"),
    });
    source = store.publish(target(source));
    const copy = store.copyToProject({
      ...target(source),
      revision: 1,
      projectId: project.projectId,
    });
    source = store.addAttachment({
      ...target(source),
      name: "rules.md",
      mimeType: "text/markdown",
      content: Buffer.from("new rules"),
    });
    source = store.saveDraft({
      ...target(source),
      document: document("Changed"),
      attachmentIds: source.draft.attachments.map((file) => file.id),
    });
    source = store.publish(target(source));
    expect(copy.sourceAgentId).toBe(source.id);
    expect(copy.sourceRevision).toBe(1);
    expect(copy.currentRevision).toBe(1);
    expect(store.getAgent(target(copy)).draft.document).toBe(
      document("Original"),
    );
    expect(copy.draft.attachments[0]?.id).not.toBe(
      source.draft.attachments[0]?.id,
    );
    const file = copy.draft.attachments[0];
    if (!file) throw new Error("Expected copied reference");
    expect(
      Buffer.from(
        store.readAttachment({ ...target(copy), attachmentId: file.id })
          .content,
      ).toString(),
    ).toBe("old rules");
    expect(() =>
      store.readAttachment({ ...target(source), attachmentId: file.id }),
    ).toThrow(/attachment_not_found/);
  });
});

describe("reference files", () => {
  it.each([
    "../escape.md",
    "folder/file.md",
    "C:\\file.md",
    "NUL.txt",
    "COM1",
    "file.",
    "bad:name",
  ])("rejects unsafe filename %s without changing the draft", (name) => {
    const agent = store.createAgent({ scope: library, document: document() });
    expect(() =>
      store.addAttachment({
        ...target(agent),
        name,
        mimeType: "text/plain",
        content: Buffer.from("data"),
      }),
    ).toThrow(/invalid_filename/);
    expect(store.getAgent(target(agent))).toEqual(agent);
  });

  it("retains removed historical files, deduplicates bytes, and detects blob corruption", () => {
    let agent = store.createAgent({ scope: library, document: document() });
    agent = store.addAttachment({
      ...target(agent),
      name: "rules.md",
      mimeType: "text/markdown",
      content: Buffer.from("rules"),
    });
    agent = store.addAttachment({
      ...target(agent),
      name: "copy.md",
      mimeType: "text/markdown",
      content: Buffer.from("rules"),
    });
    agent = store.publish(target(agent));
    const file = agent.draft.attachments[0];
    if (!file) throw new Error("Expected reference");
    expect(
      db.prepare("SELECT count(*) AS total FROM agent_attachment_blobs").get(),
    ).toEqual({ total: 1 });
    agent = store.saveDraft({
      ...target(agent),
      document: agent.draft.document,
      attachmentIds: [],
    });
    expect(
      store.getRevision({ ...target(agent), revision: 1 }).attachments,
    ).toHaveLength(2);
    expect(
      Buffer.from(
        store.readAttachment({ ...target(agent), attachmentId: file.id })
          .content,
      ).toString(),
    ).toBe("rules");
    db.prepare(
      "UPDATE agent_attachment_blobs SET content = ? WHERE sha256 = ?",
    ).run(Buffer.from("corrupt"), file.sha256);
    expect(() =>
      store.readAttachment({ ...target(agent), attachmentId: file.id }),
    ).toThrow(/attachment_corrupt/);
  });
});

describe("reviewable proposals", () => {
  it("keeps proposals separate, stores evidence, and never silently applies operational changes", () => {
    const agent = store.createAgent({ scope: project, document: document() });
    const metadata = defaultAgentMetadata("Reviewer");
    metadata.execution.permissionMode = "full";
    const proposal = store.propose({
      ...target(agent),
      document: serializeAgentDocument(metadata, "Updated instructions"),
      summary: "Update review",
      evidence: [
        {
          source: "README.md",
          detail: "Project documents review requirements",
        },
      ],
      authorThreadId: "thread-a",
    });
    expect(proposal.changedFields).toContain("instructions");
    expect(proposal.operationalChanges).toEqual(["execution.permissionMode"]);
    expect(store.getAgent(target(agent))).toEqual(agent);
    expect(() =>
      store.applyProposal({
        ...target(agent),
        proposalId: proposal.id,
        confirmOperationalChanges: false,
      }),
    ).toThrow(/operational_confirmation_required/);
    const updated = store.applyProposal({
      ...target(agent),
      proposalId: proposal.id,
      confirmOperationalChanges: true,
    });
    expect(updated.currentRevision).toBeNull();
    expect(updated.draft.metadata.execution.permissionMode).toBe("full");
    expect(
      store.getProposal({ ...target(agent), proposalId: proposal.id }).status,
    ).toBe("applied");
    expect(() =>
      store.rejectProposal({ ...target(agent), proposalId: proposal.id }),
    ).toThrow(/proposal_resolved/);
  });

  it("rejects stale and cross-agent proposals without overwriting newer edits", () => {
    let agent = store.createAgent({ scope: project, document: document() });
    const proposal = store.propose({
      ...target(agent),
      document: document("Proposal"),
      summary: "Review",
      evidence: [],
      authorThreadId: "thread-a",
    });
    const other = store.createAgent({ scope: project, document: document() });
    expect(() =>
      store.getProposal({ ...target(other), proposalId: proposal.id }),
    ).toThrow(/proposal_not_found/);
    agent = store.saveDraft({
      ...target(agent),
      document: document("Newer user edit"),
      attachmentIds: [],
    });
    expect(() =>
      store.applyProposal({
        ...target(agent),
        proposalId: proposal.id,
        confirmOperationalChanges: true,
      }),
    ).toThrow(/draft_conflict/);
    expect(store.getAgent(target(agent)).draft.document).toBe(
      document("Newer user edit"),
    );
    expect(
      store.rejectProposal({ ...target(agent), proposalId: proposal.id })
        .status,
    ).toBe("rejected");
  });
});

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignedSkillConfiguration,
  assignedSkillMigrations,
} from "./assigned-skills.js";
import { createAgentStore, migrations, type AgentStore } from "./data.js";
import {
  defaultAgentMetadata,
  describeAgentDocumentChanges,
  parseAgentDocument,
  serializeAgentDocument,
} from "./document.js";

const files = (body = "Read only the relevant sections.") => [
  {
    path: "SKILL.md",
    executable: false,
    contentBase64: Buffer.from(
      `---\nname: focused-reader\ndescription: Use when reading large files.\n---\n\n${body}\n`,
    ).toString("base64"),
  },
  {
    path: "references/Guide Δ.md",
    executable: false,
    contentBase64: Buffer.from("Keep this exact reference.\n").toString(
      "base64",
    ),
  },
];
let db: Database.Database;
let store: AgentStore;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec([...migrations, ...assignedSkillMigrations].join(";\n"));
  store = createAgentStore(db);
});
afterEach(() => db.close());

describe("assigned agent skills", () => {
  it("retains legacy document bytes and hashes without adding metadata", () => {
    const document = serializeAgentDocument(
      defaultAgentMetadata("Reader"),
      "Read carefully.",
    );
    const agent = store.createAgent({ scope: { kind: "library" }, document });
    expect(parseAgentDocument(document).document).toBe(document);
    expect(parseAgentDocument(document).metadata).not.toHaveProperty("skills");
    expect(
      store.saveDraft({
        agentId: agent.id,
        scope: agent.scope,
        expectedDraftVersion: 1,
        document,
        attachmentIds: [],
      }).draft.contentHash,
    ).toBe(agent.draft.contentHash);
  });
  it("pins full skill contents through publish, later edits and project copies", () => {
    const first = store.assignedSkills.save(files());
    const metadata = {
      ...defaultAgentMetadata("Reader"),
      schemaVersion: 2 as const,
      skills: [{ id: first.id, name: first.name }],
    };
    const draft = store.createAgent({
      scope: { kind: "library" },
      document: serializeAgentDocument(metadata, "Use assigned skills."),
    });
    const target = {
      agentId: draft.id,
      scope: draft.scope,
      expectedDraftVersion: draft.draft.version,
    };
    const published = store.publish(target);
    const second = store.assignedSkills.save(files("A changed instruction."));
    expect(second.id).not.toBe(first.id);
    store.saveDraft({
      ...target,
      expectedDraftVersion: published.draft.version,
      document: serializeAgentDocument(
        { ...metadata, skills: [{ id: second.id, name: second.name }] },
        "Use assigned skills.",
      ),
      attachmentIds: [],
    });
    const old = store.getRevision({ ...target, revision: 1 });
    const runtime = assignedSkillConfiguration(
      store,
      old.metadata.skills ?? [],
    );
    expect(runtime.experimental_skillSnapshots?.[0].files).toEqual(first.files);
    const copy = store.copyToProject({
      ...target,
      revision: 1,
      projectId: "project-a",
    });
    expect(copy.draft.metadata.skills).toEqual(old.metadata.skills);
  });
  it("refuses unsafe paths, case collisions, malformed base64 and missing entrypoints", () => {
    for (const invalid of [
      [{ ...files()[0], path: "../SKILL.md" }],
      [...files(), { ...files()[0], path: "skill.md" }],
      [{ ...files()[0], contentBase64: "!!!!" }],
      [{ ...files()[0], path: "other.md" }],
    ])
      expect(() => store.assignedSkills.save(invalid)).toThrow();
  });
  it("rejects missing or renamed pins and detects stored bundle corruption", () => {
    expect(() =>
      assignedSkillConfiguration(store, [
        { id: "a".repeat(64), name: "missing" },
      ]),
    ).toThrow(/assigned_skill_missing/);
    const skill = store.assignedSkills.save(files());
    expect(() =>
      assignedSkillConfiguration(store, [{ id: skill.id, name: "different" }]),
    ).toThrow(/assigned_skill_mismatch/);
    db.prepare(
      "UPDATE agent_skill_bundles SET bundle_json = ? WHERE id = ?",
    ).run(JSON.stringify({ ...skill, description: "Tampered" }), skill.id);
    expect(() => store.assignedSkills.read(skill.id)).toThrow(
      /assigned_skill_corrupt/,
    );
  });
  it("marks assignment changes as operational and rejects v1 assignments", () => {
    const before = serializeAgentDocument(defaultAgentMetadata(), "Work.");
    const skill = store.assignedSkills.save(files());
    const after = serializeAgentDocument(
      {
        ...defaultAgentMetadata(),
        schemaVersion: 2,
        skills: [{ id: skill.id, name: skill.name }],
      },
      "Work.",
    );
    expect(
      describeAgentDocumentChanges(before, after).operationalChanges,
    ).toContain("skills");
    expect(() =>
      serializeAgentDocument(
        { ...defaultAgentMetadata(), skills: [] },
        "Work.",
      ),
    ).toThrow();
  });
});

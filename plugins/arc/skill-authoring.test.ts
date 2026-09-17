import Database from "better-sqlite3";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentStore, migrations, type AgentStore } from "./data.js";
import { assignedSkillMigrations } from "./assigned-skills.js";
import { defaultAgentMetadata, serializeAgentDocument } from "./document.js";
import {
  parseSkillMarkdown,
  prepareSkillBundle,
  renderSkillMarkdown,
  skillBundleText,
} from "./skill-authoring.js";

let db: Database.Database;
let store: AgentStore;
const markdown =
  "---\nname: focused-reader\ndescription: Use when inspecting large files.\nlicense: MIT\nmetadata:\n  owner: ARC\n---\n\nRead relevant sections.\n";
beforeEach(() => {
  db = new Database(":memory:");
  db.exec([...migrations, ...assignedSkillMigrations].join(";\n"));
  store = createAgentStore(db);
});
afterEach(() => db.close());

describe("guided skill authoring", () => {
  it("preserves unchanged Markdown bytes and extra frontmatter during guided edits", () => {
    const fields = parseSkillMarkdown(markdown);
    expect(renderSkillMarkdown(markdown, fields)).toBe(markdown);
    const edited = renderSkillMarkdown(markdown, {
      ...fields,
      instructions: "Read the changed section and report evidence.\n",
    });
    expect(matter(edited).data).toEqual(matter(markdown).data);
    expect(parseSkillMarkdown(edited).instructions).toContain(
      "report evidence",
    );
  });
  it("retains binary assets, edits/removes selected support files and leaves assigned definitions untouched", () => {
    const original = store.assignedSkills.save([
      {
        path: "SKILL.md",
        contentBase64: Buffer.from(markdown).toString("base64"),
        executable: false,
      },
      { path: "assets/data.bin", contentBase64: "AAECAw==", executable: false },
      {
        path: "references/old.md",
        contentBase64: Buffer.from("old").toString("base64"),
        executable: false,
      },
    ]);
    const agent = store.createAgent({
      scope: { kind: "library" },
      document: serializeAgentDocument(
        {
          ...defaultAgentMetadata("Reader"),
          schemaVersion: 2,
          skills: [{ id: original.id, name: original.name }],
        },
        "Read carefully.",
      ),
    });
    const created = prepareSkillBundle(store, {
      baseSkillId: original.id,
      fields: {
        ...parseSkillMarkdown(markdown),
        instructions: "Follow references/new.md.\n",
      },
      supportingFiles: [
        {
          path: "references/new.md",
          text: "Check the line numbers.\n",
          executable: false,
        },
      ],
      removePaths: ["references/old.md"],
    });
    expect(created.id).not.toBe(original.id);
    expect(
      created.files.find((file) => file.path === "assets/data.bin"),
    ).toEqual(original.files.find((file) => file.path === "assets/data.bin"));
    expect(
      created.files.some((file) => file.path === "references/old.md"),
    ).toBe(false);
    expect(skillBundleText(created, "references/new.md")).toBe(
      "Check the line numbers.\n",
    );
    expect(store.assignedSkills.read(original.id)).toEqual(original);
    expect(
      store.getAgent({ agentId: agent.id, scope: agent.scope }).draft,
    ).toEqual(agent.draft);
  });
  it("validates final names and content and rejects support-file traversal and entry replacement", () => {
    const request = {
      baseSkillId: null,
      fields: parseSkillMarkdown(markdown),
      supportingFiles: [],
      removePaths: [],
    };
    expect(() =>
      prepareSkillBundle(store, {
        ...request,
        fields: { ...request.fields, name: "INVALID NAME" },
      }),
    ).toThrow();
    expect(() =>
      prepareSkillBundle(store, {
        ...request,
        fields: { ...request.fields, instructions: "" },
      }),
    ).toThrow();
    expect(() =>
      prepareSkillBundle(store, {
        ...request,
        supportingFiles: [
          { path: "../outside.md", text: "escape", executable: false },
        ],
      }),
    ).toThrow();
    expect(() =>
      prepareSkillBundle(store, {
        ...request,
        supportingFiles: [
          { path: "SKILL.md", text: "replacement", executable: false },
        ],
      }),
    ).toThrow("skill_entry_reserved");
  });
});

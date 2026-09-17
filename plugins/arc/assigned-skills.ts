import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import matter from "gray-matter";
import {
  experimental_assignedSkillSnapshotSchema,
  experimental_assignedSkillSnapshotsSchema,
  type PluginAgentConfiguration,
} from "@get-bb/plugin-sdk";
import {
  agentSkillBundleSchema,
  agentSkillFilesSchema,
  agentSkillReferencesSchema,
  type AgentSkillBundle,
  type AgentSkillReference,
} from "./skill-contract.js";
import type { AgentStore } from "./data.js";

export const assignedSkillMigrations = [
  `CREATE TABLE agent_skill_bundles (id TEXT PRIMARY KEY, name TEXT NOT NULL, bundle_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

export function createAssignedSkillStore(db: Database.Database) {
  function read(id: string): AgentSkillBundle {
    const row = db
      .prepare<[string], { bundleJson: string }>(
        "SELECT bundle_json AS bundleJson FROM agent_skill_bundles WHERE id = ?",
      )
      .get(id);
    if (!row)
      throw new Error(
        `assigned_skill_missing: Restore the pinned skill bundle ${id} before using this agent`,
      );
    const skill = agentSkillBundleSchema.parse(JSON.parse(row.bundleJson));
    const { id: storedId, ...snapshot } = skill;
    if (
      storedId !== id ||
      createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !== id
    )
      throw new Error(
        "assigned_skill_corrupt: The pinned skill contents no longer match their identity",
      );
    return skill;
  }
  function resolve(refs: readonly AgentSkillReference[]) {
    const resolved = agentSkillReferencesSchema.parse(refs).map((ref) => {
      const skill = read(ref.id);
      if (skill.name !== ref.name)
        throw new Error(
          "assigned_skill_mismatch: The assigned skill name does not match its pinned contents",
        );
      return skill;
    });
    experimental_assignedSkillSnapshotsSchema.parse(
      resolved.map(({ id: _id, ...snapshot }) => snapshot),
    );
    return resolved;
  }
  function save(input: unknown): AgentSkillBundle {
    const files = agentSkillFilesSchema
      .parse(input)
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    let size = 0;
    for (const file of files) {
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.toString("base64") !== file.contentBase64)
        throw new Error(
          "invalid_skill_encoding: A skill file has invalid base64",
        );
      size += bytes.length;
    }
    if (size > 1024 * 1024)
      throw new Error("skill_too_large: A skill directory cannot exceed 1 MiB");
    const entry = files.find((file) => file.path === "SKILL.md");
    if (!entry)
      throw new Error(
        "skill_entry_missing: Select a skill directory containing SKILL.md",
      );
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(entry.contentBase64, "base64"),
    );
    if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n"))
      throw new Error(
        "invalid_skill_frontmatter: SKILL.md must begin with YAML name and description between --- delimiters",
      );
    const parsed = matter(markdown);
    if (!parsed.content.trim())
      throw new Error(
        "skill_instructions_required: Add instructions below the SKILL.md frontmatter",
      );
    const snapshot = experimental_assignedSkillSnapshotSchema.parse({
      name: parsed.data.name,
      description: parsed.data.description,
      files,
    });
    const id = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const skill = { ...snapshot, id };
    db.prepare(
      "INSERT OR IGNORE INTO agent_skill_bundles (id, name, bundle_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, snapshot.name, JSON.stringify(skill), Date.now());
    return read(id);
  }
  return { read, save, resolve };
}

export function assignedSkillConfiguration(
  store: Pick<AgentStore, "assignedSkills">,
  refs: readonly AgentSkillReference[],
): Pick<PluginAgentConfiguration, "experimental_skillSnapshots"> {
  const snapshots = store.assignedSkills
    .resolve(refs)
    .map(({ id: _id, ...snapshot }) => snapshot);
  return {
    experimental_skillSnapshots:
      experimental_assignedSkillSnapshotsSchema.parse(snapshots),
  };
}

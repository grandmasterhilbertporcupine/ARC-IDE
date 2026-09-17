import matter from "gray-matter";
import {
  skillAuthoringFieldsSchema,
  prepareSkillBundleSchema,
  type AgentSkillBundle,
  type SkillAuthoringFields,
} from "./skill-contract.js";
import type { AgentStore } from "./data.js";

export function parseSkillMarkdown(markdown: string): SkillAuthoringFields {
  const parsed = matter(markdown);
  return skillAuthoringFieldsSchema.parse({
    name: parsed.data.name ?? "",
    description: parsed.data.description ?? "",
    instructions: parsed.content,
  });
}

export function renderSkillMarkdown(
  markdown: string,
  input: SkillAuthoringFields,
): string {
  const fields = skillAuthoringFieldsSchema.parse(input);
  const existing = parseSkillMarkdown(markdown);
  if (JSON.stringify(existing) === JSON.stringify(fields)) return markdown;
  const parsed = matter(markdown);
  return matter.stringify(fields.instructions, {
    ...parsed.data,
    name: fields.name,
    description: fields.description,
  });
}

export function skillBundleText(skill: AgentSkillBundle, path: string): string {
  const file = skill.files.find((entry) => entry.path === path);
  if (!file)
    throw new Error(
      "skill_file_missing: This pinned skill does not contain the requested file",
    );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(file.contentBase64, "base64"),
  );
  if (text.includes("\0"))
    throw new Error("skill_file_binary: This supporting file is binary");
  return text;
}

export function prepareSkillBundle(
  store: Pick<AgentStore, "assignedSkills">,
  input: unknown,
) {
  const args = prepareSkillBundleSchema.parse(input);
  const base =
    args.baseSkillId === null
      ? null
      : store.assignedSkills.read(args.baseSkillId);
  if (
    args.removePaths.includes("SKILL.md") ||
    args.supportingFiles.some((file) => file.path.toLowerCase() === "skill.md")
  )
    throw new Error(
      "skill_entry_reserved: Edit the guided fields for SKILL.md",
    );
  const files = new Map((base?.files ?? []).map((file) => [file.path, file]));
  for (const path of args.removePaths) files.delete(path);
  const markdown = renderSkillMarkdown(
    base === null ? "" : skillBundleText(base, "SKILL.md"),
    args.fields,
  );
  files.set("SKILL.md", {
    path: "SKILL.md",
    contentBase64: Buffer.from(markdown).toString("base64"),
    executable: false,
  });
  for (const file of args.supportingFiles)
    files.set(file.path, {
      path: file.path,
      contentBase64: Buffer.from(file.text).toString("base64"),
      executable: file.executable,
    });
  return store.assignedSkills.save([...files.values()]);
}

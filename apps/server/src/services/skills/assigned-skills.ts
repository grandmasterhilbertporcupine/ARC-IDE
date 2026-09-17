import matter from "gray-matter";
import {
  experimental_assignedSkillSnapshotsSchema,
  type ExperimentalAssignedSkillSnapshot,
} from "@get-bb/plugin-sdk";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import {
  hashSkillTreeEntries,
  type SkillTreeRegistry,
} from "./injected-skills.js";

export function stageAssignedSkillSnapshots(
  registry: SkillTreeRegistry,
  input: readonly ExperimentalAssignedSkillSnapshot[],
): HostDaemonInjectedSkillSource[] {
  return experimental_assignedSkillSnapshotsSchema
    .parse(input)
    .map((snapshot) => {
      const entries = snapshot.files.map((file) => {
        const bytes = Buffer.from(file.contentBase64, "base64");
        if (bytes.toString("base64") !== file.contentBase64)
          throw new Error(
            `Invalid assigned skill encoding: ${snapshot.name}/${file.path}`,
          );
        return {
          path: file.path,
          mode: file.executable ? 0o755 : 0o644,
          bytes,
        };
      });
      const entry = entries.find((file) => file.path === "SKILL.md");
      if (!entry)
        throw new Error(`Assigned skill ${snapshot.name} is missing SKILL.md`);
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
        entry.bytes,
      );
      const parsed = matter(markdown);
      if (
        parsed.data.name !== snapshot.name ||
        parsed.data.description?.trim() !== snapshot.description ||
        !parsed.content.trim()
      )
        throw new Error(
          `Assigned skill ${snapshot.name} does not match its SKILL.md metadata`,
        );
      const treeHash = hashSkillTreeEntries(entries);
      registry.register(
        { treeHash, entries },
        `assigned-skill:${snapshot.name}:${treeHash}`,
      );
      return {
        kind: "tree",
        required: true,
        sourceType: "data-dir",
        name: snapshot.name,
        description: snapshot.description,
        treeHash,
        entryPath: "SKILL.md",
      };
    });
}

import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentStore } from "./data.js";
import {
  agentSkillReferenceSchema,
  prepareSkillBundleSchema,
  type AgentSkillReference,
} from "./skill-contract.js";
import { prepareSkillBundle, skillBundleText } from "./skill-authoring.js";

export const skillAuthoringMigrations = [
  `CREATE TABLE skill_authoring_bundles (
    execution_context_id TEXT NOT NULL,
    skill_id TEXT NOT NULL REFERENCES agent_skill_bundles(id),
    PRIMARY KEY (execution_context_id, skill_id)
  )`,
];

export function registerSkillAuthoringTools(
  bb: BbPluginApi,
  db: Database.Database,
  store: AgentStore,
  authorize: (
    context: PluginAgentToolContext,
  ) => Promise<{ executionContextId: string; skills: AgentSkillReference[] }>,
) {
  const failure = (error: unknown): PluginAgentToolResult => ({
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  });
  async function requireBundle(
    id: string | null,
    context: PluginAgentToolContext,
  ) {
    const bound = await authorize(context);
    if (
      id !== null &&
      !bound.skills.some((skill) => skill.id === id) &&
      !db
        .prepare(
          "SELECT 1 FROM skill_authoring_bundles WHERE execution_context_id = ? AND skill_id = ?",
        )
        .get(bound.executionContextId, id)
    )
      throw new Error(
        "skill_scope_denied: This skill is not assigned to the bound authoring target or prepared in this conversation",
      );
    return bound;
  }
  bb.agents.registerTool({
    name: "arc_skill_bundle_create",
    description:
      "Prepare an immutable, unassigned SKILL.md bundle for this bound agent/team assistant. Fields are name, description (when to use), and instructions. Preserve files from an assigned base with optional supporting text edits/removals. Propose the returned reference with arc_agent_propose or arc_team_propose; this tool never changes a draft or publishes.",
    parameters: prepareSkillBundleSchema,
    async execute(input, context) {
      try {
        const bound = await requireBundle(input.baseSkillId, context);
        const skill = db.transaction(() => {
          const result = prepareSkillBundle(store, input);
          db.prepare(
            "INSERT OR IGNORE INTO skill_authoring_bundles (execution_context_id, skill_id) VALUES (?, ?)",
          ).run(bound.executionContextId, result.id);
          return result;
        })();
        return JSON.stringify({
          reference: { id: skill.id, name: skill.name },
          description: skill.description,
          files: skill.files.map((file) => ({
            path: file.path,
            executable: file.executable,
            bytes: Buffer.from(file.contentBase64, "base64").length,
          })),
          assigned: false,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
  bb.agents.registerTool({
    name: "arc_skill_bundle_read",
    description:
      "Read the file manifest or a bounded UTF-8 text section of an assigned skill or skill prepared in this bound authoring conversation. Binary files are retained by baseSkillId but cannot be read as text. Use path null for the manifest.",
    parameters: z
      .object({
        id: agentSkillReferenceSchema.shape.id,
        path: z.string().min(1).max(1024).nullable(),
        offset: z.number().int().min(0),
        limit: z.number().int().min(1).max(8192),
      })
      .strict(),
    async execute(input, context) {
      try {
        await requireBundle(input.id, context);
        const skill = store.assignedSkills.read(input.id);
        if (input.path === null)
          return JSON.stringify({
            reference: { id: skill.id, name: skill.name },
            description: skill.description,
            files: skill.files.map((file) => ({
              path: file.path,
              executable: file.executable,
              bytes: Buffer.from(file.contentBase64, "base64").length,
            })),
          });
        const text = skillBundleText(skill, input.path);
        const end = Math.min(text.length, input.offset + input.limit);
        return JSON.stringify({
          id: skill.id,
          path: input.path,
          offset: input.offset,
          content: text.slice(input.offset, end),
          totalCharacters: text.length,
          nextOffset: end < text.length ? end : null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}

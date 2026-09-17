import { z } from "zod";
import {
  experimental_assignedSkillFileSchema,
  experimental_assignedSkillSnapshotSchema,
} from "@get-bb/plugin-sdk";

export const agentSkillReferenceSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().regex(/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
  })
  .strict();
export const agentSkillReferencesSchema = z
  .array(agentSkillReferenceSchema)
  .max(32)
  .refine(
    (values) =>
      new Set(values.map((value) => value.name)).size === values.length,
    "Assign each skill name once",
  );
export const agentSkillBundleSchema =
  experimental_assignedSkillSnapshotSchema.safeExtend({
    id: agentSkillReferenceSchema.shape.id,
  });
export const agentSkillFilesSchema = z
  .array(experimental_assignedSkillFileSchema)
  .min(1)
  .max(128);
export type AgentSkillReference = z.infer<typeof agentSkillReferenceSchema>;
export type AgentSkillBundle = z.infer<typeof agentSkillBundleSchema>;
export const skillAuthoringFieldsSchema = z
  .object({
    name: z.string().max(64),
    description: z.string().max(1024),
    instructions: z.string().max(1000000),
  })
  .strict();
export type SkillAuthoringFields = z.infer<typeof skillAuthoringFieldsSchema>;
export const prepareSkillBundleSchema = z
  .object({
    baseSkillId: agentSkillReferenceSchema.shape.id.nullable(),
    fields: skillAuthoringFieldsSchema,
    supportingFiles: z
      .array(
        z
          .object({
            path: agentSkillFilesSchema.element.shape.path,
            text: z.string().max(1000000),
            executable: z.boolean(),
          })
          .strict(),
      )
      .max(127),
    removePaths: z.array(agentSkillFilesSchema.element.shape.path).max(127),
  })
  .strict()
  .refine(
    (value) =>
      value.fields.instructions.length +
        value.supportingFiles.reduce(
          (total, file) => total + file.text.length,
          0,
        ) <=
      1000000,
    "Skill authoring text exceeds the 1 MiB bundle limit",
  );

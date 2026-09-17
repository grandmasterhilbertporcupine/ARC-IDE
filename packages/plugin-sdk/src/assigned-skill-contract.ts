import { z } from "zod";

export const experimental_assignedSkillFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.includes("\\") &&
          value
            .split("/")
            .every(
              (part) =>
                part.length > 0 &&
                part !== "." &&
                part !== ".." &&
                !/[\x00-\x1f\x7f<>:"|?*]/u.test(part) &&
                !/[. ]$/u.test(part) &&
                !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
            ),
        "Skill files must use safe relative paths",
      ),
    contentBase64: z
      .string()
      .max(1_398_104)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
    executable: z.boolean(),
  })
  .strict();

export const experimental_assignedSkillSnapshotSchema = z
  .object({
    name: z.string().regex(/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u),
    description: z.string().trim().min(1).max(1024),
    files: z.array(experimental_assignedSkillFileSchema).min(1).max(128),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.files.map((file) => file.path.toLowerCase());
    if (
      paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
    )
      ctx.addIssue({
        code: "custom",
        message: "A skill file cannot also be a directory",
      });
    if (
      new Set(paths).size !== paths.length ||
      !value.files.some((file) => file.path === "SKILL.md")
    )
      ctx.addIssue({
        code: "custom",
        message: "A skill requires SKILL.md and unique file paths",
      });
    if (
      value.files.reduce(
        (total, file) => total + file.contentBase64.length,
        0,
      ) > 1_398_104
    )
      ctx.addIssue({
        code: "custom",
        message: "A skill bundle cannot exceed 1 MiB",
      });
  });

export const experimental_assignedSkillSnapshotsSchema = z
  .array(experimental_assignedSkillSnapshotSchema)
  .max(32)
  .superRefine((values, ctx) => {
    if (new Set(values.map((value) => value.name)).size !== values.length)
      ctx.addIssue({
        code: "custom",
        message: "Assigned skill names must be unique",
      });
    if (
      values.reduce(
        (total, skill) =>
          total +
          skill.files.reduce(
            (size, file) => size + file.contentBase64.length,
            0,
          ),
        0,
      ) > 5_592_408
    )
      ctx.addIssue({
        code: "custom",
        message: "Assigned skills cannot exceed 4 MiB",
      });
  });

export type ExperimentalAssignedSkillSnapshot = z.infer<
  typeof experimental_assignedSkillSnapshotSchema
>;

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentExecutionSchema } from "../contract.js";
import { teamCheckCommandSchema, teamDetailSchema } from "../teams/contract.js";

export const templateRoles = ["lead", "reader", "builder", "reviewer"] as const;
export const templateRoleSchema = z.enum(templateRoles);
export type TemplateRole = z.infer<typeof templateRoleSchema>;
const selection = agentExecutionSchema.refine(
  (value) => value.providerId !== null && value.model !== null,
  "Choose an available provider and model for this role",
);
export const templateRoleConfigurationSchema = z
  .object({
    lead: selection,
    reader: selection,
    builder: selection,
    reviewer: selection,
  })
  .strict();
export const templateConfigurationSchema = z
  .object({
    roles: templateRoleConfigurationSchema,
    check: teamCheckCommandSchema.refine(
      (value) => value.executable.length > 0,
      "Choose the project's required verification command",
    ),
  })
  .strict();
export type TemplateConfiguration = z.infer<typeof templateConfigurationSchema>;
const templateTarget = z
  .object({
    templateId: z.literal("efficient-build"),
    version: z.literal(1),
    projectId: z.string().trim().min(1).max(200),
  })
  .strict();
export const arcTemplatesRpcContract = defineRpcContract({
  listTeamTemplates: {
    input: z.null(),
    output: z
      .object({
        templates: z.array(
          z
            .object({
              id: z.literal("efficient-build"),
              version: z.literal(1),
              name: z.string(),
              description: z.string(),
              roles: z.array(
                z
                  .object({
                    id: templateRoleSchema,
                    name: z.string(),
                    responsibility: z.string(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  getTeamTemplateSetup: {
    input: templateTarget,
    output: z
      .object({
        configuration: templateConfigurationSchema.nullable(),
        defaultRoles: templateRoleConfigurationSchema.nullable(),
        defaultsSource: z.enum(["none", "global", "project"]),
        hostId: z.string(),
        blockers: z.array(z.string()),
      })
      .strict(),
  },
  instantiateTeamTemplate: {
    input: templateTarget.extend({
      operationId: z.string().trim().min(1).max(200),
      configuration: templateConfigurationSchema,
    }),
    output: z.object({ team: teamDetailSchema, reused: z.boolean() }).strict(),
  },
});
export type ArcTemplatesRpcContract = typeof arcTemplatesRpcContract;

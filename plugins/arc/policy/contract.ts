import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  DEFAULT_OWNED_RUN_LIMITS,
  ownedRunLimitsSchema,
} from "bb-plugin-workflows/owned-contract";
import { z } from "zod";

const id = z.string().trim().min(1).max(256);
const version = z.number().int().nonnegative();
export const teamPinSchema = z
  .object({
    teamId: z.string().regex(/^team_[a-f0-9-]{36}$/),
    revision: z.number().int().positive(),
  })
  .strict();
export type TeamPin = z.infer<typeof teamPinSchema>;
const pins = z
  .array(teamPinSchema)
  .max(100)
  .refine(
    (values) =>
      new Set(values.map((value) => value.teamId)).size === values.length,
    "Choose each team once, at one published version",
  );
export const autonomySchema = z.enum(["guided", "collaborative", "autonomous"]);
export const resolvedRunPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    autonomy: autonomySchema,
    preferredTeams: pins,
    restrictedTeams: pins.nullable(),
    limits: ownedRunLimitsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.restrictedTeams !== null &&
      value.preferredTeams.some(
        (preferred) =>
          !value.restrictedTeams!.some(
            (restricted) =>
              restricted.teamId === preferred.teamId &&
              restricted.revision === preferred.revision,
          ),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["preferredTeams"],
        message:
          "Preferred teams must be included in the allowed teams at the same published version",
      });
  });
export type ResolvedRunPolicy = z.infer<typeof resolvedRunPolicySchema>;
export function defaultRunPolicy(): ResolvedRunPolicy {
  return {
    schemaVersion: 1,
    autonomy: "collaborative",
    preferredTeams: [],
    restrictedTeams: null,
    limits: { ...DEFAULT_OWNED_RUN_LIMITS },
  };
}

export const sessionPolicyOverridesSchema = z
  .object({
    autonomy: autonomySchema.nullable(),
    preferredTeams: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("inherit") }).strict(),
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("teams"), teams: pins.min(1) }).strict(),
    ]),
    restrictedTeams: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("inherit") }).strict(),
      z.object({ kind: z.literal("unrestricted") }).strict(),
      z.object({ kind: z.literal("teams"), teams: pins }).strict(),
    ]),
    limits: ownedRunLimitsSchema.nullable(),
  })
  .strict();
export type SessionPolicyOverrides = z.infer<
  typeof sessionPolicyOverridesSchema
>;
export function defaultSessionOverrides(): SessionPolicyOverrides {
  return {
    autonomy: null,
    preferredTeams: { kind: "inherit" },
    restrictedTeams: { kind: "inherit" },
    limits: null,
  };
}
export function resolveRunPolicy(
  project: ResolvedRunPolicy,
  session: SessionPolicyOverrides,
): ResolvedRunPolicy {
  return resolvedRunPolicySchema.parse({
    schemaVersion: 1,
    autonomy: session.autonomy ?? project.autonomy,
    preferredTeams:
      session.preferredTeams.kind === "inherit"
        ? project.preferredTeams
        : session.preferredTeams.kind === "none"
          ? []
          : session.preferredTeams.teams,
    restrictedTeams:
      session.restrictedTeams.kind === "inherit"
        ? project.restrictedTeams
        : session.restrictedTeams.kind === "unrestricted"
          ? null
          : session.restrictedTeams.teams,
    limits: session.limits ?? project.limits,
  });
}

export const policyTargetSchema = z
  .object({ projectId: id, threadId: id.nullable() })
  .strict();
export type PolicyTarget = z.infer<typeof policyTargetSchema>;
export const projectPolicySchema = z
  .object({
    projectId: id,
    version,
    policy: resolvedRunPolicySchema,
    createdAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const sessionPolicySchema = z
  .object({
    projectId: id,
    threadId: id,
    version,
    overrides: sessionPolicyOverridesSchema,
    createdAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const policyViewSchema = z
  .object({
    project: projectPolicySchema,
    session: sessionPolicySchema.nullable(),
    effective: resolvedRunPolicySchema.nullable(),
    errors: z.array(z.string()),
  })
  .strict();
export const policyRevisionSchema = z
  .object({
    version: version.min(1),
    value: z.union([resolvedRunPolicySchema, sessionPolicyOverridesSchema]),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export const arcPolicyRpcContract = defineRpcContract({
  listPolicySessions: {
    input: z
      .object({
        projectId: id,
        limit: z.number().int().min(1).max(50),
        offset: z.number().int().nonnegative(),
      })
      .strict(),
    output: z
      .object({
        threads: z.array(z.object({ id, title: z.string() }).strict()),
        hasMore: z.boolean(),
      })
      .strict(),
  },
  getOrchestrationPolicy: {
    input: policyTargetSchema,
    output: policyViewSchema,
  },
  saveProjectPolicy: {
    input: z
      .object({
        projectId: id,
        expectedVersion: version,
        policy: resolvedRunPolicySchema,
      })
      .strict(),
    output: projectPolicySchema,
  },
  saveSessionPolicy: {
    input: z
      .object({
        projectId: id,
        threadId: id,
        expectedVersion: version,
        overrides: sessionPolicyOverridesSchema,
      })
      .strict(),
    output: policyViewSchema,
  },
  listPolicyRevisions: {
    input: policyTargetSchema
      .extend({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().nonnegative(),
      })
      .strict(),
    output: z
      .object({
        revisions: z.array(policyRevisionSchema),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  },
});
export type ArcPolicyRpcContract = typeof arcPolicyRpcContract;

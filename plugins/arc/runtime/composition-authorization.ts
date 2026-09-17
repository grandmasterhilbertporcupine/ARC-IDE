import { z } from "zod";
import { agentScopeSchema } from "../contract.js";
import { AgentStoreError } from "../data.js";
import type { ResolvedRunPolicy } from "../policy/contract.js";
import type { TeamRevision } from "../teams/contract.js";
import type { RunAgentSnapshot } from "./definition.js";
import { runtimeHash } from "./hash.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const compositionOriginSchema = z
  .object({
    kind: z.enum(["team", "agent"]),
    scope: agentScopeSchema,
    entityId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    contentHash: hash,
  })
  .strict()
  .superRefine((origin, context) => {
    if (!new RegExp(`^${origin.kind}_[a-f0-9-]{36}$`).test(origin.entityId))
      context.addIssue({
        code: "custom",
        path: ["entityId"],
        message:
          "The composition origin must identify its exact published kind",
      });
  });
export type CompositionOrigin = z.infer<typeof compositionOriginSchema>;
const originKey = (origin: CompositionOrigin) =>
  JSON.stringify([
    origin.kind,
    origin.scope.kind,
    origin.scope.kind === "project" ? origin.scope.projectId : null,
    origin.entityId,
    origin.revision,
  ]);
export const compositionAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(256),
    bindingHash: hash,
    origins: z.array(compositionOriginSchema).min(1).max(200),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.origins.map(originKey)).size === value.origins.length,
    "Composition origins must be unique",
  );
export type CompositionAuthorization = z.infer<
  typeof compositionAuthorizationSchema
>;
type Binding = {
  team: TeamRevision;
  members: Record<string, RunAgentSnapshot>;
};

export function sealCompositionAuthorization(
  projectId: string,
  binding: Binding,
  origins: readonly CompositionOrigin[],
): CompositionAuthorization {
  const unique = new Map<string, CompositionOrigin>();
  for (const value of origins) {
    const origin = compositionOriginSchema.parse(value);
    const previous = unique.get(originKey(origin));
    if (previous && previous.contentHash !== origin.contentHash)
      throw new AgentStoreError(
        "composition_origin_conflict",
        "A published composition origin has conflicting retained content",
      );
    unique.set(originKey(origin), origin);
  }
  const canonicalOrigins = [...unique]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, origin]) => origin);
  const authorization = compositionAuthorizationSchema.parse({
    schemaVersion: 1,
    projectId,
    bindingHash: runtimeHash({
      projectId,
      ...binding,
      origins: canonicalOrigins,
    }),
    origins: canonicalOrigins,
  });
  validateCompositionAuthorization(projectId, binding, authorization);
  return authorization;
}

export function validateCompositionAuthorization(
  projectId: string,
  binding: Binding,
  value: CompositionAuthorization,
) {
  const authorization = compositionAuthorizationSchema.parse(value);
  if (
    authorization.projectId !== projectId ||
    authorization.bindingHash !==
      runtimeHash({ projectId, ...binding, origins: authorization.origins }) ||
    authorization.origins.some(
      (origin) =>
        origin.scope.kind === "project" && origin.scope.projectId !== projectId,
    )
  )
    throw new AgentStoreError(
      "composition_authorization_mismatch",
      "The retained composition authorization does not match this project and its exact team and member snapshots",
    );
  return authorization;
}

export function compositionAllowedByPolicy(
  input: Binding & {
    projectId: string;
    policy: ResolvedRunPolicy;
    compositionAuthorization?: CompositionAuthorization;
  },
) {
  const authorization =
    input.compositionAuthorization === undefined
      ? undefined
      : validateCompositionAuthorization(
          input.projectId,
          { team: input.team, members: input.members },
          input.compositionAuthorization,
        );
  const allowed = input.policy.restrictedTeams;
  if (allowed === null) return true;
  if (authorization === undefined)
    return allowed.some(
      (pin) =>
        pin.teamId === input.team.teamId &&
        pin.revision === input.team.revision,
    );
  return authorization.origins.every(
    (origin) =>
      origin.kind === "team" &&
      origin.scope.kind === "project" &&
      origin.scope.projectId === input.projectId &&
      allowed.some(
        (pin) =>
          pin.teamId === origin.entityId && pin.revision === origin.revision,
      ),
  );
}

import { AgentStoreError } from "../data.js";
import type { ResolvedRunPolicy } from "../policy/contract.js";
import type { TeamRevision } from "../teams/contract.js";
import type { RunAgentSnapshot } from "./definition.js";
import { runtimeHash } from "./hash.js";
import {
  compositionAuthorizationSchema,
  compositionOriginSchema,
  compositionOriginKey as originKey,
  type CompositionAuthorization,
  type CompositionOrigin,
} from "./composition-authorization-contract.js";
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

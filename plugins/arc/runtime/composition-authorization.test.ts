import { describe, expect, it } from "vitest";
import { efficientBuildDefinition } from "../templates/catalog.js";
import type { TemplateConfiguration } from "../templates/contract.js";
import { teamHashes } from "../teams/validation.js";
import {
  composeAddressedTeams,
  type AddressedComponent,
} from "./addressed-composition.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { orchestratedRunRequestSchema } from "./orchestrated-contract.js";
import { directoryRunRequestSchema } from "./directory-contract.js";
import {
  compositionAllowedByPolicy,
  compositionAuthorizationSchema,
  sealCompositionAuthorization,
  type CompositionOrigin,
} from "./composition-authorization.js";

function fixture(kind: "git" | "directory" = "git") {
  const base = graphRunDefinitionFixture();
  const agent = base.members.builder!;
  const pin = {
    agentId: agent.definition.agentId,
    revision: agent.definition.revision,
  };
  const configuration: TemplateConfiguration = {
    roles: {
      lead: agent.execution,
      reader: agent.execution,
      builder: agent.execution,
      reviewer: agent.execution,
    },
    check: { executable: "node", args: ["--test"], timeoutMs: 60000 },
  };
  const components: AddressedComponent[] = [0, 1].map((index) => {
    const definition = efficientBuildDefinition(
      { lead: pin, reader: pin, builder: pin, reviewer: pin },
      configuration,
      kind,
    );
    definition.name = index === 0 ? "Frontend" : "Backend";
    return {
      revision: {
        ...base.team,
        teamId: `team_${index + 1}0000000-0000-4000-8000-000000000000`,
        ...teamHashes(definition),
      },
      members: Object.fromEntries(
        definition.members.map((member) => [member.id, agent]),
      ),
    };
  });
  const composed = composeAddressedTeams({
    operationId: "55555555-5555-4555-8555-555555555555",
    components,
    lead: agent,
    reviewer: agent,
    check: configuration.check,
    sourceKind: kind,
    createdAt: 1,
  });
  const origins: CompositionOrigin[] = components.map(({ revision }) => ({
    kind: "team",
    scope: { kind: "project", projectId: base.request.projectId },
    entityId: revision.teamId,
    revision: revision.revision,
    contentHash: revision.contentHash,
  }));
  const definition =
    kind === "git"
      ? orchestratedDefinitionFixture()
      : directoryDefinitionFixture();
  definition.team = composed.revision;
  definition.members = composed.members;
  definition.request.team = {
    teamId: composed.revision.teamId,
    revision: composed.revision.revision,
  };
  definition.request.addressedRecipients = origins.map((origin) => ({
    kind: origin.kind,
    entityId: origin.entityId,
    versionId: origin.revision,
    scopeKey: `project:${definition.request.projectId}`,
  }));
  definition.policy.restrictedTeams = origins.map((origin) => ({
    teamId: origin.entityId,
    revision: origin.revision,
  }));
  definition.compositionAuthorization = sealCompositionAuthorization(
    definition.request.projectId,
    { team: definition.team, members: definition.members },
    origins,
  );
  const compile = () =>
    definition.schemaVersion === 3
      ? compileArcOrchestratedRun(definition)
      : compileArcDirectoryRun(definition);
  return { definition, origins, components, compile };
}

describe("resolved addressed composition authorization", () => {
  it.each(["git", "directory"] as const)(
    "admits both allowed published recipients on %s without changing the policy",
    (kind) => {
      const state = fixture(kind);
      const policy = JSON.stringify(state.definition.policy);
      const compiled = state.compile();
      expect(JSON.stringify(compiled.definition.policy)).toBe(policy);
      expect(compiled.definition.compositionAuthorization?.origins).toEqual(
        state.origins,
      );
      expect(
        compiled.definition.policy.restrictedTeams?.some(
          (pin) => pin.teamId === compiled.definition.team.teamId,
        ),
      ).toBe(false);
      expect(
        compiled.workflow.steps.some((step) => step.kind === "agent"),
      ).toBe(true);
    },
  );

  it.each(["git", "directory"] as const)(
    "does not treat caller recipient labels as authority on %s",
    (kind) => {
      const state = fixture(kind);
      delete state.definition.compositionAuthorization;
      expect(() => state.compile()).toThrow(
        "outside the resolved session restriction",
      );
      state.definition.policy.restrictedTeams = null;
      expect(() => state.compile()).not.toThrow();
    },
  );

  it.each(["missing", "revision", "empty"] as const)(
    "rejects a %s allowlist entry",
    (change) => {
      const state = fixture();
      const allowed = state.definition.policy.restrictedTeams!;
      if (change === "missing") allowed.pop();
      if (change === "revision") allowed[0]!.revision++;
      if (change === "empty") allowed.length = 0;
      expect(() => state.compile()).toThrow(
        "outside the resolved session restriction",
      );
    },
  );

  it.each(["project", "team", "member", "origin"] as const)(
    "rejects changed %s data bound to an existing authorization",
    (change) => {
      const state = fixture();
      if (change === "project")
        state.definition.compositionAuthorization!.projectId = "other-project";
      if (change === "team")
        state.definition.team = {
          ...state.definition.team,
          ...teamHashes({
            ...state.definition.team.definition,
            description: "Another composition",
          }),
        };
      if (change === "member")
        state.definition.members.coordinator!.execution.model =
          "different-model";
      if (change === "origin")
        state.definition.compositionAuthorization!.origins[0]!.contentHash =
          "f".repeat(64);
      expect(() => state.compile()).toThrow("does not match this project");
    },
  );

  it("rejects standalone and library origins even if the synthetic ID is allowed", () => {
    const state = fixture();
    const binding = {
      team: state.definition.team,
      members: state.definition.members,
    };
    const projectId = state.definition.request.projectId;
    const standalone: CompositionOrigin = {
      kind: "agent",
      scope: { kind: "project", projectId },
      entityId: state.definition.members.coordinator!.definition.agentId,
      revision: 1,
      contentHash: state.definition.members.coordinator!.definition.contentHash,
    };
    const policy = {
      ...state.definition.policy,
      restrictedTeams: [state.definition.request.team],
    };
    expect(
      compositionAllowedByPolicy({
        ...binding,
        projectId,
        policy,
        compositionAuthorization: sealCompositionAuthorization(
          projectId,
          binding,
          [standalone],
        ),
      }),
    ).toBe(false);
    expect(
      compositionAllowedByPolicy({
        ...binding,
        projectId,
        policy: state.definition.policy,
        compositionAuthorization: sealCompositionAuthorization(
          projectId,
          binding,
          state.origins.map((origin) => ({
            ...origin,
            scope: { kind: "library" },
          })),
        ),
      }),
    ).toBe(false);
  });

  it("rejects attempts to inject internal authorization through public request schemas", () => {
    for (const kind of ["git", "directory"] as const) {
      const state = fixture(kind);
      const request = {
        ...state.definition.request,
        compositionAuthorization: state.definition.compositionAuthorization,
      };
      expect(
        (kind === "git"
          ? orchestratedRunRequestSchema
          : directoryRunRequestSchema
        ).safeParse(request).success,
      ).toBe(false);
    }
  });

  it("rejects empty, unsupported and conflicting origin records", () => {
    const state = fixture();
    const authorization = state.definition.compositionAuthorization!;
    expect(
      compositionAuthorizationSchema.safeParse({
        ...authorization,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      compositionAuthorizationSchema.safeParse({
        ...authorization,
        origins: [],
      }).success,
    ).toBe(false);
    expect(
      compositionAuthorizationSchema.safeParse({
        ...authorization,
        origins: [state.origins[0], state.origins[0]],
      }).success,
    ).toBe(false);
    expect(() =>
      sealCompositionAuthorization(
        state.definition.request.projectId,
        { team: state.definition.team, members: state.definition.members },
        [
          ...state.origins,
          { ...state.origins[0]!, contentHash: "f".repeat(64) },
        ],
      ),
    ).toThrow("conflicting retained content");
  });

  it("keeps project and library identities distinct even when a project is named library", () => {
    const state = fixture();
    const projectId = "library";
    const origin = state.origins[0]!;
    const authorization = sealCompositionAuthorization(
      projectId,
      { team: state.definition.team, members: state.definition.members },
      [
        { ...origin, scope: { kind: "library" } },
        { ...origin, scope: { kind: "project", projectId } },
      ],
    );
    expect(authorization.origins).toHaveLength(2);
    expect(
      compositionAllowedByPolicy({
        projectId,
        team: state.definition.team,
        members: state.definition.members,
        policy: state.definition.policy,
        compositionAuthorization: authorization,
      }),
    ).toBe(false);
  });

  it("retains absent authorization and identical plan hashes for serialized legacy definitions", () => {
    const graph = graphRunDefinitionFixture();
    const orchestrated = orchestratedDefinitionFixture();
    const directory = directoryDefinitionFixture();
    for (const compiled of [
      compileArcGraphRun(graph),
      compileArcOrchestratedRun(orchestrated),
      compileArcDirectoryRun(directory),
    ]) {
      expect(JSON.stringify(compiled)).not.toContain(
        "compositionAuthorization",
      );
      const definition = compiled.definition;
      const replay =
        definition.schemaVersion === 2
          ? compileArcGraphRun(JSON.parse(JSON.stringify(definition)))
          : definition.schemaVersion === 3
            ? compileArcOrchestratedRun(JSON.parse(JSON.stringify(definition)))
            : compileArcDirectoryRun(JSON.parse(JSON.stringify(definition)));
      expect(JSON.stringify(replay)).toBe(JSON.stringify(compiled));
    }
  });
});

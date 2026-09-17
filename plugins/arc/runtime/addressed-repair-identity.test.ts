import { describe, expect, it } from "vitest";
import { createTeamTestStore, teamTarget } from "../teams/testing.js";
import { efficientBuildDefinition } from "../templates/catalog.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import {
  composeAddressedTeams,
  type AddressedComponent,
} from "./addressed-composition.js";
import {
  addressedRepairIdentities,
  stabilizeAddressedRepairStages,
} from "./addressed-repair-identity.js";

describe("addressed repair identity", () => {
  it("preserves actual team repair identity when recipient order changes", () => {
    const state = createTeamTestStore();
    try {
      const base = orchestratedDefinitionFixture();
      const execution = base.members.builder.execution;
      const pin = {
        agentId: state.agent.id,
        revision: state.agent.currentRevision!,
      };
      const configuration = {
        roles: {
          lead: execution,
          reader: execution,
          builder: execution,
          reviewer: execution,
        },
        check: { executable: "node", args: ["--test"], timeoutMs: 120000 },
      };
      const member = {
        definition: state.agents.getRevision({ ...pin, scope: state.scope }),
        execution,
      };
      const components = ["A", "B"].map((name): AddressedComponent => {
        const definition = efficientBuildDefinition(
          { lead: pin, reader: pin, builder: pin, reviewer: pin },
          configuration,
          "git",
        );
        definition.name = name;
        const draft = state.store.createTeam({
          scope: state.scope,
          definition,
        });
        const published = state.store.publish(teamTarget(draft));
        return {
          revision: state.store.getRevision({
            scope: state.scope,
            teamId: published.id,
            revision: published.currentRevision!,
          }),
          members: Object.fromEntries(
            definition.members.map((entry) => [entry.id, member]),
          ),
        };
      });
      const compile = (order: AddressedComponent[]) => {
        const selected = composeAddressedTeams({
          operationId: "reordered",
          components: order,
          lead: member,
          reviewer: member,
          check: configuration.check,
          sourceKind: "git",
          createdAt: 1,
        });
        return compileArcOrchestratedRun({
          ...base,
          team: selected.revision,
          members: selected.members,
          request: {
            ...base.request,
            team: {
              teamId: selected.revision.teamId,
              revision: selected.revision.revision,
            },
            addressedRecipients: order.map((entry) => ({
              kind: "team",
              entityId: entry.revision.teamId,
              versionId: entry.revision.revision,
              scopeKey: "library",
            })),
          },
        });
      };
      const original = compile(components);
      const reordered = compile([...components].reverse());
      const a = addressedRepairIdentities(original, state.store);
      const b = addressedRepairIdentities(reordered, state.store);
      expect(a.get("recipient0-repair")).toBe(b.get("recipient1-repair"));
      expect(a.get("recipient1-repair")).toBe(b.get("recipient0-repair"));
      expect(a.get("recipient0-repair")).not.toBe(a.get("recipient1-repair"));
      const stabilized = stabilizeAddressedRepairStages(reordered, b);
      expect(
        new Set(
          stabilized.workflow.steps.flatMap((step) =>
            step.repair ? [step.repair.stageId] : [],
          ),
        ),
      ).toEqual(new Set(a.values()));
    } finally {
      state.db.close();
    }
  });
});

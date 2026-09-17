import { describe, expect, it } from "vitest";
import type { OwnedStepRef } from "bb-plugin-workflows/owned-contract";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";
import { efficientBuildDefinition } from "../templates/catalog.js";
import type { TemplateConfiguration } from "../templates/contract.js";
import { teamHashes } from "../teams/validation.js";
import {
  composeAddressedTeams,
  type AddressedComponent,
} from "./addressed-composition.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { compileArcGraphRun, type CompiledGraphRun } from "./graph-compiler.js";
import {
  compileArcDirectoryRun,
  type CompiledDirectoryRun,
} from "./directory-compiler.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";

function fixture(
  sourceKind: "git" | "directory" = "git",
  existingCondition = false,
  modelOverrides = false,
) {
  const base = graphRunDefinitionFixture();
  const agent = base.members.builder!;
  const execution = agent.execution;
  const configuration: TemplateConfiguration = {
    roles: {
      lead: execution,
      reader: execution,
      builder: execution,
      reviewer: execution,
    },
    check: { executable: "node", args: ["--test"], timeoutMs: 120000 },
  };
  const reference = {
    agentId: agent.definition.agentId,
    revision: agent.definition.revision,
  };
  const component = (name: string): AddressedComponent => {
    const definition = efficientBuildDefinition(
      {
        lead: reference,
        reader: reference,
        builder: reference,
        reviewer: reference,
      },
      configuration,
      sourceKind,
    );
    definition.name = name;
    if (modelOverrides)
      for (const member of definition.members)
        member.modelOverride = {
          providerId: "codex",
          model: `${name}-${member.id}`,
          reasoningLevel: "high",
          serviceTier: "default",
        };
    if (existingCondition) {
      definition.graph.nodes.push({
        id: "check-outcome",
        label: "Choose check outcome",
        kind: "condition",
        predicate: {
          kind: "outcome",
          sourceNodeId: "check",
          equals: "succeeded",
        },
      });
      definition.graph.edges.push(
        {
          id: "check-outcome",
          source: "check",
          target: "check-outcome",
          sourceHandle: "next",
          requiredOutcome: "completed",
        },
        {
          id: "outcome-review",
          source: "check-outcome",
          target: "review",
          sourceHandle: "true",
          requiredOutcome: "succeeded",
        },
        {
          id: "outcome-repair",
          source: "check-outcome",
          target: "repair",
          sourceHandle: "false",
          requiredOutcome: "succeeded",
        },
      );
    }
    return {
      revision: { ...base.team, ...teamHashes(definition) },
      members: Object.fromEntries(
        definition.members.map((member) => [
          member.id,
          member.modelOverride === undefined
            ? agent
            : {
                definition: agent.definition,
                execution: { ...agent.execution, ...member.modelOverride },
              },
        ]),
      ),
    };
  };
  const components = [component("Frontend team"), component("Backend team")];
  const before = JSON.stringify(components);
  const composed = composeAddressedTeams({
    operationId: "composite-test",
    components,
    lead: agent,
    reviewer: agent,
    check: { ...configuration.check, args: ["--test", "combined"] },
    sourceKind,
    createdAt: 1,
  });
  expect(JSON.stringify(components)).toBe(before);
  if (sourceKind === "directory") {
    const definition = directoryDefinitionFixture();
    definition.team = composed.revision;
    definition.members = composed.members;
    definition.request.team = { teamId: composed.revision.teamId, revision: 1 };
    return compileArcDirectoryRun(definition);
  }
  base.team = composed.revision;
  base.members = composed.members;
  base.request.team = { teamId: composed.revision.teamId, revision: 1 };
  return compileArcGraphRun(base);
}

function execute(
  compiled: CompiledGraphRun | CompiledDirectoryRun,
  failed: Set<string>,
) {
  const results = new Map<
    string,
    { state: "succeeded" | "failed"; selectedOutputs: string[] }
  >();
  const dispatched: Array<{
    origin: string | null;
    node: (typeof compiled.nodes)[string];
  }> = [];
  const choices = new Map<string, string>();
  const get = (ref: OwnedStepRef) => {
    const result = results.get(runtimeNodeKey(ref));
    if (!result)
      throw new Error(`Unadmitted dependency ${runtimeNodeKey(ref)}`);
    return result;
  };
  const result = executeWorkflowScript({
    args: compiled.workflow.args,
    body: parseWorkflowSource(compiled.workflow.source).body,
    capabilities: {
      agent: async () => {
        throw new Error("Unadmitted dispatch");
      },
      async step(nodeId, iteration) {
        const key = runtimeNodeKey({ nodeId, iteration });
        const node = compiled.nodes[key];
        if (!node) throw new Error(`Missing manifest step ${key}`);
        const origin = compiled.references.origins[key]?.graphNodeId ?? null;
        dispatched.push({ origin, node });
        let state: "succeeded" | "failed" =
          node.kind === "check" && failed.has(origin ?? "")
            ? "failed"
            : "succeeded";
        let selectedOutputs: string[] = [];
        if (node.kind === "control") {
          const op = node.operation;
          switch (op.type) {
            case "approval":
              selectedOutputs = ["approved"];
              break;
            case "barrier":
            case "delegation":
              selectedOutputs = ["next"];
              break;
            case "message-response":
            case "delegation-slot":
              selectedOutputs = ["skip"];
              break;
            case "condition": {
              const source = get(op.predicate.source);
              const predicate = op.predicate;
              const value =
                predicate.kind === "outcome"
                  ? source.state === predicate.equals
                  : predicate.kind === "check-exit"
                    ? (predicate.operator === "eq") ===
                      ((source.state === "succeeded" ? 0 : 1) ===
                        predicate.value)
                    : predicate.kind === "approval"
                      ? source.selectedOutputs.includes(predicate.equals)
                      : source.state ===
                        (predicate.equals === "approved"
                          ? "succeeded"
                          : "failed");
              selectedOutputs = [String(value)];
              break;
            }
            case "repair-result":
              state =
                get(op.check).state === "succeeded"
                  ? "succeeded"
                  : op.next === null
                    ? "failed"
                    : get(op.next).state;
              selectedOutputs = [
                state === "succeeded" ? "repaired" : "exhausted",
              ];
              break;
            case "candidate-choice": {
              const selected = op.branches.filter((branch) =>
                get(op.decision).selectedOutputs.includes(branch.output),
              );
              if (selected.length !== 1)
                throw new Error("Exactly one candidate must be selected");
              get(selected[0]!.candidate);
              choices.set(key, runtimeNodeKey(selected[0]!.candidate));
              selectedOutputs = ["next"];
              break;
            }
          }
        }
        results.set(key, { state, selectedOutputs });
        const receipt =
          node.kind === "control"
            ? { revision: 0, selectedOutputs, data: null }
            : null;
        if (state === "failed")
          throw Object.assign(new Error("Recorded failure"), {
            stepFailure: {
              workflowRunId: "workflow-test",
              ownerRunId: compiled.definition.runId,
              nodeId,
              iteration,
              attempt: 1,
              effectId: key,
              requestHash: "a".repeat(64),
              state: "failed",
              receipt,
              receiptHash: runtimeHash(receipt),
            },
          });
        return receipt;
      },
      log() {},
      phase() {},
    },
  });
  return { result, dispatched, choices };
}

describe("addressed recipient composition", () => {
  it.each(["git", "directory"] as const)(
    "retains each team's per-member model selection in a coordinated %s run",
    (sourceKind) => {
      const compiled = fixture(sourceKind, false, true);
      const selected = compiled.definition.team.definition.members.filter(
        (member) => member.modelOverride !== undefined,
      );
      expect(selected).toHaveLength(8);
      for (const member of selected) {
        const snapshot = compiled.definition.members[member.id]!;
        expect(snapshot.execution).toMatchObject(member.modelOverride!);
        expect(snapshot.definition.metadata.execution.model).toBeNull();
      }
    },
  );

  it.each([false, true])(
    "preserves two teams' check and bounded repair alternatives before combined verification (repair %s)",
    async (repair) => {
      const compiled = fixture();
      const run = execute(
        compiled,
        new Set(repair ? ["recipient0-check", "recipient1-check"] : []),
      );
      await expect(run.result).resolves.toBeDefined();
      const repairs = run.dispatched.filter(
        ({ node }) => node.kind === "agent" && node.purpose === "repair",
      );
      expect(repairs.map(({ origin }) => origin).sort()).toEqual(
        repair ? ["recipient0-repair", "recipient1-repair"] : [],
      );
      const reviews = run.dispatched
        .filter(
          ({ node }) => node.kind === "agent" && node.purpose === "review",
        )
        .map(({ origin }) => origin);
      expect(reviews).toEqual(
        expect.arrayContaining([
          "combined-review",
          `recipient0-${repair ? "review-repair" : "review"}`,
          `recipient1-${repair ? "review-repair" : "review"}`,
        ]),
      );
      expect(
        compiled.workflow.requiredGates.filter(
          (gate) =>
            gate.gateId.startsWith("team:recipient") && gate.mode === "any",
        ),
      ).toHaveLength(4);
      expect(
        compiled.definition.team.definition.graph.nodes
          .filter((node) => node.kind === "repair")
          .every((node) => node.maxRounds === 2),
      ).toBe(true);
      expect(
        run.dispatched.filter(
          ({ origin, node }) =>
            origin === "combined-check" && node.kind === "check",
        ),
      ).toHaveLength(1);
      expect(
        run.dispatched.filter(
          ({ origin, node }) =>
            origin === "combined-review" && node.kind === "verify",
        ),
      ).toHaveLength(1);
      const selections = [...run.choices].filter(([key]) =>
        compiled.references.origins[key]?.graphNodeId?.includes("arc-result"),
      );
      expect(selections).toHaveLength(2);
      expect(
        selections.every(([, selected]) =>
          compiled.references.origins[selected]?.graphNodeId?.endsWith(
            repair ? "-repair" : "-integrate",
          ),
        ),
      ).toBe(true);
    },
  );

  it("namespaces existing condition predicates without changing original team definitions", async () => {
    const compiled = fixture("git", true);
    expect(compiled.definition.team.definition.graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "recipient1-check-outcome",
        predicate: {
          kind: "outcome",
          sourceNodeId: "recipient1-check",
          equals: "succeeded",
        },
      }),
    );
    await expect(
      execute(compiled, new Set(["recipient0-check"])).result,
    ).resolves.toBeDefined();
  });

  it("serializes directory recipients on the previous selected candidate and verifies the combined result", async () => {
    const compiled = fixture("directory");
    expect(
      compiled.definition.team.definition.graph.nodes.some(
        (node) => node.kind === "integration",
      ),
    ).toBe(false);
    const run = execute(compiled, new Set(["recipient0-check"]));
    await expect(run.result).resolves.toBeDefined();
    const firstReview = run.dispatched.findIndex(
      ({ origin, node }) =>
        origin === "recipient0-review-repair" && node.kind === "agent",
    );
    const secondWriter = run.dispatched.findIndex(
      ({ origin, node }) =>
        origin === "recipient1-build" && node.kind === "agent",
    );
    expect(firstReview).toBeGreaterThan(-1);
    expect(secondWriter).toBeGreaterThan(firstReview);
    const second = compiled.definition.team.definition.graph.nodes.find(
      (node) => node.id === "recipient1-build",
    );
    expect(second).toMatchObject({
      candidate: {
        kind: "node",
        nodeId: expect.stringMatching(/^recipient0-arc-result/),
      },
    });
  });

  it("fails combined verification even when every recipient's individual check passed", async () => {
    const run = execute(fixture(), new Set(["combined-check"]));
    await expect(run.result).rejects.toThrow();
    expect(
      run.dispatched.some(
        ({ origin, node }) =>
          origin === "combined-review" && node.kind === "agent",
      ),
    ).toBe(false);
  });
});

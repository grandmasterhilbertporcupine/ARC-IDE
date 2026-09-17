import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { teamHashes } from "../teams/validation.js";
import { compileArcRun } from "./compiler.js";
import { runDefinitionSchema } from "./definition.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { graphRunDefinitionSchema } from "./graph-contract.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { orchestratedRunDefinitionSchema } from "./orchestrated-contract.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import { runDefinitionFixture } from "./testing.js";

function deterministic(input: unknown): unknown {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(input).replace(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
      (id) => {
        if (!ids.has(id))
          ids.set(
            id,
            `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`,
          );
        return ids.get(id)!;
      },
    ),
  );
}

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("retained Git compiler byte compatibility", () => {
  it("preserves deterministic V1, V2 and V3 compiled bytes", () => {
    const legacy = runDefinitionSchema.parse(
      deterministic(runDefinitionFixture()),
    );
    const graph = graphRunDefinitionSchema.parse(
      deterministic(graphRunDefinitionFixture()),
    );
    Object.assign(graph.team, teamHashes(graph.team.definition));
    const orchestrated = orchestratedRunDefinitionSchema.parse(
      deterministic(orchestratedDefinitionFixture()),
    );
    Object.assign(orchestrated.team, teamHashes(orchestrated.team.definition));
    const outputs = [
      compileArcRun(legacy),
      compileArcGraphRun(graph),
      compileArcOrchestratedRun(orchestrated),
    ];
    expect(
      outputs.map((compiled) => ({
        version: compiled.definition.schemaVersion,
        definitionBytes: digest(JSON.stringify(compiled.definition)),
        compiledBytes: digest(JSON.stringify(compiled)),
        sourceBytes: digest(compiled.workflow.source),
        planHash: compiled.workflow.planHash,
      })),
    ).toMatchSnapshot();
  });
});

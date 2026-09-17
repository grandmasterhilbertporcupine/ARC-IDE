import { describe, expect, it } from "vitest";
import { resolveRunAgentSnapshot } from "./execution-snapshot.js";
import { runDefinitionFixture } from "./testing.js";

describe("team member execution snapshots", () => {
  it("overrides only this member's model and tuning while keeping the published definition and permission mode", () => {
    const agent = runDefinitionFixture().writers[0]!;
    const original = JSON.stringify(agent.definition);
    const override = {
      providerId: "claude-code",
      model: "team-specific-model",
      reasoningLevel: "high",
      serviceTier: "default",
    } as const;
    const selected = resolveRunAgentSnapshot(
      agent.definition,
      { ...agent.execution, permissionMode: "full" },
      override,
    );
    expect(selected.execution).toEqual({
      ...override,
      permissionMode:
        agent.definition.metadata.execution.permissionMode ?? "full",
    });
    expect(JSON.stringify(selected.definition)).toBe(original);
    expect(JSON.stringify(agent.definition)).toBe(original);
    expect(
      resolveRunAgentSnapshot(agent.definition, agent.execution).execution,
    ).toEqual(agent.execution);
  });

  it("does not supply missing permission authority when a model override is complete", () => {
    const agent = runDefinitionFixture().writers[0]!;
    agent.definition.metadata.execution.permissionMode = null;
    expect(() =>
      resolveRunAgentSnapshot(agent.definition, null, {
        providerId: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    ).toThrow("execution_configuration_missing");
  });
});

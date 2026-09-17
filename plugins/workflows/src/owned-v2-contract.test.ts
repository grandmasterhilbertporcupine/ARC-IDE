import { describe, expect, it } from "vitest";
import {
  canonicalOwnedJson,
  ownedRunStartInputSchema,
  ownedRunStartSchema,
  ownedRunStartV2Schema,
  ownedStepObservationSchema,
  ownedStepObservationV2Schema,
  resolveOwnedRequirements,
} from "./owned-contract.js";
import { ownedRunInput } from "./owned-test-fixtures.js";
import {
  branchInput,
  decisionStep,
  v2Input,
  v2Step,
} from "./owned-v2-test-fixtures.js";

describe("versioned owned graph contract", () => {
  it("keeps unversioned V1 bytes without defaults and requires the explicit V2 discriminator", () => {
    const legacy = ownedRunInput();
    expect(canonicalOwnedJson(ownedRunStartInputSchema.parse(legacy))).toBe(
      canonicalOwnedJson(ownedRunStartSchema.parse(legacy)),
    );
    expect(ownedRunStartInputSchema.parse(legacy)).not.toHaveProperty(
      "schemaVersion",
    );
    const graph = branchInput();
    expect(ownedRunStartV2Schema.safeParse(graph).success).toBe(true);
    expect(ownedRunStartSchema.safeParse(graph).success).toBe(false);
    const { schemaVersion: _version, ...unversionedGraph } = graph;
    expect(ownedRunStartInputSchema.safeParse(unversionedGraph).success).toBe(
      false,
    );
    expect(
      ownedRunStartInputSchema.safeParse({ ...legacy, schemaVersion: 2 })
        .success,
    ).toBe(false);
  });

  it("requires declared control outputs, complete alternatives, known receipts and acyclic requirements", () => {
    const graph = branchInput();
    const check = graph.steps.find((step) => step.nodeId === "check");
    if (check === undefined) throw new Error("Missing selected join");
    const invalid = [
      v2Input({
        steps: [
          decisionStep(),
          v2Step("check", {
            requirements: [
              {
                kind: "selection",
                decision: { nodeId: "choice", iteration: 0 },
                output: "unknown",
              },
            ],
          }),
        ],
      }),
      v2Input({
        steps: [
          decisionStep(),
          v2Step("check", {
            requirements: [
              {
                kind: "selected",
                decision: { nodeId: "choice", iteration: 0 },
                branches: [{ output: "true", receipts: [] }],
              },
            ],
          }),
        ],
      }),
      v2Input({
        steps: [
          v2Step("check", {
            requirements: [
              {
                kind: "receipt",
                step: { nodeId: "missing", iteration: 0 },
                outcomes: ["succeeded"],
              },
            ],
          }),
        ],
      }),
      v2Input({
        steps: [
          v2Step("check", {
            requirements: [
              {
                kind: "receipt",
                step: { nodeId: "check", iteration: 0 },
                outcomes: ["succeeded"],
              },
            ],
          }),
        ],
      }),
      v2Input({
        steps: [
          v2Step("check", {
            control: { outputs: [{ id: "next", outcome: "succeeded" }] },
          }),
        ],
      }),
      v2Input({ steps: [v2Step("check", { kind: "owner-control" })] }),
      v2Input({
        steps: [
          v2Step("check", {
            kind: "owner-control",
            control: { outputs: [{ id: "next", outcome: "succeeded" }] },
            lane: {
              hostId: "host",
              repositoryId: "repo",
              target: { kind: "environment", id: "workspace" },
            },
          }),
        ],
      }),
    ];
    for (const input of invalid)
      expect(ownedRunStartV2Schema.safeParse(input).success).toBe(false);
  });

  it("resolves only retained selected alternatives and reports missing or unselected decisions explicitly", () => {
    const graph = branchInput();
    const check = graph.steps.find((step) => step.nodeId === "check");
    const right = graph.steps.find((step) => step.nodeId === "right");
    if (check === undefined || right === undefined)
      throw new Error("Missing branch fixture");
    expect(resolveOwnedRequirements(check, () => null)).toEqual({
      state: "pending",
      decision: { nodeId: "choice", iteration: 0 },
    });
    const decision = { revision: 3, selectedOutputs: ["true"], data: null };
    expect(resolveOwnedRequirements(right, () => decision)).toEqual({
      state: "unselected",
      decision: { nodeId: "choice", iteration: 0 },
      output: "false",
    });
    expect(resolveOwnedRequirements(check, () => decision)).toEqual({
      state: "ready",
      receipts: [
        {
          kind: "receipt",
          step: { nodeId: "choice", iteration: 0 },
          outcomes: ["succeeded", "failed"],
        },
        {
          kind: "receipt",
          step: { nodeId: "left", iteration: 0 },
          outcomes: ["succeeded"],
        },
      ],
    });
    const multiple = resolveOwnedRequirements(check, () => ({
      ...decision,
      selectedOutputs: ["true", "false"],
    }));
    expect(multiple.state).toBe("ready");
    if (multiple.state === "ready")
      expect(multiple.receipts.map((receipt) => receipt.step.nodeId)).toEqual([
        "choice",
        "left",
        "right",
      ]);
    expect(() =>
      resolveOwnedRequirements(check, () => ({
        ...decision,
        selectedOutputs: ["unknown"],
      })),
    ).toThrow("no admitted dependency branch");
  });

  it("validates control waiting revisions and immutable terminal receipt shape without weakening native evidence", () => {
    const waiting = {
      state: "waiting",
      resource: { kind: "owner-control", controlId: "approval" },
      revision: 0,
      waitReason: "user",
    };
    expect(ownedStepObservationV2Schema.safeParse(waiting).success).toBe(true);
    expect(ownedStepObservationSchema.safeParse(waiting).success).toBe(false);
    for (const value of [
      { ...waiting, revision: -1 },
      { ...waiting, waitReason: "forever" },
      {
        ...waiting,
        resource: { kind: "host-effect", hostId: "host", effectId: "effect" },
      },
    ])
      expect(ownedStepObservationV2Schema.safeParse(value).success).toBe(false);
    const terminal = {
      state: "succeeded",
      resource: waiting.resource,
      receipt: { revision: 1, selectedOutputs: ["approved"], data: null },
      receiptHash: "a".repeat(64),
      validity: { state: "current", identityHash: "b".repeat(64) },
    };
    expect(ownedStepObservationV2Schema.safeParse(terminal).success).toBe(true);
    for (const receipt of [
      { revision: 1, selectedOutputs: [], data: null },
      { revision: 1, selectedOutputs: ["approved", "approved"], data: null },
      {
        revision: 1,
        selectedOutputs: ["approved"],
        data: null,
        arbitrary: true,
      },
    ])
      expect(
        ownedStepObservationV2Schema.safeParse({ ...terminal, receipt })
          .success,
      ).toBe(false);
    expect(
      ownedStepObservationV2Schema.safeParse({
        ...terminal,
        resource: {
          kind: "agent",
          threadId: "thread",
          executionContextId: "context",
          environmentId: null,
          turnRequestId: null,
        },
      }).success,
    ).toBe(false);
  });
});

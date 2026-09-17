import { describe, expect, it } from "vitest";
import {
  canonicalOwnedJson,
  ownedJsonValueSchema,
  ownedRunStartSchema,
  ownedStepObservationSchema,
} from "./owned-contract.js";
import { admittedStep, ownedRunInput } from "./owned-test-fixtures.js";

describe("owned workflow admission contract", () => {
  it("requires fixed, unique, acyclic dependencies and explicit final gates", () => {
    const first = admittedStep("writer");
    const last = admittedStep("check", {
      dependencies: [
        { nodeId: "writer", iteration: 0, requiredOutcome: "succeeded" },
      ],
    });
    expect(
      ownedRunStartSchema.safeParse(ownedRunInput({ steps: [first, last] }))
        .success,
    ).toBe(true);
    expect(
      ownedRunStartSchema.safeParse(ownedRunInput({ steps: [last] })).success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(
        ownedRunInput({ steps: [first, first, last] }),
      ).success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(
        ownedRunInput({
          steps: [
            {
              ...first,
              dependencies: [
                { nodeId: "check", iteration: 0, requiredOutcome: "failed" },
              ],
            },
            last,
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(ownedRunInput({ requiredGates: [] }))
        .success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(
        ownedRunInput({
          requiredGates: [
            {
              gateId: "bad",
              mode: "any",
              steps: [{ nodeId: "missing", iteration: 0 }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unbounded iterations, unknown authority fields and excess repairs", () => {
    expect(
      ownedRunStartSchema.safeParse({ ...ownedRunInput(), owner: "other" })
        .success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(
        ownedRunInput({ steps: [admittedStep("check", { iteration: -1 })] }),
      ).success,
    ).toBe(false);
    expect(
      ownedRunStartSchema.safeParse(
        ownedRunInput({
          steps: [
            admittedStep("check", { repair: { stageId: "check", round: 4 } }),
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("retains explicit null and canonicalizes nested JSON without executing getters", () => {
    expect(ownedJsonValueSchema.parse(null)).toBeNull();
    expect(canonicalOwnedJson({ z: [{ b: 2, a: 1 }], a: null })).toBe(
      '{"a":null,"z":[{"a":1,"b":2}]}',
    );
    let invoked = false;
    expect(
      ownedJsonValueSchema.safeParse({
        get secret() {
          invoked = true;
          return 1;
        },
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const input of [
      cyclic,
      NaN,
      undefined,
      new Date(),
      Array(2),
      "x".repeat(1024 * 1024),
    ])
      expect(ownedJsonValueSchema.safeParse(input).success).toBe(false);
  });

  it("requires native dispatch evidence for a successful agent receipt", () => {
    const value = {
      state: "succeeded",
      resource: {
        kind: "agent",
        threadId: "t",
        executionContextId: "c",
        environmentId: "e",
        turnRequestId: null,
      },
      receipt: null,
      receiptHash: "a".repeat(64),
      validity: { state: "current", identityHash: "b".repeat(64) },
    };
    expect(ownedStepObservationSchema.safeParse(value).success).toBe(false);
    expect(
      ownedStepObservationSchema.safeParse({
        ...value,
        resource: { ...value.resource, turnRequestId: "turn" },
      }).success,
    ).toBe(true);
  });
});

import {
  DEFAULT_OWNED_RUN_LIMITS,
  type OwnedAdmittedStepV2,
  type OwnedControlWaitReason,
  type OwnedRunStartV2,
  type OwnedStepObservationV2,
  type OwnedStepRequestInput,
} from "./owned-contract.js";
import { hashOwnedValue } from "./owned-data.js";
import type { JsonValue } from "./types.js";

export function v2Step(
  nodeId: string,
  overrides: Partial<OwnedAdmittedStepV2> = {},
): OwnedAdmittedStepV2 {
  return {
    nodeId,
    iteration: 0,
    kind: "host-effect",
    definitionHash: hashOwnedValue(nodeId),
    requirements: [],
    lane: null,
    repair: null,
    control: null,
    ...overrides,
  };
}

export function decisionStep(nodeId = "choice"): OwnedAdmittedStepV2 {
  return v2Step(nodeId, {
    kind: "owner-control",
    control: {
      outputs: [
        { id: "true", outcome: "succeeded" },
        { id: "false", outcome: "succeeded" },
      ],
    },
  });
}

export function v2Input(
  overrides: Partial<OwnedRunStartV2> = {},
): OwnedRunStartV2 {
  return {
    schemaVersion: 2,
    ownerRunId: "graph-run-1",
    projectId: "project-1",
    originThreadId: "origin-1",
    planHash: hashOwnedValue("graph-plan"),
    source: `export const meta = {name: "graph", description: "Graph execution"}; return await step("check", 0, null);`,
    args: null,
    steps: [v2Step("check")],
    requiredGates: [
      {
        gateId: "verified",
        mode: "all",
        steps: [{ nodeId: "check", iteration: 0 }],
      },
    ],
    limits: { ...DEFAULT_OWNED_RUN_LIMITS },
    ...overrides,
  };
}

export function branchInput(): OwnedRunStartV2 {
  return v2Input({
    steps: [
      decisionStep(),
      v2Step("left", {
        kind: "agent",
        requirements: [
          {
            kind: "selection",
            decision: { nodeId: "choice", iteration: 0 },
            output: "true",
          },
        ],
      }),
      v2Step("right", {
        kind: "agent",
        requirements: [
          {
            kind: "selection",
            decision: { nodeId: "choice", iteration: 0 },
            output: "false",
          },
        ],
      }),
      v2Step("check", {
        requirements: [
          {
            kind: "selected",
            decision: { nodeId: "choice", iteration: 0 },
            branches: [
              {
                output: "true",
                receipts: [
                  {
                    kind: "receipt",
                    step: { nodeId: "left", iteration: 0 },
                    outcomes: ["succeeded"],
                  },
                ],
              },
              {
                output: "false",
                receipts: [
                  {
                    kind: "receipt",
                    step: { nodeId: "right", iteration: 0 },
                    outcomes: ["succeeded"],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ],
  });
}

export function waitingControl(
  request: OwnedStepRequestInput,
  revision = 0,
  waitReason: OwnedControlWaitReason = "user",
): Extract<OwnedStepObservationV2, { state: "waiting" }> {
  return {
    state: "waiting",
    resource: {
      kind: "owner-control",
      controlId: `control-${request.effectId}`,
    },
    revision,
    waitReason,
  };
}

export function controlReceipt(
  request: OwnedStepRequestInput,
  outputs: string[] = ["true"],
  revision = 1,
  state: "succeeded" | "failed" = "succeeded",
  data: JsonValue = null,
): Extract<
  OwnedStepObservationV2,
  {
    state: "succeeded" | "failed";
    resource: { kind: "owner-control"; controlId: string };
  }
> {
  const receipt = { revision, selectedOutputs: outputs, data };
  return {
    state,
    resource: {
      kind: "owner-control",
      controlId: `control-${request.effectId}`,
    },
    receipt,
    receiptHash: hashOwnedValue(receipt),
    validity: {
      state: "current",
      identityHash: hashOwnedValue("control-current"),
    },
  };
}

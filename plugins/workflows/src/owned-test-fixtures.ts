import {
  DEFAULT_OWNED_RUN_LIMITS,
  type OwnedAdmittedStep,
  type OwnedRunStart,
  type OwnedStepObservation,
  type OwnedStepRequest,
} from "./owned-contract.js";
import { hashOwnedValue } from "./owned-data.js";
import type { JsonValue } from "./types.js";

export function admittedStep(
  nodeId: string,
  overrides: Partial<OwnedAdmittedStep> = {},
): OwnedAdmittedStep {
  return {
    nodeId,
    iteration: 0,
    kind: "host-effect",
    definitionHash: hashOwnedValue(nodeId),
    dependencies: [],
    lane: null,
    repair: null,
    ...overrides,
  };
}

export function ownedRunInput(
  overrides: Partial<OwnedRunStart> = {},
): OwnedRunStart {
  return {
    ownerRunId: "arc-run-1",
    projectId: "project-1",
    originThreadId: "origin-1",
    planHash: hashOwnedValue("plan"),
    source: `export const meta = {name: "owned", description: "Admitted execution"}; return await step("check", 0, null);`,
    args: null,
    steps: [admittedStep("check")],
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

export function terminalReceipt(
  request: OwnedStepRequest,
  state: "succeeded" | "failed" | "interrupted" = "succeeded",
  receipt: JsonValue = null,
  kind: "agent" | "host-effect" = "host-effect",
): OwnedStepObservation {
  return {
    state,
    resource:
      kind === "host-effect"
        ? { kind, hostId: "host-1", effectId: request.effectId }
        : {
            kind,
            threadId: `thread-${request.effectId}`,
            executionContextId: `context-${request.effectId}`,
            environmentId: "environment-1",
            turnRequestId: `turn-${request.effectId}`,
          },
    receipt,
    receiptHash: hashOwnedValue(receipt),
    validity: { state: "current", identityHash: hashOwnedValue("identity") },
  };
}

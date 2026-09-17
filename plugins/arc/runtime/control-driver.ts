import type {
  OwnedDependencyReceipt,
  OwnedReceiptValidity,
  OwnedStepObservationV2,
  OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import type { HostWorkspaceState } from "../host-contract.js";
import type { DirectorySnapshot } from "../host-directory-contract.js";
import {
  directoryControlReceiptSchema,
  directoryRuntimeReceiptSchema,
  directoryReceiptSnapshot,
  type DirectoryRuntimeReceipt,
} from "./directory-receipt.js";
import { runControlContextInputSchema } from "./control-contract.js";
import type { ArcRunEffect, ArcRunStore } from "./data.js";
import type { GraphControlOperation } from "./graph-contract.js";
import {
  graphControlReceiptSchema,
  graphRuntimeReceiptSchema,
  type GraphControlReceipt,
  type GraphRuntimeReceipt,
} from "./graph-receipt.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";
import { receiptWorkspace, sameWorkspaceState } from "./receipt.js";

export function graphReceiptWorkspace(
  receipt: GraphRuntimeReceipt,
): HostWorkspaceState {
  if ("data" in receipt) {
    if (receipt.data.workspace === null)
      throw new AgentStoreError(
        "candidate_missing",
        "This decision has no candidate workspace",
      );
    return receipt.data.workspace;
  }
  return receiptWorkspace(receipt);
}

interface ControlDependencies {
  store: ArcRunStore;
  dependency(
    effect: ArcRunEffect,
    ref: OwnedStepRef,
  ): GraphRuntimeReceipt | DirectoryRuntimeReceipt;
  validity(
    effect: ArcRunEffect,
    signal: AbortSignal,
  ): Promise<OwnedReceiptValidity>;
}
type ControlCandidate = HostWorkspaceState | DirectorySnapshot;
type ControlData = Omit<GraphControlReceipt["data"], "workspace"> & {
  workspace: ControlCandidate | null;
};
function normalizedControl(
  input: GraphRuntimeReceipt | DirectoryRuntimeReceipt,
) {
  if (!("data" in input))
    throw new AgentStoreError(
      "receipt_conflict",
      "This dependency is not a control receipt",
    );
  return {
    ...input,
    data: {
      workspace:
        "snapshot" in input.data ? input.data.snapshot : input.data.workspace,
      decision: input.data.decision,
      check: input.data.check,
    },
  };
}
function controlCandidate(
  input: GraphRuntimeReceipt | DirectoryRuntimeReceipt,
): ControlCandidate {
  if ("data" in input) {
    const candidate = normalizedControl(input).data.workspace;
    if (candidate === null)
      throw new AgentStoreError(
        "candidate_missing",
        "This decision has no candidate",
      );
    return candidate;
  }
  if (
    input.kind === "directory-native" ||
    input.kind === "directory-agent" ||
    input.kind === "directory-preparation"
  ) {
    const candidate = directoryReceiptSnapshot(input);
    if (candidate === null)
      throw new AgentStoreError(
        "candidate_missing",
        "This directory stage did not produce a candidate",
      );
    return candidate;
  }
  return receiptWorkspace(input);
}
function sameControlCandidate(left: ControlCandidate, right: ControlCandidate) {
  if ("kind" in left || "kind" in right)
    return (
      "kind" in left &&
      "kind" in right &&
      runtimeHash(left) === runtimeHash(right)
    );
  return sameWorkspaceState(left, right);
}
export function createGraphControlDriver(deps: ControlDependencies) {
  const { store } = deps;
  function proof(effect: ArcRunEffect, ref: OwnedStepRef) {
    const value = effect.request.dependencyReceipts.find(
      (item) => runtimeNodeKey(item) === runtimeNodeKey(ref),
    );
    if (!value)
      throw new AgentStoreError(
        "dependency_missing",
        "This control is missing its admitted evidence",
      );
    return value;
  }
  function checkReceipt(effect: ArcRunEffect, initial: OwnedDependencyReceipt) {
    let current = initial;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current.effectId) || seen.size >= 4096)
        throw new AgentStoreError(
          "receipt_conflict",
          "Check evidence contains a cycle or exceeds the graph bound",
        );
      seen.add(current.effectId);
      const retained = store.effect(current.effectId);
      const observation = retained.observation;
      if (
        retained.runId !== effect.runId ||
        runtimeNodeKey(retained.request) !== runtimeNodeKey(current) ||
        !observation ||
        !("receipt" in observation) ||
        observation.receiptHash !== current.receiptHash ||
        observation.state !== current.outcome
      )
        throw new AgentStoreError(
          "receipt_conflict",
          "The forwarded check does not match this run's retained evidence",
        );
      const receipt =
        store.get(effect.runId).compiled.definition.schemaVersion === 4
          ? directoryRuntimeReceiptSchema.parse(observation.receipt)
          : graphRuntimeReceiptSchema.parse(observation.receipt);
      if ("data" in receipt) {
        if (receipt.data.check === null)
          throw new AgentStoreError(
            "check_missing",
            "This decision does not carry a native check",
          );
        current = receipt.data.check;
        continue;
      }
      if (
        !(
          (receipt.kind === "native" &&
            receipt.request.operation.type === "check") ||
          (receipt.kind === "directory-native" &&
            receipt.request.operation.type === "check-directory")
        )
      )
        throw new AgentStoreError(
          "check_missing",
          "This evidence is not a trusted native check",
        );
      return { proof: current, receipt };
    }
  }
  const control = (effect: ArcRunEffect, ref: OwnedStepRef) =>
    normalizedControl(deps.dependency(effect, ref));
  const workspace = (effect: ArcRunEffect, ref: OwnedStepRef) =>
    controlCandidate(deps.dependency(effect, ref));

  async function drive(
    effect: ArcRunEffect,
    operation: GraphControlOperation,
    signal: AbortSignal,
  ): Promise<OwnedStepObservationV2> {
    signal.throwIfAborted();
    const { compiled } = store.get(effect.runId);
    const definition = compiled.definition;
    if (definition.schemaVersion === 1)
      throw new AgentStoreError(
        "effect_conflict",
        "Owner controls require an admitted graph run",
      );
    const validity = await deps.validity(effect, signal);
    if (validity.state === "stale")
      return { state: "needs-reconciliation", reason: validity.reason };
    const resource = {
      kind: "owner-control" as const,
      controlId: effect.effectId,
    };
    const finish = (
      state: "succeeded" | "failed",
      selectedOutputs: string[],
      data: ControlData,
      revision = 0,
    ): OwnedStepObservationV2 => {
      const receipt =
        definition.schemaVersion === 4
          ? directoryControlReceiptSchema.parse({
              revision,
              selectedOutputs,
              data: {
                snapshot: data.workspace,
                decision: data.decision,
                check: data.check,
              },
            })
          : graphControlReceiptSchema.parse({
              revision,
              selectedOutputs,
              data,
            });
      return {
        state,
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity,
      };
    };
    const reserve = (
      candidate: ControlCandidate | null,
      proposedAssignments: Array<{ memberId: string }> | null,
    ) =>
      store.controls.reserve(
        runControlContextInputSchema.parse({
          schemaVersion: definition.schemaVersion === 4 ? 2 : 1,
          runId: effect.runId,
          effectId: effect.effectId,
          planHash: compiled.workflow.planHash,
          requestHash: effect.requestHash,
          nodeId: effect.request.nodeId,
          iteration: effect.request.iteration,
          operation,
          candidate,
          policyHash: runtimeHash(definition.policy),
          teamContentHash: definition.team.contentHash,
          dependencyReceipts: effect.request.dependencyReceipts,
          proposedAssignments,
        }),
      );
    const cancelled = (revision: number): OwnedStepObservationV2 => {
      const receipt = {
        revision,
        reason: "The run was cancelled while this decision was pending",
      };
      return {
        state: "interrupted",
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity,
      };
    };
    switch (operation.type) {
      case "message-response": {
        const question = deps.store.collaboration.selectQuestion(
          effect.runId,
          effect.effectId,
          operation.candidateMemberIds,
        );
        const memberId = question?.message.toMemberId ?? null;
        return finish(
          "succeeded",
          [memberId === null ? "skip" : `member:${memberId}`],
          {
            workspace: workspace(effect, operation.candidate),
            decision: {
              kind: "message-response",
              messageId: question?.id ?? null,
              memberId,
            },
            check: null,
          },
        );
      }
      case "barrier":
        return finish("succeeded", ["next"], {
          workspace: null,
          decision: { kind: "barrier" },
          check: null,
        });
      case "condition": {
        const predicate = operation.predicate;
        const input = deps.dependency(effect, predicate.source);
        let value: boolean;
        if (predicate.kind === "outcome")
          value = proof(effect, predicate.source).outcome === predicate.equals;
        else if (predicate.kind === "approval") {
          const decision = normalizedControl(input).data.decision;
          if (decision.kind !== "approval")
            throw new AgentStoreError(
              "condition_invalid",
              "This condition requires an approval receipt",
            );
          value = decision.value === predicate.equals;
        } else if (predicate.kind === "review-verdict") {
          if (
            !("kind" in input) ||
            (input.kind !== "agent" && input.kind !== "directory-agent") ||
            input.review === null
          )
            throw new AgentStoreError(
              "condition_invalid",
              "This condition requires an actual reviewer verdict",
            );
          value =
            (input.review.outcome === "approved" ? "approved" : "rejected") ===
            predicate.equals;
        } else {
          const check = checkReceipt(effect, proof(effect, predicate.source));
          const process = check.receipt.receipt.processes.at(-1);
          if (!process || process.interrupted || process.exitCode === null)
            throw new AgentStoreError(
              "condition_invalid",
              "A check must have a confirmed exit code before choosing a path",
            );
          value =
            predicate.operator === "eq"
              ? process.exitCode === predicate.value
              : process.exitCode !== predicate.value;
        }
        return finish("succeeded", [String(value)], {
          workspace: null,
          decision: { kind: "condition", value },
          check: null,
        });
      }
      case "approval": {
        const candidate =
          operation.candidate === null
            ? null
            : workspace(effect, operation.candidate);
        const current = reserve(candidate, null);
        if (current.state === "cancelled") return cancelled(current.revision);
        if (current.state === "pending")
          return {
            state: "waiting",
            resource,
            revision: current.revision,
            waitReason: "user",
          };
        if (current.decision === null || current.operationId === null)
          throw new AgentStoreError(
            "control_conflict",
            "The approval has no retained user decision",
          );
        return finish(
          current.decision === "approved" ? "succeeded" : "failed",
          [current.decision],
          {
            workspace: candidate,
            check: null,
            decision: {
              kind: "approval",
              value: current.decision,
              operationId: current.operationId,
              contextHash: current.contextHash,
            },
          },
          current.revision,
        );
      }
      case "repair-result": {
        const checked = checkReceipt(effect, proof(effect, operation.check));
        if (checked.proof.outcome === "succeeded") {
          const candidate = workspace(effect, operation.candidate);
          if (
            !sameControlCandidate(candidate, controlCandidate(checked.receipt))
          )
            throw new AgentStoreError(
              "candidate_changed",
              "The repaired candidate does not match its native check",
            );
          return finish("succeeded", ["repaired"], {
            workspace: candidate,
            check: checked.proof,
            decision: { kind: "repair", value: "repaired" },
          });
        }
        if (operation.next !== null) {
          const next = control(effect, operation.next);
          if (next.data.decision.kind !== "repair")
            throw new AgentStoreError(
              "receipt_conflict",
              "The next repair round did not produce a repair result",
            );
          return finish(
            next.data.decision.value === "repaired" ? "succeeded" : "failed",
            [next.data.decision.value],
            next.data,
          );
        }
        return finish("failed", ["exhausted"], {
          workspace: workspace(effect, operation.candidate),
          check: checked.proof,
          decision: { kind: "repair", value: "exhausted" },
        });
      }
      case "delegation": {
        const requester = proof(effect, operation.requester);
        const assignments = store.controls.delegation(requester.effectId);
        if (
          !assignments ||
          assignments.length > operation.maxChildCalls ||
          assignments.some(
            (item) => !operation.candidateMemberIds.includes(item.memberId),
          )
        )
          throw new AgentStoreError(
            "delegation_invalid",
            "The admitted requester did not provide a valid bounded assignment proposal",
          );
        const candidate = workspace(effect, operation.candidate);
        const decision = {
          kind: "delegation" as const,
          assignments: assignments.map(({ memberId }, slot) => ({
            slot,
            memberId,
          })),
        };
        let revision = 0;
        if (definition.policy.autonomy === "guided") {
          const current = reserve(candidate, assignments);
          if (current.state === "cancelled") return cancelled(current.revision);
          if (current.state === "pending")
            return {
              state: "waiting",
              resource,
              revision: current.revision,
              waitReason: "user",
            };
          revision = current.revision;
          if (current.decision === "rejected")
            return finish(
              "failed",
              ["rejected"],
              { workspace: candidate, decision, check: null },
              revision,
            );
          if (current.decision !== "approved")
            throw new AgentStoreError(
              "control_conflict",
              "This assignment has no retained approval",
            );
        }
        return finish(
          "succeeded",
          ["next"],
          { workspace: candidate, decision, check: null },
          revision,
        );
      }
      case "delegation-slot": {
        const input = control(effect, operation.decision);
        if (input.data.decision.kind !== "delegation")
          throw new AgentStoreError(
            "delegation_invalid",
            "This slot requires the admitted assignment decision",
          );
        const assignment = input.data.decision.assignments.find(
          (item) => item.slot === operation.slot,
        );
        const memberId = assignment?.memberId ?? null;
        if (
          memberId !== null &&
          !operation.candidateMemberIds.includes(memberId)
        )
          throw new AgentStoreError(
            "delegation_invalid",
            "This member is outside the declared candidates",
          );
        return finish(
          "succeeded",
          [memberId === null ? "skip" : `member:${memberId}`],
          {
            workspace: input.data.workspace,
            check: null,
            decision: {
              kind: "delegation-slot",
              slot: operation.slot,
              memberId,
            },
          },
        );
      }
      case "candidate-choice": {
        const decision = control(effect, operation.decision);
        const selected = operation.branches.filter((branch) =>
          decision.selectedOutputs.includes(branch.output),
        );
        if (selected.length !== 1)
          throw new AgentStoreError(
            "candidate_ambiguous",
            "This stage requires exactly one selected candidate",
          );
        const branch = selected[0];
        const candidate = workspace(effect, branch.candidate);
        const checked =
          branch.check === null
            ? null
            : checkReceipt(effect, proof(effect, branch.check));
        if (
          checked &&
          !sameControlCandidate(candidate, controlCandidate(checked.receipt))
        )
          throw new AgentStoreError(
            "candidate_changed",
            "Selected check and candidate do not match",
          );
        return finish("succeeded", ["next"], {
          workspace: candidate,
          check: checked?.proof ?? null,
          decision: { kind: "candidate", source: branch.candidate },
        });
      }
    }
  }
  function cancel(effect: ArcRunEffect): OwnedStepObservationV2 {
    const control = store.controls.find(effect.runId, effect.effectId);
    const revision =
      control === null
        ? 0
        : store.controls.cancel(effect.runId, effect.effectId).revision;
    const receipt = {
      revision,
      reason: "The run was cancelled before this control settled",
    };
    return {
      state: "interrupted",
      resource: { kind: "owner-control", controlId: effect.effectId },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: { state: "current", identityHash: effect.requestHash },
    };
  }
  return { drive, checkReceipt, cancel };
}

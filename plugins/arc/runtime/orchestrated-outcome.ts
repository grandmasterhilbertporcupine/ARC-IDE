import {
  ownedControlReceiptSchema,
  type OwnedReceiptRequirement,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import type { ArcRunEffect } from "./data.js";
import { runtimeNodeKey } from "./compiler.js";
import type { CompiledOrchestratedRun } from "./orchestrated-compiler.js";
import type { CompiledDirectoryRun } from "./directory-compiler.js";

type Outcome = "succeeded" | "failed" | "inactive" | "pending" | "unavailable";

export function orchestratedGraphOutcome(
  compiled: CompiledOrchestratedRun | CompiledDirectoryRun,
  effects: ArcRunEffect[],
) {
  const mainKey = runtimeNodeKey(compiled.references.mainCompletion);
  const steps = new Map(
    compiled.workflow.steps
      .filter((step) => runtimeNodeKey(step) !== mainKey)
      .map((step) => [runtimeNodeKey(step), step]),
  );
  const latest = new Map<string, ArcRunEffect>();
  for (const effect of effects) {
    const key = runtimeNodeKey(effect.request);
    if (!steps.has(key)) continue;
    const prior = latest.get(key);
    if (!prior || prior.request.attempt < effect.request.attempt)
      latest.set(key, effect);
    if (
      effect.observation === null ||
      ["running", "waiting", "needs-reconciliation"].includes(
        effect.observation.state,
      )
    )
      return {
        state: "pending" as const,
        reason: "Admitted team work has not settled",
      };
  }
  const outcomes = new Map<string, Outcome>();
  const visiting = new Set<string>();
  const selected = (ref: OwnedStepRef) => {
    const item = latest.get(runtimeNodeKey(ref));
    if (!item?.observation || !("receipt" in item.observation)) return null;
    const parsed = ownedControlReceiptSchema.safeParse(
      item.observation.receipt,
    );
    return parsed.success ? parsed.data.selectedOutputs : null;
  };
  const receiptOutcome = (requirement: OwnedReceiptRequirement): Outcome => {
    const outcome = evaluate(requirement.step);
    if (outcome === "pending" || outcome === "unavailable") return outcome;
    return outcome !== "inactive" && requirement.outcomes.includes(outcome)
      ? "succeeded"
      : "inactive";
  };
  const evaluate = (ref: OwnedStepRef): Outcome => {
    const key = runtimeNodeKey(ref);
    const existing = outcomes.get(key);
    if (existing) return existing;
    if (visiting.has(key)) return "unavailable";
    const step = steps.get(key);
    if (!step) return "unavailable";
    visiting.add(key);
    const calculate = (): Outcome => {
      for (const requirement of step.requirements) {
        if (requirement.kind !== "selection") continue;
        const decision = evaluate(requirement.decision);
        if (["inactive", "pending", "unavailable"].includes(decision))
          return decision;
        const outputs = selected(requirement.decision);
        if (outputs === null) return "unavailable";
        if (!outputs.includes(requirement.output)) return "inactive";
      }
      for (const requirement of step.requirements) {
        if (requirement.kind === "selection") continue;
        let receipts: OwnedReceiptRequirement[];
        if (requirement.kind === "receipt") receipts = [requirement];
        else {
          const decision = evaluate(requirement.decision);
          if (["inactive", "pending", "unavailable"].includes(decision))
            return decision;
          const outputs = selected(requirement.decision);
          if (outputs === null) return "unavailable";
          receipts = [];
          for (const output of outputs) {
            const branch = requirement.branches.find(
              (item) => item.output === output,
            );
            if (!branch) return "unavailable";
            receipts.push(...branch.receipts);
          }
        }
        for (const receipt of receipts) {
          const result = receiptOutcome(receipt);
          if (result !== "succeeded") return result;
        }
      }
      const effect = latest.get(key);
      const observation = effect?.observation;
      if (!observation || observation.state === "not-started") return "pending";
      if (!("receipt" in observation)) return "pending";
      if (observation.validity.state === "checking") return "pending";
      if (
        observation.state === "interrupted" ||
        observation.validity.state !== "current"
      )
        return "unavailable";
      return observation.state;
    };
    const result = calculate();
    visiting.delete(key);
    outcomes.set(key, result);
    return result;
  };
  const all = [...steps.values()].map(evaluate);
  if (all.includes("unavailable"))
    return {
      state: "unavailable" as const,
      reason:
        "Interrupted or stale team evidence cannot authorize an automatic response",
    };
  if (all.includes("pending"))
    return {
      state: "pending" as const,
      reason: "The selected team graph has unfinished work",
    };
  const gates = compiled.workflow.requiredGates
    .filter((gate) => gate.gateId !== "arc:main-completion")
    .map((gate) => ({
      gateId: gate.gateId,
      succeeded:
        gate.mode === "all"
          ? gate.steps.every((ref) => evaluate(ref) === "succeeded")
          : gate.steps.some((ref) => evaluate(ref) === "succeeded"),
    }));
  return {
    state: "settled" as const,
    outcome: gates.every((gate) => gate.succeeded)
      ? ("succeeded" as const)
      : ("failed" as const),
    gates,
    evidence: [...latest.values()]
      .filter(
        (effect) => outcomes.get(runtimeNodeKey(effect.request)) !== "inactive",
      )
      .map((effect) => {
        const observation = effect.observation;
        if (!observation || !("receipt" in observation))
          throw new Error("Settled graph evidence is missing");
        return {
          nodeId: effect.request.nodeId,
          iteration: effect.request.iteration,
          effectId: effect.effectId,
          outcome: observation.state,
          receiptHash: observation.receiptHash,
        };
      })
      .sort((left, right) =>
        runtimeNodeKey(left).localeCompare(runtimeNodeKey(right)),
      ),
  };
}

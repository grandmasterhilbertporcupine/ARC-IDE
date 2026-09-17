import type {
  BbPluginApi,
  ExperimentalTurnPreparation,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ownedStepObservationInputSchema as ownedStepObservationV2Schema,
  type OwnedReceiptValidityInput as OwnedReceiptValidity,
  type OwnedStepLookupInput,
  type OwnedStepObservationInput as OwnedStepObservationV2,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import type { ArcRunEffect, ArcRunStore } from "./data.js";
import { compiledOrchestratedRunSchema } from "./orchestrated-compiler.js";
import { compiledDirectoryRunSchema } from "./directory-compiler.js";
import type { OrchestratorRuntimeNode } from "./orchestrated-contract.js";
import { orchestratedGraphOutcome } from "./orchestrated-outcome.js";
import { orchestratorReceiptSchema } from "./orchestrated-receipt.js";
import { runtimeHash } from "./hash.js";

const busyPreparationError = z.object({
  status: z.literal(409),
  body: z.object({
    code: z.literal("prepared_turn_busy"),
    retryable: z.literal(true),
  }),
});

export function createOrchestratorTurnDriver(deps: {
  bb: BbPluginApi;
  store: ArcRunStore;
  canAdvance: (
    input: OwnedStepLookupInput,
    signal: AbortSignal,
  ) => Promise<boolean>;
  originValidity: (
    effect: ArcRunEffect,
    signal: AbortSignal,
  ) => Promise<OwnedReceiptValidity>;
  validateGraph: (
    effect: ArcRunEffect,
    effects: ArcRunEffect[],
    signal: AbortSignal,
  ) => Promise<{
    origin: OwnedReceiptValidity;
    observations: OwnedStepObservationV2[];
  }>;
  invalidateValidation?: (effect: ArcRunEffect) => void;
}) {
  const { bb, store } = deps;
  async function graphOutcome(effect: ArcRunEffect, signal: AbortSignal) {
    const compiled = z
      .union([compiledOrchestratedRunSchema, compiledDirectoryRunSchema])
      .parse(store.get(effect.runId).compiled);
    const effects = store.completionEffects(effect.runId);
    const terminal = effects.filter(
      (item) =>
        item.effectId !== effect.effectId &&
        item.observation &&
        "receipt" in item.observation &&
        compiled.nodes[`${item.request.nodeId}:${item.request.iteration}`]
          ?.kind !== "orchestrator",
    );
    const { origin, observations } = await deps.validateGraph(
      effect,
      terminal,
      signal,
    );
    signal.throwIfAborted();
    for (const [index, item] of terminal.entries())
      item.observation = observations[index];
    return {
      compiled,
      origin,
      outcome: orchestratedGraphOutcome(compiled, effects),
    };
  }
  async function drive(
    effect: ArcRunEffect,
    node: OrchestratorRuntimeNode,
    input: OwnedStepLookupInput,
    signal: AbortSignal,
    execute: boolean,
  ): Promise<OwnedStepObservationV2> {
    let validation: ReturnType<typeof graphOutcome> | undefined;
    const validate = () => (validation ??= graphOutcome(effect, signal));
    const assertBinding = (preparation: ExperimentalTurnPreparation) => {
      if (
        preparation.operationId !== effect.effectId ||
        preparation.threadId !== node.completion.threadId ||
        preparation.executionContextId !== effect.executionContextId ||
        preparation.environment.hostId !== node.completion.environment.hostId ||
        preparation.environment.environmentId !==
          node.completion.environment.environmentId ||
        preparation.environment.path !== node.completion.environment.path
      )
        throw new AgentStoreError(
          "execution_context_reused",
          "The prepared response belongs to another conversation or environment",
        );
    };
    let preparation = await bb.experimental_turns.getPreparation(
      { operationId: effect.effectId },
      { signal },
    );
    if (
      preparation === null &&
      effect.observation &&
      "resource" in effect.observation &&
      effect.observation.resource !== null
    )
      return {
        state: "needs-reconciliation",
        reason: "The retained main-turn preparation is missing",
      };
    const advance = await deps.canAdvance(input, signal);
    if (preparation === null && execute && advance) {
      const { compiled, outcome, origin } = await validate();
      if (
        compiled.definition.schemaVersion === 4 &&
        (origin.state === "checking" || outcome.state === "pending")
      )
        return {
          state: "not-started",
          reason:
            origin.state === "checking"
              ? origin.reason
              : outcome.state === "pending"
                ? outcome.reason
                : "Directory validation is pending",
        };
      if (outcome.state !== "settled")
        return { state: "needs-reconciliation", reason: outcome.reason };
      if (origin.state !== "current")
        return { state: "needs-reconciliation", reason: origin.reason };
      const final = store.finalVerification(effect.runId);
      const prompt = [
        `ARC team run ${effect.runId} has settled with outcome ${outcome.outcome}.`,
        `Goal: ${compiled.definition.request.goal}`,
        `Published team: ${compiled.definition.team.definition.name}, revision ${compiled.definition.team.revision}.`,
        `Required gates: ${outcome.gates.filter((gate) => gate.succeeded).length} succeeded of ${outcome.gates.length}. Gate preview: ${JSON.stringify(outcome.gates.slice(0, 20))}`,
        `Retained native evidence preview (${Math.min(outcome.evidence.length, 20)} of ${outcome.evidence.length}): ${JSON.stringify(outcome.evidence.slice(0, 20))}`,
        `Final verification preview (bounded to 12000 characters): ${JSON.stringify(final?.observation ?? null).slice(0, 12000)}`,
        "Give the user a concise, truthful report of the recorded result and any remaining decision. Required checks and review are native evidence; a worker's self-report does not verify them. The candidate remains isolated from the original project.",
        "This is one separately admitted completion turn in the same run budget. Do not edit files, execute commands, spawn workers, start another run, delegate, or perform further implementation. Propose follow-up work for a new user instruction. Opening or completing this response grants no new automatic budget.",
      ].join("\n\n");
      try {
        preparation = await bb.experimental_turns.prepare(
          {
            operationId: effect.effectId,
            projectId: compiled.definition.request.projectId,
            threadId: node.completion.threadId,
            executionContextId: effect.executionContextId,
            environment: node.completion.environment,
            execution: node.completion.execution,
            input: [{ type: "text", text: prompt, mentions: [] }],
          },
          { signal },
        );
      } catch (error) {
        if (!busyPreparationError.safeParse(error).success) throw error;
        deps.invalidateValidation?.(effect);
        preparation = await bb.experimental_turns.getPreparation(
          { operationId: effect.effectId },
          { signal },
        );
        if (preparation === null)
          return {
            state: "not-started",
            reason:
              "The main conversation has another admitted turn; this response retains its existing call admission while waiting",
          };
      }
    }
    if (preparation === null)
      return {
        state: "not-started",
        reason: "Core confirms this main turn was not prepared",
      };
    assertBinding(preparation);
    if (
      advance &&
      (preparation.state === "prepared" ||
        (preparation.state === "needs-reconciliation" &&
          preparation.dispatch?.clientTurnRequestId == null))
    ) {
      const { outcome } = await validate();
      if (
        outcome.state === "pending" &&
        store.get(effect.runId).compiled.definition.schemaVersion === 4
      )
        return {
          state: "running",
          resource: {
            kind: "agent",
            threadId: preparation.threadId,
            executionContextId: effect.executionContextId,
            environmentId: preparation.environment.environmentId,
            turnRequestId: preparation.dispatch?.clientTurnRequestId ?? null,
          },
        };
      if (outcome.state !== "settled")
        return { state: "needs-reconciliation", reason: outcome.reason };
      const origin = await deps.originValidity(effect, signal);
      if (origin.state === "checking")
        return {
          state: "running",
          resource: {
            kind: "agent",
            threadId: preparation.threadId,
            executionContextId: effect.executionContextId,
            environmentId: preparation.environment.environmentId,
            turnRequestId: preparation.dispatch?.clientTurnRequestId ?? null,
          },
        };
      if (origin.state !== "current")
        return { state: "needs-reconciliation", reason: origin.reason };
      if (await deps.canAdvance(input, signal)) {
        try {
          preparation = await bb.experimental_turns.startPrepared(
            {
              operationId: effect.effectId,
              expectedRevision: preparation.revision,
            },
            { signal },
          );
        } catch (error) {
          if (!busyPreparationError.safeParse(error).success) throw error;
          deps.invalidateValidation?.(effect);
          const retained = await bb.experimental_turns.getPreparation(
            { operationId: effect.effectId },
            { signal },
          );
          if (retained === null)
            return {
              state: "needs-reconciliation",
              reason:
                "The admitted main response disappeared while waiting for the conversation",
            };
          preparation = retained;
        }
      }
    }
    assertBinding(preparation);
    const resource = {
      kind: "agent" as const,
      threadId: preparation.threadId,
      executionContextId: effect.executionContextId,
      environmentId: preparation.environment.environmentId,
      turnRequestId: preparation.dispatch?.clientTurnRequestId ?? null,
    };
    if (
      (preparation.state === "cancelled" || preparation.state === "failed") &&
      resource.turnRequestId === null
    ) {
      const receipt = orchestratorReceiptSchema.parse({
        kind: "orchestrator-preparation",
        operationId: effect.effectId,
        threadId: preparation.threadId,
        executionContextId: effect.executionContextId,
        revision: preparation.revision,
        state: preparation.state,
        reason: preparation.reason,
      });
      return ownedStepObservationV2Schema.parse({
        state: preparation.state === "cancelled" ? "interrupted" : "failed",
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: {
          state: "current",
          identityHash: effect.request.definitionHash,
        },
      });
    }
    if (
      preparation.turn?.terminalEventId &&
      preparation.turn.terminalStatus &&
      resource.turnRequestId !== null
    ) {
      const receipt = orchestratorReceiptSchema.parse({
        kind: "orchestrator",
        operationId: effect.effectId,
        threadId: preparation.threadId,
        executionContextId: effect.executionContextId,
        turnRequestId: resource.turnRequestId,
        ...preparation.turn,
        definitionHash: effect.request.definitionHash,
      });
      return ownedStepObservationV2Schema.parse({
        state:
          receipt.kind === "orchestrator" &&
          receipt.terminalStatus === "completed"
            ? "succeeded"
            : preparation.turn.terminalStatus === "interrupted"
              ? "interrupted"
              : "failed",
        resource,
        receipt,
        receiptHash: runtimeHash(receipt),
        validity: await deps.originValidity(effect, signal),
      });
    }
    if (
      [
        "needs-reconciliation",
        "failed",
        "cancelled",
        "completed",
        "interrupted",
      ].includes(preparation.state)
    )
      return {
        state: "needs-reconciliation",
        reason:
          preparation.reason ??
          "The main turn has no matching native accepted and terminal event identity",
      };
    return { state: "running", resource };
  }
  return {
    drive,
    async interrupt(
      effect: ArcRunEffect,
      node: OrchestratorRuntimeNode,
      input: OwnedStepLookupInput,
      signal: AbortSignal,
    ) {
      const preparation = await bb.experimental_turns.getPreparation(
        { operationId: effect.effectId },
        { signal },
      );
      if (preparation !== null)
        await bb.experimental_turns.interrupt(
          {
            operationId: effect.effectId,
            expectedRevision: preparation.revision,
          },
          { signal },
        );
      return drive(effect, node, input, signal, false);
    },
    async validate(
      effect: ArcRunEffect,
      signal: AbortSignal,
    ): Promise<OwnedStepObservationV2> {
      const observation = effect.observation;
      if (!observation || !("receipt" in observation))
        throw new Error("A retained main-turn receipt is required");
      const receipt = orchestratorReceiptSchema.parse(observation.receipt);
      const preparation = await bb.experimental_turns.getPreparation(
        { operationId: effect.effectId },
        { signal },
      );
      const matches =
        preparation !== null &&
        preparation.operationId === effect.effectId &&
        receipt.operationId === effect.effectId &&
        preparation.threadId === receipt.threadId &&
        preparation.executionContextId === receipt.executionContextId &&
        (receipt.kind === "orchestrator"
          ? preparation.dispatch?.clientTurnRequestId ===
              receipt.turnRequestId &&
            preparation.turn?.acceptedEventId === receipt.acceptedEventId &&
            preparation.turn.terminalEventId === receipt.terminalEventId &&
            preparation.turn.providerThreadId === receipt.providerThreadId &&
            preparation.turn.turnId === receipt.turnId &&
            preparation.turn.terminalStatus === receipt.terminalStatus
          : preparation.state === receipt.state &&
            preparation.dispatch?.clientTurnRequestId == null);
      return ownedStepObservationV2Schema.parse({
        ...observation,
        validity: matches
          ? await deps.originValidity(effect, signal)
          : {
              state: "stale",
              reason:
                "The main response no longer matches its retained native identity",
            },
      });
    },
  };
}

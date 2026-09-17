import { ownedStepObservationV2Schema } from "bb-plugin-workflows/owned-contract";
import { hostEffectRequestSchema } from "../host-contract.js";
import { reviewVerdictSchema } from "./contract.js";
import { retainedGitCompiledRunSchema } from "./compiled.js";
import {
  gitWorkerBindingSchema,
  type ArcRunEffect,
  type ArcRunStore,
} from "./data.js";

export function gitRuntimeEffect(effect: ArcRunEffect) {
  return {
    ...effect,
    nativeRequest:
      effect.nativeRequest === null
        ? null
        : hostEffectRequestSchema.parse(effect.nativeRequest),
    workerBinding:
      effect.workerBinding === null
        ? null
        : gitWorkerBindingSchema.parse(effect.workerBinding),
    review:
      effect.review === null ? null : reviewVerdictSchema.parse(effect.review),
    observation:
      effect.observation === null
        ? null
        : ownedStepObservationV2Schema.parse(effect.observation),
  };
}
export type GitRuntimeEffect = ReturnType<typeof gitRuntimeEffect>;
export function createGitRuntimeStore(store: ArcRunStore) {
  return {
    ...store,
    get(runId: string) {
      const value = store.get(runId);
      return {
        ...value,
        compiled: retainedGitCompiledRunSchema.parse(value.compiled),
      };
    },
    effect(effectId: string) {
      return gitRuntimeEffect(store.effect(effectId));
    },
    findEffect(effectId: string) {
      const effect = store.findEffect(effectId);
      return effect && gitRuntimeEffect(effect);
    },
    previousAttempt(input: Parameters<ArcRunStore["previousAttempt"]>[0]) {
      const effect = store.previousAttempt(input);
      return effect && gitRuntimeEffect(effect);
    },
    repairConsumers(effectId: string) {
      return store.repairConsumers(effectId).map(gitRuntimeEffect);
    },
    approvalConsumers(effectId: string) {
      return store.approvalConsumers(effectId).map(gitRuntimeEffect);
    },
    completionEffects(runId: string) {
      return store.completionEffects(runId).map(gitRuntimeEffect);
    },
    recordObservation(
      effectId: string,
      input: Parameters<ArcRunStore["recordObservation"]>[1],
    ) {
      return ownedStepObservationV2Schema.parse(
        store.recordObservation(effectId, input),
      );
    },
  };
}

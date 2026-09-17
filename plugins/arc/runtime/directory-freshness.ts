import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  OwnedReceiptValidityInput,
  OwnedStepObservationLookupInput,
} from "bb-plugin-workflows/owned-contract";
import { arcHostContract } from "../host-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import type { DirectoryState } from "../host-directory-contract.js";
import type { ArcRunEffect, ArcRunStore } from "./data.js";
import type {
  DirectoryValidationIntent,
  DirectoryValidationPass,
} from "./directory-validation.js";
import { runtimeHash } from "./hash.js";

export function createDirectoryFreshness(bb: BbPluginApi, store: ArcRunStore) {
  const host = bb.hosts.experimental_client({ contract: arcHostContract });
  function result(pass: DirectoryValidationPass): {
    validity: OwnedReceiptValidityInput;
    states: DirectoryState[];
  } {
    const states: DirectoryState[] = [];
    if (pass.quiescent)
      return {
        validity: {
          state: "checking",
          validationId: pass.validationId,
          activity: "quiescent",
          reason: "Directory inspection is paused",
        },
        states,
      };
    if (
      pass.jobs.some((job) => pass.records[job.effectId]?.state !== "terminal")
    )
      return {
        validity: {
          state: "checking",
          validationId: pass.validationId,
          activity: "running",
          reason: "Waiting for every exact directory inspection to settle",
        },
        states: [],
      };
    for (const [index, job] of pass.jobs.entries()) {
      const record = pass.records[job.effectId];
      if (!record || record.state !== "terminal")
        return {
          validity: {
            state: "checking",
            validationId: pass.validationId,
            activity: "running",
            reason: "Inspecting the exact directory files",
          },
          states: [],
        };
      const receipt = record.receipt;
      const artifact = receipt?.artifact;
      if (receipt?.outcome !== "succeeded" || artifact?.kind !== "inspection")
        return {
          validity: {
            state: "stale",
            validationId: pass.validationId,
            reason:
              receipt?.reason ??
              "The directory inspection has no verified result",
          },
          states: [],
        };
      const expected = pass.intent.targets[index].expected;
      const actual = artifact.state;
      if (
        actual.path !== expected.path ||
        runtimeHash(actual.rootIdentity) !==
          runtimeHash(expected.rootIdentity) ||
        (expected.manifestDigest !== null &&
          actual.manifestDigest !== expected.manifestDigest)
      )
        return {
          validity: {
            state: "stale",
            validationId: pass.validationId,
            reason: `The exact directory source or candidate changed: ${expected.path}`,
          },
          states: [],
        };
      states.push(actual);
    }
    return {
      validity: {
        state: "current",
        validationId: pass.validationId,
        identityHash: runtimeHash({ contextHash: pass.contextHash, states }),
      },
      states,
    };
  }
  async function progress(pass: DirectoryValidationPass, signal: AbortSignal) {
    const hostId = store.get(pass.intent.runId).compiled.definition.request
      .hostId;
    await Promise.all(
      pass.jobs
        .filter((job) => pass.records[job.effectId]?.state !== "terminal")
        .slice(0, 4)
        .map(async (job) => {
          signal.throwIfAborted();
          const identity = {
            runId: job.runId,
            effectId: job.effectId,
            requestHash: directoryEffectRequestHash(job),
          };
          const observed = await host.call("observeDirectoryEffect", identity, {
            hostId,
            signal,
          });
          let record =
            observed ??
            (await host.call("startDirectoryEffect", job, { hostId, signal }));
          if (record.state === "needs-reconciliation")
            record =
              (await host.call("interruptDirectoryEffect", identity, {
                hostId,
                signal,
              })) ?? record;
          signal.throwIfAborted();
          store.directories.recordValidation(pass.validationId, record);
        }),
    );
    return store.directories.validation(pass.validationId);
  }
  async function validate(
    effect: ArcRunEffect,
    input: OwnedStepObservationLookupInput,
    options: Omit<
      DirectoryValidationIntent,
      "runId" | "effectId" | "generation"
    > & { terminal: boolean },
    signal: AbortSignal,
  ) {
    for (const active of store.directories.activeValidations(effect.effectId))
      if (
        active.intent.generation !== input.dispatchGeneration &&
        !(await interruptPass(effect, active, signal))
      )
        return {
          pass: active,
          validity: {
            state: "checking",
            validationId: active.validationId,
            activity: "running",
            reason: "Waiting for the previous directory inspection to stop",
          } as const,
          states: [],
        };
    const prior = store.directories.latestValidation(
      effect.effectId,
      input.dispatchGeneration,
      options.purpose,
    );
    const acknowledgment = "validation" in input ? input.validation : null;
    const replace =
      prior?.quiescent === true ||
      (options.terminal &&
        acknowledgment !== null &&
        prior !== null &&
        acknowledgment.validationId === prior.validationId &&
        acknowledgment.state === "current" &&
        acknowledgment.generation === input.dispatchGeneration);
    let pass = store.directories.reserveValidation(
      {
        runId: effect.runId,
        effectId: effect.effectId,
        generation: input.dispatchGeneration,
        purpose: options.purpose,
        phase: options.phase,
        targets: options.targets,
      },
      replace,
    );
    if (
      options.terminal &&
      (acknowledgment?.validationId !== pass.validationId ||
        acknowledgment.generation !== input.dispatchGeneration)
    ) {
      pass = await progress(pass, signal);
      return {
        pass,
        validity: {
          state: "checking",
          validationId: pass.validationId,
          activity: "running",
          reason:
            "Binding this exact directory inspection before accepting its result",
        } as const,
        states: [],
      };
    }
    pass = await progress(pass, signal);
    return { pass, ...result(pass) };
  }
  async function interruptPass(
    effect: ArcRunEffect,
    pass: DirectoryValidationPass,
    signal: AbortSignal,
  ) {
    const hostId = store.get(effect.runId).compiled.definition.request.hostId;
    let stopped = true;
    for (const job of pass.jobs) {
      if (pass.records[job.effectId]?.state === "terminal") continue;
      const record = await host.call(
        "interruptDirectoryEffect",
        {
          runId: job.runId,
          effectId: job.effectId,
          requestHash: directoryEffectRequestHash(job),
        },
        { hostId, signal },
      );
      signal.throwIfAborted();
      if (record) store.directories.recordValidation(pass.validationId, record);
      if (
        (record !== null && record.state !== "terminal") ||
        (record === null && pass.records[job.effectId] !== undefined)
      )
        stopped = false;
    }
    if (stopped) store.directories.quiesceValidation(pass.validationId);
    return stopped;
  }
  async function interrupt(effect: ArcRunEffect, signal: AbortSignal) {
    let stopped = true;
    for (const pass of store.directories.activeValidations(effect.effectId))
      if (!(await interruptPass(effect, pass, signal))) stopped = false;
    return stopped;
  }
  function consume(pass: DirectoryValidationPass) {
    store.directories.quiesceValidation(pass.validationId);
  }
  return { validate, interrupt, result, consume };
}

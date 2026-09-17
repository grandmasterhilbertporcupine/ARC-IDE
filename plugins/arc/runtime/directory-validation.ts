import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AgentStoreError } from "../data.js";
import {
  directoryEffectRecordSchema,
  directoryEffectRequestSchema,
  directoryRootSchema,
  directoryScanTargetSchema,
  directoryValidationPhaseSchema,
  directoryStateSchema,
  type DirectoryState,
  type DirectoryEffectRequest,
  type DirectoryEffectRecord,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import {
  directoryRunRequestSchema,
  directorySetupIntentSchema,
  type DirectoryRunRequest,
  type DirectorySetupIntent,
} from "./directory-contract.js";
import { runIdSchema, runtimeHashSchema } from "./definition.js";
import { runtimeHash } from "./hash.js";

export const directoryValidationMigrations = [
  `CREATE TABLE arc_directory_setups (
    project_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    validation_id TEXT NOT NULL UNIQUE,
    job_json TEXT NOT NULL,
    record_json TEXT,
    consumed_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, operation_id)
  )`,
  `CREATE TABLE arc_directory_validations (
    validation_id TEXT PRIMARY KEY,
    effect_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    jobs_json TEXT NOT NULL,
    records_json TEXT NOT NULL,
    quiescent INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX arc_directory_validations_by_effect ON arc_directory_validations(effect_id, generation, purpose, created_at DESC)",
  "CREATE TABLE arc_directory_worker_outputs (effect_id TEXT PRIMARY KEY, terminal_event_id TEXT NOT NULL, state_json TEXT NOT NULL)",
];

const consumptionSchema = z
  .object({ runId: runIdSchema, requestHash: runtimeHashSchema })
  .strict();
export const directorySetupRecordSchema = z
  .object({
    intent: directorySetupIntentSchema,
    requestHash: runtimeHashSchema,
    job: directoryEffectRequestSchema,
    record: directoryEffectRecordSchema.nullable(),
    consumed: consumptionSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DirectorySetupRecord = z.infer<typeof directorySetupRecordSchema>;

type SetupKey = { projectId: string; operationId: string };
interface SetupRow {
  requestHash: string;
  intentJson: string;
  jobJson: string;
  recordJson: string | null;
  consumedJson: string | null;
  createdAt: number;
}
const selectSetup = `SELECT request_hash AS requestHash, intent_json AS intentJson, job_json AS jobJson,
  record_json AS recordJson, consumed_json AS consumedJson, created_at AS createdAt FROM arc_directory_setups`;

function decodeSetup(row: SetupRow): DirectorySetupRecord {
  return directorySetupRecordSchema.parse({
    requestHash: row.requestHash,
    intent: JSON.parse(row.intentJson),
    job: JSON.parse(row.jobJson),
    record: row.recordJson === null ? null : JSON.parse(row.recordJson),
    consumed: row.consumedJson === null ? null : JSON.parse(row.consumedJson),
    createdAt: row.createdAt,
  });
}

export function createDirectoryValidationStore(db: Database.Database) {
  function getSetup(key: SetupKey): DirectorySetupRecord | null {
    const row = db
      .prepare<[string, string], SetupRow>(
        `${selectSetup} WHERE project_id = ? AND operation_id = ?`,
      )
      .get(key.projectId, key.operationId);
    return row ? decodeSetup(row) : null;
  }
  function getSetupByInspection(key: {
    projectId: string;
    sourceInspectionId: string;
  }): DirectorySetupRecord | null {
    const row = db
      .prepare<[string, string], SetupRow>(
        `${selectSetup} WHERE project_id = ? AND validation_id = ?`,
      )
      .get(key.projectId, key.sourceInspectionId);
    return row ? decodeSetup(row) : null;
  }
  return {
    ...createEffectValidationStore(db),
    getSetup,
    getSetupByInspection,
    reserveSetup(input: DirectorySetupIntent): DirectorySetupRecord {
      const intent = directorySetupIntentSchema.parse(input);
      const requestHash = runtimeHash(intent);
      return db.transaction(() => {
        const prior = getSetup(intent);
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new AgentStoreError(
              "directory_setup_conflict",
              "This setup operation belongs to another source or main conversation",
            );
          return prior;
        }
        const owner = `arc_setup_${runtimeHash({ projectId: intent.projectId, operationId: intent.operationId })}`;
        const validationId = `arc_validation_${randomUUID()}`;
        const job = directoryEffectRequestSchema.parse({
          kind: "directory",
          runId: owner,
          effectId: `arc_scan_${randomUUID()}`,
          lane: null,
          operation: {
            type: "scan-directory",
            target: { kind: "path", path: intent.path },
            consumer: { kind: "setup", operationId: owner },
            phase: "admission",
            validationId,
          },
        });
        db.prepare(
          "INSERT INTO arc_directory_setups (project_id, operation_id, request_hash, intent_json, validation_id, job_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          intent.projectId,
          intent.operationId,
          requestHash,
          JSON.stringify(intent),
          validationId,
          JSON.stringify(job),
          Date.now(),
        );
        return getSetup(intent)!;
      })();
    },
    recordSetupInspection(
      input: SetupKey & { record: DirectoryEffectRecord },
    ): DirectorySetupRecord {
      const record = directoryEffectRecordSchema.parse(input.record);
      return db.transaction(() => {
        const setup = getSetup(input);
        if (!setup)
          throw new AgentStoreError(
            "directory_setup_missing",
            "The directory setup operation is missing",
          );
        if (
          record.runId !== setup.job.runId ||
          record.effectId !== setup.job.effectId ||
          record.requestHash !== directoryEffectRequestHash(setup.job)
        )
          throw new AgentStoreError(
            "directory_setup_conflict",
            "The inspection belongs to another retained setup job",
          );
        if (setup.record?.state === "terminal") {
          if (record.state !== "terminal") return setup;
          if (runtimeHash(record) !== runtimeHash(setup.record))
            throw new AgentStoreError(
              "directory_setup_conflict",
              "A terminal inspection cannot change its retained result",
            );
          return setup;
        }
        if (record.receipt?.artifact?.kind === "inspection") {
          const operation = setup.job.operation;
          const artifact = record.receipt.artifact;
          if (
            operation.type !== "scan-directory" ||
            artifact.validationId !== operation.validationId ||
            runtimeHash(artifact.consumer) !==
              runtimeHash(operation.consumer) ||
            artifact.phase !== operation.phase
          )
            throw new AgentStoreError(
              "directory_setup_conflict",
              "The inspection receipt does not identify this validation pass",
            );
        }
        db.prepare(
          "UPDATE arc_directory_setups SET record_json = ? WHERE project_id = ? AND operation_id = ?",
        ).run(JSON.stringify(record), input.projectId, input.operationId);
        return getSetup(input)!;
      })();
    },
    consumeSetup<T>(
      input: DirectoryRunRequest,
      runId: string,
      reserve: () => T,
    ): T {
      const request = directoryRunRequestSchema.parse(input);
      const consumption = consumptionSchema.parse({
        runId,
        requestHash: runtimeHash(request),
      });
      return db.transaction(() => {
        const setup = getSetupByInspection(request);
        const artifact = setup?.record?.receipt?.artifact;
        if (
          !setup ||
          setup.record?.state !== "terminal" ||
          setup.record.receipt?.outcome !== "succeeded" ||
          artifact?.kind !== "inspection"
        )
          throw new AgentStoreError(
            "directory_setup_pending",
            "Complete the directory source inspection before starting this run",
          );
        if (
          setup.intent.originThreadId !== request.originThreadId ||
          setup.intent.hostId !== request.hostId ||
          setup.intent.path !== request.path ||
          artifact.state.path !== request.path ||
          artifact.state.manifestDigest !==
            request.expectedSource.manifestDigest ||
          runtimeHash(artifact.state.rootIdentity) !==
            runtimeHash(request.expectedSource.rootIdentity)
        )
          throw new AgentStoreError(
            "directory_source_changed",
            "The run does not match the exact inspected source and main conversation",
          );
        if (
          setup.consumed &&
          runtimeHash(setup.consumed) !== runtimeHash(consumption)
        )
          throw new AgentStoreError(
            "directory_inspection_used",
            "This source inspection already belongs to another run request",
          );
        const result = reserve();
        db.prepare(
          "UPDATE arc_directory_setups SET consumed_json = ? WHERE project_id = ? AND operation_id = ?",
        ).run(
          JSON.stringify(consumption),
          setup.intent.projectId,
          setup.intent.operationId,
        );
        return result;
      })();
    },
  };
}
export type DirectoryValidationStore = ReturnType<
  typeof createDirectoryValidationStore
>;

export const directoryValidationTargetSchema = z
  .object({
    target: directoryScanTargetSchema,
    expected: directoryRootSchema.extend({
      manifestDigest: runtimeHashSchema.nullable(),
    }),
  })
  .strict();
export const directoryValidationIntentSchema = z
  .object({
    runId: runIdSchema,
    effectId: z.string().min(1).max(200),
    generation: z.number().int().nonnegative(),
    purpose: z.string().min(1).max(256),
    phase: directoryValidationPhaseSchema,
    targets: z.array(directoryValidationTargetSchema).min(1).max(4096),
  })
  .strict();
export type DirectoryValidationIntent = z.infer<
  typeof directoryValidationIntentSchema
>;
const validationPassSchema = z
  .object({
    validationId: z.string().min(1).max(200),
    intent: directoryValidationIntentSchema,
    contextHash: runtimeHashSchema,
    jobs: z.array(directoryEffectRequestSchema),
    records: z.record(z.string(), directoryEffectRecordSchema),
    quiescent: z.boolean(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DirectoryValidationPass = z.infer<typeof validationPassSchema>;
type ValidationRow = {
  validationId: string;
  intentJson: string;
  contextHash: string;
  jobsJson: string;
  recordsJson: string;
  quiescent: number;
  createdAt: number;
};
const selectValidation = `SELECT validation_id AS validationId, intent_json AS intentJson, context_hash AS contextHash,
  jobs_json AS jobsJson, records_json AS recordsJson, quiescent, created_at AS createdAt FROM arc_directory_validations`;
function decodeValidation(row: ValidationRow): DirectoryValidationPass {
  return validationPassSchema.parse({
    validationId: row.validationId,
    intent: JSON.parse(row.intentJson),
    contextHash: row.contextHash,
    jobs: JSON.parse(row.jobsJson),
    records: JSON.parse(row.recordsJson),
    quiescent: row.quiescent === 1,
    createdAt: row.createdAt,
  });
}
function createEffectValidationStore(db: Database.Database) {
  function validation(validationId: string): DirectoryValidationPass {
    const row = db
      .prepare<[string], ValidationRow>(
        `${selectValidation} WHERE validation_id = ?`,
      )
      .get(validationId);
    if (!row)
      throw new AgentStoreError(
        "validation_missing",
        "This directory validation pass is missing",
      );
    return decodeValidation(row);
  }
  function latestValidation(
    effectId: string,
    generation: number,
    purpose: string,
  ) {
    const row = db
      .prepare<[string, number, string], ValidationRow>(
        `${selectValidation} WHERE effect_id = ? AND generation = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(effectId, generation, purpose);
    return row ? decodeValidation(row) : null;
  }
  return {
    validation,
    latestValidation,
    workerOutput(effectId: string): DirectoryState | null {
      const row = db
        .prepare<[string], { stateJson: string }>(
          "SELECT state_json AS stateJson FROM arc_directory_worker_outputs WHERE effect_id = ?",
        )
        .get(effectId);
      return row ? directoryStateSchema.parse(JSON.parse(row.stateJson)) : null;
    },
    recordWorkerOutput(
      effectId: string,
      terminalEventId: string,
      input: DirectoryState,
    ): DirectoryState {
      const state = directoryStateSchema.parse(input);
      return db.transaction(() => {
        const prior = db
          .prepare<[string], { terminalEventId: string; stateJson: string }>(
            "SELECT terminal_event_id AS terminalEventId, state_json AS stateJson FROM arc_directory_worker_outputs WHERE effect_id = ?",
          )
          .get(effectId);
        if (prior) {
          if (
            prior.terminalEventId !== terminalEventId ||
            runtimeHash(
              directoryStateSchema.parse(JSON.parse(prior.stateJson)),
            ) !== runtimeHash(state)
          )
            throw new AgentStoreError(
              "candidate_changed",
              "The completed directory worker output cannot change its retained identity",
            );
          return state;
        }
        db.prepare(
          "INSERT INTO arc_directory_worker_outputs(effect_id, terminal_event_id, state_json) VALUES (?, ?, ?)",
        ).run(effectId, terminalEventId, JSON.stringify(state));
        return state;
      })();
    },
    validationCheckedAt(
      validationId: string,
      identity: { effectId: string; runId: string },
    ): string | null {
      const row = db
        .prepare<[string, string], ValidationRow>(
          `${selectValidation} WHERE validation_id = ? AND effect_id = ?`,
        )
        .get(validationId, identity.effectId);
      if (!row) return null;
      const pass = decodeValidation(row);
      if (
        pass.quiescent ||
        pass.intent.runId !== identity.runId ||
        pass.jobs.length !== pass.intent.targets.length
      )
        return null;
      const timestamps: string[] = [];
      for (const [index, job] of pass.jobs.entries()) {
        const record = pass.records[job.effectId];
        const artifact = record?.receipt?.artifact;
        if (
          record?.state !== "terminal" ||
          record.receipt?.outcome !== "succeeded" ||
          artifact?.kind !== "inspection"
        )
          return null;
        const expected = pass.intent.targets[index].expected;
        if (
          artifact.state.path !== expected.path ||
          runtimeHash(artifact.state.rootIdentity) !==
            runtimeHash(expected.rootIdentity) ||
          (expected.manifestDigest !== null &&
            artifact.state.manifestDigest !== expected.manifestDigest)
        )
          return null;
        timestamps.push(artifact.checkedAt);
      }
      return timestamps.sort().at(-1) ?? null;
    },
    reserveValidation(
      input: DirectoryValidationIntent,
      replace: boolean,
    ): DirectoryValidationPass {
      const intent = directoryValidationIntentSchema.parse(input);
      const contextHash = runtimeHash(intent);
      return db.transaction(() => {
        const prior = latestValidation(
          intent.effectId,
          intent.generation,
          intent.purpose,
        );
        if (prior && !replace) {
          if (prior.contextHash !== contextHash)
            throw new AgentStoreError(
              "validation_conflict",
              "This validation pass belongs to different immutable evidence",
            );
          return prior;
        }
        const validationId = `arc_validation_${randomUUID()}`;
        const jobs = intent.targets.map(
          ({ target }): DirectoryEffectRequest => ({
            kind: "directory",
            runId: intent.runId,
            effectId: `arc_scan_${randomUUID()}`,
            lane: null,
            operation: {
              type: "scan-directory",
              target,
              consumer: {
                kind: "effect",
                effectId: intent.effectId,
                dispatchGeneration: intent.generation,
              },
              phase: intent.phase,
              validationId,
            },
          }),
        );
        db.prepare(
          "INSERT INTO arc_directory_validations (validation_id, effect_id, generation, purpose, context_hash, intent_json, jobs_json, records_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)",
        ).run(
          validationId,
          intent.effectId,
          intent.generation,
          intent.purpose,
          contextHash,
          JSON.stringify(intent),
          JSON.stringify(jobs),
          Date.now(),
        );
        return validation(validationId);
      })();
    },
    recordValidation(
      validationId: string,
      input: DirectoryEffectRecord,
    ): DirectoryValidationPass {
      const record = directoryEffectRecordSchema.parse(input);
      return db.transaction(() => {
        const pass = validation(validationId);
        const job = pass.jobs.find((item) => item.effectId === record.effectId);
        if (
          !job ||
          job.runId !== record.runId ||
          directoryEffectRequestHash(job) !== record.requestHash
        )
          throw new AgentStoreError(
            "validation_conflict",
            "This native result belongs to another retained validation job",
          );
        const prior = pass.records[record.effectId];
        if (prior?.state === "terminal") {
          if (record.state !== "terminal") return pass;
          if (runtimeHash(record) !== runtimeHash(prior))
            throw new AgentStoreError(
              "validation_conflict",
              "A terminal native validation result cannot change",
            );
          return pass;
        }
        const artifact = record.receipt?.artifact;
        if (
          artifact?.kind === "inspection" &&
          (job.operation.type !== "scan-directory" ||
            artifact.validationId !== validationId ||
            artifact.phase !== job.operation.phase ||
            runtimeHash(artifact.consumer) !==
              runtimeHash(job.operation.consumer))
        )
          throw new AgentStoreError(
            "validation_conflict",
            "The inspection does not identify this exact consumer and validation pass",
          );
        db.prepare(
          "UPDATE arc_directory_validations SET records_json = ? WHERE validation_id = ?",
        ).run(
          JSON.stringify({ ...pass.records, [record.effectId]: record }),
          validationId,
        );
        return validation(validationId);
      })();
    },
    quiesceValidation(validationId: string) {
      db.prepare(
        "UPDATE arc_directory_validations SET quiescent = 1 WHERE validation_id = ?",
      ).run(validationId);
      return validation(validationId);
    },
    activeValidations(effectId: string): DirectoryValidationPass[] {
      return db
        .prepare<[string], ValidationRow>(
          `${selectValidation} WHERE effect_id = ? AND quiescent = 0 AND EXISTS (SELECT 1 FROM json_each(jobs_json) job WHERE COALESCE(json_extract(records_json, '$.' || json_extract(job.value, '$.effectId') || '.state'), '') != 'terminal') ORDER BY created_at DESC`,
        )
        .all(effectId)
        .map(decodeValidation);
    },
  };
}

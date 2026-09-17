import { randomUUID } from "node:crypto";
import { createAddressedContinuationStore } from "./addressed-continuation-data.js";
import type Database from "better-sqlite3";
import {
  ownedStepRequestInputSchema as ownedStepRequestSchema,
  ownedStepObservationInputSchema as ownedStepObservationSchema,
  ownedControlReceiptSchema,
  resolveOwnedRequirements,
  type OwnedStepRequestInput as OwnedStepRequest,
  type OwnedStepObservationInput as OwnedStepObservation,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import { AgentStoreError } from "../data.js";
import {
  hostEffectRequestSchema,
  hostWorkspaceStateSchema,
} from "../host-contract.js";
import { runtimeNodeKey } from "./compiler.js";
import {
  retainedCompiledRunSchema as compiledRunSchema,
  type RetainedCompiledRun as CompiledRun,
} from "./compiled.js";
import {
  graphRunRequestSchema,
  type GraphRunRequest,
} from "./graph-contract.js";
import { graphControlReceiptSchema } from "./graph-receipt.js";
import {
  reviewVerdictSchema,
  runEffectViewSchema,
  runRequestSchema,
  runSummarySchema,
  type ArcRunRequest,
  type ArcRunSummary,
  type ReviewVerdict,
} from "./contract.js";
import { runtimeHash } from "./hash.js";
import { createInstructionUpdateStore } from "./instruction-update-data.js";
import { createDirectoryValidationStore } from "./directory-validation.js";
import {
  directoryRunRequestSchema,
  type DirectoryRunRequest,
} from "./directory-contract.js";
import { directoryEffectRequestSchema } from "../host-directory-contract.js";
import {
  directoryWorkerBindingSchema,
  directoryReviewVerdictSchema,
  directoryControlReceiptSchema,
} from "./directory-receipt.js";
import { createRunControlStore } from "./control-data.js";
import { createThreadBrowserStore } from "../threads/data.js";
import { createRunCollaborationStore } from "./collaboration-data.js";
import {
  orchestratedRunRequestSchema,
  type OrchestratedRunRequest,
} from "./orchestrated-contract.js";

export const runtimeMigrations = [
  `CREATE TABLE arc_runs (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    compiled_json TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    workflow_run_id TEXT UNIQUE,
    submission TEXT NOT NULL CHECK(submission IN ('reserved', 'submitted', 'needs-reconciliation')),
    submission_error TEXT,
    UNIQUE(project_id, operation_id)
  )`,
  "CREATE INDEX arc_runs_by_project ON arc_runs(project_id, created_at DESC, id)",
  `CREATE TABLE arc_run_effects (
    effect_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES arc_runs(id),
    node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    generation INTEGER NOT NULL,
    native_request_json TEXT,
    thread_id TEXT UNIQUE,
    execution_context_id TEXT NOT NULL UNIQUE,
    worker_binding_json TEXT,
    observation_json TEXT,
    review_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, node_id, iteration, attempt)
  )`,
  "CREATE INDEX arc_run_effects_by_node ON arc_run_effects(run_id, node_id, iteration, attempt DESC)",
];

export const gitWorkerBindingSchema = z
  .object({
    workspace: hostWorkspaceStateSchema,
    prompt: z.string().min(1).max(65_536),
  })
  .strict();
const workerBindingSchema = z.union([
  gitWorkerBindingSchema,
  directoryWorkerBindingSchema,
]);
const nativeRequestSchema = z.union([
  hostEffectRequestSchema,
  directoryEffectRequestSchema,
]);
const reviewSchema = z.union([
  reviewVerdictSchema,
  directoryReviewVerdictSchema,
]);
export type RuntimeWorkerBinding = z.infer<typeof workerBindingSchema>;

interface RunRow {
  id: string;
  requestHash: string;
  compiledJson: string;
  workflowRunId: string | null;
  submission: ArcRunSummary["submission"];
  submissionError: string | null;
}

interface EffectRow {
  effectId: string;
  runId: string;
  requestHash: string;
  requestJson: string;
  generation: number;
  nativeRequestJson: string | null;
  threadId: string | null;
  executionContextId: string;
  workerBindingJson: string | null;
  observationJson: string | null;
  reviewJson: string | null;
  createdAt: number;
}

const RUN_SELECT = `SELECT id, request_hash AS requestHash, compiled_json AS compiledJson,
  workflow_run_id AS workflowRunId, submission, submission_error AS submissionError FROM arc_runs`;
const EFFECT_SELECT = `SELECT effect_id AS effectId, run_id AS runId, request_hash AS requestHash,
  request_json AS requestJson, generation, native_request_json AS nativeRequestJson,
  thread_id AS threadId, execution_context_id AS executionContextId,
  worker_binding_json AS workerBindingJson, observation_json AS observationJson,
  review_json AS reviewJson, created_at AS createdAt FROM arc_run_effects`;

export function createArcRunStore(db: Database.Database) {
  function runView(row: RunRow) {
    const compiled = compiledRunSchema.parse(JSON.parse(row.compiledJson));
    const summary: ArcRunSummary = {
      runId: row.id,
      projectId: compiled.definition.request.projectId,
      goal: compiled.definition.request.goal,
      planHash: compiled.workflow.planHash,
      createdAt: compiled.definition.createdAt,
      workflowRunId: row.workflowRunId,
      submission: row.submission,
      submissionError: row.submissionError,
    };
    return { compiled, summary };
  }

  function get(runId: string) {
    const row = db
      .prepare<[string], RunRow>(`${RUN_SELECT} WHERE id = ?`)
      .get(runId);
    if (!row)
      throw new AgentStoreError("run_not_found", "This ARC run does not exist");
    return runView(row);
  }

  function effectView(row: EffectRow) {
    return {
      effectId: row.effectId,
      runId: row.runId,
      requestHash: row.requestHash,
      request: ownedStepRequestSchema.parse(JSON.parse(row.requestJson)),
      generation: row.generation,
      nativeRequest:
        row.nativeRequestJson === null
          ? null
          : nativeRequestSchema.parse(JSON.parse(row.nativeRequestJson)),
      threadId: row.threadId,
      executionContextId: row.executionContextId,
      workerBinding:
        row.workerBindingJson === null
          ? null
          : workerBindingSchema.parse(JSON.parse(row.workerBindingJson)),
      observation:
        row.observationJson === null
          ? null
          : ownedStepObservationSchema.parse(JSON.parse(row.observationJson)),
      review:
        row.reviewJson === null
          ? null
          : reviewSchema.parse(JSON.parse(row.reviewJson)),
      createdAt: row.createdAt,
    };
  }

  function findEffect(effectId: string) {
    const row = db
      .prepare<[string], EffectRow>(`${EFFECT_SELECT} WHERE effect_id = ?`)
      .get(effectId);
    return row ? effectView(row) : null;
  }

  function effect(effectId: string) {
    const row = findEffect(effectId);
    if (!row)
      throw new AgentStoreError(
        "effect_not_found",
        "This ARC effect has not been admitted",
      );
    return row;
  }

  function immutableEffectField(
    effectId: string,
    column: "native_request_json" | "worker_binding_json" | "review_json",
    value: string,
  ) {
    db.transaction(() => {
      const row = db
        .prepare<[string], { value: string | null }>(
          `SELECT ${column} AS value FROM arc_run_effects WHERE effect_id = ?`,
        )
        .get(effectId);
      if (!row)
        throw new AgentStoreError(
          "effect_not_found",
          "This ARC effect has not been admitted",
        );
      if (row.value !== null && row.value !== value)
        throw new AgentStoreError(
          "effect_conflict",
          "An admitted effect cannot change its sealed arguments or verdict",
        );
      db.prepare(
        `UPDATE arc_run_effects SET ${column} = ? WHERE effect_id = ? AND ${column} IS NULL`,
      ).run(value, effectId);
    })();
  }

  return {
    collaboration: createRunCollaborationStore(db),
    addressedContinuations: createAddressedContinuationStore(db),
    threadBrowser: createThreadBrowserStore(db),
    instructionUpdates: createInstructionUpdateStore(db),
    directories: createDirectoryValidationStore(db),
    controls: createRunControlStore(db),
    get,
    findOperation(projectId: string, operationId: string) {
      const row = db
        .prepare<[string, string], RunRow>(
          `${RUN_SELECT} WHERE project_id = ? AND operation_id = ?`,
        )
        .get(projectId, operationId);
      return row ? runView(row) : null;
    },
    latestForThread(projectId: string, threadId: string) {
      const row = db
        .prepare<[string, string], RunRow>(
          `${RUN_SELECT} WHERE project_id = ? AND json_extract(request_json, '$.originThreadId') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(projectId, threadId);
      return row ? runView(row) : null;
    },
    findRequest(
      input:
        | ArcRunRequest
        | GraphRunRequest
        | OrchestratedRunRequest
        | DirectoryRunRequest,
    ) {
      const request =
        "sourceInspectionId" in input
          ? directoryRunRequestSchema.parse(input)
          : "invocation" in input
            ? orchestratedRunRequestSchema.parse(input)
            : "team" in input
              ? graphRunRequestSchema.parse(input)
              : runRequestSchema.parse(input);
      const row = db
        .prepare<[string, string], RunRow>(
          `${RUN_SELECT} WHERE project_id = ? AND operation_id = ?`,
        )
        .get(request.projectId, request.operationId);
      if (!row) return null;
      if (row.requestHash !== runtimeHash(request))
        throw new AgentStoreError(
          "run_conflict",
          "This operation ID already identifies a different run request",
        );
      return runView(row);
    },
    reserve(input: CompiledRun) {
      return db.transaction(() => {
        const compiled = compiledRunSchema.parse(input);
        const request = compiled.definition.request;
        const row = db
          .prepare<[string, string], RunRow>(
            `${RUN_SELECT} WHERE project_id = ? AND operation_id = ?`,
          )
          .get(request.projectId, request.operationId);
        if (row) {
          if (row.requestHash !== runtimeHash(request))
            throw new AgentStoreError(
              "run_conflict",
              "This operation ID already identifies a different run request",
            );
          return runView(row);
        }
        db.prepare(`INSERT INTO arc_runs (id, operation_id, project_id, request_hash, request_json, compiled_json, plan_hash, goal, created_at, submission)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`).run(
          compiled.definition.runId,
          request.operationId,
          request.projectId,
          runtimeHash(request),
          JSON.stringify(request),
          JSON.stringify(compiled),
          compiled.workflow.planHash,
          request.goal,
          compiled.definition.createdAt,
        );
        return get(compiled.definition.runId);
      })();
    },
    submitted(runId: string, workflowRunId: string) {
      db.transaction(() => {
        const row = get(runId);
        if (
          row.summary.workflowRunId !== null &&
          row.summary.workflowRunId !== workflowRunId
        )
          throw new AgentStoreError(
            "run_conflict",
            "This ARC run is already bound to a different workflow",
          );
        db.prepare(
          "UPDATE arc_runs SET workflow_run_id = ?, submission = 'submitted', submission_error = NULL WHERE id = ?",
        ).run(workflowRunId, runId);
      })();
    },
    submissionUncertain(runId: string, reason: string) {
      db.prepare(
        "UPDATE arc_runs SET submission = 'needs-reconciliation', submission_error = ? WHERE id = ? AND workflow_run_id IS NULL",
      ).run(reason.slice(0, 8000), runId);
    },
    list(projectId: string, limit: number, offset: number) {
      const rows = db
        .prepare<
          [string, number, number],
          {
            runId: string;
            projectId: string;
            goal: string;
            planHash: string;
            createdAt: number;
            workflowRunId: string | null;
            submission: ArcRunSummary["submission"];
            submissionError: string | null;
          }
        >(`SELECT id AS runId, project_id AS projectId, goal, plan_hash AS planHash, created_at AS createdAt,
        workflow_run_id AS workflowRunId, submission, submission_error AS submissionError
        FROM arc_runs WHERE project_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
        .all(projectId, limit, offset);
      const total =
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_runs WHERE project_id = ?",
          )
          .get(projectId)?.total ?? 0;
      return { runs: rows.map((row) => runSummarySchema.parse(row)), total };
    },
    effect,
    findEffect,
    workspaceEffects(runId: string) {
      const { compiled } = get(runId);
      const nodeIds = [
        ...new Set(
          compiled.workflow.steps
            .filter(
              (step) => compiled.nodes[runtimeNodeKey(step)].kind === "agent",
            )
            .map((step) => step.nodeId),
        ),
      ];
      const workerPredicate = `run_id = ? AND node_id IN (${nodeIds.map(() => "?").join(", ")})`;
      const workers =
        nodeIds.length === 0
          ? []
          : db
              .prepare<string[], EffectRow>(
                `${EFFECT_SELECT} WHERE ${workerPredicate} ORDER BY created_at DESC, effect_id DESC LIMIT 100`,
              )
              .all(runId, ...nodeIds)
              .map(effectView);
      const workersTotal =
        nodeIds.length === 0
          ? 0
          : (db
              .prepare<string[], { total: number }>(
                `SELECT count(*) AS total FROM arc_run_effects WHERE ${workerPredicate}`,
              )
              .get(runId, ...nodeIds)?.total ?? 0);
      const effects = db
        .prepare<[string], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? ORDER BY created_at DESC, effect_id DESC LIMIT 100`,
        )
        .all(runId)
        .map(effectView);
      const effectsTotal =
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_run_effects WHERE run_id = ?",
          )
          .get(runId)?.total ?? 0;
      return { workers, workersTotal, effects, effectsTotal };
    },
    repairConsumers(effectId: string) {
      const source = effect(effectId);
      if (get(source.runId).compiled.definition.schemaVersion !== 1) return [];
      const observation = source.observation;
      if (observation?.state !== "failed") return [];
      return db
        .prepare<[string, number, string, string], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? AND node_id = 'repair' AND iteration = ?
          AND thread_id IS NOT NULL AND worker_binding_json IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(request_json, '$.dependencyReceipts') AS dependency
            WHERE json_extract(dependency.value, '$.effectId') = ?
              AND json_extract(dependency.value, '$.receiptHash') = ?
              AND json_extract(dependency.value, '$.outcome') = 'failed')
          ORDER BY attempt`,
        )
        .all(
          source.runId,
          source.request.iteration + 1,
          effectId,
          observation.receiptHash,
        )
        .map(effectView);
    },
    approvalConsumers(effectId: string) {
      const source = effect(effectId);
      const { compiled } = get(source.runId);
      const observation = source.observation;
      if (
        compiled.definition.schemaVersion === 1 ||
        observation?.state !== "succeeded"
      )
        return [];
      const agentKeys = Object.entries(compiled.nodes)
        .filter(([, node]) => node.kind === "agent")
        .map(([key]) => key);
      if (agentKeys.length === 0) return [];
      return db
        .prepare<string[], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? AND worker_binding_json IS NOT NULL
          AND (node_id || ':' || iteration) IN (${agentKeys.map(() => "?").join(", ")})
          AND EXISTS (SELECT 1 FROM json_each(request_json, '$.dependencyReceipts') AS dependency
            WHERE json_extract(dependency.value, '$.effectId') = ?
              AND json_extract(dependency.value, '$.receiptHash') = ?
              AND json_extract(dependency.value, '$.outcome') = 'succeeded')
          ORDER BY created_at, effect_id`,
        )
        .all(source.runId, ...agentKeys, effectId, observation.receiptHash)
        .map(effectView);
    },
    finalVerification(runId: string) {
      const { compiled } = get(runId);
      if ("references" in compiled) {
        const refs = compiled.references.finalGates.map((gate) => gate.verify);
        if (refs.length === 0) return null;
        const clauses = refs.map(() => "(node_id = ? AND iteration = ?)");
        const row = db
          .prepare<Array<string | number>, EffectRow>(
            `${EFFECT_SELECT} WHERE run_id = ? AND (${clauses.join(" OR ")}) AND json_extract(observation_json, '$.state') = 'succeeded' ORDER BY created_at DESC, attempt DESC LIMIT 1`,
          )
          .get(runId, ...refs.flatMap((ref) => [ref.nodeId, ref.iteration]));
        return row ? effectView(row) : null;
      }
      const row = db
        .prepare<[string], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? AND node_id = 'verify' AND json_extract(observation_json, '$.state') = 'succeeded' ORDER BY created_at DESC, attempt DESC LIMIT 1`,
        )
        .get(runId);
      return row ? effectView(row) : null;
    },
    effectView(effectId: string) {
      const item = effect(effectId);
      return runEffectViewSchema.parse({
        effectId,
        nodeId: item.request.nodeId,
        iteration: item.request.iteration,
        attempt: item.request.attempt,
        createdAt: item.createdAt,
        state: item.observation?.state ?? "admitted",
        resource:
          item.observation !== null && "resource" in item.observation
            ? item.observation.resource
            : item.threadId === null
              ? null
              : {
                  kind: "agent",
                  threadId: item.threadId,
                  executionContextId: item.executionContextId,
                  environmentId: null,
                  turnRequestId: null,
                },
      });
    },
    listEffectIds(runId: string, limit: number, offset: number) {
      const rows = db
        .prepare<[string, number, number], { effectId: string }>(
          "SELECT effect_id AS effectId FROM arc_run_effects WHERE run_id = ? ORDER BY created_at, effect_id LIMIT ? OFFSET ?",
        )
        .all(runId, limit, offset);
      const total =
        db
          .prepare<[string], { total: number }>(
            "SELECT count(*) AS total FROM arc_run_effects WHERE run_id = ?",
          )
          .get(runId)?.total ?? 0;
      return { ids: rows.map((row) => row.effectId), total };
    },
    effectForNode(runId: string, ref: OwnedStepRef) {
      const row = db
        .prepare<[string, string, number], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? AND node_id = ? AND iteration = ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId, ref.nodeId, ref.iteration);
      if (!row)
        throw new AgentStoreError(
          "dependency_missing",
          `Required step ${runtimeNodeKey(ref)} has no admitted effect`,
        );
      return effectView(row);
    },
    previousAttempt(request: OwnedStepRequest) {
      const row = db
        .prepare<[string, string, number, number], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt < ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(
          request.ownerRunId,
          request.nodeId,
          request.iteration,
          request.attempt,
        );
      return row ? effectView(row) : null;
    },
    reserveEffect(input: OwnedStepRequest) {
      return db.transaction(() => {
        const request = ownedStepRequestSchema.parse(input);
        const {
          requestHash: suppliedHash,
          dispatchGeneration: _generation,
          ...immutableRequest
        } = request;
        if (runtimeHash({ owner: "arc", ...immutableRequest }) !== suppliedHash)
          throw new AgentStoreError(
            "effect_conflict",
            "The admitted effect request hash is invalid",
          );
        if (request.input !== null)
          throw new AgentStoreError(
            "effect_conflict",
            "ARC runtime inputs are sealed in the run definition",
          );
        const run = get(request.ownerRunId);
        const step = run.compiled.workflow.steps.find(
          (value) =>
            value.nodeId === request.nodeId &&
            value.iteration === request.iteration,
        );
        if (!step || step.definitionHash !== request.definitionHash)
          throw new AgentStoreError(
            "effect_conflict",
            "The requested step does not match the immutable ARC plan",
          );
        if (
          run.summary.workflowRunId !== null &&
          run.summary.workflowRunId !== request.workflowRunId
        )
          throw new AgentStoreError(
            "scope_denied",
            "This effect belongs to a different workflow",
          );
        if (
          "schemaVersion" in request !==
          (run.compiled.definition.schemaVersion !== 1)
        )
          throw new AgentStoreError(
            "effect_conflict",
            "The effect version does not match its sealed run",
          );
        const requirements =
          "requirements" in step
            ? resolveOwnedRequirements(step, (ref) => {
                const admitted = request.dependencyReceipts.find(
                  (value) => runtimeNodeKey(value) === runtimeNodeKey(ref),
                );
                if (!admitted) return null;
                const retained = findEffect(admitted.effectId);
                const observation = retained?.observation;
                if (
                  !retained ||
                  retained.runId !== request.ownerRunId ||
                  runtimeNodeKey(retained.request) !== runtimeNodeKey(ref) ||
                  !observation ||
                  !("receipt" in observation) ||
                  observation.state !== admitted.outcome ||
                  observation.receiptHash !== admitted.receiptHash ||
                  observation.validity.state !== "current"
                )
                  return null;
                const receipt = (
                  run.compiled.definition.schemaVersion === 4
                    ? directoryControlReceiptSchema
                    : graphControlReceiptSchema
                ).safeParse(observation.receipt);
                return receipt.success ? receipt.data : null;
              })
            : {
                state: "ready" as const,
                receipts: step.dependencies.map(
                  ({ requiredOutcome, ...ref }) => ({
                    kind: "receipt" as const,
                    step: ref,
                    outcomes: [requiredOutcome],
                  }),
                ),
              };
        if (requirements.state !== "ready")
          throw new AgentStoreError(
            "dependency_missing",
            "This graph path is not selected by current retained evidence",
          );
        const requiredKeys = new Set(
          requirements.receipts.map((value) => runtimeNodeKey(value.step)),
        );
        const supplied = new Map(
          request.dependencyReceipts.map((value) => [
            runtimeNodeKey(value),
            value,
          ]),
        );
        if (
          supplied.size !== request.dependencyReceipts.length ||
          supplied.size !== requiredKeys.size ||
          [...supplied.keys()].some((key) => !requiredKeys.has(key)) ||
          (step.lane === null) !== (request.lane === null)
        )
          throw new AgentStoreError(
            "effect_conflict",
            "The effect does not contain its admitted dependencies and lane",
          );
        for (const dependency of requirements.receipts) {
          const receipt = supplied.get(runtimeNodeKey(dependency.step));
          if (!receipt || !dependency.outcomes.includes(receipt.outcome))
            throw new AgentStoreError(
              "dependency_missing",
              "A required dependency has not produced the admitted outcome",
            );
          const retained = findEffect(receipt.effectId);
          if (
            !retained ||
            retained.runId !== request.ownerRunId ||
            runtimeNodeKey(retained.request) !==
              runtimeNodeKey(dependency.step) ||
            retained.observation?.state !== receipt.outcome ||
            !("receiptHash" in retained.observation) ||
            retained.observation.receiptHash !== receipt.receiptHash
          )
            throw new AgentStoreError(
              "dependency_missing",
              "The dependency receipt does not match this run's native evidence",
            );
        }
        const existing = findEffect(request.effectId);
        if (existing) {
          const { dispatchGeneration: _oldGeneration, ...oldRequest } =
            existing.request;
          const { dispatchGeneration: _newGeneration, ...newRequest } = request;
          if (runtimeHash(oldRequest) !== runtimeHash(newRequest))
            throw new AgentStoreError(
              "effect_conflict",
              "This effect ID already identifies different admitted arguments",
            );
          if (request.dispatchGeneration < existing.generation)
            throw new AgentStoreError(
              "stale_generation",
              "This callback belongs to an earlier workflow generation",
            );
          db.prepare(
            "UPDATE arc_run_effects SET generation = ? WHERE effect_id = ?",
          ).run(request.dispatchGeneration, request.effectId);
          return effect(request.effectId);
        }
        db.prepare(`INSERT INTO arc_run_effects (effect_id, run_id, node_id, iteration, attempt, request_hash, request_json, generation, execution_context_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          request.effectId,
          request.ownerRunId,
          request.nodeId,
          request.iteration,
          request.attempt,
          request.requestHash,
          JSON.stringify(request),
          request.dispatchGeneration,
          `run-execution_${randomUUID()}`,
          Date.now(),
        );
        if (run.summary.workflowRunId === null)
          db.prepare(
            "UPDATE arc_runs SET workflow_run_id = ?, submission = 'submitted', submission_error = NULL WHERE id = ?",
          ).run(request.workflowRunId, request.ownerRunId);
        return effect(request.effectId);
      })();
    },
    sealNative(effectId: string, value: z.infer<typeof nativeRequestSchema>) {
      immutableEffectField(
        effectId,
        "native_request_json",
        JSON.stringify(nativeRequestSchema.parse(value)),
      );
    },
    sealWorker(effectId: string, binding: RuntimeWorkerBinding) {
      immutableEffectField(
        effectId,
        "worker_binding_json",
        JSON.stringify(workerBindingSchema.parse(binding)),
      );
    },
    bindThread(effectId: string, threadId: string) {
      db.transaction(() => {
        const row = effect(effectId);
        if (row.threadId !== null && row.threadId !== threadId)
          throw new AgentStoreError(
            "execution_context_reused",
            "This worker context belongs to another thread",
          );
        db.prepare(
          "UPDATE arc_run_effects SET thread_id = ? WHERE effect_id = ? AND thread_id IS NULL",
        ).run(threadId, effectId);
      })();
    },
    fromContext(
      executionContextId: string,
      projectId: string,
      threadId: string,
    ) {
      const row = db
        .prepare<[string], EffectRow>(
          `${EFFECT_SELECT} WHERE execution_context_id = ?`,
        )
        .get(executionContextId);
      if (!row)
        throw new AgentStoreError(
          "execution_context_missing",
          "The pinned ARC run context does not exist",
        );
      const item = effectView(row);
      const run = get(item.runId);
      if (run.summary.projectId !== projectId || item.threadId !== threadId)
        throw new AgentStoreError(
          "scope_denied",
          "This ARC context belongs to another project or thread",
        );
      const node = run.compiled.nodes[runtimeNodeKey(item.request)];
      if (node.kind !== "agent" || item.workerBinding === null)
        throw new AgentStoreError(
          "execution_context_missing",
          "The ARC worker is not prepared",
        );
      return { effect: item, run, node, binding: item.workerBinding };
    },
    completionEffects(runId: string) {
      return db
        .prepare<[string], EffectRow>(
          `${EFFECT_SELECT} WHERE run_id = ? ORDER BY node_id, iteration, attempt`,
        )
        .all(runId)
        .map(effectView);
    },
    fromTurnContext(
      executionContextId: string,
      projectId: string,
      threadId: string,
    ) {
      const row = db
        .prepare<[string], EffectRow>(
          `${EFFECT_SELECT} WHERE execution_context_id = ?`,
        )
        .get(executionContextId);
      if (!row)
        throw new AgentStoreError(
          "execution_context_missing",
          "The admitted ARC turn context does not exist",
        );
      const item = effectView(row);
      const run = get(item.runId);
      const node = run.compiled.nodes[runtimeNodeKey(item.request)];
      if (
        run.summary.projectId !== projectId ||
        node.kind !== "orchestrator" ||
        node.completion.threadId !== threadId ||
        (run.compiled.definition.schemaVersion !== 3 &&
          run.compiled.definition.schemaVersion !== 4)
      )
        throw new AgentStoreError(
          "scope_denied",
          "This ARC turn belongs to another project or conversation",
        );
      return { effect: item, run, node };
    },
    review(effectId: string, value: z.infer<typeof reviewSchema>) {
      immutableEffectField(
        effectId,
        "review_json",
        JSON.stringify(reviewSchema.parse(value)),
      );
    },
    recordObservation(effectId: string, input: OwnedStepObservation) {
      const observation = ownedStepObservationSchema.parse(input);
      return db.transaction(() => {
        const previous = effect(effectId).observation;
        const controlVersion = (value: OwnedStepObservation | null) => {
          if (
            value === null ||
            !("resource" in value) ||
            value.resource?.kind !== "owner-control"
          )
            return null;
          const revision =
            value.state === "waiting"
              ? value.revision
              : value.state === "succeeded" || value.state === "failed"
                ? ownedControlReceiptSchema.parse(value.receipt).revision
                : null;
          return revision === null
            ? null
            : { revision, controlId: value.resource.controlId };
        };
        const before = controlVersion(previous);
        const incoming = controlVersion(observation);
        if (previous !== null && before !== null && incoming !== null) {
          if (before.controlId !== incoming.controlId)
            throw new AgentStoreError(
              "receipt_conflict",
              "An owner control cannot change its bound identity",
            );
          if (incoming.revision < before.revision) return previous;
        }
        const terminal = (value: OwnedStepObservation | null) =>
          value?.state === "succeeded" ||
          value?.state === "failed" ||
          value?.state === "interrupted";
        if (previous !== null && terminal(previous)) {
          if (
            !("receiptHash" in previous) ||
            !("receiptHash" in observation) ||
            previous.receiptHash !== observation.receiptHash ||
            previous.state !== observation.state
          )
            throw new AgentStoreError(
              "receipt_conflict",
              "Historical terminal outcomes cannot be replaced",
            );
        }
        db.prepare(
          "UPDATE arc_run_effects SET observation_json = ? WHERE effect_id = ?",
        ).run(JSON.stringify(observation), effectId);
        return observation;
      })();
    },
  };
}

export type ArcRunStore = ReturnType<typeof createArcRunStore>;
export type ArcRunEffect = ReturnType<ArcRunStore["effect"]>;

import Database from "better-sqlite3";
import type {
  BbPluginApi,
  ExperimentalThreadPreparation,
  ExperimentalTurnPreparation,
} from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  ownedStepObservationInputSchema,
  type OwnedStepObservationLookupInput,
  type OwnedStepRequestInput,
} from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  getOwnedAttempt,
  ownedTerminalObservation,
  recordOwnedObservation,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";
import { migrations } from "../data.js";
import { arcHostContract } from "../host-contract.js";
import {
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
  type DirectorySnapshot,
  type DirectoryState,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import { teamEdge } from "../teams/testing.js";
import type { TeamDefinition } from "../teams/contract.js";
import { createArcRuntimeAdapter } from "./adapter.js";
import { runtimeNodeKey } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { collaborationMigrations } from "./collaboration-data.js";
import { directoryValidationMigrations } from "./directory-validation.js";
import { controlMigrations } from "./control-data.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { runtimeHash } from "./hash.js";
import { directoryRuntimeReceiptSchema } from "./directory-receipt.js";

type Event = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
export function createDirectoryRuntimeFixture(
  options: {
    repair?: boolean;
    autonomy?: "guided" | "collaborative" | "autonomous";
    update?: (team: TeamDefinition) => void;
    assignments?: string[];
  } = {},
) {
  const definition = directoryDefinitionFixture(
    options.repair
      ? (team) => {
          const review = team.graph.nodes.find(
            (node) => node.kind === "review",
          );
          if (!review || review.kind !== "review")
            throw new Error("Missing reviewer");
          review.candidate = { kind: "node", nodeId: "repair" };
          team.graph.nodes.push({
            id: "repair",
            kind: "repair",
            label: "Repair",
            checkNodeId: "check",
            maxRounds: 1,
            body: { memberId: "builder", task: "Fix the required check" },
          });
          team.graph.edges = [
            teamEdge("write", "check"),
            teamEdge("check", "repair", "failed"),
            teamEdge("repair", "review", "succeeded", "repaired"),
          ];
          team.graph.requiredGates = [
            { id: "verified", mode: "all", nodeIds: ["repair", "review"] },
          ];
        }
      : options.update,
  );
  if (options.autonomy) definition.policy.autonomy = options.autonomy;
  const compiled = compileArcDirectoryRun(definition);
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...controlMigrations,
      ...directoryValidationMigrations,
      ...workflowMigrations,
      ...collaborationMigrations,
    ].join(";\n"),
  );
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  const claimed = claimOwnedRun(db, 4);
  if (!claimed) throw new Error("Run not claimed");
  store.submitted(definition.runId, workflow.workflowRunId);
  const directories = new Map<string, DirectoryState>([
    [definition.source.path, structuredClone(definition.source)],
  ]);
  const jobs = new Map<
    string,
    { request: DirectoryEffectRequest; record: DirectoryEffectRecord }
  >();
  const preparations = new Map<string, ExperimentalThreadPreparation>();
  const mainPreparations = new Map<string, ExperimentalTurnPreparation>();
  const events: Event[] = [];
  const calls = {
    scans: 0,
    mutations: 0,
    workerStarts: 0,
    mainStarts: 0,
    stops: 0,
    interruptedScans: 0,
  };
  let holdScans = false;
  let delayedInterrupt = false;
  let holdAfterWorker = false;
  let checks = 0;
  let ordinal = 100;
  const now = "2026-09-10T12:00:00.000Z";
  function state(path: string) {
    const value = directories.get(path);
    if (!value) throw new Error(`Missing native directory fixture ${path}`);
    return structuredClone(value);
  }
  function copy(source: DirectoryState, workspaceId: string): DirectoryState {
    const copied = {
      ...source,
      path: `C:/arc-owned/${workspaceId}`,
      rootIdentity: { deviceId: "7", fileId: String(++ordinal) },
    };
    directories.set(copied.path, copied);
    return copied;
  }
  function complete(request: DirectoryEffectRequest): DirectoryEffectRecord {
    const operation = request.operation;
    let before: DirectoryState;
    let after: DirectoryState;
    let artifact: NonNullable<DirectoryEffectRecord["receipt"]>["artifact"] =
      null;
    let failed = false;
    if (operation.type === "scan-directory") {
      before = state(operation.target.path);
      after = before;
      artifact = {
        kind: "inspection",
        validationId: operation.validationId,
        consumer: operation.consumer,
        phase: operation.phase,
        state: after,
        checkedAt: now,
      };
    } else if (operation.type === "check-directory") {
      before = state(operation.workspace.path);
      after = before;
      failed = options.repair === true && checks++ === 0;
    } else {
      before = state(
        operation.type === "materialize-directory"
          ? operation.source.workspace.path
          : operation.source.path,
      );
      after = copy(before, `${operation.workspaceId}-${request.effectId}`);
      const workspace = {
        kind: "directory" as const,
        path: after.path,
        rootIdentity: after.rootIdentity,
        workspaceId: operation.workspaceId,
        originalPath: definition.source.path,
        expectedManifestDigest: after.manifestDigest,
      };
      if (operation.type === "materialize-directory")
        artifact = {
          kind: "working",
          workspace,
          sourceSnapshotId: operation.source.snapshotId,
        };
      else {
        const snapshot: DirectorySnapshot = {
          kind: "directory-snapshot",
          snapshotId: `snapshot-${request.effectId}`,
          workspace,
          manifestDigest: after.manifestDigest,
        };
        artifact = { kind: "snapshot", snapshot };
      }
    }
    return {
      kind: "directory",
      runId: request.runId,
      effectId: request.effectId,
      requestHash: directoryEffectRequestHash(request),
      state: "terminal",
      startedAt: now,
      finishedAt: now,
      receipt: {
        kind: "directory",
        operationType: operation.type,
        outcome: failed ? "failed" : "succeeded",
        errorCode: failed ? "process_failed" : null,
        reason: failed ? "The required command exited with code 1" : null,
        before,
        after,
        source: null,
        processes:
          operation.type === "check-directory"
            ? [
                {
                  executable: operation.executable,
                  args: operation.args,
                  exitCode: failed ? 1 : 0,
                  signal: null,
                  stdout: failed ? "expected 200, got 201" : "passed",
                  stderr: "",
                  stdoutBytes: 0,
                  stderrBytes: 0,
                  stdoutDigest: "a".repeat(64),
                  stderrDigest: "b".repeat(64),
                  truncated: false,
                  startedAt: now,
                  finishedAt: now,
                  interrupted: false,
                },
              ]
            : [],
        artifact: failed ? null : artifact,
        finishedAt: now,
      },
    };
  }
  const host = createFakePluginHost({
    pluginId: "arc",
    experimental_internalRpc: async ({ method }) => {
      if (method !== "inspectOwnedRun")
        throw new Error("Unexpected workflow call");
      return { run: viewOwnedRun(db, workflow.workflowRunId) };
    },
    experimental_preparedThreads: {
      async getPreparation({ operationId }) {
        return preparations.get(operationId) ?? null;
      },
      async prepare(input) {
        if (
          input.environment.type !== "host" ||
          input.environment.workspace.type !== "unmanaged" ||
          input.environment.workspace.path === null
        )
          throw new Error("Wrong directory worker environment");
        const prepared: ExperimentalThreadPreparation = {
          operationId: input.operationId,
          requestHash: runtimeHash(JSON.stringify(input)),
          threadId: `worker-${input.operationId}`,
          revision: 1,
          state: "prepared",
          environment: {
            hostId: input.environment.hostId ?? definition.request.hostId,
            environmentId: `env-${input.operationId}`,
            path: input.environment.workspace.path,
          },
          dispatch: null,
          reason: null,
        };
        preparations.set(input.operationId, prepared);
        return prepared;
      },
      async startPrepared(input) {
        const preparation = preparations.get(input.operationId);
        if (!preparation || preparation.state !== "prepared")
          throw new Error("Worker replayed after start");
        const effect = store.effect(input.operationId);
        const node = compiled.nodes[runtimeNodeKey(effect.request)];
        if (node.kind !== "agent") throw new Error("Unknown worker");
        const requestId = `creq_${input.operationId}`;
        const turnId = `native-${input.operationId}`;
        const started: ExperimentalThreadPreparation = {
          ...preparation,
          state: "started",
          revision: 2,
          dispatch: {
            acceptedRevision: input.expectedRevision,
            queuedMessageId: `queue-${input.operationId}`,
            clientTurnRequestId: requestId,
          },
        };
        preparations.set(input.operationId, started);
        calls.workerStarts++;
        if (holdAfterWorker) holdScans = true;
        if (node.purpose === "delegation")
          store.controls.proposeDelegation(
            effect.effectId,
            (options.assignments ?? []).map((memberId) => ({ memberId })),
          );
        if (node.access === "write") {
          const current = state(preparation.environment.path);
          directories.set(current.path, {
            ...current,
            manifestDigest: runtimeHash({
              previous: current.manifestDigest,
              purpose: node.purpose,
            }),
            fileBytes: current.fileBytes + 1,
          });
        }
        if (node.purpose === "review") {
          const sealed = effect.workerBinding;
          if (!sealed || !("kind" in sealed))
            throw new Error("Missing directory binding");
          store.review(effect.effectId, {
            kind: "directory",
            snapshotId: sealed.snapshot.snapshotId,
            manifestDigest: sealed.snapshot.manifestDigest,
            outcome: "approved",
            summary: "Reviewed exact candidate",
            findings: [],
          });
        }
        events.push(
          {
            id: `accepted-${input.operationId}`,
            threadId: preparation.threadId,
            seq: 1,
            createdAt: 1,
            type: "turn/input/accepted",
            scope: { kind: "turn", turnId },
            data: {
              providerThreadId: `provider-${input.operationId}`,
              clientRequestId: requestId,
            },
          },
          {
            id: `completed-${input.operationId}`,
            threadId: preparation.threadId,
            seq: 2,
            createdAt: 2,
            type: "turn/completed",
            scope: { kind: "turn", turnId },
            data: {
              providerThreadId: `provider-${input.operationId}`,
              status: "completed",
            },
          },
        );
        return started;
      },
    },
    experimental_preparedTurns: {
      async getPreparation({ operationId }) {
        return mainPreparations.get(operationId) ?? null;
      },
      async prepare(input) {
        const prepared: ExperimentalTurnPreparation = {
          operationId: input.operationId,
          requestHash: runtimeHash(JSON.stringify(input)),
          threadId: input.threadId,
          executionContextId: input.executionContextId,
          revision: 1,
          state: "prepared",
          environment: input.environment,
          dispatch: null,
          turn: null,
          reason: null,
        };
        mainPreparations.set(input.operationId, prepared);
        return prepared;
      },
      async startPrepared(input) {
        const prior = mainPreparations.get(input.operationId);
        if (!prior || prior.state !== "prepared")
          throw new Error("Main turn replayed after start");
        calls.mainStarts++;
        const completed: ExperimentalTurnPreparation = {
          ...prior,
          state: "completed",
          revision: 2,
          dispatch: {
            acceptedRevision: input.expectedRevision,
            queuedMessageId: "queue-main",
            clientTurnRequestId: "creq_main",
          },
          turn: {
            providerThreadId: "provider-main",
            turnId: "native-main",
            acceptedEventId: "accepted-main",
            terminalEventId: "completed-main",
            terminalStatus: "completed",
          },
        };
        mainPreparations.set(input.operationId, completed);
        return completed;
      },
      async interrupt({ operationId }) {
        const value = mainPreparations.get(operationId);
        if (!value) throw new Error("Main preparation missing");
        return value;
      },
    },
    sdk: {
      threads: {
        events: {
          list: ({ threadId }) =>
            events.filter((event) => event.threadId === threadId),
        },
        stop: async () => {
          calls.stops++;
          return undefined;
        },
      },
    },
    experimental_callHostRpc(call) {
      if (call.method === "startDirectoryEffect") {
        const request = arcHostContract.startDirectoryEffect.input.parse(
          call.input,
        );
        if (jobs.has(request.effectId))
          throw new Error("Native job was duplicated");
        if (request.operation.type === "scan-directory") calls.scans++;
        else calls.mutations++;
        const record: DirectoryEffectRecord =
          request.operation.type === "scan-directory" && holdScans
            ? {
                kind: "directory",
                runId: request.runId,
                effectId: request.effectId,
                requestHash: directoryEffectRequestHash(request),
                state: "running",
                startedAt: now,
                finishedAt: null,
                receipt: null,
              }
            : complete(request);
        jobs.set(request.effectId, { request, record });
        return record;
      }
      if (
        call.method === "observeDirectoryEffect" ||
        call.method === "interruptDirectoryEffect"
      ) {
        const identity = arcHostContract.observeDirectoryEffect.input.parse(
          call.input,
        );
        const job = jobs.get(identity.effectId);
        if (job && job.record.requestHash !== identity.requestHash)
          throw new Error("Native job identity changed");
        if (
          call.method === "interruptDirectoryEffect" &&
          job?.record.state === "running"
        ) {
          if (delayedInterrupt) return job.record;
          calls.interruptedScans++;
          job.record = {
            ...job.record,
            state: "terminal",
            finishedAt: now,
            receipt: {
              kind: "directory",
              operationType: job.request.operation.type,
              outcome: "interrupted",
              errorCode: "interrupted",
              reason: "Paused",
              before: null,
              after: null,
              source: null,
              artifact: null,
              processes: [],
              finishedAt: now,
            },
          };
        }
        return job?.record ?? null;
      }
      throw new Error(`Unexpected native RPC ${call.method}`);
    },
  });
  createArcRuntimeAdapter(host.bb, store);
  function lookup(
    request: OwnedStepRequestInput,
  ): OwnedStepObservationLookupInput {
    const attempt = getOwnedAttempt(db, request.effectId);
    const terminal = attempt ? ownedTerminalObservation(attempt) : null;
    const currentRun = viewOwnedRun(db, workflow.workflowRunId);
    const {
      definitionHash: _definition,
      dependencyReceipts: _dependencies,
      lane: _lane,
      input: _input,
      ...identity
    } = request;
    return {
      ...identity,
      dispatchGeneration: currentRun.dispatchGeneration,
      ...(terminal && "validationId" in terminal.validity
        ? {
            validation: {
              validationId: terminal.validity.validationId,
              state: terminal.validity.state,
              activity:
                terminal.validity.state === "checking"
                  ? terminal.validity.activity
                  : null,
              generation: attempt!.row.validation_generation!,
            },
          }
        : {}),
    };
  }
  async function invoke(
    request: OwnedStepRequestInput,
    method: "executeStep" | "observeStep" | "interruptStep",
    record = true,
  ) {
    const generation = viewOwnedRun(
      db,
      workflow.workflowRunId,
    ).dispatchGeneration;
    const observation = ownedStepObservationInputSchema.parse(
      await host.harness.experimental_callInternalRpc(
        method,
        method === "executeStep"
          ? { ...request, dispatchGeneration: generation }
          : lookup(request),
        { callerPluginId: "workflows", signal: new AbortController().signal },
      ),
    );
    if (
      record &&
      !recordOwnedObservation(db, request.effectId, generation, observation)
    )
      throw new Error(
        `Workflow rejected ${method} ${JSON.stringify(observation)}`,
      );
    return observation;
  }
  async function settle(request: OwnedStepRequestInput) {
    for (let count = 0; count < 100; count++) {
      const effect = store.effect(request.effectId);
      const method =
        effect.observation && effect.observation.state !== "not-started"
          ? "observeStep"
          : "executeStep";
      const observation = await invoke(request, method);
      if ("receipt" in observation && observation.validity.state === "current")
        return observation;
      if (
        observation.state === "needs-reconciliation" ||
        ("receipt" in observation && observation.validity.state === "stale")
      )
        throw new Error(
          `Directory run needs reconciliation: ${JSON.stringify(observation)}`,
        );
      if (observation.state === "waiting" && observation.waitReason === "user")
        return observation;
    }
    throw new Error("Directory fixture did not settle");
  }
  function admit(nodeId: string, iteration = 0) {
    const attempt = admitOwnedStep(
      db,
      workflow.workflowRunId,
      { nodeId, iteration },
      null,
      viewOwnedRun(db, workflow.workflowRunId).dispatchGeneration,
    );
    if (!attempt) throw new Error("Directory admission blocked");
    store.reserveEffect(attempt.request);
    return attempt.request;
  }
  return {
    db,
    store,
    compiled,
    workflow,
    directories,
    jobs,
    calls,
    preparations,
    events,
    invoke,
    lookup,
    admit,
    settle,
    holdScans(value: boolean) {
      holdScans = value;
    },
    delayInterrupt(value: boolean) {
      delayedInterrupt = value;
    },
    holdAfterWorker(value: boolean) {
      holdAfterWorker = value;
    },
    completeScans() {
      holdScans = false;
      for (const job of jobs.values())
        if (job.record.state === "running") job.record = complete(job.request);
    },
    completeScan(path: string) {
      const job = [...jobs.values()].find(
        (value) =>
          value.record.state === "running" &&
          value.request.operation.type === "scan-directory" &&
          value.request.operation.target.path === path,
      );
      if (!job) throw new Error("No pending scan for this path");
      job.record = complete(job.request);
    },
    async close() {
      await host.harness.dispose();
      db.close();
    },
    execute() {
      return executeWorkflowScript({
        args: null,
        body: parseWorkflowSource(compiled.workflow.source).body,
        capabilities: {
          agent: async () => {
            throw new Error("Unadmitted agent");
          },
          async step(nodeId, iteration) {
            const request = admit(nodeId, iteration);
            const observation = await settle(request);
            if (!("receipt" in observation))
              throw new Error("Directory stage is waiting for a user decision");
            if (observation.state !== "succeeded")
              throw Object.assign(new Error("Recorded native step failed"), {
                stepFailure: {
                  workflowRunId: request.workflowRunId,
                  ownerRunId: request.ownerRunId,
                  nodeId,
                  iteration,
                  attempt: request.attempt,
                  effectId: request.effectId,
                  requestHash: request.requestHash,
                  state: observation.state,
                  receipt: observation.receipt,
                  receiptHash: observation.receiptHash,
                },
              });
            return observation.receipt;
          },
          log() {},
          phase() {},
        },
      });
    },
    receipts() {
      return store
        .completionEffects(definition.runId)
        .flatMap((effect) =>
          effect.observation &&
          "receipt" in effect.observation &&
          compiled.nodes[runtimeNodeKey(effect.request)].kind !== "orchestrator"
            ? [directoryRuntimeReceiptSchema.parse(effect.observation.receipt)]
            : [],
        );
    },
  };
}

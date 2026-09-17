import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  createThreadId,
  createQueuedThreadMessageInTransaction,
  events,
  getEnvironment,
  getThread,
  threadPreparations,
  type DbQueryConnection,
} from "@bb/db";
import { clientTurnRequestIdSchema } from "@bb/domain";
import type {
  ExperimentalPreparedThreads,
  ExperimentalThreadPreparation,
} from "@get-bb/plugin-sdk";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { createThreadFromRequest } from "./thread-create.js";
import {
  canonicalPreparationJson,
  preparationHash,
} from "./prepared-thread-state.js";
import {
  preparedThreadEnvironmentSchema,
  preparedThreadLookupSchema,
  preparedThreadRequestSchema,
  preparedThreadStartSchema,
} from "./prepared-thread-validation.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";

type PreparationRow = typeof threadPreparations.$inferSelect;

function observation(
  db: DbQueryConnection,
  row: PreparationRow,
): ExperimentalThreadPreparation {
  const identity = {
    operationId: row.operationId,
    requestHash: row.requestHash,
    threadId: row.threadId,
    revision: row.revision,
  };
  const environment =
    row.environmentJson === null
      ? null
      : preparedThreadEnvironmentSchema.parse(JSON.parse(row.environmentJson));
  const dispatch =
    row.queuedMessageId === null || row.acceptedRevision === null
      ? null
      : {
          acceptedRevision: row.acceptedRevision,
          queuedMessageId: row.queuedMessageId,
          clientTurnRequestId:
            row.clientTurnRequestId === null
              ? null
              : clientTurnRequestIdSchema.parse(row.clientTurnRequestId),
        };
  const thread = getThread(db, row.threadId);
  if (
    row.state === "cancelled" ||
    row.state === "failed" ||
    row.state === "needs-reconciliation"
  )
    return {
      ...identity,
      state: row.state,
      environment,
      dispatch,
      reason: row.reason ?? "Preparation cannot advance",
    };
  if (
    (thread === null || thread.deletedAt !== null) &&
    row.state !== "reserved" &&
    row.state !== "provisioning"
  )
    return {
      ...identity,
      state: "cancelled",
      environment,
      dispatch,
      reason: "Prepared thread was deleted",
    };
  if (row.state === "reserved" || row.state === "provisioning")
    return {
      ...identity,
      state: row.state,
      environment,
      dispatch: null,
      reason: null,
    };
  if (environment === null)
    throw new Error("Prepared worker has no retained environment");
  if (row.state === "prepared")
    return {
      ...identity,
      state: "prepared",
      environment,
      dispatch: null,
      reason: null,
    };
  if (dispatch === null)
    throw new Error("Released worker has no dispatch receipt");
  const accepted =
    dispatch.clientTurnRequestId !== null &&
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, row.threadId),
          eq(events.type, "turn/input/accepted"),
          sql`json_extract(${events.data}, '$.clientRequestId') = ${dispatch.clientTurnRequestId}`,
        ),
      )
      .limit(1)
      .get() !== undefined;
  return {
    ...identity,
    state: accepted ? "started" : "start-requested",
    environment,
    dispatch,
    reason: null,
  };
}

export function createPreparedThreadApi(
  deps: LoggedPendingInteractionWorkSessionDeps,
  owner: { pluginId: string; signal: AbortSignal },
): ExperimentalPreparedThreads {
  const generation = randomUUID();
  const ownerWhere = eq(threadPreparations.ownerPluginId, owner.pluginId);
  const openStates = [
    "reserved",
    "provisioning",
    "prepared",
    "start-requested",
  ] as const;
  const withdraw = (reason: string, old: boolean) => {
    deps.db
      .update(threadPreparations)
      .set({
        state: "needs-reconciliation",
        reason,
        revision: sql`${threadPreparations.revision} + 1`,
        updatedAt: Date.now(),
      })
      .where(
        and(
          ownerWhere,
          old
            ? ne(threadPreparations.ownerGeneration, generation)
            : eq(threadPreparations.ownerGeneration, generation),
          inArray(threadPreparations.state, [...openStates]),
        ),
      )
      .run();
  };
  withdraw(
    "Preparation owner restarted; retained effects require reconciliation",
    true,
  );
  owner.signal.addEventListener(
    "abort",
    () =>
      withdraw(
        "Preparation owner was disposed; effects require reconciliation",
        false,
      ),
    { once: true },
  );
  const assertLive = (signal?: AbortSignal) => {
    owner.signal.throwIfAborted();
    signal?.throwIfAborted();
  };
  const lookup = (db: DbQueryConnection, operationId: string) =>
    db
      .select()
      .from(threadPreparations)
      .where(and(ownerWhere, eq(threadPreparations.operationId, operationId)))
      .get() ?? null;
  return {
    async prepare(raw, options) {
      assertLive(options?.signal);
      const request = preparedThreadRequestSchema.parse(raw);
      const requestHash = preparationHash(request);
      const previous = lookup(deps.db, request.operationId);
      if (previous !== null) {
        if (previous.requestHash !== requestHash)
          throw new ApiError(
            409,
            "invalid_request",
            "Preparation operation already has different sealed input",
          );
        return observation(deps.db, previous);
      }
      const now = Date.now();
      const row = deps.db
        .insert(threadPreparations)
        .values({
          ownerPluginId: owner.pluginId,
          operationId: request.operationId,
          threadId: createThreadId(),
          requestHash,
          requestJson: canonicalPreparationJson(request),
          ownerGeneration: generation,
          turnPolicy: request.turnPolicy,
          state: "reserved",
          revision: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      void createThreadFromRequest(
        deps,
        {
          ...request.execution,
          projectId: request.projectId,
          title: request.title,
          visibility: request.visibility,
          environment: request.environment,
          input: request.input,
          ...(request.parentThreadId === null
            ? {}
            : { parentThreadId: request.parentThreadId }),
          origin: "plugin",
          originPluginId: owner.pluginId,
          experimental_executionContextId: request.executionContextId,
          startedOnBehalfOf: null,
        },
        {
          preparation: {
            threadId: row.threadId,
            assertCurrent: () => {
              assertLive();
              const current = lookup(deps.db, request.operationId);
              if (
                current?.state !== "reserved" ||
                current.ownerGeneration !== generation
              )
                throw new Error("Preparation reservation is no longer current");
            },
          },
        },
      ).catch((error) => {
        deps.db
          .update(threadPreparations)
          .set({
            state: "failed",
            reason: error instanceof Error ? error.message : String(error),
            revision: sql`${threadPreparations.revision} + 1`,
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(threadPreparations.threadId, row.threadId),
              inArray(threadPreparations.state, ["reserved", "provisioning"]),
            ),
          )
          .run();
      });
      return observation(deps.db, row);
    },
    async getPreparation(raw, options) {
      assertLive(options?.signal);
      const request = preparedThreadLookupSchema.parse(raw);
      const row = lookup(deps.db, request.operationId);
      return row === null ? null : observation(deps.db, row);
    },
    async startPrepared(raw, options) {
      assertLive(options?.signal);
      const request = preparedThreadStartSchema.parse(raw);
      let admitted = false;
      const row = deps.db.transaction(
        (tx) => {
          assertLive(options?.signal);
          const current = lookup(tx, request.operationId);
          if (current === null)
            throw new ApiError(
              404,
              "invalid_request",
              "Preparation operation not found",
            );
          const environmentJson = canonicalPreparationJson(request.environment);
          if (
            current.acceptedRevision === request.expectedRevision &&
            current.environmentJson === environmentJson &&
            current.queuedMessageId !== null
          )
            return current;
          if (
            current.state !== "prepared" ||
            current.ownerGeneration !== generation ||
            current.revision !== request.expectedRevision ||
            current.environmentJson !== environmentJson
          )
            throw new ApiError(
              409,
              "invalid_request",
              "Preparation revision, owner, state or environment changed",
            );
          const thread = getThread(tx, current.threadId);
          const environment = getEnvironment(
            tx,
            request.environment.environmentId,
          );
          if (
            thread === null ||
            thread.deletedAt !== null ||
            thread.archivedAt !== null ||
            thread.status !== "idle" ||
            thread.environmentId !== request.environment.environmentId ||
            environment?.status !== "ready" ||
            environment.path !== request.environment.path ||
            environment.hostId !== request.environment.hostId
          )
            throw new ApiError(
              409,
              "invalid_request",
              "Prepared environment is no longer ready",
            );
          const sealed = preparedThreadRequestSchema.parse(
            JSON.parse(current.requestJson),
          );
          const queued = createQueuedThreadMessageInTransaction(
            tx,
            {
              threadId: current.threadId,
              content: sealed.input,
              ...sealed.execution,
              waitingOn: null,
              sendAt: null,
              payload: { kind: "inline" },
              systemNotice: null,
            },
            { preparedOperationId: current.operationId },
          );
          admitted = true;
          return tx
            .update(threadPreparations)
            .set({
              state: "start-requested",
              acceptedRevision: request.expectedRevision,
              queuedMessageId: queued.id,
              revision: current.revision + 1,
              updatedAt: Date.now(),
            })
            .where(eq(threadPreparations.threadId, current.threadId))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      if (admitted) {
        deps.hub.notifyThread(row.threadId, ["queue-changed"]);
        requestQueuedMessageDispatch(deps, {
          kind: "thread-ready",
          threadId: row.threadId,
        });
      }
      return observation(deps.db, row);
    },
  };
}

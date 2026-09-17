import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  createQueuedThreadMessageInTransaction,
  getThread,
  getOpenThreadTurnPreparation,
  openThreadTurnPreparationStates,
  queuedThreadMessages,
  threadTurnPreparations,
  type DbQueryConnection,
} from "@bb/db";
import type { ExperimentalPreparedTurns } from "@get-bb/plugin-sdk";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  canonicalPreparationJson,
  preparationHash,
} from "./prepared-thread-state.js";
import {
  observePreparedTurn,
  preparedTurnWhere,
  preparedTurnRequestSchema,
  preparedTurnLookupSchema,
  preparedTurnControlSchema,
  requirePreparedTurnBinding,
  type PreparedTurnRow,
} from "./prepared-turn-state.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { clientTurnRequestIdSchema } from "@bb/domain";

export interface PreparedTurnStop {
  (row: PreparedTurnRow, signal: AbortSignal): Promise<void>;
}

export function createPreparedTurnApi(
  deps: LoggedPendingInteractionWorkSessionDeps,
  owner: { pluginId: string; signal: AbortSignal },
  stop: PreparedTurnStop = async (row, signal) => {
    signal.throwIfAborted();
    if (row.clientTurnRequestId === null)
      throw new Error("Conditional stop requires a retained native request");
    const sealed = preparedTurnRequestSchema.parse(JSON.parse(row.requestJson));
    const requestId = clientTurnRequestIdSchema.parse(row.clientTurnRequestId);
    const result = await runLiveHostCommand(deps, {
      hostId: sealed.environment.hostId,
      timeoutMs: 30_000,
      command: {
        type: "turn.stop-if-current",
        environmentId: sealed.environment.environmentId,
        threadId: row.threadId,
        expectedClientRequestId: requestId,
        expectedTurnId: row.turnId,
      },
    });
    if (
      (result.status === "stopped" || result.status === "already-settled") &&
      (result.clientRequestId !== requestId ||
        (row.turnId !== null && result.turnId !== row.turnId))
    )
      throw new Error(
        "Conditional stop returned a different native request identity",
      );
  },
): ExperimentalPreparedTurns {
  const generation = randomUUID();
  const ownerWhere = eq(threadTurnPreparations.ownerPluginId, owner.pluginId);
  const lookup = (db: DbQueryConnection, operationId: string) =>
    db
      .select()
      .from(threadTurnPreparations)
      .where(
        and(ownerWhere, eq(threadTurnPreparations.operationId, operationId)),
      )
      .get() ?? null;
  const requireRow = (db: DbQueryConnection, operationId: string) => {
    const row = lookup(db, operationId);
    if (row === null)
      throw new ApiError(
        404,
        "prepared_turn_not_found",
        "This preparation does not belong to the calling plugin",
      );
    return row;
  };
  const withdraw = (old: boolean, reason: string) =>
    deps.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(threadTurnPreparations)
        .where(
          and(
            ownerWhere,
            old
              ? ne(threadTurnPreparations.ownerGeneration, generation)
              : eq(threadTurnPreparations.ownerGeneration, generation),
            inArray(threadTurnPreparations.state, [
              ...openThreadTurnPreparationStates,
            ]),
          ),
        )
        .all();
      for (const row of rows) {
        if (row.clientTurnRequestId === null && row.queuedMessageId !== null)
          tx.delete(queuedThreadMessages)
            .where(eq(queuedThreadMessages.id, row.queuedMessageId))
            .run();
        tx.update(threadTurnPreparations)
          .set({
            state: "needs-reconciliation",
            reason,
            revision: row.revision + 1,
            updatedAt: Date.now(),
          })
          .where(preparedTurnWhere(row))
          .run();
      }
    });
  withdraw(
    true,
    "Preparation owner restarted; explicitly reconcile this retained turn before release",
  );
  owner.signal.addEventListener(
    "abort",
    () =>
      withdraw(
        false,
        "Preparation owner was disposed; this turn cannot advance",
      ),
    { once: true },
  );
  const assertLive = (signal?: AbortSignal) => {
    owner.signal.throwIfAborted();
    signal?.throwIfAborted();
  };
  return {
    async prepare(raw, options) {
      assertLive(options?.signal);
      const request = preparedTurnRequestSchema.parse(raw);
      const requestHash = preparationHash(request);
      const row = deps.db.transaction(
        (tx) => {
          assertLive(options?.signal);
          const previous = lookup(tx, request.operationId);
          if (previous !== null) {
            if (previous.requestHash !== requestHash)
              throw new ApiError(
                409,
                "prepared_turn_conflict",
                "This operation already identifies different immutable turn input",
              );
            return previous;
          }
          const existing = getOpenThreadTurnPreparation(tx, request.threadId);
          if (existing !== null) {
            observePreparedTurn(tx, existing);
            if (getOpenThreadTurnPreparation(tx, request.threadId) !== null)
              throw new ApiError(
                409,
                "prepared_turn_busy",
                "Another owned turn is already prepared in this conversation",
                { retryable: true },
              );
          }
          const now = Date.now();
          const created = tx
            .insert(threadTurnPreparations)
            .values({
              ownerPluginId: owner.pluginId,
              operationId: request.operationId,
              projectId: request.projectId,
              threadId: request.threadId,
              executionContextId: request.executionContextId,
              requestHash,
              requestJson: canonicalPreparationJson(request),
              environmentJson: canonicalPreparationJson(request.environment),
              ownerGeneration: generation,
              state: "prepared",
              revision: 0,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          requirePreparedTurnBinding(tx, created);
          return created;
        },
        { behavior: "immediate" },
      );
      return observePreparedTurn(deps.db, row);
    },
    async getPreparation(raw, options) {
      assertLive(options?.signal);
      const request = preparedTurnLookupSchema.parse(raw);
      const row = lookup(deps.db, request.operationId);
      return row === null ? null : observePreparedTurn(deps.db, row);
    },
    async startPrepared(raw, options) {
      assertLive(options?.signal);
      const request = preparedTurnControlSchema.parse(raw);
      let released = false;
      const row = deps.db.transaction(
        (tx) => {
          assertLive(options?.signal);
          const current = requireRow(tx, request.operationId);
          if (
            current.acceptedRevision === request.expectedRevision &&
            (current.state === "start-requested" ||
              current.clientTurnRequestId !== null)
          )
            return current;
          if (
            current.revision !== request.expectedRevision ||
            current.clientTurnRequestId !== null ||
            !(
              current.state === "prepared" ||
              current.state === "needs-reconciliation"
            )
          )
            throw new ApiError(
              409,
              "prepared_turn_conflict",
              "Preparation revision or state changed; inspect the retained turn",
            );
          requirePreparedTurnBinding(tx, current);
          const thread = getThread(tx, current.threadId);
          if (
            thread?.status !== "idle" ||
            deps.pendingInteractions.hasPendingThreadInteraction(
              current.threadId,
            )
          )
            throw new ApiError(
              409,
              "prepared_turn_busy",
              "The main conversation must be idle before this owned turn is released",
              { retryable: true },
            );
          const sealed = preparedTurnRequestSchema.parse(
            JSON.parse(current.requestJson),
          );
          if (current.queuedMessageId !== null)
            tx.delete(queuedThreadMessages)
              .where(eq(queuedThreadMessages.id, current.queuedMessageId))
              .run();
          tx.update(threadTurnPreparations)
            .set({
              state: "prepared",
              ownerGeneration: generation,
              queuedMessageId: null,
              reason: null,
            })
            .where(preparedTurnWhere(current))
            .run();
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
            {
              preparedTurn: {
                ownerPluginId: owner.pluginId,
                operationId: current.operationId,
              },
            },
          );
          released = true;
          return tx
            .update(threadTurnPreparations)
            .set({
              state: "start-requested",
              acceptedRevision: request.expectedRevision,
              interruptRevision: null,
              queuedMessageId: queued.id,
              revision: current.revision + 1,
              updatedAt: Date.now(),
            })
            .where(preparedTurnWhere(current))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      if (released) {
        deps.hub.notifyThread(row.threadId, ["queue-changed"]);
        requestQueuedMessageDispatch(deps, {
          kind: "thread-ready",
          threadId: row.threadId,
        });
      }
      return observePreparedTurn(deps.db, row);
    },
    async interrupt(raw, options) {
      assertLive(options?.signal);
      const request = preparedTurnControlSchema.parse(raw);
      const row = deps.db.transaction(
        (tx) => {
          assertLive(options?.signal);
          const initial = requireRow(tx, request.operationId);
          observePreparedTurn(tx, initial);
          const current = requireRow(tx, request.operationId);
          if (
            current.interruptRevision === request.expectedRevision ||
            current.terminalEventId !== null ||
            current.state === "cancelled"
          )
            return current;
          if (initial.revision !== request.expectedRevision)
            throw new ApiError(
              409,
              "prepared_turn_conflict",
              "Preparation revision changed before interruption",
            );
          if (
            current.clientTurnRequestId === null &&
            current.queuedMessageId !== null
          )
            tx.delete(queuedThreadMessages)
              .where(eq(queuedThreadMessages.id, current.queuedMessageId))
              .run();
          return tx
            .update(threadTurnPreparations)
            .set({
              state:
                current.clientTurnRequestId === null
                  ? "cancelled"
                  : "needs-reconciliation",
              interruptRevision: request.expectedRevision,
              reason:
                current.clientTurnRequestId === null
                  ? "Owner cancelled before native request allocation"
                  : "Owner requested conditional interruption; native evidence is pending",
              revision: current.revision + 1,
              updatedAt: Date.now(),
            })
            .where(preparedTurnWhere(current))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      if (
        row.clientTurnRequestId !== null &&
        row.terminalEventId === null &&
        row.state !== "cancelled"
      ) {
        const signal =
          options?.signal === undefined
            ? owner.signal
            : AbortSignal.any([owner.signal, options.signal]);
        await stop(row, signal);
      }
      deps.hub.notifyThread(row.threadId, ["queue-changed"]);
      return observePreparedTurn(
        deps.db,
        requireRow(deps.db, request.operationId),
      );
    },
  };
}

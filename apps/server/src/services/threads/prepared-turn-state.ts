import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  events,
  getEnvironment,
  getThread,
  getThreadPreparation,
  getThreadTurnPreparationByRequest,
  getThreadTurnPreparationByQueue,
  hasUnsettledPreparedTurn,
  threadTurnPreparations,
  type DbQueryConnection,
} from "@bb/db";
import {
  clientTurnRequestIdSchema,
  permissionModeSchema,
  promptInputSchema,
  reasoningLevelSchema,
  serviceTierSchema,
  threadEventTurnStatusSchema,
  type ClientTurnRequestId,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type {
  ExperimentalToolInvocation,
  ExperimentalOwnedTurnIdentity,
  ExperimentalTurnPreparation,
} from "@get-bb/plugin-sdk";
import { ApiError } from "../../errors.js";
import { canonicalPreparationJson } from "./prepared-thread-state.js";
import { preparedThreadEnvironmentSchema } from "./prepared-thread-validation.js";

const id = z.string().trim().min(1).max(256);
export const preparedTurnLookupSchema = z.strictObject({ operationId: id });
export const preparedTurnControlSchema = preparedTurnLookupSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const preparedTurnRequestSchema = z
  .strictObject({
    operationId: id,
    projectId: id,
    threadId: id,
    executionContextId: id,
    environment: preparedThreadEnvironmentSchema,
    execution: z.strictObject({
      providerId: id,
      model: id,
      reasoningLevel: reasoningLevelSchema,
      serviceTier: serviceTierSchema,
      permissionMode: permissionModeSchema,
    }),
    input: z.array(promptInputSchema).min(1),
  })
  .refine(
    (value) =>
      value.input.every(
        (input) => input.type !== "text" || input.mentions.length === 0,
      ),
    "Prepared existing-thread turns require resolved input without dynamic mentions",
  );

export type PreparedTurnRow = typeof threadTurnPreparations.$inferSelect;
export function preparedTurnWhere(
  row: Pick<PreparedTurnRow, "ownerPluginId" | "operationId">,
) {
  return and(
    eq(threadTurnPreparations.ownerPluginId, row.ownerPluginId),
    eq(threadTurnPreparations.operationId, row.operationId),
  );
}
const acceptedData = z.object({ clientRequestId: clientTurnRequestIdSchema });
const terminalData = z.object({ status: threadEventTurnStatusSchema });

export function observePreparedTurn(
  db: DbQueryConnection,
  row: PreparedTurnRow,
): ExperimentalTurnPreparation {
  let current = row;
  if (row.clientTurnRequestId !== null && row.terminalEventId === null) {
    const matches = db
      .select()
      .from(events)
      .where(
        and(
          eq(events.threadId, row.threadId),
          eq(events.type, "turn/input/accepted"),
          sql`json_extract(${events.data}, '$.clientRequestId') = ${row.clientTurnRequestId}`,
        ),
      )
      .limit(2)
      .all();
    const accepted = matches[0];
    if (matches.length > 1) {
      if (
        row.state !== "needs-reconciliation" ||
        row.reason !== "Native request acceptance is ambiguous"
      )
        current = db
          .update(threadTurnPreparations)
          .set({
            state: "needs-reconciliation",
            reason: "Native request acceptance is ambiguous",
            revision: row.revision + 1,
            updatedAt: Date.now(),
          })
          .where(preparedTurnWhere(row))
          .returning()
          .get();
    } else if (
      accepted !== undefined &&
      accepted.turnId !== null &&
      accepted.providerThreadId !== null
    ) {
      acceptedData.parse(JSON.parse(accepted.data));
      const terminal = db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, row.threadId),
            eq(events.turnId, accepted.turnId),
            eq(events.providerThreadId, accepted.providerThreadId),
            eq(events.type, "turn/completed"),
          ),
        )
        .limit(1)
        .get();
      const terminalValue =
        terminal === undefined
          ? null
          : terminalData.parse(JSON.parse(terminal.data));
      const state = terminalValue?.status ?? "started";
      if (
        row.acceptedEventId !== accepted.id ||
        row.state !== state ||
        terminal !== undefined
      ) {
        current =
          db
            .update(threadTurnPreparations)
            .set({
              state,
              providerThreadId: accepted.providerThreadId,
              turnId: accepted.turnId,
              acceptedEventId: accepted.id,
              terminalEventId: terminal?.id ?? null,
              terminalStatus: terminalValue?.status ?? null,
              reason: null,
              revision: row.revision + 1,
              updatedAt: Date.now(),
            })
            .where(
              and(
                preparedTurnWhere(row),
                eq(threadTurnPreparations.revision, row.revision),
              ),
            )
            .returning()
            .get() ?? row;
      }
    }
  }
  return {
    operationId: current.operationId,
    requestHash: current.requestHash,
    threadId: current.threadId,
    executionContextId: current.executionContextId,
    revision: current.revision,
    state: current.state,
    environment: preparedThreadEnvironmentSchema.parse(
      JSON.parse(current.environmentJson),
    ),
    dispatch:
      current.queuedMessageId === null || current.acceptedRevision === null
        ? null
        : {
            acceptedRevision: current.acceptedRevision,
            queuedMessageId: current.queuedMessageId,
            clientTurnRequestId:
              current.clientTurnRequestId === null
                ? null
                : clientTurnRequestIdSchema.parse(current.clientTurnRequestId),
          },
    turn:
      current.providerThreadId === null ||
      current.turnId === null ||
      current.acceptedEventId === null
        ? null
        : {
            providerThreadId: current.providerThreadId,
            turnId: current.turnId,
            acceptedEventId: current.acceptedEventId,
            terminalEventId: current.terminalEventId,
            terminalStatus: current.terminalStatus,
          },
    reason: current.reason,
  };
}

export function requirePreparedTurnBinding(
  db: DbQueryConnection,
  row: PreparedTurnRow,
): void {
  const request = preparedTurnRequestSchema.parse(JSON.parse(row.requestJson));
  const thread = getThread(db, row.threadId);
  const environment = getEnvironment(db, request.environment.environmentId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.projectId !== request.projectId ||
    thread.providerId !== request.execution.providerId ||
    thread.environmentId !== request.environment.environmentId ||
    (thread.experimental_executionContextId !== null &&
      thread.experimental_executionContextId !== undefined) ||
    !environment ||
    environment.status !== "ready" ||
    environment.hostId !== request.environment.hostId ||
    environment.path !== request.environment.path
  )
    throw new ApiError(
      409,
      "prepared_turn_binding_changed",
      "The prepared turn's project, provider, thread or environment changed",
    );
}

export function preparedTurnConfiguration(
  db: DbQueryConnection,
  queueId: string | null,
  requestId: ClientTurnRequestId,
): ExperimentalOwnedTurnIdentity | null {
  if (queueId === null) return null;
  const row = getThreadTurnPreparationByQueue(db, queueId);
  if (row === null) return null;
  if (row.state !== "start-requested" || row.clientTurnRequestId !== null)
    throw new ApiError(
      409,
      "prepared_turn_revoked",
      "This owned turn is no longer released",
    );
  requirePreparedTurnBinding(db, row);
  return {
    ownerPluginId: row.ownerPluginId,
    operationId: row.operationId,
    executionContextId: row.executionContextId,
    clientTurnRequestId: requestId,
  };
}

export function recordPreparedTurnDispatch(
  db: DbQueryConnection,
  args: {
    threadId: string;
    queueId: string | null;
    requestId: ClientTurnRequestId;
    input: PromptInput[];
    execution: ResolvedThreadExecutionOptions;
  },
): void {
  const row =
    args.queueId === null
      ? null
      : getThreadTurnPreparationByQueue(db, args.queueId);
  if (row === null) {
    if (hasUnsettledPreparedTurn(db, args.threadId))
      throw new ApiError(
        409,
        "owned_turn_active",
        "The owned turn must settle before another input can be released",
      );
    return;
  }
  preparedTurnConfiguration(db, args.queueId, args.requestId);
  const request = preparedTurnRequestSchema.parse(JSON.parse(row.requestJson));
  const thread = getThread(db, args.threadId);
  if (
    row.threadId !== args.threadId ||
    thread?.status !== "idle" ||
    canonicalPreparationJson(args.input) !==
      canonicalPreparationJson(request.input) ||
    request.execution.model !== args.execution.model ||
    request.execution.reasoningLevel !== args.execution.reasoningLevel ||
    request.execution.serviceTier !== args.execution.serviceTier ||
    request.execution.permissionMode !== args.execution.permissionMode
  )
    throw new ApiError(
      409,
      "prepared_turn_changed",
      "Owned turns require an idle conversation and the exact admitted input and execution",
    );
  db.update(threadTurnPreparations)
    .set({
      clientTurnRequestId: args.requestId,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        preparedTurnWhere(row),
        eq(threadTurnPreparations.revision, row.revision),
      ),
    )
    .run();
}

export function resolveToolInvocation(
  db: DbQueryConnection,
  input: {
    threadId: string;
    providerThreadId: string;
    turnId: string;
    callId: string;
  },
): ExperimentalToolInvocation {
  const accepted = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, input.threadId),
        eq(events.turnId, input.turnId),
        eq(events.providerThreadId, input.providerThreadId),
        eq(events.type, "turn/input/accepted"),
      ),
    )
    .limit(32)
    .all();
  const identities = accepted.map((event) =>
    acceptedData.parse(JSON.parse(event.data)),
  );
  if (identities.length === 0 || identities.length >= 32)
    throw new ApiError(
      409,
      "invocation_pending",
      "Native input ownership is not yet unambiguous; retry this tool call",
      { retryable: true },
    );
  const owned = identities
    .map((identity) => {
      const turn = getThreadTurnPreparationByRequest(
        db,
        identity.clientRequestId,
      );
      if (turn !== null)
        return {
          ownerPluginId: turn.ownerPluginId,
          operationId: turn.operationId,
          executionContextId: turn.executionContextId,
          clientTurnRequestId: identity.clientRequestId,
        };
      const preparation = getThreadPreparation(db, input.threadId);
      if (preparation?.clientTurnRequestId !== identity.clientRequestId)
        return null;
      const context = z
        .object({ executionContextId: id })
        .parse(JSON.parse(preparation.requestJson));
      return {
        ownerPluginId: preparation.ownerPluginId,
        operationId: preparation.operationId,
        executionContextId: context.executionContextId,
        clientTurnRequestId: identity.clientRequestId,
      };
    })
    .filter((value) => value !== null);
  if (owned.length > 0 && (identities.length !== 1 || owned.length !== 1))
    throw new ApiError(
      409,
      "invocation_ambiguous",
      "Several inputs share this native turn; owned invocation cannot be attributed safely",
      { retryable: true },
    );
  const terminal = db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.threadId, input.threadId),
        eq(events.turnId, input.turnId),
        eq(events.providerThreadId, input.providerThreadId),
        eq(events.type, "turn/completed"),
      ),
    )
    .limit(1)
    .get();
  if (terminal !== undefined)
    throw new ApiError(
      409,
      "invocation_stale",
      "This native turn has already settled",
    );
  return {
    providerThreadId: input.providerThreadId,
    turnId: input.turnId,
    callId: input.callId,
    ownedTurn: owned[0] ?? null,
  };
}

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  getThreadPreparation,
  getThread,
  getEnvironment,
  threadPreparations,
  assertPreparedThreadMutable,
  type DbQueryConnection,
} from "@bb/db";
import type {
  ClientTurnRequestId,
  PromptInput,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import {
  preparedThreadRequestSchema,
  preparedThreadEnvironmentSchema,
} from "./prepared-thread-validation.js";

export function canonicalPreparationJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalPreparationJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalPreparationJson(item)}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Preparation requires JSON values");
  return encoded;
}

export function preparationHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalPreparationJson(value))
    .digest("hex");
}

export function assertPreparedQueueDispatch(
  db: DbQueryConnection,
  threadId: string,
  queueIds: readonly string[],
): void {
  const row = getThreadPreparation(db, threadId);
  if (row === null) return;
  if (
    row.state === "start-requested" &&
    row.clientTurnRequestId === null &&
    queueIds.length === 1 &&
    row.queuedMessageId === queueIds[0]
  )
    return;
  assertPreparedThreadMutable(db, threadId);
}

export function recordPreparedDispatch(
  db: DbQueryConnection,
  args: {
    threadId: string;
    queuedMessageId: string | null;
    requestId: ClientTurnRequestId;
    input: PromptInput[];
    execution: ResolvedThreadExecutionOptions;
  },
): void {
  const row = getThreadPreparation(db, args.threadId);
  if (row === null) return;
  assertPreparedQueueDispatch(
    db,
    args.threadId,
    args.queuedMessageId === null ? [] : [args.queuedMessageId],
  );
  if (row.clientTurnRequestId !== null) return;
  const sealed = preparedThreadRequestSchema.parse(JSON.parse(row.requestJson));
  const thread = getThread(db, args.threadId);
  const retained =
    row.environmentJson === null
      ? null
      : preparedThreadEnvironmentSchema.parse(JSON.parse(row.environmentJson));
  const environment =
    retained === null ? null : getEnvironment(db, retained.environmentId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.providerId !== sealed.execution.providerId ||
    thread.originPluginId !== row.ownerPluginId ||
    thread.experimental_executionContextId !== sealed.executionContextId ||
    thread.projectId !== sealed.projectId ||
    retained === null ||
    thread.environmentId !== retained.environmentId ||
    environment?.status !== "ready" ||
    environment.hostId !== retained.hostId ||
    environment.path !== retained.path
  )
    throw new ApiError(
      409,
      "invalid_request",
      "Prepared worker binding changed before native dispatch",
    );
  if (
    canonicalPreparationJson(sealed.input) !==
      canonicalPreparationJson(args.input) ||
    sealed.execution.model !== args.execution.model ||
    sealed.execution.reasoningLevel !== args.execution.reasoningLevel ||
    sealed.execution.permissionMode !== args.execution.permissionMode ||
    sealed.execution.serviceTier !== args.execution.serviceTier
  )
    throw new ApiError(
      409,
      "invalid_request",
      "Prepared first input or execution changed after admission",
    );
  db.update(threadPreparations)
    .set({
      clientTurnRequestId: args.requestId,
      revision: sql`${threadPreparations.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(eq(threadPreparations.threadId, args.threadId))
    .run();
}

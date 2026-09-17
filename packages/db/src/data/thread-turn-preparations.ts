import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { events, threadTurnPreparations } from "../schema.js";

export const openThreadTurnPreparationStates = ["prepared", "start-requested", "started", "needs-reconciliation"] as const;

export function getThreadTurnPreparationByQueue(db: DbQueryConnection, queueId: string) {
  return db.select().from(threadTurnPreparations).where(eq(threadTurnPreparations.queuedMessageId, queueId)).get() ?? null;
}

export function getThreadTurnPreparationByRequest(db: DbQueryConnection, requestId: string) {
  return db.select().from(threadTurnPreparations).where(eq(threadTurnPreparations.clientTurnRequestId, requestId)).get() ?? null;
}

export function getOpenThreadTurnPreparation(db: DbQueryConnection, threadId: string) {
  return db.select().from(threadTurnPreparations).where(and(eq(threadTurnPreparations.threadId, threadId), inArray(threadTurnPreparations.state, [...openThreadTurnPreparationStates]))).get() ?? null;
}

export function assertPreparedTurnQueueMutable(db: DbQueryConnection, queueId: string): void {
  if (getThreadTurnPreparationByQueue(db, queueId) !== null) throw new Error("An owned turn queue entry can only be controlled by its preparation owner");
}

export function preparedTurnQueueCanDispatch(db: DbQueryConnection, queueIds: readonly string[]): boolean {
  if (queueIds.length === 0) return true;
  const owned = db.select().from(threadTurnPreparations).where(inArray(threadTurnPreparations.queuedMessageId, [...queueIds])).all();
  const only = owned[0];
  return owned.length === 0 || owned.length === 1 && queueIds.length === 1 && only?.state === "start-requested" && only.clientTurnRequestId === null;
}

export function getPreparedTurnQueueIds(db: DbQueryConnection, queueIds: readonly string[]): Set<string> {
  if (queueIds.length === 0) return new Set();
  return new Set(db.select({id:threadTurnPreparations.queuedMessageId}).from(threadTurnPreparations).where(inArray(threadTurnPreparations.queuedMessageId,[...queueIds])).all().flatMap(row=>row.id===null?[]:[row.id]));
}

export function assertPreparedTurnRequestMutable(db: DbQueryConnection, requestId: string): void {
  if (getThreadTurnPreparationByRequest(db, requestId) !== null) throw new Error("An owned turn cannot be retried or edited outside its preparation");
}

export function hasUnsettledPreparedTurn(db: DbQueryConnection, threadId: string): boolean {
  return db.select({ id: threadTurnPreparations.operationId }).from(threadTurnPreparations).where(and(
    eq(threadTurnPreparations.threadId, threadId),
    inArray(threadTurnPreparations.state, [...openThreadTurnPreparationStates]),
    sql`${threadTurnPreparations.clientTurnRequestId} IS NOT NULL`,
    isNull(threadTurnPreparations.terminalEventId),
    sql`NOT EXISTS (SELECT 1 FROM ${events} AS accepted JOIN ${events} AS terminal ON terminal.thread_id = accepted.thread_id AND terminal.turn_id = accepted.turn_id AND terminal.provider_thread_id = accepted.provider_thread_id WHERE accepted.thread_id = ${threadTurnPreparations.threadId} AND accepted.type = 'turn/input/accepted' AND json_extract(accepted.data, '$.clientRequestId') = ${threadTurnPreparations.clientTurnRequestId} AND terminal.type = 'turn/completed' AND (SELECT COUNT(*) FROM ${events} AS matching WHERE matching.thread_id = accepted.thread_id AND matching.type = 'turn/input/accepted' AND json_extract(matching.data, '$.clientRequestId') = json_extract(accepted.data, '$.clientRequestId')) = 1)`,
  )).limit(1).get() !== undefined;
}

export function assertPreparedTurnHistoryMutable(db: DbQueryConnection, threadId: string): void {
  if (hasUnsettledPreparedTurn(db, threadId)) throw new Error("Wait for the owned turn to settle before changing this conversation's history");
}

export function assertPreparedTurnHistorySuffixMutable(db: DbQueryConnection, threadId:string, fromSequence:number):void {
  const owned = db.select({id:threadTurnPreparations.operationId}).from(threadTurnPreparations).innerJoin(events,and(eq(events.threadId,threadTurnPreparations.threadId),eq(events.type,"client/turn/requested"),sql`json_extract(${events.data}, '$.requestId') = ${threadTurnPreparations.clientTurnRequestId}`)).where(and(eq(threadTurnPreparations.threadId,threadId),sql`${events.sequence} >= ${fromSequence}`)).limit(1).get();
  if (owned !== undefined) throw new Error("Editing this message would remove retained owned turn history");
}

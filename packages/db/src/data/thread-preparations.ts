import { and, eq, inArray, sql } from "drizzle-orm";
import type { ClientTurnRequestId } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { threadPreparations } from "../schema.js";

export function getThreadPreparation(db: DbQueryConnection, threadId: string) {
  return db.select().from(threadPreparations)
    .where(eq(threadPreparations.threadId, threadId)).get() ?? null;
}

export function assertPreparedThreadMutable(
  db: DbQueryConnection,
  threadId: string,
): void {
  const preparation = getThreadPreparation(db, threadId);
  if (preparation === null || (
    preparation.turnPolicy === "conversation" &&
    preparation.clientTurnRequestId !== null &&
    (preparation.state === "started" || preparation.state === "start-requested")
  )) return;
  throw new Error(
    "Prepared worker accepts only its admitted first turn; create a new preparation for another turn",
  );
}

export function assertPreparedThreadRequest(
  db: DbQueryConnection,
  threadId: string,
  requestId: ClientTurnRequestId,
): void {
  const preparation = getThreadPreparation(db, threadId);
  if (preparation === null) return;
  if (
    (preparation.state === "start-requested" || preparation.state === "started") &&
    preparation.clientTurnRequestId === requestId
  ) return;
  assertPreparedThreadMutable(db, threadId);
}

export function cancelThreadPreparation(
  db: DbQueryConnection,
  threadId: string,
  reason: string,
): void {
  db.update(threadPreparations).set({
    state: "cancelled",
    reason,
    revision: sql`${threadPreparations.revision} + 1`,
    updatedAt: Date.now(),
  }).where(and(
    eq(threadPreparations.threadId, threadId),
    inArray(threadPreparations.state, [
      "reserved", "provisioning", "prepared", "start-requested",
    ]),
  )).run();
}

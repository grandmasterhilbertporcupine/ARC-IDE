import { getThreadPreparation, type DbQueryConnection } from "@bb/db";
import { preparedThreadRequestSchema } from "./prepared-thread-validation.js";

export function ownerControlledParentNotification(
  db: DbQueryConnection,
  childThreadId: string,
  parentThreadId: string,
): string | null {
  const preparation = getThreadPreparation(db, childThreadId);
  if (preparation === null) return null;
  const request = preparedThreadRequestSchema.parse(
    JSON.parse(preparation.requestJson),
  );
  return request.parentNotification === "owner-controlled" &&
    request.parentThreadId === parentThreadId
    ? preparation.ownerPluginId
    : null;
}

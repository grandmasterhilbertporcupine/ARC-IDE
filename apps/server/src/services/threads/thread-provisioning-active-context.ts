import type { ThreadProvisionContext } from "./thread-provisioning-context.js";
import type { DbQueryConnection } from "@bb/db";
import { persistPreparedProvisionContext } from "./prepared-thread-provision.js";
import { persistAddressedProvision } from "./addressed-dispatch.js";

const activeThreadProvisionContexts = new Map<string, ThreadProvisionContext>();

export function rememberActiveThreadProvisionContext(entry: {
  db?: DbQueryConnection;
  context: ThreadProvisionContext;
  threadId: string;
}): void {
  if (entry.context.request.experimental_addressing) {
    if (!entry.db)
      throw new Error(
        "Addressed provisioning requires durable context storage",
      );
    persistAddressedProvision(entry.db, entry.threadId, entry.context);
  }
  if (entry.context.request.clientRequestId === null) {
    if (!entry.db)
      throw new Error("Prepared provisioning requires durable context storage");
    persistPreparedProvisionContext(entry.db, entry.threadId, entry.context);
  }
  activeThreadProvisionContexts.set(entry.threadId, entry.context);
}

export function forgetActiveThreadProvisionContext(threadId: string): void {
  activeThreadProvisionContexts.delete(threadId);
}

export function getActiveThreadProvisionContext(
  threadId: string,
): ThreadProvisionContext | null {
  return activeThreadProvisionContexts.get(threadId) ?? null;
}

import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  events,
  getEnvironment,
  getThread,
  getThreadPreparation,
  getThreadPendingStartContext,
  setThreadPendingStartContext,
  threads,
  type DbQueryConnection,
} from "@bb/db";
import {
  experimentalAddressingSchema,
  experimentalAddressedDispatchResultSchema,
  jsonValueSchema,
  systemOperationEventDataSchema,
  promptInputSchema,
  threadScope,
  type ExperimentalAddressing,
  type PromptInput,
  type Thread,
} from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { dispatchPluginAddressedMessage } from "../plugins/plugin-agent-contributions.js";
import { validatePromptAttachmentReferences } from "../projects/attachments.js";
import {
  threadProvisionContextSchema,
  type ThreadProvisionContext,
} from "./thread-provisioning-context.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { resolveMessageSenderThreadId } from "./thread-send.js";
import {
  assertPreparedQueueDispatch,
  canonicalPreparationJson,
} from "./prepared-thread-state.js";

const recordSchema = z.object({
  kind: z.literal("addressed-provision"),
  operationId: z.string().uuid(),
  requestHash: z.string(),
  state: z.enum(["provisioning", "routing", "completed", "failed"]),
  context: threadProvisionContextSchema.nullable(),
  result: experimentalAddressedDispatchResultSchema.optional(),
  error: z.string().optional(),
});

export function readAddressedProvision(
  db: DbQueryConnection,
  threadId: string,
) {
  const raw = getThreadPendingStartContext(db, threadId);
  if (!raw) return null;
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeRecord(
  db: DbQueryConnection,
  threadId: string,
  record: z.infer<typeof recordSchema>,
) {
  setThreadPendingStartContext(db, {
    threadId,
    pendingStartContext: JSON.stringify(record),
  });
}

export function assertAddressedSend(payload: {
  input: readonly PromptInput[];
  experimental_addressing?: ExperimentalAddressing;
  sendAt?: number;
}) {
  const addressedMention = payload.input.some(
    (item) =>
      item.type === "text" &&
      item.mentions.some(
        (mention) =>
          mention.resource.kind === "plugin" &&
          mention.resource.experimental_recipient,
      ),
  );
  if (addressedMention && !payload.experimental_addressing)
    throw new ApiError(
      422,
      "addressed_send_required",
      "Choose the recipients in the composer and send again. Addressed mentions cannot be sent as ordinary context.",
    );
  if (!payload.experimental_addressing) return;
  experimentalAddressingSchema.parse(payload.experimental_addressing);
  if (payload.sendAt !== undefined)
    throw new ApiError(
      422,
      "addressed_schedule_unsupported",
      "Addressed work must be sent now. Scheduled team dispatch is not supported yet.",
    );
}

const addressedDispatches = new Map<
  string,
  {
    fingerprint: string;
    task: Promise<import("@bb/domain").ExperimentalAddressedDispatchResult>;
  }
>();
const addressedThreads = new Map<string, Promise<void>>();

export function assertAddressedActorThread(
  db: DbQueryConnection,
  threadId: string | undefined,
) {
  if (!threadId) return;
  const actor = getThread(db, threadId);
  if (!actor || actor.deletedAt !== null)
    throw new ApiError(
      409,
      "invalid_request",
      "The addressed sender conversation is unavailable.",
    );
  if (
    actor.experimental_executionContextId ||
    getThreadPreparation(db, threadId)
  )
    throw new ApiError(
      409,
      "addressed_worker_denied",
      "Owned workers cannot send or retry coordinated work. Use the admitted run's message tools or report the result in the worker conversation.",
    );
}

function assertAddressedSender(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  targetThread: Thread,
  senderThreadId: string | undefined,
) {
  resolveMessageSenderThreadId(deps, { targetThread, senderThreadId });
  assertAddressedActorThread(deps.db, senderThreadId);
}

export async function dispatchAddressedMessage(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "config" | "hub">,
  thread: Thread,
  payload: Pick<
    SendMessageRequest,
    "input" | "experimental_addressing" | "sendAt" | "senderThreadId"
  >,
): Promise<import("@bb/domain").ExperimentalAddressedDispatchResult> {
  assertAddressedSend(payload);
  assertAddressedSender(deps, thread, payload.senderThreadId);
  const key = `${thread.id}:${payload.experimental_addressing?.operationId}`;
  const fingerprint = addressedCreateHash({
    input: payload.input,
    recipients: payload.experimental_addressing?.recipients,
  });
  const current = addressedDispatches.get(key);
  if (current) {
    if (current.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "addressed_operation_conflict",
        "This send operation already belongs to different input.",
      );
    return current.task;
  }
  const prior = addressedThreads.get(thread.id) ?? Promise.resolve();
  const task = prior.then(async () => {
    const latest = getThread(deps.db, thread.id);
    if (!latest)
      throw new ApiError(
        404,
        "thread_not_found",
        "This conversation no longer exists.",
      );
    assertPreparedQueueDispatch(deps.db, latest.id, []);
    assertAddressedSender(deps, latest, payload.senderThreadId);
    if (
      latest.experimental_executionContextId ||
      latest.parentThreadId ||
      latest.archivedAt !== null ||
      latest.deletedAt !== null
    )
      throw new ApiError(
        409,
        "addressed_origin_required",
        "Retry addressed work from its writable main conversation. Owned workers cannot dispatch another coordinated run.",
      );
    try {
      return await dispatchAddressedMessageInner(deps, latest, payload);
    } catch (error) {
      const addressing = payload.experimental_addressing;
      if (addressing) {
        const fingerprint = addressedCreateHash({
          input: payload.input,
          recipients: addressing.recipients,
        });
        deps.db.transaction(
          (tx) => {
            const last = tx
              .select({ data: events.data })
              .from(events)
              .where(
                and(
                  eq(events.threadId, latest.id),
                  eq(events.type, "system/operation"),
                  sql`json_extract(${events.data}, '$.operation') = 'addressed_dispatch' AND json_extract(${events.data}, '$.operationId') = ${addressing.operationId}`,
                ),
              )
              .orderBy(sql`${events.sequence} DESC`)
              .limit(1)
              .get();
            const previous = last
              ? systemOperationEventDataSchema.parse(JSON.parse(last.data))
              : null;
            if (
              previous &&
              (previous.metadata?.fingerprint !== fingerprint ||
                previous.status === "completed")
            )
              return;
            appendThreadEventInTransaction(tx, {
              threadId: latest.id,
              environmentId: latest.environmentId,
              type: "system/operation",
              scope: threadScope(),
              data: {
                operation: "addressed_dispatch",
                operationId: addressing.operationId,
                status: "failed",
                message: `Addressed work could not start: ${error instanceof Error ? error.message : String(error)}`,
                metadata: {
                  fingerprint,
                  retryAddressed: true,
                  ...(previous
                    ? {}
                    : {
                        input: jsonValueSchema.parse(payload.input),
                        recipients: jsonValueSchema.parse(
                          addressing.recipients,
                        ),
                      }),
                },
              },
            });
          },
          { behavior: "immediate" },
        );
        deps.hub.notifyThread(latest.id, ["events-appended"]);
      }
      throw error;
    }
  });
  const tail = task.then(
    () => {},
    () => {},
  );
  addressedThreads.set(thread.id, tail);
  addressedDispatches.set(key, { fingerprint, task });
  try {
    return await task;
  } finally {
    addressedDispatches.delete(key);
    if (addressedThreads.get(thread.id) === tail)
      addressedThreads.delete(thread.id);
  }
}

export async function retryAddressedMessage(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "config" | "hub">,
  thread: Thread,
  operationId: string,
  senderThreadId?: string,
) {
  assertAddressedSender(deps, thread, senderThreadId);
  const provision = readAddressedProvision(deps.db, thread.id);
  const prepared =
    provision?.operationId === operationId ? provision.context?.request : null;
  let payload: {
    input: PromptInput[];
    experimental_addressing: ExperimentalAddressing;
  };
  if (prepared?.experimental_addressing) {
    payload = {
      input: prepared.input,
      experimental_addressing: prepared.experimental_addressing,
    };
  } else {
    const row = deps.db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.threadId, thread.id),
          eq(events.type, "system/operation"),
          sql`json_extract(${events.data}, '$.operation') = 'addressed_dispatch' AND json_extract(${events.data}, '$.operationId') = ${operationId} AND json_type(${events.data}, '$.metadata.input') = 'array'`,
        ),
      )
      .orderBy(events.sequence)
      .limit(1)
      .get();
    if (!row)
      throw new ApiError(
        404,
        "addressed_request_not_found",
        "This conversation has no saved addressed request with that operation ID.",
      );
    const receipt = systemOperationEventDataSchema.parse(JSON.parse(row.data));
    payload = {
      input: z.array(promptInputSchema).parse(receipt.metadata?.input),
      experimental_addressing: experimentalAddressingSchema.parse({
        operationId,
        recipients: receipt.metadata?.recipients,
      }),
    };
  }
  const result = await dispatchAddressedMessage(deps, thread, {
    ...payload,
    senderThreadId,
  });
  if (provision?.operationId === operationId)
    writeRecord(deps.db, thread.id, {
      ...provision,
      state: "completed",
      result,
    });
  return result;
}

async function dispatchAddressedMessageInner(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "config" | "hub">,
  thread: Thread,
  payload: Pick<
    SendMessageRequest,
    "input" | "experimental_addressing" | "sendAt"
  >,
) {
  assertAddressedSend(payload);
  const addressing = payload.experimental_addressing;
  if (!addressing) throw new Error("Addressed recipients are required");
  assertPreparedQueueDispatch(deps.db, thread.id, []);
  if (thread.experimental_executionContextId || thread.parentThreadId)
    throw new ApiError(
      409,
      "addressed_origin_required",
      "Send addressed work from a main conversation. Owned worker contexts cannot start another coordinated run.",
    );
  if (thread.archivedAt !== null || thread.deletedAt !== null)
    throw new ApiError(
      409,
      "thread_not_writable",
      "Restore this conversation before sending addressed work.",
    );
  const environment = thread.environmentId
    ? getEnvironment(deps.db, thread.environmentId)
    : null;
  if (environment?.status !== "ready" || !environment.path)
    throw new ApiError(
      409,
      "addressed_workspace_not_ready",
      "The workspace is not ready. Finish workspace setup and retry the same message.",
    );
  await validatePromptAttachmentReferences({
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
  });
  const fingerprint = addressedCreateHash({
    input: payload.input,
    recipients: addressing.recipients,
  });
  const receipt = deps.db.transaction(
    (tx) => {
      const rows = tx
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operation') = 'addressed_dispatch' AND json_extract(${events.data}, '$.operationId') = ${addressing.operationId}`,
          ),
        )
        .orderBy(events.sequence)
        .all();
      const recorded = rows.map((row) =>
        systemOperationEventDataSchema.parse(JSON.parse(row.data)),
      );
      const original = recorded[0];
      if (original && original.metadata?.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "addressed_operation_conflict",
          "This send operation already belongs to different input.",
        );
      const completed = recorded.find((row) => row.status === "completed");
      if (completed)
        return experimentalAddressedDispatchResultSchema.parse(
          completed.metadata?.result,
        );
      if (!original) {
        const newThread =
          readAddressedProvision(tx, thread.id)?.operationId ===
          addressing.operationId;
        const text = payload.input
          .flatMap((input) => (input.type === "text" ? [input.text] : []))
          .join("\n\n");
        appendThreadEventInTransaction(tx, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          type: "system/operation",
          scope: threadScope(),
          data: {
            operation: "addressed_dispatch",
            operationId: addressing.operationId,
            status: "started",
            message: `${newThread ? "Sending work" : text || "Attached work"}\n\nTo ${addressing.recipients.map((recipient) => `@${recipient.label} (v${recipient.versionId})`).join(", ")}`,
            metadata: {
              fingerprint,
              input: jsonValueSchema.parse(payload.input),
              recipients: jsonValueSchema.parse(addressing.recipients),
            },
          },
        });
      }
      return null;
    },
    { behavior: "immediate" },
  );
  if (receipt) return receipt;
  deps.hub.notifyThread(thread.id, ["events-appended"]);
  const result = await dispatchPluginAddressedMessage({
    projectId: thread.projectId,
    threadId: thread.id,
    operationId: addressing.operationId,
    prompt: payload.input,
    recipients: addressing.recipients,
  });
  deps.db.transaction(
    (tx) => {
      const recorded = tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operation') = 'addressed_dispatch' AND json_extract(${events.data}, '$.operationId') = ${addressing.operationId} AND json_extract(${events.data}, '$.status') = 'completed'`,
          ),
        )
        .get();
      if (!recorded)
        appendThreadEventInTransaction(tx, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          type: "system/operation",
          scope: threadScope(),
          data: {
            operation: "addressed_dispatch",
            operationId: addressing.operationId,
            status: "completed",
            message: `${result.summary}\n\nRun: ${result.runId}`,
            metadata: { fingerprint, result: jsonValueSchema.parse(result) },
          },
        });
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(thread.id, ["events-appended"]);
  return result;
}

export function addressedCreateHash(request: object) {
  return createHash("sha256")
    .update(canonicalPreparationJson(request))
    .digest("hex");
}

export function findAddressedCreation(
  db: DbQueryConnection,
  projectId: string,
  operationId: string,
) {
  const row = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.projectId, projectId),
        isNull(threads.deletedAt),
        sql`json_valid(${threads.pendingStartContext}) AND json_extract(${threads.pendingStartContext}, '$.kind') = 'addressed-provision' AND json_extract(${threads.pendingStartContext}, '$.operationId') = ${operationId}`,
      ),
    )
    .get();
  return row ? getThread(db, row.id) : null;
}

export function reserveAddressedCreation(
  db: DbQueryConnection,
  threadId: string,
  operationId: string,
  requestHash: string,
) {
  writeRecord(db, threadId, {
    kind: "addressed-provision",
    operationId,
    requestHash,
    state: "provisioning",
    context: null,
  });
}

export function persistAddressedProvision(
  db: DbQueryConnection,
  threadId: string,
  context: ThreadProvisionContext,
) {
  const record = readAddressedProvision(db, threadId);
  if (!record)
    throw new Error("Addressed workspace preparation is no longer reserved");
  writeRecord(db, threadId, { ...record, context });
}

const dispatching = new Map<string, Promise<void>>();

export async function finishAddressedProvision(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "config" | "hub">,
  threadId: string,
) {
  const active = dispatching.get(threadId);
  if (active) return active;
  const task = (async () => {
    const record = readAddressedProvision(deps.db, threadId);
    const thread = getThread(deps.db, threadId);
    if (!record || !thread || record.state === "completed") return;
    const context = record.context;
    if (!context?.request.experimental_addressing)
      throw new Error(
        "Addressed workspace preparation is missing its send request",
      );
    writeRecord(deps.db, threadId, { ...record, state: "routing" });
    try {
      const result = await dispatchAddressedMessage(deps, thread, {
        input: context.request.input,
        experimental_addressing: context.request.experimental_addressing,
      });
      writeRecord(deps.db, threadId, { ...record, state: "completed", result });
    } catch (error) {
      writeRecord(deps.db, threadId, {
        ...record,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  })();
  dispatching.set(threadId, task);
  try {
    await task;
  } finally {
    dispatching.delete(threadId);
  }
}

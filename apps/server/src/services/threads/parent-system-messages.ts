import {
  events,
  getEnvironment,
  getLatestStoredThreadEventOfTypes,
  getThread,
  requireThreadLifecycleEventApplied,
  type DbTransaction,
} from "@bb/db";
import { and, eq, sql } from "drizzle-orm";
import { threadScope } from "@bb/domain";
import type {
  PromptInput,
  PromptMentionResource,
  PromptTextMention,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
} from "@bb/domain";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import { createQueuedThreadMessage } from "@bb/db";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
  type PreparedTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  ensureThreadCanStartRequest,
  prepareReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import {
  appendThreadEventInTransaction,
  appendClientTurnEventInTransaction,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  createClientTurnRequestId,
  getActiveTurnId,
} from "./thread-events.js";
import { ownerControlledParentNotification } from "./prepared-parent-notifications.js";
import { preparationHash } from "./prepared-thread-state.js";
import {
  dispatchTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { queueInputForStartingTurn } from "./thread-turn-starting.js";
import {
  ThreadContextClearInProgressError,
  withThreadSendGuard,
} from "./thread-context-mutation-guard.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";

const PARENT_SYSTEM_MESSAGE_SOURCE = "tell";

export interface ParentSystemMessageTaxonomy {
  systemMessageKind: SystemMessageKind;
  systemMessageSubject: SystemMessageSubject | null;
}

interface QueueParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  input: PromptInput[];
  parentThreadId: string;
}

export interface ParentSystemRenderedMention {
  resource: PromptMentionResource;
  serializedText: string;
}

export interface ParentSystemThreadMentionSource {
  id: string;
  projectId: string;
  title: string | null;
}

interface ParentSystemTextSegment {
  kind: "text";
  text: string;
}

interface ParentSystemMentionSegment {
  kind: "mention";
  mention: ParentSystemRenderedMention;
}

export type ParentSystemInputSegment =
  | ParentSystemTextSegment
  | ParentSystemMentionSegment;

interface BuildParentSystemInputFromSegmentsArgs {
  segments: readonly ParentSystemInputSegment[];
}

interface BuildParentSystemInputFromTemplateSlotArgs {
  renderedText: string;
  segments: readonly ParentSystemInputSegment[];
  slot: string;
}

interface BuildParentSystemThreadMentionArgs {
  thread: ParentSystemThreadMentionSource;
}

interface RenderedParentSystemSlotParts {
  prefix: string;
  suffix: string;
}

interface QueueReadyParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  environment: ReadyThreadEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  thread: Thread;
}

interface QueueActiveParentSystemMessageInTransactionArgs extends QueueReadyParentSystemMessageArgs {
  preparedCommand: PreparedTurnSubmitCommandPayload;
}

function splitRenderedParentSystemSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): RenderedParentSystemSlotParts {
  const start = args.renderedText.indexOf(args.slot);
  if (start === -1) {
    throw new Error("Parent system template slot was not found in message");
  }
  const next = args.renderedText.indexOf(args.slot, start + args.slot.length);
  if (next !== -1) {
    throw new Error("Parent system template slot must be unique in message");
  }

  return {
    prefix: args.renderedText.slice(0, start),
    suffix: args.renderedText.slice(start + args.slot.length),
  };
}

function buildParentSystemInputFromSegments(
  args: BuildParentSystemInputFromSegmentsArgs,
): PromptInput[] {
  let text = "";
  const mentions: PromptTextMention[] = [];

  for (const segment of args.segments) {
    if (segment.kind === "text") {
      text += segment.text;
      continue;
    }

    if (segment.mention.serializedText.length === 0) {
      throw new Error("Parent system mention text must not be empty");
    }
    const start = text.length;
    text += segment.mention.serializedText;
    mentions.push({
      start,
      end: text.length,
      resource: segment.mention.resource,
    });
  }

  return [{ type: "text", text, mentions }];
}

export function buildParentSystemInputFromTemplateSlot(
  args: BuildParentSystemInputFromTemplateSlotArgs,
): PromptInput[] {
  const parts = splitRenderedParentSystemSlot(args);
  return buildParentSystemInputFromSegments({
    segments: [
      { kind: "text", text: parts.prefix },
      ...args.segments,
      { kind: "text", text: parts.suffix },
    ],
  });
}

export function parentSystemThreadLabel(thread: {
  id: string;
  title: string | null;
}): string {
  return thread.title?.trim() || thread.id;
}

export function buildParentSystemThreadMention(
  args: BuildParentSystemThreadMentionArgs,
): ParentSystemRenderedMention {
  return {
    serializedText: `@thread:${args.thread.id}`,
    resource: {
      kind: "thread",
      label: parentSystemThreadLabel(args.thread),
      projectId: args.thread.projectId,
      threadId: args.thread.id,
    },
  };
}

function queueActiveParentSystemMessageInTransaction(
  tx: DbTransaction,
  args: QueueActiveParentSystemMessageInTransactionArgs,
): Extract<HostDaemonCommand, { type: "turn.submit" }> | null {
  const currentThread = getThread(tx, args.thread.id);
  if (
    !currentThread ||
    currentThread.environmentId !== args.environment.id ||
    currentThread.status !== "active" ||
    currentThread.archivedAt !== null ||
    currentThread.deletedAt !== null
  ) {
    return null;
  }

  const expectedSteerTurnId = getActiveTurnId({ db: tx }, args.thread.id);
  const request = appendClientTurnEventInTransaction(tx, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
    requestMethod: "turn/start",
    source: PARENT_SYSTEM_MESSAGE_SOURCE,
    target: {
      kind: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
  });
  return addRequestIdToTurnSubmitCommandPayload({
    requestId: request.requestId,
    preparedCommand: {
      ...args.preparedCommand,
      target: {
        mode: "auto",
        expectedTurnId: expectedSteerTurnId,
      },
    },
  });
}

async function queueActiveParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<boolean> {
  const expectedSteerTurnId = getActiveTurnId(deps, args.thread.id);
  if (expectedSteerTurnId === null) {
    const outcome = queueInputForStartingTurn(deps, {
      claimed: null,
      input: {
        input: args.input,
        execution: args.execution,
        payload: { kind: "inline" },
        senderThreadId: null,
        systemNotice: {
          kind: args.systemMessageKind,
          subject: args.systemMessageSubject,
        },
      },
      threadId: args.thread.id,
    });
    if (outcome.kind === "queued") return true;
    if (outcome.kind === "dispatched") return false;
    if (outcome.kind === "retry") {
      const currentThread = outcome.thread;
      if (
        currentThread === null ||
        currentThread.archivedAt !== null ||
        currentThread.deletedAt !== null ||
        currentThread.status === "stopping"
      ) {
        return false;
      }
      return queueReadyParentSystemMessage(deps, {
        ...args,
        thread: currentThread,
      });
    }
  }
  const permissionEscalation = resolvePermissionEscalation({
    initiator: "system",
  });
  await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
    thread: args.thread,
    input: args.input,
    execution: args.execution,
    permissionEscalation,
    target: {
      mode: "auto",
      expectedTurnId: expectedSteerTurnId,
    },
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
  });

  const command = deps.db.transaction(
    (tx) =>
      queueActiveParentSystemMessageInTransaction(tx, {
        ...args,
        preparedCommand,
      }),
    { behavior: "immediate" },
  );
  if (command === null) {
    return false;
  }

  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live active parent system message command failed",
      );
    },
  });
  return true;
}

async function queueReadyParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyParentSystemMessageArgs,
): Promise<boolean> {
  if (args.thread.status === "active") {
    return queueActiveParentSystemMessage(deps, args);
  }

  const permissionEscalation = resolvePermissionEscalation({
    initiator: "system",
  });
  const requestId = createClientTurnRequestId();

  const command = await prepareReadyThreadTurnCommand(deps, {
    thread: args.thread,
    fork: null,
    input: args.input,
    requestId,
    execution: args.execution,
    permissionEscalation,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: false,
  });
  const activeThread: Thread | null = deps.db.transaction(
    (tx) => {
      ensureThreadCanStartRequest(args.thread);
      appendPreparedClientTurnRequestedEventWithNotificationInTransaction(tx, {
        threadId: args.thread.id,
        environmentId: args.environment.id,
        type: "client/turn/requested",
        input: args.input,
        execution: args.execution,
        initiator: "system",
        senderThreadId: null,
        systemMessageKind: args.systemMessageKind,
        systemMessageSubject: args.systemMessageSubject,
        requestMethod: "turn/start",
        source: PARENT_SYSTEM_MESSAGE_SOURCE,
        target: { kind: "new-turn" },
        requestId,
      });
      const dispatchKind = command.mode;
      if (dispatchKind !== "turn.submit") {
        return null;
      }
      return requireThreadLifecycleEventApplied(
        applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { event: { type: "run.started" }, threadId: args.thread.id },
        ),
      );
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["client/turn/requested"],
  });
  startLiveHostCommand(deps, {
    command: command.command,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    onError: ({ error }) => {
      deps.logger.warn(
        { err: error, threadId: args.thread.id },
        "Live parent system message command failed",
      );
    },
  });
  if (activeThread) {
    deps.hub.notifyThread(
      args.thread.id,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, activeThread),
    );
  }
  return true;
}

export async function queueParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueParentSystemMessageArgs,
): Promise<boolean> {
  const parentThread = getThread(deps.db, args.parentThreadId);
  if (
    !parentThread ||
    parentThread.archivedAt !== null ||
    parentThread.deletedAt !== null
  ) {
    return false;
  }
  const delivery = recordOwnerControlledParentNotice(deps, {
    ...args,
    parentThread,
  });
  if (delivery === null) return true;
  args = { ...args, ...delivery };
  const hasPendingInteraction =
    deps.pendingInteractions.hasPendingThreadInteraction(parentThread.id);
  if (!hasPendingInteraction) {
    try {
      return await deliverParentSystemMessage(deps, {
        input: args.input,
        parentThread,
        systemMessageKind: args.systemMessageKind,
        systemMessageSubject: args.systemMessageSubject,
      });
    } catch (error) {
      if (!(error instanceof ThreadContextClearInProgressError)) throw error;
    }
  }

  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: parentThread.id,
    },
  );
  createQueuedThreadMessage(deps.db, deps.hub, {
    threadId: parentThread.id,
    content: args.input,
    senderThreadId: null,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    serviceTier: execution.serviceTier,
    waitingOn: { kind: hasPendingInteraction ? "interaction" : "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: {
      kind: args.systemMessageKind,
      subject: args.systemMessageSubject,
    },
  });
  if (!hasPendingInteraction) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: parentThread.id,
    });
  }
  return true;
}

interface DeliverParentSystemMessageArgs extends ParentSystemMessageTaxonomy {
  input: PromptInput[];
  parentThread: Thread;
}

/**
 * Dispatches a parent-system notice, with no interaction check of its own.
 *
 * Split out so the queue drain can deliver a notice that QUEUED on an
 * interaction without re-entering the check that queued it — which, on a
 * thread whose interaction settled a moment ago, would otherwise be a race
 * that could queue a second copy of the same notice.
 */
export async function deliverParentSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DeliverParentSystemMessageArgs,
): Promise<boolean> {
  const delivery = recordOwnerControlledParentNotice(deps, args);
  if (delivery === null) return true;
  return withThreadSendGuard(delivery.parentThread.id, () =>
    deliverParentSystemMessageWithContextGuard(deps, delivery),
  );
}

function recordOwnerControlledParentNotice(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub">,
  args: DeliverParentSystemMessageArgs,
): DeliverParentSystemMessageArgs | null {
  const childIds = new Set<string>();
  if (args.systemMessageSubject?.kind === "thread")
    childIds.add(args.systemMessageSubject.threadId);
  else if (args.systemMessageSubject?.kind === "thread-batch")
    for (const part of args.input) {
      if (part.type !== "text") continue;
      for (const mention of part.mentions ?? [])
        if (mention.resource.kind === "thread")
          childIds.add(mention.resource.threadId);
    }
  const owned = [...childIds].flatMap((childThreadId) => {
    const ownerPluginId = ownerControlledParentNotification(
      deps.db,
      childThreadId,
      args.parentThread.id,
    );
    return ownerPluginId === null ? [] : [{ childThreadId, ownerPluginId }];
  });
  if (owned.length === 0) return args;
  const ownedIds = new Set(owned.map(({ childThreadId }) => childThreadId));
  const ordinaryIds = [...childIds].filter((id) => !ownedIds.has(id));
  function inputFor(ids: string[]): PromptInput[] {
    const included = new Set(ids);
    return args.input.map((part) => {
      if (part.type !== "text")
        throw new Error(
          "Cannot split a mixed parent notice with non-text input",
        );
      let text = "";
      let offset = 0;
      const mentions: PromptTextMention[] = [];
      for (const line of part.text.split(/(?<=\n)/u)) {
        const lineMentions = (part.mentions ?? []).filter(
          (mention) =>
            mention.start < offset + line.length && mention.end > offset,
        );
        const references = lineMentions.flatMap((mention) =>
          mention.resource.kind === "thread" ? [mention.resource.threadId] : [],
        );
        const excluded = references.some(
          (id) => childIds.has(id) && !included.has(id),
        );
        if (excluded && references.some((id) => included.has(id)))
          throw new Error(
            "Cannot split different child outcomes on the same notice line",
          );
        if (!excluded) {
          const delta = text.length - offset;
          mentions.push(
            ...lineMentions.map((mention) => ({
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            })),
          );
          text += line;
        }
        offset += line.length;
      }
      return { ...part, text, mentions };
    });
  }
  const ownedInput =
    ordinaryIds.length === 0 ? args.input : inputFor([...ownedIds]);
  const message = ownedInput
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  const operationId = preparationHash({
    parentThreadId: args.parentThread.id,
    kind: args.systemMessageKind,
    input: ownedInput,
    owned: owned.map((child) => ({
      ...child,
      terminalSequence:
        getLatestStoredThreadEventOfTypes(deps.db, {
          threadId: child.childThreadId,
          types: ["turn/completed"],
        })?.sequence ?? null,
    })),
  });
  const inserted = deps.db.transaction(
    (tx) => {
      const previous = tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.threadId, args.parentThread.id),
            eq(events.type, "system/operation"),
            sql`json_extract(${events.data}, '$.operationId') = ${operationId}`,
          ),
        )
        .limit(1)
        .get();
      if (previous) return false;
      appendThreadEventInTransaction(tx, {
        threadId: args.parentThread.id,
        environmentId: args.parentThread.environmentId,
        scope: threadScope(),
        type: "system/operation",
        data: {
          operation: "owned_child_notice",
          operationId,
          status: "completed",
          message,
          metadata: {
            delivery: "owner-controlled",
            kind: args.systemMessageKind,
            children: owned,
          },
        },
      });
      return true;
    },
    { behavior: "immediate" },
  );
  if (inserted)
    deps.hub.notifyThread(args.parentThread.id, ["events-appended"]);
  return ordinaryIds.length === 0
    ? null
    : {
        parentThread: args.parentThread,
        input: inputFor(ordinaryIds),
        systemMessageKind: "child-outcome-batch",
        systemMessageSubject: {
          kind: "thread-batch",
          count: ordinaryIds.length,
        },
      };
}

async function deliverParentSystemMessageWithContextGuard(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: DeliverParentSystemMessageArgs,
): Promise<boolean> {
  const { parentThread } = args;
  const { environment } = requireThreadEnvironment(deps.db, parentThread.id);
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: parentThread.id,
    },
  );
  if (
    await dispatchTurnDuringReprovision({
      deps,
      environment,
      execution,
      initiator: "system",
      input: args.input,
      senderThreadId: null,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      thread: parentThread,
    })
  ) {
    return true;
  }

  const readyEnvironment = requireReadyThreadEnvironment(
    getEnvironment(deps.db, environment.id) ?? environment,
  );
  return await queueReadyParentSystemMessage(deps, {
    thread: parentThread,
    input: args.input,
    execution,
    environment: readyEnvironment,
    systemMessageKind: args.systemMessageKind,
    systemMessageSubject: args.systemMessageSubject,
  });
}

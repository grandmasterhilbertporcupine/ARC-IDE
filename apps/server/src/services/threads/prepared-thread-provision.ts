import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getThread,
  getEnvironment,
  threadPreparations,
  getThreadPreparation,
  type DbQueryConnection,
} from "@bb/db";
import type {
  Environment,
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  createMetadataPendingContext,
  hasProvisioningTimelineRow,
  type ThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
} from "./thread-provisioning-context.js";
import {
  applyLoggedThreadLifecycleEvent,
  applyLoggedThreadLifecycleEventInTransaction,
} from "./lifecycle-outcome.js";
import {
  getActiveThreadProvisionContext,
  rememberActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import { appendThreadProvisioningEventInTransaction } from "./thread-events.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { scheduleThreadProvisioningAdvance } from "./thread-provisioning.js";
import { canonicalPreparationJson } from "./prepared-thread-state.js";
import { preparedThreadRequestSchema } from "./prepared-thread-validation.js";

export function beginPreparedThreadProvision(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    environmentIntent: ThreadProvisionEnvironmentIntent;
    execution: ResolvedThreadExecutionOptions;
    input: PromptInput[];
  },
): void {
  const record = getThreadPreparation(deps.db, args.thread.id);
  if (record === null || record.state !== "reserved")
    throw new Error("Prepared reservation is no longer available");
  const sealed = preparedThreadRequestSchema.parse(
    JSON.parse(record.requestJson),
  );
  if (
    sealed.execution.providerId !== args.thread.providerId ||
    sealed.execution.model !== args.execution.model ||
    sealed.execution.reasoningLevel !== args.execution.reasoningLevel ||
    sealed.execution.permissionMode !== args.execution.permissionMode ||
    sealed.execution.serviceTier !== args.execution.serviceTier
  )
    throw new Error(
      "Resolved provider execution differs from the sealed preparation",
    );
  const context = createMetadataPendingContext({
    environmentIntent: args.environmentIntent,
    execution: args.execution,
    clientRequestId: null,
    fork: null,
    input: args.input,
    seedWithoutRun: false,
    titleProvided: true,
  });
  deps.db
    .update(threadPreparations)
    .set({
      state: "provisioning",
      provisioningContextJson: JSON.stringify(context),
      revision: record.revision + 1,
      updatedAt: Date.now(),
    })
    .where(eq(threadPreparations.threadId, args.thread.id))
    .run();
  const outcome = applyLoggedThreadLifecycleEvent(deps, {
    threadId: args.thread.id,
    event: { type: "run.preparing" },
  });
  if (!outcome.applied)
    throw new Error("Prepared thread could not begin provisioning");
  rememberActiveThreadProvisionContext({
    db: deps.db,
    threadId: args.thread.id,
    context,
  });
  scheduleThreadProvisioningAdvance(deps, context, args.thread.id);
}

export function persistPreparedProvisionContext(
  db: DbQueryConnection,
  threadId: string,
  context: ThreadProvisionContext,
): void {
  if (context.request.clientRequestId !== null) return;
  const record = getThreadPreparation(db, threadId);
  if (record?.state !== "provisioning")
    throw new Error("Prepared provisioning authority was withdrawn");
  db.update(threadPreparations)
    .set({
      provisioningContextJson: JSON.stringify(context),
      updatedAt: Date.now(),
    })
    .where(eq(threadPreparations.threadId, threadId))
    .run();
}

export function failPreparedThreadCreation(
  db: DbQueryConnection,
  threadId: string,
  reason: string,
): void {
  db.update(threadPreparations)
    .set({
      state: "failed",
      reason,
      revision: sql`${threadPreparations.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(threadPreparations.threadId, threadId),
        inArray(threadPreparations.state, ["reserved", "provisioning"]),
      ),
    )
    .run();
}

export function settlePreparedEnvironment(
  deps: Pick<
    LoggedPendingInteractionWorkSessionDeps,
    "db" | "hub" | "logger" | "providerRegistry"
  >,
  threadId: string,
  environment: Environment,
): void {
  const result = deps.db.transaction(
    (tx) => {
      const row = getThreadPreparation(tx, threadId);
      const thread = getThread(tx, threadId);
      const currentEnvironment = getEnvironment(tx, environment.id);
      const context = getActiveThreadProvisionContext(threadId);
      if (
        row?.state !== "provisioning" ||
        thread?.status !== "starting" ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.environmentId !== environment.id ||
        currentEnvironment?.status !== "ready" ||
        currentEnvironment.path === null ||
        currentEnvironment.path !== environment.path ||
        currentEnvironment.hostId !== environment.hostId ||
        context?.request.clientRequestId !== null ||
        context.state.stage !== "workspace-ready" ||
        context.state.environmentId !== environment.id ||
        row.provisioningContextJson !== JSON.stringify(context)
      )
        throw new Error("Prepared provisioning is no longer current");
      const completedProvisionSequence = hasProvisioningTimelineRow(context)
        ? appendThreadProvisioningEventInTransaction(tx, {
            threadId,
            environmentId: environment.id,
            provisioningId: context.state.provisioningId,
            status: "completed",
            entries: [],
          })
        : null;
      tx.update(threadPreparations)
        .set({
          state: "prepared",
          environmentJson: canonicalPreparationJson({
            hostId: currentEnvironment.hostId,
            environmentId: currentEnvironment.id,
            path: currentEnvironment.path,
          }),
          revision: row.revision + 1,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(threadPreparations.threadId, threadId),
            eq(threadPreparations.state, "provisioning"),
            eq(threadPreparations.revision, row.revision),
          ),
        )
        .run();
      const outcome = applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { threadId, event: { type: "run.succeeded" } },
      );
      if (!outcome.applied)
        throw new Error("Prepared provisioning could not settle to idle");
      return { thread: outcome.thread, completedProvisionSequence };
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(
    threadId,
    ["status-changed"],
    buildThreadStatusChangeMetadata(deps, result.thread),
  );
  if (result.completedProvisionSequence !== null)
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["system/thread-provisioning"],
    });
}

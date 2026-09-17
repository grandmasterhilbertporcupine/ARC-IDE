import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import type { ArcRunEffect, ArcRunStore } from "./data.js";
import type { RunAgentSnapshot } from "./definition.js";

export async function prepareRuntimeWorker(
  bb: BbPluginApi,
  store: ArcRunStore,
  effect: ArcRunEffect,
  input: {
    projectId: string;
    parentThreadId: string;
    hostId: string;
    path: string;
    prompt: string;
    title: string;
    execution: RunAgentSnapshot["execution"];
  },
  signal: AbortSignal,
  mayPrepare: boolean,
) {
  const request = store.get(effect.runId).compiled.definition.request;
  const attachments =
    "addressedAttachments" in request
      ? (request.addressedAttachments ?? [])
      : [];
  let preparation = await bb.experimental_threads.getPreparation(
    { operationId: effect.effectId },
    { signal },
  );
  if (preparation === null && mayPrepare)
    preparation = await bb.experimental_threads.prepare(
      {
        operationId: effect.effectId,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        parentNotification: "owner-controlled",
        executionContextId: effect.executionContextId,
        title: input.title,
        visibility: "visible",
        turnPolicy: "single",
        environment: {
          type: "host",
          hostId: input.hostId,
          workspace: { type: "unmanaged", path: input.path },
        },
        execution: input.execution,
        input: [
          { type: "text", text: input.prompt, mentions: [] },
          ...attachments,
        ],
      },
      { signal },
    );
  if (preparation !== null) {
    if (
      preparation.operationId !== effect.effectId ||
      (preparation.environment !== null &&
        (preparation.environment.hostId !== input.hostId ||
          preparation.environment.path !== input.path))
    )
      throw new AgentStoreError(
        "execution_context_reused",
        "The worker preparation does not match its assigned context and directory",
      );
    store.bindThread(effect.effectId, preparation.threadId);
  }
  return preparation;
}

export async function runtimeWorkerTerminal(
  bb: BbPluginApi,
  threadId: string,
  requestId: string,
  signal: AbortSignal,
) {
  const events = await bb.sdk.threads.events.list({
    threadId,
    types: ["turn/input/accepted", "turn/completed"],
    limit: "200",
    order: "asc",
    signal,
  });
  const accepted = events.find(
    (event) =>
      event.type === "turn/input/accepted" &&
      event.data.clientRequestId === requestId,
  );
  if (!accepted || accepted.scope.kind !== "turn") return null;
  const turnId = accepted.scope.turnId;
  const completed = events.find(
    (event) =>
      event.type === "turn/completed" &&
      event.scope.kind === "turn" &&
      event.scope.turnId === turnId,
  );
  return completed?.type === "turn/completed"
    ? { id: completed.id, status: completed.data.status }
    : null;
}

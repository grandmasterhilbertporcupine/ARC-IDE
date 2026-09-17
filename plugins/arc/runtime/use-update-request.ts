import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { errorMessage } from "../studio/data.js";
import type { InstructionUpdateApplication } from "./instruction-update-contract.js";
import { useRetainedRequest } from "./retained-request.js";

type PreviewIdentity = {
  runId: string;
  previewId: string;
  previewHash: string;
};
export type UpdateRequest<P extends PreviewIdentity> = {
  operationId: string;
  preview: P;
  intent: "apply" | "cancel";
};
type Application<P extends PreviewIdentity> = {
  operationId: string;
  preview: P;
  state: InstructionUpdateApplication["state"];
};
type ApplyInput = {
  operationId: string;
  previewId: string;
  previewHash: string;
};
type UpdateKey = { runId: string; operationId: string };

export function useUpdateRequest<
  P extends PreviewIdentity,
  A extends Application<P>,
>({
  runId,
  storageKey,
  schema,
  application,
  accept,
  changed,
  onIntentChange,
  actions,
}: {
  runId: string;
  storageKey: string;
  schema: z.ZodType<UpdateRequest<P>>;
  application: A | null;
  accept(application: A): void;
  changed(): void;
  onIntentChange(pending: boolean): void;
  actions: {
    apply(input: ApplyInput): Promise<A>;
    poll(input: UpdateKey): Promise<A>;
    cancel(input: UpdateKey & ApplyInput): Promise<A>;
  };
}) {
  const retained = useRetainedRequest(storageKey, schema);
  const pending =
    retained.value?.preview.runId === runId ? retained.value : null;
  const needsRetry =
    pending !== null &&
    !(
      application?.operationId === pending.operationId &&
      (application.state === "applied" || application.state === "cancelled")
    );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const retain = retained.retain;
  useEffect(() => {
    onIntentChange(needsRetry);
  }, [needsRetry, onIntentChange]);
  useEffect(() => {
    if (pending !== null && !needsRetry) retain(null);
  }, [pending, needsRetry, retain]);
  useEffect(() => () => active.current?.abort(), []);

  async function submit(request: UpdateRequest<P>) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    retain(request);
    onIntentChange(true);
    setBusy(true);
    setError(null);
    const key = {
      runId: request.preview.runId,
      operationId: request.operationId,
    };
    const input = {
      operationId: request.operationId,
      previewId: request.preview.previewId,
      previewHash: request.preview.previewHash,
    };
    const cancellation = { ...key, ...input };
    try {
      let result =
        request.intent === "cancel"
          ? await actions.cancel(cancellation)
          : await actions.apply(input);
      const startedAt = Date.now();
      for (;;) {
        controller.signal.throwIfAborted();
        accept(result);
        changed();
        if (request.intent === "cancel" && result.state === "starting") {
          retain(null);
          onIntentChange(false);
          setError(
            "Successor admission was already sealed, so this update cannot be cancelled. Continue the saved update to open and control its resulting run.",
          );
          break;
        }
        if (["applied", "cancelled", "failed"].includes(result.state)) {
          if (result.state !== "failed") {
            retain(null);
            onIntentChange(false);
          }
          break;
        }
        if (Date.now() - startedAt >= 15 * 60_000)
          throw new Error(
            "The update is still pending. Continue the saved request to check again.",
          );
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", stop);
            resolve();
          }, 1500);
          controller.signal.addEventListener("abort", stop, { once: true });
        });
        controller.signal.throwIfAborted();
        result =
          request.intent === "cancel"
            ? await actions.cancel(cancellation)
            : await actions.poll(key);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const unresolvedPending = needsRetry ? pending : null;
  const retry: UpdateRequest<P> | null =
    unresolvedPending ??
    (application
      ? {
          operationId: application.operationId,
          preview: application.preview,
          intent: application.state === "cancelling" ? "cancel" : "apply",
        }
      : null);
  return {
    pending,
    needsRetry,
    unresolvedPending,
    retry,
    submit,
    busy,
    error,
    clearError: () => setError(null),
    storageError: retained.storageError,
  };
}

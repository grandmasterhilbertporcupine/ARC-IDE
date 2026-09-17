import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import type { z } from "zod";
import { arcAddressedFollowupsRpcContract } from "../runtime/addressed-continuation-contract.js";
import { errorMessage } from "../studio/data.js";

type Followup = z.infer<
  typeof arcAddressedFollowupsRpcContract.retryAddressedFollowup.output
>;
const labels = {
  queued: "Queued after this pass",
  checking: "Verifying prior work",
  starting: "Admitting continuation",
  applied: "Continued",
  "action-required": "Needs attention",
  cancelled: "Cancelled",
};

export function AddressedFollowups({
  projectId,
  threadId,
}: {
  projectId: string;
  threadId: string;
}) {
  const rpc = useRpc<typeof arcAddressedFollowupsRpcContract>();
  const navigate = useBbNavigate();
  const [items, setItems] = useState<Followup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    try {
      const result = await rpc.call("getAddressedFollowups", {
        projectId,
        threadId,
      });
      if (generation.current === current) {
        setItems(result.followups);
        setError(null);
      }
    } catch (failure) {
      if (generation.current === current) setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
    }
  }, [rpc, projectId, threadId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  useRealtime("addressed:changed", () => void refresh());
  async function act(item: Followup, cancel: boolean) {
    if (busy) return;
    setBusy(item.operationId);
    try {
      await rpc.call(
        cancel ? "cancelAddressedFollowup" : "retryAddressedFollowup",
        {
          projectId,
          threadId,
          operationId: item.operationId,
          expectedUpdatedAt: item.updatedAt,
        },
      );
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }
  if (!items.length && !error) return null;
  const pending = items.filter(
    (item) => !["applied", "cancelled"].includes(item.state),
  );
  return (
    <details
      className="shrink-0 border-b px-4 py-2 text-xs"
      open={pending.some((item) => item.state === "action-required") || !!error}
    >
      <summary className="cursor-pointer font-medium">
        Follow-ups ·{" "}
        {pending.length
          ? `${pending.length} pending`
          : `${items.length} retained`}
      </summary>
      <p className="py-2 text-muted-foreground">
        Follow-ups preserve the checked candidate and share the conversation’s
        call and time limits.
      </p>
      {error && (
        <p role="alert" className="text-destructive-text">
          {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
        </p>
      )}
      <ol className="max-h-48 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <li key={item.operationId} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate" title={item.goal}>
                {item.goal}
              </p>
              <p className="text-muted-foreground">{labels[item.state]}</p>
              {item.error && (
                <p className="text-destructive-text">{item.error}</p>
              )}
            </div>
            {item.state === "applied" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  navigate.toPluginPanel("workspace", {
                    subPath: item.successorRunId,
                  })
                }
              >
                Open continuation
              </Button>
            )}
            {item.state === "action-required" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void act(item, false)}
              >
                Retry
              </Button>
            )}
            {["queued", "action-required"].includes(item.state) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void act(item, true)}
              >
                Cancel follow-up
              </Button>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

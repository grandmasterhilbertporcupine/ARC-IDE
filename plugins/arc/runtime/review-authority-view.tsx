import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import type { z } from "zod";
import { arcRunsRpcContract } from "./contract.js";
import { errorMessage } from "../studio/data.js";

type Authority = z.infer<
  typeof arcRunsRpcContract.getRunReviewAuthority.output
>;

export function RunReviewAuthority({ runId }: { runId: string }) {
  const rpc = useRpc<typeof arcRunsRpcContract>();
  const [data, setData] = useState<Authority | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const value = await rpc.call("getRunReviewAuthority", { runId });
      if (generation.current !== current) return;
      setData(value);
      setError(null);
    } catch (failure) {
      if (generation.current === current) setError(errorMessage(failure));
    }
  }, [rpc, runId]);
  useEffect(() => {
    setData(null);
    setError(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  if (error)
    return (
      <aside
        aria-label="Review permissions"
        className="border-b px-4 py-3 text-sm"
        role="alert"
      >
        Review permission status is unavailable. {error}
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Refresh review permissions
        </Button>
      </aside>
    );
  if (!data || data.state === "authorized") return null;
  return (
    <aside
      aria-label="Review permissions"
      className="space-y-2 border-b px-4 py-3 text-sm"
    >
      {data.state === "legacy" ? (
        <p className="text-muted-foreground">
          This older run format does not use team review permissions.
        </p>
      ) : (
        <>
          <p role="alert">
            This run's retained team lacks valid review permissions. Its saved
            results remain historical and cannot authorize further review work
            or completion.
          </p>
          <ul className="space-y-1">
            {data.diagnostics.slice(0, 3).map((diagnostic, index) => (
              <li key={index}>{diagnostic.message}</li>
            ))}
          </ul>
          {data.diagnostics.length > 3 && (
            <details>
              <summary className="cursor-pointer">
                All review permission issues ({data.diagnostics.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {data.diagnostics.map((diagnostic, index) => (
                  <li key={index}>{diagnostic.message}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-muted-foreground">
            Publish corrected permissions and explicitly review a rule update
            for active work. File verification timestamps still describe the
            retained file evidence.
          </p>
        </>
      )}
    </aside>
  );
}

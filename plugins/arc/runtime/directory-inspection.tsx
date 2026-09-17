import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { arcRunsRpcContract } from "./contract.js";
import { runtimeIdSchema } from "./definition.js";
import type { DirectorySetup } from "./source-contract.js";
import { errorMessage } from "../studio/data.js";

export function DirectoryInspection({
  projectId,
  originThreadId,
  hostId,
  path,
  onChanged,
}: {
  projectId: string;
  originThreadId: string;
  hostId: string;
  path: string;
  onChanged(value: DirectorySetup | null): void;
}) {
  const rpc = useRpc<typeof arcRunsRpcContract>();
  const navigate = useBbNavigate();
  const storageKey = `arc:directory-inspection:v1:${projectId}:${originThreadId}:${hostId}:${path}`;
  const [operationId, setOperationId] = useState<string | null>(() => {
    try {
      const value = runtimeIdSchema.safeParse(
        sessionStorage.getItem(storageKey),
      );
      return value.success ? value.data : null;
    } catch {
      return null;
    }
  });
  const [result, setResult] = useState<DirectorySetup | null>(null);
  const [loading, setLoading] = useState(operationId !== null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    onChanged(null);
    if (operationId === null) return;
    const inspectionOperationId = operationId;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const value = await rpc.call("getDirectoryRunSetup", {
          operationId: inspectionOperationId,
          projectId,
          originThreadId,
          hostId,
        });
        if (!active) return;
        setResult(value);
        onChanged(value);
        if (value.state === "pending")
          timer = setTimeout(() => void poll(), 1500);
      } catch (failure) {
        if (active) {
          setResult(null);
          setError(errorMessage(failure));
          onChanged(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, operationId, projectId, originThreadId, hostId, retry, onChanged]);

  function begin() {
    const id = crypto.randomUUID();
    onChanged(null);
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      sessionStorage.setItem(storageKey, id);
      setStorageError(null);
    } catch {
      setStorageError(
        "This browser could not retain the inspection across reloads. Keep this view open to retry it.",
      );
    }
    setOperationId(id);
  }
  const pending = loading || result?.state === "pending";
  return (
    <section
      aria-label="Project folder inspection"
      className="space-y-2 text-sm"
    >
      <p className="text-muted-foreground">
        This project runs serially in separate folder copies. Inspect its files
        before starting the team.
      </p>
      {pending && <p role="status">Inspecting project files…</p>}
      {result?.state === "ready" && (
        <p className="text-muted-foreground">
          {result.source.entryCount.toLocaleString()} entries ·{" "}
          {result.source.fileBytes.toLocaleString()} bytes ·{" "}
          <code title={result.source.manifestDigest}>
            {result.source.manifestDigest.slice(0, 12)}
          </code>
        </p>
      )}
      {result?.state === "failed" && (
        <p role="alert" className="break-words text-destructive">
          {result.reason}
        </p>
      )}
      {result?.state === "consumed" && (
        <p className="text-muted-foreground">
          This inspection already belongs to a saved run. Inspect again for a
          new run.
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {storageError && (
        <p role="alert" className="text-destructive">
          {storageError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {error && operationId !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setError(null);
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Retry saved inspection
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={begin}
          >
            {operationId === null
              ? "Inspect project folder"
              : "Refresh folder inspection"}
          </Button>
        )}
        {error && operationId !== null && (
          <Button size="sm" variant="ghost" disabled={loading} onClick={begin}>
            Start new inspection
          </Button>
        )}
        {result?.state === "consumed" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate.toPluginPanel("runs", { subPath: result.runId })
            }
          >
            Open saved run
          </Button>
        )}
      </div>
    </section>
  );
}

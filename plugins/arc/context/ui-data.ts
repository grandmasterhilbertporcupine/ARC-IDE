import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { arcContextRpcContract } from "./contract.js";
import type { HostContextStatus } from "../host-context-contract.js";
import { errorMessage } from "../studio/data.js";
import {
  CONTEXT_REFERENCE_LIMITS,
  contextReferenceNameSchema,
  contextReferenceTextSchema,
} from "./reference-contract.js";

export type ContextRpc = ReturnType<
  typeof useRpc<typeof arcContextRpcContract>
>;

export function contextProject(subPath: string): string | null {
  try {
    const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
    return parts[0] === "project" && parts[1] ? parts[1] : null;
  } catch {
    return null;
  }
}

export function latestContextStatus(
  ...observations: Array<HostContextStatus | null | undefined>
): HostContextStatus | null {
  let latest: HostContextStatus | null = null;
  for (const observed of observations) {
    if (!observed) continue;
    if (!latest) {
      latest = observed;
      continue;
    }
    const sameScope =
      observed.scope.projectId === latest.scope.projectId &&
      observed.scope.hostId === latest.scope.hostId &&
      observed.scope.environmentId === latest.scope.environmentId &&
      observed.scope.path === latest.scope.path;
    if (
      sameScope &&
      observed.indexId === latest.indexId &&
      observed.generation !== latest.generation
    ) {
      if (observed.generation > latest.generation) latest = observed;
      continue;
    }
    const observedTime = Date.parse(observed.updatedAt ?? "") || 0;
    const latestTime = Date.parse(latest.updatedAt ?? "") || 0;
    if (observedTime >= latestTime) latest = observed;
  }
  return latest;
}

export function useContextRead<T>(
  key: string,
  fetcher: (rpc: ContextRpc) => Promise<T>,
  intervalMs: number | null = null,
) {
  const rpc = useRpc<typeof arcContextRpcContract>();
  const fetchRef = useRef(fetcher);
  useEffect(() => {
    fetchRef.current = fetcher;
  });
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: true });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setState((previous) => ({
        key,
        data: previous.key === key ? previous.data : null,
        error: null,
        loading: true,
      }));
      try {
        const data = await fetchRef.current(rpc);
        if (active) setState({ key, data, error: null, loading: false });
      } catch (failure) {
        if (active)
          setState((previous) => ({
            ...previous,
            error: errorMessage(failure),
            loading: false,
          }));
      } finally {
        inFlight = false;
      }
    };
    const visible = () => void load();
    document.addEventListener("visibilitychange", visible);
    const timer = intervalMs === null ? null : setInterval(visible, intervalMs);
    void load();
    return () => {
      active = false;
      if (timer !== null) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [rpc, key, revision, intervalMs]);
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    loading: state.key !== key || state.loading,
    refresh,
  };
}

export async function readReferenceFile(file: File) {
  const name = contextReferenceNameSchema.parse(file.name);
  if (file.size > CONTEXT_REFERENCE_LIMITS.itemBytes)
    throw new Error("Choose a UTF-8 text file of 64 KiB or less.");
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${name}.`));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer))
        reject(new Error(`Could not read ${name}.`));
      else resolve(reader.result);
    };
    reader.readAsArrayBuffer(file);
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error(
      "This file is not valid UTF-8 text. Export it as UTF-8 and try again.",
    );
  }
  const parsed = contextReferenceTextSchema.safeParse(text);
  if (!parsed.success)
    throw new Error(
      "Choose nonempty UTF-8 text without null bytes, up to 64 KiB.",
    );
  return { name, text: parsed.data };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ArcAgentsRpcContract, AgentScope } from "../contract.js";

export function useStudioRpc() {
  return useRpc<ArcAgentsRpcContract>();
}

export type StudioRpc = ReturnType<typeof useStudioRpc>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useStudioQuery<T>(
  key: string,
  fetcher: (rpc: StudioRpc) => Promise<T>,
) {
  const rpc = useStudioRpc();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    loading: boolean;
    error: string | null;
  }>({ key, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useRealtime("agents:changed", refresh);
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
      error: null,
    }));
    void fetcherRef.current(rpc).then(
      (data) => {
        if (active) setState({ key, data, loading: false, error: null });
      },
      (error: unknown) => {
        if (active)
          setState((previous) => ({
            ...previous,
            key,
            loading: false,
            error: errorMessage(error),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, key, generation]);
  return {
    ...state,
    data: state.key === key ? state.data : undefined,
    refresh,
  };
}

export interface StudioRoute {
  scope: AgentScope;
  agentId: string | null;
}

export function parseStudioRoute(subPath: string): StudioRoute {
  try {
    const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "project" && parts[1])
      return {
        scope: { kind: "project", projectId: parts[1] },
        agentId: parts[2] ?? null,
      };
    return {
      scope: { kind: "library" },
      agentId: parts[0] === "library" ? (parts[1] ?? null) : null,
    };
  } catch {
    return { scope: { kind: "library" }, agentId: null };
  }
}

export function studioPath(
  scope: AgentScope,
  agentId: string | null = null,
): string {
  const prefix =
    scope.kind === "library"
      ? "library"
      : `project/${encodeURIComponent(scope.projectId)}`;
  return agentId === null ? prefix : `${prefix}/${encodeURIComponent(agentId)}`;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ArcAgentsRpcContract, AgentScope } from "../contract.js";
import type {
  ArcTeamAssistantRpcContract,
  ArcTeamsRpcContract,
  TeamDefinition,
  TeamNode,
} from "./contract.js";
import { errorMessage } from "../studio/data.js";

export function useTeamRpc() {
  return useRpc<
    ArcTeamsRpcContract & ArcTeamAssistantRpcContract & ArcAgentsRpcContract
  >();
}

type TeamRpc = ReturnType<typeof useTeamRpc>;

export function useTeamQuery<T>(
  key: string,
  fetcher: (rpc: TeamRpc) => Promise<T>,
) {
  const rpc = useTeamRpc();
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: true });
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useRealtime("teams:changed", refresh);
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      error: null,
      loading: true,
    }));
    void fetchRef.current(rpc).then(
      (data) => {
        if (active) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (active)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, key, generation]);
  return { ...state, data: state.key === key ? state.data : null, refresh };
}

export function teamRoute(subPath: string): {
  scope: AgentScope;
  teamId: string | null;
} {
  try {
    const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "project" && parts[1])
      return {
        scope: { kind: "project", projectId: parts[1] },
        teamId: parts[2] ?? null,
      };
    return {
      scope: { kind: "library" },
      teamId: parts[0] === "library" ? (parts[1] ?? null) : null,
    };
  } catch {
    return { scope: { kind: "library" }, teamId: null };
  }
}

export function teamPath(
  scope: AgentScope,
  teamId: string | null = null,
): string {
  const prefix =
    scope.kind === "library"
      ? "library"
      : `project/${encodeURIComponent(scope.projectId)}`;
  return teamId === null ? prefix : `${prefix}/${encodeURIComponent(teamId)}`;
}

export function blankTeam(name: string): TeamDefinition {
  return {
    schemaVersion: 2,
    name,
    description: "",
    leaderMemberId: null,
    groups: [],
    members: [],
    permissions: [],
    graph: { nodes: [], edges: [], entryNodeIds: [], requiredGates: [] },
    presentation: { nodes: [], groups: [], members: [] },
  };
}

export const stageLabels: Record<TeamNode["kind"], string> = {
  agent: "Agent task",
  parallel: "Parallel paths",
  join: "Join paths",
  check: "Run a check",
  review: "Review work",
  condition: "Choose a path",
  repair: "Repair and recheck",
  approval: "Ask for approval",
  integration: "Integrate changes",
  release: "Release",
  delegation: "Delegate a task",
};

export function newStage(
  kind: TeamNode["kind"],
  memberId: string | null,
): TeamNode {
  const base = { id: `stage_${crypto.randomUUID()}`, label: stageLabels[kind] };
  const member = memberId ?? "unassigned";
  const candidate = { kind: "source" } as const;
  switch (kind) {
    case "agent":
      return {
        ...base,
        kind,
        memberId: member,
        task: "",
        access: "write",
        candidate,
      };
    case "parallel":
      return { ...base, kind };
    case "join":
      return { ...base, kind, mode: "all", decisionNodeId: null };
    case "check":
      return {
        ...base,
        kind,
        candidate,
        command: { executable: "", args: [], timeoutMs: 120000 },
      };
    case "review":
      return { ...base, kind, memberId: member, task: "", candidate };
    case "condition":
      return {
        ...base,
        kind,
        predicate: {
          kind: "outcome",
          sourceNodeId: "unassigned",
          equals: "succeeded",
        },
      };
    case "repair":
      return {
        ...base,
        kind,
        body: { memberId: member, task: "" },
        checkNodeId: "unassigned",
        maxRounds: 3,
      };
    case "approval":
      return { ...base, kind, message: "", approver: "user", candidate: null };
    case "integration":
      return { ...base, kind, writerNodeIds: [], baseCandidate: candidate };
    case "release":
      return {
        ...base,
        kind,
        target: "pull-request",
        candidate,
        configurationRef: null,
      };
    case "delegation":
      return {
        ...base,
        kind,
        requesterMemberId: member,
        candidateMemberIds: [],
        task: "",
        access: "read",
        candidate,
        maxChildCalls: 1,
      };
  }
}

export type BuilderSelection = {
  kind: "node" | "edge" | "group" | "member" | "grant" | "hierarchy";
  id: string;
} | null;

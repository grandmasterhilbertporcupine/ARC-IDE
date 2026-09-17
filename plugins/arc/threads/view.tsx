import { useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalThreadViewProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { TeamWorkspace } from "../workspace/view.js";
import { errorMessage } from "../studio/data.js";
import { runIdSchema } from "../runtime/definition.js";
import {
  arcThreadBrowserRpcContract,
  type ArcThreadBindings,
  type ArcThreadRun,
} from "./contract.js";

type Origin = ArcThreadBindings["origins"][number];
function selectionKey(projectId: string, threadId: string) {
  return `arc:thread-team:v1:${projectId}:${threadId}`;
}
function readSelection(projectId: string, threadId: string) {
  try {
    return sessionStorage.getItem(selectionKey(projectId, threadId));
  } catch {
    return null;
  }
}

export function ArcThreadTeam(props: ExperimentalThreadViewProps) {
  return <ThreadTeam key={`${props.projectId}:${props.threadId}`} {...props} />;
}

function ThreadTeam({
  threadId,
  projectId,
  mainElementId,
  viewState,
  onViewStateChange,
}: ExperimentalThreadViewProps) {
  const rpc = useRpc<typeof arcThreadBrowserRpcContract>();
  const navigate = useBbNavigate();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [runs, setRuns] = useState<ArcThreadRun[]>([]);
  const parsedLink =
    viewState === null ? null : runIdSchema.safeParse(viewState);
  const linkedRun = parsedLink?.success ? parsedLink.data : null;
  const [remembered, setRemembered] = useState(
    () => linkedRun ?? readSelection(projectId, threadId),
  );
  const selected = linkedRun ?? remembered;
  useEffect(() => {
    if (linkedRun === null) return;
    try {
      sessionStorage.setItem(selectionKey(projectId, threadId), linkedRun);
    } catch {}
  }, [linkedRun, projectId, threadId]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useRef<() => void>(() => undefined);
  const older = useRef<() => void>(() => undefined);
  useRealtime("runs:changed", () => refresh.current());
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let requestedRefresh = false;
    let pages = 1;
    const load = async (more = false) => {
      if (inFlight) {
        requestedRefresh = true;
        return;
      }
      inFlight = true;
      setLoading(true);
      if (more) pages += 1;
      try {
        const collected = new Map<string, ArcThreadRun>();
        let latest: Origin | null = null;
        for (let page = 0; page < pages; page += 1) {
          const result = await rpc.call("listThreadBindings", {
            projectId,
            threadIds: [threadId],
            runLimit: 20,
            runOffset: page * 20,
          });
          if (stopped) return;
          const value = result.origins.find(
            (item) => item.threadId === threadId,
          );
          if (!value)
            throw new Error("The run list did not include this conversation");
          if (value.defaultRun)
            collected.set(value.defaultRun.runId, value.defaultRun);
          for (const run of value.runs) collected.set(run.runId, run);
          latest = value;
          if (value.nextOffset === null) break;
        }
        if (stopped) return;
        setOrigin(latest);
        setRuns(
          [...collected.values()].sort(
            (a, b) =>
              b.createdAt - a.createdAt || b.runId.localeCompare(a.runId),
          ),
        );
        setError(null);
      } catch (failure) {
        if (!stopped) setError(errorMessage(failure));
      } finally {
        inFlight = false;
        if (!stopped) {
          setLoading(false);
          if (requestedRefresh) {
            requestedRefresh = false;
            void load();
          }
        }
      }
    };
    refresh.current = () => void load();
    older.current = () => void load(true);
    const visibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = setInterval(visibility, 15_000);
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      refresh.current = () => undefined;
      older.current = () => undefined;
    };
  }, [rpc, projectId, threadId]);
  const chosen = selected ?? origin?.defaultRun?.runId ?? null;
  const savedSelectionMissing =
    selected !== null && !runs.some((run) => run.runId === selected);
  const change = (runId: string) => {
    setRemembered(runId);
    onViewStateChange(runId);
    try {
      sessionStorage.setItem(selectionKey(projectId, threadId), runId);
    } catch {}
  };
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      aria-label="Team companion"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <label
          className="text-xs text-muted-foreground"
          htmlFor={`arc-thread-run-${threadId}`}
        >
          Team run
        </label>
        <select
          id={`arc-thread-run-${threadId}`}
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
          value={chosen ?? ""}
          disabled={!origin || origin.runsTotal === 0}
          onChange={(event) => change(event.target.value)}
        >
          {!chosen && (
            <option value="">
              {origin ? "No team runs" : "Loading runs…"}
            </option>
          )}
          {savedSelectionMissing && (
            <option value={selected}>Saved run · {selected}</option>
          )}
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.team?.name ?? "Team run"} ·{" "}
              {run.state?.replaceAll("-", " ") ?? run.submission} ·{" "}
              {new Date(run.createdAt).toLocaleString()} · {run.goal}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => refresh.current()}
        >
          Refresh
        </Button>
        {origin?.nextOffset !== null && origin && (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => older.current()}
          >
            Older runs
          </Button>
        )}
      </header>
      {parsedLink !== null && !parsedLink.success && (
        <p
          role="alert"
          className="shrink-0 border-b px-3 py-2 text-sm text-destructive"
        >
          This run link is invalid. Choose a saved run from this conversation.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="shrink-0 border-b px-3 py-2 text-sm text-destructive"
        >
          {origin ? "Showing the last loaded runs. " : ""}
          {error}
        </p>
      )}
      {origin?.activeLookup === "unavailable" && (
        <p
          role="status"
          className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          Active run lookup is unavailable. Showing the latest saved run unless
          you selected another.
        </p>
      )}
      {chosen ? (
        <div className="min-h-0 flex-1">
          <TeamWorkspace
            runId={chosen}
            threadId={threadId}
            projectId={projectId}
            mainElementId={mainElementId}
          />
        </div>
      ) : origin && origin.runsTotal === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 overflow-y-auto p-4">
          <h2 className="text-base font-medium">
            Bring a team into this conversation
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose your preferred team and delegation settings in Orchestration,
            then ask the main agent to start a team run. Agent conversations and
            the saved graph will appear here.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              navigate.toPluginPanel("orchestration", { subPath: "" })
            }
          >
            Open Orchestration
          </Button>
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {error
            ? "Retry to load this conversation’s teams."
            : "Loading team runs…"}
        </p>
      )}
    </section>
  );
}

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ThreadChat,
  experimental_useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  arcWorkspaceRpcContract,
  type ArcWorkspaceCursor,
  type ArcWorkspaceView,
  type ArcWorkspaceWorker,
} from "./contract.js";
import { errorMessage } from "../studio/data.js";
import { RunReviewAuthority } from "../runtime/review-authority-view.js";
import { RunUpdateLineage, useRunUpdates } from "../runtime/run-updates.js";
import { WorkspaceResults } from "./results.js";
import { AddressedFollowups } from "./addressed-followups.js";
import { WorkspaceGraph } from "./graph.js";
import { animateWorkspaceHandoff } from "./handoff.js";

const stateLabels: Record<ArcWorkspaceWorker["state"], string> = {
  admitted: "Assigned",
  preparing: "Preparing workspace",
  prepared: "Ready to dispatch",
  "dispatch-requested": "Waiting for provider",
  "native-accepted": "Working",
  succeeded: "Finished",
  failed: "Failed",
  interrupted: "Interrupted",
  "needs-reconciliation": "Needs reconciliation",
  unavailable: "Status unavailable",
};

const purposeLabels = {
  writer: "Builder",
  reader: "Researcher",
  delegation: "Coordinator",
  repair: "Repair",
  review: "Reviewer",
};

function useWorkspace(runId: string) {
  const rpc = useRpc<typeof arcWorkspaceRpcContract>();
  const refreshRef = useRef<() => void>(() => undefined);
  const [data, setData] = useState<ArcWorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoffs, setHandoffs] = useState<ArcWorkspaceView["events"]>([]);
  useRealtime("runs:changed", () => refreshRef.current());
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let cursor: ArcWorkspaceCursor | null = null;
    const load = async () => {
      if (inFlight || stopped || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        let more = true;
        const accepted: ArcWorkspaceView["events"] = [];
        for (let page = 0; more && page < 6 && !stopped; page += 1) {
          const value = await rpc.call("getWorkspace", {
            runId,
            cursor,
            eventLimit: 50,
          });
          if (stopped) return;
          cursor = value.cursor;
          accepted.push(
            ...value.events.filter(
              (event) => event.milestone === "native-accepted",
            ),
          );
          setData(value);
          more = value.hasMoreEvents;
        }
        if (accepted.length > 0) setHandoffs(accepted);
        setError(null);
      } catch (failure) {
        if (!stopped) {
          cursor = null;
          setError(errorMessage(failure));
        }
      } finally {
        inFlight = false;
      }
    };
    refreshRef.current = () => void load();
    const visibility = () => {
      cursor = null;
      void load();
    };
    document.addEventListener("visibilitychange", visibility);
    const interval = setInterval(() => void load(), 3000);
    void load();
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => undefined;
    };
  }, [rpc, runId]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, error, handoffs, refresh };
}

export function WorkspacePanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const runId = subPath.split("/").filter(Boolean)[0];
  if (!runId)
    return (
      <section className="flex h-full flex-col items-start justify-center gap-3 p-8">
        <Icon
          name="Workflow"
          className="size-6 text-muted-foreground"
          aria-hidden
        />
        <h1 className="text-base font-medium">Your team, working together</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          Open a team run to see the main conversation, each agent’s work and
          its recorded handoffs in one workspace.
        </p>
        <Button
          variant="outline"
          onClick={() => navigate.toPluginPanel("runs", { subPath: "" })}
        >
          Choose a run
        </Button>
      </section>
    );
  return <LiveWorkspace key={runId} runId={runId} />;
}

function ProviderMark({ providerId }: { providerId: string | null }) {
  const directory = experimental_useProviders();
  const provider = directory.providers.find((item) => item.id === providerId);
  if (!provider?.logoUrl)
    return (
      <Icon
        name="Bot"
        className="size-4 shrink-0 text-muted-foreground"
        aria-label={provider?.displayName ?? providerId ?? "Agent"}
      />
    );
  const image = `url("${provider.logoUrl.replace(/["\\]/gu, "\\$&")}")`;
  return (
    <span
      role="img"
      aria-label={provider.displayName}
      className="size-4 shrink-0 bg-current"
      style={{
        maskImage: image,
        WebkitMaskImage: image,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
      }}
    />
  );
}

const Transcript = memo(function Transcript({
  threadId,
}: {
  threadId: string;
}) {
  return (
    <ThreadChat
      threadId={threadId}
      variant="timeline"
      layout="contained"
      className="min-h-0 flex-1"
    />
  );
});

const MainChat = memo(function MainChat({ threadId }: { threadId: string }) {
  return (
    <ThreadChat
      threadId={threadId}
      variant="compact"
      layout="contained"
      permissionPolicy="inherit"
      className="min-h-0 flex-1"
    />
  );
});

function WorkerPane({
  worker,
  attempts,
  onAttempt,
  onFocus,
  focused,
}: {
  worker: ArcWorkspaceWorker;
  attempts: ArcWorkspaceWorker[];
  onAttempt(effectId: string): void;
  onFocus(): void;
  focused: boolean;
}) {
  const navigate = useBbNavigate();
  return (
    <section
      aria-label={`${worker.name} ${purposeLabels[worker.purpose]} conversation`}
      data-workspace-effect={worker.effectId}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-t"
      style={worker.group ? { borderColor: worker.group.color } : undefined}
    >
      <header className="shrink-0 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <ProviderMark providerId={worker.execution.providerId} />
          <h2
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={worker.name}
          >
            {worker.name}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={onFocus}
            aria-label={`${focused ? "Exit focus" : "Focus"} ${worker.name}`}
          >
            {focused ? "All chats" : "Focus"}
          </Button>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {worker.group && <span>{worker.group.name}</span>}
          <span>
            {purposeLabels[worker.purpose]} · v{worker.revision}
          </span>
          <span className="truncate" title={worker.execution.model}>
            {worker.execution.model}
          </span>
          <span
            className={
              worker.state === "failed"
                ? "text-destructive"
                : worker.state === "native-accepted"
                  ? "text-foreground"
                  : ""
            }
          >
            {stateLabels[worker.state]}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <select
            aria-label={`${worker.name} ${purposeLabels[worker.purpose]} attempt`}
            className="min-w-0 rounded border border-input bg-background px-1 py-1 text-xs"
            value={worker.effectId}
            onChange={(event) => onAttempt(event.target.value)}
          >
            {attempts.map((attempt) => (
              <option key={attempt.effectId} value={attempt.effectId}>
                {attempt.iteration > 0 ? `Round ${attempt.iteration} · ` : ""}
                Attempt {attempt.attempt} · {stateLabels[attempt.state]}
              </option>
            ))}
          </select>
          {worker.threadId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                worker.threadId && navigate.toThread(worker.threadId)
              }
            >
              Open chat
            </Button>
          )}
        </div>
      </header>
      {worker.reason && (
        <p
          role="status"
          className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {worker.reason}
        </p>
      )}
      {worker.threadId ? (
        <Transcript threadId={worker.threadId} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 overflow-y-auto p-4">
          <p className="text-sm">{stateLabels[worker.state]}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {worker.task}
          </p>
        </div>
      )}
    </section>
  );
}

export function TeamWorkspace({
  runId,
  threadId,
  projectId,
  mainElementId,
}: {
  runId: string;
  threadId: string;
  projectId: string;
  mainElementId: string;
}) {
  return (
    <LiveWorkspace
      key={runId}
      runId={runId}
      companion={{ threadId, projectId, mainElementId }}
    />
  );
}

function LiveWorkspace({
  runId,
  companion,
}: {
  runId: string;
  companion?: { threadId: string; projectId: string; mainElementId: string };
}) {
  const navigate = useBbNavigate();
  const query = useWorkspace(runId);
  const runUpdates = useRunUpdates(
    runId,
    query.data !== null && query.data.run.definition.schemaVersion !== 1,
  );
  const latestData = useRef(query.data);
  useEffect(() => {
    latestData.current = query.data;
  }, [query.data]);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const graphToggleRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(1000);
  const [focus, setFocus] = useState<string | null>(null);
  const [compactNode, setCompactNode] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphRealized, setGraphRealized] = useState(false);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [workerOverview, setWorkerOverview] = useState(false);
  const shownKeys = useRef(new Set<string>());
  const companionMainId = companion?.mainElementId ?? null;
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    const data = latestData.current;
    if (!root || !data || query.handoffs.length === 0) return;
    const cleanups: (() => void)[] = [];
    const notices: string[] = [];
    for (const event of query.handoffs) {
      if (shownKeys.current.has(event.key)) continue;
      shownKeys.current.add(event.key);
      const worker = data.workers.find(
        (item) => item.effectId === event.effectId,
      );
      if (!worker) continue;
      notices.push(
        `${worker.name} accepted its ${purposeLabels[worker.purpose].toLowerCase()} assignment.`,
      );
      if (
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.visibilityState === "hidden"
      )
        continue;
      const target = Array.from(
        root.querySelectorAll<HTMLElement>("[data-workspace-effect]"),
      ).find((element) => element.dataset.workspaceEffect === event.effectId);
      const source = companionMainId
        ? document.getElementById(companionMainId)
        : mainRef.current;
      if (!source || !target) continue;
      const cleanup = animateWorkspaceHandoff(
        source,
        target,
        event.key,
        worker.group?.color ?? getComputedStyle(root).color,
      );
      if (cleanup) cleanups.push(cleanup);
    }
    if (notices.length > 0) setAnnouncement(notices.join(" "));
    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [query.handoffs, companionMainId]);

  const data = query.data;
  const groups = new Map<string, ArcWorkspaceWorker[]>();
  for (const worker of data?.workers ?? []) {
    const group = groups.get(worker.nodeId) ?? [];
    group.push(worker);
    groups.set(worker.nodeId, group);
  }
  for (const group of groups.values())
    group.sort((a, b) => b.iteration - a.iteration || b.attempt - a.attempt);
  const workers = [...groups].map(
    ([nodeId, choices]) =>
      choices.find((worker) => worker.effectId === attempts[nodeId]) ??
      choices[0],
  );
  workers.sort(
    (a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId),
  );
  const compact =
    workers.find((worker) => worker.nodeId === compactNode) ?? workers[0];
  const selected = workers.find((worker) => worker.nodeId === focus);
  const overviewWorkers = workers.slice(-4);
  if (
    compactNode !== null &&
    compact &&
    !overviewWorkers.some((worker) => worker.nodeId === compact.nodeId)
  )
    overviewWorkers[0] = compact;
  const visibleWorkers = selected
    ? [selected]
    : width >= 1450 || workerOverview
      ? overviewWorkers
      : compact
        ? [compact]
        : [];
  const mainVisible = focus === null || focus === "main" || !selected;
  const workerVisible =
    focus !== "main" &&
    (companion !== undefined || width >= 800 || selected !== undefined);
  const showMain =
    companion === undefined &&
    mainVisible &&
    !selected &&
    !(width < 800 && graphOpen && focus !== "main");
  const mountMain = companion === undefined && mainVisible && !selected;
  const graphAvailable =
    data !== null && data.run.definition.schemaVersion !== 1;
  const showGraph = graphAvailable && graphOpen && focus !== "main";
  const showWorkers = workerVisible && visibleWorkers.length > 0;
  const showTeam = showGraph || showWorkers;
  const closeGraph = useCallback(() => {
    setGraphOpen(false);
    graphToggleRef.current?.focus();
  }, []);
  const inspectWorker = useCallback(
    (worker: ArcWorkspaceWorker) => {
      setCompactNode(worker.nodeId);
      setAttempts((previous) => ({
        ...previous,
        [worker.nodeId]: worker.effectId,
      }));
      setFocus(width < 800 ? worker.nodeId : null);
    },
    [width],
  );
  const openDetail = useCallback(
    () => navigate.toPluginPanel("runs", { subPath: runId }),
    [navigate, runId],
  );
  const candidateDigest = data
    ? "kind" in data.run.verification
      ? data.run.verification.manifestDigest
      : data.run.verification.head
    : null;

  if (
    data &&
    companion &&
    (data.origin.threadId !== companion.threadId ||
      data.run.summary.projectId !== companion.projectId)
  )
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        This run belongs to a different conversation. Refresh the team
        selection.
      </p>
    );

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-base font-medium">
            {companion ? "Team activity" : "Workspace"}
          </h1>
          <div className="flex items-center gap-1">
            {data && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  navigate.toPluginPanel("context", {
                    subPath: `project/${encodeURIComponent(data.run.summary.projectId)}`,
                  })
                }
              >
                Context
              </Button>
            )}
            {graphAvailable && (
              <Button
                ref={graphToggleRef}
                size="sm"
                variant={showGraph ? "secondary" : "ghost"}
                aria-expanded={showGraph}
                aria-controls="arc-workspace-graph"
                onClick={() => {
                  if (showGraph) closeGraph();
                  else {
                    setGraphRealized(true);
                    setGraphOpen(true);
                    setFocus(null);
                  }
                }}
              >
                Graph
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={query.refresh}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={activityOpen}
              onClick={() => setActivityOpen((value) => !value)}
            >
              Activity
            </Button>
            <Button size="sm" variant="outline" onClick={openDetail}>
              Run details
            </Button>
          </div>
        </div>
        <p
          className="mt-1 truncate text-sm text-muted-foreground"
          title={data?.run.summary.goal}
        >
          {data?.run.summary.goal ?? "Loading the saved run…"}
        </p>
        {data && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {data.run.workflow?.state.replaceAll("-", " ") ??
                data.run.summary.submission}
            </span>
            {data.run.workflow && (
              <span>
                {data.run.workflow.activeAgents} active ·{" "}
                {data.run.workflow.agentCalls} /{" "}
                {data.run.workflow.limits.maxAgentCalls}{" "}
                {data.run.definition.schemaVersion >= 3
                  ? "agent calls"
                  : "worker calls"}
              </span>
            )}
            {data.run.verification.state !== "pending" && (
              <span
                className={
                  data.run.verification.state === "stale"
                    ? "text-destructive"
                    : "text-foreground"
                }
              >
                {runUpdates.data?.outgoing?.application.state === "applied"
                  ? `Historical candidate · replaced by ${runUpdates.data.outgoing.kind === "rules" ? "rule" : "instruction"} update`
                  : data.run.verification.state === "current"
                    ? "kind" in data.run.verification
                      ? "Last verified candidate"
                      : "Verified candidate"
                    : data.run.verification.state === "checking"
                      ? "Verifying folder contents…"
                      : data.run.verification.state === "stale"
                        ? "Verification is stale"
                        : "Verification unavailable"}
                {candidateDigest ? ` · ${candidateDigest.slice(0, 12)}` : ""}
                {"kind" in data.run.verification &&
                  data.run.verification.checkedAt && (
                    <>
                      {" "}
                      ·{" "}
                      <time dateTime={data.run.verification.checkedAt}>
                        {new Date(
                          data.run.verification.checkedAt,
                        ).toLocaleString()}
                      </time>
                    </>
                  )}
              </span>
            )}
          </div>
        )}
      </header>
      {data && <WorkspaceResults key={runId} run={data.run} />}
      {data &&
        "addressedRecipients" in data.run.definition.request &&
        data.run.definition.request.addressedRecipients && (
          <AddressedFollowups
            key={data.run.definition.request.originThreadId}
            projectId={data.run.summary.projectId}
            threadId={data.run.definition.request.originThreadId}
          />
        )}
      <RunUpdateLineage state={runUpdates.data} />
      {data && data.run.definition.schemaVersion !== 1 && (
        <RunReviewAuthority runId={runId} />
      )}
      {runUpdates.error && (
        <p
          role="alert"
          className="shrink-0 border-b px-4 py-2 text-sm text-destructive"
        >
          Run update status is unavailable.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runUpdates.refresh()}
          >
            Refresh update status
          </Button>
        </p>
      )}
      {query.error && (
        <div
          role="alert"
          className="shrink-0 border-b px-4 py-2 text-sm text-destructive"
        >
          {data ? "Showing the last observed state. " : ""}
          {query.error}{" "}
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {data && (
        <>
          <nav
            aria-label="Workspace conversations"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1"
          >
            <Button
              size="sm"
              variant={focus === null ? "secondary" : "ghost"}
              aria-pressed={focus === null}
              onClick={() => setFocus(null)}
            >
              Overview
            </Button>
            {!companion && (
              <Button
                size="sm"
                variant={focus === "main" ? "secondary" : "ghost"}
                aria-pressed={focus === "main"}
                onClick={() => setFocus("main")}
              >
                Main conversation
              </Button>
            )}
            {width >= 800 && width < 1450 && workers.length > 1 && (
              <Button
                size="sm"
                variant={
                  workerOverview && focus === null ? "secondary" : "ghost"
                }
                aria-pressed={workerOverview && focus === null}
                onClick={() => {
                  setWorkerOverview((value) => !value);
                  setFocus(null);
                }}
              >
                Worker overview
              </Button>
            )}
            {workers.map((worker) => (
              <Button
                key={worker.nodeId}
                size="sm"
                aria-pressed={
                  focus === worker.nodeId ||
                  (compact?.nodeId === worker.nodeId &&
                    width < 1450 &&
                    focus === null)
                }
                variant={
                  focus === worker.nodeId ||
                  (compact?.nodeId === worker.nodeId &&
                    width < 1450 &&
                    focus === null)
                    ? "secondary"
                    : "ghost"
                }
                onClick={() => {
                  setCompactNode(worker.nodeId);
                  setFocus(width < 800 || width >= 1450 ? worker.nodeId : null);
                }}
              >
                {worker.name} · {purposeLabels[worker.purpose]}
              </Button>
            ))}
          </nav>
          {showWorkers && workers.length > visibleWorkers.length && (
            <p className="shrink-0 border-b px-4 py-1 text-xs text-muted-foreground">
              Showing {visibleWorkers.length} of {workers.length} loaded worker
              conversations. Choose another conversation above
              {graphAvailable ? " or select its stage in the graph." : "."}
            </p>
          )}
          {data.workersTruncated && (
            <p
              role="status"
              className="shrink-0 px-4 py-2 text-xs text-muted-foreground"
            >
              Showing the latest {data.workers.length} of {data.workersTotal}{" "}
              worker attempts. Run details retains the full execution history.
            </p>
          )}
          {activityOpen && (
            <section
              aria-label="Recorded activity"
              className="max-h-48 shrink-0 overflow-y-auto border-b px-4 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Recorded execution</h2>
                <span className="text-xs text-muted-foreground">
                  {data.effectsTotal} steps
                </span>
              </div>
              {data.effects
                .slice()
                .reverse()
                .slice(0, 12)
                .map((effect) => (
                  <div
                    key={effect.effectId}
                    className="flex items-center justify-between gap-3 border-t py-1 text-xs"
                  >
                    <span>
                      {effect.nodeId.replaceAll("-", " ")}
                      {effect.iteration > 0
                        ? ` · round ${effect.iteration}`
                        : ""}{" "}
                      · attempt {effect.attempt}
                    </span>
                    <span className="text-muted-foreground">
                      {effect.state.replaceAll("-", " ")}
                    </span>
                  </div>
                ))}
              <Button size="sm" variant="ghost" onClick={openDetail}>
                All steps and evidence
              </Button>
            </section>
          )}
          <div
            className="grid min-h-0 flex-1 overflow-hidden"
            style={{
              gridTemplateColumns:
                showMain && showTeam && width >= 800
                  ? "minmax(320px, .9fr) minmax(0, 1.6fr)"
                  : "minmax(0, 1fr)",
              gridTemplateRows: "minmax(0, 1fr)",
            }}
          >
            {mountMain && (
              <section
                ref={mainRef}
                hidden={!showMain}
                aria-label="Main orchestrator conversation"
                className={
                  showMain
                    ? "flex min-h-0 min-w-0 flex-col overflow-hidden"
                    : "hidden"
                }
              >
                <header className="shrink-0 border-b px-3 py-2">
                  <div className="flex items-center gap-2">
                    <ProviderMark providerId={data.origin.providerId} />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
                      Main conversation
                    </h2>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setFocus(focus === "main" ? null : "main")}
                    >
                      {focus === "main" ? "All chats" : "Focus"}
                    </Button>
                  </div>
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={data.origin.title ?? undefined}
                  >
                    {data.origin.model ??
                      data.origin.providerId ??
                      "Project conversation"}
                    {data.origin.title ? ` · ${data.origin.title}` : ""}
                  </p>
                </header>
                <MainChat threadId={data.origin.threadId} />
              </section>
            )}
            <div
              hidden={!showTeam}
              className={
                showTeam
                  ? "flex min-h-0 min-w-0 flex-col overflow-hidden"
                  : "hidden"
              }
            >
              <section
                id="arc-workspace-graph"
                hidden={!showGraph}
                aria-label="Workspace graph pane"
                className={
                  showGraph
                    ? "flex min-h-0 shrink-0 flex-col overflow-hidden border-b border-l"
                    : "hidden"
                }
                style={
                  showGraph
                    ? {
                        height: showWorkers
                          ? graphExpanded
                            ? "65%"
                            : "40%"
                          : "100%",
                        minHeight: 280,
                      }
                    : undefined
                }
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
                  <h2 className="text-sm font-medium">Saved team graph</h2>
                  <div className="flex items-center gap-1">
                    {showWorkers && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={graphExpanded}
                        onClick={() => setGraphExpanded((value) => !value)}
                      >
                        {graphExpanded ? "Smaller graph" : "Larger graph"}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={closeGraph}>
                      Hide graph
                    </Button>
                  </div>
                </div>
                {graphRealized && graphAvailable && (
                  <WorkspaceGraph
                    run={data.run}
                    visible={showGraph}
                    workers={data.workers}
                    workersTruncated={data.workersTruncated}
                    onWorker={inspectWorker}
                    onRunDetails={openDetail}
                  />
                )}
              </section>
              {showWorkers && (
                <div
                  className={
                    workerOverview && width < 1450 && !selected
                      ? "grid min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
                      : "grid min-h-0 min-w-0 flex-1 overflow-hidden"
                  }
                  style={{
                    gridTemplateColumns:
                      width >= 1450 && !selected && visibleWorkers.length > 1
                        ? "repeat(2, minmax(0, 1fr))"
                        : "minmax(0, 1fr)",
                    gridAutoRows:
                      workerOverview && width < 1450 && !selected
                        ? "minmax(260px, 1fr)"
                        : "minmax(0, 1fr)",
                  }}
                >
                  {visibleWorkers.map((worker) => (
                    <WorkerPane
                      key={worker.nodeId}
                      worker={worker}
                      attempts={groups.get(worker.nodeId) ?? [worker]}
                      onAttempt={(effectId) =>
                        setAttempts((previous) => ({
                          ...previous,
                          [worker.nodeId]: effectId,
                        }))
                      }
                      onFocus={() => setFocus(selected ? null : worker.nodeId)}
                      focused={selected?.nodeId === worker.nodeId}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          {workers.length === 0 && (
            <p className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">
              Worker conversations appear when the run admits an assignment.
              Open Run details to inspect preparation or control execution.
            </p>
          )}
        </>
      )}
    </div>
  );
}

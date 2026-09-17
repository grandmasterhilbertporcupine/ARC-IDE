import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { z } from "zod";
import { arcOrchestratorRpcContract } from "../orchestrator/contract.js";
import {
  arcRunsRpcContract,
  type ArcRunRequest,
  type ArcRunSummary,
} from "./contract.js";
import { useStudioQuery, errorMessage } from "../studio/data.js";
import type { AgentSummary } from "../contract.js";
import {
  GraphRunRoute,
  PublishedTeamRunPicker,
  RunControls,
} from "./graph-panel.js";
import { InstructionUpdates } from "./instruction-updates.js";
import { RuleUpdates } from "./rule-updates.js";
import { RunReviewAuthority } from "./review-authority-view.js";
import {
  RunUpdateLineage,
  useRunUpdates,
  instructionUpdateQuery,
  ruleUpdateQuery,
} from "./run-updates.js";

type RunView = z.infer<typeof arcRunsRpcContract.getRun.output>;
type RunSetup = z.infer<typeof arcRunsRpcContract.getRunSetup.output>;
type EffectView = z.infer<typeof arcRunsRpcContract.listRunEffects.output>;
const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const terminal = new Set(["succeeded", "failed", "cancelled"]);

export function RuntimePanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const projects = useStudioQuery("runtime-projects", (rpc) =>
    rpc.call("listStudioProjects", null),
  );
  const [projectId, setProjectId] = useState("");
  const route = subPath.split("/").filter(Boolean)[0] ?? null;
  const selectedRun = route === "new" || route === "legacy" ? null : route;
  const rpc = useRpc<typeof arcRunsRpcContract>();
  const [runs, setRuns] = useState<ArcRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useRealtime("runs:changed", () => setRefresh((value) => value + 1));
  useEffect(() => {
    if (!projectId) {
      setRuns([]);
      return;
    }
    let active = true;
    setError(null);
    void rpc.call("listRuns", { projectId, offset: 0, limit: 20 }).then(
      (value) => {
        if (active) setRuns(value.runs);
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, projectId, refresh]);
  if (route === "new")
    return (
      <GraphRunRoute
        subPath={subPath}
        back={() => navigate.toPluginPanel("runs", { subPath: "" })}
        onStarted={(run) =>
          navigate.toPluginPanel("runs", { subPath: run.summary.runId })
        }
      />
    );
  if (selectedRun)
    return (
      <RunDetail
        key={selectedRun}
        runId={selectedRun}
        back={() => navigate.toPluginPanel("runs", { subPath: "" })}
      />
    );
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b p-4">
        <h1 className="text-base font-medium">Team runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give builders separate workspaces, then check and review their
          combined work.
        </p>
        <label className="mt-4 block text-sm">
          Project
          <select
            className={`${selectClass} mt-1`}
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Choose a project</option>
            {projects.data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {projects.error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {projects.error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={route === "legacy" ? "ghost" : "outline"}
            aria-pressed={route !== "legacy"}
            onClick={() => navigate.toPluginPanel("runs", { subPath: "" })}
          >
            Published team
          </Button>
          <Button
            size="sm"
            variant={route === "legacy" ? "outline" : "ghost"}
            aria-pressed={route === "legacy"}
            onClick={() =>
              navigate.toPluginPanel("runs", { subPath: "legacy" })
            }
          >
            Fixed run
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {runs.length > 0 && (
          <section aria-label="Saved runs" className="border-b px-4 py-3">
            <h2 className="mb-2 text-sm font-medium">Recent runs</h2>
            {runs.map((run) => (
              <button
                type="button"
                key={run.runId}
                className="flex w-full items-start justify-between gap-3 border-t py-3 text-left text-sm hover:text-foreground focus-visible:outline focus-visible:outline-ring"
                onClick={() =>
                  navigate.toPluginPanel("runs", { subPath: run.runId })
                }
              >
                <span className="min-w-0 flex-1 truncate">{run.goal}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {run.submission === "needs-reconciliation"
                    ? "Needs reconciliation"
                    : new Date(run.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </section>
        )}
        {projectId && route !== "legacy" ? (
          <PublishedTeamRunPicker key={projectId} projectId={projectId} />
        ) : projectId ? (
          <RunForm
            key={projectId}
            projectId={projectId}
            onStarted={(run) =>
              navigate.toPluginPanel("runs", { subPath: run.summary.runId })
            }
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Choose a Git project to configure a run. Your published project
            agents supply its roles and model settings.
          </p>
        )}
      </div>
    </div>
  );
}

function RunForm({
  projectId,
  onStarted,
}: {
  projectId: string;
  onStarted(run: RunView): void;
}) {
  const rpc = useRpc<typeof arcRunsRpcContract>();
  const navigate = useBbNavigate();
  const [setup, setSetup] = useState<RunSetup | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [parent, setParent] = useState("");
  const [goal, setGoal] = useState("");
  const [writers, setWriters] = useState([
    { agentId: "", task: "" },
    { agentId: "", task: "" },
  ]);
  const [reviewer, setReviewer] = useState("");
  const [repairer, setRepairer] = useState("");
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ArcRunRequest | null>(null);
  const [search, setSearch] = useState("");
  const [knownAgents, setKnownAgents] = useState<AgentSummary[]>([]);
  const agents = useStudioQuery(
    `runtime-agents:${projectId}:${search}`,
    (client) =>
      client.call("listAgents", {
        scope: { kind: "project", projectId },
        search,
        limit: 50,
        offset: 0,
      }),
  );
  useEffect(() => {
    if (!agents.data) return;
    setKnownAgents((previous) => {
      const updated = new Map(previous.map((agent) => [agent.id, agent]));
      for (const agent of agents.data!.agents) updated.set(agent.id, agent);
      return [...updated.values()];
    });
  }, [agents.data]);
  const selectedIds = new Set([
    ...writers.map((writer) => writer.agentId),
    reviewer,
    repairer,
  ]);
  const visibleIds = new Set(
    agents.data?.agents.map((agent) => agent.id) ?? [],
  );
  const published = knownAgents.filter(
    (agent) =>
      agent.currentRevision !== null &&
      (visibleIds.has(agent.id) || selectedIds.has(agent.id)),
  );
  useEffect(() => {
    let active = true;
    setSetup(null);
    setError(null);
    void rpc.call("getRunSetup", { projectId, hostId }).then(
      (value) => {
        if (active) {
          setSetup(value);
          setParent((previous) =>
            value.threads.some((thread) => thread.id === previous)
              ? previous
              : (value.threads[0]?.id ?? ""),
          );
        }
      },
      (failure: unknown) => {
        if (active) setError(errorMessage(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, projectId, hostId, sourceRefresh]);
  const selectAgent = (
    label: string,
    value: string,
    update: (value: string) => void,
  ) => (
    <label className="block text-sm">
      {label}
      <select
        className={`${selectClass} mt-1`}
        value={value}
        onChange={(event) => update(event.target.value)}
      >
        <option value="">Choose a published agent</option>
        {published.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name} · v{agent.currentRevision}
          </option>
        ))}
      </select>
    </label>
  );
  async function start() {
    setBusy(true);
    setError(null);
    try {
      if (!setup) throw new Error("Wait for the project checkout to load");
      const agent = (id: string) => {
        const found = published.find((value) => value.id === id);
        if (!found?.currentRevision)
          throw new Error("Choose published project agents for every role");
        return { agentId: found.id, revision: found.currentRevision };
      };
      const request =
        pending ??
        arcRunsRpcContract.startRun.input.parse({
          operationId: crypto.randomUUID(),
          projectId,
          originThreadId: parent,
          hostId: setup.selected.hostId,
          path: setup.selected.path,
          expectedHead: setup.selected.head,
          goal,
          writers: writers.map((writer) => ({
            agent: agent(writer.agentId),
            task: writer.task,
          })),
          reviewer: agent(reviewer),
          repairer: agent(repairer),
          check: {
            executable,
            args: args.split("\n").filter((line) => line.length > 0),
            timeoutMs: 600_000,
          },
        });
      setPending(request);
      onStarted(await rpc.call("startRun", request));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">New run</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            navigate.toPluginPanel("agents", {
              subPath: `project/${projectId}`,
            })
          }
        >
          Project agents
        </Button>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {agents.error && (
        <p role="alert" className="text-sm text-destructive">
          {agents.error}
        </p>
      )}
      {!setup && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading project and Git state…
        </p>
      )}
      {setup && (
        <>
          <fieldset
            disabled={busy || pending !== null}
            className="min-w-0 space-y-5 disabled:opacity-60"
          >
            {setup.sources.length > 1 && (
              <label className="block text-sm">
                Host checkout
                <select
                  className={`${selectClass} mt-1`}
                  value={setup.selected.hostId}
                  onChange={(event) => setHostId(event.target.value)}
                >
                  {setup.sources.map((source) => (
                    <option key={source.hostId} value={source.hostId}>
                      {source.path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="text-sm">
              <p className="break-all text-muted-foreground">
                {setup.selected.path}
              </p>
              <p className="mt-1">
                Starting commit <code>{setup.selected.head.slice(0, 12)}</code>{" "}
                ·{" "}
                {setup.selected.clean
                  ? "Clean checkout"
                  : "Uncommitted changes"}
              </p>
              {!setup.selected.clean && (
                <p className="mt-1 text-muted-foreground">
                  Commit your starting changes before running parallel builders.
                </p>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSourceRefresh((value) => value + 1)}
              >
                Refresh checkout
              </Button>
            </div>
            <label className="block text-sm">
              Main conversation
              <select
                className={`${selectClass} mt-1`}
                value={parent}
                onChange={(event) => setParent(event.target.value)}
              >
                <option value="">Choose a project conversation</option>
                {setup.threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title ?? "Untitled conversation"}
                  </option>
                ))}
              </select>
            </label>
            {setup.threads.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Create a conversation in this project, then refresh the checkout
                to select it as the run's main conversation.
              </p>
            )}
            <label className="block text-sm">
              What should the team deliver?
              <Textarea
                className="mt-1"
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Describe the result and how you'll know it is ready."
              />
            </label>
            <label className="block text-sm">
              Find project agents
              <Input
                className="mt-1"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search published agents"
              />
            </label>
            {writers.map((writer, index) => (
              <div key={index} className="space-y-2 border-t pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Builder {index + 1}</h3>
                  {writers.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setWriters((values) =>
                          values.filter((_, item) => item !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {selectAgent("Agent", writer.agentId, (agentId) =>
                  setWriters((values) =>
                    values.map((value, item) =>
                      item === index ? { ...value, agentId } : value,
                    ),
                  ),
                )}
                <label className="block text-sm">
                  Assignment
                  <Textarea
                    className="mt-1"
                    rows={2}
                    value={writer.task}
                    onChange={(event) =>
                      setWriters((values) =>
                        values.map((value, item) =>
                          item === index
                            ? { ...value, task: event.target.value }
                            : value,
                        ),
                      )
                    }
                  />
                </label>
              </div>
            ))}
            {writers.length < 4 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setWriters((values) => [...values, { agentId: "", task: "" }])
                }
              >
                Add builder
              </Button>
            )}
            <div className="space-y-3 border-t pt-4">
              {selectAgent("Final reviewer", reviewer, setReviewer)}
              {selectAgent("Agent for check repairs", repairer, setRepairer)}
            </div>
            <div className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-medium">Required check</h3>
              <label className="block text-sm">
                Executable
                <Input
                  className="mt-1"
                  value={executable}
                  onChange={(event) => setExecutable(event.target.value)}
                  placeholder="e.g. node or pnpm.cmd"
                />
              </label>
              <label className="block text-sm">
                Arguments · one per line
                <Textarea
                  className="mt-1 font-mono"
                  rows={3}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder={"run\ntest"}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Runs directly in the integrated worktree with a 10-minute
                timeout. Up to 3 check repairs, 4 active agents, 100 worker
                calls and 2 hours of active work.
              </p>
            </div>
          </fieldset>
          <Button
            onClick={() => void start()}
            disabled={busy || !setup.selected.clean}
          >
            {busy
              ? "Starting run…"
              : pending
                ? "Retry saved request"
                : "Start team run"}
          </Button>
          {pending && !busy && (
            <p className="text-xs text-muted-foreground">
              This request is retained so retrying cannot start a duplicate run.
              Its settings are sealed.
            </p>
          )}
        </>
      )}
      {!setup && error && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSourceRefresh((value) => value + 1)}
        >
          Retry checkout
        </Button>
      )}
    </div>
  );
}

function RunDetail({ runId, back }: { runId: string; back(): void }) {
  const rpc = useRpc<typeof arcRunsRpcContract>();
  const orchestratorRpc = useRpc<typeof arcOrchestratorRpcContract>();
  const navigate = useBbNavigate();
  const [run, setRun] = useState<RunView | null>(null);
  const runUpdates = useRunUpdates(
    runId,
    run !== null && run.definition.schemaVersion !== 1,
  );
  const [instructionIntent, setInstructionIntent] = useState(false);
  const [ruleIntent, setRuleIntent] = useState(false);
  const updateBlock =
    instructionIntent || ruleIntent
      ? "A reviewed update request is pending. Finish or cancel it before changing this run."
      : runUpdates.blockedReason;
  const [effects, setEffects] = useState<EffectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pendingControl, setPendingControl] = useState<z.infer<
    typeof arcRunsRpcContract.controlRun.input
  > | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const workflowState = run?.workflow?.state;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [value, history] = await Promise.all([
        rpc.call("getRun", { runId }),
        rpc.call("listRunEffects", { runId, offset, limit: 50 }),
      ]);
      if (current === generation.current) {
        setRun(value);
        setEffects(history);
        setError(null);
      }
    } catch (failure) {
      if (current === generation.current) setError(errorMessage(failure));
    }
  }, [rpc, runId, offset]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !workflowState ||
      ((terminal.has(workflowState) || workflowState === "paused") &&
        run?.verification.state !== "checking")
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [workflowState, run?.verification.state, refresh]);
  useRealtime("runs:changed", () => void refresh());
  async function control(action: "pause" | "resume" | "cancel") {
    if (!run?.workflow || updateBlock) return;
    setBusy(true);
    setControlError(null);
    const request = pendingControl ?? {
      runId,
      operationId: crypto.randomUUID(),
      expectedVersion: run.workflow.controlVersion,
      action,
    };
    setPendingControl(request);
    try {
      setRun(await rpc.call("controlRun", request));
      setPendingControl(null);
    } catch (failure) {
      setControlError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const candidateDigest = run
    ? "kind" in run.verification
      ? run.verification.manifestDigest
      : run.verification.head
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="space-y-3 border-b p-4">
        <Button variant="ghost" size="sm" onClick={back}>
          All runs
        </Button>
        <h1 className="text-base font-medium">
          {run?.summary.goal ?? "Team run"}
        </h1>
        {run && (
          <>
            <p className="text-sm text-muted-foreground">
              {run.workflow?.state.replaceAll("-", " ") ??
                run.summary.submission.replaceAll("-", " ")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate.toThread(run.definition.request.originThreadId)
                }
              >
                Main conversation
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate.toPluginPanel("workspace", { subPath: runId })
                }
              >
                Workspace
              </Button>
              {run.workflow && !terminal.has(run.workflow.state) && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy || pendingControl !== null || updateBlock !== null
                    }
                    onClick={() =>
                      void control(
                        run.workflow?.state === "paused" ? "resume" : "pause",
                      )
                    }
                  >
                    {run.workflow.state === "paused" ? "Resume" : "Pause"}
                  </Button>
                  {run.definition.schemaVersion === 4 &&
                    run.workflow.state === "needs-reconciliation" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          pendingControl !== null ||
                          updateBlock !== null
                        }
                        onClick={() => void control("resume")}
                      >
                        Recheck and resume
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      busy || pendingControl !== null || updateBlock !== null
                    }
                    onClick={() => void control("cancel")}
                  >
                    Cancel run
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </header>
      <RunUpdateLineage state={runUpdates.data} />
      {run && run.definition.schemaVersion !== 1 && (
        <RunReviewAuthority runId={runId} />
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {updateBlock &&
          runUpdates.data?.outgoing?.application.state !== "applied" && (
            <p className="text-sm text-muted-foreground">{updateBlock}</p>
          )}
        {run && run.definition.schemaVersion !== 1 && (
          <>
            <InstructionUpdates
              key={`instructions:${runId}`}
              run={run}
              query={{
                ...instructionUpdateQuery(runUpdates),
                blockedReason: ruleIntent
                  ? "Finish or cancel the pending rule update first."
                  : runUpdates.blockedReason,
              }}
              onIntentChange={setInstructionIntent}
              changed={() => void refresh()}
            />
            <RuleUpdates
              key={`rules:${runId}`}
              run={run}
              query={{
                ...ruleUpdateQuery(runUpdates),
                blockedReason: instructionIntent
                  ? "Finish or cancel the pending instruction update first."
                  : runUpdates.blockedReason,
              }}
              onIntentChange={setRuleIntent}
              changed={() => void refresh()}
            />
          </>
        )}
        {controlError && (
          <p role="alert" className="break-words text-sm text-destructive">
            {controlError}
          </p>
        )}
        {pendingControl && controlError && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || updateBlock !== null}
            onClick={() => void control(pendingControl.action)}
          >
            Retry {pendingControl.action}
          </Button>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {!run && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading run…
          </p>
        )}
        {run?.summary.submissionError && (
          <p role="alert" className="text-sm text-destructive">
            {run.summary.submissionError}
          </p>
        )}
        {run && run.summary.workflowRunId === null && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || updateBlock !== null}
            onClick={async () => {
              setBusy(true);
              try {
                setRun(
                  run.definition.schemaVersion === 1
                    ? await rpc.call("startRun", run.definition.request)
                    : run.definition.schemaVersion === 2
                      ? await rpc.call("startTeamRun", run.definition.request)
                      : await orchestratorRpc.call("reconcileOrchestratedRun", {
                          runId: run.summary.runId,
                        }),
                );
              } catch (failure) {
                setError(errorMessage(failure));
              } finally {
                setBusy(false);
              }
            }}
          >
            Reconcile saved request
          </Button>
        )}
        {run?.workflow && (
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <span>{run.workflow.activeAgents} active agents</span>
            <span>
              {run.workflow.agentCalls} / {run.workflow.limits.maxAgentCalls}{" "}
              {run.definition.schemaVersion >= 3
                ? "agent calls"
                : "worker calls"}
            </span>
            <span>
              {Math.ceil(run.workflow.chargedActiveMs / 60_000)} minutes charged
            </span>
          </div>
        )}
        {run?.workflow?.error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {run.workflow.error}
          </p>
        )}
        {run && run.definition.schemaVersion !== 1 ? (
          <RunControls
            key={run.summary.runId}
            run={run}
            blockedReason={updateBlock}
          />
        ) : null}
        {run && run.verification.state !== "pending" && (
          <section
            className="border-t pt-3 text-sm"
            aria-label="Candidate verification"
          >
            <p>
              {runUpdates.data?.outgoing?.application.state === "applied"
                ? `Historical candidate · replaced by ${runUpdates.data.outgoing.kind === "rules" ? "rule" : "instruction"} update`
                : run.verification.state === "current"
                  ? "kind" in run.verification
                    ? "Last verified candidate"
                    : "Verified candidate"
                  : run.verification.state === "checking"
                    ? "Verifying folder contents…"
                    : run.verification.state === "stale"
                      ? "Verification is stale"
                      : "Verification unavailable"}
              {candidateDigest && (
                <>
                  {" "}
                  · <code>{candidateDigest.slice(0, 12)}</code>
                </>
              )}
            </p>
            {"kind" in run.verification && run.verification.checkedAt && (
              <p className="mt-1 text-muted-foreground">
                Last verified{" "}
                <time dateTime={run.verification.checkedAt}>
                  {new Date(run.verification.checkedAt).toLocaleString()}
                </time>
                . New actions check the folder again.
              </p>
            )}
            {run.verification.workspacePath && (
              <p className="mt-1 break-all text-muted-foreground">
                {run.verification.workspacePath}
              </p>
            )}
            {run.definition.schemaVersion === 4 && (
              <p className="mt-2 break-all text-muted-foreground">
                Original folder: {run.definition.source.path}
              </p>
            )}
            {run.verification.reason && (
              <p role="alert" className="mt-1 text-destructive">
                {run.verification.reason}
              </p>
            )}
          </section>
        )}
        <section aria-label="Execution steps">
          <h2 className="mb-2 text-sm font-medium">Execution</h2>
          {effects?.effects.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No native steps have been admitted yet.
            </p>
          )}
          {effects?.effects.map((effect) => (
            <div
              className="flex items-center justify-between gap-2 border-t py-3 text-sm"
              key={effect.effectId}
            >
              <div className="min-w-0">
                <p className="truncate">
                  {effect.nodeId.replaceAll("-", " ")}
                  {effect.iteration > 0 ? ` · round ${effect.iteration}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {effect.state.replaceAll("-", " ")} · attempt {effect.attempt}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {effect.resource?.kind === "agent" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (effect.resource?.kind === "agent")
                        navigate.toThread(effect.resource.threadId);
                    }}
                  >
                    Chat
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const value = await rpc.call("getRunEffect", {
                        runId,
                        effectId: effect.effectId,
                      });
                      setEvidence(JSON.stringify(value, null, 2));
                    } catch (failure) {
                      setError(errorMessage(failure));
                    }
                  }}
                >
                  Evidence
                </Button>
              </div>
            </div>
          ))}
        </section>
        {effects && effects.total > 50 && (
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {offset + 1}–{Math.min(offset + 50, effects.total)} of{" "}
              {effects.total}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + 50 >= effects.total}
              onClick={() => setOffset((value) => value + 50)}
            >
              Next
            </Button>
          </div>
        )}
        {evidence && (
          <section aria-label="Native evidence" className="border-t pt-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Recorded evidence</h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEvidence(null)}
              >
                Close
              </Button>
            </div>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
              {evidence}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}

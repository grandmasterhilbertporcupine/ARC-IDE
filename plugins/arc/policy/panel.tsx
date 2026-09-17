import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { z } from "zod";
import { errorMessage, useStudioQuery } from "../studio/data.js";
import { useTeamQuery } from "../teams/ui-data.js";
import {
  arcPolicyRpcContract,
  autonomySchema,
  defaultSessionOverrides,
  resolvedRunPolicySchema,
  resolveRunPolicy,
  sessionPolicyOverridesSchema,
  type PolicyTarget,
  type ResolvedRunPolicy,
  type SessionPolicyOverrides,
  type TeamPin,
} from "./contract.js";

type PolicyView = z.infer<
  typeof arcPolicyRpcContract.getOrchestrationPolicy.output
>;
type PolicyRpc = ReturnType<typeof useRpc<typeof arcPolicyRpcContract>>;
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const fieldClass = "grid min-w-0 gap-1.5 text-sm";
const meanings = {
  guided:
    "Ask for approval before each agent assignment, including delegated work.",
  collaborative:
    "Review and approve the plan before work begins, then continue through its approval steps.",
  autonomous: "Continue within the approved plan, permissions and run limits.",
};

function usePolicyQuery<T>(
  key: string,
  fetcher: (rpc: PolicyRpc) => Promise<T>,
) {
  const rpc = useRpc<typeof arcPolicyRpcContract>();
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
  useRealtime("policy:changed", refresh);
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
            error: errorMessage(error),
            loading: false,
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [key, generation, rpc]);
  return { ...state, data: state.key === key ? state.data : null, refresh };
}

function route(subPath: string): PolicyTarget | null {
  try {
    const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
    return parts[0] === "project" && parts[1]
      ? {
          projectId: parts[1],
          threadId: parts[2] === "session" ? (parts[3] ?? null) : null,
        }
      : null;
  } catch {
    return null;
  }
}

export function OrchestrationPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const target = route(subPath);
  const [dirty, setDirty] = useState(false);
  const projects = useStudioQuery("policy-projects", (rpc) =>
    rpc.call("listStudioProjects", null),
  );
  const choose = (next: PolicyTarget) =>
    navigate.toPluginPanel("orchestration", {
      subPath: `project/${encodeURIComponent(next.projectId)}${next.threadId === null ? "" : `/session/${encodeURIComponent(next.threadId)}`}`,
    });
  useEffect(() => setDirty(false), [subPath]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b px-4 py-3">
        <h1 className="text-base font-medium">Orchestration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how your orchestrator works with teams. Save defaults for new
          team graph runs.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className={fieldClass}>
            Project
            <select
              className={selectClass}
              value={target?.projectId ?? ""}
              disabled={dirty || projects.loading}
              onChange={(event) => {
                if (event.target.value)
                  choose({ projectId: event.target.value, threadId: null });
              }}
            >
              <option value="">
                {projects.loading ? "Loading projects…" : "Choose a project"}
              </option>
              {target &&
                !projects.data?.projects.some(
                  (project) => project.id === target.projectId,
                ) && (
                  <option value={target.projectId}>{target.projectId}</option>
                )}
              {projects.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <SessionPicker
              key={target.projectId}
              target={target}
              disabled={dirty}
              onChange={(threadId) => choose({ ...target, threadId })}
            />
          )}
        </div>
        {dirty && (
          <p className="mt-2 text-xs text-muted-foreground">
            Save or reset your edits before switching project or session.
          </p>
        )}
        {projects.error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {projects.error}{" "}
            <Button variant="ghost" size="sm" onClick={projects.refresh}>
              Retry projects
            </Button>
          </p>
        )}
      </header>
      {target ? (
        <PolicyLoader
          key={`${target.projectId}:${target.threadId}`}
          target={target}
          onDirty={setDirty}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          Choose a project to set defaults, or tailor them for an existing
          session.
        </p>
      )}
    </div>
  );
}

function SessionPicker({
  target,
  disabled,
  onChange,
}: {
  target: PolicyTarget;
  disabled: boolean;
  onChange(threadId: string | null): void;
}) {
  const [offset, setOffset] = useState(0);
  const [known, setKnown] = useState<Array<{ id: string; title: string }>>([]);
  const sessions = usePolicyQuery(
    `sessions:${target.projectId}:${offset}`,
    (rpc) =>
      rpc.call("listPolicySessions", {
        projectId: target.projectId,
        limit: 50,
        offset,
      }),
  );
  useEffect(() => {
    if (sessions.data)
      setKnown((previous) => [
        ...new Map(
          [...previous, ...sessions.data!.threads].map((thread) => [
            thread.id,
            thread,
          ]),
        ).values(),
      ]);
  }, [sessions.data]);
  return (
    <div className="min-w-0">
      <label className={fieldClass}>
        Settings for
        <select
          className={selectClass}
          disabled={disabled}
          value={target.threadId ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">Project defaults</option>
          {target.threadId &&
            !known.some((thread) => thread.id === target.threadId) && (
              <option value={target.threadId}>{target.threadId}</option>
            )}
          {known.map((thread) => (
            <option key={thread.id} value={thread.id}>
              Session · {thread.title || "Untitled conversation"}
            </option>
          ))}
        </select>
      </label>
      {sessions.loading && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          Loading sessions…
        </p>
      )}
      {sessions.error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {sessions.error}{" "}
          <Button variant="ghost" size="sm" onClick={sessions.refresh}>
            Retry sessions
          </Button>
        </p>
      )}
      {sessions.data?.hasMore && (
        <Button
          variant="ghost"
          size="sm"
          disabled={sessions.loading || disabled}
          onClick={() => setOffset((value) => value + 50)}
        >
          Load more sessions
        </Button>
      )}
    </div>
  );
}

function PolicyLoader({
  target,
  onDirty,
}: {
  target: PolicyTarget;
  onDirty(dirty: boolean): void;
}) {
  const query = usePolicyQuery(
    `policy:${target.projectId}:${target.threadId}`,
    (rpc) => rpc.call("getOrchestrationPolicy", target),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {query.error && (
        <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">
          {query.error}{" "}
          <Button variant="ghost" size="sm" onClick={query.refresh}>
            Retry settings
          </Button>
        </p>
      )}
      {query.data ? (
        <PolicyEditor
          target={target}
          view={query.data}
          refresh={query.refresh}
          onDirty={onDirty}
        />
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {query.loading
            ? "Loading orchestration settings…"
            : "Settings are unavailable."}
        </p>
      )}
    </div>
  );
}

function draftFor(view: PolicyView): SessionPolicyOverrides {
  if (view.session) return view.session.overrides;
  const policy = view.project.policy;
  return {
    autonomy: policy.autonomy,
    preferredTeams: policy.preferredTeams.length
      ? { kind: "teams", teams: policy.preferredTeams }
      : { kind: "none" },
    restrictedTeams:
      policy.restrictedTeams === null
        ? { kind: "unrestricted" }
        : { kind: "teams", teams: policy.restrictedTeams },
    limits: policy.limits,
  };
}

function PolicyEditor({
  target,
  view,
  refresh,
  onDirty,
}: {
  target: PolicyTarget;
  view: PolicyView;
  refresh(): void;
  onDirty(dirty: boolean): void;
}) {
  const rpc = useRpc<typeof arcPolicyRpcContract>();
  const [baseline, setBaseline] = useState(view);
  const [draft, setDraft] = useState(() => draftFor(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState(false);
  const session = target.threadId !== null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFor(baseline));
  const changed =
    view.project.version > baseline.project.version ||
    (view.session?.version ?? 0) > (baseline.session?.version ?? 0);
  useEffect(() => onDirty(dirty || busy), [dirty, busy, onDirty]);
  useEffect(() => {
    if (!dirty && !busy && changed) {
      setBaseline(view);
      setDraft(draftFor(view));
    }
  }, [view, dirty, busy, changed]);
  const update = (next: SessionPolicyOverrides) => {
    setDraft(next);
    setError(null);
    setSaved(false);
  };
  const reset = () => {
    setBaseline(view);
    setDraft(draftFor(view));
    setError(null);
    setSaved(false);
  };
  const parsed = sessionPolicyOverridesSchema.safeParse(draft);
  let effective: ResolvedRunPolicy | null = null;
  let validation: string | null = parsed.success
    ? null
    : parsed.error.issues.map((issue) => issue.message).join(". ");
  if (parsed.success) {
    try {
      effective = resolveRunPolicy(view.project.policy, parsed.data);
    } catch (failure) {
      validation =
        failure instanceof z.ZodError
          ? failure.issues.map((issue) => issue.message).join(". ")
          : errorMessage(failure);
    }
  }
  async function save() {
    if (busy || effective === null || !parsed.success) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const accepted =
        target.threadId === null
          ? await rpc
              .call("saveProjectPolicy", {
                projectId: target.projectId,
                expectedVersion: baseline.project.version,
                policy: resolvedRunPolicySchema.parse(effective),
              })
              .then((project) => ({
                project,
                session: null,
                effective: project.policy,
                errors: [],
              }))
          : await rpc.call("saveSessionPolicy", {
              ...target,
              threadId: target.threadId,
              expectedVersion: baseline.session?.version ?? 0,
              overrides: parsed.data,
            });
      setBaseline(accepted);
      setDraft(draftFor(accepted));
      setSaved(true);
      refresh();
    } catch (failure) {
      setError(errorMessage(failure));
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto max-w-4xl divide-y">
          <section className="py-4">
            <h2 className="text-sm font-medium">
              {session ? "Session overrides" : "Project defaults"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {session
                ? "Inherit each project setting or choose an explicit override for this conversation."
                : "Sessions inherit these settings until you choose an override."}{" "}
              Existing runs retain their saved settings.
            </p>
            {view.errors.map((message) => (
              <p
                key={message}
                role="alert"
                className="mt-2 text-sm text-destructive"
              >
                {message}
              </p>
            ))}
            {changed && dirty && (
              <p role="status" className="mt-2 text-sm">
                Settings changed elsewhere. Your edits are preserved. Reset to
                the latest saved settings to review those changes.
              </p>
            )}
          </section>
          <fieldset disabled={busy} className="min-w-0 py-4">
            <legend className="sr-only">Orchestrator freedom</legend>
            <label className={fieldClass}>
              Orchestrator freedom
              <select
                className={`${selectClass} max-w-md`}
                value={draft.autonomy ?? "inherit"}
                onChange={(event) =>
                  update({
                    ...draft,
                    autonomy:
                      event.target.value === "inherit"
                        ? null
                        : autonomySchema.parse(event.target.value),
                  })
                }
              >
                {session && (
                  <option value="inherit">
                    Inherit project · {view.project.policy.autonomy}
                  </option>
                )}
                <option value="guided">Guided</option>
                <option value="collaborative">Collaborative</option>
                <option value="autonomous">Autonomous</option>
              </select>
            </label>
            <p className="mt-2 text-sm text-muted-foreground">
              {meanings[draft.autonomy ?? view.project.policy.autonomy]}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Explicit approval steps and provider permissions remain in force
              at every level.
            </p>
          </fieldset>
          <fieldset disabled={busy} className="min-w-0 py-4">
            <legend className="sr-only">Team choices</legend>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="min-w-0">
                <label className={fieldClass}>
                  Preferred teams
                  <select
                    className={selectClass}
                    value={draft.preferredTeams.kind}
                    onChange={(event) =>
                      update({
                        ...draft,
                        preferredTeams:
                          event.target.value === "inherit"
                            ? { kind: "inherit" }
                            : event.target.value === "none"
                              ? { kind: "none" }
                              : { kind: "teams", teams: [] },
                      })
                    }
                  >
                    {session && (
                      <option value="inherit">
                        Inherit project preference
                      </option>
                    )}
                    <option value="none">No preference</option>
                    <option value="teams">Choose published versions</option>
                  </select>
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  A preference guides team choice; it does not grant permission.
                </p>
                {draft.preferredTeams.kind === "teams" && (
                  <TeamPins
                    label="Preferred"
                    projectId={target.projectId}
                    pins={draft.preferredTeams.teams}
                    onChange={(teams) =>
                      update({
                        ...draft,
                        preferredTeams: { kind: "teams", teams },
                      })
                    }
                  />
                )}
                {draft.preferredTeams.kind === "inherit" && (
                  <PinSummary
                    pins={view.project.policy.preferredTeams}
                    empty="No project preference"
                  />
                )}
              </div>
              <div className="min-w-0">
                <label className={fieldClass}>
                  Allowed teams
                  <select
                    className={selectClass}
                    value={draft.restrictedTeams.kind}
                    onChange={(event) =>
                      update({
                        ...draft,
                        restrictedTeams:
                          event.target.value === "inherit"
                            ? { kind: "inherit" }
                            : event.target.value === "unrestricted"
                              ? { kind: "unrestricted" }
                              : { kind: "teams", teams: [] },
                      })
                    }
                  >
                    {session && (
                      <option value="inherit">
                        Inherit project restriction
                      </option>
                    )}
                    <option value="unrestricted">
                      Any available project team
                    </option>
                    <option value="teams">
                      Only selected published versions
                    </option>
                  </select>
                </label>
                <p className="mt-2 text-xs text-muted-foreground">
                  A selected set limits which exact team versions a new run can
                  use.
                </p>
                {draft.restrictedTeams.kind === "teams" && (
                  <>
                    <TeamPins
                      label="Allowed"
                      projectId={target.projectId}
                      pins={draft.restrictedTeams.teams}
                      onChange={(teams) =>
                        update({
                          ...draft,
                          restrictedTeams: { kind: "teams", teams },
                        })
                      }
                    />
                    {draft.restrictedTeams.teams.length === 0 && (
                      <p className="mt-2 text-sm">
                        No teams allowed. Add a version to allow it.
                      </p>
                    )}
                  </>
                )}
                {draft.restrictedTeams.kind === "inherit" && (
                  <PinSummary
                    pins={view.project.policy.restrictedTeams}
                    empty="No teams allowed by the project"
                  />
                )}
              </div>
            </div>
          </fieldset>
          <fieldset disabled={busy} className="min-w-0 py-4">
            <legend className="sr-only">Run limits</legend>
            <h2 className="text-sm font-medium">Run limits</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Bound each new run’s work. Active time excludes pauses.
            </p>
            {session && (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.limits === null}
                  onChange={(event) =>
                    update({
                      ...draft,
                      limits: event.target.checked
                        ? null
                        : { ...view.project.policy.limits },
                    })
                  }
                />
                Inherit project run limits
              </label>
            )}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  ["maxConcurrentAgents", "Agents at once", 1, 64],
                  ["maxAgentCalls", "Total agent calls", 1, 1000],
                  ["maxRepairRounds", "Repair rounds", 0, 100],
                  ["maxActiveMs", "Active time (seconds)", 0.001, 2592000],
                ] as const
              ).map(([key, label, min, max]) => {
                const value =
                  (draft.limits ?? view.project.policy.limits)[key] /
                  (key === "maxActiveMs" ? 1000 : 1);
                return (
                  <label key={key} className={fieldClass}>
                    {label}
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      step={key === "maxActiveMs" ? 0.001 : 1}
                      value={Number.isFinite(value) ? value : ""}
                      disabled={draft.limits === null}
                      onChange={(event) => {
                        if (draft.limits !== null)
                          update({
                            ...draft,
                            limits: {
                              ...draft.limits,
                              [key]:
                                event.target.value === ""
                                  ? Number.NaN
                                  : key === "maxActiveMs"
                                    ? Math.round(
                                        Number(event.target.value) * 1000,
                                      )
                                    : Number(event.target.value),
                            },
                          });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
          <section className="py-4">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={history}
              onClick={() => setHistory((value) => !value)}
            >
              {history ? "Hide" : "View"} saved history
            </Button>
            {history && (
              <PolicyHistory
                target={target}
                currentVersion={view.session?.version ?? view.project.version}
              />
            )}
          </section>
        </div>
      </div>
      <footer className="shrink-0 border-t px-4 py-3">
        {dirty && validation && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {validation}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {error} Your edits are still here.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !dirty || effective === null || changed}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save settings"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!dirty && !changed)}
            onClick={reset}
          >
            Reset to latest
          </Button>
          {session && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => update(defaultSessionOverrides())}
            >
              Use all project defaults
            </Button>
          )}
          <span role="status" className="text-xs text-muted-foreground">
            {saved
              ? "Settings saved"
              : dirty
                ? "Unsaved changes"
                : `Saved version ${baseline.session?.version ?? baseline.project.version}`}
          </span>
        </div>
      </footer>
    </>
  );
}

function PinSummary({
  pins,
  empty,
}: {
  pins: TeamPin[] | null;
  empty: string;
}) {
  return (
    <p className="mt-2 break-words text-xs text-muted-foreground">
      {pins === null
        ? "Any available project team"
        : pins.length === 0
          ? empty
          : pins.map((pin) => `${pin.teamId} · v${pin.revision}`).join(", ")}
    </p>
  );
}

function TeamPins({
  projectId,
  pins,
  label,
  onChange,
}: {
  projectId: string;
  pins: TeamPin[];
  label: string;
  onChange(pins: TeamPin[]): void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="mt-2 min-w-0">
      <ul aria-label={`${label} team versions`} className="divide-y">
        {pins.map((pin) => (
          <li key={pin.teamId} className="flex min-w-0 items-center gap-2 py-2">
            <PinnedTeam projectId={projectId} pin={pin} />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${label.toLowerCase()} ${pin.teamId} version ${pin.revision}`}
              onClick={() =>
                onChange(pins.filter((value) => value.teamId !== pin.teamId))
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        aria-expanded={adding}
        onClick={() => setAdding((value) => !value)}
      >
        {adding ? "Close" : "Add"} {label.toLowerCase()} team
      </Button>
      {adding && (
        <TeamVersionPicker
          projectId={projectId}
          label={label}
          pins={pins}
          onAdd={(pin) => {
            onChange([...pins, pin]);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function PinnedTeam({ projectId, pin }: { projectId: string; pin: TeamPin }) {
  const query = useTeamQuery(
    `policy-pin:${projectId}:${pin.teamId}:${pin.revision}`,
    async (rpc) => {
      const target = {
        scope: { kind: "project", projectId } as const,
        teamId: pin.teamId,
      };
      const [current, published] = await Promise.all([
        rpc.call("getTeam", target),
        rpc.call("getTeamRevision", { ...target, revision: pin.revision }),
      ]);
      return {
        name: published.revision.definition.name,
        archived: current.team.archivedAt !== null,
      };
    },
  );
  return (
    <span className="min-w-0 flex-1 break-words text-sm">
      {query.data?.name ?? pin.teamId} · v{pin.revision}
      {query.data?.archived && " · Archived"}
      {query.error && (
        <span className="block text-xs text-destructive">{query.error}</span>
      )}
    </span>
  );
}

function TeamVersionPicker({
  projectId,
  label,
  pins,
  onAdd,
}: {
  projectId: string;
  label: string;
  pins: TeamPin[];
  onAdd(pin: TeamPin): void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [teamId, setTeamId] = useState("");
  const query = useTeamQuery(
    `policy-teams:${projectId}:${search}:${offset}`,
    (rpc) =>
      rpc.call("listTeams", {
        scope: { kind: "project", projectId },
        search,
        includeArchived: false,
        offset,
        limit: 50,
      }),
  );
  return (
    <div
      className="mt-3 grid min-w-0 gap-2 border-l pl-3"
      aria-label={`${label} team picker`}
    >
      <label className={fieldClass}>
        Find {label.toLowerCase()} team
        <Input
          value={search}
          placeholder="Search project teams"
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
            setTeamId("");
          }}
        />
      </label>
      <label className={fieldClass} htmlFor={id}>
        {label} team
      </label>
      <select
        id={id}
        className={selectClass}
        value={teamId}
        onChange={(event) => setTeamId(event.target.value)}
      >
        <option value="">
          {query.loading ? "Loading teams…" : "Choose a published team"}
        </option>
        {query.data?.teams.map((team) => (
          <option
            key={team.id}
            value={team.id}
            disabled={
              team.currentRevision === null ||
              pins.some((pin) => pin.teamId === team.id)
            }
          >
            {team.name}
            {team.currentRevision === null
              ? " · Unpublished"
              : ` · latest v${team.currentRevision}`}
            {pins.some((pin) => pin.teamId === team.id)
              ? " · Already selected"
              : ""}
          </option>
        ))}
      </select>
      {query.error && (
        <p role="alert" className="text-xs text-destructive">
          {query.error}{" "}
          <Button variant="ghost" size="sm" onClick={query.refresh}>
            Retry teams
          </Button>
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-xs text-muted-foreground">
          No matching project teams. Publish a team in this project or copy a
          library version into it.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={offset === 0 || query.loading}
          onClick={() => {
            setOffset((value) => Math.max(0, value - 50));
            setTeamId("");
          }}
        >
          Previous teams
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !query.data || offset + 50 >= query.data.total || query.loading
          }
          onClick={() => {
            setOffset((value) => value + 50);
            setTeamId("");
          }}
        >
          Next teams
        </Button>
      </div>
      {teamId && (
        <RevisionPicker
          key={teamId}
          projectId={projectId}
          teamId={teamId}
          label={label}
          onAdd={onAdd}
        />
      )}
    </div>
  );
}

function RevisionPicker({
  projectId,
  teamId,
  label,
  onAdd,
}: {
  projectId: string;
  teamId: string;
  label: string;
  onAdd(pin: TeamPin): void;
}) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState("");
  const query = useTeamQuery(
    `policy-team-versions:${projectId}:${teamId}:${offset}`,
    (rpc) =>
      rpc.call("listTeamRevisions", {
        scope: { kind: "project", projectId },
        teamId,
        offset,
        limit: 50,
      }),
  );
  return (
    <>
      <label className={fieldClass}>
        {label} published version
        <select
          className={selectClass}
          value={revision}
          onChange={(event) => setRevision(event.target.value)}
        >
          <option value="">
            {query.loading ? "Loading versions…" : "Choose exact version"}
          </option>
          {query.data?.revisions.map((value) => (
            <option key={value.revision} value={value.revision}>
              v{value.revision} · {value.definition.name}
            </option>
          ))}
        </select>
      </label>
      {query.error && (
        <p role="alert" className="text-xs text-destructive">
          {query.error}{" "}
          <Button variant="ghost" size="sm" onClick={query.refresh}>
            Retry versions
          </Button>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={offset === 0 || query.loading}
          onClick={() => {
            setOffset((value) => Math.max(0, value - 50));
            setRevision("");
          }}
        >
          Previous versions
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !query.data || offset + 50 >= query.data.total || query.loading
          }
          onClick={() => {
            setOffset((value) => value + 50);
            setRevision("");
          }}
        >
          Next versions
        </Button>
        <Button
          size="sm"
          disabled={
            !query.data?.revisions.some(
              (value) => String(value.revision) === revision,
            )
          }
          onClick={() => onAdd({ teamId, revision: Number(revision) })}
        >
          Pin {label.toLowerCase()} version
        </Button>
      </div>
    </>
  );
}

function PolicyHistory({
  target,
  currentVersion,
}: {
  target: PolicyTarget;
  currentVersion: number;
}) {
  const [offset, setOffset] = useState(0);
  const query = usePolicyQuery(
    `policy-history:${target.projectId}:${target.threadId}:${currentVersion}:${offset}`,
    (rpc) => rpc.call("listPolicyRevisions", { ...target, limit: 10, offset }),
  );
  return (
    <section className="mt-2" aria-label="Saved settings history">
      <p className="mb-2 text-xs text-muted-foreground">
        Each saved version is retained. Viewing history does not change your
        settings.
      </p>
      {query.loading && (
        <p role="status" className="text-sm">
          Loading history…
        </p>
      )}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}{" "}
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry history
          </Button>
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-muted-foreground">No saved versions yet.</p>
      )}
      {query.data?.revisions.map((revision) => (
        <details key={revision.version} className="border-t py-2">
          <summary className="cursor-pointer text-sm focus-visible:outline focus-visible:outline-ring">
            Version {revision.version} ·{" "}
            {new Date(revision.createdAt).toLocaleString()}
          </summary>
          <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <dt>Orchestrator freedom</dt>
            <dd>{revision.value.autonomy ?? "Inherit project"}</dd>
            <dt>Preferred teams</dt>
            <dd>
              <HistoryTeams
                projectId={target.projectId}
                value={revision.value.preferredTeams}
                empty="No preference"
              />
            </dd>
            <dt>Allowed teams</dt>
            <dd>
              <HistoryTeams
                projectId={target.projectId}
                value={revision.value.restrictedTeams}
                empty="No teams allowed"
              />
            </dd>
            <dt>Run limits</dt>
            <dd className="break-words">
              {revision.value.limits === null
                ? "Inherit project"
                : `${revision.value.limits.maxConcurrentAgents} agents at once · ${revision.value.limits.maxAgentCalls} calls · ${revision.value.limits.maxRepairRounds} repair rounds · ${revision.value.limits.maxActiveMs / 1000}s active`}
            </dd>
          </dl>
        </details>
      ))}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={offset === 0 || query.loading}
          onClick={() => setOffset((value) => Math.max(0, value - 10))}
        >
          Newer history
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !query.data || offset + 10 >= query.data.total || query.loading
          }
          onClick={() => setOffset((value) => value + 10)}
        >
          Older history
        </Button>
      </div>
    </section>
  );
}

function HistoryTeams({
  projectId,
  value,
  empty,
}: {
  projectId: string;
  value:
    | ResolvedRunPolicy["restrictedTeams"]
    | SessionPolicyOverrides["preferredTeams"]
    | SessionPolicyOverrides["restrictedTeams"];
  empty: string;
}) {
  if (value === null) return <>Any available project team</>;
  const pins = Array.isArray(value)
    ? value
    : value.kind === "teams"
      ? value.teams
      : null;
  if (pins === null)
    return (
      <>
        {!Array.isArray(value) && value.kind === "inherit"
          ? "Inherit project"
          : !Array.isArray(value) && value.kind === "unrestricted"
            ? "Any available project team"
            : empty}
      </>
    );
  return pins.length === 0 ? (
    <>{empty}</>
  ) : (
    <ul>
      {pins.map((pin) => (
        <li key={pin.teamId}>
          <PinnedTeam projectId={projectId} pin={pin} />
        </li>
      ))}
    </ul>
  );
}

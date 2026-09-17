import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { z } from "zod";
import { arcRunsRpcContract, type ArcRunView } from "./contract.js";
import { graphRunRequestSchema } from "./graph-contract.js";
import { directoryRunRequestSchema } from "./directory-contract.js";
import { validateDirectoryTeamGraph } from "./directory-graph-validation.js";
import { DirectoryInspection } from "./directory-inspection.js";
import type { DirectorySetup } from "./source-contract.js";
import { arcOrchestratorRpcContract } from "../orchestrator/contract.js";
import {
  resolveRunControlSchema,
  type RunControl,
} from "./control-contract.js";
import {
  arcPolicyRpcContract,
  policyViewSchema,
  type ResolvedRunPolicy,
  type TeamPin,
} from "../policy/contract.js";
import {
  arcTeamsRpcContract,
  teamRevisionSchema,
  type TeamRevision,
} from "../teams/contract.js";
import type { ArcAgentsRpcContract } from "../contract.js";
import { useTeamQuery } from "../teams/ui-data.js";
import { errorMessage } from "../studio/data.js";
import { useRetainedRequest } from "./retained-request.js";

type GraphRpc = typeof arcRunsRpcContract &
  typeof arcOrchestratorRpcContract &
  typeof arcPolicyRpcContract &
  typeof arcTeamsRpcContract &
  ArcAgentsRpcContract;
type Client = ReturnType<typeof useRpc<GraphRpc>>;
const selectClass =
  "mt-1 h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const fieldClass = "block min-w-0 text-sm";
const routeSchema = z.object({
  projectId: graphRunRequestSchema.shape.projectId,
  teamId: graphRunRequestSchema.shape.team.shape.teamId,
  revision: graphRunRequestSchema.shape.team.shape.revision,
});
const pinnedTeamSchema = z
  .object({
    team: teamRevisionSchema,
    memberNames: z.record(z.string(), z.string()),
  })
  .strict();
const pendingStartSchema = z
  .object({
    request: z.union([
      graphRunRequestSchema,
      directoryRunRequestSchema.omit({ invocation: true }),
    ]),
    pinned: pinnedTeamSchema,
    policy: policyViewSchema,
    parentTitle: z.string(),
    recovery: z.literal("setup").optional(),
  })
  .strict();

function useGraphQuery<T>(
  key: string,
  fetcher: (rpc: Client) => Promise<T>,
  topic: string,
) {
  const rpc = useRpc<GraphRpc>();
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({ key, data: null, loading: true, error: null });
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useRealtime(topic, refresh);
  useEffect(() => {
    let active = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      loading: true,
      error: null,
    }));
    void fetchRef.current(rpc).then(
      (data) => {
        if (active) setState({ key, data, loading: false, error: null });
      },
      (failure: unknown) => {
        if (active)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(failure),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [key, rpc, generation]);
  return { ...state, data: state.key === key ? state.data : null, refresh };
}

export function graphRunPath(
  projectId: string,
  teamId: string,
  revision: number,
) {
  return `new/${encodeURIComponent(projectId)}/${encodeURIComponent(teamId)}/${revision}`;
}

export function GraphRunRoute({
  subPath,
  back,
  onStarted,
}: {
  subPath: string;
  back(): void;
  onStarted(run: ArcRunView): void;
}) {
  let route: z.infer<typeof routeSchema> | null = null;
  try {
    const [kind, projectId, teamId, revision, extra] = subPath
      .split("/")
      .map(decodeURIComponent);
    const result = routeSchema.safeParse({
      projectId,
      teamId,
      revision: Number(revision),
    });
    if (kind === "new" && extra === undefined && result.success)
      route = result.data;
  } catch {}
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b p-4">
        <Button size="sm" variant="ghost" onClick={back}>
          All runs
        </Button>
        <h1 className="mt-3 text-base font-medium">Run a published team</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {route ? (
          <GraphRunForm
            key={`${route.projectId}:${route.teamId}:${route.revision}`}
            {...route}
            onStarted={onStarted}
          />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            This team run link is invalid. Choose a published team from Runs.
          </p>
        )}
      </div>
    </div>
  );
}

export function PublishedTeamRunPicker({ projectId }: { projectId: string }) {
  const navigate = useBbNavigate();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [pin, setPin] = useState<{
    teamId: string;
    revision: number;
    name: string;
  } | null>(null);
  const query = useTeamQuery(
    `run-teams:${projectId}:${search}:${offset}`,
    (rpc) =>
      rpc.call("listTeams", {
        scope: { kind: "project", projectId },
        search,
        includeArchived: false,
        limit: 30,
        offset,
      }),
  );
  const published =
    query.data?.teams.filter((team) => team.currentRevision !== null) ?? [];
  return (
    <section className="space-y-3 p-4" aria-label="Published team run">
      <div>
        <h2 className="text-sm font-medium">Choose a published team</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review its saved plan, main conversation and settings before starting.
        </p>
      </div>
      <Input
        aria-label="Find a published team"
        value={search}
        placeholder="Find a team…"
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
      />
      <label className={fieldClass}>
        Published team
        <select
          className={selectClass}
          value={pin ? `${pin.teamId}:${pin.revision}` : ""}
          onChange={(event) => {
            const team = published.find(
              (item) =>
                `${item.id}:${item.currentRevision}` === event.target.value,
            );
            setPin(
              team?.currentRevision
                ? {
                    teamId: team.id,
                    revision: team.currentRevision,
                    name: team.name,
                  }
                : null,
            );
          }}
        >
          <option value="">
            {query.loading ? "Loading teams…" : "Choose a team"}
          </option>
          {pin &&
          !published.some(
            (team) =>
              team.id === pin.teamId && team.currentRevision === pin.revision,
          ) ? (
            <option value={`${pin.teamId}:${pin.revision}`}>
              {pin.name} · v{pin.revision}
            </option>
          ) : null}
          {published.map((team) => (
            <option key={team.id} value={`${team.id}:${team.currentRevision}`}>
              {team.name} · v{team.currentRevision}
            </option>
          ))}
        </select>
      </label>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {!query.loading && !query.error && published.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No published teams on this page. Publish a project team in the Team
          builder, or copy a library team into this project.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pin === null}
          onClick={() => {
            if (pin)
              navigate.toPluginPanel("runs", {
                subPath: graphRunPath(projectId, pin.teamId, pin.revision),
              });
          }}
        >
          Review run
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigate.toPluginPanel("teams", {
              subPath: `project/${encodeURIComponent(projectId)}`,
            })
          }
        >
          Team builder
        </Button>
        <Button size="sm" variant="ghost" onClick={query.refresh}>
          Refresh teams
        </Button>
        {offset > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset((value) => Math.max(0, value - 30))}
          >
            Previous teams
          </Button>
        ) : null}
        {query.data && offset + 30 < query.data.total ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset((value) => value + 30)}
          >
            More teams
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function PolicyPinName({
  pin,
  projectId,
}: {
  pin: TeamPin;
  projectId: string;
}) {
  const query = useTeamQuery(
    `graph-policy-pin:${projectId}:${pin.teamId}:${pin.revision}`,
    (rpc) =>
      rpc.call("getTeamRevision", {
        scope: { kind: "project", projectId },
        ...pin,
      }),
  );
  return (
    <span>
      {query.data?.revision.definition.name ??
        (query.loading ? "Loading team…" : pin.teamId)}{" "}
      · v{pin.revision}
    </span>
  );
}

function PolicySummary({
  policy,
  projectId,
  selectedTeam,
}: {
  policy: ResolvedRunPolicy;
  projectId: string;
  selectedTeam: TeamRevision | null;
}) {
  const key = (pin: TeamPin) => `${pin.teamId}:${pin.revision}`;
  const preferences = new Set(policy.preferredTeams.map(key));
  const pins = [
    ...new Map(
      [...policy.preferredTeams, ...(policy.restrictedTeams ?? [])].map(
        (pin) => [key(pin), pin],
      ),
    ).values(),
  ];
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">
        {policy.autonomy === "guided"
          ? "Guided · approve each assignment"
          : policy.autonomy === "collaborative"
            ? "Collaborative · approve the plan first"
            : "Autonomous · work within the saved plan"}
      </p>
      <p className="text-muted-foreground">
        Up to {policy.limits.maxConcurrentAgents} agents at once ·{" "}
        {policy.limits.maxAgentCalls} agent calls ·{" "}
        {policy.limits.maxRepairRounds} repair rounds ·{" "}
        {Math.round(policy.limits.maxActiveMs / 60000)} active minutes
      </p>
      <p className="text-muted-foreground">
        The final response in the main conversation uses one agent call.
      </p>
      <p className="text-muted-foreground">
        {preferences.size === 0
          ? "No team preference"
          : "Saved team preferences apply"}{" "}
        ·{" "}
        {policy.restrictedTeams === null
          ? "Any published project team is allowed"
          : policy.restrictedTeams.length === 0
            ? "No teams are allowed by these settings"
            : "Only the saved allowed teams can run"}
      </p>
      {pins.length > 0 ? (
        <ul className="space-y-1 text-muted-foreground">
          {pins.map((pin) => (
            <li key={key(pin)}>
              {selectedTeam?.teamId === pin.teamId &&
              selectedTeam.revision === pin.revision ? (
                <span>
                  {selectedTeam.definition.name} · v{pin.revision}
                </span>
              ) : (
                <PolicyPinName pin={pin} projectId={projectId} />
              )}{" "}
              · {preferences.has(key(pin)) ? "preferred" : "allowed"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function GraphRunForm({
  projectId,
  teamId,
  revision,
  onStarted,
}: z.infer<typeof routeSchema> & { onStarted(run: ArcRunView): void }) {
  const rpc = useRpc<GraphRpc>();
  const navigate = useBbNavigate();
  const retained = useRetainedRequest(
    `arc:graph-start:v1:${projectId}:${teamId}:${revision}`,
    pendingStartSchema,
  );
  const pending =
    retained.value &&
    retained.value.request.projectId === projectId &&
    retained.value.request.team.teamId === teamId &&
    retained.value.request.team.revision === revision
      ? retained.value
      : null;
  const [hostId, setHostId] = useState<string | null>(
    pending?.request.hostId ?? null,
  );
  const [parentId, setParentId] = useState(
    pending?.request.originThreadId ?? "",
  );
  const [parentTitle, setParentTitle] = useState(pending?.parentTitle ?? "");
  const [sessionOffset, setSessionOffset] = useState(0);
  const [goal, setGoal] = useState(pending?.request.goal ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<DirectorySetup | null>(null);
  const teamQuery = useGraphQuery(
    `graph-pin:${projectId}:${teamId}:${revision}`,
    async (client) => {
      const { revision: team } = await client.call("getTeamRevision", {
        scope: { kind: "project", projectId },
        teamId,
        revision,
      });
      const unique = [
        ...new Map(
          team.definition.members.map((member) => [
            `${member.agentId}:${member.revision}`,
            member,
          ]),
        ).values(),
      ];
      const names = await Promise.all(
        unique.map(async (member) => {
          const agent = await client.call("getAgentRevision", {
            scope: { kind: "project", projectId },
            agentId: member.agentId,
            revision: member.revision,
          });
          return [
            `${member.agentId}:${member.revision}`,
            agent.revision.metadata.name,
          ] as const;
        }),
      );
      return { team, memberNames: Object.fromEntries(names) };
    },
    "teams:changed",
  );
  const setupQuery = useGraphQuery(
    `graph-setup:${projectId}:${hostId}`,
    (client) => client.call("getProjectRunSetup", { projectId, hostId }),
    "projects:changed",
  );
  const sessionQuery = useGraphQuery(
    `graph-sessions:${projectId}:${sessionOffset}`,
    (client) =>
      client.call("listPolicySessions", {
        projectId,
        limit: 30,
        offset: sessionOffset,
      }),
    "policy:changed",
  );
  const policyQuery = useGraphQuery(
    `graph-policy:${projectId}:${parentId}`,
    (client) =>
      client.call("getOrchestrationPolicy", {
        projectId,
        threadId: parentId || null,
      }),
    "policy:changed",
  );
  const pinned = pending?.pinned ?? teamQuery.data;
  const policy = pending?.policy ?? policyQuery.data;
  const effective = policy?.effective;
  const selected = pending
    ? "sourceInspectionId" in pending.request
      ? {
          kind: "directory" as const,
          hostId: pending.request.hostId,
          path: pending.request.path,
        }
      : {
          kind: "git" as const,
          hostId: pending.request.hostId,
          path: pending.request.path,
          head: pending.request.expectedHead,
          clean: true,
        }
    : setupQuery.data?.selected;
  const directoryDiagnostics =
    selected?.kind === "directory" && pinned
      ? validateDirectoryTeamGraph(pinned.team.definition).diagnostics
      : [];
  const sourceReady =
    selected?.kind === "git"
      ? selected.clean
      : inspection?.state === "ready" &&
        inspection.hostId === selected?.hostId &&
        inspection.path === selected?.path;
  const allowed =
    effective?.restrictedTeams === null ||
    effective?.restrictedTeams.some(
      (pin) => pin.teamId === teamId && pin.revision === revision,
    );
  const release = pinned?.team.definition.graph.nodes.some(
    (node) => node.kind === "release",
  );
  const ready =
    pinned &&
    effective &&
    sourceReady &&
    parentId &&
    goal.trim() &&
    allowed &&
    !release &&
    directoryDiagnostics.length === 0 &&
    policy?.errors.length === 0 &&
    !policyQuery.loading &&
    !setupQuery.loading &&
    !teamQuery.loading &&
    !policyQuery.error &&
    !setupQuery.error &&
    !teamQuery.error;
  async function start() {
    if (busy || pending?.recovery === "setup" || (!pending && !ready)) return;
    if (!pending && (!pinned || !policy || !selected)) return;
    setBusy(true);
    setError(null);
    try {
      let sealed = pending;
      if (sealed === null) {
        if (!pinned || !policy || !selected) return;
        sealed = pendingStartSchema.parse({
          request: {
            operationId: crypto.randomUUID(),
            projectId,
            originThreadId: parentId,
            hostId: selected.hostId,
            path: selected.path,
            ...(selected.kind === "git"
              ? { expectedHead: selected.head }
              : inspection?.state === "ready"
                ? {
                    sourceInspectionId: inspection.sourceInspectionId,
                    expectedSource: {
                      rootIdentity: inspection.source.rootIdentity,
                      manifestDigest: inspection.source.manifestDigest,
                    },
                  }
                : {}),
            goal,
            team: { teamId, revision },
            expectedProjectPolicyVersion: policy.project.version,
            expectedSessionPolicyVersion: policy.session?.version ?? 0,
          },
          pinned,
          policy,
          parentTitle,
        });
      }
      retained.retain(sealed);
      const run =
        "sourceInspectionId" in sealed.request
          ? await rpc.call("requestDirectoryTeamRun", sealed.request)
          : await rpc.call("startTeamRun", sealed.request);
      retained.retain(null);
      onStarted(run);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function reviewCurrentSetup() {
    if (busy || pending === null) return;
    setBusy(true);
    setError(null);
    retained.retain({ ...pending, recovery: "setup" });
    try {
      const result =
        "sourceInspectionId" in pending.request
          ? await rpc.call("discardDirectoryRunRequest", pending.request)
          : await rpc.call("discardTeamRunRequest", pending.request);
      if (result.state === "reserved") {
        retained.retain(null);
        onStarted(result.run);
      } else {
        if (result.operationId !== pending.request.operationId)
          throw new Error(
            "The setup review did not match the saved request. Retry this review.",
          );
        retained.retain(null);
        setupQuery.refresh();
        policyQuery.refresh();
        teamQuery.refresh();
        sessionQuery.refresh();
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-3xl space-y-5">
      {pinned ? (
        <section aria-label="Pinned team plan" className="space-y-3">
          <div>
            <h2 className="text-base font-medium">
              {pinned.team.definition.name} · v{pinned.team.revision}
            </h2>
            {pinned.team.definition.description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {pinned.team.definition.description}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{pinned.team.definition.members.length} members</span>
            <span>{pinned.team.definition.graph.nodes.length} stages</span>
            <span>
              {pinned.team.definition.graph.requiredGates.length} required gate
              groups
            </span>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer">
              Published members and plan
            </summary>
            <ul className="mt-2 space-y-1">
              {pinned.team.definition.members.map((member) => (
                <li key={member.id}>
                  {pinned.memberNames[`${member.agentId}:${member.revision}`] ??
                    member.id}{" "}
                  · agent v{member.revision}
                  {member.groupId
                    ? ` · ${pinned.team.definition.groups.find((group) => group.id === member.groupId)?.name ?? member.groupId}`
                    : ""}
                </li>
              ))}
            </ul>
            <ul className="mt-3 space-y-1">
              {pinned.team.definition.graph.nodes.map((node) => (
                <li key={node.id}>
                  {node.label} · {node.kind.replaceAll("-", " ")}
                </li>
              ))}
            </ul>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              Published content: {pinned.team.contentHash}
            </p>
          </details>
        </section>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading published team…
        </p>
      )}
      <fieldset
        disabled={busy || pending !== null}
        className="space-y-4 border-0 p-0"
      >
        <label className={fieldClass}>
          Main conversation
          <select
            className={selectClass}
            value={parentId}
            onChange={(event) => {
              const thread = sessionQuery.data?.threads.find(
                (item) => item.id === event.target.value,
              );
              setParentId(event.target.value);
              setParentTitle(thread?.title ?? event.target.value);
              setInspection(null);
            }}
          >
            <option value="">Choose an existing conversation</option>
            {parentId &&
            !sessionQuery.data?.threads.some(
              (thread) => thread.id === parentId,
            ) ? (
              <option value={parentId}>{parentTitle}</option>
            ) : null}
            {sessionQuery.data?.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title || "Untitled conversation"}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={sessionQuery.refresh}>
            Refresh conversations
          </Button>
          {sessionOffset > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSessionOffset((value) => Math.max(0, value - 30))
              }
            >
              Previous conversations
            </Button>
          ) : null}
          {sessionQuery.data?.hasMore ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSessionOffset((value) => value + 30)}
            >
              More conversations
            </Button>
          ) : null}
        </div>
        {sessionQuery.data?.threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Start a normal conversation in this project, then refresh this list.
          </p>
        ) : null}
        <label className={fieldClass}>
          Project source
          <select
            className={selectClass}
            value={hostId ?? selected?.hostId ?? ""}
            onChange={(event) => {
              setHostId(event.target.value || null);
              setInspection(null);
            }}
          >
            <option value="">Choose a project source</option>
            {setupQuery.data?.sources.map((source) => (
              <option
                key={`${source.hostId}:${source.path}`}
                value={source.hostId}
              >
                {source.path} · {source.hostId}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <p className="break-words text-sm text-muted-foreground">
            {pending
              ? "Saved source"
              : selected.kind === "directory"
                ? "Project folder · serial execution"
                : selected.clean
                  ? "Clean checkout"
                  : "Checkout has uncommitted changes"}{" "}
            {selected.kind === "git" ? (
              <>
                · <code>{selected.head.slice(0, 12)}</code>
              </>
            ) : null}
            <br />
            {selected.path}
          </p>
        ) : null}
        {selected?.kind === "git" && !selected.clean ? (
          <p className="text-sm text-destructive">
            Commit or stash your changes, then refresh the checkout before
            starting.
          </p>
        ) : null}
        <Button size="sm" variant="ghost" onClick={setupQuery.refresh}>
          Refresh project source
        </Button>
        {!pending && selected?.kind === "directory" && parentId ? (
          <DirectoryInspection
            key={`${projectId}:${parentId}:${selected.hostId}:${selected.path}`}
            projectId={projectId}
            originThreadId={parentId}
            hostId={selected.hostId}
            path={selected.path}
            onChanged={setInspection}
          />
        ) : null}
        <label className={fieldClass}>
          What should the team deliver?
          <Textarea
            className="mt-1 min-h-24"
            value={goal}
            maxLength={16384}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Describe the outcome for this team."
          />
        </label>
      </fieldset>
      {policy && effective ? (
        <section
          aria-label="Run orchestration settings"
          className="space-y-2 border-t pt-4"
        >
          <PolicySummary
            policy={effective}
            projectId={projectId}
            selectedTeam={pinned?.team ?? null}
          />
          <p className="text-xs text-muted-foreground">
            Project settings v{policy.project.version} · conversation settings v
            {policy.session?.version ?? 0}
            {pending ? " · retained for this request" : ""}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() =>
              navigate.toPluginPanel("orchestration", {
                subPath: `project/${encodeURIComponent(projectId)}${parentId ? `/session/${encodeURIComponent(parentId)}` : ""}`,
              })
            }
          >
            Orchestration settings
          </Button>
        </section>
      ) : null}
      {!pending && effective && !allowed ? (
        <p role="alert" className="text-sm text-destructive">
          This team revision is outside this conversation’s allowed teams.
        </p>
      ) : null}
      {release ? (
        <p role="alert" className="text-sm text-destructive">
          This published plan includes a release stage. Running release stages
          requires the upcoming factory capability.
        </p>
      ) : null}
      {[
        error,
        teamQuery.error,
        setupQuery.error,
        sessionQuery.error,
        policyQuery.error,
        retained.storageError,
        ...(policy?.errors ?? []),
        ...directoryDiagnostics.map(
          (item) =>
            `${item.message} Stages: ${item.nodeIds.map((id) => pinned?.team.definition.graph.nodes.find((node) => node.id === id)?.label || id).join(", ")}.`,
        ),
      ]
        .filter(Boolean)
        .map((message, index) => (
          <p
            key={index}
            role="alert"
            className="break-words text-sm text-destructive"
          >
            {message}
          </p>
        ))}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || (!pending && !ready)}
            onClick={() =>
              void (pending?.recovery === "setup"
                ? reviewCurrentSetup()
                : start())
            }
          >
            {busy
              ? pending?.recovery === "setup"
                ? "Checking saved request…"
                : "Saving run…"
              : pending?.recovery === "setup"
                ? "Retry setup review"
                : pending
                  ? "Retry saved team request"
                  : "Start published team run"}
          </Button>
          {pending && pending.recovery !== "setup" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void reviewCurrentSetup()}
            >
              Review current setup
            </Button>
          ) : null}
        </div>
        {pending ? (
          <>
            <p className="text-sm text-muted-foreground">
              This exact request is retained across retries and reloads. Its
              team revision, conversation, source and settings remain sealed.
            </p>
            <p className="text-sm text-muted-foreground">
              Reviewing setup first checks whether this request saved a run. If
              it did, that run opens. Otherwise, you can review current settings
              and start again.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Starting saves the published plan and resolves its pinned agents’
            model settings from this project and conversation.
          </p>
        )}
      </div>
    </div>
  );
}

export function RunControls({
  run,
  blockedReason = null,
}: {
  run: ArcRunView;
  blockedReason?: string | null;
}) {
  const workflowState = run.workflow?.state;
  const [offset, setOffset] = useState(0);
  const query = useGraphQuery(
    `run-decisions:${run.summary.runId}:${run.workflow?.state}:${run.workflow?.controlVersion}:${offset}`,
    (rpc) =>
      rpc.call("listRunControls", {
        runId: run.summary.runId,
        limit: 20,
        offset,
      }),
    "runs:changed",
  );
  const { refresh } = query;
  useEffect(() => {
    if (
      workflowState &&
      ["succeeded", "failed", "cancelled"].includes(workflowState)
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [workflowState, refresh]);
  return (
    <section aria-label="Run approvals" className="space-y-3 border-t pt-4">
      <h2 className="text-sm font-medium">Approvals</h2>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.loading && !query.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading approval decisions…
        </p>
      ) : null}
      {query.data?.controls.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No approval decisions have been requested.
        </p>
      ) : null}
      {query.data?.controls.map((control) => (
        <RunControlDecision
          key={control.controlId}
          control={control}
          run={run}
          changed={query.refresh}
          blockedReason={blockedReason}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={query.refresh}>
          Refresh approvals
        </Button>
        {offset > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset((value) => Math.max(0, value - 20))}
          >
            Previous approvals
          </Button>
        ) : null}
        {query.data && offset + 20 < query.data.total ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset((value) => value + 20)}
          >
            More approvals
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function RunControlDecision({
  control,
  run,
  changed,
  blockedReason,
}: {
  control: RunControl;
  run: ArcRunView;
  changed(): void;
  blockedReason: string | null;
}) {
  const rpc = useRpc<GraphRpc>();
  const retained = useRetainedRequest(
    `arc:run-decision:v1:${run.summary.runId}:${control.controlId}`,
    resolveRunControlSchema,
  );
  const pending =
    retained.value?.runId === run.summary.runId &&
    retained.value.controlId === control.controlId
      ? retained.value
      : null;
  const [resolved, setResolved] = useState<RunControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeDecision = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeDecision.current?.abort();
    };
  }, []);
  const current =
    resolved && resolved.revision >= control.revision ? resolved : control;
  const context = current.context;
  const operation = context.operation;
  const definition = run.definition;
  const terminal =
    run.workflow !== null &&
    ["succeeded", "failed", "cancelled"].includes(run.workflow.state);
  const paused =
    blockedReason !== null ||
    (definition.schemaVersion === 4 && run.workflow?.desiredControl !== "run");
  useEffect(() => {
    if (terminal || paused) activeDecision.current?.abort();
  }, [terminal, paused]);
  const memberName = (memberId: string) =>
    definition.schemaVersion !== 1
      ? (definition.members[memberId]?.definition.metadata.name ?? memberId)
      : memberId;
  async function decide(decision: "approved" | "rejected") {
    if (busy || terminal || paused || current.state !== "pending") return;
    const request = pending ?? {
      runId: run.summary.runId,
      controlId: current.controlId,
      operationId: crypto.randomUUID(),
      expectedRevision: current.revision,
      contextHash: current.contextHash,
      decision,
    };
    setBusy(true);
    setError(null);
    retained.retain(request);
    const controller = new AbortController();
    activeDecision.current = controller;
    try {
      let result: RunControl;
      if (definition.schemaVersion === 4) {
        const startedAt = Date.now();
        for (;;) {
          controller.signal.throwIfAborted();
          const response = await rpc.call(
            "resolveDirectoryRunControl",
            request,
          );
          controller.signal.throwIfAborted();
          if (response.state === "resolved") {
            result = response.control;
            break;
          }
          if (
            response.control.revision !== request.expectedRevision ||
            response.control.contextHash !== request.contextHash ||
            response.control.state !== "pending"
          )
            throw new Error(
              "This decision changed. Review its current evidence before responding.",
            );
          setChecking(true);
          if (Date.now() - startedAt >= 15 * 60_000)
            throw new Error(
              "Folder verification is still pending. Retry the saved decision to continue checking.",
            );
          await new Promise<void>((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(controller.signal.reason);
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener("abort", stop);
              resolve();
            }, 1500);
            controller.signal.addEventListener("abort", stop, { once: true });
          });
        }
      } else result = await rpc.call("resolveRunControl", request);
      if (controller.signal.aborted) return;
      setResolved(result);
      retained.retain(null);
      changed();
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (activeDecision.current === controller) activeDecision.current = null;
      if (mounted.current) {
        setBusy(false);
        setChecking(false);
      }
    }
  }
  return (
    <article
      className="space-y-3 border-t pt-3 text-sm"
      aria-label={
        operation.type === "delegation"
          ? "Assignment approval"
          : "Plan or task approval"
      }
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="font-medium">
          {operation.type === "delegation"
            ? "Proposed assignments"
            : context.candidate === null
              ? "Plan approval"
              : "Task approval"}
        </h3>
        <span className="text-muted-foreground">
          {current.state === "pending"
            ? terminal
              ? "Run ended"
              : "Waiting for you"
            : current.state === "cancelled"
              ? "Cancelled"
              : current.decision === "approved"
                ? "Approved"
                : "Rejected"}
        </span>
      </div>
      {operation.type === "approval" ? (
        <p className="whitespace-pre-wrap break-words">{operation.message}</p>
      ) : operation.type === "delegation" ? (
        <p className="whitespace-pre-wrap break-words">{operation.task}</p>
      ) : null}
      {context.proposedAssignments ? (
        <ol className="space-y-1">
          {context.proposedAssignments.map((assignment, index) => (
            <li key={`${index}:${assignment.memberId}`}>
              {index + 1}. {memberName(assignment.memberId)}
              {definition.schemaVersion !== 1 &&
              definition.members[assignment.memberId]
                ? ` · agent v${definition.members[assignment.memberId].definition.revision}`
                : ""}
            </li>
          ))}
        </ol>
      ) : null}
      {context.candidate ? (
        <p className="break-words text-muted-foreground">
          Candidate{" "}
          <code>
            {("kind" in context.candidate
              ? context.candidate.manifestDigest
              : context.candidate.head
            ).slice(0, 12)}
          </code>
          <br />
          {"kind" in context.candidate
            ? context.candidate.workspace.path
            : context.candidate.path}
        </p>
      ) : (
        <p className="text-muted-foreground">
          This decision is bound to the saved team plan.
        </p>
      )}
      {definition.schemaVersion !== 1 ? (
        <p className="text-muted-foreground">
          {definition.team.definition.name} · team v{definition.team.revision} ·{" "}
          {definition.policy.autonomy}
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Decision evidence
        </summary>
        <dl className="mt-2 grid gap-y-2 break-all text-xs">
          <div>
            <dt>Context</dt>
            <dd>{current.contextHash}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{context.planHash}</dd>
          </div>
          <div>
            <dt>Team content</dt>
            <dd>{context.teamContentHash}</dd>
          </div>
          <div>
            <dt>Settings</dt>
            <dd>{context.policyHash}</dd>
          </div>
          <div>
            <dt>Decision revision</dt>
            <dd>{current.revision}</dd>
          </div>
        </dl>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {context.dependencyReceipts.map((proof) => (
            <li
              className="break-all"
              key={`${proof.nodeId}:${proof.iteration}`}
            >
              {proof.nodeId} · {proof.outcome} · receipt {proof.receiptHash}
            </li>
          ))}
        </ul>
      </details>
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
      {checking && (
        <p role="status" className="text-muted-foreground">
          Verifying folder contents before saving your decision…
        </p>
      )}
      {paused && !terminal && (
        <p className="text-muted-foreground">
          {blockedReason ?? "Resume this run to verify and save the decision."}
        </p>
      )}
      {retained.storageError ? (
        <p role="alert" className="text-destructive">
          {retained.storageError}
        </p>
      ) : null}
      {pending && current.state !== "pending" ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            This decision is already closed. The recorded result is shown above;
            the saved retry will not change it.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              retained.retain(null);
              setError(null);
            }}
          >
            Dismiss saved retry
          </Button>
        </div>
      ) : pending ? (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || terminal || paused}
            onClick={() => void decide(pending.decision)}
          >
            {busy
              ? "Saving decision…"
              : `Retry ${pending.decision === "approved" ? "approval" : "rejection"}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Retrying preserves the exact decision and evidence revision.
          </p>
        </div>
      ) : current.state === "pending" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || terminal || paused}
            onClick={() => void decide("approved")}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || terminal || paused}
            onClick={() => void decide("rejected")}
          >
            Reject
          </Button>
        </div>
      ) : null}
      {terminal && current.state === "pending" ? (
        <p className="text-muted-foreground">
          This run has ended. Refresh approval history to see its recorded
          decision status.
        </p>
      ) : null}
    </article>
  );
}

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import {
  useBbNavigate,
  experimental_useAppPanel as useAppPanel,
  experimental_useProviders as useProviders,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { Icon } from "@bb/shared-ui/icon";
import type {
  AgentScope,
  AgentSummary,
  AgentSkillReference,
  AgentMetadata,
} from "../contract.js";
import { errorMessage, studioPath, useStudioQuery } from "../studio/data.js";
import {
  MAX_TEAM_NODES,
  teamDefinitionSchema,
  type TeamDefinition,
  type TeamDetail,
  type TeamNode,
} from "./contract.js";
import {
  blankTeam,
  newStage,
  stageLabels,
  teamPath,
  teamRoute,
  useTeamQuery,
  useTeamRpc,
  type BuilderSelection,
} from "./ui-data.js";
import { TeamCanvas } from "./canvas.js";
import {
  EdgeInspector,
  Field,
  selectClass,
  StageInspector,
} from "./inspector.js";
import { TeamPeople } from "./people.js";
import { TeamHistory, TeamSuggestions } from "./history.js";
import { TeamRequirements } from "./requirements.js";
import { OrganizationCanvas } from "./organization-canvas.js";
import { TeamMemberInspector } from "./member-inspector.js";
import type { MemberIdentity } from "./member-model.js";
import { queueAssistantDraft } from "../studio/assistant-draft.js";
import {
  AGENT_DRAG_TYPE,
  addSubagentGrants,
  connectTeamMembers,
  relationshipLabels,
  removeTeamMember,
  type TeamRelationship,
} from "./organization.js";
import { TeamTemplateCatalog } from "../templates/panel.js";
import {
  connectionFilterLabels,
  type TeamConnectionFilter,
} from "./organization-connections.js";

const localTeamSchema = z
  .object({
    version: z.number().int().positive(),
    definition: teamDefinitionSchema,
  })
  .strict();
function isLocalTeam(value: unknown): value is z.infer<typeof localTeamSchema> {
  return localTeamSchema.safeParse(value).success;
}

const tabs = [
  "Team",
  "Workflow",
  "People & groups",
  "History",
  "Suggestions",
  "Definition",
] as const;

export function TeamBuilder({ subPath }: PluginNavPanelProps) {
  const route = teamRoute(subPath);
  const rpc = useTeamRpc();
  const navigate = useBbNavigate();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [offset, setOffset] = useState(0);
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useStudioQuery("team-projects", (client) =>
    client.call("listStudioProjects", null),
  );
  const query = useTeamQuery(
    `teams:${JSON.stringify(route.scope)}:${deferred}:${offset}:${archived}`,
    (client) =>
      client.call("listTeams", {
        scope: route.scope,
        search: deferred,
        limit: 50,
        offset,
        includeArchived: archived,
      }),
  );
  const go = (scope: AgentScope, teamId: string | null = null) =>
    navigate.toPluginPanel("teams", { subPath: teamPath(scope, teamId) });
  return (
    <div
      className="@container/teams flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-arc-team-builder
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          {route.teamId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(route.scope)}
              aria-label="Back to teams"
            >
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
          )}
          <div>
            <h1 className="text-base font-medium">Team Builder</h1>
            <p className="text-xs text-muted-foreground">
              Give your agents a shared way to work.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Save in
          <select
            aria-label="Team library or project"
            className="h-8 max-w-56 rounded-md border bg-background px-2 text-sm text-foreground"
            value={
              route.scope.kind === "library" ? "library" : route.scope.projectId
            }
            onChange={(event) => {
              setOffset(0);
              go(
                event.target.value === "library"
                  ? { kind: "library" }
                  : { kind: "project", projectId: event.target.value },
              );
            }}
          >
            <option value="library">Personal library</option>
            {projects.data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {projects.error && (
        <p
          role="alert"
          className="border-b px-4 py-2 text-xs text-destructive-text"
        >
          Projects could not load: {projects.error}
          <Button size="sm" variant="ghost" onClick={projects.refresh}>
            Retry
          </Button>
        </p>
      )}
      {route.teamId ? (
        <SelectedTeam
          key={`${JSON.stringify(route.scope)}:${route.teamId}`}
          teamId={route.teamId}
          scope={route.scope}
          projects={projects.data?.projects ?? []}
          onOpen={go}
        />
      ) : (
        <div className="mx-auto w-full max-w-4xl space-y-5 overflow-y-auto p-5">
          <TeamTemplateCatalog
            projects={projects.data?.projects ?? []}
            projectId={
              route.scope.kind === "project" ? route.scope.projectId : null
            }
            onOpen={go}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="Search teams"
              placeholder="Find a team…"
              className="min-w-48 flex-1"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => {
                  setArchived(event.target.checked);
                  setOffset(0);
                }}
              />
              Include archived
            </label>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              setBusy(true);
              setError(null);
              void rpc
                .call("createTeam", {
                  scope: route.scope,
                  definition: blankTeam(name.trim()),
                })
                .then(
                  (value) => {
                    setName("");
                    go(route.scope, value.team.id);
                  },
                  (failure) => setError(errorMessage(failure)),
                )
                .finally(() => setBusy(false));
            }}
          >
            <Input
              aria-label="New team name"
              placeholder="Name your team"
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              Create team
            </Button>
          </form>
          {(error || query.error) && (
            <p role="alert" className="text-sm text-destructive-text">
              {error ?? query.error}
              <Button size="sm" variant="ghost" onClick={query.refresh}>
                Retry
              </Button>
            </p>
          )}
          {!query.data && !query.error && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading teams…
            </p>
          )}
          {query.data?.total === 0 && (
            <div className="py-12">
              <Icon
                name="Workflow"
                className="mb-4 size-6 text-muted-foreground"
              />
              <h2 className="text-base font-medium">
                Start with the people, then connect the work
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
                Create a team, add published agents from your library, and
                connect their assignments with checks and reviews. You can save
                unfinished drafts as you go.
              </p>
            </div>
          )}
          {query.data?.teams.map((team) => (
            <button
              key={team.id}
              type="button"
              className="flex w-full items-center gap-3 border-b px-1 py-4 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => go(team.scope, team.id)}
            >
              <Icon name="Workflow" className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-medium">
                  {team.name || "Untitled team"}
                </h2>
                <p className="truncate text-xs text-muted-foreground">
                  {team.description || "No description yet"}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {team.archivedAt !== null
                  ? "Archived"
                  : team.currentRevision === null
                    ? "Draft"
                    : `v${team.currentRevision}${team.hasUnpublishedChanges ? " · edited" : ""}`}
              </span>
              <Icon name="ChevronRight" className="size-4" />
            </button>
          ))}
          {query.data && query.data.total > 50 && (
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </Button>
              <span className="text-xs">
                {offset + 1}–{Math.min(offset + 50, query.data.total)} of{" "}
                {query.data.total}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + 50 >= query.data.total}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SelectedTeam({
  teamId,
  scope,
  projects,
  onOpen,
}: {
  teamId: string;
  scope: AgentScope;
  projects: { id: string; name: string }[];
  onOpen(scope: AgentScope, teamId: string): void;
}) {
  const query = useTeamQuery(`team:${JSON.stringify(scope)}:${teamId}`, (rpc) =>
    rpc.call("getTeam", { teamId, scope }),
  );
  if (!query.data)
    return (
      <div className="p-5 text-sm" role={query.error ? "alert" : "status"}>
        {query.error ?? "Loading team…"}
        {query.error && (
          <Button variant="ghost" size="sm" onClick={query.refresh}>
            Retry
          </Button>
        )}
      </div>
    );
  return (
    <TeamEditor
      team={query.data.team}
      projects={projects}
      onOpen={onOpen}
      refresh={query.refresh}
      remoteError={query.error}
    />
  );
}

function TeamEditor({
  team,
  projects,
  onOpen,
  refresh,
  remoteError,
}: {
  team: TeamDetail;
  projects: { id: string; name: string }[];
  onOpen(scope: AgentScope, teamId: string): void;
  refresh(): void;
  remoteError: string | null;
}) {
  const rpc = useTeamRpc();
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  const providerDirectory = useProviders();
  const storageKey = `arc.teamDraft.${team.id}`;
  const [local] = useState(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "null",
      );
      return isLocalTeam(value) ? value : null;
    } catch {
      return null;
    }
  });
  const [base, setBase] = useState(team);
  const [version, setVersion] = useState(local?.version ?? team.draft.version);
  const [definition, setDefinition] = useState<TeamDefinition>(
    local?.definition ?? team.draft.definition,
  );
  const [selection, setSelection] = useState<BuilderSelection>(null);
  const [editingModelMemberId, setEditingModelMemberId] = useState<
    string | null
  >(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>(
    team.draft.definition.schemaVersion === 1 ? "Workflow" : "Team",
  );
  const [relationship, setRelationship] = useState<TeamRelationship>("message");
  const [connectionFilter, setConnectionFilter] =
    useState<TeamConnectionFilter>("reports-to");
  const [bothWays, setBothWays] = useState(true);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const history = useRef<{
    past: TeamDefinition[];
    future: TeamDefinition[];
    lastAt: number;
    movement: boolean;
  }>({ past: [], future: [], lastAt: 0, movement: false });
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const [, setHistoryVersion] = useState(0);
  const [compactPane, setCompactPane] = useState<
    "canvas" | "library" | "inspector"
  >("canvas");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copyProject, setCopyProject] = useState("");
  const [paletteSearch, setPaletteSearch] = useState("");
  const deferredSearch = useDeferredValue(paletteSearch);
  const [paletteOffset, setPaletteOffset] = useState(0);
  const [paletteSource, setPaletteSource] = useState<"project" | "library">(
    team.scope.kind === "library" ? "library" : "project",
  );
  const paletteScope: AgentScope =
    paletteSource === "library" ? { kind: "library" } : team.scope;
  const [stageKind, setStageKind] = useState<TeamNode["kind"]>("agent");
  const [connectSource, setConnectSource] = useState("");
  const [connectTarget, setConnectTarget] = useState("");
  const [raw, setRaw] = useState(JSON.stringify(definition, null, 2));
  const dirty =
    JSON.stringify(definition) !== JSON.stringify(base.draft.definition);
  const conflict = team.draft.version > version;
  const target = { teamId: team.id, scope: team.scope };
  const palette = useStudioQuery(
    `team-palette:${JSON.stringify(paletteScope)}:${deferredSearch}:${paletteOffset}`,
    (client) =>
      client.call("listAgents", {
        scope: paletteScope,
        search: deferredSearch,
        includeArchived: false,
        limit: 50,
        offset: paletteOffset,
      }),
  );
  const memberKey = JSON.stringify(
    definition.members.map((member) => [
      member.id,
      member.agentId,
      member.revision,
    ]),
  );
  const memberQuery = useTeamQuery(
    `team-members:${team.id}:${memberKey}`,
    async (client) => {
      const entries = await Promise.all(
        definition.members.map(async (member) => {
          try {
            const value = await client.call("getAgentRevision", {
              agentId: member.agentId,
              scope: team.scope,
              revision: member.revision,
            });
            return [
              member.id,
              {
                name: value.revision.metadata.name,
                model:
                  value.revision.metadata.execution.model ?? "Project model",
                role: value.revision.metadata.role,
                execution: value.revision.metadata.execution,
                skills: [...(value.revision.metadata.skills ?? [])],
                error: null,
              },
            ] as const;
          } catch (failure) {
            return [
              member.id,
              {
                name: `Unavailable agent · v${member.revision}`,
                model: member.agentId,
                role: "",
                execution: null,
                skills: new Array<AgentSkillReference>(),
                error: errorMessage(failure),
              },
            ] as const;
          }
        }),
      );
      return new Map<
        string,
        {
          name: string;
          model: string;
          role: string;
          execution: AgentMetadata["execution"] | null;
          skills: readonly AgentSkillReference[];
          error: string | null;
        }
      >(entries);
    },
  );
  const names = useMemo(() => {
    const identities = new Map<string, MemberIdentity>();
    for (const member of definition.members) {
      const agent = memberQuery.data?.get(member.id);
      if (!agent) continue;
      const execution = member.modelOverride ?? agent.execution;
      const provider = providerDirectory.providers.find(
        (item) => item.id === execution?.providerId,
      );
      identities.set(member.id, {
        name: agent.name,
        role: agent.role,
        model: execution?.model ?? "Project model",
        providerId: execution?.providerId ?? null,
        providerName: provider?.displayName,
        logoUrl: provider?.logoUrl,
      });
    }
    return identities;
  }, [memberQuery.data, definition.members, providerDirectory.providers]);
  const selectedNode =
    selection?.kind === "node"
      ? definition.graph.nodes.find((node) => node.id === selection.id)
      : undefined;
  const selectedEdge =
    selection?.kind === "edge"
      ? definition.graph.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const selectedMember =
    selection?.kind === "member"
      ? definition.members.find((member) => member.id === selection.id)
      : undefined;
  const selectedGrant =
    selection?.kind === "grant"
      ? definition.permissions.find((grant) => grant.id === selection.id)
      : undefined;
  const selectedHierarchy =
    selection?.kind === "hierarchy"
      ? definition.members.find((member) => member.id === selection.id)
      : undefined;

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version, definition }));
    } catch {}
  }, [storageKey, version, definition]);
  useEffect(() => {
    if (
      !dirty &&
      version === base.draft.version &&
      team.draft.version > base.draft.version
    ) {
      setBase(team);
      setVersion(team.draft.version);
      setDefinition(team.draft.definition);
    }
  }, [team, base, dirty, version]);
  useEffect(() => {
    if (tab !== "Definition") setRaw(JSON.stringify(definition, null, 2));
  }, [definition, tab]);
  const changed = useCallback((value: TeamDefinition) => {
    if (
      value.schemaVersion === 1 &&
      (value.leaderMemberId !== undefined ||
        value.presentation.members !== undefined ||
        value.permissions.some((grant) => grant.action === "message") ||
        value.members.some(
          (member) =>
            member.role !== undefined ||
            member.responsibility !== undefined ||
            member.leaderMemberId !== undefined ||
            member.skills !== undefined,
        ))
    )
      value = { ...value, schemaVersion: 2 };
    const previous = definitionRef.current;
    if (JSON.stringify(value) === JSON.stringify(previous)) return;
    const movement =
      JSON.stringify({
        ...value,
        schemaVersion: previous.schemaVersion,
        presentation: previous.presentation,
      }) === JSON.stringify(previous);
    const now = Date.now();
    if (
      !(
        movement &&
        history.current.movement &&
        now - history.current.lastAt < 500
      )
    )
      history.current.past = [...history.current.past.slice(-49), previous];
    history.current.future = [];
    history.current.movement = movement;
    history.current.lastAt = now;
    definitionRef.current = value;
    setDefinition(value);
    setHistoryVersion((current) => current + 1);
    setMessage(null);
  }, []);
  const select = useCallback((value: BuilderSelection) => {
    setSelection(value);
  }, []);
  const editMemberModel = useCallback((memberId: string) => {
    setSelection({ kind: "member", id: memberId });
    setEditingModelMemberId(memberId);
    setTab("Team");
    setCompactPane("inspector");
  }, []);
  function connectMembers(source: string, target: string) {
    const current = definitionRef.current;
    const next = connectTeamMembers(
      current,
      source,
      target,
      relationship,
      bothWays,
    );
    setConnectionFilter(relationship);
    if (next === current)
      setMessage(
        "That relationship already exists or would create invalid leadership.",
      );
    else changed(next);
  }

  function accepted(value: TeamDetail) {
    setBase(value);
    setVersion(value.draft.version);
    setDefinition(value.draft.definition);
    definitionRef.current = value.draft.definition;
    history.current = { past: [], future: [], lastAt: 0, movement: false };
    setHistoryVersion((current) => current + 1);
    setError(null);
    refresh();
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  function addStage(
    kind: TeamNode["kind"],
    memberId: string | null = null,
    current: TeamDefinition = definition,
    position?: { x: number; y: number },
  ) {
    if (current.graph.nodes.length >= MAX_TEAM_NODES) {
      setError(`A team can contain up to ${MAX_TEAM_NODES} stages.`);
      return;
    }
    const node = newStage(kind, memberId ?? current.members[0]?.id ?? null);
    const index = current.graph.nodes.length;
    changed({
      ...current,
      graph: {
        ...current.graph,
        nodes: [...current.graph.nodes, node],
        entryNodeIds: index === 0 ? [node.id] : current.graph.entryNodeIds,
      },
      presentation: {
        ...current.presentation,
        nodes: [
          ...current.presentation.nodes,
          {
            nodeId: node.id,
            x: position?.x ?? (index % 4) * 260,
            y: position?.y ?? Math.floor(index / 4) * 180,
          },
        ],
      },
    });
    setSelection({ kind: "node", id: node.id });
    setCompactPane("inspector");
  }
  async function addAgent(
    agent: AgentSummary,
    position?: { x: number; y: number },
  ) {
    if (agent.currentRevision === null || busy) return;
    if (definitionRef.current.members.length >= 100) {
      setError("A team can contain up to 100 members.");
      return;
    }
    let selected = agent;
    if (paletteScope.kind === "library" && team.scope.kind === "project") {
      setBusy(true);
      setError(null);
      try {
        selected = (
          await rpc.call("copyAgentToProject", {
            scope: paletteScope,
            agentId: agent.id,
            revision: agent.currentRevision,
            projectId: team.scope.projectId,
          })
        ).agent;
      } catch (failure) {
        setError(errorMessage(failure));
        return;
      } finally {
        setBusy(false);
      }
    }
    if (selected.currentRevision === null) return;
    const current = definitionRef.current;
    const id = `member_${crypto.randomUUID()}`;
    let next: TeamDefinition = {
      ...current,
      schemaVersion: 2,
      members: [
        ...current.members,
        {
          id,
          agentId: selected.id,
          revision: selected.currentRevision,
          groupId: null,
          role: "",
          responsibility: "",
          leaderMemberId: null,
          skills: [],
        },
      ],
      presentation: {
        ...current.presentation,
        members: [
          ...(current.presentation.members ?? []),
          {
            memberId: id,
            x: position?.x ?? (current.members.length % 3) * 320,
            y: position?.y ?? Math.floor(current.members.length / 3) * 240,
          },
        ],
      },
    };
    if (addingUnder !== null) next = addSubagentGrants(next, addingUnder, id);
    setAddingUnder(null);
    if (tab === "Workflow") addStage("agent", id, next, position);
    else {
      changed(next);
      setSelection({ kind: "member", id });
      setCompactPane("inspector");
    }
  }
  function removeStage(nodeId: string) {
    changed({
      ...definition,
      graph: {
        ...definition.graph,
        nodes: definition.graph.nodes.filter((node) => node.id !== nodeId),
        edges: definition.graph.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        ),
        entryNodeIds: definition.graph.entryNodeIds.filter(
          (id) => id !== nodeId,
        ),
        requiredGates: definition.graph.requiredGates
          .map((gate) => ({
            ...gate,
            nodeIds: gate.nodeIds.filter((id) => id !== nodeId),
          }))
          .filter((gate) => gate.nodeIds.length > 0),
      },
      presentation: {
        ...definition.presentation,
        nodes: definition.presentation.nodes.filter(
          (item) => item.nodeId !== nodeId,
        ),
      },
    });
    setSelection(null);
    setCompactPane("canvas");
  }
  function travel(direction: "undo" | "redo") {
    const source =
      direction === "undo" ? history.current.past : history.current.future;
    const value = source.pop();
    if (!value) return;
    const destination =
      direction === "undo" ? history.current.future : history.current.past;
    destination.push(definitionRef.current);
    history.current.movement = false;
    definitionRef.current = value;
    setDefinition(value);
    setHistoryVersion((current) => current + 1);
    setSelection(null);
    setMessage(direction === "undo" ? "Change undone." : "Change restored.");
  }
  function removeSelection() {
    if (selectedMember)
      changed(removeTeamMember(definition, selectedMember.id));
    else if (selectedGrant)
      changed({
        ...definition,
        permissions: definition.permissions.filter(
          (grant) => grant.id !== selectedGrant.id,
        ),
      });
    else if (selectedHierarchy)
      changed({
        ...definition,
        members: definition.members.map((member) =>
          member.id === selectedHierarchy.id
            ? { ...member, leaderMemberId: null }
            : member,
        ),
      });
    else if (selectedNode) {
      removeStage(selectedNode.id);
      return;
    } else if (selectedEdge)
      changed({
        ...definition,
        graph: {
          ...definition.graph,
          edges: definition.graph.edges.filter(
            (edge) => edge.id !== selectedEdge.id,
          ),
        },
      });
    setSelection(null);
  }
  function dropAgent(agentId: string, position: { x: number; y: number }) {
    const agent = palette.data?.agents.find((item) => item.id === agentId);
    if (agent) void addAgent(agent, position);
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.closest("input, textarea, select") ||
            target.isContentEditable)
        )
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          travel(event.shiftKey ? "redo" : "undo");
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "y"
        ) {
          event.preventDefault();
          travel("redo");
        } else if (
          (event.key === "Delete" || event.key === "Backspace") &&
          selection
        ) {
          event.preventDefault();
          removeSelection();
        }
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2">
            {definition.presentation.color === undefined ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  changed({
                    ...definition,
                    presentation: {
                      ...definition.presentation,
                      color: "#3b82f6",
                    },
                  })
                }
              >
                Set color
              </Button>
            ) : (
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="color"
                  aria-label="Team color"
                  title="Team color"
                  className="h-8 w-8 cursor-pointer rounded border bg-background"
                  value={definition.presentation.color}
                  onChange={(event) =>
                    changed({
                      ...definition,
                      presentation: {
                        ...definition.presentation,
                        color: event.target.value,
                      },
                    })
                  }
                />
                Color
              </label>
            )}
            <Input
              aria-label="Team name"
              placeholder="Name your team"
              maxLength={100}
              className="h-8 min-w-0 max-w-72 font-medium"
              value={definition.name}
              onChange={(event) =>
                changed({ ...definition, name: event.target.value })
              }
            />
            {definition.presentation.color && (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Reset team color"
                onClick={() => {
                  const { color: _color, ...presentation } =
                    definition.presentation;
                  changed({ ...definition, presentation });
                }}
              >
                Reset color
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {base.currentRevision === null
              ? "Unpublished"
              : `Version ${base.currentRevision}`}{" "}
            · draft {version} · {dirty ? "Unsaved edits" : "Saved"}
            {base.archivedAt !== null ? " · Archived" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={history.current.past.length === 0}
            onClick={() => travel("undo")}
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={history.current.future.length === 0}
            onClick={() => travel("redo")}
          >
            Redo
          </Button>
          {base.scope.kind === "project" && base.currentRevision !== null && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || dirty || conflict || base.archivedAt !== null}
              onClick={() => {
                if (
                  base.scope.kind !== "project" ||
                  base.currentRevision === null
                )
                  return;
                navigate.toPluginPanel("runs", {
                  subPath: `new/${base.scope.projectId}/${base.id}/${base.currentRevision}`,
                });
              }}
            >
              Run version {base.currentRevision}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                !panel.openFixedTab({
                  surface: { kind: "current" },
                  tab: { panelId: "teams", id: "assistant" },
                })
              )
                setError("Open the Team assistant from the side panel tabs.");
            }}
          >
            Ask assistant
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !dirty || conflict || base.archivedAt !== null}
            onClick={() =>
              void run(async () => {
                const result = await rpc.call("saveTeamDraft", {
                  ...target,
                  expectedDraftVersion: version,
                  definition,
                });
                accepted(result.team);
                setMessage("Draft saved.");
              })
            }
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={
              busy ||
              dirty ||
              conflict ||
              !base.validation.valid ||
              base.archivedAt !== null ||
              (!base.hasUnpublishedChanges && base.currentRevision !== null)
            }
            onClick={() =>
              void run(async () => {
                const result = await rpc.call("publishTeamRevision", {
                  ...target,
                  expectedDraftVersion: version,
                });
                accepted(result.team);
                setMessage(`Published version ${result.team.currentRevision}.`);
              })
            }
          >
            Publish version
          </Button>
        </div>
      </div>
      {(error || remoteError || conflict) && (
        <div
          role="alert"
          className="shrink-0 border-b px-4 py-2 text-xs text-destructive-text"
        >
          {error ??
            remoteError ??
            "This team changed elsewhere. Your local edits are kept; save their Definition text before discarding or reapplying them."}
          {conflict && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                accepted(team);
                setMessage("Loaded the latest saved draft.");
              }}
            >
              Discard local edits and load latest
            </Button>
          )}
        </div>
      )}
      {message && (
        <p
          role="status"
          className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {message}
        </p>
      )}
      <nav
        aria-label="Team builder views"
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5"
      >
        {tabs.map((item) => (
          <Button
            key={item}
            variant={tab === item ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {item}
          </Button>
        ))}
      </nav>
      {(tab === "Team" || tab === "Workflow") && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              className="@[1100px]/teams:hidden"
              onClick={() =>
                setCompactPane(compactPane === "library" ? "canvas" : "library")
              }
            >
              {compactPane === "library" ? "Back to canvas" : "Agent library"}
            </Button>
            {tab === "Workflow" ? (
              <>
                <select
                  aria-label="Stage type"
                  className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs"
                  value={stageKind}
                  onChange={(event) => {
                    const kind = Object.keys(stageLabels).find(
                      (key) => key === event.target.value,
                    );
                    if (kind && kind in stageLabels)
                      setStageKind(newStageFromLabel(kind));
                  }}
                >
                  {Object.entries(stageLabels).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addStage(stageKind)}
                >
                  Add stage
                </Button>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Show
                  <select
                    aria-label="Visible connections"
                    className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs text-foreground"
                    value={connectionFilter}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === "reports-to" ||
                        value === "message" ||
                        value === "delegate" ||
                        value === "review" ||
                        value === "all"
                      )
                        setConnectionFilter(value);
                    }}
                  >
                    {Object.entries(connectionFilterLabels).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Draw
                  <select
                    aria-label="Relationship type"
                    className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs"
                    value={relationship}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (
                        value === "message" ||
                        value === "delegate" ||
                        value === "review" ||
                        value === "reports-to"
                      )
                        setRelationship(value);
                    }}
                  >
                    {Object.entries(relationshipLabels).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {relationship === "message" && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={bothWays}
                      onChange={(event) => setBothWays(event.target.checked)}
                    />
                    Both ways
                  </label>
                )}
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!selection}
              onClick={() => {
                if (selection?.kind === "group") setTab("People & groups");
                else setCompactPane("inspector");
              }}
            >
              Edit selected
            </Button>
            {compactPane === "inspector" && (
              <Button
                variant="ghost"
                size="sm"
                className="@[1100px]/teams:hidden"
                onClick={() => setCompactPane("canvas")}
              >
                Back to canvas
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {definition.graph.nodes.length} stages ·{" "}
              {definition.members.length} members
            </span>
          </div>
          {addingUnder !== null && (
            <div
              role="status"
              className="flex items-center gap-2 border-b px-3 py-2 text-xs"
            >
              Choose a subagent for{" "}
              {names.get(addingUnder)?.name ?? addingUnder}. Adds delegation and
              messaging in both directions.
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAddingUnder(null)}
              >
                Cancel
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <aside
              aria-label="Published agent palette"
              className={`${compactPane === "library" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col border-r @[1100px]/teams:flex @[1100px]/teams:w-52 @[1100px]/teams:flex-none`}
            >
              <div className="space-y-2 border-b p-3">
                <h3 className="text-xs font-medium">Agent library</h3>
                {team.scope.kind === "project" && (
                  <Field label="Agents from">
                    <select
                      aria-label="Agent palette source"
                      className={selectClass}
                      value={paletteSource}
                      disabled={busy}
                      onChange={(event) => {
                        setPaletteSource(
                          event.target.value === "library"
                            ? "library"
                            : "project",
                        );
                        setPaletteOffset(0);
                      }}
                    >
                      <option value="project">This project</option>
                      <option value="library">Reusable library</option>
                    </select>
                  </Field>
                )}
                {team.scope.kind === "project" &&
                  paletteSource === "library" && (
                    <p className="text-xs text-muted-foreground">
                      Drag an agent to create an editable project copy with its
                      published skills.
                    </p>
                  )}
                <Input
                  aria-label="Find an agent for this team"
                  placeholder="Find an agent…"
                  value={paletteSearch}
                  onChange={(event) => {
                    setPaletteSearch(event.target.value);
                    setPaletteOffset(0);
                  }}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {palette.error && (
                  <p role="alert" className="p-2 text-xs text-destructive-text">
                    {palette.error}
                    <Button size="sm" variant="ghost" onClick={palette.refresh}>
                      Retry
                    </Button>
                  </p>
                )}
                {!palette.data && !palette.error && (
                  <p
                    role="status"
                    className="p-2 text-xs text-muted-foreground"
                  >
                    Loading agents…
                  </p>
                )}
                {palette.data?.agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="mb-1 flex w-full items-start gap-2 rounded-md p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={agent.currentRevision === null || busy}
                    draggable={agent.currentRevision !== null && !busy}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(AGENT_DRAG_TYPE, agent.id);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => void addAgent(agent)}
                    title={
                      agent.currentRevision === null
                        ? "Publish this agent in Agent Studio first"
                        : tab === "Team"
                          ? "Drag onto the canvas or click to add this agent"
                          : "Drag onto the canvas or click to add a task"
                    }
                  >
                    <Icon
                      name="Bot"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm">{agent.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {agent.currentRevision === null
                          ? "Publish to use"
                          : `v${agent.currentRevision} · ${agent.role || "Custom role"}`}
                      </p>
                    </div>
                  </button>
                ))}
                {palette.data?.total === 0 && (
                  <p className="p-2 text-xs leading-relaxed text-muted-foreground">
                    Create and publish an agent in this library or project to
                    add it here.
                  </p>
                )}
                {palette.data && palette.data.total > 50 && (
                  <div className="flex justify-between pt-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={paletteOffset === 0}
                      onClick={() =>
                        setPaletteOffset(Math.max(0, paletteOffset - 50))
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={paletteOffset + 50 >= palette.data.total}
                      onClick={() => setPaletteOffset(paletteOffset + 50)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
            </aside>
            <main
              aria-label={tab === "Team" ? "Team structure" : "Team graph"}
              className={`${compactPane === "canvas" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col @[1100px]/teams:flex`}
            >
              <div className="relative min-h-0 flex-1">
                {tab === "Team" ? (
                  <OrganizationCanvas
                    definition={definition}
                    names={names}
                    selection={selection}
                    relationship={relationship}
                    connectionFilter={connectionFilter}
                    onConnectMembers={connectMembers}
                    onChange={changed}
                    onSelect={select}
                    onDropAgent={dropAgent}
                    onEditModel={editMemberModel}
                  />
                ) : (
                  <TeamCanvas
                    definition={definition}
                    members={names}
                    selection={selection}
                    onSelect={select}
                    onChange={changed}
                    onDropAgent={dropAgent}
                    onEditModel={editMemberModel}
                  />
                )}
                {(tab === "Team"
                  ? definition.members.length
                  : definition.graph.nodes.length) === 0 && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                    <div className="max-w-sm text-center">
                      <h3 className="text-base font-medium">
                        {tab === "Team"
                          ? "Build your agent team"
                          : "Build your team’s workflow"}
                      </h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {tab === "Team"
                          ? "Drag agents from the library, choose their responsibilities, then connect who can communicate and delegate."
                          : "Add an agent or stage, then connect the handles. Use the inspector to set assignments and required checks."}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {tab === "Team" ? (
                <details className="shrink-0 border-t px-3 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Connect agents with the keyboard
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <select
                      aria-label="Relationship source"
                      className="h-8 max-w-48 rounded border bg-background px-2 text-xs"
                      value={connectSource}
                      onChange={(event) => setConnectSource(event.target.value)}
                    >
                      <option value="">From member</option>
                      {definition.members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {names.get(member.id)?.name ?? member.id}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Relationship target"
                      className="h-8 max-w-48 rounded border bg-background px-2 text-xs"
                      value={connectTarget}
                      onChange={(event) => setConnectTarget(event.target.value)}
                    >
                      <option value="">To member</option>
                      {definition.members
                        .filter((member) => member.id !== connectSource)
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {names.get(member.id)?.name ?? member.id}
                          </option>
                        ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !connectSource ||
                        !connectTarget ||
                        connectSource === connectTarget
                      }
                      onClick={() =>
                        connectMembers(connectSource, connectTarget)
                      }
                    >
                      Connect agents
                    </Button>
                  </div>
                </details>
              ) : (
                <details className="shrink-0 border-t px-3 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Connect stages with the keyboard
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <select
                      aria-label="Connection source"
                      className="h-8 max-w-48 rounded border bg-background px-2 text-xs"
                      value={connectSource}
                      onChange={(event) => setConnectSource(event.target.value)}
                    >
                      <option value="">From stage</option>
                      {definition.graph.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Connection target"
                      className="h-8 max-w-48 rounded border bg-background px-2 text-xs"
                      value={connectTarget}
                      onChange={(event) => setConnectTarget(event.target.value)}
                    >
                      <option value="">To stage</option>
                      {definition.graph.nodes
                        .filter((node) => node.id !== connectSource)
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.label}
                          </option>
                        ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !connectSource ||
                        !connectTarget ||
                        connectSource === connectTarget
                      }
                      onClick={() => {
                        const source = definition.graph.nodes.find(
                          (node) => node.id === connectSource,
                        );
                        const edge = {
                          id: `edge_${crypto.randomUUID()}`,
                          source: connectSource,
                          target: connectTarget,
                          sourceHandle:
                            source?.kind === "condition"
                              ? ("true" as const)
                              : source?.kind === "repair"
                                ? ("repaired" as const)
                                : ("next" as const),
                          requiredOutcome: "succeeded" as const,
                        };
                        changed({
                          ...definition,
                          graph: {
                            ...definition.graph,
                            edges: [...definition.graph.edges, edge],
                          },
                        });
                        setSelection({ kind: "edge", id: edge.id });
                        setCompactPane("inspector");
                      }}
                    >
                      Connect
                    </Button>
                  </div>
                </details>
              )}
            </main>
            <aside
              aria-label={
                tab === "Team" ? "Member inspector" : "Stage inspector"
              }
              className={`${compactPane === "inspector" ? "block" : "hidden"} min-h-0 min-w-0 flex-1 overflow-y-auto border-l @[1100px]/teams:block @[1100px]/teams:w-72 @[1100px]/teams:flex-none`}
            >
              {tab === "Team" && selectedMember ? (
                <TeamMemberInspector
                  member={selectedMember}
                  definition={definition}
                  names={names}
                  inheritedSkills={[
                    ...(memberQuery.data?.get(selectedMember.id)?.skills ?? []),
                  ]}
                  inheritedRole={
                    memberQuery.data?.get(selectedMember.id)?.role ?? ""
                  }
                  inheritedExecution={
                    memberQuery.data?.get(selectedMember.id)?.execution ?? null
                  }
                  editingModel={editingModelMemberId === selectedMember.id}
                  onEditModel={(editing) =>
                    setEditingModelMemberId(editing ? selectedMember.id : null)
                  }
                  projectId={
                    team.scope.kind === "project" ? team.scope.projectId : null
                  }
                  onChange={changed}
                  onAskSkillAssistant={(prompt) => {
                    void run(async () => {
                      if (conflict || base.archivedAt !== null)
                        throw new Error(
                          "Resolve the draft conflict or restore this team before building a skill.",
                        );
                      if (dirty) {
                        const saved = await rpc.call("saveTeamDraft", {
                          ...target,
                          expectedDraftVersion: version,
                          definition,
                        });
                        accepted(saved.team);
                      }
                      queueAssistantDraft(
                        `arc.teamAssistantPrompt.${team.id}`,
                        `For team member ${selectedMember.id}, propose a team-specific skill addition in this member's skills field. Preserve the reusable agent defaults and all other team fields.\n\n${prompt}`,
                      );
                      if (
                        !panel.openFixedTab({
                          surface: { kind: "current" },
                          tab: { panelId: "teams", id: "assistant" },
                        })
                      )
                        setError(
                          "Open the Team assistant from the side panel tabs.",
                        );
                    });
                  }}
                  onDelete={removeSelection}
                  onAddSubagent={() => {
                    setAddingUnder(selectedMember.id);
                    setCompactPane("library");
                  }}
                  onAddTask={() => {
                    setTab("Workflow");
                    addStage("agent", selectedMember.id);
                  }}
                  onOpenAgent={() =>
                    navigate.toPluginPanel("agents", {
                      subPath: studioPath(team.scope, selectedMember.agentId),
                    })
                  }
                  onOpenStage={(id) => {
                    setTab("Workflow");
                    setSelection({ kind: "node", id });
                    setCompactPane("inspector");
                  }}
                />
              ) : tab === "Team" && (selectedGrant || selectedHierarchy) ? (
                <div className="space-y-3 p-4">
                  <h3 className="text-sm font-medium">
                    {selectedGrant
                      ? relationshipLabels[selectedGrant.action]
                      : "Leadership"}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedGrant
                      ? `${names.get(selectedGrant.fromMemberId)?.name ?? selectedGrant.fromMemberId} → ${names.get(selectedGrant.toMemberId)?.name ?? selectedGrant.toMemberId}`
                      : `${names.get(selectedHierarchy?.id ?? "")?.name ?? "Member"} reports to ${names.get(selectedHierarchy?.leaderMemberId ?? "")?.name ?? "leader"}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedGrant?.action === "message"
                      ? "Messages share information. They do not assign new work or expand permissions."
                      : "This relationship is independent of workflow order."}
                  </p>
                  <Button size="sm" variant="outline" onClick={removeSelection}>
                    Remove relationship
                  </Button>
                </div>
              ) : tab === "Workflow" && selectedNode ? (
                <StageInspector
                  node={selectedNode}
                  definition={definition}
                  names={names}
                  onChange={(node) =>
                    changed({
                      ...definition,
                      graph: {
                        ...definition.graph,
                        nodes: definition.graph.nodes.map((item) =>
                          item.id === node.id ? node : item,
                        ),
                      },
                    })
                  }
                  onDefinitionChange={changed}
                  onDelete={() => removeStage(selectedNode.id)}
                />
              ) : tab === "Workflow" && selectedEdge ? (
                <EdgeInspector
                  edge={selectedEdge}
                  definition={definition}
                  onChange={(edge) =>
                    changed({
                      ...definition,
                      graph: {
                        ...definition.graph,
                        edges: definition.graph.edges.map((item) =>
                          item.id === edge.id ? edge : item,
                        ),
                      },
                    })
                  }
                  onDelete={() => {
                    changed({
                      ...definition,
                      graph: {
                        ...definition.graph,
                        edges: definition.graph.edges.filter(
                          (item) => item.id !== selectedEdge.id,
                        ),
                      },
                    });
                    setSelection(null);
                    setCompactPane("canvas");
                  }}
                />
              ) : (
                <p className="p-4 text-sm leading-relaxed text-muted-foreground">
                  {tab === "Team"
                    ? "Select an agent to edit its role, responsibilities, leader and skills. Select a connection to inspect its permission."
                    : "Select a stage or connection to edit it. Group names, colors and permissions live in People & groups."}
                </p>
              )}
            </aside>
          </div>
          <details className="shrink-0 border-t px-4 py-2">
            <summary className="cursor-pointer text-xs">
              {dirty
                ? "Save to validate current edits"
                : base.validation.valid
                  ? "Structure valid"
                  : `${base.validation.diagnostics.length} items need attention`}{" "}
              ·{" "}
              {base.validation.execution.available
                ? "Runtime supported"
                : "Execution availability"}
            </summary>
            <div className="max-h-48 space-y-2 overflow-y-auto py-3">
              {base.validation.execution.available && (
                <p className="text-xs text-muted-foreground">
                  Run a published project version to review its source, policy
                  and candidate checks before admission.
                </p>
              )}
              {base.validation.diagnostics.map((item, index) => (
                <button
                  type="button"
                  key={`${item.code}:${index}`}
                  className="block text-left text-xs text-destructive-text underline-offset-2 hover:underline"
                  onClick={() => {
                    const id = item.nodeIds[0];
                    if (id) select({ kind: "node", id });
                  }}
                >
                  {item.message}
                </button>
              ))}
              {base.validation.execution.blockers.map((item, index) => (
                <p
                  key={`${item.code}:${index}`}
                  className="text-xs text-muted-foreground"
                >
                  {item.message}
                </p>
              ))}
              {memberQuery.data &&
                [...memberQuery.data.values()].flatMap((member, index) =>
                  member.error
                    ? [
                        <p
                          key={index}
                          className="text-xs text-destructive-text"
                        >
                          {member.error}
                        </p>,
                      ]
                    : [],
                )}
            </div>
          </details>
        </div>
      )}
      {tab === "People & groups" && (
        <TeamPeople definition={definition} names={names} onChange={changed} />
      )}
      {tab === "History" && (
        <TeamHistory
          target={target}
          version={version}
          dirty={dirty || conflict}
          onUpdated={accepted}
        />
      )}
      {tab === "Suggestions" && (
        <TeamSuggestions
          target={target}
          version={version}
          dirty={dirty || conflict}
          onUpdated={accepted}
        />
      )}
      {tab === "Definition" && (
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div className="grid gap-4 @[800px]/teams:grid-cols-2">
            <Field label="Description">
              <Textarea
                aria-label="Team description"
                rows={2}
                value={definition.description}
                maxLength={2000}
                onChange={(event) =>
                  changed({ ...definition, description: event.target.value })
                }
              />
            </Field>
          </div>
          <TeamRequirements definition={definition} onChange={changed} />
          <details>
            <summary className="cursor-pointer text-sm">
              Canonical definition · advanced
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Edit the same definition used by the graph and SDK. Applying
                JSON changes the local draft; save when ready.
              </p>
              <Textarea
                aria-label="Canonical team JSON"
                className="min-h-80 font-mono text-xs"
                spellCheck={false}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  try {
                    changed(teamDefinitionSchema.parse(JSON.parse(raw)));
                    setError(null);
                    setMessage("JSON applied to local draft.");
                  } catch (failure) {
                    setError(errorMessage(failure));
                  }
                }}
              >
                Apply JSON to draft
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRaw(JSON.stringify(definition, null, 2))}
              >
                Refresh JSON from graph
              </Button>
            </div>
          </details>
          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <Field label="Copy published version to project">
              <select
                aria-label="Copy team destination"
                className={selectClass}
                value={copyProject}
                onChange={(event) => setCopyProject(event.target.value)}
              >
                <option value="">Choose a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !copyProject || base.currentRevision === null}
              onClick={() =>
                void run(async () => {
                  if (base.currentRevision === null) return;
                  const result = await rpc.call("copyTeamToProject", {
                    ...target,
                    revision: base.currentRevision,
                    projectId: copyProject,
                  });
                  onOpen(result.team.scope, result.team.id);
                })
              }
            >
              Copy team and agents
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || dirty || conflict}
              onClick={() =>
                void run(async () => {
                  const result = await rpc.call("setTeamArchived", {
                    ...target,
                    expectedDraftVersion: version,
                    archived: base.archivedAt === null,
                  });
                  accepted(result.team);
                })
              }
            >
              {base.archivedAt === null
                ? "Archive team"
                : "Restore archived team"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty && !conflict}
              onClick={() => {
                accepted(team);
                setMessage("Local edits discarded.");
              }}
            >
              Discard local edits
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function newStageFromLabel(value: string): TeamNode["kind"] {
  switch (value) {
    case "parallel":
    case "join":
    case "check":
    case "review":
    case "condition":
    case "repair":
    case "approval":
    case "integration":
    case "release":
    case "delegation":
      return value;
    default:
      return "agent";
  }
}

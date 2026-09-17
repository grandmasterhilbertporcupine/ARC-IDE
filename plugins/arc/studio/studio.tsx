import { useDeferredValue, useState } from "react";
import {
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { AgentScope } from "../contract.js";
import { AgentEditor } from "./editor.js";
import {
  errorMessage,
  parseStudioRoute,
  studioPath,
  useStudioQuery,
  useStudioRpc,
} from "./data.js";

const starterRoles = [
  {
    name: "Custom agent",
    role: "",
    body: "Describe what this agent should help with, how it should work, and how it should check its results.",
  },
  {
    name: "Frontend builder",
    role: "Frontend",
    body: "Build clear, accessible interfaces using the project's existing components and design system. Understand the requested behavior before editing. Check the rendered result, keyboard interactions, loading and error states. Report the files changed and the verification you actually performed.",
  },
  {
    name: "Backend builder",
    role: "Backend",
    body: "Implement reliable application behavior using the project's existing architecture. Validate input at boundaries and preserve data and authorization rules. Add meaningful tests for changed behavior. Report implementation decisions, actual checks, and unresolved issues.",
  },
  {
    name: "Test engineer",
    role: "Testing",
    body: "Verify the requested user workflow using the project's real test tools. Reproduce failures, identify their cause, and provide actionable evidence. Never claim a test passed without its result. Do not remove or weaken required checks to make a build pass.",
  },
  {
    name: "Code reviewer",
    role: "Review",
    body: "Review the proposed changes against the task's acceptance criteria and surrounding implementation. Prioritize concrete bugs, regressions, data safety and missing verification. Cite the relevant files and explain the practical impact. Distinguish confirmed findings from questions.",
  },
];

export function AgentStudio({ subPath }: PluginNavPanelProps) {
  const route = parseStudioRoute(subPath);
  const scopeKey = JSON.stringify(route.scope);
  const rpc = useStudioRpc();
  const navigate = useBbNavigate();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [offset, setOffset] = useState(0);
  const [roleIndex, setRoleIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const projects = useStudioQuery("studio-projects", (client) =>
    client.call("listStudioProjects", null),
  );
  const list = useStudioQuery(
    `agents:${scopeKey}:${deferredSearch}:${offset}:${showArchived}`,
    (client) =>
      client.call("listAgents", {
        scope: route.scope,
        search: deferredSearch,
        offset,
        limit: 50,
        includeArchived: showArchived,
      }),
  );

  function go(scope: AgentScope, agentId: string | null = null) {
    setLibraryOpen(false);
    navigate.toPluginPanel("agents", { subPath: studioPath(scope, agentId) });
  }

  async function createAgent() {
    setBusy(true);
    setError(null);
    try {
      const starter = starterRoles[roleIndex] ?? starterRoles[0];
      const metadata = {
        ...defaultAgentMetadata(starter.name),
        role: starter.role,
        specialty: starter.role,
      };
      const result = await rpc.call("createAgent", {
        scope: route.scope,
        document: serializeAgentDocument(metadata, starter.body),
      });
      list.refresh();
      go(route.scope, result.agent.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="@container/studio flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-arc-agent-studio
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          {route.agentId && (
            <Button
              size="sm"
              variant="ghost"
              className="mb-1 -ml-2 @[760px]/studio:hidden"
              aria-expanded={libraryOpen}
              aria-controls="arc-agent-library"
              onClick={() => setLibraryOpen((value) => !value)}
            >
              <Icon name="ChevronLeft" className="size-3.5" />
              {libraryOpen ? "Back to editor" : "Agent library"}
            </Button>
          )}
          <h1 className="text-base font-medium">Agent Studio</h1>
          <p className="text-xs text-muted-foreground">
            Give your agents a role, instructions and shared references.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Save in
          <select
            aria-label="Agent library or project"
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
      </div>
      {projects.error && (
        <p
          role="alert"
          className="border-b px-4 py-2 text-xs text-destructive-text"
        >
          Projects could not load: {projects.error}{" "}
          <button
            type="button"
            className="underline"
            onClick={projects.refresh}
          >
            Retry
          </button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col @[760px]/studio:flex-row">
        <aside
          id="arc-agent-library"
          aria-label="Agent library"
          className={`${route.agentId && !libraryOpen ? "hidden" : "flex"} min-h-0 flex-1 flex-col border-b @[760px]/studio:flex @[760px]/studio:w-56 @[760px]/studio:flex-none @[760px]/studio:border-r @[760px]/studio:border-b-0`}
        >
          <div className="space-y-2 p-3">
            <Input
              aria-label="Search agents"
              placeholder="Find an agent…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => {
                  setShowArchived(event.target.checked);
                  setOffset(0);
                }}
              />
              Include archived
            </label>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-2"
            aria-busy={list.loading}
          >
            {list.error && (
              <p role="alert" className="p-2 text-xs text-destructive-text">
                {list.error}{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={list.refresh}
                >
                  Retry
                </button>
              </p>
            )}
            {!list.data && list.loading && (
              <p role="status" className="p-2 text-xs text-muted-foreground">
                Loading agents…
              </p>
            )}
            {list.data?.agents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                aria-current={route.agentId === agent.id ? "page" : undefined}
                onClick={() => go(route.scope, agent.id)}
                className={`mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${route.agentId === agent.id ? "bg-state-active" : ""}`}
              >
                <Icon
                  name="Bot"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {agent.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {agent.archivedAt !== null
                      ? "Archived"
                      : agent.role || "Custom role"}{" "}
                    ·{" "}
                    {agent.currentRevision === null
                      ? "Draft"
                      : `v${agent.currentRevision}`}
                    {agent.hasUnpublishedChanges &&
                    agent.currentRevision !== null
                      ? " · Edited"
                      : ""}
                  </span>
                </span>
              </button>
            ))}
            {list.data?.total === 0 && (
              <p className="p-2 text-xs leading-relaxed text-muted-foreground">
                {search
                  ? "No agents match this search."
                  : "Create your first agent below. Start with a role or describe your own."}
              </p>
            )}
          </div>
          {(list.data?.total ?? 0) > 50 && (
            <div className="flex items-center justify-between px-3 py-2 text-xs">
              <Button
                variant="ghost"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + 50, list.data?.total ?? 0)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + 50 >= (list.data?.total ?? 0)}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </Button>
            </div>
          )}
          <div className="space-y-2 border-t p-3">
            <select
              aria-label="Starter role"
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              value={roleIndex}
              onChange={(event) => setRoleIndex(Number(event.target.value))}
            >
              {starterRoles.map((role, index) => (
                <option key={role.name} value={index}>
                  {role.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              className="w-full"
              disabled={busy}
              onClick={() => void createAgent()}
            >
              <Icon name="Plus" className="size-4" />
              {busy ? "Creating…" : "Create agent"}
            </Button>
            {error && (
              <p role="alert" className="text-xs text-destructive-text">
                {error}
              </p>
            )}
          </div>
        </aside>
        <main
          className={`${libraryOpen || !route.agentId ? "hidden @[760px]/studio:block" : "block"} min-h-0 min-w-0 flex-1`}
        >
          {route.agentId ? (
            <AgentEditor
              key={`${scopeKey}:${route.agentId}`}
              agentId={route.agentId}
              scope={route.scope}
              projects={projects.data?.projects ?? []}
              onRefresh={list.refresh}
              onOpen={(agentId, scope) => go(scope, agentId)}
            />
          ) : (
            <div className="flex h-full flex-col justify-center gap-3 p-6 md:p-10">
              <Icon name="Bot" className="size-7 text-muted-foreground" />
              <h2 className="text-base font-medium">
                Build an agent you can work with.
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                Choose a role, explain what good work looks like, and add the
                reference files it should use. Save a version before testing it
                or copying it into a project.
              </p>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Your personal library is reusable. Each project keeps its own
                version, so changing one project’s agent leaves the others as
                they were.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

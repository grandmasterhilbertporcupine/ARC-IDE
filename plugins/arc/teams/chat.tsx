import { useEffect, useState } from "react";
import { ThreadChat, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Textarea } from "@bb/shared-ui/textarea";
import type { AgentScope } from "../contract.js";
import { errorMessage, useStudioQuery } from "../studio/data.js";
import { useAssistantDraft } from "../studio/assistant-draft.js";
import { selectClass } from "./inspector.js";
import { teamRoute, useTeamQuery, useTeamRpc } from "./ui-data.js";

export const teamAssistantTab = { panelId: "teams", id: "assistant" } as const;

export function TeamAssistantPanel({ subPath }: PluginNavPanelProps) {
  const route = teamRoute(subPath);
  if (!route.teamId)
    return (
      <p className="p-4 text-sm leading-relaxed text-muted-foreground">
        Select or create a team to plan its members, assignments, checks and
        collaboration with the assistant.
      </p>
    );
  return (
    <TeamChat
      key={`${JSON.stringify(route.scope)}:${route.teamId}`}
      teamId={route.teamId}
      scope={route.scope}
    />
  );
}

function TeamChat({ teamId, scope }: { teamId: string; scope: AgentScope }) {
  const rpc = useTeamRpc();
  const query = useTeamQuery(`team-chat:${teamId}`, (client) =>
    client.call("getTeam", { teamId, scope }),
  );
  const projects = useStudioQuery("team-chat-projects", (client) =>
    client.call("listStudioProjects", null),
  );
  const sessions = useTeamQuery(`team-sessions:${teamId}`, (client) =>
    client.call("listTeamSessions", { teamId, scope, limit: 100, offset: 0 }),
  );
  const [projectId, setProjectId] = useState(
    scope.kind === "project" ? scope.projectId : "",
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptKey = `arc.teamAssistantPrompt.${teamId}`;
  const [prompt, setPrompt] = useState(() => {
    try {
      return localStorage.getItem(promptKey) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(promptKey, prompt);
    } catch {}
  }, [promptKey, prompt]);
  useAssistantDraft(promptKey, setPrompt, setCompose);
  const available =
    sessions.data?.sessions.filter((session) => session.threadId !== null) ??
    [];
  const selectedId = threadId ?? available[0]?.threadId ?? null;
  const selected = available.find((session) => session.threadId === selectedId);
  const team = query.data?.team;
  const targetProject = projectId || projects.data?.personalProjectId || "";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">Build this team</h2>
            <p className="truncate text-xs text-muted-foreground">
              {team?.name ?? "Loading team…"}
              {selected && !compose ? ` · draft ${selected.draftVersion}` : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setCompose(true);
              setError(null);
            }}
          >
            New chat
          </Button>
        </div>
        {available.length > 0 && (
          <select
            aria-label="Team assistant conversation"
            className={selectClass}
            value={selectedId ?? ""}
            onChange={(event) => {
              setThreadId(event.target.value);
              setCompose(false);
            }}
          >
            {available.map((session) => (
              <option
                key={session.executionContextId}
                value={session.threadId ?? ""}
              >
                Draft {session.draftVersion} ·{" "}
                {new Date(session.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
        {(error || query.error || sessions.error || projects.error) && (
          <p role="alert" className="text-xs text-destructive-text">
            {error ?? query.error ?? sessions.error ?? projects.error}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                query.refresh();
                sessions.refresh();
                projects.refresh();
              }}
            >
              Retry
            </Button>
          </p>
        )}
      </header>
      {selectedId && !compose ? (
        <ThreadChat
          threadId={selectedId}
          variant="compact"
          layout="contained"
          permissionPolicy="inherit"
          className="min-h-0 flex-1"
        />
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!team || !targetProject || !prompt.trim()) return;
            setBusy(true);
            setError(null);
            void rpc
              .call("startTeamAssistant", {
                teamId,
                scope,
                expectedDraftVersion: team.draft.version,
                projectId: targetProject,
                prompt,
              })
              .then(
                (value) => {
                  setThreadId(value.threadId);
                  setCompose(false);
                  setPrompt("");
                  sessions.refresh();
                },
                (failure) => setError(errorMessage(failure)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            Describe the team you want. The assistant can inspect real agents
            and suggest an exact draft change. Review suggestions before
            applying them; publishing remains your choice.
          </p>
          {scope.kind === "library" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Conversation project</span>
              <select
                aria-label="Team assistant project"
                className={selectClass}
                value={targetProject}
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
          )}
          <Textarea
            aria-label="Ask the team assistant"
            rows={7}
            maxLength={100000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Help me organize a frontend builder, backend builder and reviewer…"
          />
          <p className="text-xs text-muted-foreground">
            Uses saved draft {team?.draft.version ?? "…"}. Save your graph edits
            before starting.
          </p>
          <Button
            type="submit"
            disabled={
              busy ||
              !team ||
              !prompt.trim() ||
              !targetProject ||
              team.archivedAt !== null
            }
          >
            {busy ? "Starting assistant…" : "Start assistant"}
          </Button>
          {compose && selectedId && (
            <Button size="sm" variant="ghost" onClick={() => setCompose(false)}>
              Back to conversation
            </Button>
          )}
          {sessions.data && sessions.data.total > available.length && (
            <p className="text-xs text-muted-foreground">
              {sessions.data.total - available.length} older or unbound sessions
              are retained. Use the sessions SDK or CLI to inspect them.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import {
  ThreadChat,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@bb/shared-ui/icon";
import { Textarea } from "@bb/shared-ui/textarea";
import type { AgentDetail, AgentScope } from "../contract.js";
import { useAssistantDraft } from "./assistant-draft.js";
import {
  errorMessage,
  parseStudioRoute,
  useStudioQuery,
  useStudioRpc,
} from "./data.js";

export const assistantTab = { panelId: "agents", id: "assistant" } as const;
export const testTab = { panelId: "agents", id: "test" } as const;

export function AgentAssistantPanel(props: PluginNavPanelProps) {
  return <StudioChatPanel {...props} purpose="assistant" />;
}

export function AgentTestPanel(props: PluginNavPanelProps) {
  return <StudioChatPanel {...props} purpose="test" />;
}

function StudioChatPanel({
  subPath,
  purpose,
}: PluginNavPanelProps & { purpose: "assistant" | "test" }) {
  const route = parseStudioRoute(subPath);
  return route.agentId ? (
    <SelectedChatPanel
      key={`${route.agentId}:${purpose}`}
      agentId={route.agentId}
      scope={route.scope}
      purpose={purpose}
    />
  ) : (
    <p className="p-4 text-sm leading-relaxed text-muted-foreground">
      Select or create an agent to{" "}
      {purpose === "assistant"
        ? "shape its instructions with the assistant"
        : "test a saved version"}
      .
    </p>
  );
}

function SelectedChatPanel({
  agentId,
  scope,
  purpose,
}: {
  agentId: string;
  scope: AgentScope;
  purpose: "assistant" | "test";
}) {
  const query = useStudioQuery(`chat-agent:${agentId}`, (rpc) =>
    rpc.call("getAgent", { agentId, scope }),
  );
  if (!query.data)
    return (
      <p
        className="p-4 text-sm text-muted-foreground"
        role={query.error ? "alert" : "status"}
      >
        {query.error ?? "Loading agent…"}
        {query.error && (
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        )}
      </p>
    );
  return <AgentChat agent={query.data.agent} scope={scope} purpose={purpose} />;
}

function AgentChat({
  agent,
  scope,
  purpose,
}: {
  agent: AgentDetail;
  scope: AgentScope;
  purpose: "assistant" | "test";
}) {
  const rpc = useStudioRpc();
  const navigate = useBbNavigate();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [projectId, setProjectId] = useState(
    scope.kind === "project" ? scope.projectId : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const helpId = useId();
  const isPointerCoarse = usePointerCoarse();
  const promptKey = `arc.agentChatDraft.${agent.id}.${purpose}`;
  const [prompt, setPrompt] = useState(() => {
    try {
      return localStorage.getItem(promptKey) ?? "";
    } catch {
      return "";
    }
  });
  const projects = useStudioQuery("chat-projects", (client) =>
    client.call("listStudioProjects", null),
  );
  useAssistantDraft(promptKey, setPrompt, setCompose);
  const sessions = useStudioQuery(`sessions:${agent.id}:${purpose}`, (client) =>
    client.call("listAgentSessions", {
      agentId: agent.id,
      scope,
      purpose,
      limit: 100,
    }),
  );
  const available =
    sessions.data?.sessions.filter((session) => session.threadId !== null) ??
    [];
  const threadId = selectedThreadId ?? available[0]?.threadId ?? null;
  const session = available.find((item) => item.threadId === threadId);
  const targetProject = projectId || projects.data?.personalProjectId || "";
  const ready = purpose === "assistant" || agent.currentRevision !== null;
  const canStart =
    !busy &&
    ready &&
    !!targetProject &&
    !!prompt.trim() &&
    agent.archivedAt === null;

  useEffect(() => {
    try {
      localStorage.setItem(promptKey, prompt);
    } catch {}
  }, [promptKey, prompt]);

  async function start() {
    if (!canStart || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const target = {
        agentId: agent.id,
        scope,
        projectId: targetProject,
        prompt,
      };
      const result =
        purpose === "assistant"
          ? await rpc.call("startAgentAssistant", {
              ...target,
              expectedDraftVersion: agent.draft.version,
            })
          : await rpc.call("startAgentTest", {
              ...target,
              revision: agent.currentRevision ?? 0,
            });
      setSelectedThreadId(result.threadId);
      setCompose(false);
      setPrompt("");
      sessions.refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">
              {purpose === "assistant" ? "Build this agent" : "Test this agent"}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {agent.name}
              {session && !compose
                ? ` · ${session.revision === null ? `draft ${session.draftVersion}` : `version ${session.revision}`}`
                : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
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
            aria-label={`${purpose === "assistant" ? "Assistant" : "Test"} session history`}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            value={compose ? "" : (threadId ?? "")}
            onChange={(event) => {
              if (event.target.value) {
                setSelectedThreadId(event.target.value);
                setCompose(false);
              }
            }}
          >
            <option value="">New conversation</option>
            {available.map((item) => (
              <option key={item.executionContextId} value={item.threadId ?? ""}>
                {item.revision === null
                  ? `Draft ${item.draftVersion}`
                  : `Version ${item.revision}`}{" "}
                · {new Date(item.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        )}
      </div>
      {sessions.error && (
        <p
          role="alert"
          className="border-b px-3 py-2 text-xs text-destructive-text"
        >
          {sessions.error}{" "}
          <button
            type="button"
            className="underline"
            onClick={sessions.refresh}
          >
            Retry
          </button>
        </p>
      )}
      {threadId && !compose ? (
        <>
          <ThreadChat
            threadId={threadId}
            variant="compact"
            layout="contained"
            permissionPolicy="editable"
            className="min-h-0 flex-1"
          />
          <Button
            variant="ghost"
            size="sm"
            className="m-2 self-start"
            onClick={() => navigate.toThread(threadId)}
          >
            Open full chat
          </Button>
        </>
      ) : purpose === "assistant" ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-arc-assistant-compose
        >
          <div className="min-h-0 flex-1 overflow-auto px-4 py-6">
            <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-3">
              <h3 className="text-base font-medium">
                What should this agent do?
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Describe its job, how it should work, and what a good result
                looks like. The assistant helps turn your ideas into clear agent
                instructions.
              </p>
              {!prompt.trim() && (
                <div
                  className="flex flex-col items-start gap-1 pt-2"
                  aria-label="Ideas for building your agent"
                >
                  {[
                    [
                      "Help define its role",
                      "Help me define this agent’s role. Ask me about the work it should handle, then suggest clear instructions.",
                    ],
                    [
                      "Improve its instructions",
                      "Review this agent’s saved instructions and suggest improvements that make its responsibilities and expected results clearer.",
                    ],
                    [
                      "Add checks for its work",
                      "Help this agent check its own work. Suggest verification steps and explain when it should ask me for help.",
                    ],
                  ].map(([label, text]) => (
                    <Button
                      key={label}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto justify-start whitespace-normal px-2 py-2 text-left text-muted-foreground"
                      disabled={busy || agent.archivedAt !== null}
                      onClick={() => {
                        setPrompt(text);
                        promptRef.current?.focus();
                      }}
                    >
                      <Icon
                        name="CornerDownRight"
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <form
            aria-label="Build this agent with the assistant"
            className="shrink-0 space-y-2 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div className="relative w-full rounded-xl border border-border bg-background shadow-lift focus-within:border-ring">
              <Textarea
                ref={promptRef}
                aria-label="Ask the agent assistant"
                aria-describedby={helpId}
                placeholder="Describe the agent you want to build, or ask for a change…"
                className="field-sizing-content min-h-24 max-h-48 resize-none rounded-xl border-0 px-3.5 py-3 shadow-none focus-visible:ring-0"
                rows={3}
                value={prompt}
                maxLength={100_000}
                disabled={busy || agent.archivedAt !== null}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !isPointerCoarse &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    if (!event.repeat)
                      event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="flex min-w-0 items-end gap-3 pb-2 pl-3.5 pr-2 pt-1.5">
                <div className="min-w-0 flex-1 space-y-1">
                  {scope.kind === "library" && (
                    <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon
                        name="Folder"
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <select
                        aria-label="Agent conversation project"
                        className="h-8 min-w-0 max-w-full rounded-md bg-background pr-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={targetProject}
                        disabled={busy || agent.archivedAt !== null}
                        onChange={(event) => setProjectId(event.target.value)}
                      >
                        {projects.data?.personalProjectId && (
                          <option value={projects.data.personalProjectId}>
                            No project
                          </option>
                        )}
                        {projects.data?.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p className="truncate text-xs text-muted-foreground">
                    {agent.draft.metadata.execution.providerId === null
                      ? "Uses project model and session defaults"
                      : `${agent.draft.metadata.execution.providerId} · ${agent.draft.metadata.execution.model}`}
                  </p>
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className={COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS}
                  aria-label={
                    busy
                      ? "Starting agent assistant"
                      : "Send to agent assistant"
                  }
                  aria-busy={busy}
                  disabled={!canStart}
                >
                  <Icon
                    name={busy ? "Spinner" : "CornerDownLeft"}
                    className={busy ? "size-4 animate-spin" : "size-4"}
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </div>
            <div
              id={helpId}
              className="space-y-1 px-1 text-xs leading-relaxed text-muted-foreground"
            >
              <p>
                Save editor changes first. Review proposed changes in
                Suggestions.
              </p>
              <p>
                {isPointerCoarse
                  ? "Tap send to ask the assistant"
                  : "Enter to send · Shift+Enter for a new line"}
              </p>
            </div>
            {agent.archivedAt !== null && (
              <p role="status" className="px-1 text-xs text-warning-text">
                Restore this archived agent before starting a conversation.
              </p>
            )}
            {error && (
              <p role="alert" className="px-1 text-xs text-destructive-text">
                {error}
              </p>
            )}
            {projects.error && (
              <p role="alert" className="px-1 text-xs text-destructive-text">
                {projects.error}{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={projects.refresh}
                >
                  Retry
                </button>
              </p>
            )}
          </form>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Try a small task using the published instructions. The conversation
            stays attached to this version even if you edit the agent later.
          </p>
          {!ready && (
            <p role="status" className="text-xs text-warning-text">
              Save a version in the editor before starting a test.
            </p>
          )}
          {scope.kind === "library" && (
            <label className="block space-y-1.5 text-xs">
              <span>Project context</span>
              <select
                aria-label="Agent conversation project"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={targetProject}
                disabled={busy}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.data?.personalProjectId && (
                  <option value={projects.data.personalProjectId}>
                    No project
                  </option>
                )}
                {projects.data?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Uses the model and permissions saved in version{" "}
            {agent.currentRevision ?? "—"}.
          </p>
          <Textarea
            aria-label="Agent test prompt"
            placeholder="Describe a small task to test this agent…"
            className="min-h-36 resize-y text-sm"
            value={prompt}
            maxLength={100_000}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <Button size="sm" disabled={!canStart} onClick={() => void start()}>
            {busy
              ? "Starting…"
              : `Test version ${agent.currentRevision ?? "—"}`}
          </Button>
          {error && (
            <p role="alert" className="text-xs text-destructive-text">
              {error}
            </p>
          )}
          {projects.error && (
            <p role="alert" className="text-xs text-destructive-text">
              {projects.error}{" "}
              <button
                type="button"
                className="underline"
                onClick={projects.refresh}
              >
                Retry
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

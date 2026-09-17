import { z } from "zod";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PreviewLaunchConfig, ProjectPreview } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@bb/shared-ui/dialog";
import { sdk } from "@/lib/sdk";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { getDesktopBrowserApi } from "@/lib/bb-desktop";

export function ProjectPreviewControls({
  environmentId,
  onNavigate,
  visible = true,
}: {
  environmentId: string | null;
  onNavigate: (url: string) => void;
  visible?: boolean;
}) {
  const { data: environment } = useEnvironment(environmentId);
  const projectId = environment?.projectId;
  const queryClient = useQueryClient();
  const queryKey = ["project-preview", projectId];
  const { data, error: queryError } = useQuery({
    queryKey,
    queryFn: () => sdk.experimental_previews.get({ projectId: projectId! }),
    enabled: Boolean(projectId) && visible,
    refetchInterval: Boolean(projectId) && visible ? 5_000 : false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const [editing, setEditing] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [draft, setDraft] = useState<PreviewLaunchConfig>({
    command: "",
    cwd: "",
    hostId: "",
    url: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detachReview, setDetachReview] = useState<ProjectPreview | null>(null);
  const [acknowledgedDetach, setAcknowledgedDetach] = useState(false);
  const [browserHost, setBrowserHost] = useState<string | null>(null);
  const { data: hosts = [] } = useQuery({
    queryKey: ["preview-hosts"],
    queryFn: () => sdk.hosts.list(),
    enabled: editing,
  });
  const { data: suggestedCommands = [] } = useQuery({
    queryKey: ["preview-scripts", environment?.hostId, environment?.path],
    enabled: editing && Boolean(environment?.path),
    retry: false,
    queryFn: async () => {
      if (!environment?.path) return [];
      const result = await sdk.files.read({
        hostId: environment.hostId,
        path: `${environment.path.replace(/[\\/]+$/u, "")}/package.json`,
        rootPath: environment.path,
      });
      if (result.contentEncoding !== "utf8") return [];
      const parsed = z
        .object({
          packageManager: z.string().optional(),
          scripts: z.record(z.string(), z.string()).optional(),
        })
        .parse(JSON.parse(result.content));
      const manager =
        /^(pnpm|yarn|bun|npm)@/u.exec(parsed.packageManager ?? "")?.[1] ??
        "npm";
      return ["dev", "start", "serve"]
        .filter((name) => parsed.scripts?.[name])
        .map((name) => `${manager} run ${name}`);
    },
  });
  useEffect(() => {
    const url = data?.url;
    if (!pendingOpen || !url || data?.status !== "running") return;
    const loopback = /^https?:\/\/(?:localhost|127\.|\[::1\])/iu.test(url);
    if (loopback && (!browserHost || browserHost !== data?.config?.hostId))
      return;
    onNavigate(url);
    setPendingOpen(false);
  }, [
    pendingOpen,
    data?.url,
    data?.status,
    data?.config?.hostId,
    browserHost,
    onNavigate,
  ]);

  useEffect(() => {
    void getDesktopBrowserApi()
      ?.getTarget?.()
      .then((target) => setBrowserHost(target?.hostId ?? null))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setEditing(false);
    setError(null);
    setShowLogs(false);
    setPendingOpen(false);
    setDetachReview(null);
    setAcknowledgedDetach(false);
  }, [projectId]);
  if (!projectId || !environment) return null;
  const active =
    data?.terminal !== null &&
    data?.terminal !== undefined &&
    data.terminal.status !== "exited";
  const remote = Boolean(
    data?.config && browserHost && data.config.hostId !== browserHost,
  );
  const edit = () => {
    setDraft(
      data?.config ?? {
        command: "",
        cwd: environment.path ?? "",
        hostId: environment.hostId,
        url: "",
      },
    );
    setEditing(true);
  };
  const run = async (operation: "save" | "start" | "stop" | "restart") => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const next: ProjectPreview =
        operation === "save"
          ? await sdk.experimental_previews.configure({
              projectId,
              expectedRevision: data.revision,
              config: draft,
            })
          : await sdk.experimental_previews[operation]({ projectId });
      queryClient.setQueryData(queryKey, next);
      if (operation === "save") setEditing(false);
      if (operation === "start" || operation === "restart")
        setPendingOpen(true);
      if (operation === "stop") setPendingOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Preview operation failed",
      );
      void queryClient.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  };
  const detach = async () => {
    if (
      !detachReview?.cleanup ||
      detachReview.projectId !== projectId ||
      !acknowledgedDetach
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await sdk.experimental_previews.detach({
        projectId,
        expectedRevision: detachReview.revision,
        terminalId: detachReview.cleanup.terminalId,
        acknowledgeUnconfirmedProcess: true,
      });
      queryClient.setQueryData(queryKey, next);
      setPendingOpen(false);
      setDetachReview(null);
      setAcknowledgedDetach(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Preview recovery failed",
      );
      void queryClient.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  };
  const unreachableLoopback =
    remote &&
    Boolean(
      data?.url && /^https?:\/\/(?:localhost|127\.|\[::1\])/iu.test(data.url),
    );
  return (
    <section
      aria-label="Project preview"
      className="shrink-0 border-b border-border bg-sidebar px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Preview</span>
        <span role="status" className="text-muted-foreground">
          {data?.status ?? "Loading"}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {!data?.config ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={edit}
              disabled={!data || busy}
            >
              Set launch command
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(active || data.cleanup ? "stop" : "start")
                }
                disabled={busy}
              >
                {data.cleanup ? "Retry Stop" : active ? "Stop" : "Start"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run("restart")}
                disabled={busy || !active || Boolean(data.cleanup)}
              >
                Restart
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowLogs(!showLogs)}
                aria-expanded={showLogs}
              >
                Logs
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={edit}
                disabled={busy || active || Boolean(data.cleanup)}
              >
                Configure
              </Button>
              {data.cleanup && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDetachReview(data);
                    setAcknowledgedDetach(false);
                  }}
                >
                  Detach lost session
                </Button>
              )}
            </>
          )}
          {data?.url && (
            <Button
              size="sm"
              variant="ghost"
              disabled={unreachableLoopback || data.status !== "running"}
              onClick={() => onNavigate(data.url!)}
            >
              Open app
            </Button>
          )}
        </div>
      </div>
      {data?.status === "detached" && (
        <p role="status" className="mt-2 text-muted-foreground">
          Tracking released. Detaching did not stop or confirm exit of the old
          processes. Inspect or stop them on their host before launching again.
        </p>
      )}
      {data?.config && (
        <p
          className="truncate text-muted-foreground"
          title={`${data.config.hostId} · ${data.config.cwd}`}
        >
          {data.config.command} · {data.config.cwd}
        </p>
      )}
      {unreachableLoopback && (
        <p role="status" className="mt-2 text-muted-foreground">
          This server is on another machine. Configure its reachable URL or
          connect an authenticated port share before opening it here.
        </p>
      )}
      {(error || queryError || data?.error) && (
        <p role="alert" className="mt-2 text-destructive">
          {error ?? queryError?.message ?? data?.error}
        </p>
      )}
      <Dialog
        modal={false}
        open={detachReview !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDetachReview(null);
            setAcknowledgedDetach(false);
          }
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detach lost preview session?</DialogTitle>
            <DialogDescription>
              This releases ARC's tracking only. It does not stop the old
              processes or confirm that they exited. Inspect or stop them using
              tools on their host first. A new preview must prove its own
              process and URL ownership.
            </DialogDescription>
          </DialogHeader>
          {detachReview?.cleanup && (
            <div className="space-y-3 text-sm">
              <dl className="grid gap-1 break-all">
                <dt className="text-muted-foreground">Session</dt>
                <dd className="font-mono">{detachReview.cleanup.terminalId}</dd>
                <dt className="text-muted-foreground">Machine</dt>
                <dd>{detachReview.cleanup.hostId}</dd>
                <dt className="text-muted-foreground">
                  Launch command and directory
                </dt>
                <dd>
                  {detachReview.config?.command}
                  <br />
                  {detachReview.config?.cwd}
                </dd>
                <dt className="text-muted-foreground">Last URL</dt>
                <dd>{detachReview.url ?? "Unavailable"}</dd>
              </dl>
              <details>
                <summary>Review retained logs</summary>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {detachReview.logs || "No retained terminal output"}
                </pre>
              </details>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={acknowledgedDetach}
                  onChange={(event) =>
                    setAcknowledgedDetach(event.target.checked)
                  }
                />
                <span>
                  I reviewed this session and understand its processes may still
                  be running.
                </span>
              </label>
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDetachReview(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !acknowledgedDetach}
              onClick={() => void detach()}
            >
              Detach this session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {Boolean(data?.detachedSessions.length) && (
        <details className="mt-2 text-muted-foreground">
          <summary>
            Detached session history ({data!.detachedSessions.length})
          </summary>
          <p className="mt-1">
            Up to 20 recent sessions are retained. Their process exits remain
            unconfirmed.
          </p>
          {data!.detachedSessions
            .slice()
            .reverse()
            .map((session) => (
              <details
                key={`${session.terminalId}:${session.detachedAt}`}
                className="mt-2"
              >
                <summary className="break-all">
                  {session.terminalId} · {session.config.hostId}
                </summary>
                <p className="break-all">
                  {session.config.command} · {session.config.cwd}
                </p>
                <p>{session.error}</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {session.logs || "No retained terminal output"}
                </pre>
              </details>
            ))}
        </details>
      )}
      {editing && (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <label>
            Launch command
            <Input
              aria-label="Preview launch command"
              placeholder="pnpm dev"
              value={draft.command}
              onChange={(event) =>
                setDraft({ ...draft, command: event.target.value })
              }
              required
            />
          </label>
          {suggestedCommands.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {suggestedCommands.map((command) => (
                <Button
                  type="button"
                  key={command}
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft({ ...draft, command })}
                >
                  {command}
                </Button>
              ))}
            </div>
          )}
          <label>
            Working directory
            <Input
              aria-label="Preview working directory"
              value={draft.cwd}
              onChange={(event) =>
                setDraft({ ...draft, cwd: event.target.value })
              }
              required
            />
          </label>
          <label>
            Machine
            <select
              aria-label="Preview machine"
              className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={draft.hostId}
              onChange={(event) =>
                setDraft({ ...draft, hostId: event.target.value })
              }
              required
            >
              {!hosts.some((host) => host.id === draft.hostId) && (
                <option value={draft.hostId}>
                  {draft.hostId || "Choose a machine"}
                </option>
              )}
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name} · {host.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            App URL{" "}
            <span className="text-muted-foreground">
              (optional; detected from output)
            </span>
            <Input
              aria-label="Preview URL"
              placeholder="http://localhost:3000"
              value={draft.url}
              onChange={(event) =>
                setDraft({ ...draft, url: event.target.value })
              }
            />
          </label>
          <p className="text-muted-foreground">
            Saving does not run the command. Start creates a persistent terminal
            owned by this project preview.
          </p>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              Save
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {showLogs && (
        <pre
          tabIndex={0}
          aria-label="Preview logs"
          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-xs"
        >
          {data?.logs || "Waiting for terminal output…"}
        </pre>
      )}
    </section>
  );
}

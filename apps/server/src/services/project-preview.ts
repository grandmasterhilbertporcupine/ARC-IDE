import type {
  TerminalPreviewProbeResult,
  TerminalPreviewStopResult,
} from "@bb/host-daemon-contract";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appSettingsValues } from "@bb/db";
import { z } from "zod";
import {
  previewLaunchConfigSchema,
  detachedPreviewSessionSchema,
  detachPreviewRequestSchema,
  type ConfigurePreviewRequest,
  type DetachPreviewRequest,
  type ProjectPreview,
  type TerminalSession,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { requirePublicProject } from "./lib/entity-lookup.js";
import { isAbsoluteHostPath } from "./hosts/host-path.js";

const savedPreviewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    config: previewLaunchConfigSchema,
    terminalId: z.string().nullable(),
    launchTitle: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: z.number().nullable().default(null),
    cleanupUnconfirmed: z.boolean().default(false),
    detachedSessions: z.array(detachedPreviewSessionSchema).max(20).default([]),
    lastLogs: z.string().max(32_768).default(""),
    lastUrl: z.string().nullable().default(null),
  })
  .strict();
type SavedPreview = z.infer<typeof savedPreviewSchema>;

export function previewLogText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "")
    .slice(-32_768);
}

export function detectPreviewUrl(logs: string): string | null {
  for (const match of previewLogText(logs).matchAll(
    /https?:\/\/[^\s<>"'`]+/gu,
  )) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/u, ""));
      if (url.username || url.password) continue;
      const host = url.hostname.toLowerCase();
      if (
        !["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(
          host,
        ) &&
        !host.endsWith(".localhost")
      )
        continue;
      if (host === "0.0.0.0") url.hostname = "127.0.0.1";
      if (host === "[::]") url.hostname = "[::1]";
      return url.href;
    } catch {
      continue;
    }
  }
  return null;
}

export function createProjectPreviewService(deps: {
  db: AppDeps["db"];
  probe: (
    hostId: string,
    terminalId: string,
    url: string,
  ) => Promise<TerminalPreviewProbeResult>;
  stopOwned: (
    hostId: string,
    terminalId: string,
  ) => Promise<TerminalPreviewStopResult>;
  terminalSessions: Pick<
    AppDeps["terminalSessions"],
    | "getTerminal"
    | "listTerminals"
    | "readTerminalOutput"
    | "createTerminal"
    | "closeTerminal"
  >;
}) {
  const locks = new Set<string>();
  const probes = new Map<
    string,
    { checkedAt: number; promise: Promise<TerminalPreviewProbeResult> }
  >();
  const probe = (hostId: string, terminalId: string, url: string) => {
    const cacheKey = JSON.stringify([hostId, terminalId, url]);
    const cached = probes.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 5000) return cached.promise;
    const promise = deps
      .probe(hostId, terminalId, url)
      .catch((): TerminalPreviewProbeResult => ({
        state: "unavailable",
        statusCode: null,
        reason: "Preview readiness could not be verified on its host",
      }));
    if (probes.size >= 100) probes.delete(probes.keys().next().value!);
    probes.set(cacheKey, { checkedAt: Date.now(), promise });
    return promise;
  };
  const key = (projectId: string) => `arc.preview.${projectId}`;
  const read = (projectId: string): SavedPreview | null => {
    requirePublicProject(deps.db, projectId);
    const row = deps.db
      .select()
      .from(appSettingsValues)
      .where(eq(appSettingsValues.key, key(projectId)))
      .get();
    return row ? savedPreviewSchema.parse(JSON.parse(row.value)) : null;
  };
  const write = (projectId: string, value: SavedPreview) => {
    deps.db
      .insert(appSettingsValues)
      .values({
        key: key(projectId),
        value: JSON.stringify(value),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: appSettingsValues.key,
        set: { value: JSON.stringify(value), updatedAt: Date.now() },
      })
      .run();
  };
  const terminal = (saved: SavedPreview): TerminalSession | null => {
    if (saved.terminalId) {
      try {
        return deps.terminalSessions.getTerminal({
          terminalId: saved.terminalId,
        });
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    if (!saved.launchTitle) return null;
    return (
      deps.terminalSessions
        .listTerminals({
          query: { hostId: saved.config.hostId, cwd: saved.config.cwd },
        })
        .find((item) => item.title === saved.launchTitle) ?? null
    );
  };
  const active = (session: TerminalSession | null) =>
    session !== null && session.status !== "exited";
  const cleanupMessage =
    "The preview process exit has not been confirmed. Retry Stop after reconnecting its host. If the session is lost, inspect or stop its processes on that host, then explicitly detach the lost session to release tracking. Start and Restart remain blocked until then.";
  const cleanupUnconfirmed = (
    saved: SavedPreview,
    session: TerminalSession | null,
  ) =>
    !(session?.status === "exited" && session.exitCode !== null) &&
    (saved.cleanupUnconfirmed ||
      session?.status === "exited" ||
      (saved.terminalId !== null && session === null));
  const get = async (projectId: string): Promise<ProjectPreview> => {
    const saved = read(projectId);
    if (!saved)
      return {
        projectId,
        revision: 0,
        config: null,
        terminal: null,
        status: "unconfigured",
        cleanup: null,
        detachedSessions: [],
        url: null,
        logs: "",
        error: null,
      };
    const session = terminal(saved);
    let logs = saved.lastLogs;
    let error = saved.error;
    if (
      saved.cleanupUnconfirmed &&
      session?.status === "exited" &&
      session.exitCode !== null
    )
      error = null;
    if (session) {
      try {
        const output = await deps.terminalSessions.readTerminalOutput({
          terminalId: session.id,
          query: { tailBytes: 32_768, limitChunks: 128 },
        });
        logs = previewLogText(
          Buffer.concat(
            output.chunks.map((chunk) =>
              Buffer.from(chunk.dataBase64, "base64"),
            ),
          ).toString("utf8"),
        );
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.message
            : "Preview logs are unavailable";
      }
    }
    const detected = detectPreviewUrl(logs);
    const url = saved.config.url || detected || saved.lastUrl;
    if (logs !== saved.lastLogs || url !== saved.lastUrl) {
      const current = read(projectId);
      if (
        current &&
        current.revision === saved.revision &&
        current.launchTitle === saved.launchTitle &&
        current.terminalId === saved.terminalId
      )
        write(projectId, { ...current, lastLogs: logs, lastUrl: url });
    }
    let status: ProjectPreview["status"] =
      !saved.terminalId &&
      !saved.launchTitle &&
      saved.detachedSessions.length > 0
        ? "detached"
        : "stopped";
    if (cleanupUnconfirmed(saved, session)) {
      status = "failed";
      error = saved.error ?? cleanupMessage;
    } else if (session?.status === "disconnected") status = "disconnected";
    else if (active(session) && session) {
      status = "starting";
      if (url) {
        const localUrl =
          saved.config.url &&
          /^(?:localhost|127\.0\.0\.1|\[::1\])$/u.test(
            new URL(saved.config.url).hostname,
          )
            ? saved.config.url
            : (detected ?? url);
        const readiness = await probe(
          saved.config.hostId,
          session.id,
          localUrl,
        );
        status =
          readiness.state === "ready"
            ? "running"
            : readiness.state === "failed"
              ? "failed"
              : "starting";
        error = readiness.reason;
      }
      if (
        status === "starting" &&
        saved.startedAt !== null &&
        Date.now() - saved.startedAt > 120_000
      ) {
        status = "failed";
        error = `Preview did not become ready within two minutes. ${error ?? "Check the launch command and its logs."}`;
      }
    } else if (
      error ||
      (session?.exitCode != null &&
        session.exitCode !== 0 &&
        session.closeReason !== "user")
    ) {
      status = "failed";
      error ??= `Preview command exited with code ${session?.exitCode ?? "unknown"}`;
    }
    return {
      projectId,
      revision: saved.revision,
      cleanup:
        cleanupUnconfirmed(saved, session) && (session?.id ?? saved.terminalId)
          ? {
              terminalId: (session?.id ?? saved.terminalId)!,
              hostId: saved.config.hostId,
            }
          : null,
      detachedSessions: saved.detachedSessions,
      config: saved.config,
      terminal: session,
      status,
      url,
      logs,
      error,
    };
  };
  const locked = async <T>(
    projectId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (locks.has(projectId))
      throw new ApiError(
        409,
        "preview_busy",
        "Another preview operation is in progress",
      );
    locks.add(projectId);
    try {
      return await run();
    } finally {
      locks.delete(projectId);
    }
  };
  const configure = (projectId: string, input: ConfigurePreviewRequest) =>
    locked(projectId, async () => {
      const saved = read(projectId);
      if (saved && cleanupUnconfirmed(saved, terminal(saved)))
        throw new ApiError(409, "preview_cleanup_unconfirmed", cleanupMessage);
      if ((saved?.revision ?? 0) !== input.expectedRevision)
        throw new ApiError(
          409,
          "preview_conflict",
          "Preview configuration changed. Reload before saving.",
        );
      if (saved && active(terminal(saved)))
        throw new ApiError(
          409,
          "preview_running",
          "Stop the preview before changing its launch command",
        );
      if (!isAbsoluteHostPath(input.config.cwd))
        throw new ApiError(
          400,
          "invalid_path",
          "Preview directory must be an absolute path on its host",
        );
      write(projectId, {
        revision: input.expectedRevision + 1,
        config: input.config,
        terminalId: null,
        launchTitle: null,
        error: null,
        startedAt: null,
        cleanupUnconfirmed: false,
        detachedSessions: saved?.detachedSessions ?? [],
        lastLogs: "",
        lastUrl: null,
      });
      return get(projectId);
    });
  const stopSaved = async (projectId: string, saved: SavedPreview) => {
    const session = terminal(saved);
    if (session?.status === "disconnected") {
      write(projectId, {
        ...saved,
        terminalId: session.id,
        cleanupUnconfirmed: true,
        error: cleanupMessage,
      });
      throw new ApiError(
        409,
        "preview_cleanup_unconfirmed",
        `Reconnect the preview host before stopping or restarting. ${cleanupMessage}`,
      );
    }
    if (active(session) || cleanupUnconfirmed(saved, session)) {
      const retained = {
        ...saved,
        terminalId: session?.id ?? saved.terminalId,
        cleanupUnconfirmed: true,
        error: cleanupMessage,
      };
      write(projectId, retained);
      if (!session)
        throw new ApiError(409, "preview_cleanup_unconfirmed", cleanupMessage);
      let stopped: TerminalPreviewStopResult;
      try {
        stopped = await deps.stopOwned(saved.config.hostId, session.id);
      } catch (error) {
        write(projectId, {
          ...retained,
          error: `${cleanupMessage} ${error instanceof Error ? error.message : "Host cleanup request failed"}`,
        });
        throw error;
      }
      if (stopped.state !== "stopped") {
        write(projectId, { ...retained, error: stopped.reason });
        throw new ApiError(409, "preview_cleanup_unconfirmed", stopped.reason);
      }
    }
    write(projectId, {
      ...saved,
      terminalId: session?.id ?? saved.terminalId,
      error: null,
      cleanupUnconfirmed: false,
    });
  };
  const action = (projectId: string, operation: "start" | "stop" | "restart") =>
    locked(projectId, async () => {
      let saved = read(projectId);
      if (!saved)
        throw new ApiError(
          409,
          "preview_unconfigured",
          "Save a preview command first",
        );
      if (operation !== "start") {
        await stopSaved(projectId, saved);
        if (operation === "stop") return get(projectId);
        saved = read(projectId)!;
      } else {
        const existing = terminal(saved);
        if (cleanupUnconfirmed(saved, existing))
          throw new ApiError(
            409,
            "preview_cleanup_unconfirmed",
            saved.error ?? cleanupMessage,
          );
        if (active(existing)) {
          write(projectId, { ...saved, terminalId: existing!.id, error: null });
          return get(projectId);
        }
      }
      const next: SavedPreview = {
        ...saved,
        terminalId: null,
        launchTitle: `ARC Preview · ${projectId} · ${randomUUID()}`,
        error: null,
        startedAt: Date.now(),
        cleanupUnconfirmed: false,
        lastLogs: "",
        lastUrl: null,
      };
      write(projectId, next);
      try {
        const session = await deps.terminalSessions.createTerminal({
          payload: {
            target: {
              kind: "host_path",
              hostId: next.config.hostId,
              cwd: next.config.cwd,
            },
            cols: 100,
            rows: 30,
            title: next.launchTitle!,
            start: { mode: "command", command: next.config.command },
          },
        });
        write(projectId, { ...next, terminalId: session.id });
      } catch (cause) {
        write(projectId, {
          ...next,
          error:
            cause instanceof Error ? cause.message : "Preview could not start",
        });
        throw cause;
      }
      return get(projectId);
    });
  const detach = (projectId: string, input: DetachPreviewRequest) =>
    locked(projectId, async () => {
      const request = detachPreviewRequestSchema.parse(input);
      const saved = read(projectId);
      const session = saved ? terminal(saved) : null;
      if (
        !saved ||
        saved.revision !== request.expectedRevision ||
        (session?.id ?? saved.terminalId) !== request.terminalId
      )
        throw new ApiError(
          409,
          "preview_conflict",
          "Preview session changed. Review the current session before detaching.",
        );
      if (!cleanupUnconfirmed(saved, session))
        throw new ApiError(
          409,
          "preview_cleanup_available",
          "Use Stop for an available preview. Detach is only available after cleanup could not be confirmed.",
        );
      const evidence = await get(projectId);
      if (!cleanupUnconfirmed(saved, terminal(saved)))
        throw new ApiError(
          409,
          "preview_cleanup_available",
          "The process exit was confirmed while reviewing recovery. Reload the preview.",
        );
      write(projectId, {
        ...saved,
        revision: saved.revision + 1,
        terminalId: null,
        launchTitle: null,
        startedAt: null,
        cleanupUnconfirmed: false,
        error: null,
        lastLogs: "",
        lastUrl: null,
        detachedSessions: [
          ...saved.detachedSessions,
          {
            terminalId: request.terminalId,
            config: saved.config,
            terminal: evidence.terminal,
            url: evidence.url,
            logs: evidence.logs,
            error: evidence.error,
            detachedAt: Date.now(),
            processExit: "unconfirmed" as const,
          },
        ].slice(-20),
      });
      return get(projectId);
    });
  return { get, configure, action, detach };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate, projects, type DbConnection } from "@bb/db";
import type {
  TerminalPreviewProbeResult,
  TerminalPreviewStopResult,
} from "@bb/host-daemon-contract";
import type { TerminalSession } from "@bb/server-contract";
import { detachPreviewRequestSchema } from "@bb/server-contract";
import { ApiError } from "../../src/errors.js";
import {
  createProjectPreviewService,
  detectPreviewUrl,
} from "../../src/services/project-preview.js";

const databases: DbConnection[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function fixture() {
  const db = createConnection(":memory:");
  migrate(db);
  databases.push(db);
  db.insert(projects)
    .values({ id: "project", name: "Preview", createdAt: 1, updatedAt: 1 })
    .run();
  const sessions = new Map<string, TerminalSession>();
  let nextTerminalId = 0;
  type Manager = Parameters<
    typeof createProjectPreviewService
  >[0]["terminalSessions"];
  const manager: Manager = {
    createTerminal: vi.fn(async ({ payload }) => {
      if (payload.target.kind !== "host_path")
        throw new Error("Unexpected scope");
      const session: TerminalSession = {
        id: `terminal-${nextTerminalId++}`,
        hostId: payload.target.hostId,
        initialCwd: payload.target.cwd ?? "/tmp",
        threadId: null,
        environmentId: null,
        title: payload.title ?? "Preview",
        cols: 100,
        rows: 30,
        status: "running",
        exitCode: null,
        closeReason: null,
        createdAt: 1,
        updatedAt: 1,
        lastUserInputAt: null,
      };
      sessions.set(session.id, session);
      return session;
    }),
    closeTerminal: vi.fn(async ({ terminalId }) => {
      const session = sessions.get(terminalId);
      if (!session) throw new ApiError(404, "not_found", "Missing");
      const next: TerminalSession = {
        ...session,
        status: "exited",
        exitCode: 0,
        closeReason: "user",
      };
      sessions.set(terminalId, next);
      return next;
    }),
    getTerminal: ({ terminalId }) => {
      const value = sessions.get(terminalId);
      if (!value) throw new ApiError(404, "not_found", "Missing");
      return value;
    },
    listTerminals: () => [...sessions.values()],
    readTerminalOutput: async () => ({
      chunks: [
        {
          seq: 1,
          dataBase64: Buffer.from("Local: http://localhost:5173/\n").toString(
            "base64",
          ),
        },
      ],
      nextSeq: 2,
      truncated: false,
    }),
  };
  const probe = vi.fn(async (): Promise<TerminalPreviewProbeResult> => ({
    state: "ready",
    statusCode: 200,
    reason: null,
  }));
  const stopOwned = vi.fn(
    async (
      _hostId: string,
      terminalId: string,
    ): Promise<TerminalPreviewStopResult> => {
      const session = await manager.closeTerminal({
        terminalId,
        payload: { mode: "force", reason: "user" },
      });
      return session.exitCode !== null
        ? { state: "stopped", exitCode: session.exitCode, reason: null }
        : {
            state: "unavailable",
            exitCode: null,
            reason: "Owned process exit was not confirmed",
          };
    },
  );
  const service = createProjectPreviewService({
    db,
    terminalSessions: manager,
    probe,
    stopOwned,
  });
  const configure = () =>
    service.configure("project", {
      expectedRevision: 0,
      config: {
        hostId: "host",
        cwd: "C:\\Project Δ",
        command: "npm run dev",
        url: "",
      },
    });
  return { db, sessions, manager, service, configure, probe, stopOwned };
}

describe("owned project previews", () => {
  it("saves without execution, preserves configuration across service restart and rejects stale edits", async () => {
    const { db, manager, service, configure, probe, stopOwned } = fixture();
    expect((await configure()).status).toBe("stopped");
    expect(manager.createTerminal).not.toHaveBeenCalled();
    const restored = createProjectPreviewService({
      db,
      terminalSessions: manager,
      probe,
      stopOwned,
    });
    expect((await restored.get("project")).config?.cwd).toBe("C:\\Project Δ");
    await expect(configure()).rejects.toThrow("changed");
    await expect(service.get("unknown")).rejects.toThrow("Project not found");
  });
  it("starts once, detects its URL, blocks configuration while active and restarts only its owned terminal", async () => {
    const { service, configure, manager, sessions } = fixture();
    await configure();
    const first = await service.action("project", "start");
    expect(first.url).toBe("http://localhost:5173/");
    await service.action("project", "start");
    expect(manager.createTerminal).toHaveBeenCalledTimes(1);
    await expect(
      service.configure("project", {
        expectedRevision: 1,
        config: { hostId: "host", cwd: "/tmp", command: "other", url: "" },
      }),
    ).rejects.toThrow("Stop the preview");
    const next = await service.action("project", "restart");
    expect(next.terminal?.id).not.toBe(first.terminal?.id);
    expect(manager.closeTerminal).toHaveBeenCalledExactlyOnceWith({
      terminalId: first.terminal?.id,
      payload: { mode: "force", reason: "user" },
    });
    expect(sessions.get(first.terminal!.id)?.status).toBe("exited");
  });
  it("recovers a created terminal after a lost start response without launching another process", async () => {
    const { db, service, configure, manager, probe, stopOwned } = fixture();
    await configure();
    const create = manager.createTerminal;
    manager.createTerminal = vi.fn(async (input) => {
      await create(input);
      throw new Error("Lost response");
    });
    await expect(service.action("project", "start")).rejects.toThrow(
      "Lost response",
    );
    const restored = createProjectPreviewService({
      db,
      terminalSessions: manager,
      probe,
      stopOwned,
    });
    expect((await restored.action("project", "start")).terminal?.id).toBe(
      "terminal-0",
    );
    expect(manager.createTerminal).toHaveBeenCalledTimes(1);
  });
  it("does not replace a disconnected preview while cleanup is unconfirmed", async () => {
    const { service, configure, manager, sessions } = fixture();
    await configure();
    const first = await service.action("project", "start");
    sessions.set(first.terminal!.id, {
      ...first.terminal!,
      status: "disconnected",
    });
    await expect(service.action("project", "restart")).rejects.toThrow(
      "Reconnect",
    );
    expect(manager.closeTerminal).not.toHaveBeenCalled();
    expect(manager.createTerminal).toHaveBeenCalledTimes(1);
  });
  it.each(["unavailable", "timeout"])(
    "blocks replacement after %s cleanup across service restart and allows a confirmed retry",
    async (failure) => {
      const { db, service, configure, manager, probe, stopOwned } = fixture();
      await configure();
      await service.action("project", "start");
      const successfulStop = stopOwned.getMockImplementation()!;
      if (failure === "timeout")
        stopOwned.mockRejectedValue(
          new Error("Host cleanup request timed out"),
        );
      else
        stopOwned.mockResolvedValue({
          state: "unavailable",
          exitCode: null,
          reason: "Owned process exit was not confirmed",
        });
      await expect(service.action("project", "stop")).rejects.toThrow();
      const restored = createProjectPreviewService({
        db,
        terminalSessions: manager,
        probe,
        stopOwned,
      });
      expect(await restored.get("project")).toMatchObject({
        status: "failed",
        terminal: { id: "terminal-0", status: "running" },
      });
      await expect(restored.action("project", "start")).rejects.toThrow();
      await expect(restored.action("project", "restart")).rejects.toThrow();
      await expect(
        restored.configure("project", {
          expectedRevision: 1,
          config: {
            hostId: "host",
            cwd: "/tmp",
            command: "replacement",
            url: "",
          },
        }),
      ).rejects.toThrow("Start and Restart remain blocked");
      expect(manager.createTerminal).toHaveBeenCalledTimes(1);
      stopOwned.mockImplementation(successfulStop);
      expect((await restored.action("project", "stop")).status).toBe("stopped");
      expect((await restored.action("project", "start")).terminal?.id).toBe(
        "terminal-1",
      );
    },
  );
  it.each(["missing", "null exit"])(
    "retains uncertainty for a %s terminal and does not start a replacement",
    async (failure) => {
      const { service, configure, manager, sessions, stopOwned } = fixture();
      await configure();
      const first = await service.action("project", "start");
      if (failure === "missing") sessions.delete(first.terminal!.id);
      else
        sessions.set(first.terminal!.id, {
          ...first.terminal!,
          status: "exited",
          exitCode: null,
        });
      stopOwned.mockResolvedValue({
        state: "unavailable",
        exitCode: null,
        reason: "Owned process exit was not confirmed",
      });
      expect((await service.get("project")).status).toBe("failed");
      await expect(service.action("project", "stop")).rejects.toThrow();
      await expect(service.action("project", "start")).rejects.toThrow();
      await expect(service.action("project", "restart")).rejects.toThrow();
      expect(manager.createTerminal).toHaveBeenCalledTimes(1);
      sessions.set(first.terminal!.id, {
        ...first.terminal!,
        status: "exited",
        exitCode: 0,
      });
      expect((await service.get("project")).status).toBe("stopped");
      expect((await service.action("project", "start")).terminal?.id).toBe(
        "terminal-1",
      );
    },
  );
  it("reports a confirmed user stop as stopped even when forced exit uses a nonzero code", async () => {
    const { service, configure, sessions, stopOwned } = fixture();
    await configure();
    const first = await service.action("project", "start");
    stopOwned.mockImplementation(async () => {
      sessions.set(first.terminal!.id, {
        ...first.terminal!,
        status: "exited",
        exitCode: 17,
        closeReason: "user",
      });
      return { state: "stopped", exitCode: 17, reason: null };
    });
    expect((await service.action("project", "stop")).status).toBe("stopped");
  });
  it("requires an owned listener and HTTP response before reporting running", async () => {
    const { service, configure, probe } = fixture();
    probe.mockResolvedValue({
      state: "starting",
      statusCode: null,
      reason: "Waiting for HTTP",
    });
    await configure();
    const starting = await service.action("project", "start");
    expect(starting.status).toBe("starting");
    expect(starting.error).toBe("Waiting for HTTP");
    expect(probe).toHaveBeenCalledWith(
      "host",
      "terminal-0",
      "http://localhost:5173/",
    );
  });
  it("only detaches the explicitly reviewed unavailable session, retains its evidence and requires fresh ownership", async () => {
    const { db, service, configure, manager, sessions, probe, stopOwned } =
      fixture();
    await configure();
    const running = await service.action("project", "start");
    const request = {
      expectedRevision: running.revision,
      terminalId: running.terminal!.id,
      acknowledgeUnconfirmedProcess: true as const,
    };
    await expect(service.detach("project", request)).rejects.toThrow(
      "Use Stop",
    );
    sessions.delete(request.terminalId);
    expect((await service.get("project")).cleanup).toEqual({
      terminalId: request.terminalId,
      hostId: "host",
    });
    await expect(service.action("project", "start")).rejects.toThrow();
    await expect(
      service.detach("project", { ...request, terminalId: "other-session" }),
    ).rejects.toThrow("session changed");
    await expect(
      service.detach("project", { ...request, expectedRevision: 0 }),
    ).rejects.toThrow("session changed");
    expect(
      detachPreviewRequestSchema.safeParse({
        ...request,
        acknowledgeUnconfirmedProcess: false,
      }).success,
    ).toBe(false);
    expect(
      detachPreviewRequestSchema.safeParse({
        expectedRevision: request.expectedRevision,
        terminalId: request.terminalId,
      }).success,
    ).toBe(false);
    const detached = await service.detach("project", request);
    expect(detached).toMatchObject({
      status: "detached",
      cleanup: null,
      terminal: null,
      revision: 2,
      detachedSessions: [
        {
          terminalId: "terminal-0",
          config: running.config,
          logs: running.logs,
          url: running.url,
          processExit: "unconfirmed",
        },
      ],
    });
    expect(stopOwned).not.toHaveBeenCalled();
    expect(manager.closeTerminal).not.toHaveBeenCalled();
    expect(manager.createTerminal).toHaveBeenCalledTimes(1);
    const restored = createProjectPreviewService({
      db,
      terminalSessions: manager,
      probe,
      stopOwned,
    });
    expect((await restored.get("project")).detachedSessions).toEqual(
      detached.detachedSessions,
    );
    probe.mockResolvedValue({
      state: "failed",
      statusCode: null,
      reason: "Port is still owned by the detached process",
    });
    const next = await restored.action("project", "start");
    expect(next).toMatchObject({
      status: "failed",
      terminal: { id: "terminal-1" },
      detachedSessions: detached.detachedSessions,
    });
    expect(probe).toHaveBeenLastCalledWith(
      "host",
      "terminal-1",
      "http://localhost:5173/",
    );
    await expect(restored.detach("project", request)).rejects.toThrow(
      "session changed",
    );
  });
  it("releases tracking after an explicit failed stop without killing or claiming the old process exited", async () => {
    const { service, configure, sessions, stopOwned, manager } = fixture();
    await configure();
    const running = await service.action("project", "start");
    stopOwned.mockResolvedValue({
      state: "unavailable",
      exitCode: null,
      reason: "Native session was lost",
    });
    await expect(service.action("project", "stop")).rejects.toThrow("lost");
    const detached = await service.detach("project", {
      expectedRevision: running.revision,
      terminalId: running.terminal!.id,
      acknowledgeUnconfirmedProcess: true,
    });
    expect(detached.status).toBe("detached");
    expect(detached.detachedSessions[0]).toMatchObject({
      processExit: "unconfirmed",
      error: "Native session was lost",
      terminal: { status: "running" },
    });
    expect(sessions.get(running.terminal!.id)?.status).toBe("running");
    expect(stopOwned).toHaveBeenCalledTimes(1);
    expect(manager.createTerminal).toHaveBeenCalledTimes(1);
  });
  it("reports a port owned by another process as a failed preview", async () => {
    const { service, configure, probe } = fixture();
    probe.mockResolvedValue({
      state: "failed",
      statusCode: null,
      reason: "Port 5173 is already owned by another process",
    });
    await configure();
    expect(await service.action("project", "start")).toMatchObject({
      status: "failed",
      error: "Port 5173 is already owned by another process",
    });
  });
  it("ignores external log URLs and credentials, strips ANSI and normalizes wildcard bind addresses", () => {
    expect(
      detectPreviewUrl(
        "Docs: https://vite.dev\n\x1b[32mLocal: http://0.0.0.0:3000/\x1b[0m",
      ),
    ).toBe("http://127.0.0.1:3000/");
    expect(
      detectPreviewUrl(
        "http://user:secret@localhost:3000/\nhttps://external.test/",
      ),
    ).toBeNull();
  });
});

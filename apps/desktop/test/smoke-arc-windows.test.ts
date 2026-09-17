import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createSmokeEnvironment,
  validateSmokeEnvironment,
  parseSmokeResume,
  requireWithin,
  verifyProjectContext,
  verifyProjectBinding,
  verifyOwnedApplicationProcess,
} from "../scripts/smoke-arc-windows.mjs";

const token = "feb150a8-5305-4e47-8604-a8ac46427580";
it("keeps provider smoke customization inside the owned ARC environment", () => {
  const original = createSmokeEnvironment(
    { SystemRoot: process.env.SystemRoot ?? join(tmpdir(), "Windows") },
    join(tmpdir(), "arc-smoke-owned"),
    23450,
    23451,
  );
  expect(
    validateSmokeEnvironment(original, {
      ...original,
      PATH: original.PATH + ";C:\\Provider",
      CODEX_HOME: join(tmpdir(), "codex-home"),
    }).BB_DATA_DIR,
  ).toBe(original.BB_DATA_DIR);
  for (const change of [
    { BB_DATA_DIR: join(tmpdir(), "other") },
    { HOME: join(tmpdir(), "other") },
    { BB_SERVER_PORT: "80" },
    { NODE_OPTIONS: "--inspect" },
    { PATH: "C:\\Provider" },
  ]) {
    expect(() =>
      validateSmokeEnvironment(original, { ...original, ...change }),
    ).toThrow();
  }
});
const referenceText = `Shared project note ${token}. The orbital dispatch limit is three.`;
const reference = {
  id: "context_original",
  revision: 1,
  sha256: createHash("sha256").update(referenceText).digest("hex"),
};
const priorSmoke = {
  status: "passed",
  projectId: "proj_smoke",
  serverPort: 12345,
  daemonPort: 12346,
  context: [
    { pass: 1, reference },
    { pass: 2, reference },
  ],
};

async function serveContext(retained = reference) {
  const calls: { method: string; input: unknown }[] = [];
  let cancelled = false;
  const hit = {
    relativePath: "preserve-project.txt",
    text: token,
    sha256: createHash("sha256").update(token).digest("hex"),
    indexId: "context_index",
    chunkId: "chunk_original",
    sourceGeneration: 1,
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const method = request.url?.split("/").at(-1) ?? "";
    const input: unknown = JSON.parse(body);
    calls.push({ method, input });
    let result: unknown;
    switch (method) {
      case "listContextReferences":
        result = { sources: [retained] };
        break;
      case "readContextReference":
        result = { source: retained, text: referenceText };
        break;
      case "importContextSource":
        result = {
          outcome: "applied",
          reference,
          status: null,
          indexError: "Context operation was superseded.",
        };
        break;
      case "reindexContext":
      case "getContextStatus":
        result = {
          state: "ready",
          semantic: "ready",
          coverage: "complete",
          counts: { embeddedChunks: 2 },
          operationId: `packaged-index-2-${token}`,
        };
        break;
      case "searchContext":
        result = { mode: "hybrid", hits: [hit] };
        break;
      case "readContextExcerpt":
        result = cancelled
          ? { state: "stale", hit: null }
          : { state: "current", hit };
        break;
      case "cancelContextIndexing":
        cancelled = true;
        result = { state: "cancelled" };
        break;
      default:
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Context fixture did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("ARC packaged Windows smoke boundaries", () => {
  it("resumes from the last completed Context pass and rejects incomplete evidence", () => {
    expect(parseSmokeResume(priorSmoke)).toEqual({
      projectId: priorSmoke.projectId,
      serverPort: priorSmoke.serverPort,
      daemonPort: priorSmoke.daemonPort,
      previousContext: { pass: 2, reference },
    });
    for (const invalid of [
      { ...priorSmoke, status: "failed" },
      { ...priorSmoke, context: [] },
      { ...priorSmoke, context: [{ pass: 2 }] },
      { ...priorSmoke, context: [{ pass: 0, reference }] },
    ]) {
      expect(() => parseSmokeResume(invalid)).toThrow();
    }
  });

  it("verifies retained reference bytes before retrying and uses a fresh reindex operation after reinstall", async () => {
    const resumed = parseSmokeResume(priorSmoke);
    const server = await serveContext();
    try {
      const result = await verifyProjectContext(
        server.baseUrl,
        { project: { id: resumed.projectId }, token },
        "host_local",
        resumed.previousContext.pass,
        resumed.previousContext,
      );
      expect(result).toMatchObject({
        pass: 3,
        reference,
        importIndexError: "Context operation was superseded.",
        status: { semantic: "ready", coverage: "complete" },
        stopped: { state: "cancelled" },
        cancelledExcerpt: { state: "stale", hit: null },
      });
      expect(server.calls.slice(0, 3).map(({ method }) => method)).toEqual([
        "listContextReferences",
        "readContextReference",
        "importContextSource",
      ]);
      expect(
        server.calls.find(({ method }) => method === "reindexContext"),
      ).toMatchObject({ input: { operationId: `packaged-index-2-${token}` } });
    } finally {
      await server.close();
    }
  });

  it("rejects a changed saved Context identity or hash before issuing another import", async () => {
    for (const retained of [
      { ...reference, id: "context_replaced" },
      { ...reference, revision: 2 },
      { ...reference, sha256: "0".repeat(64) },
    ]) {
      const server = await serveContext(retained);
      try {
        await expect(
          verifyProjectContext(
            server.baseUrl,
            { project: { id: priorSmoke.projectId }, token },
            "host_local",
            2,
            { reference },
          ),
        ).rejects.toThrow("lost or changed the saved Context reference");
        expect(server.calls.map(({ method }) => method)).toEqual([
          "listContextReferences",
        ]);
      } finally {
        await server.close();
      }
    }
  });

  it("requires the selected executable and creation time before stopping a process", () => {
    const executable = join(tmpdir(), "owned ARC", "ARC IDE.exe");
    const expected = {
      pid: 123,
      executable,
      startedAt: "2026-09-10T00:00:00Z",
    };
    const current = {
      exists: true,
      id: 123,
      executablePath: executable,
      startedAt: expected.startedAt,
    };
    expect(verifyOwnedApplicationProcess(current, expected)).toEqual(current);
    expect(
      verifyOwnedApplicationProcess({ exists: false }, expected),
    ).toBeNull();
    expect(() =>
      verifyOwnedApplicationProcess(
        { ...current, executablePath: join(tmpdir(), "other", "ARC IDE.exe") },
        expected,
      ),
    ).toThrow("exact selected ARC executable");
    expect(() =>
      verifyOwnedApplicationProcess({ ...current, id: 456 }, expected),
    ).toThrow("exact selected ARC executable");
    expect(() =>
      verifyOwnedApplicationProcess(
        { ...current, startedAt: "2026-09-10T01:00:00Z" },
        expected,
      ),
    ).toThrow("reused application PID");
  });

  it("excludes credentials, developer runtimes, update feeds and alternate data roots", () => {
    const root = join(tmpdir(), "smoke Δ");
    const env = createSmokeEnvironment(
      {
        SystemRoot: root,
        OPENAI_API_KEY: "not-a-real-key",
        ANTHROPIC_API_KEY: "not-a-real-key",
        CODEX_HOME: "foreign-auth",
        ARC_UPDATE_BASE_URL: "https://foreign.test",
        BB_DATA_DIR: "foreign-data",
        BB_DESKTOP_APP_URL: "http://localhost:1",
        NODE_OPTIONS: "--require=foreign",
        PATH: "foreign-bin",
      },
      root,
      12345,
      12346,
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.ARC_UPDATE_BASE_URL).toBeUndefined();
    expect(env.BB_DESKTOP_APP_URL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).not.toContain("foreign-bin");
    expect(env.BB_DATA_DIR).toBe(join(root, "data"));
    expect(() =>
      requireWithin(root, join(root, "..", "different", "project")),
    ).toThrow("outside the smoke boundary");
    expect(() => requireWithin(root, root)).toThrow(
      "outside the smoke boundary",
    );
  });

  it("rejects a restored project that changed identity, host or workspace", () => {
    const workspace = join(tmpdir(), "Project 東京");
    const expected = {
      projectId: "proj_smoke",
      name: "Smoke",
      hostId: "host_local",
      workspace,
    };
    const source = {
      id: "src_smoke",
      type: "local_path",
      hostId: "host_local",
      path: workspace,
    };
    const project = { id: "proj_smoke", name: "Smoke", sources: [source] };
    expect(verifyProjectBinding(project, expected)).toEqual(project);
    expect(() =>
      verifyProjectBinding({ ...project, id: "proj_other" }, expected),
    ).toThrow("identity changed");
    expect(() =>
      verifyProjectBinding(
        { ...project, sources: [{ ...source, hostId: "host_other" }] },
        expected,
      ),
    ).toThrow("original host workspace");
    expect(() =>
      verifyProjectBinding(
        { ...project, sources: [{ ...source, path: join(tmpdir(), "other") }] },
        expected,
      ),
    ).toThrow("original host workspace");
  });
});

import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentalContextEmbeddingInput,
  ExperimentalContextEmbeddingOptions,
  ExperimentalContextEmbeddingResult,
  ExperimentalContextEmbeddingStatus,
  ExperimentalContextTokenCountResult,
  ExperimentalHostContextEmbeddings,
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchListener,
} from "@get-bb/plugin-sdk/host";
import type {
  HostContextReference,
  HostContextScope,
  HostContextStatus,
  HostContextHit,
} from "../../host-context-contract.js";
import {
  hostContextLimits,
  hostContextHitSchema,
} from "../../host-context-contract.js";
import { ContextStore, hashText, type ChunkRow } from "./store.js";
import { HostContextService } from "./service.js";
import { git } from "../git.js";

const digest = "a".repeat(64);
const referenceDigest = (references: HostContextReference[]) =>
  hashText(
    JSON.stringify(
      [...references]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(({ id, sha256, revision, name }) => ({
          id,
          sha256,
          revision,
          name,
        })),
    ),
  );
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

async function waitForSettled(
  check: () => Promise<void>,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(20);
  }
}

class FixtureEmbeddings implements ExperimentalHostContextEmbeddings {
  available = true;
  generation = "fixture-generation";
  unresolvedOperation: "status" | "countTokens" | "embed" | null = null;
  unresolvedEntered = deferred();
  helperOutstanding = false;
  statusCalls = 0;
  statusStopUnresolved = false;
  admissions: Array<{
    operation: "countTokens" | "embed";
    generation: string;
  }> = [];
  beforeEmbed:
    | ((
        input: ExperimentalContextEmbeddingInput,
        signal: AbortSignal,
      ) => Promise<void>)
    | null = null;
  embedded: string[] = [];
  counts: string[] = [];
  active = 0;
  private async unresolved(
    operation: "status" | "countTokens" | "embed",
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.unresolvedOperation !== operation) return false;
    this.unresolvedOperation = null;
    this.helperOutstanding = true;
    this.unresolvedEntered.release();
    await new Promise<void>((resolveAbort) => {
      if (signal.aborted) resolveAbort();
      else
        signal.addEventListener("abort", () => resolveAbort(), { once: true });
    });
    return true;
  }
  settleHelperExit(): void {
    this.helperOutstanding = false;
    this.generation = "fixture-generation-after-observed-exit";
  }
  async status({
    signal,
  }: ExperimentalContextEmbeddingOptions): Promise<ExperimentalContextEmbeddingStatus> {
    signal.throwIfAborted();
    this.statusCalls++;
    if (this.statusStopUnresolved)
      return {
        state: "unavailable",
        error: {
          code: "stop_unresolved",
          message: "Fixture internal status timeout did not confirm child exit",
        },
      };
    if (await this.unresolved("status", signal))
      return {
        state: "unavailable",
        error: {
          code: "stop_unresolved",
          message: "Fixture child exit is not observed",
        },
      };
    if (!this.available)
      return {
        state: "unavailable",
        error: { code: "runtime_unavailable", message: "Fixture unavailable" },
      };
    return {
      state: "ready",
      generation: this.generation,
      descriptor: {
        manifestDigest: digest,
        model: "Xenova/all-MiniLM-L6-v2",
        revision: "751bff37182d3f1213fa05d7196b954e230abad9",
        runtime: { transformers: "4.2.0", onnx: "1.24.3", sharp: "0.35.4" },
        target: { platform: "win32", arch: "x64" },
        tokenizer: { policy: "minilm-total-tokens-v1", totalTokens: 256 },
        dimension: 384,
        dtype: "q8",
        pooling: "mean",
        normalize: true,
      },
    };
  }
  async countTokens(
    input: ExperimentalContextEmbeddingInput,
    { signal }: ExperimentalContextEmbeddingOptions,
  ): Promise<ExperimentalContextTokenCountResult> {
    signal.throwIfAborted();
    if (input.expectedGeneration !== this.generation)
      return {
        state: "failed",
        error: {
          code: "worker_stopped",
          message: "Exact fixture helper generation is no longer available",
        },
      };
    this.admissions.push({
      operation: "countTokens",
      generation: this.generation,
    });
    if (await this.unresolved("countTokens", signal))
      return {
        state: "failed",
        error: {
          code: "stop_unresolved",
          message: "Fixture child exit is not observed",
        },
      };
    this.counts.push(...input.items.map((item) => item.text));
    return {
      state: "completed",
      generation: this.generation,
      requestId: input.requestId,
      manifestDigest: digest,
      items: input.items.map((item) => ({
        id: item.id,
        tokenCount: Array.from(item.text).length + 2,
      })),
    };
  }
  async embed(
    input: ExperimentalContextEmbeddingInput,
    { signal }: ExperimentalContextEmbeddingOptions,
  ): Promise<ExperimentalContextEmbeddingResult> {
    this.active++;
    try {
      signal.throwIfAborted();
      if (input.expectedGeneration !== this.generation)
        return {
          state: "failed",
          error: {
            code: "worker_stopped",
            message: "Exact fixture helper generation is no longer available",
          },
        };
      this.admissions.push({ operation: "embed", generation: this.generation });
      if (await this.unresolved("embed", signal))
        return {
          state: "failed",
          error: {
            code: "stop_unresolved",
            message: "Fixture child exit is not observed",
          },
        };
      await this.beforeEmbed?.(input, signal);
      signal.throwIfAborted();
      this.embedded.push(...input.items.map((item) => item.text));
      return {
        state: "completed",
        generation: this.generation,
        requestId: input.requestId,
        manifestDigest: digest,
        items: input.items.map((item) => {
          const vector = Array.from({ length: 384 }, () => 0);
          vector[/database|sqlite|storage/iu.test(item.text) ? 1 : 0] = 1;
          return {
            id: item.id,
            tokenCount: Array.from(item.text).length + 2,
            vector,
          };
        }),
      };
    } finally {
      this.active--;
    }
  }
}

async function fixture(
  options: {
    nativeWatch?: boolean;
    references?: HostContextReference[];
    available?: boolean;
  } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "arc-context-Δ-"));
  const data = join(temporary, "host data");
  await mkdir(join(temporary, "Project with spaces"), { recursive: true });
  const root = await realpath(join(temporary, "Project with spaces"));
  const capability = new FixtureEmbeddings();
  capability.available = options.available ?? true;
  const lifetime = new AbortController();
  const listeners = new Set<ExperimentalHostWatchListener>();
  const events: ExperimentalHostWatchEvent[] = [];
  let leases = 0,
    watchCount = 0,
    nextLease = 0;
  const leaseDisposal: { before: ((id: number) => Promise<void>) | null } = {
    before: null,
  };
  const context: Pick<
    ExperimentalHostRpcContext,
    | "signal"
    | "lifecycle"
    | "experimental_watch"
    | "experimental_retainWorker"
    | "experimental_contextEmbeddings"
  > = {
    signal: new AbortController().signal,
    lifecycle: { signal: lifetime.signal },
    experimental_contextEmbeddings: capability,
    experimental_retainWorker() {
      leases++;
      const id = ++nextLease;
      let disposed = false;
      return {
        async dispose() {
          if (!disposed) {
            await leaseDisposal.before?.(id);
            disposed = true;
            leases--;
          }
        },
      };
    },
    async experimental_watch(input, listener) {
      listeners.add(listener);
      watchCount++;
      const native = options.nativeWatch
        ? watch(input.rootPath, { recursive: true }, (_kind, file) => {
            if (file) {
              const event: ExperimentalHostWatchEvent = {
                kind: "changed",
                changes: [
                  {
                    type: "update",
                    path: resolve(input.rootPath, file.toString()),
                  },
                ],
              };
              events.push(event);
              if (events.length > 100) events.shift();
              void listener(event);
            }
          })
        : null;
      native?.on("error", (error) => {
        void listener({ kind: "watch-error", message: error.message });
      });
      let disposed = false;
      return {
        async dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
          watchCount--;
          if (native)
            await new Promise<void>((resolveClosed) => {
              native.once("close", resolveClosed);
              native.close();
            });
        },
      };
    },
  };
  const references = options.references ?? [];
  const scope: HostContextScope = {
    projectId: "project-a",
    hostId: "host-a",
    environmentId: null,
    path: root,
    referenceDigest: referenceDigest(references),
  };
  let service = await HostContextService.open(data);
  const start = (
    operationId = "operation-a",
    target = scope,
    refs = references,
  ) => service.start({ scope: target, operationId, references: refs }, context);
  const ready = async (target = scope) => {
    await waitForSettled(async () => {
      const status = await service.status({ scope: target }, context);
      expect(status.state, status.reason ?? "").toBe("ready");
    });
    return service.status({ scope: target }, context);
  };
  return {
    root,
    data,
    scope,
    context,
    capability,
    events,
    leaseDisposal,
    start,
    ready,
    get service() {
      return service;
    },
    get leases() {
      return leases;
    },
    get watches() {
      return watchCount;
    },
    async emit(event: ExperimentalHostWatchEvent) {
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
    async reopen() {
      await service.dispose();
      service = await HostContextService.open(data);
    },
    async close() {
      await service.dispose();
      expect(capability.active).toBe(0);
      expect(capability.helperOutstanding).toBe(false);
      expect(leases).toBe(0);
      expect(watchCount).toBe(0);
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

async function settleUnknownFixtureFence(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  f.capability.settleHelperExit();
  expect(f.capability.helperOutstanding).toBe(false);
  const store: unknown = Reflect.get(f.service, "store");
  if (!(store instanceof ContextStore))
    throw new Error("Fixture Context store is unavailable");
  const fence = store.stopFence(f.scope);
  if (fence) {
    expect(fence.helper_generation).toBeNull();
    expect(store.clearStopFence(f.scope, fence.fence_id)).toBe(true);
  }
  await f.service.status({ scope: f.scope }, f.context);
}

describe("host Context text cache with real files and migrated SQLite", () => {
  it("indexes real code and immutable references with exact fixture-token spans and hybrid provenance", async () => {
    const reference = {
      id: "ref-a",
      name: "Architecture.md",
      text: "SQLite storage owns the database layer.",
      sha256: hashText("SQLite storage owns the database layer."),
      revision: 1,
    };
    const f = await fixture({ references: [reference] });
    try {
      const body = "export const café = '😀';\n".repeat(80);
      await writeFile(join(f.root, "module.ts"), body);
      await writeFile(join(f.root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
      await writeFile(join(f.root, "binary.txt"), Buffer.from([65, 0, 66]));
      await writeFile(
        join(f.root, "manual.pdf"),
        "unsupported document fixture",
      );
      await mkdir(join(f.root, "node_modules"));
      await writeFile(
        join(f.root, "node_modules", "dependency.js"),
        "not selected",
      );
      await f.start();
      const status = await f.ready();
      expect(status.coverage).toBe("complete");
      expect(status.semantic).toBe("ready");
      expect(status.counts.skipped).toBe(4);
      expect(status.counts.indexed).toBe(2);
      expect(
        f.capability.embedded.every(
          (text) => Array.from(text).length + 2 <= 256,
        ),
      ).toBe(true);
      const db = new DatabaseSync(
        join(f.data, "context", "text-index.sqlite"),
        { readOnly: true },
      );
      try {
        const rows = db
          .prepare(
            "SELECT c.text,c.start_offset,c.end_offset,c.token_count FROM context_chunks c JOIN context_sources s ON s.id=c.source_id WHERE s.name='module.ts' ORDER BY c.start_offset",
          )
          .all();
        expect(rows.map((row) => row.text).join("")).toBe(body);
        for (const row of rows) {
          expect(typeof row.start_offset).toBe("number");
          expect(typeof row.end_offset).toBe("number");
          if (
            typeof row.start_offset !== "number" ||
            typeof row.end_offset !== "number"
          )
            throw new Error("Invalid stored locator");
          expect(body.slice(row.start_offset, row.end_offset)).toBe(row.text);
        }
      } finally {
        db.close();
      }
      const result = await f.service.search(
        { scope: f.scope, query: "database", limit: 10 },
        f.context,
      );
      expect(result.mode).toBe("hybrid");
      const hit = result.hits.find((value) => value.kind === "reference");
      expect(hit?.sha256).toBe(reference.sha256);
      expect(hit?.authority).toBe("reference");
      expect(hit?.lexicalRank).not.toBeNull();
      expect(hit?.semanticRank).not.toBeNull();
      const foreign = await f.service.search(
        {
          scope: { ...f.scope, projectId: "project-b" },
          query: "database",
          limit: 10,
        },
        f.context,
      );
      expect(foreign.status.state).toBe("absent");
      expect(foreign.hits).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("invalidates synchronously during a blocked old embedding and rejects its late source generation", async () => {
    const f = await fixture(),
      blocked = deferred(),
      entered = deferred();
    try {
      await writeFile(join(f.root, "notes.md"), "previous zebra instruction");
      let first = true;
      f.capability.beforeEmbed = async () => {
        if (first) {
          first = false;
          entered.release();
          await blocked.promise;
        }
      };
      await f.start();
      await vi.waitFor(() => expect(f.capability.active).toBe(1), {
        timeout: 10_000,
      });
      const before = await f.service.sources(
        { scope: f.scope, cursor: null, limit: 100 },
        f.context,
      );
      const generation = before.sources.find(
        (source) => source.name === "notes.md",
      )?.generation;
      await writeFile(join(f.root, "notes.md"), "replacement fox instruction");
      await f.emit({
        kind: "changed",
        changes: [{ path: join(f.root, "notes.md"), type: "update" }],
      });
      const during = await f.service.sources(
        { scope: f.scope, cursor: null, limit: 100 },
        f.context,
      );
      expect(
        during.sources.find((source) => source.name === "notes.md")?.state,
      ).toBe("stale");
      expect(
        during.sources.find((source) => source.name === "notes.md")?.generation,
      ).toBeGreaterThan(generation ?? 0);
      blocked.release();
      await f.ready();
      const result = await f.service.search(
        { scope: f.scope, query: "fox", limit: 10 },
        f.context,
      );
      expect(
        result.hits.some((hit) => hit.text.includes("replacement fox")),
      ).toBe(true);
      expect(
        result.hits.every(
          (hit) => hit.sha256 === hashText("replacement fox instruction"),
        ),
      ).toBe(true);
    } finally {
      blocked.release();
      await f.close();
    }
  });

  it("freshly hashes returned files when the watcher misses an edit", async () => {
    const f = await fixture({ available: false });
    try {
      await writeFile(join(f.root, "notes.md"), "original unique zebra");
      await f.start();
      await f.ready();
      const result = await f.service.search(
          { scope: f.scope, query: "zebra", limit: 10 },
          f.context,
        ),
        hit = result.hits[0];
      expect(result.mode).toBe("lexical");
      expect(result.reason).toBe("runtime_unavailable");
      if (!hit) throw new Error("Missing lexical fixture hit");
      await writeFile(join(f.root, "notes.md"), "changed unique fox");
      const excerpt = await f.service.excerpt(
        {
          scope: f.scope,
          indexId: hit.indexId,
          chunkId: hit.chunkId,
          sourceGeneration: hit.sourceGeneration,
          sha256: hit.sha256,
        },
        f.context,
      );
      expect(excerpt.state).toBe("stale");
      expect(excerpt.hit).toBeNull();
      await f.ready();
      expect(
        (
          await f.service.search(
            { scope: f.scope, query: "fox", limit: 10 },
            f.context,
          )
        ).hits[0]?.sha256,
      ).toBe(hashText("changed unique fox"));
    } finally {
      await f.close();
    }
  });

  it("fences an old immutable reference catalog and requires the exact replacement bytes", async () => {
    const first = {
      id: "reference",
      name: "Rules.md",
      text: "old reference zebra",
      sha256: hashText("old reference zebra"),
      revision: 1,
    };
    const second = {
      ...first,
      text: "new reference fox",
      sha256: hashText("new reference fox"),
      revision: 2,
    };
    const f = await fixture({ available: false, references: [first] });
    try {
      await f.start();
      await f.ready();
      const scope = { ...f.scope, referenceDigest: referenceDigest([second]) };
      const stale = await f.service.search(
        { scope, query: "zebra", limit: 10 },
        f.context,
      );
      expect(stale.hits).toEqual([]);
      expect(stale.status.state).toBe("stale");
      expect(f.watches).toBe(0);
      await expect(
        f.start("wrong-bytes", scope, [{ ...second, text: "forged text" }]),
      ).rejects.toThrow("UTF-8 identity");
      await f.start("operation-b", scope, [second]);
      await f.ready(scope);
      const found = await f.service.search(
        { scope, query: "fox", limit: 10 },
        f.context,
      );
      expect(found.hits[0]?.sourceRevision).toBe(2);
      expect(found.hits[0]?.sha256).toBe(second.sha256);
    } finally {
      await f.close();
    }
  });

  it("waits for active inference cancellation and does not replay a cancelled operation", async () => {
    const f = await fixture(),
      entered = deferred();
    try {
      await writeFile(join(f.root, "notes.md"), "cancel this embedding");
      f.capability.beforeEmbed = async (_input, signal) => {
        entered.release();
        await new Promise<void>((resolveAbort) => {
          if (signal.aborted) resolveAbort();
          else
            signal.addEventListener("abort", () => resolveAbort(), {
              once: true,
            });
        });
      };
      await f.start();
      await vi.waitFor(() => expect(f.capability.active).toBe(1), {
        timeout: 10_000,
      });
      const cancelled = await f.service.cancel(
        { scope: f.scope, operationId: "operation-a" },
        f.context,
      );
      expect(cancelled.state).toBe("cancelled");
      expect(f.capability.active).toBe(0);
      expect(f.watches).toBe(0);
      expect(f.leases).toBe(0);
      expect((await f.start()).state).toBe("cancelled");
      expect(f.capability.active).toBe(0);
      await expect(
        f.service.cancel(
          { scope: f.scope, operationId: "foreign-operation" },
          f.context,
        ),
      ).rejects.toThrow("current operation");
      f.capability.beforeEmbed = null;
      await f.start("operation-b");
      await f.ready();
    } finally {
      await f.close();
    }
  });

  it.each(["status", "countTokens", "embed"] as const)(
    "retains an unresolved %s cancellation fence and ownership until authoritative helper recovery",
    async (operation) => {
      const f = await fixture();
      try {
        await writeFile(
          join(f.root, "notes.md"),
          "database cancellation proof",
        );
        f.capability.unresolvedOperation = operation;
        await f.start();
        await f.capability.unresolvedEntered.promise;
        const result = await f.service.cancel(
          { scope: f.scope, operationId: "operation-a" },
          f.context,
        );
        expect(result).toMatchObject({
          state: "failed",
          reason: "embedding_stop_unresolved",
          coverage: "unknown",
        });
        expect(f.leases).toBe(1);
        expect(f.watches).toBe(0);
        expect(f.capability.helperOutstanding).toBe(true);
        const calls = f.capability.statusCalls;
        expect(
          (await f.service.status({ scope: f.scope }, f.context)).state,
        ).toBe("failed");
        if (operation === "status")
          expect(f.capability.statusCalls).toBe(calls);
        expect(
          (
            await f.service.cancel(
              { scope: f.scope, operationId: "operation-a" },
              f.context,
            )
          ).state,
        ).toBe("failed");
        await expect(f.start("replacement-denied")).rejects.toThrow(
          "cleanup needs verification",
        );
        await expect(f.service.dispose()).rejects.toThrow(
          "embedding_stop_unresolved",
        );
        expect(f.leases).toBe(1);
        const reopened = await HostContextService.open(f.data);
        try {
          expect(
            await reopened.status({ scope: f.scope }, f.context),
          ).toMatchObject({
            state: "failed",
            reason: "embedding_stop_unresolved",
          });
          await expect(
            reopened.start(
              {
                scope: f.scope,
                operationId: "reopened-replacement-denied",
                references: [],
              },
              f.context,
            ),
          ).rejects.toThrow("cleanup needs verification");
          const db = new DatabaseSync(
            join(f.data, "context", "text-index.sqlite"),
            { readOnly: true },
          );
          try {
            expect(
              db.prepare("SELECT COUNT(*) n FROM context_operations").get()?.n,
            ).toBe(1);
            expect(
              db
                .prepare("SELECT helper_generation FROM context_stop_fences")
                .get()?.helper_generation,
            ).toBe(operation === "status" ? null : "fixture-generation");
          } finally {
            db.close();
          }
        } finally {
          await reopened.dispose();
        }
        f.capability.settleHelperExit();
        if (operation === "status") {
          const calls = f.capability.statusCalls;
          expect(
            (await f.service.status({ scope: f.scope }, f.context)).state,
          ).toBe("failed");
          expect(f.capability.statusCalls).toBe(calls);
          expect(f.leases).toBe(1);
          await settleUnknownFixtureFence(f);
        } else {
          expect(
            await f.service.status({ scope: f.scope }, f.context),
          ).toMatchObject({
            state: "stale",
            reason: "embedding_stop_confirmed_requires_reindex",
          });
          expect(f.leases).toBe(0);
          await f.start("replacement-after-confirmed-exit");
          expect((await f.ready()).semantic).toBe("ready");
        }
      } finally {
        f.capability.settleHelperExit();
        if (operation === "status") await settleUnknownFixtureFence(f);
        else await f.service.status({ scope: f.scope }, f.context);
        await f.close();
      }
    },
  );

  it.each(["status", "countTokens", "embed"] as const)(
    "does not hide an unresolved search %s stop behind abort or lexical fallback",
    async (operation) => {
      const f = await fixture();
      const abort = new AbortController();
      try {
        await writeFile(
          join(f.root, "notes.md"),
          "database cancellation proof",
        );
        await f.start();
        await f.ready();
        f.capability.unresolvedOperation = operation;
        const request = f.service.search(
          { scope: f.scope, query: "database", limit: 10 },
          { ...f.context, signal: abort.signal },
        );
        await f.capability.unresolvedEntered.promise;
        expect(f.leases).toBe(2);
        abort.abort();
        const result = await request;
        expect(result).toMatchObject({
          status: { state: "failed", reason: "embedding_stop_unresolved" },
          reason: "embedding_stop_unresolved",
          hits: [],
        });
        expect(f.capability.helperOutstanding).toBe(true);
        expect(
          (
            await f.service.cancel(
              { scope: f.scope, operationId: "operation-a" },
              f.context,
            )
          ).state,
        ).toBe("failed");
        expect(f.leases).toBe(2);
        await expect(f.start("replacement-denied")).rejects.toThrow(
          "cleanup needs verification",
        );
        await expect(f.service.dispose()).rejects.toThrow(
          "embedding_stop_unresolved",
        );
        f.capability.settleHelperExit();
        if (operation === "status") {
          expect(
            (await f.service.status({ scope: f.scope }, f.context)).state,
          ).toBe("failed");
          await settleUnknownFixtureFence(f);
        } else {
          expect(
            (await f.service.status({ scope: f.scope }, f.context)).state,
          ).toBe("stale");
          expect(f.leases).toBe(0);
        }
      } finally {
        abort.abort();
        f.capability.settleHelperExit();
        if (operation === "status") await settleUnknownFixtureFence(f);
        else await f.service.status({ scope: f.scope }, f.context);
        await f.close();
      }
    },
  );

  it("does not reuse a previous drain generation when a later status cancellation is unresolved", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "notes.md"), "database cancellation proof");
      await f.start();
      await f.ready();
      f.capability.unresolvedOperation = "status";
      await f.emit({ kind: "watch-error", message: "fixture full rescan" });
      await f.capability.unresolvedEntered.promise;
      expect(
        (
          await f.service.cancel(
            { scope: f.scope, operationId: "operation-a" },
            f.context,
          )
        ).state,
      ).toBe("failed");
      f.capability.settleHelperExit();
      const calls = f.capability.statusCalls;
      expect(
        (await f.service.status({ scope: f.scope }, f.context)).reason,
      ).toBe("embedding_stop_unresolved");
      expect(f.capability.statusCalls).toBe(calls);
      expect(f.leases).toBe(1);
    } finally {
      await settleUnknownFixtureFence(f);
      await f.close();
    }
  });

  it("retains an unresolved reconciliation probe even when its caller signal was not aborted", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "notes.md"), "database cancellation proof");
      f.capability.unresolvedOperation = "countTokens";
      await f.start();
      await f.capability.unresolvedEntered.promise;
      expect(
        (
          await f.service.cancel(
            { scope: f.scope, operationId: "operation-a" },
            f.context,
          )
        ).state,
      ).toBe("failed");
      f.capability.statusStopUnresolved = true;
      expect(f.context.signal.aborted).toBe(false);
      expect(
        (await f.service.status({ scope: f.scope }, f.context)).state,
      ).toBe("failed");
      expect(f.leases).toBe(2);
      f.capability.statusStopUnresolved = false;
      f.capability.settleHelperExit();
      const calls = f.capability.statusCalls;
      expect(
        (await f.service.status({ scope: f.scope }, f.context)).state,
      ).toBe("failed");
      expect(f.capability.statusCalls).toBe(calls);
      await expect(f.start("replacement-denied")).rejects.toThrow(
        "cleanup needs verification",
      );
    } finally {
      f.capability.statusStopUnresolved = false;
      await settleUnknownFixtureFence(f);
      await f.close();
    }
  });

  it("preserves a newer unresolved reply while an older proof is releasing its retained lease", async () => {
    const f = await fixture();
    const firstAbort = new AbortController(),
      secondAbort = new AbortController();
    const firstEntered = deferred(),
      secondEntered = deferred(),
      disposalEntered = deferred(),
      releaseDisposal = deferred();
    let first: ReturnType<HostContextService["search"]> | null = null;
    let second: ReturnType<HostContextService["search"]> | null = null;
    let reconcile: Promise<HostContextStatus> | null = null;
    try {
      await writeFile(join(f.root, "notes.md"), "database cancellation proof");
      await f.start();
      await f.ready();
      const count = f.capability.countTokens.bind(f.capability);
      let queryCount = 0;
      f.capability.countTokens = async (input, options) => {
        if (input.items[0]?.id !== "query") return count(input, options);
        (++queryCount === 1 ? firstEntered : secondEntered).release();
        await new Promise<void>((resolveAbort) => {
          if (options.signal.aborted) resolveAbort();
          else
            options.signal.addEventListener("abort", () => resolveAbort(), {
              once: true,
            });
        });
        return {
          state: "failed",
          error: {
            code: "stop_unresolved",
            message: "Fixture delayed cancellation reply",
          },
        };
      };
      first = f.service.search(
        { scope: f.scope, query: "database first", limit: 10 },
        { ...f.context, signal: firstAbort.signal },
      );
      await firstEntered.promise;
      second = f.service.search(
        { scope: f.scope, query: "database second", limit: 10 },
        { ...f.context, signal: secondAbort.signal },
      );
      await secondEntered.promise;
      firstAbort.abort();
      expect((await first).status.state).toBe("failed");
      f.capability.settleHelperExit();
      f.leaseDisposal.before = async (id) => {
        if (id !== 1) return;
        disposalEntered.release();
        await releaseDisposal.promise;
      };
      reconcile = f.service.status({ scope: f.scope }, f.context);
      await disposalEntered.promise;
      secondAbort.abort();
      expect((await second).status.state).toBe("failed");
      releaseDisposal.release();
      expect((await reconcile).state).toBe("failed");
      expect(f.leases).toBe(2);
      expect(
        (await f.service.status({ scope: f.scope }, f.context)).state,
      ).toBe("stale");
      expect(f.leases).toBe(0);
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      releaseDisposal.release();
      f.leaseDisposal.before = null;
      await Promise.all(
        [first, second, reconcile].filter((value) => value !== null),
      );
      f.capability.settleHelperExit();
      await f.service.status({ scope: f.scope }, f.context);
      await f.close();
    }
  });

  it.each(["countTokens", "embed"] as const)(
    "pins %s to the observed helper generation for indexing and search",
    async (operation) => {
      const f = await fixture();
      const expected: string[] = [];
      let replacements = 0;
      try {
        await writeFile(join(f.root, "notes.md"), "database generation proof");
        const replace = (input: ExperimentalContextEmbeddingInput) => {
          expected.push(input.expectedGeneration);
          f.capability.generation = `replacement-${++replacements}`;
        };
        if (operation === "countTokens") {
          const original = f.capability.countTokens.bind(f.capability);
          f.capability.countTokens = (input, options) => {
            replace(input);
            return original(input, options);
          };
        } else {
          const original = f.capability.embed.bind(f.capability);
          f.capability.embed = (input, options) => {
            replace(input);
            return original(input, options);
          };
        }
        await f.start();
        expect(await f.ready()).toMatchObject({
          semantic: "partial",
          reason: "embedding_worker_stopped",
        });
        expect(expected).toEqual(["fixture-generation"]);
        expect(
          f.capability.admissions.filter(
            (item) => item.operation === operation,
          ),
        ).toEqual([]);
        expect(f.capability.embedded).toEqual([]);
        const result = await f.service.search(
          { scope: f.scope, query: "database", limit: 10 },
          f.context,
        );
        expect(result).toMatchObject({
          mode: "lexical",
          reason: "worker_stopped",
        });
        expect(result.hits).toHaveLength(1);
        expect(expected).toEqual(["fixture-generation", "replacement-1"]);
        expect(
          f.capability.admissions.filter(
            (item) => item.operation === operation,
          ),
        ).toEqual([]);
        expect(f.capability.embedded).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it("marks reopened file caches unknown until the exact saved indexing request resumes", async () => {
    const f = await fixture({ available: false });
    try {
      await writeFile(join(f.root, "notes.md"), "persisted zebra");
      await f.start();
      await f.ready();
      await f.reopen();
      const stale = await f.service.status({ scope: f.scope }, f.context);
      expect(stale.state).toBe("stale");
      expect(stale.coverage).toBe("unknown");
      expect(stale.reason).toBe("host_restarted");
      expect(
        (
          await f.service.search(
            { scope: f.scope, query: "zebra", limit: 10 },
            f.context,
          )
        ).hits,
      ).toEqual([]);
      await f.start();
      expect((await f.ready()).counts.indexed).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("detects physical root replacement and gives the replacement a new index identity", async () => {
    const f = await fixture({ available: false });
    try {
      await writeFile(join(f.root, "notes.md"), "original root");
      await f.start();
      const first = await f.ready();
      await rename(f.root, `${f.root} saved`);
      await mkdir(f.root);
      await writeFile(join(f.root, "notes.md"), "replacement root");
      expect(
        (await f.service.status({ scope: f.scope }, f.context)).state,
      ).toBe("stale");
      expect(f.watches).toBe(0);
      await f.start("operation-b");
      const second = await f.ready();
      expect(second.indexId).not.toBe(first.indexId);
      expect(second.root?.rootIdentity).not.toEqual(first.root?.rootIdentity);
    } finally {
      await f.close();
    }
  });

  it("observes real native create, save, atomic rename and delete events", async () => {
    const f = await fixture({ nativeWatch: true, available: false });
    try {
      await f.start();
      await f.ready();
      await writeFile(join(f.root, "notes.md"), "created zebra");
      await waitForSettled(async () => {
        const result = await f.service.search(
          { scope: f.scope, query: "zebra", limit: 10 },
          f.context,
        );
        expect(
          result.hits.some((hit) => hit.name === "notes.md"),
          JSON.stringify({
            stage: "create",
            status: result.status,
            events: f.events.slice(-8),
          }),
        ).toBe(true);
      });
      await writeFile(join(f.root, "replacement.md"), "saved fox");
      await rename(join(f.root, "replacement.md"), join(f.root, "notes.md"));
      await waitForSettled(async () => {
        const result = await f.service.search(
          { scope: f.scope, query: "fox", limit: 10 },
          f.context,
        );
        expect(
          result.hits.some((hit) => hit.sha256 === hashText("saved fox")),
          JSON.stringify({
            stage: "atomic-save",
            status: result.status,
            events: f.events.slice(-8),
          }),
        ).toBe(true);
      });
      await rm(join(f.root, "notes.md"));
      await waitForSettled(async () => {
        const sources = await f.service.sources(
          { scope: f.scope, cursor: null, limit: 100 },
          f.context,
        );
        expect(
          sources.sources.find((source) => source.name === "notes.md")?.state,
          JSON.stringify({
            stage: "delete",
            status: sources.status,
            events: f.events.slice(-8),
          }),
        ).toBe("deleted");
      });
    } finally {
      await f.close();
    }
  }, 30_000);

  it("rejects stale paging cursors and records unsupported byte limits without truncation", async () => {
    const f = await fixture({ available: false });
    try {
      await writeFile(join(f.root, "a.md"), "one");
      await writeFile(join(f.root, "b.md"), "two");
      await writeFile(
        join(f.root, "oversized.txt"),
        Buffer.alloc(hostContextLimits.maxFileBytes + 1, 65),
      );
      await f.start();
      await f.ready();
      const first = await f.service.sources(
        { scope: f.scope, cursor: null, limit: 1 },
        f.context,
      );
      expect(first.nextCursor).not.toBeNull();
      await f.emit({ kind: "rescan-required" });
      await expect(
        f.service.sources(
          { scope: f.scope, cursor: first.nextCursor, limit: 1 },
          f.context,
        ),
      ).rejects.toThrow("cursor is stale");
      await f.ready();
      const sources = await f.service.sources(
        { scope: f.scope, cursor: null, limit: 100 },
        f.context,
      );
      const large = sources.sources.find(
        (source) => source.name === "oversized.txt",
      );
      expect(large?.state).toBe("skipped");
      expect(large?.reason).toBe("file_size_limit");
      expect(large?.chunks).toBe(0);
      await f.emit({ kind: "watch-error", message: "fixture overflow" });
      await vi.waitFor(
        async () =>
          expect(
            (await f.service.status({ scope: f.scope }, f.context)).state,
          ).toBe("stale"),
        { timeout: 10_000 },
      );
      expect(
        (
          await f.service.search(
            { scope: f.scope, query: "one", limit: 10 },
            f.context,
          )
        ).hits,
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("removes an already collected hit when a later excerpt read observes its invalidation", async () => {
    const f = await fixture({ available: false });
    const original: unknown = Reflect.get(f.service, "freshHit");
    if (typeof original !== "function")
      throw new Error("Missing Context excerpt reader");
    let calls = 0,
      first: HostContextHit | null = null;
    Object.defineProperty(f.service, "freshHit", {
      configurable: true,
      value: async (
        ...args: [HostContextScope, HostContextStatus, ChunkRow, AbortSignal]
      ): Promise<HostContextHit | null> => {
        calls++;
        if (calls === 2 && first?.relativePath) {
          const path = join(f.root, first.relativePath);
          await writeFile(path, "replacement content");
          await f.emit({
            kind: "changed",
            changes: [{ path, type: "update" }],
          });
        }
        const raw: unknown = await Reflect.apply(original, f.service, args);
        const hit = hostContextHitSchema.nullable().parse(raw);
        if (calls === 1) first = hit;
        return hit;
      },
    });
    try {
      await writeFile(join(f.root, "a.md"), "shared marker alpha");
      await writeFile(join(f.root, "b.md"), "shared marker beta");
      await f.start();
      await f.ready();
      const result = await f.service.search(
        { scope: f.scope, query: "shared", limit: 10 },
        f.context,
      );
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(result.hits).toHaveLength(1);
      expect(result.reason).toBe("index_changed_during_search");
    } finally {
      Reflect.deleteProperty(f.service, "freshHit");
      await f.close();
    }
  });

  it("isolates two real Git worktrees and reconciles a missed HEAD change", async () => {
    const f = await fixture({ available: false });
    try {
      const hooks = join(f.root, "..", "empty-hooks");
      await mkdir(hooks);
      const run = async (path: string, args: string[]) => {
        const result = await git(
          path,
          [
            "-c",
            "user.name=ARC Context fixture",
            "-c",
            "user.email=context@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            `core.hooksPath=${hooks}`,
            ...args,
          ],
          f.context.signal,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      await run(f.root, ["init", "-q"]);
      await writeFile(join(f.root, "notes.md"), "accepted zebra source");
      await run(f.root, ["add", "notes.md"]);
      await run(f.root, ["commit", "-qm", "initial fixture"]);
      const worker = join(f.root, "..", "isolated worker");
      await run(f.root, [
        "worktree",
        "add",
        "-b",
        "isolated-worker",
        worker,
        "HEAD",
      ]);
      await writeFile(join(worker, "notes.md"), "unmerged fox source");
      const workerScope = {
        ...f.scope,
        path: worker,
        environmentId: "worker-environment",
      };
      await f.start();
      await f.start("worker-operation", workerScope);
      const accepted = await f.ready(),
        isolated = await f.ready(workerScope);
      expect(accepted.git?.commonGitDir).toBe(isolated.git?.commonGitDir);
      expect(accepted.git?.gitDir).not.toBe(isolated.git?.gitDir);
      expect(accepted.indexId).not.toBe(isolated.indexId);
      expect(
        (
          await f.service.search(
            { scope: f.scope, query: "fox", limit: 10 },
            f.context,
          )
        ).hits,
      ).toEqual([]);
      expect(
        (
          await f.service.search(
            { scope: workerScope, query: "fox", limit: 10 },
            f.context,
          )
        ).hits[0]?.text,
      ).toContain("unmerged fox");
      await run(f.root, ["checkout", "-qb", "revised-main"]);
      await writeFile(join(f.root, "notes.md"), "new branch eagle source");
      await run(f.root, ["add", "notes.md"]);
      await run(f.root, ["commit", "-qm", "revised fixture"]);
      const changed = await f.service.status({ scope: f.scope }, f.context);
      expect(changed.state).toBe("stale");
      expect(changed.reason).toBe("git_identity_changed");
      const refreshed = await f.ready();
      expect(refreshed.git?.head).not.toBe(accepted.git?.head);
      expect(
        (
          await f.service.search(
            { scope: f.scope, query: "eagle", limit: 10 },
            f.context,
          )
        ).hits[0]?.text,
      ).toContain("new branch eagle");
      expect(
        (await f.service.status({ scope: workerScope }, f.context)).git?.head,
      ).toBe(isolated.git?.head);
    } finally {
      await f.close();
    }
  }, 45_000);

  it("retains lexical chunks with a source-specific reason after embedding failure", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "notes.md"), "lexical zebra source");
      f.capability.beforeEmbed = async () => {
        throw new Error("fixture_inference_failed");
      };
      await f.start();
      const status = await f.ready();
      expect(status.semantic).toBe("partial");
      const sources = await f.service.sources(
        { scope: f.scope, cursor: null, limit: 100 },
        f.context,
      );
      expect(sources.sources[0]?.state).toBe("indexed");
      expect(sources.sources[0]?.reason).toBe("fixture_inference_failed");
      expect(sources.sources[0]?.chunks).toBeGreaterThan(0);
      expect(sources.sources[0]?.embeddedChunks).toBe(0);
      const result = await f.service.search(
        { scope: f.scope, query: "zebra", limit: 10 },
        f.context,
      );
      expect(result.mode).toBe("lexical");
      expect(result.hits[0]?.text).toContain("zebra");
    } finally {
      await f.close();
    }
  });

  it("uses actual SQLite FTS migrations and refuses a newer cache schema", async () => {
    const store = new ContextStore(":memory:");
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE name='context_fts'")
        .get()?.name,
    ).toBe("context_fts");
    store.close();
    const directory = await mkdtemp(join(tmpdir(), "arc-context-migration-"));
    try {
      const legacyPath = join(directory, "legacy.sqlite");
      const legacy = new ContextStore(legacyPath);
      legacy.db
        .prepare("INSERT INTO context_operations VALUES(?,?,?)")
        .run("scope-a", "operation-a", digest);
      legacy.db.exec("DROP TABLE context_stop_fences; PRAGMA user_version=1");
      legacy.close();
      const migrated = new ContextStore(legacyPath);
      try {
        expect(
          migrated.db.prepare("PRAGMA user_version").get()?.user_version,
        ).toBe(2);
        expect(
          migrated.db
            .prepare(
              "SELECT request_hash FROM context_operations WHERE scope_key=? AND operation_id=?",
            )
            .get("scope-a", "operation-a")?.request_hash,
        ).toBe(digest);
        expect(
          migrated.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='context_stop_fences'",
            )
            .get()?.name,
        ).toBe("context_stop_fences");
      } finally {
        migrated.close();
      }
      const path = join(directory, "newer.sqlite"),
        db = new DatabaseSync(path);
      db.exec("PRAGMA user_version=3");
      db.close();
      expect(() => new ContextStore(path)).toThrow(
        "Unsupported Context index version",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("admits at most four concurrent distinct roots after asynchronous identity checks", async () => {
    const f = await fixture({ available: false });
    try {
      const scopes: HostContextScope[] = [];
      for (let i = 0; i < 5; i++) {
        const path = join(f.root, `scope-${i}`);
        await mkdir(path);
        scopes.push({ ...f.scope, projectId: `project-${i}`, path });
      }
      const results = await Promise.allSettled(
        scopes.map((scope, i) => f.start(`operation-${i}`, scope)),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(4);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(f.watches).toBe(4);
      expect(f.leases).toBe(4);
    } finally {
      await f.close();
    }
  });
});

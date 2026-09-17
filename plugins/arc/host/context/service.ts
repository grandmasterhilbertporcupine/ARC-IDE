import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { z } from "zod";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchSubscription,
  ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import {
  hostContextCancelInputSchema,
  hostContextExcerptInputSchema,
  hostContextLimits,
  hostContextSearchInputSchema,
  hostContextSourcesInputSchema,
  hostContextStartInputSchema,
  hostContextStatusInputSchema,
  type HostContextHit,
  type HostContextReference,
  type HostContextScope,
  type HostContextStartInput,
  type HostContextStatus,
} from "../../host-context-contract.js";
import {
  directoryRootSchema,
  type DirectoryRoot,
} from "../../host-directory-contract.js";
import { inspectDirectoryRoot, sameDirectoryRoot } from "../directory.js";
import { containedPath } from "../git.js";
import {
  ContextStore,
  hashText,
  scopeKey,
  type ChunkRow,
  type SourceRow,
} from "./store.js";
import {
  embedChunks,
  exactChunks,
  lexicalChunks,
  type EmbeddingBinding,
} from "./chunk.js";
import {
  inspectContextGit,
  readSourceText,
  SourceReadFailure,
  textSkipReason,
  verifyRoot,
  walkTextRoot,
  type ScanEntry,
} from "./scan.js";

type HostContext = Pick<
  ExperimentalHostRpcContext,
  | "signal"
  | "lifecycle"
  | "experimental_watch"
  | "experimental_retainWorker"
  | "experimental_contextEmbeddings"
>;
type Job = {
  scope: HostContextScope;
  indexId: string;
  operationId: string;
  root: DirectoryRoot;
  references: HostContextReference[];
  context: HostContext;
  controller: AbortController;
  lease: ExperimentalHostWorkerLease;
  watches: ExperimentalHostWatchSubscription[];
  ready: boolean;
  watchFailed: boolean;
  watchVersion: number;
  full: boolean;
  pending: Set<string>;
  epoch: number;
  done: Promise<void> | null;
  binding: EmbeddingBinding | null;
  semanticReason: string | null;
  stopped: boolean;
  stopping: Promise<void> | null;
  lifecycleAbort: () => void;
};
const sourceId = (indexId: string, kind: "file" | "reference", key: string) =>
  `source_${hashText(JSON.stringify([indexId, kind, key])).slice(0, 48)}`;
const errorCode = (error: unknown) =>
  error instanceof SourceReadFailure
    ? error.code
    : error instanceof Error
      ? error.message.slice(0, 2048)
      : "context_operation_failed";
const isUnresolvedStop = (error: unknown) =>
  error instanceof SourceReadFailure &&
  error.code === "embedding_stop_unresolved";
const isMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";
const cursorSchema = z
  .object({
    indexId: z.string(),
    generation: z.number().int(),
    after: z.string(),
  })
  .strict();

export class HostContextService {
  private readonly jobs = new Map<string, Job>();
  private readonly controls = new Map<string, Promise<void>>();
  private readonly reconciliations = new Map<string, Promise<boolean>>();
  private readonly unresolvedLeases = new Map<
    string,
    Set<ExperimentalHostWorkerLease>
  >();
  private disposed = false;
  private constructor(private readonly store: ContextStore) {}

  static async open(dataDir: string): Promise<HostContextService> {
    await mkdir(join(dataDir, "context"), { recursive: true });
    return new HostContextService(
      new ContextStore(join(dataDir, "context", "text-index.sqlite")),
    );
  }

  private async control<T>(
    scope: HostContextScope,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = scopeKey(scope),
      previous = this.controls.get(key) ?? Promise.resolve();
    const work = previous.then(run, run);
    const tail = work.then(
      () => {},
      () => {},
    );
    this.controls.set(key, tail);
    try {
      return await work;
    } finally {
      if (this.controls.get(key) === tail) this.controls.delete(key);
    }
  }

  private signal(context: HostContext): AbortSignal {
    if (this.disposed) throw new Error("Context service is disposed.");
    const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
    signal.throwIfAborted();
    return signal;
  }

  private retainStop(scope: HostContextScope, generation: string | null): void {
    this.store.retainStopFence(scope, generation);
    const job = this.jobs.get(scopeKey(scope));
    if (job) {
      job.stopped = true;
      job.ready = false;
      job.controller.abort();
    }
  }

  private retainLease(
    scope: HostContextScope,
    lease: ExperimentalHostWorkerLease,
  ): void {
    const key = scopeKey(scope);
    const leases =
      this.unresolvedLeases.get(key) ?? new Set<ExperimentalHostWorkerLease>();
    leases.add(lease);
    this.unresolvedLeases.set(key, leases);
  }

  private async reconcileStop(
    scope: HostContextScope,
    context: HostContext,
  ): Promise<boolean> {
    if (!this.store.stopFence(scope)) {
      const job = this.jobs.get(scopeKey(scope));
      if (job?.stopped) {
        try {
          await this.stop(job);
        } catch (error) {
          if (isUnresolvedStop(error)) return false;
          throw error;
        }
      }
      await this.releaseLeases(scope);
      return this.store.stopFence(scope) === null;
    }
    const key = scopeKey(scope);
    const pending = this.reconciliations.get(key);
    if (pending) return pending;
    const work = this.reconcileOwnedStop(scope, context);
    this.reconciliations.set(key, work);
    try {
      return await work;
    } finally {
      if (this.reconciliations.get(key) === work)
        this.reconciliations.delete(key);
    }
  }

  private async reconcileOwnedStop(
    scope: HostContextScope,
    context: HostContext,
  ): Promise<boolean> {
    const job = this.jobs.get(scopeKey(scope));
    if (job) {
      try {
        await this.stop(job);
      } catch (error) {
        if (!isUnresolvedStop(error)) throw error;
      }
    }
    const fence = this.store.stopFence(scope);
    if (!fence) return true;
    if (fence.helper_generation === null) return false;
    const signal = this.signal(context);
    const lease = context.experimental_retainWorker();
    const model = await context.experimental_contextEmbeddings
      .status({ signal })
      .then(
        async (result) => {
          if (
            result.state === "unavailable" &&
            result.error.code === "stop_unresolved"
          )
            this.retainLease(scope, lease);
          else await lease.dispose();
          return result;
        },
        async (error: unknown) => {
          await lease.dispose();
          throw error;
        },
      );
    if (
      model.state === "unavailable" &&
      model.error.code === "stop_unresolved"
    ) {
      this.retainStop(scope, null);
      return false;
    }
    signal.throwIfAborted();
    if (model.state !== "ready" || model.generation === fence.helper_generation)
      return false;
    if (!this.store.clearStopFence(scope, fence.fence_id)) return false;
    if (job) {
      try {
        await this.stop(job);
      } catch (error) {
        if (isUnresolvedStop(error)) return false;
        throw error;
      }
    }
    await this.releaseLeases(scope);
    return this.store.stopFence(scope) === null;
  }

  private async releaseLeases(scope: HostContextScope): Promise<void> {
    if (this.store.stopFence(scope)) return;
    const key = scopeKey(scope);
    const leases = this.unresolvedLeases.get(key);
    if (leases) {
      await Promise.all(
        [...leases].map(async (lease) => {
          await lease.dispose();
          leases.delete(lease);
        }),
      );
      if (leases.size === 0 && this.unresolvedLeases.get(key) === leases)
        this.unresolvedLeases.delete(key);
    }
  }

  private validateReferences(input: HostContextStartInput): void {
    const refs = [...input.references].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
      throw new Error("Context reference IDs must be unique.");
    let total = 0;
    for (const ref of refs) {
      const bytes = Buffer.from(ref.text, "utf8");
      total += bytes.length;
      if (
        bytes.length > hostContextLimits.maxReferenceBytes ||
        hashText(bytes) !== ref.sha256 ||
        ref.text.includes("\0")
      )
        throw new Error(
          "Context reference content does not match its bounded UTF-8 identity.",
        );
    }
    if (total > hostContextLimits.maxReferenceTotalBytes)
      throw new Error("Context reference collection exceeds its byte limit.");
    const digest = hashText(
      JSON.stringify(
        refs.map(({ id, sha256, revision, name }) => ({
          id,
          sha256,
          revision,
          name,
        })),
      ),
    );
    if (digest !== input.scope.referenceDigest)
      throw new Error("Context reference catalog digest does not match.");
  }

  async start(
    raw: z.infer<typeof hostContextStartInputSchema>,
    context: HostContext,
  ): Promise<HostContextStatus> {
    const input = hostContextStartInputSchema.parse(raw);
    return this.control(input.scope, async () => {
      const signal = this.signal(context);
      if (!isAbsolute(input.scope.path))
        throw new Error("Context root must be an authorized absolute path.");
      this.validateReferences(input);
      if (!(await this.reconcileStop(input.scope, context)))
        throw new Error(
          "Context helper cleanup needs verification before indexing can restart.",
        );
      const requestHash = hashText(
        JSON.stringify({ scope: input.scope, references: input.references }),
      );
      const replay = this.store.replay(
        input.scope,
        input.operationId,
        requestHash,
      );
      const existing = this.jobs.get(scopeKey(input.scope));
      if (replay && existing?.operationId === input.operationId)
        return this.store.status(input.scope);
      const current = this.store.index(input.scope);
      if (replay && current?.reason !== "host_restarted")
        return this.checkedStatus(input.scope, context);
      if (existing) {
        try {
          await this.stop(existing);
        } catch (error) {
          if (isUnresolvedStop(error)) return this.store.status(input.scope);
          throw error;
        }
      }
      if (this.jobs.size >= hostContextLimits.maxWatchedIndexes)
        throw new Error(
          "Context watch capacity reached; cancel an existing index before starting another.",
        );
      const root = await inspectDirectoryRoot(input.scope.path);
      const git = await inspectContextGit(root.path, signal);
      signal.throwIfAborted();
      if (
        replay &&
        current &&
        !sameDirectoryRoot(
          root,
          directoryRootSchema.parse(JSON.parse(current.root_json)),
        )
      )
        throw new Error(
          "Context root changed; start a new indexing operation.",
        );
      if (this.jobs.size >= hostContextLimits.maxWatchedIndexes)
        throw new Error(
          "Context watch capacity reached; cancel an existing index before starting another.",
        );
      const index = replay
        ? current
        : this.store.start(
            input.scope,
            input.operationId,
            requestHash,
            root,
            git,
          );
      if (!index) throw new Error("Context index admission is unavailable.");
      if (replay)
        this.store.update(input.scope, {
          state: "indexing",
          coverage: "unknown",
          reason: null,
          git,
        });
      const controller = new AbortController();
      const job: Job = {
        scope: input.scope,
        indexId: index.index_id,
        operationId: input.operationId,
        root,
        references: input.references,
        context,
        controller,
        lease: context.experimental_retainWorker(),
        watches: [],
        ready: false,
        watchFailed: false,
        watchVersion: 0,
        full: true,
        pending: new Set(),
        epoch: this.store.nextEpoch(index.index_id),
        done: null,
        binding: null,
        semanticReason: null,
        stopped: false,
        stopping: null,
        lifecycleAbort: () => {},
      };
      job.lifecycleAbort = () => {
        void this.stop(job).catch(() => {});
      };
      context.lifecycle.signal.addEventListener("abort", job.lifecycleAbort, {
        once: true,
      });
      this.jobs.set(scopeKey(input.scope), job);
      try {
        const watched = new Set([
          root.path,
          ...(git ? [git.gitDir, git.commonGitDir] : []),
        ]);
        for (const path of watched) {
          const watch = await context.experimental_watch(
            { rootPath: path, debounceMs: 25, maxWaitMs: 100 },
            (event) => {
              if (job.stopped || this.disposed) return;
              job.watchVersion++;
              if (event.kind !== "changed" || path !== root.path) {
                job.full = true;
                if (event.kind === "watch-error") job.watchFailed = true;
                this.store.invalidate(
                  job.scope,
                  null,
                  event.kind === "changed" ? "git_changed" : event.kind,
                );
              } else {
                const paths: string[] = [];
                for (const change of event.changes) {
                  let suffix: string;
                  try {
                    suffix = relative(
                      root.path,
                      containedPath(root.path, change.path),
                    )
                      .split(sep)
                      .join("/");
                  } catch {
                    job.full = true;
                    continue;
                  }
                  if (suffix === ".git" || suffix.startsWith(".git/")) {
                    job.full = true;
                    continue;
                  }
                  if (textSkipReason(suffix) === "excluded_directory") continue;
                  const known = this.store.source(
                    sourceId(job.indexId, "file", suffix),
                    job.indexId,
                  );
                  if (
                    !known ||
                    known.reason === "excluded_directory" ||
                    known.reason === "depth_limit"
                  )
                    job.full = true;
                  paths.push(suffix);
                  job.pending.add(suffix);
                }
                if (job.full || paths.length)
                  this.store.invalidate(
                    job.scope,
                    job.full ? null : paths,
                    "filesystem_changed",
                  );
              }
              this.run(job);
            },
          );
          job.watches.push(watch);
          signal.throwIfAborted();
        }
        job.ready = true;
        this.run(job);
        return this.store.status(input.scope);
      } catch (error) {
        await this.stop(job);
        this.store.update(input.scope, {
          state: "failed",
          coverage: "unknown",
          reason: errorCode(error),
        });
        throw error;
      }
    });
  }

  private run(job: Job): void {
    if (job.done || !job.ready || job.stopped || this.disposed) return;
    job.done = this.drain(job)
      .catch((error) => {
        job.full = false;
        job.pending.clear();
        if (isUnresolvedStop(error))
          this.retainStop(job.scope, job.binding?.generation ?? null);
        else if (!job.stopped && !this.disposed)
          this.store.update(job.scope, {
            state: "failed",
            coverage: "partial",
            reason: errorCode(error),
          });
      })
      .finally(() => {
        job.done = null;
        if (this.store.stopFence(job.scope))
          void this.stop(job).catch(() => {});
        if (!job.stopped && (job.full || job.pending.size)) this.run(job);
      });
  }

  private async drain(job: Job): Promise<void> {
    const signal = job.controller.signal;
    const capability = job.context.experimental_contextEmbeddings;
    job.binding = null;
    const model = capability ? await capability.status({ signal }) : null;
    if (
      model?.state === "unavailable" &&
      model.error.code === "stop_unresolved"
    )
      throw new SourceReadFailure("embedding_stop_unresolved");
    signal.throwIfAborted();
    job.binding =
      model?.state === "ready"
        ? {
            manifestDigest: model.descriptor.manifestDigest,
            generation: model.generation,
          }
        : null;
    job.semanticReason =
      model?.state === "unavailable"
        ? model.error.code
        : model
          ? null
          : "host_upgrade_required";
    this.store.update(job.scope, {
      semantic: job.binding ? "pending" : "unavailable",
      manifestDigest: job.binding?.manifestDigest ?? null,
    });
    while (job.full || job.pending.size) {
      signal.throwIfAborted();
      await verifyRoot(job.root);
      const full = job.full;
      job.full = false;
      const paths = [...job.pending];
      job.pending.clear();
      const version = job.watchVersion,
        epoch = ++job.epoch;
      if (full) {
        const git = await inspectContextGit(job.root.path, signal);
        this.store.update(job.scope, { git });
        for await (const entry of walkTextRoot(job.root, signal))
          await this.processEntry(job, entry, epoch);
        for (const reference of job.references)
          await this.processReference(job, reference, epoch);
        if (job.watchVersion === version)
          this.store.finishTraversal(job.indexId, epoch);
        else job.full = true;
      } else {
        for (const path of paths)
          await this.processEntry(
            job,
            { path, name: path, reason: null, directory: false },
            epoch,
          );
      }
      await yieldTurn();
    }
    signal.throwIfAborted();
    await verifyRoot(job.root);
    signal.throwIfAborted();
    const status = this.store.status(job.scope);
    this.store.update(job.scope, {
      state: job.watchFailed ? "stale" : "ready",
      coverage: job.watchFailed
        ? "unknown"
        : status.counts.failed || status.counts.stale
          ? "partial"
          : "complete",
      semantic: !job.binding
        ? "unavailable"
        : status.counts.embeddedChunks === status.counts.chunks
          ? "ready"
          : "partial",
      reason: job.watchFailed
        ? "watch_error_requires_reindex"
        : job.semanticReason,
    });
  }

  private async processEntry(
    job: Job,
    entry: ScanEntry,
    epoch: number,
  ): Promise<void> {
    const id = sourceId(job.indexId, "file", entry.path);
    const old = this.store.source(id, job.indexId);
    const source = this.store.ensureSource(
      job.indexId,
      {
        id,
        name: entry.name,
        kind: "file",
        path: entry.path,
        revision: Math.max(1, old?.revision ?? 1),
      },
      epoch,
    );
    const skipped = entry.reason ?? textSkipReason(entry.path);
    if (skipped) {
      this.store.mark(source, "skipped", skipped);
      return;
    }
    try {
      const content = await readSourceText(
        job.root,
        entry.path,
        job.controller.signal,
      );
      const revision =
        source.sha && source.sha !== content.sha
          ? source.revision + 1
          : source.revision;
      await this.processText(
        job,
        source,
        content.text,
        content.sha,
        content.size,
        revision,
        source.name,
      );
    } catch (error) {
      if (isUnresolvedStop(error)) throw error;
      job.controller.signal.throwIfAborted();
      if (isMissing(error))
        this.store.mark(source, "deleted", "source_removed");
      else if (
        error instanceof SourceReadFailure &&
        [
          "binary_content",
          "invalid_utf8",
          "file_size_limit",
          "link_or_junction",
          "unsupported_entry",
        ].includes(error.code)
      )
        this.store.mark(source, "skipped", error.code, error.size);
      else this.store.mark(source, "failed", errorCode(error));
    }
  }

  private async processReference(
    job: Job,
    reference: HostContextReference,
    epoch: number,
  ): Promise<void> {
    const source = this.store.ensureSource(
      job.indexId,
      {
        id: sourceId(job.indexId, "reference", reference.id),
        name: reference.name,
        kind: "reference",
        path: null,
        revision: reference.revision,
      },
      epoch,
    );
    await this.processText(
      job,
      source,
      reference.text,
      reference.sha256,
      Buffer.byteLength(reference.text),
      reference.revision,
      reference.name,
    );
  }

  private async processText(
    job: Job,
    source: SourceRow,
    text: string,
    sha: string,
    size: number,
    revision: number,
    name: string,
  ): Promise<void> {
    const signal = job.controller.signal;
    signal.throwIfAborted();
    if (!this.store.content(source, text, sha, size, revision, name)) return;
    let lexical;
    try {
      lexical = lexicalChunks(source, sha, text);
    } catch (error) {
      this.store.mark(source, "failed", errorCode(error), size);
      return;
    }
    if (
      !this.store.commit(
        job.scope,
        job.operationId,
        source,
        sha,
        lexical,
        null,
      ) ||
      !job.binding ||
      !text
    )
      return;
    try {
      const chunks = await exactChunks(
        { ...source, name },
        sha,
        text,
        job.context.experimental_contextEmbeddings,
        job.binding,
        signal,
        () =>
          this.store.source(source.id, source.index_id)?.generation ===
          source.generation,
      );
      signal.throwIfAborted();
      if (!(await this.currentSource(job, source, sha))) return;
      if (
        !this.store.commit(
          job.scope,
          job.operationId,
          source,
          sha,
          chunks,
          job.binding.manifestDigest,
        )
      )
        return;
      for (let offset = 0; offset < chunks.length; offset += 8) {
        const result = await embedChunks(
          name,
          chunks.slice(offset, offset + 8),
          job.context.experimental_contextEmbeddings,
          job.binding,
          signal,
        );
        signal.throwIfAborted();
        if (!(await this.currentSource(job, source, sha))) return;
        if (
          !this.store.vectors(
            job.scope,
            job.operationId,
            source,
            sha,
            job.binding.manifestDigest,
            result,
          )
        )
          return;
        await yieldTurn();
      }
    } catch (error) {
      if (isUnresolvedStop(error)) throw error;
      signal.throwIfAborted();
      if (
        error instanceof SourceReadFailure &&
        error.code === "chunk_count_limit"
      )
        this.store.mark(source, "failed", error.code, size);
      else {
        job.semanticReason = errorCode(error);
        this.store.mark(source, "indexed", job.semanticReason, size);
      }
    }
  }

  private async currentSource(
    job: Job,
    source: SourceRow,
    sha: string,
  ): Promise<boolean> {
    if (
      this.store.source(source.id, source.index_id)?.generation !==
      source.generation
    )
      return false;
    if (source.kind === "file" && source.path !== null) {
      try {
        const current = await readSourceText(
          job.root,
          source.path,
          job.controller.signal,
        );
        if (current.sha !== sha)
          throw new SourceReadFailure("source_changed_during_embedding");
      } catch (error) {
        job.controller.signal.throwIfAborted();
        this.store.invalidate(job.scope, [source.path], errorCode(error));
        job.pending.add(source.path);
        return false;
      }
    }
    return (
      this.store.source(source.id, source.index_id)?.generation ===
      source.generation
    );
  }

  private async stop(job: Job): Promise<void> {
    if (job.stopping) return job.stopping;
    const stopping = this.stopOwned(job);
    job.stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (job.stopping === stopping) job.stopping = null;
    }
  }

  private async stopOwned(job: Job): Promise<void> {
    job.stopped = true;
    job.ready = false;
    job.controller.abort();
    job.context.lifecycle.signal.removeEventListener(
      "abort",
      job.lifecycleAbort,
    );
    const watchers = await Promise.allSettled(
      job.watches.map((watch) => watch.dispose()),
    );
    if (job.done) await job.done;
    if (this.store.stopFence(job.scope))
      throw new SourceReadFailure("embedding_stop_unresolved");
    const failed = watchers.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      throw new Error(
        `Context watch stop was not confirmed: ${errorCode(failed.reason)}`,
      );
    await job.lease.dispose();
    if (this.jobs.get(scopeKey(job.scope)) === job)
      this.jobs.delete(scopeKey(job.scope));
  }

  private async checkedStatus(
    scope: HostContextScope,
    context: HostContext,
  ): Promise<HostContextStatus> {
    const signal = this.signal(context),
      index = this.store.index(scope);
    if (!index) return this.store.status(scope);
    if (!(await this.reconcileStop(scope, context)))
      return this.store.status(scope);
    const saved = this.store.status(scope);
    if (saved.scope.referenceDigest !== scope.referenceDigest) {
      const job = this.jobs.get(scopeKey(scope));
      if (job) await this.stop(job);
      if (
        saved.state !== "stale" ||
        saved.reason !== "reference_catalog_changed"
      )
        this.store.invalidate(
          scope,
          null,
          "reference_catalog_changed",
          "stale",
        );
      return this.store.status(scope);
    }
    try {
      if (!saved.root) throw new SourceReadFailure("root_identity_unavailable");
      await verifyRoot(saved.root);
      const git = await inspectContextGit(saved.root.path, signal);
      if (JSON.stringify(git) !== JSON.stringify(saved.git)) {
        this.store.invalidate(scope, null, "git_identity_changed", "stale");
        const job = this.jobs.get(scopeKey(scope));
        if (job) {
          job.full = true;
          this.run(job);
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      const job = this.jobs.get(scopeKey(scope));
      if (job) await this.stop(job);
      if (saved.state !== "stale" || saved.reason !== errorCode(error))
        this.store.invalidate(scope, null, errorCode(error), "stale");
    }
    return this.store.status(scope);
  }

  async status(
    raw: z.infer<typeof hostContextStatusInputSchema>,
    context: HostContext,
  ): Promise<HostContextStatus> {
    const input = hostContextStatusInputSchema.parse(raw);
    return this.checkedStatus(input.scope, context);
  }

  async sources(
    raw: z.infer<typeof hostContextSourcesInputSchema>,
    context: HostContext,
  ) {
    const input = hostContextSourcesInputSchema.parse(raw),
      status = await this.checkedStatus(input.scope, context);
    if (!status.indexId) return { status, sources: [], nextCursor: null };
    let after = "";
    if (input.cursor) {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.indexId !== status.indexId ||
        cursor.generation !== status.generation
      )
        throw new Error(
          "Context source cursor is stale; restart from the first page.",
        );
      after = cursor.after;
    }
    const rows = this.store.sources(status.indexId, after, input.limit + 1);
    const sources = rows.slice(0, input.limit),
      last = sources.at(-1);
    return {
      status,
      sources,
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                indexId: status.indexId,
                generation: status.generation,
                after: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }

  private async freshHit(
    scope: HostContextScope,
    status: HostContextStatus,
    chunk: ChunkRow,
    signal: AbortSignal,
  ): Promise<HostContextHit | null> {
    if (!status.indexId || !status.root) return null;
    const source = this.store.source(chunk.source_id, status.indexId);
    if (
      !source ||
      source.generation !== chunk.source_gen ||
      source.sha !== chunk.sha ||
      source.state !== "indexed"
    )
      return null;
    try {
      let text = source.text;
      if (source.kind === "file") {
        if (status.coverage === "unknown" || source.path === null) return null;
        const observed = await readSourceText(status.root, source.path, signal);
        if (observed.sha !== source.sha)
          throw new SourceReadFailure("excerpt_content_changed");
        text = observed.text;
      }
      if (
        text === null ||
        hashText(text) !== chunk.sha ||
        text.slice(chunk.start_offset, chunk.end_offset) !== chunk.text
      )
        throw new SourceReadFailure("excerpt_content_changed");
      if (
        this.store.status(scope).scope.referenceDigest !== scope.referenceDigest
      )
        return null;
      const current = this.store.source(source.id, status.indexId);
      if (
        !current ||
        current.generation !== chunk.source_gen ||
        current.state !== "indexed"
      )
        return null;
      return {
        indexId: status.indexId,
        indexGeneration: this.store.status(scope).generation,
        chunkId: chunk.chunk_id,
        sourceId: source.id,
        sourceGeneration: source.generation,
        sourceRevision: source.revision,
        sha256: chunk.sha,
        name: source.name,
        kind: source.kind,
        relativePath: source.path,
        authority: "reference",
        startOffset: chunk.start_offset,
        endOffset: chunk.end_offset,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        tokenCount: chunk.token_count,
        text: chunk.text,
        lexicalRank: null,
        semanticRank: null,
        score: 0,
      };
    } catch (error) {
      signal.throwIfAborted();
      this.store.invalidate(
        scope,
        source.path === null ? null : [source.path],
        errorCode(error),
        "stale",
      );
      const job = this.jobs.get(scopeKey(scope));
      if (job) {
        if (source.path === null) job.full = true;
        else job.pending.add(source.path);
        this.run(job);
      }
      return null;
    }
  }

  async excerpt(
    raw: z.infer<typeof hostContextExcerptInputSchema>,
    context: HostContext,
  ) {
    const input = hostContextExcerptInputSchema.parse(raw),
      signal = this.signal(context),
      status = await this.checkedStatus(input.scope, context);
    const chunk =
      status.indexId === input.indexId
        ? this.store.chunk(input.indexId, input.chunkId)
        : null;
    const hit =
      chunk &&
      chunk.source_gen === input.sourceGeneration &&
      chunk.sha === input.sha256
        ? await this.freshHit(input.scope, status, chunk, signal)
        : null;
    return {
      status: this.store.status(input.scope),
      state: hit ? ("current" as const) : ("stale" as const),
      hit,
    };
  }

  async search(
    raw: z.infer<typeof hostContextSearchInputSchema>,
    context: HostContext,
  ) {
    const input = hostContextSearchInputSchema.parse(raw),
      signal = this.signal(context);
    let status = await this.checkedStatus(input.scope, context);
    let mode: "hybrid" | "lexical" = "lexical",
      reason: string | null = null,
      semanticTruncated = false;
    const hits: HostContextHit[] = [];
    if (
      !status.indexId ||
      this.store.stopFence(input.scope) ||
      status.scope.referenceDigest !== input.scope.referenceDigest
    )
      return {
        status,
        mode,
        reason: this.store.stopFence(input.scope)
          ? "embedding_stop_unresolved"
          : "index_unavailable",
        semanticTruncated,
        hits,
      };
    const words = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 40) ?? [];
    const expression = words
      .map((word) => `"${word.replaceAll('"', '""')}"`)
      .join(" OR ");
    let lexical = expression
      ? this.store.lexical(status.indexId, expression, input.limit * 4)
      : [];
    const semantic: Array<{ row: ChunkRow; similarity: number }> = [];
    const initialGeneration = status.generation;
    const lease = context.experimental_retainWorker();
    let retainedLease = false;
    let queryBinding: EmbeddingBinding | null = null;
    try {
      const capability = context.experimental_contextEmbeddings;
      const model = capability ? await capability.status({ signal }) : null;
      if (
        model?.state === "unavailable" &&
        model.error.code === "stop_unresolved"
      )
        throw new SourceReadFailure("embedding_stop_unresolved");
      signal.throwIfAborted();
      if (model?.state !== "ready")
        reason =
          model?.state === "unavailable"
            ? model.error.code
            : "host_upgrade_required";
      else if (model.descriptor.manifestDigest !== status.manifestDigest)
        reason = "index_model_pending";
      else {
        const binding = {
          generation: model.generation,
          manifestDigest: model.descriptor.manifestDigest,
        };
        queryBinding = binding;
        const requestId = randomUUID();
        const count = await capability.countTokens(
          {
            requestId,
            expectedManifestDigest: binding.manifestDigest,
            expectedGeneration: binding.generation,
            items: [{ id: "query", text: input.query }],
          },
          { signal },
        );
        if (count.state === "failed" && count.error.code === "stop_unresolved")
          throw new SourceReadFailure("embedding_stop_unresolved");
        signal.throwIfAborted();
        if (count.state === "failed") reason = count.error.code;
        else if (
          count.requestId !== requestId ||
          count.generation !== binding.generation ||
          count.manifestDigest !== binding.manifestDigest ||
          count.items.length !== 1 ||
          count.items[0]?.id !== "query"
        )
          reason = "embedding_binding_changed";
        else if (count.items[0].tokenCount > 256) reason = "query_token_limit";
        else {
          const embedId = randomUUID();
          const embedded = await capability.embed(
            {
              requestId: embedId,
              expectedManifestDigest: binding.manifestDigest,
              expectedGeneration: binding.generation,
              items: [{ id: "query", text: input.query }],
            },
            { signal },
          );
          if (
            embedded.state === "failed" &&
            embedded.error.code === "stop_unresolved"
          )
            throw new SourceReadFailure("embedding_stop_unresolved");
          signal.throwIfAborted();
          if (embedded.state === "failed") reason = embedded.error.code;
          else if (
            embedded.requestId !== embedId ||
            embedded.generation !== binding.generation ||
            embedded.manifestDigest !== binding.manifestDigest ||
            embedded.items.length !== 1 ||
            embedded.items[0]?.id !== "query"
          )
            reason = "embedding_binding_changed";
          else {
            const query = embedded.items[0].vector,
              started = performance.now();
            let after = 0;
            for (;;) {
              const page = this.store.vectorPage(
                status.indexId,
                binding.manifestDigest,
                after,
                hostContextLimits.vectorPageSize,
              );
              for (const row of page) {
                if (!row.vector || row.vector.byteLength !== 384 * 4)
                  throw new Error("Invalid stored Context vector.");
                const bytes = Buffer.from(row.vector);
                let similarity = 0;
                for (let i = 0; i < 384; i++)
                  similarity += (query[i] ?? 0) * bytes.readFloatLE(i * 4);
                if (!Number.isFinite(similarity))
                  throw new Error("Invalid stored Context vector.");
                semantic.push({ row, similarity });
                semantic.sort(
                  (a, b) =>
                    b.similarity - a.similarity || a.row.rowid - b.row.rowid,
                );
                if (semantic.length > input.limit * 4) semantic.pop();
                after = row.rowid;
              }
              if (page.length < hostContextLimits.vectorPageSize) break;
              await yieldTurn();
              signal.throwIfAborted();
              if (
                performance.now() - started >
                hostContextLimits.maxSemanticScanMs
              ) {
                semanticTruncated = true;
                break;
              }
            }
            mode = "hybrid";
          }
        }
      }
    } catch (error) {
      if (isUnresolvedStop(error)) {
        this.retainStop(input.scope, queryBinding?.generation ?? null);
        const key = scopeKey(input.scope);
        this.retainLease(input.scope, lease);
        retainedLease = true;
        const job = this.jobs.get(key);
        if (job) void this.stop(job).catch(() => {});
        return {
          status: this.store.status(input.scope),
          mode: "lexical" as const,
          reason: "embedding_stop_unresolved",
          semanticTruncated: false,
          hits: [],
        };
      }
      signal.throwIfAborted();
      reason = errorCode(error);
      semantic.length = 0;
    } finally {
      if (!retainedLease) await lease.dispose();
    }
    status = this.store.status(input.scope);
    if (status.generation !== initialGeneration) {
      semantic.length = 0;
      mode = "lexical";
      reason = "index_changed_during_search";
      lexical =
        status.indexId && expression
          ? this.store.lexical(status.indexId, expression, input.limit * 4)
          : [];
    }
    const combined = new Map<
      string,
      {
        row: ChunkRow;
        lexicalRank: number | null;
        semanticRank: number | null;
        score: number;
      }
    >();
    lexical.forEach((row, i) =>
      combined.set(row.chunk_id, {
        row,
        lexicalRank: i + 1,
        semanticRank: null,
        score: 1 / (61 + i),
      }),
    );
    semantic.forEach(({ row }, i) => {
      const prior = combined.get(row.chunk_id);
      combined.set(row.chunk_id, {
        row,
        lexicalRank: prior?.lexicalRank ?? null,
        semanticRank: i + 1,
        score: (prior?.score ?? 0) + 1 / (61 + i),
      });
    });
    let characters = 0;
    for (const item of [...combined.values()].sort(
      (a, b) => b.score - a.score || a.row.rowid - b.row.rowid,
    )) {
      const hit = await this.freshHit(input.scope, status, item.row, signal);
      if (!hit) continue;
      if (characters + hit.text.length > 16_000) break;
      characters += hit.text.length;
      hits.push({
        ...hit,
        lexicalRank: item.lexicalRank,
        semanticRank: item.semanticRank,
        score: item.score,
      });
      if (hits.length >= input.limit) break;
    }
    const finalStatus = this.store.status(input.scope);
    const currentHits =
      finalStatus.indexId &&
      finalStatus.scope.referenceDigest === input.scope.referenceDigest
        ? hits
            .filter((hit) => {
              const chunk = this.store.chunk(hit.indexId, hit.chunkId);
              return (
                hit.indexId === finalStatus.indexId &&
                chunk?.source_gen === hit.sourceGeneration &&
                chunk.sha === hit.sha256
              );
            })
            .map((hit) => ({ ...hit, indexGeneration: finalStatus.generation }))
        : [];
    if (currentHits.length !== hits.length)
      reason = "index_changed_during_search";
    return {
      status: finalStatus,
      mode,
      reason,
      semanticTruncated,
      hits: currentHits,
    };
  }

  async cancel(
    raw: z.infer<typeof hostContextCancelInputSchema>,
    context: HostContext,
  ): Promise<HostContextStatus> {
    const input = hostContextCancelInputSchema.parse(raw);
    return this.control(input.scope, async () => {
      this.signal(context);
      const index = this.store.index(input.scope);
      if (!index || index.operation_id !== input.operationId)
        throw new Error(
          "Context cancellation does not match the current operation.",
        );
      const job = this.jobs.get(scopeKey(input.scope));
      if (!(await this.reconcileStop(input.scope, context)))
        return this.store.status(input.scope);
      if (job) {
        try {
          await this.stop(job);
        } catch (error) {
          if (isUnresolvedStop(error)) return this.store.status(input.scope);
          throw error;
        }
      }
      this.store.invalidate(
        input.scope,
        null,
        "indexing_cancelled",
        "cancelled",
      );
      return this.store.status(input.scope);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await Promise.all([...this.controls.values()]);
      await Promise.all([...this.reconciliations.values()]);
      await Promise.all([...this.jobs.values()].map((job) => this.stop(job)));
      if (this.unresolvedLeases.size)
        throw new SourceReadFailure("embedding_stop_unresolved");
      this.store.close();
    } catch (error) {
      this.disposed = false;
      throw error;
    }
  }
}

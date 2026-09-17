import { useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Icon } from "@bb/shared-ui/icon";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import type { z } from "zod";
import { errorMessage, useStudioQuery } from "../studio/data.js";
import { arcContextRpcContract, type ContextTarget } from "./contract.js";
import type {
  HostContextHit,
  HostContextStatus,
} from "../host-context-contract.js";
import {
  CONTEXT_REFERENCE_LIMITS,
  type ContextReference,
} from "./reference-contract.js";
import {
  contextProject,
  latestContextStatus,
  readReferenceFile,
  useContextRead,
} from "./ui-data.js";

type SearchResult = z.infer<typeof arcContextRpcContract.searchContext.output>;
type Excerpt = z.infer<typeof arcContextRpcContract.readContextExcerpt.output>;
type Original = z.infer<
  typeof arcContextRpcContract.readContextReference.output
>;
type ImportRequest = z.infer<
  typeof arcContextRpcContract.importContextSource.input
>;
type ArchiveRequest = z.infer<
  typeof arcContextRpcContract.archiveContextReference.input
>;
const selectClass =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const statusLabels: Record<HostContextStatus["state"], string> = {
  absent: "Not indexed",
  indexing: "Indexing",
  ready: "Ready",
  stale: "Changes detected",
  cancelled: "Indexing cancelled",
  failed: "Indexing failed",
};

export function ContextPanel({ subPath }: PluginNavPanelProps) {
  const projectId = contextProject(subPath);
  const navigate = useBbNavigate();
  const projects = useStudioQuery("context-projects", (rpc) =>
    rpc.call("listStudioProjects", null),
  );
  return (
    <section
      className="@container/context flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
      aria-label="Project Context"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h1 className="text-base font-medium">Context</h1>
          <p className="text-xs text-muted-foreground">
            Project files and saved references, with their sources attached.
          </p>
        </div>
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          Project
          <select
            aria-label="Context project"
            className={`${selectClass} max-w-64 text-foreground`}
            value={projectId ?? ""}
            onChange={(event) =>
              navigate.toPluginPanel("context", {
                subPath: event.target.value
                  ? `project/${encodeURIComponent(event.target.value)}`
                  : "",
              })
            }
          >
            <option value="">
              {projects.loading ? "Loading projects…" : "Choose a project"}
            </option>
            {projectId &&
            !projects.data?.projects.some(
              (project) => project.id === projectId,
            ) ? (
              <option value={projectId}>{projectId}</option>
            ) : null}
            {projects.data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {projects.error ? (
        <Notice error={projects.error} retry={projects.refresh} />
      ) : null}
      {projectId ? (
        <ProjectContext key={projectId} projectId={projectId} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          Choose a project to browse and search its files and saved references.
        </div>
      )}
    </section>
  );
}

function Notice({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-destructive-text"
    >
      <span>{error}</span>
      {retry ? (
        <Button size="sm" variant="ghost" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function ProjectContext({ projectId }: { projectId: string }) {
  const [hostId, setHostId] = useState<string | null>(null);
  const setup = useContextRead(`setup:${projectId}:${hostId}`, (rpc) =>
    rpc.call("getContextSetup", { projectId, hostId }),
  );
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Icon name="Folder" className="size-3.5 text-muted-foreground" />
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          Source
          <select
            aria-label="Context source"
            className={`${selectClass} w-full max-w-xl text-foreground`}
            value={hostId ?? setup.data?.target.hostId ?? ""}
            onChange={(event) => setHostId(event.target.value || null)}
            disabled={!setup.data}
          >
            {!setup.data ? (
              <option value="">
                {setup.error ? "Source unavailable" : "Loading source…"}
              </option>
            ) : null}
            {setup.data?.sources.map((source) => (
              <option key={source.hostId} value={source.hostId}>
                {source.path} · {source.hostId}
              </option>
            ))}
          </select>
        </label>
      </div>
      {setup.error ? (
        <Notice error={setup.error} retry={setup.refresh} />
      ) : null}
      {setup.data ? (
        <SourceContext
          key={JSON.stringify(setup.data.target)}
          target={setup.data.target}
        />
      ) : !setup.error ? (
        <p role="status" className="p-4 text-xs text-muted-foreground">
          Loading project sources…
        </p>
      ) : null}
    </>
  );
}

function SourceContext({ target }: { target: ContextTarget }) {
  const rpc = useRpc<typeof arcContextRpcContract>();
  const status = useContextRead(
    "status",
    (client) => client.call("getContextStatus", { target }),
    3000,
  );
  const pageVersion = `${status.data?.generation ?? 0}:${status.data?.scope.referenceDigest ?? ""}`;
  const [pages, setPages] = useState<{
    version: string;
    cursors: Array<string | null>;
  }>({ version: pageVersion, cursors: [null] });
  const cursorHistory = pages.version === pageVersion ? pages.cursors : [null];
  const cursor = cursorHistory.at(-1) ?? null;
  const [refresh, setRefresh] = useState(0);
  const sourceVersion = `${status.data?.generation ?? 0}:${status.data?.scope.referenceDigest ?? ""}:${status.data?.state ?? ""}:${status.data?.counts.indexed ?? 0}:${status.data?.counts.failed ?? 0}:${status.data?.counts.skipped ?? 0}`;
  const sources = useContextRead(
    `sources:${sourceVersion}:${cursor}:${refresh}`,
    (client) =>
      client.call("listContextSources", { target, cursor, limit: 50 }),
  );
  const references = useContextRead(
    `references:${status.data?.scope.referenceDigest ?? ""}:${refresh}`,
    (client) =>
      client.call("listContextReferences", { projectId: target.projectId }),
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const [selected, setSelected] = useState<
    | { kind: "hit"; hit: HostContextHit }
    | { kind: "reference"; source: ContextReference }
    | null
  >(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const detailsTrigger = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingIndex, setPendingIndex] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ImportRequest | null>(
    null,
  );
  const [pendingArchive, setPendingArchive] = useState<ArchiveRequest | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const replacement = useRef<ContextReference | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      searchSequence.current += 1;
    };
  }, []);
  const current = latestContextStatus(
    search?.status,
    sources.data?.status,
    status.data,
  );
  const retryIndex =
    pendingIndex !== null && pendingIndex !== current?.operationId;
  const detailVersion = `${current?.indexId ?? ""}:${current?.generation ?? 0}:${current?.scope.referenceDigest ?? ""}:${current?.state ?? ""}`;
  const outdated =
    search !== null &&
    current !== null &&
    (search.status.indexId !== current.indexId ||
      search.status.generation !== current.generation ||
      search.status.scope.referenceDigest !== current.scope.referenceDigest ||
      current.state !== "ready");

  function reload() {
    status.refresh();
    setRefresh((value) => value + 1);
  }

  async function index() {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    const operationId =
      pendingIndex && retryIndex ? pendingIndex : crypto.randomUUID();
    setPendingIndex(operationId);
    try {
      await rpc.call("reindexContext", {
        target,
        operationId,
      });
      if (!alive.current) return;
      setPendingIndex(null);
      reload();
    } catch (failure) {
      if (alive.current) setActionError(errorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!current?.operationId) return;
    setBusy(true);
    setActionError(null);
    try {
      await rpc.call("cancelContextIndexing", {
        target,
        operationId: current.operationId,
      });
      if (alive.current) reload();
    } catch (failure) {
      if (alive.current) setActionError(errorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function saveReference(request: ImportRequest) {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    setPendingImport(request);
    try {
      const result = await rpc.call("importContextSource", request);
      if (!alive.current) return;
      setPendingImport(null);
      if (result.outcome === "rejected") setActionError(result.error.message);
      else
        setMessage(
          `${result.reference.name} saved · revision ${result.reference.revision}.${result.indexError ? ` Indexing needs attention: ${result.indexError}` : ""}`,
        );
      reload();
    } catch (failure) {
      if (alive.current) setActionError(errorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function upload(file: File) {
    const replacing = replacement.current;
    setBusy(true);
    setActionError(null);
    try {
      const contents = await readReferenceFile(file);
      if (!alive.current) return;
      await saveReference({
        target,
        operationId: crypto.randomUUID(),
        sourceId: replacing?.id ?? null,
        expectedRevision: replacing?.revision ?? null,
        ...contents,
      });
    } catch (failure) {
      if (alive.current) {
        setActionError(errorMessage(failure));
        setBusy(false);
      }
    }
  }

  async function removeReference(request: ArchiveRequest) {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    setPendingArchive(request);
    try {
      const result = await rpc.call("archiveContextReference", request);
      if (!alive.current) return;
      setPendingArchive(null);
      if (result.outcome === "rejected") setActionError(result.error.message);
      else
        setMessage(
          `${result.reference.name} removed from Context. Its original revisions are retained.${result.indexError ? ` Indexing needs attention: ${result.indexError}` : ""}`,
        );
      reload();
    } catch (failure) {
      if (alive.current) setActionError(errorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function find() {
    if (!query.trim()) return;
    const submittedQuery = query.trim();
    const sequence = ++searchSequence.current;
    setSearchBusy(true);
    setSearchError(null);
    setSelected(null);
    setDrawerOpen(false);
    try {
      const result = await rpc.call("searchContext", {
        target,
        query: submittedQuery,
        limit: 20,
      });
      if (alive.current && sequence === searchSequence.current) {
        setSearch(result);
        setSearchedQuery(submittedQuery);
      }
    } catch (failure) {
      if (alive.current && sequence === searchSequence.current)
        setSearchError(errorMessage(failure));
    } finally {
      if (alive.current && sequence === searchSequence.current)
        setSearchBusy(false);
    }
  }

  function showDetails(
    value: NonNullable<typeof selected>,
    trigger: HTMLElement,
  ) {
    detailsTrigger.current = trigger;
    setSelected(value);
    setDrawerOpen(true);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0 text-xs" role="status">
          <span className="font-medium">
            {current ? statusLabels[current.state] : "Checking index…"}
          </span>
          {current ? (
            <span className="text-muted-foreground">
              {" "}
              · {current.counts.indexed.toLocaleString()} indexed ·{" "}
              {current.counts.chunks.toLocaleString()} excerpts ·{" "}
              {current.coverage === "complete"
                ? "Scan complete"
                : current.coverage === "partial"
                  ? "Partial coverage"
                  : "Coverage not known"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={reload} disabled={busy}>
            Refresh
          </Button>
          {current?.state === "indexing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || current.operationId === null}
              onClick={() => void cancel()}
            >
              Cancel indexing
            </Button>
          ) : (
            <>
              {current?.operationId &&
              (current.state === "ready" ||
                current.state === "stale" ||
                current.state === "failed") ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  Stop watching
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !current}
                onClick={() => void index()}
              >
                {retryIndex
                  ? "Retry indexing request"
                  : current?.state === "absent"
                    ? "Index project"
                    : "Reindex"}
              </Button>
            </>
          )}
        </div>
      </div>
      {current?.reason ? (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          {current.reason}
        </p>
      ) : null}
      {current?.state === "cancelled" ? (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Indexing and file watching are stopped. Reindex to refresh Context.
        </p>
      ) : null}
      {status.error ? (
        <Notice error={status.error} retry={status.refresh} />
      ) : null}
      {actionError ? <Notice error={actionError} /> : null}
      {message ? (
        <p role="status" className="border-b px-4 py-2 text-xs">
          {message}
        </p>
      ) : null}
      {pendingImport && !busy ? (
        <div className="border-b px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveReference(pendingImport)}
          >
            Retry reference save
          </Button>
        </div>
      ) : null}
      {pendingArchive && !busy ? (
        <div className="border-b px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void removeReference(pendingArchive)}
          >
            Retry reference removal
          </Button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(140px,32%)_minmax(0,1fr)] @[900px]/context:grid-cols-[260px_minmax(0,1fr)] @[900px]/context:grid-rows-1">
        <aside
          aria-label="Context sources"
          className="min-h-0 overflow-y-auto border-b @[900px]/context:border-r @[900px]/context:border-b-0"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <h2 className="text-xs font-medium">Saved references</h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={
                busy ||
                pendingImport !== null ||
                pendingArchive !== null ||
                !references.data ||
                references.data.sources.length >= CONTEXT_REFERENCE_LIMITS.count
              }
              onClick={() => {
                replacement.current = null;
                fileInput.current?.click();
              }}
            >
              <Icon name="Plus" className="size-3.5" />
              Add
            </Button>
          </div>
          <input
            type="file"
            ref={fileInput}
            className="hidden"
            aria-label="Upload Context reference"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            Keep project notes here. UTF-8 text, up to 64 KiB each.
          </p>
          {references.error ? (
            <Notice error={references.error} retry={references.refresh} />
          ) : null}
          {references.data?.sources.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              No saved references yet.
            </p>
          ) : null}
          {references.data?.sources.map((source) => (
            <div key={source.id} className="flex items-center border-t px-2">
              <button
                className="min-w-0 flex-1 px-1 py-2 text-left text-xs hover:text-foreground focus-visible:outline focus-visible:outline-ring"
                type="button"
                aria-label={`Read ${source.name}, revision ${source.revision}`}
                onClick={(event) =>
                  showDetails(
                    { kind: "reference", source },
                    event.currentTarget,
                  )
                }
              >
                <span className="block truncate font-medium">
                  {source.name}
                </span>
                <span className="text-muted-foreground">
                  Reference · v{source.revision} ·{" "}
                  {formatBytes(source.sizeBytes)}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Replace ${source.name}`}
                disabled={
                  busy || pendingImport !== null || pendingArchive !== null
                }
                onClick={() => {
                  replacement.current = source;
                  fileInput.current?.click();
                }}
              >
                Replace
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${source.name} from Context`}
                disabled={
                  busy || pendingImport !== null || pendingArchive !== null
                }
                onClick={() =>
                  void removeReference({
                    target,
                    operationId: crypto.randomUUID(),
                    sourceId: source.id,
                    expectedRevision: source.revision,
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="border-t px-3 py-2">
            <h2 className="text-xs font-medium">Indexed sources</h2>
            {current ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {current.counts.discovered.toLocaleString()} found ·{" "}
                {current.counts.skipped} skipped · {current.counts.failed}{" "}
                failed · {current.counts.stale} stale
              </p>
            ) : null}
          </div>
          {sources.error ? (
            <Notice error={sources.error} retry={sources.refresh} />
          ) : null}
          {!sources.data && sources.loading ? (
            <p
              role="status"
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              Loading sources…
            </p>
          ) : null}
          {sources.data?.sources.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              {current?.state === "absent"
                ? "Index this project to discover its files."
                : "No sources on this page."}
            </p>
          ) : null}
          {sources.data?.sources.map((source) => (
            <details key={source.id} className="border-t px-3 py-2 text-xs">
              <summary className="cursor-pointer">
                <span className="break-words font-medium">
                  {source.relativePath ?? source.name}
                </span>
                <span className="ml-2 text-muted-foreground">
                  {source.state}
                </span>
              </summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                <p>
                  {source.kind === "reference"
                    ? "Saved reference"
                    : "Project file"}{" "}
                  · v{source.revision} · {formatBytes(source.sizeBytes)}
                </p>
                <p>
                  {source.chunks} excerpts · {source.embeddedChunks} embedded
                </p>
                {source.reason ? <p>{source.reason}</p> : null}
                {source.sha256 ? (
                  <p className="break-all font-mono">SHA-256 {source.sha256}</p>
                ) : null}
              </div>
            </details>
          ))}
          {cursorHistory.length > 1 || sources.data?.nextCursor ? (
            <div className="flex items-center justify-between border-t px-3 py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={cursorHistory.length === 1 || sources.loading}
                onClick={() =>
                  setPages({
                    version: pageVersion,
                    cursors: cursorHistory.slice(0, -1),
                  })
                }
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {cursorHistory.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!sources.data?.nextCursor || sources.loading}
                onClick={() => {
                  const next = sources.data?.nextCursor;
                  if (next)
                    setPages({
                      version: pageVersion,
                      cursors: [...cursorHistory, next],
                    });
                }}
              >
                Next
              </Button>
            </div>
          ) : null}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-col">
          <form
            className="flex shrink-0 gap-2 border-b p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void find();
            }}
          >
            <Input
              aria-label="Search project Context"
              placeholder="Find a function, decision or reference…"
              maxLength={4000}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={
                searchBusy ||
                !query.trim() ||
                !current ||
                current.state === "absent"
              }
            >
              Search
            </Button>
          </form>
          <div className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
            {search
              ? `${search.mode === "hybrid" ? "Keyword + semantic results" : "Keyword results"} for “${searchedQuery}”`
              : current?.semantic === "ready"
                ? "Keyword + semantic search available"
                : "Keyword search · semantic search is not ready"}
            {search?.reason ? ` · ${search.reason}` : ""}
            {search?.semanticTruncated
              ? " · Semantic search covered part of the index"
              : ""}
          </div>
          {searchError ? <Notice error={searchError} /> : null}
          {outdated ? (
            <p
              role="status"
              className="border-b px-3 py-2 text-xs text-muted-foreground"
            >
              The index changed. Search again for current results.
            </p>
          ) : null}
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            aria-busy={searchBusy}
          >
            {searchBusy ? (
              <p role="status" className="p-4 text-xs text-muted-foreground">
                Searching Context…
              </p>
            ) : null}
            {!search && !searchBusy ? (
              <div className="p-6 text-sm text-muted-foreground">
                <p>Find the details your team needs.</p>
                <p className="mt-2 text-xs">
                  Results retain their source and revision. Retrieved content is
                  reference material; it does not change agent permissions or
                  project rules.
                </p>
              </div>
            ) : null}
            {search?.hits.length === 0 && !searchBusy ? (
              <p className="p-4 text-sm text-muted-foreground">
                No matching excerpts. Try a file name, a function or a few
                different words.
              </p>
            ) : null}
            {search?.hits.map((hit) => (
              <button
                key={`${hit.indexId}:${hit.chunkId}:${hit.sourceGeneration}:${hit.sha256}`}
                type="button"
                aria-label={`Read ${hit.relativePath ?? hit.name}, lines ${hit.startLine} to ${hit.endLine}, revision ${hit.sourceRevision}`}
                className="block w-full border-b px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring"
                onClick={(event) =>
                  showDetails({ kind: "hit", hit }, event.currentTarget)
                }
              >
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="break-words text-sm font-medium">
                    {hit.relativePath ?? hit.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Lines {hit.startLine}–{hit.endLine} · v{hit.sourceRevision}{" "}
                    · Reference
                  </span>
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                  {hit.text.length > 360
                    ? `${hit.text.slice(0, 360)}…`
                    : hit.text}
                </span>
              </button>
            ))}
          </div>
        </main>
      </div>
      <ResponsiveDrawerShell
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        srLabel="Context source details"
        onAfterCloseAutoFocus={() => {
          if (detailsTrigger.current?.isConnected)
            detailsTrigger.current.focus();
        }}
        contentClassName="mx-auto max-w-3xl"
      >
        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-medium">Source details</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDrawerOpen(false)}
            >
              Close details
            </Button>
          </div>
          {selected ? (
            <ContextDetails
              key={JSON.stringify(selected)}
              target={target}
              selected={selected}
              version={detailVersion}
            />
          ) : null}
        </div>
      </ResponsiveDrawerShell>
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function ContextDetails({
  target,
  selected,
  version,
}: {
  target: ContextTarget;
  selected:
    | { kind: "hit"; hit: HostContextHit }
    | { kind: "reference"; source: ContextReference };
  version: string;
}) {
  const navigate = useBbNavigate();
  const [openError, setOpenError] = useState(false);
  const detail = useContextRead<Excerpt | Original>(
    `${JSON.stringify(selected)}:${selected.kind === "hit" ? version : ""}`,
    (rpc) =>
      selected.kind === "hit"
        ? rpc.call("readContextExcerpt", {
            target,
            indexId: selected.hit.indexId,
            chunkId: selected.hit.chunkId,
            sourceGeneration: selected.hit.sourceGeneration,
            sha256: selected.hit.sha256,
          })
        : rpc.call("readContextReference", {
            projectId: target.projectId,
            sourceId: selected.source.id,
            revision: selected.source.revision,
          }),
  );
  const data = detail.data;
  const hit = data && "hit" in data ? data.hit : null;
  const original = data && "source" in data ? data : null;
  const stale = data && "state" in data && data.state === "stale";
  const label =
    selected.kind === "hit"
      ? (selected.hit.relativePath ?? selected.hit.name)
      : selected.source.name;
  const sha =
    hit?.sha256 ??
    original?.source.sha256 ??
    (selected.kind === "hit" ? selected.hit.sha256 : selected.source.sha256);
  const path = hit?.relativePath;
  return (
    <div className="min-h-0 overflow-y-auto p-4">
      <h3 className="break-words text-sm font-medium">{label}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Reference material ·{" "}
        {original
          ? `saved revision ${original.source.revision}`
          : hit
            ? `lines ${hit.startLine}–${hit.endLine} · revision ${hit.sourceRevision}`
            : "Checking the selected source…"}
      </p>
      {detail.error ? (
        <Notice error={detail.error} retry={detail.refresh} />
      ) : null}
      {detail.loading && !data ? (
        <p role="status" className="mt-4 text-xs text-muted-foreground">
          Loading exact source…
        </p>
      ) : null}
      {stale ? (
        <p role="status" className="mt-4 text-sm">
          This excerpt is no longer current. Search again to view an updated
          source.
        </p>
      ) : null}
      {!stale && (hit || original) ? (
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-xs">
          {hit?.text ?? original?.text}
        </pre>
      ) : null}
      <details className="mt-4 border-t pt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Provenance
        </summary>
        <dl className="mt-2 space-y-2">
          <div>
            <dt className="text-muted-foreground">Authority</dt>
            <dd>Reference · cannot change operational rules</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">SHA-256</dt>
            <dd className="break-all font-mono">{sha}</dd>
          </div>
          {hit ? (
            <div>
              <dt className="text-muted-foreground">
                Index / source generation
              </dt>
              <dd>
                {hit.indexGeneration} / {hit.sourceGeneration}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
      {path && hit?.kind === "file" && !stale ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => {
            const scope = data && "status" in data ? data.status.scope : null;
            if (!scope) return;
            const opened = navigate.experimental_openFilePreview({
              target: target.environmentId
                ? {
                    kind: "workspace",
                    environmentId: target.environmentId,
                    path,
                  }
                : {
                    kind: "host",
                    hostId: target.hostId,
                    path: `${scope.path.replace(/[\\/]$/, "")}/${path}`,
                  },
              location: {
                kind: "range",
                startLine: hit.startLine,
                endLine: hit.endLine,
              },
            });
            setOpenError(!opened);
          }}
        >
          Open current file
        </Button>
      ) : null}
      {openError ? (
        <p role="alert" className="mt-2 text-xs text-destructive-text">
          The current file could not be opened in this view.
        </p>
      ) : null}
    </div>
  );
}

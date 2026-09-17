// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ContextPanel } from "./panel.js";
import { arcContextRpcContract } from "./contract.js";
import type {
  HostContextHit,
  HostContextStatus,
} from "../host-context-contract.js";
import type { ContextReference } from "./reference-contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toPluginPanel: vi.fn(), experimental_openFilePreview: vi.fn() },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useBbNavigate: () => harness.navigate,
  useRealtime: () => {},
}));

const target = {
  projectId: "project-a",
  hostId: "host-a",
  environmentId: null,
};
const hash = "a".repeat(64);
const reference: ContextReference = {
  id: "context_11111111-1111-1111-1111-111111111111",
  name: "Guide Δ.md",
  sha256: hash,
  sizeBytes: 40,
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};
const hit: HostContextHit = {
  indexId: "index-a",
  indexGeneration: 3,
  chunkId: "chunk-a",
  sourceId: "file-a",
  sourceGeneration: 2,
  sourceRevision: 4,
  sha256: hash,
  name: "pricing.ts",
  kind: "file",
  relativePath: "src/pricing.ts",
  authority: "reference",
  startOffset: 10,
  endOffset: 90,
  startLine: 2,
  endLine: 5,
  tokenCount: 20,
  text: '<script>notExecutable()</script>\nconst price = "Δ";',
  lexicalRank: 1,
  semanticRank: null,
  score: 0.5,
};
let status: HostContextStatus;
let refs: ContextReference[];
let excerptStale: boolean;
let indexFailures: number;
let archiveFailures: number;
let importIndexError: string | null;
let importRejection: "reference_limit" | "source_changed" | null;
let archiveRejection: "source_changed" | null;
let importFailures: number;
let paginated: boolean;
let delayedSearch: Promise<unknown> | null;

function searchResult() {
  return {
    status,
    mode: "lexical",
    reason: "Local embeddings unavailable",
    semanticTruncated: true,
    hits: [hit],
  };
}

async function respond(method: string, input: unknown): Promise<unknown> {
  if (method === "getContextSetup") {
    const request = arcContextRpcContract.getContextSetup.input.parse(input);
    return {
      project: { id: request.projectId, name: "Project A" },
      sources: [
        { hostId: "host-a", path: "C:/Project A" },
        { hostId: "host-b", path: "D:/Project A" },
      ],
      target: {
        ...target,
        projectId: request.projectId,
        hostId: request.hostId ?? "host-a",
      },
    };
  }
  if (method === "getContextStatus") return status;
  if (method === "listContextReferences") return { sources: refs };
  if (method === "listContextSources") {
    const request = arcContextRpcContract.listContextSources.input.parse(input);
    return {
      status,
      sources: [
        {
          id: request.cursor ? "file-b" : "file-a",
          name: request.cursor ? "notes.txt" : "pricing.ts",
          kind: "file",
          relativePath: request.cursor ? "notes.txt" : "src/pricing.ts",
          revision: 4,
          generation: 2,
          sha256: hash,
          state: "indexed",
          reason: null,
          sizeBytes: 100,
          chunks: 1,
          embeddedChunks: 0,
        },
      ],
      nextCursor: paginated && request.cursor === null ? "exact-cursor" : null,
    };
  }
  if (method === "searchContext") return delayedSearch ?? searchResult();
  if (method === "readContextExcerpt")
    return {
      status,
      state: excerptStale ? "stale" : "current",
      hit: excerptStale ? null : hit,
    };
  if (method === "readContextReference")
    return {
      source: {
        id: reference.id,
        name: reference.name,
        sha256: reference.sha256,
        revision: reference.revision,
      },
      text: "The retained original, including Δ.\n",
    };
  if (method === "reindexContext") {
    const request = arcContextRpcContract.reindexContext.input.parse(input);
    if (indexFailures-- > 0) throw new Error("Index response unavailable");
    status = {
      ...status,
      state: "indexing",
      operationId: request.operationId,
      coverage: "partial",
    };
    return status;
  }
  if (method === "cancelContextIndexing") {
    status = { ...status, state: "cancelled" };
    return status;
  }
  if (method === "importContextSource") {
    const request =
      arcContextRpcContract.importContextSource.input.parse(input);
    if (importFailures-- > 0) throw new Error("Import response unavailable");
    if (importRejection)
      return {
        outcome: "rejected",
        error: {
          code: importRejection,
          message:
            importRejection === "reference_limit"
              ? "Remove a reference to free space."
              : "Reload the current reference revision.",
        },
      };
    const saved = {
      ...reference,
      name: request.name,
      revision: (request.expectedRevision ?? 0) + 1,
      sizeBytes: new TextEncoder().encode(request.text).byteLength,
    };
    refs = [saved];
    return {
      outcome: "applied",
      reference: saved,
      status: importIndexError ? null : status,
      indexError: importIndexError,
    };
  }
  if (method === "archiveContextReference") {
    const request =
      arcContextRpcContract.archiveContextReference.input.parse(input);
    if (archiveFailures-- > 0) throw new Error("Removal response unavailable");
    if (archiveRejection)
      return {
        outcome: "rejected",
        error: {
          code: archiveRejection,
          message: "Reload the current reference revision.",
        },
      };
    const removed =
      refs.find((source) => source.id === request.sourceId) ?? reference;
    refs = refs.filter((source) => source.id !== request.sourceId);
    return { outcome: "applied", reference: removed, status, indexError: null };
  }
  throw new Error(`Unexpected Context RPC ${method}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  refs = [reference];
  excerptStale = false;
  indexFailures = 0;
  archiveFailures = 0;
  importIndexError = null;
  importRejection = null;
  archiveRejection = null;
  importFailures = 0;
  paginated = false;
  delayedSearch = null;
  status = {
    scope: { ...target, path: "C:/Project A", referenceDigest: "b".repeat(64) },
    indexId: "index-a",
    generation: 3,
    operationId: "previous-operation",
    state: "ready",
    coverage: "complete",
    root: null,
    git: null,
    counts: {
      discovered: 1,
      indexed: 1,
      stale: 0,
      skipped: 0,
      failed: 0,
      chunks: 1,
      embeddedChunks: 0,
    },
    semantic: "unavailable",
    manifestDigest: null,
    reason: null,
    updatedAt: "2026-09-10T21:00:00Z",
  };
  harness.navigate.experimental_openFilePreview.mockReturnValue(true);
  harness.rpc.call.mockImplementation(
    async (method: string, input: unknown) => {
      if (method === "listStudioProjects")
        return {
          projects: [
            { id: "project-a", name: "Project A" },
            { id: "project Δ", name: "Project Δ" },
          ],
          personalProjectId: null,
        };
      const contract = Object.entries(arcContextRpcContract).find(
        ([name]) => name === method,
      )?.[1];
      if (!contract) throw new Error(`Unknown RPC ${method}`);
      contract.input.parse(input);
      return contract.output.parse(await respond(method, input));
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    clearTimeout(handle),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function ready() {
  await screen.findByRole("button", { name: "Reindex" });
  await screen.findByRole("button", { name: "Replace Guide Δ.md" });
}
async function search() {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search project Context" }),
    { target: { value: " pricing " } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  return screen.findByRole("button", { name: /Read src\/pricing.ts, lines/ });
}
function calls(method: string) {
  return harness.rpc.call.mock.calls.filter(([name]) => name === method);
}
function upload(file: File) {
  fireEvent.change(screen.getByLabelText("Upload Context reference"), {
    target: { files: [file] },
  });
}

describe("Context panel", () => {
  it("uses the existing project navigation without indexing on open", async () => {
    render(<ContextPanel subPath="" />);
    await screen.findByRole("option", { name: "Project Δ" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Context project" }),
      { target: { value: "project Δ" } },
    );
    expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith("context", {
      subPath: "project/project%20%CE%94",
    });
    expect(calls("getContextSetup")).toHaveLength(0);
    expect(calls("reindexContext")).toHaveLength(0);
  });

  it("shows partial semantic coverage and reads exact escaped provenance in the shared drawer", async () => {
    render(
      <StrictMode>
        <ContextPanel subPath="project/project-a" />
      </StrictMode>,
    );
    await ready();
    const result = await search();
    expect(calls("searchContext")[0][1]).toEqual({
      target,
      query: "pricing",
      limit: 20,
    });
    expect(
      screen.getByText(
        /Keyword results for “pricing”.*Local embeddings unavailable.*covered part/,
      ),
    ).toBeTruthy();
    result.focus();
    fireEvent.click(result);
    const drawer = await screen.findByRole("dialog", {
      name: "Context source details",
    });
    await within(drawer).findByText(/const price/);
    expect(drawer.querySelector("pre")?.textContent).toBe(hit.text);
    expect(drawer.querySelector("script")).toBeNull();
    expect(calls("readContextExcerpt").at(-1)?.[1]).toEqual({
      target,
      indexId: hit.indexId,
      chunkId: hit.chunkId,
      sourceGeneration: hit.sourceGeneration,
      sha256: hash,
    });
    expect(within(drawer).getByText(hash)).toBeTruthy();
    expect(
      within(drawer).getByText("Reference · cannot change operational rules"),
    ).toBeTruthy();
    expect(document.querySelector("[inert]")).toBeNull();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Open current file" }),
    );
    expect(harness.navigate.experimental_openFilePreview).toHaveBeenCalledWith({
      target: {
        kind: "host",
        hostId: "host-a",
        path: "C:/Project A/src/pricing.ts",
      },
      location: { kind: "range", startLine: 2, endLine: 5 },
    });
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Close details" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(result));
  });

  it("rechecks an open exact excerpt when the index changes and withholds stale text", async () => {
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.click(await search());
    const drawer = await screen.findByRole("dialog", {
      name: "Context source details",
    });
    await within(drawer).findByText(/const price/);
    expect(drawer.querySelector("pre")?.textContent).toBe(hit.text);
    excerptStale = true;
    status = { ...status, generation: 4, state: "stale" };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await within(drawer).findByText(/no longer current/);
    expect(drawer.querySelector("pre")).toBeNull();
    expect(
      within(drawer).queryByRole("button", { name: "Open current file" }),
    ).toBeNull();
    expect(calls("readContextExcerpt")).toHaveLength(2);
    expect(screen.getByText(/index changed/)).toBeTruthy();
  });

  it("uses a fresh search observation over an older poll but honors a later invalidation generation", async () => {
    status = {
      ...status,
      state: "indexing",
      updatedAt: "2026-09-10T21:00:00Z",
    };
    const older = status;
    render(<ContextPanel subPath="project/project-a" />);
    await screen.findByRole("button", { name: "Cancel indexing" });
    await screen.findByRole("button", { name: "Replace Guide Δ.md" });
    status = { ...status, state: "ready", updatedAt: "2026-09-10T21:00:02Z" };
    await search();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText(/index changed/)).toBeNull();
    status = older;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls("getContextStatus").length).toBeGreaterThan(1),
    );
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText(/index changed/)).toBeNull();
    status = { ...older, generation: 4, state: "stale" };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Changes detected");
    expect(screen.getByText(/index changed/)).toBeTruthy();
  });

  it("discards a prior host's delayed search on source change", async () => {
    let resolveSearch: (result: unknown) => void = () => {};
    delayedSearch = new Promise((resolve) => {
      resolveSearch = resolve;
    });
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search project Context" }),
      { target: { value: "pricing" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Context source" }), {
      target: { value: "host-b" },
    });
    await waitFor(() =>
      expect(calls("getContextSetup").at(-1)?.[1]).toEqual({
        projectId: "project-a",
        hostId: "host-b",
      }),
    );
    await ready();
    await act(async () => resolveSearch(searchResult()));
    expect(
      screen.queryByRole("button", { name: /Read src\/pricing.ts, lines/ }),
    ).toBeNull();
    expect(calls("getContextStatus").at(-1)?.[1]).toEqual({
      target: { ...target, hostId: "host-b" },
    });
  });

  it("accepts a newer replacement index even when its generation resets", async () => {
    status = { ...status, generation: 30, updatedAt: "2026-09-10T21:00:00Z" };
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    delayedSearch = Promise.resolve({
      ...searchResult(),
      status: {
        ...status,
        indexId: "replacement-index",
        generation: 1,
        updatedAt: "2026-09-10T21:00:04Z",
      },
      hits: [{ ...hit, indexId: "replacement-index", indexGeneration: 1 }],
    });
    await search();
    expect(screen.queryByText(/index changed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls("getContextStatus").length).toBeGreaterThan(1),
    );
    expect(screen.queryByText(/index changed/)).toBeNull();
  });

  it("sends exact paging cursors and returns to the first page on a new generation", async () => {
    paginated = true;
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByText("notes.txt");
    expect(calls("listContextSources").at(-1)?.[1]).toEqual({
      target,
      cursor: "exact-cursor",
      limit: 50,
    });
    status = { ...status, generation: 4 };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls("listContextSources").at(-1)?.[1]).toEqual({
        target,
        cursor: null,
        limit: 50,
      }),
    );
    expect(screen.getByText("Page 1")).toBeTruthy();
  });

  it("retries the same index operation after a lost response and cancels that exact operation", async () => {
    indexFailures = 1;
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Reindex" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry indexing request" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel indexing" }),
    );
    await screen.findByText("Indexing cancelled");
    const first = calls("reindexContext")[0][1];
    expect(calls("reindexContext")[1][1]).toEqual(first);
    expect(calls("cancelContextIndexing")[0][1]).toEqual(first);
  });

  it("preserves BOM and Unicode in a new reference and reports a retained save when indexing fails", async () => {
    importIndexError = "Host unavailable";
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    const text = "\uFEFF# Decisions Δ\r\nUse the existing API.\n";
    upload(new File([new TextEncoder().encode(text)], "Decision Δ.md"));
    await screen.findByText(
      /Decision Δ.md saved · revision 1.*Indexing needs attention: Host unavailable/,
    );
    const request = arcContextRpcContract.importContextSource.input.parse(
      calls("importContextSource")[0][1],
    );
    expect(request).toEqual({
      target,
      operationId: expect.any(String),
      sourceId: null,
      expectedRevision: null,
      name: "Decision Δ.md",
      text,
    });
    expect(calls("reindexContext")).toHaveLength(0);
  });

  it("stops a ready index's retained watch using its exact operation without restarting on reads", async () => {
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    await search();
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    await screen.findByText(
      "Indexing and file watching are stopped. Reindex to refresh Context.",
    );
    expect(calls("cancelContextIndexing")[0][1]).toEqual({
      target,
      operationId: "previous-operation",
    });
    expect(screen.queryByRole("button", { name: "Stop watching" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reindex" })).toBeTruthy();
    expect(screen.getByText(/index changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls("getContextStatus").length).toBeGreaterThan(2),
    );
    expect(calls("reindexContext")).toHaveLength(0);
  });

  it.each(["reference_limit", "source_changed"] as const)(
    "unlocks reference management after a definitive %s rejection",
    async (code) => {
      if (code === "reference_limit")
        refs = [
          { ...reference, sizeBytes: 65_536 },
          ...Array.from({ length: 7 }, (_, index) => ({
            ...reference,
            id: `context_0000000${index}-1111-1111-1111-111111111111`,
            name: `Other ${index}.md`,
            sizeBytes: 65_536,
          })),
        ];
      render(<ContextPanel subPath="project/project-a" />);
      await ready();
      if (code === "source_changed") {
        fireEvent.click(
          screen.getByRole("button", { name: "Replace Guide Δ.md" }),
        );
        refs = [{ ...reference, revision: 3 }];
      }
      importRejection = code;
      upload(new File(["Revised notes\n"], "Guide Δ.md"));
      await screen.findByText(
        code === "reference_limit"
          ? "Remove a reference to free space."
          : "Reload the current reference revision.",
      );
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Remove Guide Δ.md from Context" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(
        screen.queryByRole("button", { name: "Retry reference save" }),
      ).toBeNull();
      const rejected = arcContextRpcContract.importContextSource.input.parse(
        calls("importContextSource")[0][1],
      );
      importRejection = null;
      if (code === "reference_limit") {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Remove Guide Δ.md from Context",
          }),
        );
        await waitFor(() =>
          expect(
            screen.queryByRole("button", {
              name: "Remove Guide Δ.md from Context",
            }),
          ).toBeNull(),
        );
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
      } else {
        await screen.findByRole("button", {
          name: "Read Guide Δ.md, revision 3",
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Replace Guide Δ.md" }),
        );
      }
      upload(new File(["Revised notes\n"], "Guide Δ.md"));
      await screen.findByText(/Guide Δ.md saved/);
      const retried = arcContextRpcContract.importContextSource.input.parse(
        calls("importContextSource")[1][1],
      );
      expect(retried.operationId).not.toBe(rejected.operationId);
      expect(retried.expectedRevision).toBe(
        code === "source_changed" ? 3 : null,
      );
    },
  );

  it("refreshes an outdated removal revision and allows a new exact removal", async () => {
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    refs = [{ ...reference, revision: 3 }];
    archiveRejection = "source_changed";
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Guide Δ.md from Context" }),
    );
    await screen.findByText("Reload the current reference revision.");
    await screen.findByRole("button", { name: "Read Guide Δ.md, revision 3" });
    expect(
      screen.queryByRole("button", { name: "Retry reference removal" }),
    ).toBeNull();
    archiveRejection = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Guide Δ.md from Context" }),
    );
    await screen.findByText("No saved references yet.");
    const first = arcContextRpcContract.archiveContextReference.input.parse(
      calls("archiveContextReference")[0][1],
    );
    const next = arcContextRpcContract.archiveContextReference.input.parse(
      calls("archiveContextReference")[1][1],
    );
    expect(first.expectedRevision).toBe(2);
    expect(next.expectedRevision).toBe(3);
    expect(next.operationId).not.toBe(first.operationId);
  });

  it("retains the same import operation and bytes for an uncertain transport retry", async () => {
    importFailures = 1;
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    upload(new File(["Retain these exact bytes Δ\n"], "Notes.md"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry reference save" }),
    );
    await screen.findByText(/Notes.md saved/);
    expect(calls("importContextSource")[1][1]).toEqual(
      calls("importContextSource")[0][1],
    );
  });

  it("reads the retained revision and replaces only the selected reference revision", async () => {
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Read Guide Δ.md, revision 2" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Context source details",
    });
    await within(drawer).findByText("The retained original, including Δ.");
    expect(calls("readContextReference")[0][1]).toEqual({
      projectId: target.projectId,
      sourceId: reference.id,
      revision: 2,
    });
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Close details" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace Guide Δ.md" }));
    upload(new File(["Revised source\n"], "Guide Δ.md"));
    await screen.findByText(/Guide Δ.md saved · revision 3/);
    const request = arcContextRpcContract.importContextSource.input.parse(
      calls("importContextSource")[0][1],
    );
    expect(request.sourceId).toBe(reference.id);
    expect(request.expectedRevision).toBe(2);
  });

  it("removes a current reference with its exact revision and reuses the request after an uncertain response", async () => {
    archiveFailures = 1;
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Guide Δ.md from Context" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry reference removal" }),
    );
    await screen.findByText(
      /removed from Context.*original revisions are retained/,
    );
    await screen.findByText("No saved references yet.");
    const request = calls("archiveContextReference")[0][1];
    expect(request).toEqual({
      target,
      operationId: expect.any(String),
      sourceId: reference.id,
      expectedRevision: 2,
    });
    expect(calls("archiveContextReference")[1][1]).toEqual(request);
  });

  it("refreshes the reference catalog after a CLI or SDK change is observed", async () => {
    render(<ContextPanel subPath="project/project-a" />);
    await ready();
    refs = [{ ...reference, name: "Changed by SDK.md", revision: 3 }];
    status = {
      ...status,
      scope: { ...status.scope, referenceDigest: "c".repeat(64) },
    };
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: "Replace Changed by SDK.md" });
    expect(
      screen.queryByRole("button", { name: "Replace Guide Δ.md" }),
    ).toBeNull();
  });

  it.each([
    { bytes: new Uint8Array([0xff, 0xfe]), message: /not valid UTF-8/ },
    {
      bytes: new TextEncoder().encode("contains\u0000null"),
      message: /without null bytes/,
    },
    { bytes: new Uint8Array(65_537), message: /64 KiB or less/ },
  ])(
    "rejects invalid reference bytes before any mutation: $message",
    async ({ bytes, message }) => {
      render(<ContextPanel subPath="project/project-a" />);
      await ready();
      upload(new File([bytes], "Bad.txt"));
      await screen.findByText(message);
      expect(calls("importContextSource")).toHaveLength(0);
    },
  );
});

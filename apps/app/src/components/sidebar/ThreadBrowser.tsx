import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useNavigate } from "react-router-dom";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import { createSidebarProjectIdResolver } from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppHeaderChrome } from "@/components/layout/AppPageHeader";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  useArchivedThreads,
  useThreadSearch,
} from "@/hooks/queries/thread-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { SidebarContent, useCloseMobileSidebar } from "@/components/ui/sidebar";
import { ProjectList } from "./ProjectList";
import { PluginThreadList } from "./PluginThreadList";
import { useThreadListReplacement } from "./threadListProvider";
import { ThreadBrowserRows } from "./ThreadBrowserRows";
import { ThreadBrowserSearchResults } from "./ThreadBrowserSearchResults";
import { SidebarThreadShortcutKeysContext } from "./sidebarThreadShortcuts";
import { useThreadBrowserNavigation } from "./useThreadBrowserNavigation";
import {
  ALL_THREAD_PROJECTS,
  filterBrowserThreads,
  threadBrowserDrawerOpenAtom,
  threadBrowserOpenAtom,
  ThreadBrowserPresentation,
  useThreadBrowserProject,
  type ThreadBrowserFilter,
} from "./threadBrowserState";
import "./thread-browser.css";

const EMPTY_THREADS: ThreadListEntry[] = [];
const FILTERS: { value: ThreadBrowserFilter; label: string }[] = [
  { value: "all", label: "All threads" },
  { value: "working", label: "Working" },
  { value: "attention", label: "Needs attention" },
  { value: "archived", label: "Archived" },
];
const clampWidth = (width: number) => Math.min(420, Math.max(280, width));
const browserWidthAtom = atomWithStorage(
  "arc.threads.width",
  336,
  createLocalStorageSyncStorage<number>({
    parse: (value, initial) =>
      value !== null && Number.isFinite(Number(value))
        ? clampWidth(Number(value))
        : initial,
    serialize: (value) => String(clampWidth(value)),
  }),
  { getOnInit: true },
);

type BrowserViewState = {
  scope: string;
  query: string;
  filter: ThreadBrowserFilter;
  searchLimit: number;
};
type BrowserViewProps = {
  viewState: BrowserViewState;
  setViewState: Dispatch<SetStateAction<BrowserViewState>>;
  readScrollPosition: () => { key: string; top: number };
  saveScrollPosition: (position: { key: string; top: number }) => void;
};

function ThreadBrowser({
  onClose,
  onSelect,
  enabled,
  viewState,
  setViewState,
  readScrollPosition,
  saveScrollPosition,
  headerInsetClassName,
}: BrowserViewProps & {
  onClose: () => void;
  onSelect: () => void;
  enabled: boolean;
  headerInsetClassName?: string;
}) {
  const navigation = useSidebarNavigation();
  const route = useRouteState();
  const [scope, setScope] = useThreadBrowserProject();
  const [composeProject, setComposeProject] = useRootComposeProjectId();
  const projectId = scope === ALL_THREAD_PROJECTS ? null : scope;
  const navigate = useNavigate();
  const closeSidebar = useCloseMobileSidebar();
  const { query, filter, searchLimit } =
    viewState.scope === scope
      ? viewState
      : { query: "", filter: viewState.filter, searchLimit: 20 };
  const setQuery = (query: string) =>
    setViewState((current) => ({ ...current, scope, query }));
  const setFilter = (filter: ThreadBrowserFilter) =>
    setViewState((current) => ({ ...current, scope, filter }));
  const setSearchLimit = (searchLimit: number) =>
    setViewState((current) => ({ ...current, scope, searchLimit }));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const replacement = useThreadListReplacement();
  const hasSearch = query.trim().length > 0;
  const isActivityView = filter === "working" || filter === "attention";
  const archive = useArchivedThreads(projectId ? { projectId } : {}, {
    enabled: enabled && filter === "archived" && !hasSearch,
  });
  const search = useThreadSearch({
    active: enabled && hasSearch,
    query,
    limitPerGroup: searchLimit,
    ...(projectId ? { projectId } : {}),
  });
  const allThreads = useMemo(
    () =>
      navigation.data
        ? [
            ...navigation.data.personalProject.threads,
            ...navigation.data.projects.flatMap((project) => project.threads),
          ]
        : EMPTY_THREADS,
    [navigation.data],
  );
  const archivedThreads = useMemo(
    () => archive.data?.pages.flat() ?? EMPTY_THREADS,
    [archive.data],
  );
  const routeScope = useMemo(() => {
    const byId = new Map(allThreads.map((thread) => [thread.id, thread]));
    const selected = route.threadId ? byId.get(route.threadId) : undefined;
    return selected
      ? createSidebarProjectIdResolver(byId)(selected)
      : route.projectId;
  }, [allThreads, route.projectId, route.threadId]);
  const searchGroup =
    filter === "archived" ? search.data?.archived : search.data?.active;
  const searchCurrent =
    search.hasSearchableQuery && search.debouncedQuery === query.trim();
  const searchThreads = useMemo(
    () =>
      searchCurrent
        ? (searchGroup?.results.map((result) => result.thread) ?? EMPTY_THREADS)
        : EMPTY_THREADS,
    [searchCurrent, searchGroup],
  );
  const threads = useMemo(
    () =>
      filterBrowserThreads(
        hasSearch
          ? searchThreads
          : filter === "archived"
            ? archivedThreads
            : allThreads,
        hasSearch ? null : projectId,
        filter,
      ),
    [allThreads, archivedThreads, filter, hasSearch, projectId, searchThreads],
  );
  const browser = useMemo(() => ({ projectId, threads }), [projectId, threads]);
  const projectName =
    projectId === null
      ? "All projects"
      : projectId === PERSONAL_PROJECT_ID
        ? "Personal"
        : (navigation.data?.projects.find((project) => project.id === projectId)
            ?.name ?? "Project");
  const provisional =
    !hasSearch && filter !== "archived" && navigation.isPlaceholderData;
  const loading = hasSearch
    ? search.isLoading || search.isDebouncing
    : filter === "archived"
      ? archive.isPending
      : navigation.isPending;
  const failed = hasSearch
    ? search.isError
    : filter === "archived"
      ? archive.isError
      : navigation.isError;
  const onNavigate = useCallback(() => {
    closeSidebar();
    onSelect();
  }, [closeSidebar, onSelect]);
  const version = threads.map((thread) => thread.id).join("|");
  const shortcuts = useThreadBrowserNavigation(
    listRef,
    route.threadId,
    enabled,
    version,
    onNavigate,
  );

  useEffect(() => {
    setViewState((current) =>
      current.scope === scope
        ? current
        : { ...current, scope, query: "", searchLimit: 20 },
    );
  }, [scope, setViewState]);
  const scrollKey = `${scope}/${filter}/${query}`;
  const restoredScrollKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (loading || provisional || restoredScrollKey.current === scrollKey)
      return;
    const position = readScrollPosition();
    if (listRef.current)
      listRef.current.scrollTop = position.key === scrollKey ? position.top : 0;
    restoredScrollKey.current = scrollKey;
  }, [loading, provisional, scrollKey, readScrollPosition]);
  useEffect(() => {
    if (routeScope && scope !== ALL_THREAD_PROJECTS && routeScope !== scope)
      setScope(routeScope);
  }, [routeScope, scope, setScope]);
  useEffect(() => {
    if (
      !navigation.isSuccess ||
      navigation.isPlaceholderData ||
      !navigation.data ||
      scope === ALL_THREAD_PROJECTS ||
      scope === PERSONAL_PROJECT_ID
    )
      return;
    if (!navigation.data.projects.some((project) => project.id === scope)) {
      setScope(ALL_THREAD_PROJECTS);
      if (composeProject === scope) setComposeProject(PERSONAL_PROJECT_ID);
    }
  }, [
    composeProject,
    navigation.data,
    navigation.isPlaceholderData,
    navigation.isSuccess,
    scope,
    setComposeProject,
    setScope,
  ]);

  const newThread = () => {
    setComposeProject(projectId ?? composeProject);
    onNavigate();
    void navigate(getRootComposeRoutePath(), { state: { focusPrompt: true } });
  };
  const retry = () => {
    if (hasSearch) void search.refetch();
    else if (filter === "archived") void archive.refetch();
    else void navigation.refetch();
  };
  return (
    <ThreadBrowserPresentation.Provider value={true}>
      <ThreadBrowserRows enabled={enabled}>
        <SidebarThreadShortcutKeysContext.Provider value={shortcuts}>
          <div
            className="arc-thread-browser"
            data-testid="thread-browser"
            aria-label="Thread browser"
          >
            <header className="h-14 shrink-0 border-b border-border-seam px-4">
              <div
                className={cn(
                  "arc-thread-browser-header-inset flex h-full min-w-0 items-center gap-2",
                  headerInsetClassName,
                )}
              >
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-foreground">
                    Threads
                  </h2>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={projectName}
                  >
                    {projectName}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label="New thread"
                  onClick={newThread}
                >
                  <Icon name="Plus" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label="Hide threads"
                  onClick={onClose}
                >
                  <Icon name="PanelLeft" className="size-4" />
                </Button>
              </div>
            </header>
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-seam px-3">
              {isActivityView ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left text-xs text-muted-foreground"
                  onClick={() => {
                    setFilter("all");
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <Icon name="Search" className="size-3.5" />
                  Search conversations
                </button>
              ) : (
                <div className="relative min-w-0 flex-1">
                  <Icon
                    name="Search"
                    className="pointer-events-none absolute left-1 top-2 size-3.5 text-muted-foreground"
                  />
                  <Input
                    ref={inputRef}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSearchLimit(20);
                    }}
                    placeholder="Search conversations…"
                    aria-label={`Search ${projectName} conversations`}
                    className="h-8 border-0 bg-transparent pr-7 pl-6 text-xs shadow-none focus-visible:ring-0"
                  />
                  {query ? (
                    <button
                      type="button"
                      className="absolute top-1 right-0 p-1 text-muted-foreground"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <Icon name="X" className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={`Thread filter: ${FILTERS.find((item) => item.value === filter)?.label}`}
                  >
                    <Icon name="SlidersHorizontal" className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" mobileTitle="Show threads">
                  {FILTERS.map((item) => (
                    <DropdownMenuCheckboxItem
                      key={item.value}
                      checked={filter === item.value}
                      onCheckedChange={() => {
                        setFilter(item.value);
                        setQuery("");
                      }}
                    >
                      {item.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {filter !== "all" ? (
              <div className="flex shrink-0 items-center justify-between px-4 pt-3 text-xs font-medium text-muted-foreground">
                <span>
                  {FILTERS.find((item) => item.value === filter)?.label}
                </span>
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  aria-label="Show all threads"
                >
                  <Icon name="X" className="size-3" />
                </button>
              </div>
            ) : null}
            <SidebarContent
              ref={listRef}
              className="arc-thread-browser-scroll pt-2 pb-4"
              onScroll={(event) => {
                if (restoredScrollKey.current === scrollKey)
                  saveScrollPosition({
                    key: scrollKey,
                    top: event.currentTarget.scrollTop,
                  });
              }}
            >
              {provisional || loading ? (
                <p
                  role="status"
                  className="px-4 py-2 text-xs text-muted-foreground"
                >
                  {provisional ? "Updating saved threads…" : "Loading threads…"}
                </p>
              ) : null}
              {failed ? (
                <button
                  type="button"
                  onClick={retry}
                  className="px-4 py-3 text-left text-xs text-destructive"
                >
                  Threads unavailable. Retry
                </button>
              ) : null}
              {hasSearch &&
              !search.hasSearchableQuery &&
              !search.isDebouncing ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Enter at least two characters to search conversations.
                </p>
              ) : null}
              {hasSearch && search.hasSearchableQuery && !loading && !failed ? (
                <p className="px-4 pb-2 text-xs text-muted-foreground">
                  {searchGroup?.total ?? 0}{" "}
                  {(searchGroup?.total ?? 0) === 1 ? "result" : "results"}
                </p>
              ) : null}
              <PluginThreadList
                replacement={replacement}
                searchQuery={query}
                onNavigate={onNavigate}
                original={
                  hasSearch ? (
                    <ThreadBrowserSearchResults
                      results={
                        searchCurrent ? (searchGroup?.results ?? []) : []
                      }
                      allThreads={allThreads}
                      selectedThreadId={route.threadId}
                      onNavigate={onNavigate}
                    />
                  ) : (
                    <ProjectList
                      browser={browser}
                      onProjectSelect={onNavigate}
                    />
                  )
                }
              />
              {threads.length === 0 &&
              !loading &&
              !provisional &&
              !failed &&
              !hasSearch ? (
                <div className="px-4 py-6">
                  <p className="text-sm text-foreground">
                    {filter === "all"
                      ? "Start a conversation"
                      : filter === "working"
                        ? "Nothing working right now"
                        : filter === "attention"
                          ? "You're all caught up"
                          : "No archived threads"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {filter === "all"
                      ? "Describe what you want to build. Your conversations and team activity will appear here."
                      : "Your project conversations stay available in All threads."}
                  </p>
                  {filter === "all" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={newThread}
                    >
                      New thread
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {hasSearch &&
              searchCurrent &&
              searchGroup &&
              searchGroup.total > searchGroup.results.length ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  Showing {searchGroup.results.length} of {searchGroup.total}.{" "}
                  {searchLimit < 50 ? (
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => setSearchLimit(50)}
                    >
                      Show more
                    </button>
                  ) : (
                    "Refine your search to narrow the results."
                  )}
                </div>
              ) : null}
              {!hasSearch && filter === "archived" && archive.hasNextPage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mx-3"
                  disabled={archive.isFetchingNextPage}
                  onClick={() => void archive.fetchNextPage()}
                >
                  {archive.isFetchingNextPage
                    ? "Loading…"
                    : "Load older threads"}
                </Button>
              ) : null}
            </SidebarContent>
          </div>
        </SidebarThreadShortcutKeysContext.Provider>
      </ThreadBrowserRows>
    </ThreadBrowserPresentation.Provider>
  );
}

export function ThreadBrowserLayout({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const { sidebarReserveClass } = useAppHeaderChrome();
  const [viewState, setViewState] = useState<BrowserViewState>({
    scope: ALL_THREAD_PROJECTS,
    query: "",
    filter: "all",
    searchLimit: 20,
  });
  const scrollPosition = useRef({ key: "", top: 0 });
  const readScrollPosition = useCallback(() => scrollPosition.current, []);
  const saveScrollPosition = useCallback(
    (position: { key: string; top: number }) => {
      scrollPosition.current = position;
    },
    [],
  );
  const [open, setOpen] = useAtom(threadBrowserOpenAtom);
  const [drawerOpen, setDrawerOpen] = useAtom(threadBrowserDrawerOpenAtom);
  const [width, setWidth] = useAtom(browserWidthAtom);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const isResizing = liveWidth !== null;
  const currentWidth = useRef(width);
  const container = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);
  const [available, setAvailable] = useState(() => window.innerWidth - 224);
  const inline = available >= width + 640;
  const showOpener = !inline || !open;
  const dragging = useRef<{ start: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    if (open) {
      pane.current
        ?.querySelector<HTMLElement>('input, button[aria-label="Hide threads"]')
        ?.focus({ preventScroll: true });
    } else {
      opener.current?.focus({ preventScroll: true });
    }
  }, [open]);
  useEffect(() => {
    dispatchBrowserViewBoundsSync();
  }, [open, inline]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    if (!isResizing) return;
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      currentWidth.current = clampWidth(
        dragging.current.width + event.clientX - dragging.current.start,
      );
      setLiveWidth(currentWidth.current);
      dispatchBrowserViewBoundsSync();
    };
    const stop = () => {
      setWidth(currentWidth.current);
      setLiveWidth(null);
      dragging.current = null;
      dispatchBrowserViewBoundsSync();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("blur", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [isResizing, setWidth]);
  const close = useCallback(() => {
    setDrawerOpen(false);
    if (inline) {
      focusAfterToggle.current =
        pane.current?.contains(document.activeElement) ?? false;
      setOpen(false);
    }
  }, [inline, setDrawerOpen, setOpen]);
  const closeAfterNavigate = useCallback(() => {
    if (!inline) setDrawerOpen(false);
  }, [inline, setDrawerOpen]);
  return (
    <div
      ref={container}
      className="flex min-h-0 min-w-0 flex-1"
      data-testid="thread-browser-layout"
    >
      {active && inline ? (
        <aside
          ref={pane}
          aria-label="Threads pane"
          aria-hidden={!open}
          inert={!open}
          data-state={open ? "open" : "closed"}
          data-resizing={isResizing}
          className="arc-thread-browser-pane"
          style={{ width: open ? (liveWidth ?? width) : 0 }}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget)
              dispatchBrowserViewBoundsSync();
          }}
        >
          <div className="arc-thread-browser-viewport">
            <div
              className="arc-thread-browser-surface"
              style={{ width: liveWidth ?? width }}
            >
              <ThreadBrowser
                onClose={close}
                onSelect={closeAfterNavigate}
                enabled={open}
                headerInsetClassName={sidebarReserveClass}
                viewState={viewState}
                setViewState={setViewState}
                readScrollPosition={readScrollPosition}
                saveScrollPosition={saveScrollPosition}
              />
            </div>
          </div>
          <div
            role="separator"
            aria-label="Resize thread browser"
            aria-orientation="vertical"
            tabIndex={0}
            aria-valuemin={280}
            aria-valuemax={420}
            aria-valuenow={width}
            className="arc-thread-browser-resize"
            onPointerDown={(event) => {
              event.preventDefault();
              currentWidth.current = width;
              dragging.current = { start: event.clientX, width };
              setLiveWidth(width);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setWidth(
                  clampWidth(width + (event.key === "ArrowLeft" ? -16 : 16)),
                );
              }
            }}
          />
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? (
          <div
            className="arc-thread-browser-opener"
            data-state={showOpener ? "open" : "closed"}
            inert={!showOpener}
            aria-hidden={!showOpener}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget)
                dispatchBrowserViewBoundsSync();
            }}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="h-10 border-b border-border-seam px-3">
                <div
                  className={cn(
                    "arc-thread-browser-header-inset flex h-full items-center",
                    sidebarReserveClass,
                  )}
                >
                  <Button
                    ref={opener}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (inline) {
                        focusAfterToggle.current = true;
                        setOpen(true);
                      } else setDrawerOpen(true);
                    }}
                    aria-expanded={inline ? open : drawerOpen}
                  >
                    <Icon name="PanelLeft" className="size-4" />
                    Threads
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {children}
      </div>
      {active && !inline ? (
        <ResponsiveDrawerShell
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          srLabel="Threads"
          contentClassName="arc-thread-browser-drawer"
        >
          <ThreadBrowser
            onClose={closeAfterNavigate}
            onSelect={closeAfterNavigate}
            enabled={drawerOpen}
            viewState={viewState}
            setViewState={setViewState}
            readScrollPosition={readScrollPosition}
            saveScrollPosition={saveScrollPosition}
          />
        </ResponsiveDrawerShell>
      ) : null}
      <IframeDragGuardOverlay active={liveWidth !== null} cursor="col-resize" />
    </div>
  );
}

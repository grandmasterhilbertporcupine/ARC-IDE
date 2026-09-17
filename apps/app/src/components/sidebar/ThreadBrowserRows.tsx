import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProviderInfo, ThreadListEntry } from "@bb/domain";
import { Link } from "react-router-dom";
import { getThreadRoutePath } from "@/lib/route-paths";
import { threadViewKey } from "@/components/plugin/PluginThreadView";
import { Icon } from "@bb/shared-ui/icon";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  PluginThreadListAnnotationsProvider,
  useThreadListAnnotation,
} from "@/components/plugin/PluginThreadListAnnotations";
import { cn } from "@bb/shared-ui/lib/utils";

type VisibleRow = { id: string; projectId: string };
const EMPTY_VISIBLE_ROWS: VisibleRow[] = [];
const VisibleRowsContext = createContext<
  ((row: VisibleRow) => () => void) | null
>(null);
const ProvidersContext = createContext<ReadonlyMap<string, ProviderInfo>>(
  new Map(),
);
const TimeContext = createContext(0);

export function ThreadBrowserRows({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const { data: providers } = useSystemProviders();
  const providerMap = useMemo(
    () => new Map((providers ?? []).map((provider) => [provider.id, provider])),
    [providers],
  );
  const entries = useRef(new Map<string, { row: VisibleRow; count: number }>());
  const frame = useRef<number | null>(null);
  const mounted = useRef(true);
  const [visible, setVisible] = useState<VisibleRow[]>([]);
  const register = useCallback((row: VisibleRow) => {
    const schedule = () => {
      if (!mounted.current || frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setVisible([...entries.current.values()].map((entry) => entry.row));
      });
    };
    const prior = entries.current.get(row.id);
    entries.current.set(row.id, { row, count: (prior?.count ?? 0) + 1 });
    schedule();
    return () => {
      const entry = entries.current.get(row.id);
      if (entry && entry.count > 1) entry.count -= 1;
      else entries.current.delete(row.id);
      schedule();
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  return (
    <VisibleRowsContext.Provider value={register}>
      <ProvidersContext.Provider value={providerMap}>
        <TimeContext.Provider value={now}>
          <PluginThreadListAnnotationsProvider
            threads={enabled ? visible : EMPTY_VISIBLE_ROWS}
          >
            {children}
          </PluginThreadListAnnotationsProvider>
        </TimeContext.Provider>
      </ProvidersContext.Provider>
    </VisibleRowsContext.Provider>
  );
}

export function useRegisterThreadBrowserRow(thread: ThreadListEntry) {
  const register = useContext(VisibleRowsContext);
  useEffect(
    () => register?.({ id: thread.id, projectId: thread.projectId }),
    [register, thread.id, thread.projectId],
  );
}

export function ThreadBrowserRowContent({
  thread,
  children,
  status,
  needsInput,
  hasError,
  working,
  childCount,
  collapsed,
  toggle,
  onSelect,
}: {
  thread: ThreadListEntry;
  children: ReactNode;
  status: string | null;
  needsInput: boolean;
  hasError: boolean;
  working: boolean;
  childCount: number;
  collapsed: boolean;
  toggle: ReactNode;
  onSelect?: () => void;
}) {
  const annotations = useThreadListAnnotation(thread.id);
  const now = useContext(TimeContext);
  const identities = annotations.flatMap((annotation) => annotation.identities);
  const agent = identities.find((identity) => identity.kind === "agent");
  const groupAnnotation = annotations.find((annotation) =>
    annotation.identities.some((identity) => identity.kind === "group"),
  );
  const group = groupAnnotation?.identities.find(
    (identity) => identity.kind === "group",
  );
  const teamView = groupAnnotation?.viewId ? groupAnnotation : undefined;
  const providers = useContext(ProvidersContext);
  const execution = thread.lastRequestedModel;
  const providerId = execution?.providerId ?? thread.providerId;
  const provider = providers.get(providerId) ?? null;
  const mark = getProviderIconInfo(providerId, provider);
  const workspace = thread.environmentBranchName ?? thread.environmentName;
  const metadata = [group?.label, workspace].filter(Boolean).join(" · ");
  const counters = collapsed
    ? annotations
        .flatMap((annotation) => annotation.counters)
        .filter((counter) => counter.value > 0)
    : [];
  return (
    <div className="pointer-events-none min-w-0 flex-1 py-2.5">
      {group?.color ? (
        <span
          aria-hidden
          className="arc-thread-team-accent"
          style={{ backgroundColor: group.color }}
        />
      ) : null}
      <div className="mb-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {provider && mark?.icon ? (
          <ProviderIconMark
            provider={provider}
            icon={mark.icon}
            className="size-3.5 shrink-0"
          />
        ) : (
          <Icon name="Bot" className="size-3.5 shrink-0" />
        )}
        <span
          className="min-w-0 flex-1 truncate"
          title={
            execution
              ? `Last requested model: ${execution.model}`
              : (provider?.displayName ?? providerId)
          }
        >
          {agent?.label ??
            execution?.model ??
            provider?.displayName ??
            providerId}
          {agent && execution ? (
            <span className="text-subtle-foreground"> · {execution.model}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "max-w-28 shrink-0 truncate text-xs",
            needsInput
              ? "text-warning"
              : hasError
                ? "text-destructive"
                : working && "text-success",
          )}
          title={status ?? undefined}
        >
          {needsInput
            ? "Needs input"
            : thread.queuedWork === "failed"
              ? "Queue failed"
              : hasError
                ? "Failed"
                : working
                  ? "Working…"
                  : thread.queuedWork === "waiting"
                    ? "Queued"
                    : formatRelativeTime({
                        timestamp: thread.latestAttentionAt || thread.createdAt,
                        now,
                      })}
        </span>
      </div>
      <div className="flex items-start gap-1 text-sm font-medium leading-5 text-foreground">
        <div className="min-w-0 flex-1">{children}</div>
        <span className="pointer-events-auto relative z-10 shrink-0">
          {toggle}
        </span>
      </div>
      {metadata || childCount > 0 ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {metadata ? (
            <>
              <Icon
                name={
                  thread.environmentBranchName ? "GitBranch" : "UserRoundPlus"
                }
                className="size-3 shrink-0"
              />
              <span className="min-w-0 truncate" title={metadata}>
                {group && teamView?.viewId ? (
                  <Link
                    className="pointer-events-auto relative z-10 hover:text-foreground hover:underline"
                    aria-label={`Open ${group.label} team view`}
                    onClick={onSelect}
                    to={`${getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id })}?${new URLSearchParams({ threadView: threadViewKey(teamView.pluginId, teamView.viewId) })}`}
                  >
                    {group.label}
                  </Link>
                ) : (
                  group?.label
                )}
                {group && workspace ? " · " : ""}
                {workspace}
              </span>
            </>
          ) : null}
          {childCount > 0 ? (
            <span className="shrink-0">
              {metadata ? "· " : ""}
              {childCount} {childCount === 1 ? "thread" : "threads"}
            </span>
          ) : null}
        </div>
      ) : null}
      {counters.length > 0 ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {counters
            .map((counter) => `${counter.value} ${counter.label}`)
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

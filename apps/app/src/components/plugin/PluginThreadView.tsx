import { useCallback, useEffect, useId } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { usePluginSlots } from "@/lib/plugin-slots";
import { usePluginFrontendBootComplete } from "@/lib/plugin-frontend-boot-state";
import { getThreadRoutePath } from "@/lib/route-paths";
import { PluginSlotMount } from "./PluginSlotMount";

export function threadViewKey(pluginId: string, id: string): string {
  return `${pluginId}/${id}`;
}

function CompanionFailure({ onCrash }: { onCrash: () => void }) {
  useEffect(onCrash, [onCrash]);
  return null;
}

export function useThreadView({
  threadId,
  projectId,
  isRootThread,
}: {
  threadId: string;
  projectId: string | null;
  isRootThread: boolean;
}) {
  const mainElementId = `bb-thread-main-${useId()}`;
  const { threadViews } = usePluginSlots();
  const bootComplete = usePluginFrontendBootComplete();
  const location = useLocation();
  const navigate = useNavigate();
  const pathname =
    projectId === null ? null : getThreadRoutePath({ projectId, threadId });
  const isCurrentRoute = location.pathname === pathname;
  const requested = isCurrentRoute
    ? new URLSearchParams(location.search).get("threadView")
    : null;
  const selected =
    (isRootThread ? threadViews : []).find(
      (slot) => threadViewKey(slot.pluginId, slot.id) === requested,
    ) ?? null;
  const stateKey =
    selected === null
      ? null
      : `threadViewState.${threadViewKey(selected.pluginId, selected.id)}`;
  const rawState =
    stateKey === null
      ? null
      : new URLSearchParams(location.search).get(stateKey);
  const viewState =
    rawState !== null && rawState.length <= 512 ? rawState : null;
  const onViewStateChange = useCallback(
    (value: string | null) => {
      if (pathname === null || !isCurrentRoute || stateKey === null) return;
      if (value !== null && (typeof value !== "string" || value.length > 512))
        return;
      if (value === rawState) return;
      const params = new URLSearchParams(location.search);
      if (value === null) params.delete(stateKey);
      else params.set(stateKey, value);
      const search = params.toString();
      navigate({
        pathname,
        search: search ? `?${search}` : "",
        hash: location.hash,
      });
    },
    [
      isCurrentRoute,
      location.hash,
      location.search,
      navigate,
      pathname,
      rawState,
      stateKey,
    ],
  );
  const select = useCallback(
    (value: string | null, replace = false) => {
      if (pathname === null) return;
      const params = new URLSearchParams(isCurrentRoute ? location.search : "");
      if (value === null) params.delete("threadView");
      else params.set("threadView", value);
      const search = params.toString();
      navigate(
        {
          pathname,
          search: search ? `?${search}` : "",
          hash: isCurrentRoute ? location.hash : "",
        },
        { replace },
      );
    },
    [isCurrentRoute, location.hash, location.search, navigate, pathname],
  );
  useEffect(() => {
    if (bootComplete && requested !== null && selected === null)
      select(null, true);
  }, [bootComplete, requested, selected, select]);
  const onCrash = useCallback(() => select(null, true), [select]);
  const Component = selected?.component;
  return {
    mainElementId,
    controls:
      isRootThread && projectId !== null && threadViews.length > 0 ? (
        <div
          role="group"
          aria-label="Thread view"
          className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
          data-thread-view-switch=""
        >
          <Button
            type="button"
            variant={selected === null ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-2 text-xs"
            aria-pressed={selected === null}
            onClick={() => select(null)}
          >
            Chat
          </Button>
          {threadViews.map((slot) => (
            <Button
              key={threadViewKey(slot.pluginId, slot.id)}
              type="button"
              variant={selected === slot ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-xs"
              aria-pressed={selected === slot}
              onClick={() => select(threadViewKey(slot.pluginId, slot.id))}
            >
              {slot.label}
            </Button>
          ))}
        </div>
      ) : null,
    companion:
      selected !== null && Component && projectId !== null ? (
        <section
          aria-label={selected.label}
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          data-thread-companion={threadViewKey(selected.pluginId, selected.id)}
        >
          <PluginSlotMount
            key={`${selected.pluginId}/${selected.id}/${selected.generation}/${threadId}`}
            pluginId={selected.pluginId}
            slotKind="threadView"
            slotId={selected.id}
            instanceId={threadId}
            crashFallback={<CompanionFailure onCrash={onCrash} />}
          >
            <Component
              threadId={threadId}
              projectId={projectId}
              mainElementId={mainElementId}
              viewState={viewState}
              onViewStateChange={onViewStateChange}
            />
          </PluginSlotMount>
        </section>
      ) : null,
  };
}

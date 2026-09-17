import { useEffect, useRef } from "react";
import {
  useRealtime,
  useRpc,
  type ExperimentalThreadListAnnotation,
  type ExperimentalThreadListAnnotationsProps,
} from "@get-bb/plugin-sdk/app";
import {
  arcThreadBrowserRpcContract,
  type ArcThreadBindings,
} from "./contract.js";

export function threadAnnotations(
  bindings: ArcThreadBindings,
): ExperimentalThreadListAnnotation[] {
  const annotations = new Map<string, ExperimentalThreadListAnnotation>();
  for (const origin of bindings.origins) {
    if (!origin.defaultRun) continue;
    const run = origin.defaultRun;
    annotations.set(origin.threadId, {
      threadId: origin.threadId,
      identities: run.team
        ? [
            {
              id: run.team.teamId,
              kind: "group",
              label: run.team.name,
              detail: `Team revision ${run.team.revision}`,
              color: null,
            },
          ]
        : [],
      counters: [
        { id: "runs", label: "team runs", value: origin.runsTotal },
        {
          id: "workers",
          label: "worker chats in this run",
          value: run.workerThreadsTotal,
        },
      ],
      viewId: "team",
    });
  }
  for (const worker of bindings.workers) {
    annotations.set(worker.threadId, {
      threadId: worker.threadId,
      identities: [
        {
          id: worker.agentId,
          kind: "agent",
          label: worker.name,
          detail: `${worker.role} · v${worker.revision} · ${worker.providerId} / ${worker.model}`,
          color: worker.group?.color ?? null,
        },
        ...(worker.group
          ? [
              {
                id: worker.group.id,
                kind: "group" as const,
                label: worker.group.name,
                detail: worker.team
                  ? `${worker.team.name} · v${worker.team.revision}`
                  : null,
                color: worker.group.color,
              },
            ]
          : worker.team
            ? [
                {
                  id: worker.team.teamId,
                  kind: "group" as const,
                  label: worker.team.name,
                  detail: `Team revision ${worker.team.revision}`,
                  color: null,
                },
              ]
            : []),
      ],
      counters: [],
      viewId: null,
    });
  }
  return [...annotations.values()];
}

export function ArcThreadAnnotations({
  projectId,
  threadIds,
  onChange,
}: ExperimentalThreadListAnnotationsProps) {
  const rpc = useRpc<typeof arcThreadBrowserRpcContract>();
  const publish = useRef(onChange);
  useEffect(() => {
    publish.current = onChange;
  }, [onChange]);
  const refresh = useRef<() => void>(() => undefined);
  const identity = JSON.stringify([...new Set(threadIds)].sort());
  useRealtime("runs:changed", () => refresh.current());
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let again = false;
    let watch = false;
    const ids: string[] = JSON.parse(identity);
    const load = async () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const annotations: ExperimentalThreadListAnnotation[] = [];
        let active = false;
        for (let offset = 0; offset < ids.length; offset += 100) {
          const result = await rpc.call("listThreadBindings", {
            projectId,
            threadIds: ids.slice(offset, offset + 100),
            runLimit: 1,
            runOffset: 0,
          });
          if (stopped) return;
          annotations.push(...threadAnnotations(result));
          active ||= result.origins.some(
            (origin) =>
              origin.defaultRun !== null &&
              (origin.defaultRun.state === null ||
                !["succeeded", "failed", "cancelled"].includes(
                  origin.defaultRun.state,
                )),
          );
        }
        watch = active;
        if (!stopped) publish.current(annotations);
      } catch {
        watch = true;
        if (!stopped) publish.current([]);
      } finally {
        inFlight = false;
        if (!stopped && again) {
          again = false;
          void load();
        }
      }
    };
    publish.current([]);
    refresh.current = () => void load();
    const visibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = setInterval(() => {
      if (watch && document.visibilityState === "visible") void load();
    }, 30_000);
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      refresh.current = () => undefined;
    };
  }, [rpc, projectId, identity]);
  return null;
}

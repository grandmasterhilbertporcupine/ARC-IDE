import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createContext, useContext } from "react";
import type { ThreadListEntry } from "@bb/domain";
import {
  createSidebarProjectIdResolver,
  hasActiveBackgroundAgentActivity,
  hasActiveBackgroundCommandActivity,
  hasActiveGoalActivity,
  hasActivePlanModeActivity,
  hasActiveWorkflowActivity,
  isRuntimeBusyThread,
  isUnreadDoneThread,
} from "@bb/client-core";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";

export const ALL_THREAD_PROJECTS = "all";
export type ThreadBrowserFilter = "all" | "working" | "attention" | "archived";

export const threadBrowserProjectAtom = atomWithStorage(
  "arc.threads.project",
  ALL_THREAD_PROJECTS,
  createLocalStorageSyncStorage<string>({
    parse: (value, initial) => value || initial,
    serialize: (value) => value,
  }),
  { getOnInit: true },
);

export const threadBrowserOpenAtom = atomWithStorage(
  "arc.threads.open",
  true,
  createLocalStorageSyncStorage<boolean>({
    parse: (value, initial) => (value === null ? initial : value !== "false"),
    serialize: String,
  }),
  { getOnInit: true },
);

export const threadBrowserDrawerOpenAtom = atom(false);
export const ThreadBrowserPresentation = createContext(false);
export const useThreadBrowserPresentation = () =>
  useContext(ThreadBrowserPresentation);
export const useThreadBrowserProject = () => useAtom(threadBrowserProjectAtom);

export function threadIsWorking(thread: ThreadListEntry): boolean {
  return (
    isRuntimeBusyThread(thread) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActiveGoalActivity(thread) ||
    hasActivePlanModeActivity(thread)
  );
}

export function threadNeedsAttention(thread: ThreadListEntry): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.queuedWork === "failed" ||
    (isUnreadDoneThread(thread) && thread.status === "error")
  );
}

export function filterBrowserThreads(
  threads: readonly ThreadListEntry[],
  projectId: string | null,
  filter: ThreadBrowserFilter,
): ThreadListEntry[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const resolveProject = createSidebarProjectIdResolver(byId);
  const inScope = threads.filter(
    (thread) =>
      thread.visibility !== "hidden" &&
      (projectId === null || resolveProject(thread) === projectId),
  );
  if (filter === "all" || filter === "archived") return inScope;
  const included = new Set<string>();
  for (const thread of inScope) {
    if (
      !(filter === "working"
        ? threadIsWorking(thread)
        : threadNeedsAttention(thread))
    )
      continue;
    let current: ThreadListEntry | undefined = thread;
    while (current && !included.has(current.id)) {
      included.add(current.id);
      current =
        current.parentThreadId === null
          ? undefined
          : byId.get(current.parentThreadId);
    }
  }
  return inScope.filter((thread) => included.has(thread.id));
}

import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ThreadListEntry } from "@bb/domain";
import type { ThreadSearchResult } from "@bb/server-contract";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";
import { getThreadRoutePath } from "@/lib/route-paths";
import { ThreadRow } from "./ThreadRow";

export function ThreadBrowserSearchResults({
  results,
  allThreads,
  selectedThreadId,
  onNavigate,
}: {
  results: readonly ThreadSearchResult[];
  allThreads: readonly ThreadListEntry[];
  selectedThreadId: string | undefined;
  onNavigate: () => void;
}) {
  const threads = useMemo(
    () => results.map((result) => result.thread),
    [results],
  );
  const drafts = usePromptDraftInputThreadIds(threads);
  const byId = useMemo(
    () => new Map(allThreads.map((thread) => [thread.id, thread])),
    [allThreads],
  );
  return results.map(({ thread, matches }) => {
    const parent = thread.parentThreadId
      ? byId.get(thread.parentThreadId)
      : undefined;
    const snippet = matches.find(
      (match) =>
        match.sourceKind !== "title" && match.sourceKind !== "title_fallback",
    );
    return (
      <div key={thread.id} className="border-b border-border-seam/50 pb-1">
        <ThreadRow
          thread={thread}
          projectId={thread.projectId}
          crossProjectId={null}
          isActive={thread.id === selectedThreadId}
          hasComposerDraft={drafts.has(thread.id)}
          onProjectSelect={onNavigate}
          options={{ kind: "default", depth: 0, isCompact: false }}
          {...(snippet?.sourceSeq !== null && snippet?.sourceSeq !== undefined
            ? { searchMessageSeq: snippet.sourceSeq }
            : {})}
        />
        {thread.parentThreadId ? (
          <p className="mx-4 mb-1 truncate text-xs text-muted-foreground">
            {parent ? (
              <Link
                onClick={onNavigate}
                to={getThreadRoutePath({
                  projectId: parent.projectId,
                  threadId: parent.id,
                })}
                className="hover:text-foreground"
              >
                From {getThreadDisplayTitle(parent)}
              </Link>
            ) : (
              "Delegated conversation"
            )}
          </p>
        ) : null}
        {snippet ? (
          <p
            className="mx-4 mb-2 line-clamp-2 text-xs leading-4 text-muted-foreground"
            title={snippet.text}
          >
            {snippet.text}
          </p>
        ) : null}
      </div>
    );
  });
}

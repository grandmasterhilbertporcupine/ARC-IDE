import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import type { TeamDetail, TeamTarget } from "./contract.js";
import { errorMessage } from "../studio/data.js";
import { useTeamQuery, useTeamRpc } from "./ui-data.js";

export function TeamHistory({
  target,
  version,
  dirty,
  onUpdated,
}: {
  target: TeamTarget;
  version: number;
  dirty: boolean;
  onUpdated(team: TeamDetail): void;
}) {
  const rpc = useTeamRpc();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useTeamQuery(
    `team-history:${target.teamId}:${offset}`,
    (client) =>
      client.call("listTeamRevisions", { ...target, offset, limit: 20 }),
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-5">
      <div>
        <h2 className="text-sm font-medium">Published versions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Restore a version into the draft. Existing runs keep their original
          snapshot.
        </p>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-sm text-destructive-text">
          {error ?? query.error}
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </p>
      )}
      {dirty && (
        <p className="text-xs text-muted-foreground">
          Save or discard local edits before restoring a version.
        </p>
      )}
      {!query.data && !query.error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading versions…
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-muted-foreground">
          Publish the team’s first version to start its history.
        </p>
      )}
      {query.data?.revisions.map((revision) => (
        <article key={revision.revision} className="space-y-2 border-b pb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">
                Version {revision.revision} · {revision.definition.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                {new Date(revision.createdAt).toLocaleString()} ·{" "}
                {revision.definition.members.length} members ·{" "}
                {revision.definition.graph.nodes.length} stages
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || dirty}
              onClick={() => {
                setBusy(true);
                setError(null);
                void rpc
                  .call("restoreTeamRevision", {
                    ...target,
                    expectedDraftVersion: version,
                    revision: revision.revision,
                  })
                  .then(
                    (value) => {
                      onUpdated(value.team);
                      query.refresh();
                    },
                    (failure) => setError(errorMessage(failure)),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Restore to draft
            </Button>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Inspect this version
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded border p-3 text-xs">
              {JSON.stringify(revision.definition, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      {query.data && query.data.total > 20 && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + 20, query.data.total)} of{" "}
            {query.data.total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + 20 >= query.data.total}
            onClick={() => setOffset(offset + 20)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export function TeamSuggestions({
  target,
  version,
  dirty,
  onUpdated,
}: {
  target: TeamTarget;
  version: number;
  dirty: boolean;
  onUpdated(team: TeamDetail): void;
}) {
  const rpc = useTeamRpc();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useTeamQuery(
    `team-proposals:${target.teamId}:${offset}`,
    (client) =>
      client.call("listTeamProposals", {
        ...target,
        status: null,
        offset,
        limit: 20,
      }),
  );
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-5">
      <div>
        <h2 className="text-sm font-medium">Suggested changes</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Review the exact changes before applying them to your draft.
        </p>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-sm text-destructive-text">
          {error ?? query.error}
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </p>
      )}
      {!query.data && !query.error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading suggestions…
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-muted-foreground">
          Ask the team assistant for a change. Its proposals will appear here
          for review.
        </p>
      )}
      {query.data?.proposals.map((proposal) => (
        <article key={proposal.id} className="space-y-3 border-b pb-5">
          <div>
            <h3 className="text-sm font-medium">{proposal.summary}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {proposal.status} · Based on draft {proposal.baseDraftVersion} ·{" "}
              {new Date(proposal.createdAt).toLocaleString()}
            </p>
          </div>
          <p className="text-xs">
            {proposal.operationalChanges
              ? "Changes team behavior or permissions."
              : "Changes presentation only."}
          </p>
          <p className="break-words text-xs text-muted-foreground">
            Changed: {proposal.changedFields.join(", ")}
          </p>
          {proposal.evidence.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs">
                Sources for this suggestion
              </summary>
              <dl className="mt-2 space-y-2 text-xs">
                {proposal.evidence.map((item, index) => (
                  <div key={index}>
                    <dt className="break-words font-medium">{item.source}</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                      {item.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          <div className="grid gap-3 @[1000px]/teams:grid-cols-2">
            <details>
              <summary className="cursor-pointer text-xs">Before</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded border p-3 text-xs">
                {JSON.stringify(proposal.beforeDefinition, null, 2)}
              </pre>
            </details>
            <details>
              <summary className="cursor-pointer text-xs">
                Proposed team
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded border p-3 text-xs">
                {JSON.stringify(proposal.definition, null, 2)}
              </pre>
            </details>
          </div>
          {proposal.validation.diagnostics.map((item, index) => (
            <p
              key={`${item.code}:${index}`}
              className="text-xs text-destructive-text"
            >
              {item.message}
            </p>
          ))}
          {proposal.status === "pending" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  busy || dirty || proposal.baseDraftVersion !== version
                }
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void rpc
                    .call("applyTeamProposal", {
                      ...target,
                      expectedDraftVersion: version,
                      proposalId: proposal.id,
                    })
                    .then(
                      (value) => {
                        onUpdated(value.team);
                        query.refresh();
                      },
                      (failure) => setError(errorMessage(failure)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Apply to draft
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || dirty}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void rpc
                    .call("rejectTeamProposal", {
                      ...target,
                      expectedDraftVersion: version,
                      proposalId: proposal.id,
                    })
                    .then(
                      () => query.refresh(),
                      (failure) => setError(errorMessage(failure)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Reject
              </Button>
              {proposal.baseDraftVersion !== version && (
                <span className="text-xs text-muted-foreground">
                  Draft changed. Ask for an updated proposal.
                </span>
              )}
              {dirty && (
                <span className="text-xs text-muted-foreground">
                  Save or discard local edits first.
                </span>
              )}
            </div>
          )}
        </article>
      ))}
      {query.data && query.data.total > 20 && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous
          </Button>
          <span className="text-xs">
            {offset + 1}–{Math.min(offset + 20, query.data.total)} of{" "}
            {query.data.total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + 20 >= query.data.total}
            onClick={() => setOffset(offset + 20)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

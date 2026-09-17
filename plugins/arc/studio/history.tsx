import { useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { AgentDetail, AgentProposal, AgentScope } from "../contract.js";
import { parseAgentDocument } from "../document.js";
import { errorMessage, useStudioQuery, useStudioRpc } from "./data.js";

interface HistoryProps {
  agent: AgentDetail;
  scope: AgentScope;
  disabled: boolean;
  onAccept(agent: AgentDetail): void;
  onError(error: string | null): void;
}

export function AgentHistory({
  agent,
  scope,
  disabled,
  onAccept,
  onError,
}: HistoryProps) {
  const rpc = useStudioRpc();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const query = useStudioQuery(`versions:${agent.id}:${offset}`, (client) =>
    client.call("listAgentRevisions", {
      agentId: agent.id,
      scope,
      limit: 20,
      offset,
    }),
  );
  const revision = query.data?.revisions.find(
    (value) => value.revision === selected,
  );

  async function restore(revision: number) {
    setBusy(true);
    onError(null);
    try {
      const result = await rpc.call("restoreAgentRevision", {
        agentId: agent.id,
        scope,
        revision,
        expectedDraftVersion: agent.draft.version,
      });
      onAccept(result.agent);
      query.refresh();
    } catch (failure) {
      onError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Published versions are immutable. Restoring an older version creates a
        new version and preserves this history. Restoring the current version
        discards saved draft changes. Save or discard unsaved edits first.
      </p>
      {query.error && (
        <p role="alert" className="text-xs text-destructive-text">
          {query.error}{" "}
          <button type="button" className="underline" onClick={query.refresh}>
            Retry
          </button>
        </p>
      )}
      {!query.data && query.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading versions…
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-muted-foreground">
          This agent has no published versions. Use Save version when its
          instructions are ready.
        </p>
      )}
      {query.data?.revisions.map((item) => (
        <div
          key={item.revision}
          className="flex items-center justify-between gap-2 border-b py-3"
        >
          <button
            type="button"
            className="min-w-0 text-left"
            aria-expanded={selected === item.revision}
            onClick={() =>
              setSelected(selected === item.revision ? null : item.revision)
            }
          >
            <span className="block text-sm font-medium">
              Version {item.revision}
              {item.revision === agent.currentRevision ? " · Current" : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(item.createdAt).toLocaleString()} ·{" "}
              {item.attachments.length} reference files
            </span>
          </button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              disabled ||
              busy ||
              (item.revision === agent.currentRevision &&
                !agent.hasUnpublishedChanges)
            }
            onClick={() => void restore(item.revision)}
          >
            {item.revision === agent.currentRevision
              ? "Discard saved draft changes"
              : "Restore as new version"}
          </Button>
        </div>
      ))}
      {(query.data?.total ?? 0) > 20 && (
        <div className="flex justify-between">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => {
              setSelected(null);
              setOffset(Math.max(0, offset - 20));
            }}
          >
            Newer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + 20 >= (query.data?.total ?? 0)}
            onClick={() => {
              setSelected(null);
              setOffset(offset + 20);
            }}
          >
            Older
          </Button>
        </div>
      )}
      {revision && (
        <section
          aria-label={`Version ${revision.revision} instructions`}
          className="space-y-3 border-t pt-4"
        >
          <h3 className="text-sm font-medium">
            {revision.metadata.name} · Version {revision.revision}
          </h3>
          <Markdown content={parseAgentDocument(revision.document).body} />
          {revision.attachments.length > 0 && (
            <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
              {revision.attachments.map((file) => (
                <p key={file.id}>
                  {file.name} · {file.sha256.slice(0, 12)}
                </p>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function AgentSuggestions({
  agent,
  scope,
  disabled,
  onAccept,
  onError,
}: HistoryProps) {
  const query = useStudioQuery(`suggestions:${agent.id}`, (rpc) =>
    rpc.call("listAgentProposals", {
      agentId: agent.id,
      scope,
      status: "pending",
      limit: 50,
    }),
  );
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        The assistant proposes changes here. Review the instructions and any
        model or permission changes before applying them to your draft.
      </p>
      {query.error && (
        <p role="alert" className="text-xs text-destructive-text">
          {query.error}{" "}
          <button type="button" className="underline" onClick={query.refresh}>
            Retry
          </button>
        </p>
      )}
      {!query.data && query.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading suggestions…
        </p>
      )}
      {query.data?.total === 0 && (
        <p className="text-sm text-muted-foreground">
          No pending suggestions for this agent.
        </p>
      )}
      {query.data?.proposals.map((proposal) => (
        <ProposalReview
          key={proposal.id}
          proposal={proposal}
          agent={agent}
          scope={scope}
          disabled={disabled}
          onAccept={onAccept}
          onError={onError}
          refresh={query.refresh}
        />
      ))}
      {(query.data?.total ?? 0) > 50 && (
        <p className="text-xs text-muted-foreground">
          Showing the first 50 pending suggestions. Review these to continue
          through the remaining suggestions.
        </p>
      )}
    </div>
  );
}

function ProposalReview({
  proposal,
  agent,
  scope,
  disabled,
  onAccept,
  onError,
  refresh,
}: HistoryProps & { proposal: AgentProposal; refresh(): void }) {
  const rpc = useStudioRpc();
  const [expanded, setExpanded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const stale = proposal.baseDraftVersion !== agent.draft.version;

  async function apply() {
    setBusy(true);
    onError(null);
    try {
      const result = await rpc.call("applyAgentProposal", {
        agentId: agent.id,
        scope,
        expectedDraftVersion: agent.draft.version,
        proposalId: proposal.id,
        confirmOperationalChanges: confirmed,
      });
      onAccept(result.agent);
      refresh();
    } catch (failure) {
      onError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    onError(null);
    try {
      await rpc.call("rejectAgentProposal", {
        agentId: agent.id,
        scope,
        proposalId: proposal.id,
      });
      refresh();
    } catch (failure) {
      onError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 border-b pb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{proposal.summary}</h3>
          <p className="text-xs text-muted-foreground">
            Based on draft {proposal.baseDraftVersion} ·{" "}
            {new Date(proposal.createdAt).toLocaleString()}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide changes" : "Review changes"}
        </Button>
      </div>
      {stale && (
        <p role="status" className="text-xs text-warning-text">
          This suggestion is out of date. Ask the assistant to propose against
          the current draft.
        </p>
      )}
      {expanded && (
        <div className="space-y-3">
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-2 text-xs font-medium">
                Current at proposal time
              </h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed p-3 font-mono text-xs">
                {proposal.beforeDocument}
              </pre>
            </div>
            <div className="min-w-0">
              <h4 className="mb-2 text-xs font-medium">Proposed</h4>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed p-3 font-mono text-xs">
                {proposal.document}
              </pre>
            </div>
          </div>
          {proposal.evidence.map((source, index) => (
            <p key={index} className="text-xs text-muted-foreground">
              <span className="font-medium">{source.source}</span>:{" "}
              {source.detail}
            </p>
          ))}
          {proposal.operationalChanges.length > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I reviewed the changes to{" "}
                {proposal.operationalChanges.join(", ")}.
              </span>
            </label>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={
                disabled ||
                busy ||
                stale ||
                (proposal.operationalChanges.length > 0 && !confirmed)
              }
              onClick={() => void apply()}
            >
              Apply to draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void reject()}
            >
              Dismiss suggestion
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

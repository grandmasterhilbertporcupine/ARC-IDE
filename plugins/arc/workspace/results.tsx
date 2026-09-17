import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import {
  arcRunUsageRpcContract,
  type CollaborationCursor,
  type RunResultReceipt,
  type RunUsageWorker,
  type RunDialogueState,
} from "../runtime/usage-contract.js";
import type {
  ReaderReport,
  RunMessage,
} from "../runtime/collaboration-contract.js";
import type { ArcWorkspaceView } from "./contract.js";

type Section = "usage" | "results" | "reports" | "messages";
const token = (value: number | null) =>
  value === null ? "Unavailable" : value.toLocaleString();
export function usageGroups(workers: RunUsageWorker[]) {
  const groups = new Map<
    string,
    {
      role: string;
      model: string;
      providerId: string;
      workers: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      missing: number;
    }
  >();
  for (const worker of workers) {
    const role = worker.role || worker.purpose;
    const key = JSON.stringify([role, worker.providerId, worker.model]);
    const group = groups.get(key) ?? {
      role,
      model: worker.model,
      providerId: worker.providerId,
      workers: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      missing: 0,
    };
    group.workers += 1;
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
    ] as const)
      if (worker[field] !== null)
        group[field] = (group[field] ?? 0) + worker[field];
    if (
      [worker.inputTokens, worker.outputTokens, worker.cachedInputTokens].some(
        (value) => value === null,
      )
    )
      group.missing += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function WorkspaceResults({ run }: { run: ArcWorkspaceView["run"] }) {
  const rpc = useRpc<typeof arcRunUsageRpcContract>();
  const runId = run.summary.runId;
  const [open, setOpen] = useState(false);
  const [dialogue, setDialogue] = useState<RunDialogueState | null>(null);
  const [workers, setWorkers] = useState<RunUsageWorker[]>([]);
  const [receipts, setReceipts] = useState<RunResultReceipt[]>([]);
  const [reports, setReports] = useState<ReaderReport[]>([]);
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [usageOffset, setUsageOffset] = useState<number | null>(null);
  const [resultOffset, setResultOffset] = useState<number | null>(null);
  const [reportCursor, setReportCursor] = useState<CollaborationCursor | null>(
    null,
  );
  const [messageCursor, setMessageCursor] =
    useState<CollaborationCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [runId],
  );
  async function load(section?: Section) {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const [usage, results, handoffs, inbox] = await Promise.all([
        !section || section === "usage"
          ? rpc.call("getRunUsage", {
              runId,
              offset: section ? (usageOffset ?? 0) : 0,
              limit: 20,
            })
          : null,
        !section || section === "results"
          ? rpc.call("getRunResults", {
              runId,
              offset: section ? (resultOffset ?? 0) : 0,
              limit: 20,
            })
          : null,
        !section || section === "reports"
          ? rpc.call("listRunCollaboration", {
              runId,
              kind: "reports",
              cursor: section ? reportCursor : null,
              limit: 10,
            })
          : null,
        !section || section === "messages"
          ? rpc.call("listRunCollaboration", {
              runId,
              kind: "messages",
              cursor: section ? messageCursor : null,
              limit: 10,
            })
          : null,
      ]);
      if (generation.current !== current) return;
      if (usage) {
        setWorkers((previous) =>
          section ? [...previous, ...usage.workers] : usage.workers,
        );
        setUsageOffset(usage.nextOffset);
      }
      if (results) {
        setDialogue(results.dialogue);
        setReceipts((previous) =>
          section ? [...previous, ...results.receipts] : results.receipts,
        );
        setResultOffset(results.nextOffset);
      }
      if (handoffs) {
        setReports((previous) =>
          section ? [...previous, ...handoffs.reports] : handoffs.reports,
        );
        setReportCursor(handoffs.nextCursor);
      }
      if (inbox) {
        setMessages((previous) =>
          section ? [...previous, ...inbox.messages] : inbox.messages,
        );
        setMessageCursor(inbox.nextCursor);
      }
    } catch (failure) {
      if (generation.current === current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Run evidence is unavailable",
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <section className="shrink-0 border-b" aria-label="Run usage and results">
      <div className="flex items-center gap-2 px-4 py-1">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            if (!open) void load();
          }}
        >
          Usage & results
        </Button>
        {open && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void load()}
          >
            Refresh evidence
          </Button>
        )}
      </div>
      {open && (
        <div className="max-h-80 space-y-4 overflow-auto px-4 pb-4 text-xs">
          {busy && <p role="status">Reading retained evidence…</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div>
            <h2 className="mb-2 text-sm font-medium">Reported tokens</h2>
            <p className="mb-2 text-muted-foreground">
              Totals cover the loaded worker turns. Cached input is part of
              input. Missing provider data is unavailable; these numbers do not
              estimate savings or cost.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="py-1 pr-3">Role / model</th>
                    <th className="pr-3">Input</th>
                    <th className="pr-3">Output</th>
                    <th className="pr-3">Cached input</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {usageGroups(workers).map((group) => (
                    <tr
                      key={JSON.stringify([
                        group.role,
                        group.providerId,
                        group.model,
                      ])}
                      className="border-t"
                    >
                      <td className="py-2 pr-3">
                        {group.role}
                        <span className="block text-muted-foreground">
                          {group.providerId} · {group.model}
                        </span>
                      </td>
                      <td className="pr-3">{token(group.inputTokens)}</td>
                      <td className="pr-3">{token(group.outputTokens)}</td>
                      <td className="pr-3">{token(group.cachedInputTokens)}</td>
                      <td>
                        {group.workers} turns
                        {group.missing > 0
                          ? ` · ${group.missing} incomplete`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!workers.length && !busy && (
              <p>No reported worker usage on this page.</p>
            )}
            {workers
              .filter((worker) => worker.reason)
              .map((worker) => (
                <p className="mt-1 text-muted-foreground" key={worker.effectId}>
                  {worker.name}: {worker.reason}
                </p>
              ))}
            {usageOffset !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void load("usage")}
              >
                Load more usage
              </Button>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium">
              Changes, checks and review
            </h2>
            {receipts.map((receipt) => (
              <details key={receipt.effectId} className="border-t py-2">
                <summary className="cursor-pointer">
                  {receipt.nodeId} · {receipt.state}
                  {receipt.validity ? ` · evidence ${receipt.validity}` : ""}
                </summary>
                <div className="space-y-1 pt-2 text-muted-foreground">
                  {receipt.reason && <p>{receipt.reason}</p>}
                  <p>
                    {receipt.changes ?? "No change summary in this receipt."}
                  </p>
                  {receipt.checks.map((check, index) => (
                    <p key={index}>
                      <code className="break-all">{check.command}</code> ·{" "}
                      {check.interrupted
                        ? "interrupted"
                        : check.exitCode === null
                          ? "exit unavailable"
                          : `exit ${check.exitCode}`}
                      {check.truncated ? " · output truncated in receipt" : ""}
                    </p>
                  ))}
                  {receipt.checksTruncated && (
                    <p>More processes are recorded in Run details.</p>
                  )}
                  <p>
                    {receipt.review
                      ? `${receipt.review.outcome}: ${receipt.review.summary} (${receipt.review.findings} findings)`
                      : "No review verdict in this receipt."}
                  </p>
                  {receipt.artifact && (
                    <p className="break-all">
                      Recorded artifact:{" "}
                      {receipt.artifact.path ?? "Path unavailable"} ·{" "}
                      {receipt.artifact.identity ?? "Identity unavailable"}
                    </p>
                  )}
                </div>
              </details>
            ))}
            {!receipts.length && !busy && (
              <p>No retained receipts on this page.</p>
            )}
            {resultOffset !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void load("results")}
              >
                Load more results
              </Button>
            )}
            <p className="mt-2 text-muted-foreground">
              Next action:{" "}
              {run.verification.state === "current"
                ? "Inspect the verified candidate and its checks in Run details before deciding whether to promote it."
                : "Inspect pending, failed or unavailable evidence in Run details. A worker’s completion does not verify the candidate."}
            </p>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium">Handoff reports</h2>
            {reports.map((item) => (
              <details key={item.id} className="border-t py-2">
                <summary className="cursor-pointer">
                  {item.memberId} · {new Date(item.createdAt).toLocaleString()}
                </summary>
                <div className="space-y-2 whitespace-pre-wrap pt-2">
                  <p>{item.report.findings}</p>
                  <p>Coverage: {item.report.coverage}</p>
                  <p>Omissions: {item.report.omissions || "None stated"}</p>
                  {item.report.files.map((file, index) => (
                    <p key={index}>
                      <code>{file.path}</code> · {file.detail}
                    </p>
                  ))}
                  {item.report.questions.map((question, index) => (
                    <p key={index}>Question: {question}</p>
                  ))}
                  <p className="break-all text-muted-foreground">
                    Source:{" "}
                    {item.source.kind === "git"
                      ? item.source.head
                      : item.source.manifestDigest}
                  </p>
                </div>
              </details>
            ))}
            {!reports.length && !busy && (
              <p className="text-muted-foreground">No retained reports.</p>
            )}
            {reportCursor && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void load("reports")}
              >
                Load more reports
              </Button>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium">Team messages</h2>
            {dialogue && (
              <div
                role="status"
                className="mb-2 space-y-1 text-muted-foreground"
              >
                <p>
                  {dialogue.unansweredQuestions} unanswered questions ·{" "}
                  {dialogue.state.replaceAll("-", " ")}
                </p>
                <p>
                  {dialogue.remainingCheckpoints} unadmitted response
                  checkpoints · {dialogue.remainingAgentCalls ?? "Unavailable"}{" "}
                  calls remaining ·{" "}
                  {dialogue.remainingActiveMs === null
                    ? "Active time unavailable"
                    : `${Math.ceil(dialogue.remainingActiveMs / 1000)} seconds remaining`}
                </p>
                <p>{dialogue.nextAction}</p>
              </div>
            )}
            {messages.map((item) => (
              <details key={item.id} className="border-t py-2">
                <summary className="cursor-pointer">
                  {item.fromMemberId} → {item.message.toMemberId} ·{" "}
                  {item.message.kind}
                </summary>
                <p className="whitespace-pre-wrap pt-2">{item.message.text}</p>
                {item.message.replyTo && (
                  <p className="text-muted-foreground">
                    Reply to {item.message.replyTo}
                  </p>
                )}
              </details>
            ))}
            {!messages.length && !busy && (
              <p className="text-muted-foreground">No retained messages.</p>
            )}
            {messageCursor && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void load("messages")}
              >
                Load more messages
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

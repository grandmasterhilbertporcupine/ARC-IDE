import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { z } from "zod";
import { arcPolicyRpcContract } from "../policy/contract.js";
import { arcTeamsRpcContract, type TeamRevision } from "../teams/contract.js";
import { errorMessage } from "../studio/data.js";
import type { ArcRunView } from "./contract.js";
import {
  arcRuleUpdatesRpcContract,
  ruleUpdatePreviewSchema,
  type RuleUpdatePreviewResult,
} from "./rule-update-contract.js";
import type { RuleUpdateQuery } from "./run-updates.js";
import { RuleReviewDetails } from "./rule-review.js";
import { useUpdateRequest } from "./use-update-request.js";

type Rpc = typeof arcRuleUpdatesRpcContract &
  typeof arcTeamsRpcContract &
  typeof arcPolicyRpcContract;
type PolicyView = z.infer<
  typeof arcPolicyRpcContract.getOrchestrationPolicy.output
>;
const pendingSchema = z
  .object({
    operationId:
      arcRuleUpdatesRpcContract.applyRunRuleUpdate.input.shape.operationId,
    preview: ruleUpdatePreviewSchema,
    intent: z.enum(["apply", "cancel"]),
  })
  .strict();

export function RuleUpdates({
  run,
  query,
  changed,
  onIntentChange,
}: {
  run: ArcRunView;
  query: RuleUpdateQuery;
  changed(): void;
  onIntentChange(pending: boolean): void;
}) {
  const rpc = useRpc<Rpc>();
  const application = query.data?.outgoing ?? null;
  const update = useUpdateRequest({
    runId: run.summary.runId,
    storageKey: `arc:rule-update:v1:${run.summary.runId}`,
    schema: pendingSchema,
    application,
    accept: query.accept,
    changed,
    onIntentChange,
    actions: {
      apply: (input) => rpc.call("applyRunRuleUpdate", input),
      poll: (input) => rpc.call("pollRunRuleUpdate", input),
      cancel: (input) => rpc.call("cancelRunRuleUpdate", input),
    },
  });
  const definition = run.definition;
  const teamId = definition.schemaVersion === 1 ? null : definition.team.teamId;
  const teamRevision =
    definition.schemaVersion === 1 ? 0 : definition.team.revision;
  const [open, setOpen] = useState(update.pending !== null);
  const [revisions, setRevisions] = useState<TeamRevision[]>([]);
  const [selected, setSelected] = useState(String(teamRevision));
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [result, setResult] = useState<RuleUpdatePreviewResult | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (application?.state === "cancelled") setResult(null);
  }, [application?.operationId, application?.state]);
  const busy = reviewing || update.busy;
  const held = application !== null && application.state !== "cancelled";
  const canPreview =
    teamId !== null &&
    run.workflow !== null &&
    !["succeeded", "failed", "cancelled"].includes(run.workflow.state) &&
    !held &&
    !update.needsRetry &&
    !query.blockedReason;
  const displayPreview =
    application && application.state !== "cancelled"
      ? application.preview
      : (update.unresolvedPending?.preview ??
        (result?.disposition === "restart" ? result.preview : null));
  const review =
    displayPreview ??
    (result && result.disposition !== "restart" ? result.review : null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!open || !teamId || held || update.needsRetry) return;
    let current = true;
    setLoading(true);
    void Promise.all([
      rpc.call("listTeamRevisions", {
        scope: { kind: "project", projectId: run.summary.projectId },
        teamId,
        limit: 20,
        offset,
      }),
      rpc.call("getOrchestrationPolicy", {
        projectId: run.summary.projectId,
        threadId: definition.request.originThreadId,
      }),
    ]).then(
      ([teams, settings]) => {
        if (!current) return;
        setRevisions(
          teams.revisions.filter((item) => item.revision >= teamRevision),
        );
        setTotal(teams.total);
        setPolicy(settings);
        setLoading(false);
      },
      (error: unknown) => {
        if (!current) return;
        setReviewError(errorMessage(error));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [
    rpc,
    open,
    teamId,
    teamRevision,
    run.summary.projectId,
    definition.request.originThreadId,
    offset,
    held,
    update.needsRetry,
  ]);

  async function preview() {
    if (!canPreview || !teamId || !selected || !policy || busy) return;
    const current = ++generation.current;
    setReviewing(true);
    setReviewError(null);
    update.clearError();
    setResult(null);
    try {
      const value = await rpc.call("previewRunRuleUpdate", {
        runId: run.summary.runId,
        team: { teamId, revision: Number(selected) },
        expectedProjectPolicyVersion: policy.project.version,
        expectedSessionPolicyVersion: policy.session?.version ?? 0,
      });
      if (current === generation.current) setResult(value);
    } catch (error) {
      if (current === generation.current) setReviewError(errorMessage(error));
    } finally {
      if (current === generation.current) setReviewing(false);
    }
  }
  async function refreshSettings() {
    const current = ++generation.current;
    setLoading(true);
    setReviewError(null);
    setResult(null);
    try {
      const settings = await rpc.call("getOrchestrationPolicy", {
        projectId: run.summary.projectId,
        threadId: definition.request.originThreadId,
      });
      if (current === generation.current) setPolicy(settings);
    } catch (error) {
      if (current === generation.current) setReviewError(errorMessage(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  const staleControl =
    displayPreview !== null &&
    displayPreview.controlVersion !== run.workflow?.controlVersion;
  const error = reviewError ?? update.error;
  return (
    <section
      aria-label="Update operational rules"
      className="min-w-0 space-y-3 border-t pt-3 text-sm"
    >
      <Button
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Update operational rules
      </Button>
      {open && (
        <>
          <p className="text-muted-foreground">
            Review saved project and session settings, team checks and agent
            permissions for this run. Saving settings leaves active runs
            unchanged.
          </p>
          {application && (
            <p role="status">
              Rule update {application.state}. {application.reason}
            </p>
          )}
          {!held && !update.needsRetry && (
            <>
              <label className="block">
                Team revision for rule review
                <select
                  aria-label="Team revision for rule review"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2"
                  value={selected}
                  disabled={busy || loading || !canPreview}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setResult(null);
                  }}
                >
                  {selected !== String(teamRevision) &&
                    !revisions.some(
                      (item) => String(item.revision) === selected,
                    ) && (
                      <option value={selected}>
                        Selected team · v{selected}
                      </option>
                    )}
                  {teamId &&
                    !revisions.some(
                      (item) => item.revision === teamRevision,
                    ) && (
                      <option value={teamRevision}>
                        Current team · v{teamRevision}
                      </option>
                    )}
                  {revisions.map((item) => (
                    <option key={item.revision} value={item.revision}>
                      {item.definition.name} · v{item.revision}
                      {item.revision === teamRevision ? " (current)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-muted-foreground">
                Keep the current team revision to apply settings changes only.
              </p>
              {loading && <p role="status">Loading current settings…</p>}
              {policy && (
                <p>
                  Project settings v{policy.project.version}; session settings v
                  {policy.session?.version ?? 0}.
                </p>
              )}
              {policy?.errors.map((message) => (
                <p role="alert" key={message}>
                  {message}
                </p>
              ))}
              <div className="flex flex-wrap gap-2">
                {offset > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || loading}
                    onClick={() =>
                      setOffset((value) => Math.max(0, value - 20))
                    }
                  >
                    Previous rule revisions
                  </Button>
                )}
                {offset + 20 < total && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || loading}
                    onClick={() => setOffset((value) => value + 20)}
                  >
                    More rule revisions
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading || !policy || !canPreview}
                  onClick={() => void preview()}
                >
                  Review rule changes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || loading || !canPreview}
                  onClick={() => void refreshSettings()}
                >
                  Refresh saved settings
                </Button>
              </div>
            </>
          )}
          {result?.disposition === "no-running-change" && !displayPreview && (
            <p role="status">No running change. {result.reason}</p>
          )}
          {result?.disposition === "blocked" && !displayPreview && (
            <div role="alert">
              <p>These rules cannot be applied yet.</p>
              <ul className="mt-2 space-y-1">
                {result.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}:${index}`}>{blocker.message}</li>
                ))}
              </ul>
            </div>
          )}
          {review && <RuleReviewDetails review={review} run={run} />}
          {displayPreview && !held && !update.needsRetry && (
            <>
              <p>
                The entire team restarts from the verified original source. It
                needs new approvals and checks. Earlier results remain
                historical, and used calls, active time and repair rounds count
                toward the reviewed total limits.
              </p>
              <Button
                size="sm"
                disabled={busy || !canPreview || staleControl}
                onClick={() =>
                  void update.submit({
                    operationId: crypto.randomUUID(),
                    preview: displayPreview,
                    intent: "apply",
                  })
                }
              >
                Pause and apply rules
              </Button>
              {staleControl && (
                <p role="alert">
                  Run controls changed. Review the rules again before applying.
                </p>
              )}
            </>
          )}
          {update.retry &&
            (update.needsRetry ||
              (held && application?.state !== "applied")) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (update.retry) void update.submit(update.retry);
                  }}
                >
                  {busy
                    ? "Updating rules…"
                    : update.retry.intent === "cancel"
                      ? "Retry rule cancellation"
                      : "Continue rule update"}
                </Button>
                {update.retry.intent !== "cancel" &&
                  application?.state !== "applied" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (update.retry)
                          void update.submit({
                            ...update.retry,
                            intent: "cancel",
                          });
                      }}
                    >
                      Cancel rule update
                    </Button>
                  )}
              </div>
            )}
          {application?.state === "cancelled" && (
            <p>
              The rule update was cancelled. The original run was not replaced.
              If paused, use Resume when ready.
            </p>
          )}
          {query.blockedReason && !held && (
            <p className="text-muted-foreground">{query.blockedReason}</p>
          )}
          {query.error && (
            <p role="alert">
              {query.error}{" "}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void query.refresh()}
              >
                Refresh update status
              </Button>
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
          {update.storageError && (
            <p role="alert" className="text-destructive">
              {update.storageError}
            </p>
          )}
        </>
      )}
    </section>
  );
}

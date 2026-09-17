import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { z } from "zod";
import { arcTeamsRpcContract, type TeamRevision } from "../teams/contract.js";
import { errorMessage } from "../studio/data.js";
import type { ArcRunView } from "./contract.js";
import type { InstructionUpdateQuery } from "./run-updates.js";
import { useUpdateRequest } from "./use-update-request.js";
import {
  arcInstructionUpdatesRpcContract,
  instructionUpdatePreviewSchema,
  type InstructionUpdatePreview,
} from "./instruction-update-contract.js";

type Rpc = typeof arcInstructionUpdatesRpcContract & typeof arcTeamsRpcContract;
const pendingSchema = z
  .object({
    operationId:
      arcInstructionUpdatesRpcContract.applyRunInstructionUpdate.input.shape
        .operationId,
    preview: instructionUpdatePreviewSchema,
    intent: z.enum(["apply", "cancel"]),
  })
  .strict();

export function InstructionUpdates({
  run,
  query,
  onIntentChange,
  changed,
}: {
  run: ArcRunView;
  query: InstructionUpdateQuery;
  onIntentChange(pending: boolean): void;
  changed(): void;
}) {
  const rpc = useRpc<Rpc>();
  const application = query.data?.outgoing ?? null;
  const update = useUpdateRequest({
    runId: run.summary.runId,
    storageKey: `arc:instruction-update:v1:${run.summary.runId}`,
    schema: pendingSchema,
    application,
    accept: query.accept,
    changed,
    onIntentChange,
    actions: {
      apply: (input) => rpc.call("applyRunInstructionUpdate", input),
      poll: (input) => rpc.call("pollRunInstructionUpdate", input),
      cancel: (input) => rpc.call("cancelRunInstructionUpdate", input),
    },
  });
  const { needsRetry, unresolvedPending, retry, submit } = update;
  const [open, setOpen] = useState(update.pending !== null);
  const [revisions, setRevisions] = useState<TeamRevision[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<InstructionUpdatePreview | null>(null);
  const [reviewError, setError] = useState<string | null>(null);
  const [reviewing, setBusy] = useState(false);
  const busy = reviewing || update.busy;
  const error = reviewError ?? update.error;
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (application?.state === "cancelled") setPreview(null);
  }, [application?.operationId, application?.state]);
  const definition = run.definition;
  const teamId = definition.schemaVersion === 1 ? null : definition.team.teamId;
  const teamRevision =
    definition.schemaVersion === 1 ? 0 : definition.team.revision;
  const held = application !== null && application.state !== "cancelled";
  const displayPreview =
    application?.state !== "cancelled" && application
      ? application.preview
      : (unresolvedPending?.preview ?? preview);
  const canPreview =
    run.workflow !== null &&
    !["succeeded", "failed", "cancelled"].includes(run.workflow.state) &&
    !held &&
    !needsRetry &&
    !query.blockedReason;
  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!open || teamId === null || held || needsRetry) return;
    let current = true;
    setLoading(true);
    void rpc
      .call("listTeamRevisions", {
        scope: { kind: "project", projectId: run.summary.projectId },
        teamId,
        limit: 20,
        offset,
      })
      .then(
        (result) => {
          if (!current) return;
          setRevisions(
            result.revisions.filter((item) => item.revision > teamRevision),
          );
          setTotal(result.total);
          setLoading(false);
        },
        (failure: unknown) => {
          if (current) {
            setError(errorMessage(failure));
            setLoading(false);
          }
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
    offset,
    held,
    needsRetry,
  ]);

  async function review() {
    if (!teamId || !selected || !canPreview || busy) return;
    const current = ++requestGeneration.current;
    setBusy(true);
    setError(null);
    update.clearError();
    setPreview(null);
    try {
      const result = await rpc.call("previewRunInstructionUpdate", {
        runId: run.summary.runId,
        team: { teamId, revision: Number(selected) },
      });
      if (current === requestGeneration.current) setPreview(result);
    } catch (failure) {
      if (current === requestGeneration.current)
        setError(errorMessage(failure));
    } finally {
      if (current === requestGeneration.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Update run instructions"
      className="space-y-3 border-t pt-3 text-sm"
    >
      <Button
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Update instructions
      </Button>
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
      {open && (
        <>
          <p className="text-muted-foreground">
            Publishing leaves active runs unchanged. Review a newer revision of
            this team to apply agent instructions explicitly.
          </p>
          {application && (
            <p role="status">
              Update {application.state}. {application.reason}
            </p>
          )}
          {!held && !needsRetry && (
            <>
              {loading ? (
                <p role="status">Loading published revisions…</p>
              ) : (
                <label className="block">
                  Published team revision
                  <select
                    aria-label="Published team revision"
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2"
                    value={selected}
                    disabled={busy || !canPreview}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">Choose a newer revision</option>
                    {selected &&
                      !revisions.some(
                        (item) => String(item.revision) === selected,
                      ) && (
                        <option value={selected}>
                          Selected team · v{selected}
                        </option>
                      )}
                    {revisions.map((revision) => (
                      <option key={revision.revision} value={revision.revision}>
                        {revision.definition.name} · v{revision.revision}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!loading && revisions.length === 0 && (
                <p className="text-muted-foreground">
                  No newer revision on this page. Publish changed agent
                  instructions, then publish a team revision using them.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {offset > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOffset((value) => Math.max(0, value - 20));
                      setSelected("");
                      setPreview(null);
                    }}
                  >
                    Previous revisions
                  </Button>
                )}
                {offset + 20 < total && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOffset((value) => value + 20);
                      setSelected("");
                      setPreview(null);
                    }}
                  >
                    More revisions
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !selected || !canPreview}
                  onClick={() => void review()}
                >
                  Review instruction changes
                </Button>
              </div>
              {!canPreview && !query.blockedReason && (
                <p className="text-muted-foreground">
                  Instruction updates require an active team run.
                </p>
              )}
            </>
          )}
          {displayPreview && (
            <div className="space-y-3">
              <p className="font-medium">
                {displayPreview.oldTeam.name} · v
                {displayPreview.oldTeam.revision} → v
                {displayPreview.newTeam.revision}
              </p>
              <p>
                The entire team starts again from the verified original source.
                Earlier results remain in this run’s history. Consumed calls,
                active time and repair rounds carry forward within the same
                limits.
              </p>
              <p className="break-all text-muted-foreground">
                Original{" "}
                {displayPreview.source.kind === "git" ? "repository" : "folder"}
                : {displayPreview.source.path}
              </p>
              {displayPreview.changes.map((change) => (
                <details key={change.memberId} className="border-t pt-2">
                  <summary className="cursor-pointer">
                    {change.name} · agent v{change.oldRevision} → v
                    {change.newRevision}
                  </summary>
                  <div className="mt-2 grid min-w-0 gap-3 lg:grid-cols-2">
                    <div>
                      <h3 className="font-medium">Current instructions</h3>
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
                        {change.before}
                      </pre>
                    </div>
                    <div>
                      <h3 className="font-medium">Proposed instructions</h3>
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
                        {change.after}
                      </pre>
                    </div>
                  </div>
                </details>
              ))}
              <p className="text-muted-foreground">
                Affected steps:{" "}
                {displayPreview.affectedNodes
                  .map((node) => node.label)
                  .join(", ")}
              </p>
              {!held && !needsRetry && (
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !canPreview ||
                    displayPreview.controlVersion !==
                      run.workflow?.controlVersion
                  }
                  onClick={() =>
                    void submit({
                      operationId: crypto.randomUUID(),
                      preview: displayPreview,
                      intent: "apply",
                    })
                  }
                >
                  Pause and apply instructions
                </Button>
              )}
              {!held &&
                !needsRetry &&
                displayPreview.controlVersion !==
                  run.workflow?.controlVersion && (
                  <p role="alert">
                    Run controls changed. Review the instructions again before
                    applying.
                  </p>
                )}
            </div>
          )}
          {retry &&
            (needsRetry || (held && application?.state !== "applied")) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void submit(retry)}
                >
                  {busy
                    ? "Updating instructions…"
                    : retry.intent === "cancel"
                      ? "Retry cancellation"
                      : "Continue instruction update"}
                </Button>
                {retry.intent !== "cancel" &&
                  application?.state !== "applied" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void submit({ ...retry, intent: "cancel" })
                      }
                    >
                      Cancel instruction update
                    </Button>
                  )}
              </div>
            )}
          {application?.state === "cancelled" && (
            <p>
              The update was cancelled. The original run was not replaced. If
              paused, use Resume when ready.
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

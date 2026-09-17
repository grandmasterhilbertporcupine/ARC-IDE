# Reviewed instruction updates

This Phase 4 slice applies agent instruction bodies to active graph runs. Publishing an agent or team revision never changes an existing run. In Run details, open **Update instructions**, choose a newer published revision of the same project team, review the exact old/new bodies and affected steps, then choose **Pause and apply instructions**.

The update reruns the entire team from the verified original source in a linked continuation. It preserves the predecessor's candidates, conversations and receipts as history. It carries consumed agent calls, charged active time and per-stage repair usage forward within the same limits. It does not reuse earlier results as authority for the new instructions. Workspace and Run details link the two runs and label replaced results as historical.

## Scope

V2 Git graphs, V3 main-composer graphs and V4 serial folders share the continuation contract. Fixed V1 runs require a new run. This slice accepts only instruction body changes through newer published agent revisions in a newer revision of the same team. Agent metadata, references, provider/permission settings, graph structure, tasks, grants, checks and operational policy must remain unchanged. Team restrictions must allow the exact proposed revision, and policy versions must still match. Broader operational-rule updates remain a separate acceptance item.

[Operational-rule updates](ARC-RULE-UPDATES.md) use a separate explicit preview while sharing the same continuation engine and active-update lock. `getRunUpdateState` reads mixed instruction/rule lineage; the older instruction-only state RPC retains its original response shape. Operational-rule native acceptance is recorded separately.

## SDK and CLI

Use `sdk.plugins.callRpc({pluginId: "arc", method, input})` or `bb arc runs rpc <method> --input <json>`. Large previews can use the existing `--input-file`, `--host` and `--output-file` options.

1. `previewRunInstructionUpdate({runId, team:{teamId,revision}})` returns `previewId`, `previewHash`, the exact prior plan/control version, original source identity, old/new team revisions, changed bodies and affected nodes. Review this result before applying.
2. `applyRunInstructionUpdate({operationId,previewId,previewHash})` retains the exact reviewed operation before requesting durable pause. Reuse these fields after response loss.
3. `pollRunInstructionUpdate({runId,operationId})` advances that saved update. The returned application exposes `pausing`, `checking`, `starting`, `applied`, `cancelling`, `cancelled` or `failed`, plus its reason and successor ID. Polling is an explicit continuation action.
4. `getRunInstructionUpdateState({runId})` returns `incoming` and `outgoing` applications. This is read-only; reopening a view never starts the replacement.
5. `cancelRunInstructionUpdate({runId,operationId,previewId,previewHash})` cancels the exact reviewed operation before admission. Retain the cancellation intent and those fields after response loss. Cancellation can reserve an absent operation as cancelled, fencing a late Apply without pausing the original. If pause already began, cancellation leaves the original paused for explicit Resume. Once successor admission is sealed, cancellation cannot restore the predecessor.

The UI retains request identity and cancellation intent across reloads, stops advancing polls when closed, and offers an explicit retry. Source movement or stale policy/control context requires cancelling the failed update and reviewing again. Workers cannot apply these user decisions through their contextual CLI.

## Runtime boundaries

Workflows owns reservation, pause/quiescence, retirement, successor admission and cumulative counters. ARC owns reviewed instruction content, source validation, immutable snapshots and historical lineage. The successor is prepared only after native work and validation effects have settled and the original source has been verified again. Ordinary start/reconcile paths cannot bypass continuation admission. Cancellation and retries do not reset usage.

New persistence is appended after existing migrations. Existing V1/V2 Workflows inputs and legacy run receipts retain their meaning. No second scheduler or new daemon wire contract is introduced by this slice.

Implementation and verification are tracked in [ARC-PROGRESS](ARC-PROGRESS.md). A completed code change does not imply native or release acceptance.

# Serial project folders

Status: the serial folder runtime passed source verification and native Windows acceptance with Codex on September 10, 2026. Exact evidence and remaining Phase 4 gates are recorded in [ARC-PROGRESS.md](ARC-PROGRESS.md). Git runs keep their existing versioned definitions and receipts.

ARC definition V4 runs a published team against a project folder without creating Git metadata. Workflows remains the only scheduler. Each writing stage receives a fresh, run-owned working copy. Completed output is captured as a retained snapshot. Checks and reviews identify the exact snapshot; repair starts from a new copy of the failed candidate. The original folder and earlier candidates are preserved. The final response uses the original main conversation and consumes one admission within the same run budget.

## Setup and requests

The Runs form identifies the selected source, asks for the main conversation and goal, and offers **Inspect project folder** for a non-Git source. It displays inventory failures and graph capability diagnostics before starting work. Retrying after a lost acknowledgement keeps the same saved request.

The matching SDK surface is `sdk.plugins.callRpc({pluginId:"arc",method,input})`; the CLI is `bb arc runs rpc <method>` or `bb arc orchestrator rpc <method>`. Both support JSON input and the documented host input/output-file flags.

| Method | Input and result |
| --- | --- |
| `getProjectRunSetup` | `{projectId,hostId:null|string}` returns registered sources, main conversations and selected `kind:"git"|"directory"`. Git includes its actual HEAD/clean state. Host errors are not converted to directory results. This does not start an inventory or provider. |
| `getDirectoryRunSetup` | `{operationId,projectId,originThreadId,hostId}` durably records the registered source and main environment before starting one read-only scan. Repeat the same input while pending. |
| `requestDirectoryTeamRun` | Takes the fields below and saves one V4 run. Direct user SDK/CLI only; native main-agent admission has a separate authoritative invocation boundary. |
| `discardDirectoryRunRequest` | Takes the exact unused user request. Returns the existing reserved run, or confirms permanent retirement before a changed request can be made. It does not cancel an existing run. |
| `reconcileOrchestratedRun` | `{runId}` reuses the saved V3 or V4 definition after an uncertain admission. It does not select newer policies, teams or source files. |
| `resolveDirectoryRunControl` | Same input as `resolveRunControl`: `{runId,controlId,operationId,expectedRevision,contextHash,decision:"approved"|"rejected"}`. Returns `{state:"checking"|"resolved",control}`. Repeat the exact request while checking; the decision is saved only after fresh inspection. |

Directory setup returns its `operationId`, `sourceInspectionId`, `hostId` and canonical `path`, plus one of:

- `state:"pending"`: the same scan is unfinished. Poll the same operation.
- `state:"ready"`: `source` includes physical `rootIdentity`, `manifestDigest`, entry count and file bytes.
- `state:"failed"`: a named `code` and `reason` describe the failure. An interrupted unknown scan requires a new read-only inspection operation.
- `state:"consumed"`: `runId` identifies the run already using this inspection. Reconcile that run or inspect again for a separate user request.

`requestDirectoryTeamRun` requires:

```json
{
  "operationId": "stable-user-run-operation",
  "projectId": "selected-project",
  "originThreadId": "selected-main-conversation",
  "hostId": "selected-host",
  "path": "C:/Projects/My app",
  "sourceInspectionId": "returned-inspection-id",
  "expectedSource": {
    "rootIdentity": { "deviceId": "returned-device-id", "fileId": "returned-file-id" },
    "manifestDigest": "returned-sha256"
  },
  "goal": "The requested outcome",
  "team": { "teamId": "selected-published-team", "revision": 1 },
  "expectedProjectPolicyVersion": 0,
  "expectedSessionPolicyVersion": 0
}
```

The values above illustrate fields; use actual returned IDs, decimal filesystem identities, digest and policy versions. There is no `expectedHead` for a directory. Inspection consumption and run reservation share one SQLite transaction. A failed reservation leaves the inspection unconsumed; a different request cannot reuse an inspection already bound to a run.

Main agents use `arc_orchestration_context`, then `arc_directory_source_inspect({hostId,operationId:null})`. Pending scans are polled with the returned operation ID. `arc_directory_team_run_request` accepts the directory request fields except operation/project/thread/invocation identity, which ARC derives from the actual native call. Owned automatic completion turns cannot request fresh independent budgets. Finish the requesting turn after admission so the separately admitted completion can arrive.

## Candidates, checks and coverage

The approval UI displays its folder inspection while retrying the same decision, revision and operation ID. Leaving the view stops polling and retains the exact request for an explicit retry; it does not undo an already accepted decision. The original `resolveRunControl` remains available and reports `validation_pending` until directory evidence is ready. Resuming an interrupted run and approving a pending decision remain separate actions.

The host inventories regular files and directories, including dotfiles, empty directories, dependencies and build outputs. It rejects links/junctions and unsupported entries with the affected path. It does not silently exclude files, install dependencies or flatten an installed pnpm tree. Initial limits are 100,000 entries, 8 GiB total file bytes, 1 GiB per file, 32 MiB encoded manifest and depth 128. These are explicit format limits, not claims about full metadata backup or OS sandboxing.

A snapshot has its own retained identity and physical copy, not just a content hash. A materialized worker directory has a separate physical identity. Copying records intent and the destination reservation before filesystem mutation, verifies source and destination, and makes the result available only after a confirmed receipt. Incomplete destinations are retained for reconciliation and never silently adopted, overwritten or replayed.

Checks launch the configured executable and arguments directly. Their before/after manifests and native process receipts must identify the same candidate. A command that changes candidate files, including cache/coverage/build output, is invalid even if it exits zero. This first implementation does not remap output directories automatically. A review verdict records `kind:"directory"`, `snapshotId`, `manifestDigest`, outcome, summary and findings through the actual assigned reviewer.

Parallel stages, unordered compatible writers and Git integration are rejected for directory execution. Use serial candidate dependencies or a Git project for parallel writing. Conditions, approvals, bounded repair/delegation and selected activation joins retain their declared graph semantics. An activation join does not create a new candidate by itself. Final checks and review must cover the selected candidate's writing stages.

Long inventories use retained asynchronous host inspection jobs. A pending fresh validation displays **Verifying folder contents** and blocks dependent admission/completion without replacing the historical receipt or charging a second agent call. Pausing interrupts active scans; confirmed quiescence retains the historical evidence. Explicit recheck/resume must obtain fresh evidence before dispatch. Unknown copy/process effects still require reconciliation. These are observations of stable contents, not atomic filesystem snapshots.

## Verification and acceptance

Run and Workspace inspection display the exact retained final proof and its `checkedAt` timestamp as **Last verified candidate**. Opening or polling a view does not start a competing inventory scan. The timestamp describes historical evidence; each execution action requires fresh validation under the scheduler. A missing or mismatched retained proof is shown as unavailable.

Native acceptance passed in `.arc-verification/directory-runtime/2026-09-10T14-58-50-745Z-7bbf043a/result.json`. The actual main agent admitted a preferred, restricted team revision; a real owning restart preserved its zero-call approval. After browser approval, three serial workers completed building, repair and snapshot review, followed by one counted main response. The required check caught the planted 201-versus-200-cent defect; repair and final checks passed. The independent final audit confirmed complete unchanged original and retained inventories, exact native/core identities, the selected proof timestamp, CLI parity, three real handoffs, zero replay after reload and no browser errors.

The preceding failed fixture-briefing attempt and a premature startup read are retained separately. The latter was retried only after SDK/database checks proved the same run remained paused with no resume or worker call; the immutable failure and explicit recovery history remain in the successful artifact. All 387 ARC and 302 Workflows tests passed, including real Git compatibility and directory crash-recovery tests. This verifies the bounded Codex developer-machine path; it does not certify other providers, linked dependency trees, large-project performance, an installer or the remaining Phase 4 gates.

# Workflows built-in plugin

Workflows is an opt-in built-in plugin (`builtin:workflows`) and is disabled on
fresh ARC installations. It runs provider-independent JavaScript orchestration
inside QuickJS while delegating actual reasoning to ordinary ARC threads.

The author-facing native surface is intentionally one tool:
`bb_workflow_run`. Validation, inspection, listing, and cancellation use the
`bb workflows` CLI documented below. Provider and model discovery uses ARC's
built-in `bb provider` commands. Structured workers separately
receive only `bb_workflow_result`; ordinary authoring agents never receive that
worker tool.

## Progress UI

A successful `bb_workflow_run` result includes a trusted
`previewDirective` such as:

```text
::workflow-preview{run="wfr_…"}
```

The authoring agent emits that returned value exactly once on a standalone
line. ARC replaces the directive with a compact live run card in chat. The card
shows run state, declared phases, the active phase's workers, elapsed time, and
an action that opens the full workflow inspector in the thread's right panel.
While a thread has queued or running workflows, the plugin also contributes a
status card above that thread's composer. It lists every active run with its
current phase and agent-call progress and lets the user stop a run in place;
the card disappears when the thread has no active runs.
The panel shows every phase and worker, links attached workers to their ARC
threads, reports cache and result state, and can stop an active run. It may also
be opened directly from the thread panel action, in which case it shows that
thread's latest run.

Both surfaces are implemented by the plugin app with `@bb/shared-ui` controls
and ARC theme tokens. Directive attributes and restored panel parameters are
treated as untrusted input. The backend additionally binds every requested run
to the directive message or panel thread, so a run ID from another thread
cannot be inspected or stopped through these UI RPCs. The service publishes a
`workflow-runs` realtime signal for the origin thread when a run starts, is
claimed, settles, or is cancelled, so the composer status surface learns about
new runs without a standing poll; it and the active message cards poll once
per second only while a run is active and the page is visible, refresh once
when the page or the realtime connection comes back, and stop when terminal.

The security boundary is the QuickJS context: workflow code has JSON data and
explicit orchestration capabilities, but no Node, filesystem, shell, network,
imports, clock, or randomness. The QuickJS WASM is embedded in the plugin's
single-file server bundle so packaged built-ins need no sidecar asset.
JSON Schema compilation and result validation necessarily run in the Node host,
not inside QuickJS, so every metadata and agent-output schema is restricted
before Ajv sees it. The supported subset covers boolean schemas plus common
structured-output keywords: `type`, `properties`, `required`,
`additionalProperties`, `items`, scalar `enum`, `const`, numeric/string/array/
object size bounds, `nullable`, and annotation keywords. Regex and format
validation, references, combinators/conditionals, `uniqueItems`, `contains`,
dependent/unevaluated schemas, unknown keywords, structured enums, and excessive
property or enum fanout are rejected with the schema path and safety reason.
Schemas also retain the 64 KiB, 4,096-node, depth, cycle, and prototype-safety
limits. This deliberately conservative subset keeps host-side validation
bounded and preserves ordinary object/array structured results.

Metadata may declare an ordered literal `phases` array. Every entry has a
required non-empty, unique `title` and an optional non-empty `detail`; unknown
fields and malformed entries are rejected. Declaration order is preserved.
`phase(title)` changes the current phase, and later agent calls inherit it.
An agent-level `phase` applies only to that call and does not change the current
phase.

Workflow input follows the native Claude source modes: provide exactly one of
an inline `script`, a workspace `scriptPath`, or a workflow `name`. The older
`source` field remains an explicit alias for inline `script`; `script` and
`source` cannot be supplied together. Name lookup is project-local at
`.bb/workflows/<name>.js`. There is no plugin-bundled workflow discovery.

File and name sources are resolved on the workflow origin environment's host,
not on the ARC server machine. ARC reads them through the environment `hostId`
with `rootPath` confinement to its workspace. Traversal and outside absolute or
UNC paths, missing workspace roots, non-UTF-8 content, and sources larger than
512 KiB are rejected. QuickJS receives only the resolved source text and never
receives a filesystem capability.

Durability lives in the plugin-owned SQLite database. Runs and ordered agent
calls are persisted independently. On restart the source is evaluated from the
beginning and successful calls are replayed by a SHA-256 key until the first
divergence. Explicit resume uses the same longest-unchanged-prefix rule against
the selected prior run. Parallel calls receive identities in deterministic
invocation order, so concurrency does not stop replay. The first edited, new,
failed, cancelled, incomplete, or null-result call and the entire suffix run
live. Successful calls are reusable regardless of which tools they used,
including file edits and other writes, because resume is restricted to the same
environment workspace where those effects remain. Runs created before
replay-safety metadata existed replay nothing.

Agent calls retry transient provider failures twice with bounded backoff before
the failure reaches the workflow script. Retryability comes from an explicit
SDK `retryable` marker when available or conservative overload, rate-limit,
provider 5xx, and network-error signatures. Authentication, configuration,
schema, and other deterministic failures are not retried. Retry attempts are
persisted on the call so a plugin restart cannot reset the retry budget.

Worker output is either the final assistant text or an Ajv-validated value
submitted through `bb_workflow_result`. Structured workers receive two
corrective retries after their initial invalid attempt.

Required work uses `parallelSettled()` or `pipelineSettled()` followed by
`requireSuccess(outcomes)`. Settled helpers preserve each success or failure
instead of converting failures into data. `requireSuccess` returns successful
values in input order, or throws before the next statement when any required
outcome failed or was explicitly skipped. A schema-valid `null`, `false`, or
`0` is successful data, not a failure. A successful call still needs its own
domain checks: a returned `{ passed: false }` does not mean a test passed.

`pipelineSettled()` streams independent items without a stage barrier. A
failed stage records its zero-based `stageIndex` and skips later stages for
that item. Null values continue through subsequent stages. Callbacks must
return a value; `undefined` is a failure, and `null` is the explicit empty
result. Optional outcomes can be inspected separately and excluded from the
required gate deliberately. The legacy `parallel()` and `pipeline()` helpers
retain their documented failure-to-null behavior for existing workflows;
they must not serve as required review, test, or release gates.

Workflow workers use ARC's generic hidden-thread visibility. They remain
out of sidebar organization without contributing unread/pending favicon
attention. Retention archives them when it deletes their run, because a
stopped worker keeps its thread row and no server cascade reaches a root
hidden thread. Ordinary search, prompt history,
lifecycle, and direct operations remain available. Workers are root threads,
so no parent notification applies; a hidden thread that does have a parent
still reports its turns and blockers to it. Workflows does not create a
temporary Workflow folder.

Workflows may invoke one child workflow level with
`workflow(nameOrRef, args)`. A string and `{ name }` resolve under
`.bb/workflows`, `{ scriptPath }` uses the same origin-workspace confinement as
top-level runs, and `{ script }` is inline source. Each child is parsed,
schema-validated, and evaluated in a separate QuickJS VM. Parent and child VMs
share one FIFO agent scheduler, call budget, cancellation signal, replay order,
and phase/progress record. A child cannot invoke a grandchild.

## Settings

Workflows declares six plugin settings:

- `maxActiveRuns` limits runs dispatched at once across the plugin.
- `maxConcurrentAgents` limits live agent calls within one run, including its
  child workflow.
- `maxAgentCalls` bounds the shared parent/child call count.
- `totalRunTimeoutMs` fails a run independently of explicit cancellation.
- `retentionDays` controls terminal-run cleanup while preserving active runs
  and retained resume ancestors. The sweep archives each expired run's worker
  threads before it deletes the run, and keeps the run for a later sweep when a
  worker does not archive.
- `maxNotificationBytes` bounds completion messages by UTF-8 byte length.

`maxActiveRuns` is live plugin-global dispatch policy: changing it immediately
changes how many queued runs the worker may claim. The other five values are
snapshotted into each new run and remain fixed for that run, including a resumed
run. Saving settings does not require a plugin reload.
Terminal runs send an agent-only completion input back to the origin thread. It
steers an active origin immediately or starts a turn when the origin is idle,
while remaining absent from the user-facing timeline and search. Polling the
compact `status` summary remains authoritative when a completion message is
truncated or temporarily cannot be delivered. Completion delivery is
at-least-once: a successful `threads.send` followed by a crash before its durable
acknowledgement may produce a duplicate because the API has no idempotency key.
Duplicates carry the same stable run ID marker. Failed attempts use durable,
capped exponential backoff. Status exposes notification outcome as `pending`,
`delivered`, or `abandoned`; a missing or deleted origin permanently records
`abandoned` so it cannot block retention.

Useful checks:

```bash
pnpm exec turbo run typecheck --filter=bb-plugin-workflows
pnpm exec turbo run test --filter=bb-plugin-workflows --force
bb plugin build plugins/workflows
```

User-facing commands (run these from an ARC project thread) are:

```bash
bb workflows validate --script '<javascript>'
bb workflows validate --file .bb/workflows/review.js
bb workflows validate --name review
bb workflows run --script '<javascript>' --args '<json>'
bb workflows run --file .bb/workflows/review.js --resume <run-id>
bb workflows run --name review
bb workflows status <run-id>
bb workflows history <run-id> --cursor 0 --limit 100
bb workflows list --limit 20
bb workflows stop <run-id>
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

`status` is deliberately bounded: it returns run state, phase, call counts,
notification state, and only a small final result. It omits source, arguments,
and call history so polling cannot be truncated into invalid JSON.
`list` is likewise bounded and returns compact run summaries rather than source
or result bodies. Untrusted names, phases, and errors are capped by UTF-8 bytes;
the adjacent `*Truncated` fields report when a displayed value was shortened.

`history` returns one strict JSONL snapshot page ordered by call index. Redirect
it before inspecting it so large prompts and results never enter the agent
transcript:

```bash
run=<run-id>
mkdir -p "$BB_THREAD_STORAGE/workflows"
bb workflows history "$run" --cursor 0 --limit 100 \
  > "$BB_THREAD_STORAGE/workflows/$run.jsonl"
```

The final `page` record reports `hasMore` and `nextCursor`. Fetch the next page
with that cursor and append it to the same file. A full `run` record appears on
the first page, later pages include a small `run-reference`, and every call
record includes requested options, resolved provider/model/reasoning/permission,
cache/live state, child thread ID, repairs, result, and error. Pages are
snapshots; while a run is active, rewrite the file from cursor `0` when a fresh
detailed view is needed.

This redirection intentionally happens in the invoking agent's shell. The
canonical state remains in the plugin's server-side SQLite database, while the
JSONL file lands in `$BB_THREAD_STORAGE` on that thread's execution host. The
same flow therefore works for local and remote environments without granting
the server arbitrary filesystem-write access.

Before selecting an explicit provider tuple, query only the relevant provider
with ARC's built-in commands above. Never infer ACP model IDs from a provider
name: for example, an ACP provider can advertise `grok-4.5` even though neither
that model ID nor its reasoning options can be derived from `acp-grok`.

`--source` is retained as an inline alias for `--script`. `run` and `validate`
share source resolution and validation. Validation checks the 512 KiB limit,
hidden control characters, JavaScript syntax and unsafe constructs, literal
metadata and JSON Schemas, partial literal provider/model/reasoning tuples, and
every discoverable literal tuple against the live origin-host provider data.
Errors distinguish unavailable providers, model-load failures, model
mismatches, and unsupported reasoning levels.

For the CLI, a relative `--file` is resolved from the invoking CLI's current
directory. That directory and the final path must both remain inside the
origin environment workspace; absolute and traversal escapes are rejected.
Relative agent-tool `scriptPath` values remain rooted at the workspace root.

Agent options accept native `label`, `phase`, and `schema` alongside ARC's
existing `title` and `outputSchema`. `label` resolves to canonical `title`, and
`schema` resolves to canonical `outputSchema`. Both spellings of an alias may
be provided only when structurally identical; schema object key order is
ignored.
`provider`, `model`, and `reasoningLevel` remain all-or-none. Title/label/phase
are display-only and do not participate in resume cache identity. The canonical
output schema does participate, regardless of which accepted spelling supplied
it.

Resume requires a terminal prior run from the same project and environment
workspace. Another origin thread may resume it only when that thread uses the
same environment. Successful writer calls are cached just like read-only calls;
their effects are not copied into another workspace.

## ARC owned runs

ARC uses the same `workflow-worker` service and active-run limit as ordinary
Workflows. Its immutable manifest is admitted through private plugin RPC;
ordinary scripts and public Workflows RPC cannot create owned runs. ARC owns
the user-facing run SDK, CLI, project policy, compiler and native execution
adapter. The shared schemas are exported as `bb-plugin-workflows/owned-contract`.

Owned scripts call `step(nodeId, iteration, input)`. The manifest fixes the node,
iteration, dependencies, required outcomes, definition and optional integration
lane before execution. `agent()` and nested workflow execution cannot bypass
that admission. Successful steps return their JSON receipt, including `null`.
Failed or interrupted steps reject with an error whose `stepFailure` contains
the immutable step identity, state, receipt and receipt hash. Returning from a
script succeeds only when every required gate has current successful receipts
and all admitted native work has settled.

Start is idempotent by owner/run identity and the complete canonical request.
Pause, resume and cancel use both an operation ID and expected control version.
Pause fences dispatch before requesting interruption and remains pending while
native work is running or unknown. A lost response never proves an effect was
absent. Observed absence reuses the original dispatch reservation; an observed
interruption requires a new physical attempt. The existing maintenance pass
observes prepared work and can advance ARC's already admitted preparation to
its first native turn under the current control generation.

Owned rows retain separate steps, physical attempts, stage repair rounds,
native resource identities, fenced lanes and immutable terminal receipts.
Receipt validity is rechecked separately; stale or unavailable verification
holds dispatch without rewriting historical outcomes. Legacy cache replay,
interrupted-call reset and retention do not touch these rows.

Adapters with asynchronous inspections use additive validation observations and
lookup acknowledgements. A `checking` observation retains the exact terminal
outcome, resource and receipt hash while a named scan is running or quiescent.
Dependent work and final completion wait for the acknowledged scan result;
validation does not consume another agent call. Pause/cancel waits for confirmed
scan quiescence. A stale tagged proof requires explicit recheck/resume, which
validates retained evidence under a new generation before admitting new work.
Maintenance also refreshes older-generation current proofs when replay skips
their original branch. Legacy synchronous observation contracts remain valid.

Defaults are four active agents, 100 admitted agent calls, three repair rounds
per stage and two hours of active work. Host effects and waiting parents do not
consume agent slots. Receipt replay does not consume calls. Active-time
reservations are durable, measured intervals reconcile without resetting the
budget, confirmed pause excludes idle time, and a worker restart conservatively
retains its unresolved interval while excluding the offline gap.

Reviewed instruction replacement uses four additional owner-only RPCs:
`reserveOwnedContinuation`, `inspectOwnedContinuation`,
`startOwnedContinuation` and `cancelOwnedContinuation`. Reservation binds the
predecessor, operation ID and successor owner/run identity, checks the expected
control version, and requests durable pause. Ordinary controls and direct
`startOwnedRun` calls cannot bypass this reservation. Cancelling an unconsumed
reservation leaves the original paused and permits an explicit resume; the
cancelled successor identity cannot be reused.

A continuation is `ready` only after native attempts, validation requests,
running scans and open active-time intervals have settled. Waiting owner
approvals and CI controls are retained during reservation. Starting seals the
complete successor request, requests cancellation of the predecessor's remaining
controls, and reports `retiring` until their actual interruption is observed.
Maintenance then atomically retires the predecessor and admits exactly one
successor. The `successorPlanHash` is null before sealing. Changed-input retries
conflict; a consumed reservation cannot be cancelled. Inspection is read-only and
returns null for an absent reservation after validating ownership of its predecessor.

The successor must retain the same owner, project, origin, limits and repair-stage
identities. Workflows derives cumulative calls, settled active time and repair
usage from its own ledger. Repair baselines offset the successor's local round
numbers, so repeating a continuation cannot reset a work item's limits. Prior
manifests, native receipts and outcomes remain immutable. ARC owns the reviewed
instruction diff, semantic result invalidation and user-facing replacement flow.

Reviewed operational-rule changes use `startOwnedRuleContinuation` with the same
reservation, inspection and cancellation methods. Its strict input contains
`predecessorWorkflowRunId`, `operationId`, the complete V2 `successor`, and
`authorization: {schemaVersion: 1, reviewHash, repairStages}`. Each stage declares
its stable `stageId`, `beforeMaxRounds` and `afterMaxRounds`. The new method may
change total limits after quiescence; those totals include inherited consumption.
Limits below consumed calls, settled time or stage rounds leave the reservation
unconsumed. A limit equal to consumption grants no further charged work.

The exact method, review and successor are sealed together. Ordinary and reviewed
starts cannot replay each other's seals. A zero-inclusive stage catalog is
transferred atomically with accounting through both continuation families, so
disabling or lowering a stage cannot erase its identity or past usage. Existing
uncatalogued runs retain manifest-based compatibility. A legacy zero-round
manifest has unknown dormant stage identities; only ARC's explicit reviewed
authorization may initialize those IDs, all with zero before ceilings.

`inspectOwnedRuleContext({workflowRunId})` is an owner-only pure read returning
`{run, repairCatalog}`. `run.repairRounds` contains cumulative stage usage.
`repairCatalog` is either `{source: "stored" | "manifest", stages}` with exact
`{stageId, maxRounds}` entries, or `{source: "legacy-zero"}`. The latter represents
unknown dormant identities rather than an empty catalog. Reading does not run
maintenance, launch validation or alter the run. ARC owns policy, Team, grant,
provider and required-check semantics and binds its reviewed values to the sealed
plan; this Workflows method does not independently confer those permissions.

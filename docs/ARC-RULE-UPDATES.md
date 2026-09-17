# Reviewed operational rules

Active Team runs retain immutable instructions, operational settings and published team revisions. Saving project/session settings or publishing another team revision does not change a running snapshot. Run details exposes an explicit rule review alongside instruction-only updates. The implementation uses the existing Workflows continuation engine and one shared update ledger; it does not create another scheduler.

## Review and apply

Read `getOrchestrationPolicy({projectId,threadId})` and select the current or a newer published revision of the same project Team. The current revision supports policy-only changes. `previewRunRuleUpdate({runId,team:{teamId,revision},expectedProjectPolicyVersion,expectedSessionPolicyVersion})` compares the exact saved settings, published definitions and resolved execution choices with the run's snapshot.

The response distinguishes three outcomes:

- `no-running-change`: preferred-team, presentation or effectively masked/inherited settings do not require a restart. The review explains the result and has no applicable preview identity.
- `blocked`: the selected team is excluded, a structural or metadata change is unsupported, permissions are invalid, execution cannot be resolved, or proposed cumulative limits are below recorded usage. The response provides typed blockers. No successor, source inspection or pause is allocated for this review.
- `restart`: an immutable applicable preview contains its ID/hash, exact policy/team versions, old/new values, affected steps, complete repair-stage ceilings, observed usage and original source identity.

The review can cover autonomy, overall limits, team restrictions, directed collaboration grants, delegation choices, native check commands/timeouts, completion requirements, repair ceilings and agent execution. Simultaneous agent instruction-body changes are shown explicitly. Provider/model inheritance is displayed with the exact resolved execution tuple. Presentation and preferred-team changes are identified as affecting future selection. Changed checks are shown exactly; the application does not certify an arbitrary changed command as stronger or weaker.

This bounded operation preserves project, original source, main conversation/environment, Team identity, member-to-agent identities, graph stage identities/kinds, edges and candidate references. Attachments, unrelated agent metadata and structural graph changes require a separate new run. V1 fixed runs do not support this operation. V3/V4 main-response execution stays pinned to its existing binding.

After reviewing an applicable result, call `applyRunRuleUpdate({operationId,previewId,previewHash})`. Reuse these exact values after a lost response. ARC reserves the operation, pauses and quiesces the original run, verifies original source again and rechecks settings/execution. The entire team restarts from that source in one linked successor. It receives fresh approvals, checks and review work; old receipts and candidates remain historical and cannot authorize the successor.

## Recovery and budgets

`pollRunRuleUpdate({runId,operationId})` advances an explicitly saved application. Returned states are `pausing`, `checking`, `starting`, `applied`, `cancelling`, `cancelled` and `failed`. Reopening Run details or Workspace performs read-only inspection and does not automatically Apply.

`cancelRunRuleUpdate({runId,operationId,previewId,previewHash})` retains cancellation intent before attempting cancellation. Retrying the same request resolves lost replies. Cancellation can prevent a late Apply even before pause is reserved. If pause already began, cancelling an unconsumed update leaves the original paused for explicit Resume. Once successor admission is sealed, cancellation cannot restore the original; continue inspection of the same operation and control its resulting run.

`getRunUpdateState({runId})` reads mixed incoming/outgoing lineage as `{kind:"instructions"|"rules",application}` entries. Both operation types share one active-update lock, source verification and recovery engine. Existing instruction RPC payloads and saved browser requests remain compatible; `getRunInstructionUpdateState` continues to expose instruction entries only. Server control guards protect both kinds even for older clients.

Calls and active time are cumulative across the full continuation chain. Repair usage is cumulative per stable stage. Proposed totals are new overall grants, not fresh remaining allocations: four used calls with a reviewed total of six leave two. Workflows derives usage from its own ledger, validates ceilings before sealing and atomically transfers them at admission. ARC accepts no caller-supplied consumption counters. Lower concurrency applies after old work is quiescent. Zero remaining allowance is disclosed and does not promise that a successor can finish.

A durable repair catalog preserves every stage identity, including disabled stages. Disabling and later enabling a stage cannot discard prior usage. Ordinary instruction continuations retain exact limits and stage ceilings; only a reviewed rule amendment can change them. A cap below actual usage blocks admission. Additional consumption between preview and pause is rechecked without silently increasing the reviewed grant.

## Review permissions

Review grants are directed from the reviewer to every other member whose work can be present in the candidate. Serial writes inherit earlier contributors; integration combines its base and writers; repair retains previous authors and adds its repairer. A writing delegation includes every permitted child writer. The read-only requester is not an author merely because it delegates. Self-review does not need a self-grant; other contributors still require explicit grants.

Publication validates the complete declared contributor set. Runtime preparation, resumed review work, authoritative verdicts and new final verification use the exact retained Team and effect identity. Missing grants fail closed without rewriting old receipts or preventing cancellation and physical verification from settling. Publishing a grant elsewhere does not change a bound active snapshot; the reviewed rule update is the path to adopt it. Revoking a grant while keeping a graph that requires it is blocked.

`getRunReviewAuthority({runId})` returns `authorized`, `invalid` or `legacy` with typed Team diagnostics. It is read-only and separate from physical candidate verification. A saved hash/timestamp still identifies file evidence; it does not assert review permission validity. V1 fixed runs are `legacy` because they predate Team grants. Grants govern authoritative review work and verdicts, not general filesystem access or a new sandbox.

## SDK, CLI and evidence

All methods use `sdk.plugins.callRpc({pluginId:"arc",method,input})` or `bb arc runs rpc <method> --input <json>`. The existing `--input-file`, `--host` and `--output-file` options support large reviews. Mutating review/apply/poll/cancel operations are user-only; worker context cannot supply operational authority. Read operations retain project scope checks.

Actual verification and remaining native gates are recorded in [ARC-PROGRESS.md](ARC-PROGRESS.md). Instruction-body native evidence is separate from operational-rule acceptance. [ARC-INSTRUCTION-UPDATES.md](ARC-INSTRUCTION-UPDATES.md) documents the unchanged narrow instruction operation.

# ARC runtime implementation contract

This refines Phase 3 of [ARC-PLAN](ARC-PLAN.md). It does not replace its acceptance gates. Implementation status and actual evidence belong in [ARC-PROGRESS](ARC-PROGRESS.md).

## Responsibility and execution

Workflows remains the only scheduler and JavaScript workflow executor. ARC owns project policy, immutable run definitions, agent snapshots, compilation, the execution adapter and the user-facing run view. The ARC host entry owns native Git/process operations and their receipts. Do not create another workflow service or scheduler inside ARC.

The first complete run has two isolated writers, a required join, serial integration into a run-owned worktree, review and a native check of the integrated candidate, an actual failed-check repair, and durable pause/recovery. Work in a managed worktree never authorizes changing the original checkout or publishing a branch.

## Server plugin calls

Extend the existing Standard Schema RPC registry with `bb.rpc.experimental_registerInternal` and `bb.rpc.experimental_client`. Registrations are separate from public RPC routes. The client captures its plugin handle; core supplies the actual caller plugin ID and cancellation signal. Input and output are validated. Public HTTP, CLI and agent tools cannot call internal handlers.

Resolve active generations on each call and recheck after asynchronous validation. Withdraw registrations and abort their invocations before disposal closes services or databases. Failed candidate activation preserves the previous live generation. A transport/disposal exception is an unknown effect outcome, not evidence that the requested operation never started.

Workflows owns the shared, pure contract for owned runs and ARC adapters. Export that contract from the Workflows package; ARC may depend on those schemas, never its service implementation. The Workflows adapter admits ARC as its initial owner and verifies caller identity. ARC accepts execution callbacks only from Workflows.

## Prepared workers

Add server-bound `bb.experimental_threads.prepare`, `getPreparation` and `startPrepared` operations with ownership captured from the plugin handle. ARC's public run RPC and CLI remain the end-user surface.

Preparation reserves one thread under a unique owner/operation ID and canonical request hash. It seals the first input, provider/execution tuple, project, environment specification and immutable execution-context ID. Repeating identical input observes the same reservation; changed input rejects. Keep the operation tombstone after thread deletion.

Seal an explicit `turnPolicy` of `single` or `conversation`. ARC runtime workers use `single`: only the admitted first client request may dispatch. Ordinary Send-now, retry, edit, clear or compact paths cannot create an unbudgeted additional turn. A corrective action is a new admitted worker on a retained verified workspace. Native provider compaction within that admitted turn remains inherited behavior. This core guard is required because the public dispatch hook alone is intentionally bypassed by Send-now.

New ARC preparations also seal `parentNotification: "owner-controlled"`. Completion and interruption remain visible as passive parent history; they do not automatically start or steer a parent provider turn outside Workflows. Omission retains legacy BB notification behavior and the original request hash for existing preparations. A future orchestrator response requires explicit owned admission. The current run counter measures admitted worker calls; manual main-chat turns are separate BB conversation activity.

Reuse existing environment placement, worktree provisioning, setup execution and workspace-ready events without creating a provider turn. Persist the preparation and provisioning intent before dispatch. Do not manufacture a fork, empty turn or distant scheduled message. A core hold must prevent ordinary send, retry, Send-now and alternate dispatch paths from releasing the reserved first message.

After ARC binds and verifies the prepared environment, `startPrepared` atomically releases the sealed first input under an expected reservation revision and environment identity. Record its queued-message ID and actual client-turn request ID. Repeating the call observes that receipt; it never sends another first message. Stop, deletion, owner disposal and stale callbacks must not release the hold.

A missing provisioning or native-start acknowledgment after restart requires reconciliation. Do not rerun setup or recreate a worktree because an in-memory request disappeared. An existing ready environment is reusable; an existing turn request is observable. A Git preflight followed by dispatch must be described as preflight unless the daemon enforces the expected revision at its execution boundary. Any added daemon wire field requires the protocol-version decision mandated by AGENTS.md.

Match worker completion through the retained client request ID, its native input-accepted event and that event's turn scope. A later preparation reconciliation state does not erase a recorded native completion. Confirmed cancelled or failed preparation without a client request ID is terminal before dispatch, including when a sealed queued-message ID already exists.

## Durable Workflows state

Persist each admitted owner/run, plan hash, source, manifest, limits, control version and dispatch generation. Start is idempotent by owner/run ID and the complete canonical request. The manifest fixes each node's kind, definition hash and integration lane; script inputs cannot supply different protected commands, agent revisions or authority.

Compile bounded loops into explicit node/iteration entries with fixed dependency identities and required outcomes. A repair round belongs to a stage iteration; it is distinct from a physical dispatch attempt. Immutable required gates prevent an early script return from bypassing required checks. Control requests also carry an operation ID so a lost pause/resume response can be retried without another transition.

Add an admitted `step(nodeId, iteration, input)` capability to the existing worker. Store every step and attempt separately, with a stable effect ID, canonical request hash, dependencies, resource identity, timestamps and immutable terminal receipt. Do not reuse the legacy call-cache upsert/reset semantics for owned effects. Successful JSON null is a result; absent, failed, interrupted and ambiguous outcomes are distinct.

The existing reconciliation pass observes ARC's short execute/observe/interrupt methods. ARC does not poll independently. A completed receipt can advance required work only after definition, dependency and relevant source/context/policy identities still match. Integration lanes use durable fencing and remain occupied until the effect is terminal or reconciled.

A failed check becomes historical evidence only after its fixed repair successor consumes that exact effect and receipt hash, is bound to the checked candidate, and has a native accepted turn matching core's retained client request ID. Subsequent authorized repair changes must not strand replay at the consumed failure. Unconsumed failed checks, successful checks, reviews and final verification still require the relevant current candidate. The original source must remain unchanged throughout. Historical workflow success and the retained candidate's current verification status are shown separately.

Observation may finish preparation for an already admitted worker: when core reports Prepared, ARC checks its sealed worktree and releases its one input. Workflows binds such advancing observation to the current run's cancellation signal as well as plugin lifetime. Pause cancels that authority; paused quiescence observations use a fresh non-advancing signal. Authoritatively absent native effects are redispatched only through execute with the same attempt identity. Transport uncertainty never proves absence.

Enforce the persisted defaults: four active agents, 100 admitted worker calls, three repair rounds per stage and two hours of active work. Charge admitted dispatch and corrective turns; completed receipt replay does not consume another call. Waiting parents and host checks do not occupy agent slots. Persist bounded active-time intervals, excluding confirmed paused and CI-wait time without granting a fresh budget after restart.

Persist pause before requesting interruption and stop new admissions immediately. Observe native worker outcomes before reporting Paused. Unknown termination remains Needs reconciliation. Resume keeps the original counters, definitions and receipts.

## Native effects and acceptance

Use ARC's existing host-worker transport with a host-local SQLite journal. Native snapshot, commit, integration and check effects bind a stable effect ID to canonical arguments, repository/worktree identity and expected source revision. Record intent before the effect and a native receipt afterward. Retain exit code, bounded output and its digest, before/after source state, timestamps and relevant artifact digests. Agent prose is not check evidence.

Matching retries return a retained receipt or current/uncertain state. Conflicting hashes reject. Incomplete journal entries are never blindly rerun, and target movement invalidates dependent checks. Use the packaged runtime's verified built-in SQLite; no extra database service or Python dependency is needed.

Host protocol 185 adds explicit `fork-worktree` and `merge-candidate` operations. The existing `prepare-worktree` and `integrate` operations retain their V1 meaning. A daemon with an older wire version must update before receiving the new operations; shared TypeScript compilation is not a compatibility substitute.

| Operation | Source and resulting behavior |
| --- | --- |
| `prepare-worktree` | `request.workspace` identifies the original checkout and its exact HEAD. Create a new detached run-owned linked worktree at that commit. This does not copy uncommitted original-checkout changes. |
| `fork-worktree` | `request.workspace` identifies a clean detached candidate already owned by the same run and host journal. `workspaceId` selects a new deterministic destination. Fork the exact candidate HEAD without changing or reusing the source. |
| `integrate` | V1 integration applies the single commit at `operation.source.expectedHead` with `cherry-pick --no-commit`, then commits it into the owned target. It does not represent the source candidate's complete history. |
| `merge-candidate` | V2 integration merges the complete history of `operation.source` into the exact target in `request.workspace`. The committed result retains target and source ancestry, so earlier writer and repair commits are not lost. |

Forks require non-null expected HEAD and state digest, canonical repository/worktree paths, a detached clean source, and a ready workspace ownership row in the same run and journal. Original, foreign-run, foreign-repository and redirected sources reject. An existing or reserved destination is never reused. Reserve ownership before worktree creation, recheck source identity/state around creation, and atomically mark the new workspace ready with its successful receipt. An interrupted receipt write leaves the physical destination reserved and uncertain; a retry cannot recreate it or release a worker there.

The `merge-candidate` request requires a non-null integration lane and non-null expected state digests for both source and target. Both workspaces must be separate, canonical, clean, detached linked worktrees owned by the same run/journal/repository. Compute the merged tree from both exact commits with Git's modern `merge-tree --write-tree` mode. Conflicts fail before changing either index or working tree. Recheck both candidates, then apply the result with two-tree `read-tree -m -u`; do not force-reset through dirty or untracked changes. Commit the exact merged tree with both parent commits and advance only the target's detached HEAD using an expected-HEAD compare-and-swap. The new operation uses `update-ref --no-deref` so a concurrent symbolic HEAD cannot redirect that update into a branch. Retain actual created commit/tree IDs even if later verification invalidates the result.

Fork and merge receipts preserve immutable `before`, `source`, `after` and artifact identities. `observeEffect` separately computes whether those recorded states remain current; it never rewrites historical receipt contents. An authorized successor may make its predecessor's raw host receipt stale. ARC decides which historical creation/integration evidence remains usable; checks, reviews and final verification still bind the exact candidate they verified. Integration lanes remain fenced until the recorded effect is terminal or reconciled. These native primitives do not authorize changes to the original checkout, branch publication, merging a pull request or deployment.

Verification includes real migrated databases and disposable Git worktrees; concurrent/repeated prepare and start; zero provider work before release; owner and generation rejection; Send-now and queued-input mutation attempts; crash gaps; failed required joins; successful null; exhausted limits; pause during work; target movement; and unchanged original checkout. Native provider and host execution are required acceptance evidence after unit and integration checks pass.

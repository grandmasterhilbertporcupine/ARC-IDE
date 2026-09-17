# ARC graph runs and orchestration settings

Status: published-Team graph execution and orchestration settings have native/browser acceptance recorded in [ARC-PROGRESS.md](ARC-PROGRESS.md), checkpoint 20. Checkpoint 26 records independently audited native main-composer admission, four workers and one counted response in the original conversation. Checkpoint 32 records the passed serial ordinary-folder native gate with three workers and one counted response. The observed provisioning-status and timeline-position issues also have regression and native/browser evidence. Other Phase 4 gates below remain open; this is not whole-Phase-4 or packaged-release acceptance.

## Sealed graph runs

`startTeamRun` accepts `{operationId,projectId,originThreadId,hostId,path,expectedHead,goal,team:{teamId,revision},expectedProjectPolicyVersion,expectedSessionPolicyVersion}` through `sdk.plugins.callRpc({pluginId:"arc",method:"startTeamRun",input})` and `bb arc runs rpc startTeamRun`. Use `--input-file <absolute-host-path> --host <id>` for large inputs and `--output-file` for evidence. The same run inspection, effect pagination and pause/resume/cancel methods serve fixed and graph runs.

ARC validates the actual project, main conversation and registered source, then seals the published project team, every member's exact agent revision and resolved execution settings, source state, effective policy and compiled workflow in one reservation. Both policy versions must match the user's observed settings. Stable operation IDs recover the original request after response loss; they cannot adopt changed revisions or inputs. A later policy/team revision does not silently alter a saved run. Changing active operational rules through a reviewed pause/invalidation flow remains an open gate.

If a saved start request needs different settings, the UI's Review current setup action calls `discardTeamRunRequest` with that exact original request. It atomically returns `{state:"reserved",run}` if the run already exists, or permanently retires the unused project/operation/hash and returns `{state:"discarded",operationId,requestHash}`. Concurrent preflight cannot reserve a retired request. Acknowledgement loss requires retrying this same recovery operation, not switching back to start. Only after confirmed retirement may the UI issue a new operation ID. An existing run is opened for inspection and is never implicitly cancelled by this action.

The unversioned fixed Workflows manifest and ARC definition version 1 retain their old serialization and replay hashes. Graph definitions and manifests explicitly use version 2. Workflows remains the only scheduler. The compiled manifest admits at most 4,096 steps, and each actual agent request consumes the existing concurrency and call budgets before dispatch.

## Candidates and controls

Main-composer admission uses additive ARC definition V3. `getOrchestratorContext` discovers policy, exact team versions and the source on the main conversation's host. User `requestTeamRun` accepts the V2 start fields; native `arc_team_run_request` derives scope and idempotency from authoritative core invocation. The sealed V3 request has required `invocation:null` only for direct trusted-user admission, or an exact native providerThreadId/turnId/callId tuple. Its completion binds the actual main thread/environment and model independently from member defaults. V1/V2 serialization is unchanged; V3 uses the existing Workflows V2 ledger and adds one agent step after settled graph evidence. Pause, cancellation, exhausted budgets and unknown effects cannot trigger a new completion dispatch. An already owned automatic turn cannot use native ARC admission to reset its limits.

For an uncertain native request, user `reconcileOrchestratedRun({runId})` retries the database's immutable definition. User `discardOrchestratedRunRequest` accepts the exact V3 user start input and retires an unused request before replacement. Contextual agent CLI cannot perform either mutation. Direct user SDK/HTTP retains BB's existing local trust boundary; these checks do not sandbox provider terminal access. The Runs UI retains policy/approval presentation and same-request reconciliation for V3. The native gate verified one initial manual request separately from five charged automatic calls, with no extra main tools or automatic turns.

Completion validation shares repeated receipt and exact host/path inspection results within one fresh callback pass, with at most four inspections in flight. It does not cache validity across polls or relax the existing ten-second Workflows callback deadline. The original source is checked again after asynchronous main-turn preparation and before release. Aborted inspections propagate cancellation instead of replacing retained evidence with a stale conclusion; independently completed checks can retain their observed result. These are bounded filesystem observations, not an atomic filesystem snapshot.

Every graph writer and repair attempt receives a distinct detached, owned worktree forked from the exact admitted candidate. Earlier failed-check evidence remains attached to its unchanged candidate. Serial V2 integration merges each entire owned candidate history; V1 integration retains its original cherry-pick behavior. Required successful native checks, explicit reviewer verdicts and final verification must identify the same candidate commit and file state. An alternative final candidate must include all writers and repairs active on that alternative.

Owner controls record barriers, typed condition outcomes, approvals, bounded repair results, declared delegation choices and selected candidates. Workflows validates the selected output and exact retained dependency proofs before admitting a branch. Duplicate requirements share a proof but retain every outcome constraint. Interrupted or unknown operations never satisfy a settled success/failure requirement.

`listRunControls` takes `{runId,limit?,offset?}`; `getRunControl` takes `{runId,controlId}`. User decisions call `resolveRunControl` with `{runId,controlId,operationId,expectedRevision,contextHash,decision:"approved"|"rejected"}`. The context binds the run/plan, admitted effect/request, exact policy/team hashes, candidate and dependency receipts. A stale revision, changed evidence or closed run rejects. Retry the identical decision operation after an uncertain response. Agent callers can inspect their project's decisions but cannot approve them.

Pending user decisions consume no agent slot. Pause retains them without creating another decision attempt. Cancellation records an interruption even if the original source is unavailable or changed. An approved writer's subsequently changed workspace does not erase that historical approval: recovery requires the exact bound writer, its native accepted request and original approved workspace identity. Unconsumed decisions and final checks/reviews still require current evidence.

Paused time is excluded from the existing active-work clock. Pure user/CI waits exclude time only when no native work remains active. Owner reconciliation and dependency waits remain charged; limits are never reset by a control transition.

## Project defaults and session overrides

Orchestration settings use `bb arc policy show|history --project <id> [--thread <id>]`, `bb arc policy rpc <method>` and the matching ARC plugin RPC contract.

| Method | Input |
| --- | --- |
| `listPolicySessions` | `{projectId,limit,offset}` |
| `getOrchestrationPolicy` | `{projectId,threadId:null|string}` |
| `saveProjectPolicy` | `{projectId,expectedVersion,policy}` |
| `saveSessionPolicy` | `{projectId,threadId,expectedVersion,overrides}` |
| `listPolicyRevisions` | `{projectId,threadId:null|string,limit,offset}` |

The project policy is `{schemaVersion:1,autonomy,preferredTeams,restrictedTeams,limits}`. Team pins are `{teamId,revision}` in the same project. Preferred teams are ordered; `[]` means no preference. A null restriction permits any otherwise eligible project team; an empty restriction permits none. Preferred pins must belong to the restriction when one exists. Defaults are Collaborative, no preference, unrestricted teams, four active agents, 100 calls, three repair rounds per stage and two active hours.

Session overrides have nullable `autonomy` and `limits` for inheritance. `preferredTeams` is `{kind:"inherit"}`, `{kind:"none"}` or `{kind:"teams",teams:[pins]}`. `restrictedTeams` is `{kind:"inherit"}`, `{kind:"unrestricted"}` or `{kind:"teams",teams:[pins]}`. Project settings are defaults: an authorized user may deliberately override them for a session. The autonomy mode itself never relaxes restrictions or grants. Conflicting inherited preferences and restrictions produce an actionable unresolved policy instead of being silently discarded. Version zero represents defaults without a saved revision; writes append immutable versions using compare-and-swap.

Guided requires approval before each agent assignment, including read-only work, and before proposed dynamic assignments. Collaborative requires an initial plan approval and allows declared work within its sealed bounds. Autonomous admits declared work within those bounds. Explicit graph approvals remain required in every mode. Provider permissions, required checks, release configuration and budgets remain independent.

Declared delegation has a bounded candidate roster and child-call count. The separately admitted requester uses `arc_run_delegate({assignments:[{memberId}]})`; the server derives its identity from the actual bound task, checks directed grants and stores the ordered proposal under that effect. Each selected child receives its own admission. Workers cannot invent graph nodes, enlarge budgets, change policy or approve decisions. V3 separately admits its final main-orchestrator response; passive child notices do not trigger provider calls.

Release stages require the later configured factory capability. Serial non-Git execution passed the bounded native Codex gate in checkpoint 32 of ARC-PROGRESS. Explicit instruction-body application uses reviewed immutable continuations with cumulative limits; its implementation and current acceptance are documented in [ARC-INSTRUCTION-UPDATES.md](ARC-INSTRUCTION-UPDATES.md). Broader operational-rule changes, remaining native autonomy/delegation paths and the combined 200-node/four-live-chat performance gate remain open. Further automatic episodes require the later finite Factory grant. See [ARC-PLAN.md](ARC-PLAN.md) for the full accepted scope.

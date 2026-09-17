# ARC teams and live Workspace design

Status: Phase 4 is in progress. Live Workspace, versioned Team Builder, Git/folder graph execution, counted main-orchestrator admission, project/session policy and reviewed rule continuation have recorded source/browser/native acceptance slices. Combined graph/chat usability and remaining native autonomy/delegation variants are still open. [ARC-PLAN.md](ARC-PLAN.md) remains the approved scope; [ARC-GRAPH-RUNTIME.md](ARC-GRAPH-RUNTIME.md) describes the contracts and [ARC-PROGRESS.md](ARC-PROGRESS.md) records evidence. The sequence below retains the remaining acceptance requirements.

Workspace derives real conversations from fixed or graph run snapshots. Team Builder stores and edits canonical definitions through UI, SDK and CLI. Published project graphs use the versioned compiler and controls in the same Workflows scheduler; fixed runs retain their original contracts. Scoped tests do not replace native graph acceptance or complete Phase 4.

## Complete Phase 4 scope

- One main composer and orchestrator at the upper left, inspectable worker chats and tool events, actual work states and task handoff animation. Focus, collapse and detail views keep the workspace usable on a laptop.
- An agent library beside an editable graph, with named/colorable nested groups. Agent names, model identities and eventual team membership come from the exact definitions used by a run.
- Executable parallel paths, joins, checks, reviews, conditions, bounded repair loops, approvals, integration and release stages. A release stage is visibly unavailable until the Phase 6 factory capability and required configuration exist; it cannot silently count as successful or be skipped.
- Organizational membership, directed collaboration grants and execution dependencies are separate. Configured agents can delegate tasks or review work through admitted operations.
- Canonical validated team graphs, immutable published revisions, project copies of library definitions, history and reviewable assistant proposals. Graph errors explain the action the user can take in ordinary language.
- Project defaults and explicit session overrides for autonomy, team preference, optional team restriction and execution limits. Collaborative with no preferred team remains the default.
- Matching typed SDK and `bb` CLI operations, real graph and handoff acceptance, responsive behavior, keyboard/screen-reader verification and reduced motion.

Shared retrieval, ingestion and knowledge promotion remain Phase 5. Goal/backlog intake and configured remote merge, deployment, health checks and rollback remain Phase 6. Appearance customization remains Phase 7. These phases remain required; the team builder does not imply those capabilities already exist.

## Step 1: live Workspace from retained runtime facts

Reuse the existing origin task, worker tasks and their BB transcripts. The origin uses the existing compact `ThreadChat` with the sole composer. Worker panels use the timeline view; runtime workers retain the core single-turn admission guard. Opening a panel must not create a task, send a turn or modify a sealed run.

The backend projects run definitions, admitted nodes, effect attempts, retained resource bindings and observations. The UI shows the following distinctions:

| Displayed fact                           | Required source                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Agent name, revision, provider and model | The run's immutable agent and execution snapshot                                     |
| Requested work                           | The admitted definition and exact task input                                         |
| Prepared worker                          | The retained preparation and bound environment identity                              |
| Native work started                      | The exact retained client request and its native input-accepted event                |
| Native work finished                     | Completion belonging to that accepted event's turn scope                             |
| Check result                             | The host receipt with candidate identity, command and exit status                    |
| Current verification                     | The retained candidate's current validity, distinct from historical workflow success |
| Team/group color and membership          | The immutable published team snapshot consumed by a V2 graph run                       |

The first Workspace has no team snapshot. It may identify writer, reviewer and repair roles from the admitted nodes, but must not invent teams or infer membership from a role, provider or position. Missing native acknowledgment remains pending or needs reconciliation. A deleted or inaccessible task is an unavailable transcript, not a completed task.

Keep transcripts in BB's existing event storage. A Workspace response carries only the projection and task references needed to render it. Bind every effect and task reference to its run and project. Do not replace a pinned name/model with current Agent Studio metadata after a definition is edited.

The saved graph inspector uses the retained `run.definition.team` and `members` for V2/V3/V4 runs. It reuses Team Builder's canvas with editing disabled: navigation, selection and details remain available, while movement, connection/reconnection and deletion cannot modify the plan. Search gives a keyboard route to any declared stage. `graphNodeId` on a projected worker comes from `compiled.references.origins[runtimeNodeKey(effect.request)]`; fixed V1 runs and missing origins return null. Repair iterations and delegated child slots can share a declared stage, so selection retains the exact worker attempt and thread identity.

Opening or hiding the graph preserves the sole composer draft and the existing visible worker chats. Desktop places the bounded graph above up to four worker panes; laptop retains a selected chat and offers Worker overview for up to four chats with vertical scrolling; the conversation bar selects other workers. Compact focus views retain navigation back to the main conversation. The immutable graph is the declared plan, not a complete execution-status overlay: the latest 100 worker attempts cannot establish outcomes for all stages, host checks or skipped branches. Stage details disclose missing history and link to Run details. Graph layout/member labels are held by run identity and plan hash so a repeated parsed RPC response does not rebuild the saved plan.

Handoffs use stable identities from actual dispatch facts, such as run/effect/attempt plus the retained request ID. Initial load establishes a baseline; only newly observed handoffs animate. Polling, retries and panel remounts do not replay old movement. A requested or prepared handoff may have its own accurately labeled state, but cannot animate as native activity before acknowledgment. Reduced motion presents the same state change without movement.

The existing `ThreadChat`, provider metadata, `useRpc` and realtime hooks are the first reuse candidates. This step needs no additional scheduler or daemon wire field. Add a narrowly scoped public projection RPC and CLI operation alongside the UI. Preserve pagination and report any truncated coverage rather than implying that an incomplete page is the whole run.

Gate: open an actual run, inspect its origin and worker conversations, observe one real handoff, distinguish failed/interrupted/reconciled work, retain correct identities after definition edits and reload without fabricated animation. Verify empty/loading/error and missing-task states, keyboard operation, reduced motion and laptop layout in the actual application.

## Step 2: versioned team definitions and authoring

The implemented pure contracts live in [teams/contract.ts](../plugins/arc/teams/contract.ts): `TeamDefinition`, `TeamNode`, `TeamEdge`, `TeamMember`, `TeamGroup`, `TeamGrant`, revision/proposal/session types, `arcTeamsRpcContract` and the separate `arcTeamAssistantRpcContract`. The canonical shape separates meaning from placement:

```ts
type TeamDefinition = {
  schemaVersion: 1;
  name: string;
  description: string;
  groups: TeamGroup[];
  members: TeamMember[];
  permissions: TeamGrant[];
  graph: {
    nodes: TeamNode[];
    edges: TeamEdge[];
    entryNodeIds: string[];
    requiredGates: { id: string; mode: "all" | "any"; nodeIds: string[] }[];
  };
  presentation: {
    nodes: { nodeId: string; x: number; y: number }[];
    groups: {
      groupId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }[];
  };
};
```

A member has a stable member ID, `agentId`, exact published `revision`, and nullable `groupId`. Its agent revision must belong to the team's library or project scope. A group has an ID, name, six-digit hex color and nullable `parentGroupId`. Directed grants identify `fromMemberId`, `toMemberId` and action `delegate` or `review`. Graph nodes reference members without treating visual nesting as an execution edge. Role descriptions and group colors do not claim provider permissions or host sandboxing.

Saved drafts can contain blank task text, unassigned references and unfinished connections. They return actionable diagnostics; publishing requires valid references, named stages, a DAG, explicit entries and nonempty required gates. Draft writes, publication, restore, archive and proposal application use `expectedDraftVersion`. Immutable revisions are insert-only; restoring publishes a new revision without rewriting history.

Copying a published personal-library team into a project copies each distinct referenced agent/revision and its owned attachments once, remaps member references and publishes the project team in one SQLite transaction. The copy retains source provenance. Later library changes do not update that project or an active run. The full content hash includes presentation; the operational hash excludes names, display descriptions, node labels, organizational groups and placement. Pinned agent revisions, tasks, graph dependencies and directed grants remain operational. Presentation is stored in the immutable revision without changing its operational meaning.

The builder uses `@xyflow/react` for the editable canvas, alongside the agent palette, stage/group/member inspectors, connection controls, history, suggestions and assistant pane. Canonical positions remain world coordinates while the canvas handles nested groups. The implementation provides drag/drop and keyboard paths; realistic graph performance, screen-reader behavior and browser walkthroughs require recorded verification.

All planned stage kinds are representable now: `agent`, `parallel`, `join`, `check`, `review`, `condition`, `repair`, `approval`, `integration`, `release` and `delegation`. Candidate references identify the original source or an earlier writing/integration/repair node. Integration retains ordered writer references. Conditions inspect typed prior outcomes, check exit codes, review verdicts or approval decisions; arbitrary JavaScript/prose predicates are rejected. A selected join identifies its controlling condition, and nested alternatives need explicit reconvergence.

Edges retain `source`, `target`, `sourceHandle` and `requiredOutcome`. Ordinary edges use `next`; conditions use `true`/`false`, both requiring a successful recorded decision. `completed` means settled `succeeded` or `failed`, excluding interrupted/unknown; it is distinct from a native provider completion event. Required gates require successful evidence and support `all`/`any`; validation rejects mandatory success on incompatible alternatives.

A repair stage contains a fixed `checkNodeId`, `{memberId,task}` body and at most three rounds. Its named exits are `repaired` (successful native recheck) and `exhausted` (failed bounded rounds); future lowering must rebind the check command to each repaired candidate. A delegation point pins a requester, candidate members, task/access and `maxChildCalls`; each candidate needs a directed delegation grant. Future requester/continuation turns still require separate run-budget admissions. Neither node currently executes. Authoring is bounded to 200 nodes, 1,000 edges, 100 members and a 1 MiB canonical definition.

Structural validity and execution availability are separate server results. Supported structurally valid graphs report runtime availability; release retains its factory-capability blocker. Starting a published project revision also checks source, policy and final-candidate compilation. Publication never dispatches work or bypasses these checks. Existing schema-version-1 Runs remain independent and do not consume a team revision.

`bb arc teams list|show|history|rpc` and `sdk.plugins.callRpc({pluginId:"arc",method,input})` share the contracts. Team operations cover create/read/list, save/validate draft, publish/history/restore, copy/archive and propose/list/read/apply/reject suggestions. File input/output options match Agent Studio. See the [agents skill](../plugins/arc/skills/agents/SKILL.md) for exact method inputs.

`startTeamAssistant` saves the immutable team draft snapshot before spawning its BB conversation and binds it to the actual project/task before configuration permits its first turn. `listTeamSessions` preserves the draft version and nullable task identity after an uncertain spawn. The assistant uses `arc_team_snapshot`, reads the latest draft with `arc_team_read`, discovers published agents and submits `arc_team_propose`. Definitions are editing material, not operating instructions. Library proposals require that exact team's bound assistant; project agents can propose within their project. Direct edits/publication/application remain user controlled. A proposal retains before/after definitions, evidence, changed fields and operational-change status; stale application fails. Applying changes the draft, with publishing separate.

The authoring acceptance passed on September 10, 2026: `.arc-verification/team-authoring-native/2026-09-10T09-43-56-309Z-26caef8e/result.json`, with a separate `independent-audit.md` and exact event identities in `independent-audit.json`. The actual UI created a library team, applied the complete canonical definition through the advanced JSON editor, saved and published it, started its bound assistant, reviewed/applied the real suggestion, published revision 2 and reloaded history. SDK/CLI reads matched; the project copy retained exact agent content with remapped identities; the original fixture remained unchanged. Real SQLite regressions cover stale drafts and atomic copy separately.

The native assistant produced one accepted/completed Codex turn using recorded dispatch model `gpt-5.6-sol`; the provider completion does not independently echo the model. Its only three action tools were `arc_team_snapshot`, `arc_team_read` and `arc_team_propose`. It quoted context absent from its user prompt and submitted a pending description-only proposal before user application. The first revision and operational hash remained unchanged. The successful run has no page/console errors; the earlier pre-acceptance skill-tree404 attempt is preserved separately.

This native gate uses advanced JSON authoring. Canvas interactions, grouping, nested measured cards and responsive/reduced-motion checks have separate browser evidence in ARC-PROGRESS checkpoints 15–17; the 16 final canvas regressions and scoped ARC typecheck passed. That historical run proves neither general graph execution nor every accessibility/performance target. The subsequent graph/control/policy integration and remaining Phase 4 walkthrough have their own evidence gates.

## Step 3: graph validation and lowering

Extend ARC's compiler instead of adding an executor. The existing Phase 3 compiler emits a fixed writer/commit/integration/check/repair/review/verification sequence. The general compiler must produce the same protected Workflows manifest concepts from the validated graph.

Use structured bounded loops and deterministic `(nodeId, iteration)` entries. Conditions inspect typed prior outcomes, check exit codes, review verdicts or approval receipts; worker prose and arbitrary predicate JavaScript do not authorize a branch. Parallel branches and joins retain explicit outcome requirements. Final success requires checks and reviews of the final integrated candidate.

Validation must reject missing references, unreachable required gates, uncontrolled cycles, invalid joins, unsupported capabilities, unsafe writer placement and graphs exceeding the existing compiled-step bound. Error messages identify the offending nodes and a concrete correction. Organizational nesting may flatten without altering collaboration grants.

Preserve decoding and replay of existing schema-version-1 runs and receipts. Introduce a discriminated graph run version rather than reinterpret earlier definitions. Replace fixed `repair` and `verify` node assumptions in ARC data/receipt handling with compiler-produced references to the exact repair consumer and final required gates. Historical failed-check exemptions remain linked to the exact admitted repair and native accepted request.

Git host effects support isolated worktrees; parallel writing continues to require Git. Ordinary folders use the serial V4 runtime with complete manifests, retained copies and directory check/review receipts. Its bounded Windows/Codex native gate passed; [ARC-DIRECTORY-RUNTIME.md](ARC-DIRECTORY-RUNTIME.md) documents exact graph/filesystem limits and remaining acceptance. Unsupported parallel directory graphs and linked files report explicit diagnostics.

Gate: run real parallel frontend/backend work through a published team revision, serially integrate it, expose a planted failed check, repair within bounds and verify the final candidate. Cover required joins, alternative branches, exhausted limits, revision changes and unchanged original checkout through real SQLite and native host tests.

## Step 4: durable controls in the existing Workflows ledger

The V2 owned-step contract adds owner-control beside agent and host-effect. Approval, branch selection and delegation decisions have durable owner receipts. The existing reconciliation pass remains responsible for progress; ARC has no separate scheduler. The following requirements remain the acceptance contract for the integrated implementation.

Extend admitted dependencies to express selected alternatives and their required outcomes. A fixed list of dependencies that all must succeed cannot faithfully join mutually exclusive branches. The ledger must enforce the selected decision and dependency groups, not rely solely on generated workflow code to obey them.

Each control operation binds its stable operation ID, expected decision revision, definition and canonical request hash. The receipt records what was approved or selected. Changed task input, candidate, team revision or policy requires a new applicable decision; a stale approval cannot authorize different work.

Waiting controls consume no agent slot. The control contract must state its waiting reason and clock treatment. Preserve the approved exclusion of paused and CI-wait time, and do not let newly introduced waiting states silently reset or extend active-time budgets. The existing running-clock behavior needs deliberate integration with those states.

Dynamic delegation requires a sealed request at an admitted delegation point. The current manifest is immutable and ARC effect reservation rejects arbitrary replacement inputs. The first general implementation should use bounded declared delegation points and permitted candidate choices, or require a newly approved definition when the graph itself changes. Record each request before admission and charge every provider continuation. Waiting parents release slots so nested collaboration cannot deadlock the four-agent default.

Gate: durable approvals and branch decisions survive response loss/restart; stale decisions reject; no rejected path dispatches; no unresolved required control can be bypassed by an early script return; nested delegation respects grants, slot limits, call limits and pause.

## Step 5: project/session policy and orchestrator integration

The implemented effective policy includes autonomy, exact preferred team revisions, optional restricted team revisions and existing execution limits. Directed grants remain sealed in the team. The resolved policy and its hash are pinned with the run. Project defaults and session overrides distinguish inheritance from an explicit empty preference; no preference is a real choice.

The following semantics are implemented and awaiting complete native policy acceptance:

- Guided: approve each agent assignment and proposed dynamic delegation.
- Collaborative: approve a plan, allow work inside its configured bounds, and request approval for changes outside it.
- Autonomous: admit work within the configured grants, required gates and limits.

Autonomy never overrides a team restriction, host permission, required check, budget or release configuration. The default remains Collaborative, no preferred team, four active agents, three repair rounds per stage, 100 provider calls and two hours of active work. Role and team colors carry no authority.

The main orchestrator uses ARC-owned tools to propose or admit work under the resolved policy. Server policy validates actual task/project ownership and immutable input, rather than trusting context supplied by a worker. Server-initiated follow-up turns are admitted and counted too. A user correction may create a new admitted worker on a retained verified workspace, preserving the core single-turn guard.

Changing a team or policy publishes a new revision. Applying changed operational rules to ongoing work pauses affected execution and invalidates affected downstream evidence; it does not mutate the active snapshot invisibly. The Workspace subsequently derives group colors, names and membership from that run's immutable team revision.

Gate: project/session settings resolve consistently through UI and SDK/CLI; explicit no-preference differs from inherit; configured delegation and review grants are enforced; editing definitions cannot alter active identities or bypass required checks; each autonomy mode has a real observed approval/admission path.

### Observed parent-turn admission gap

Read-only inspection on September 10 confirmed that the current counter measures owned **worker calls**, not every provider turn caused by a run. In the completed native run `run_0291b227-ac73-4a9d-bbe4-b721065533ff`, the retained Workflows result records six worker admissions. Its origin task `thr_gkpimfe92k` separately has one initial readiness turn and five automatic parent turns with actual input-accepted and completed events:

| Parent request    | Recorded cause                    | Accepted event   | Completed event  |
| ----------------- | --------------------------------- | ---------------- | ---------------- |
| `creq_s28tvrxzvk` | Child outcome batch, two children | `evt_s9j67jq7f4` | `evt_ian8pmch2j` |
| `creq_xten2ivwhc` | Backend writer completed          | `evt_6qnaysckme` | `evt_b4y8xxhrjw` |
| `creq_vxbbqs392e` | Frontend writer completed         | `evt_8xhryusm8m` | `evt_zj22ahc7ic` |
| `creq_cnm3vveavd` | Repair completed                  | `evt_j9x62zdey9` | `evt_uwcbmef9r3` |
| `creq_ussc43a2jc` | Review completed                  | `evt_iu4eu5vm74` | `evt_d94wbup589` |

These five requests have `initiator: system` and `source: tell`. They were verified through the active server's read-only events API, matching each request to its accepted turn scope and completion. The earlier `thread-1.jsonl` acceptance artifact captured only the initial readiness turn; it is not evidence that later parent turns were absent. The native run result remains at `.arc-verification/team-runtime/2026-09-10T07-29-14-289Z-43a94d2a/result.json`. Do not present its six worker calls as the complete project/provider call total.

The cause is the inherited core child notification path:

1. ARC passes `parentThreadId` to prepared worker creation. Core retains `originPluginId: arc` while `originKind` is null.
2. `isParentNotifiableChildThread` in `apps/server/src/services/threads/thread-parent.ts` accepts any child with a parent and null origin kind. It does not exclude a plugin-owned prepared worker.
3. `apps/server/src/internal/events.ts` routes child root-turn completions into `child-thread-notifications.ts`, which batches updates and calls `queueParentSystemMessage`.
4. `parent-system-messages.ts` starts an idle parent's new system turn, or submits an automatic input to an active parent, through the ordinary host command path. It does not obtain an owned Workflows admission. An active-parent input is not necessarily a new native turn, so future accounting must preserve the actual request/accepted-turn distinction.
5. `plugins/workflows/src/owned-data.ts` charges `agent_calls` only while inserting an admitted manifest step whose kind is agent. An inherited parent notification does not pass through that transaction. The worker's single-turn preparation guard applies to the child, not its ordinary origin conversation.

The Workspace labels this metric **worker calls**. The five observed acknowledgments are genuine provider activity, but neither the counter nor worker pause controls covered their dispatch. The inherited parent delivery path did not consult the owned run's control state; the historical run therefore does not prove a whole-run budget.

The implemented bounded correction adds optional preparation `parentNotification: "owner-controlled"`, sealed with a non-null parent. New ARC workers select it. Core retains deduplicated passive `system/operation` history with operation `owned_child_notice`, suppresses automatic start/steer for these child notifications, and rejects explicit worker-to-parent sends through both the shared sender boundary and claimed queue delivery. Parent/child organization remains intact. Mixed batches retain the ordinary outcome lines and interruption/workflow guidance. The passive event uses terminal delivery status `completed` and displays as Child update; its metadata retains the actual child outcome. Omitted options keep the original request hash and inherited semantics, so existing preparations are not silently rewritten. Core regression/type/API checks and fresh native acceptance pass: two worker calls, two passive completion notices and zero additional parent turns. ARC-PROGRESS checkpoint 14 records the native result; detailed scoped evidence is in `.arc-verification/phase4-parent-notification-handoff.md`.

V3 now separately admits and charges the final orchestrator response before dispatch through the existing Workflows ledger, with the exact parent request ID, run attribution and pause/generation checks. Checkpoint 26 records independently audited native acceptance: four workers plus one prepared main response, distinct from the initial manual request. Ordinary BB child-notification behavior remains unchanged for unrelated tasks. The correction preserves the parent relationship and uses actual admission rather than a post-dispatch counter increment.

Regression coverage includes direct, active-parent and queued-notification delivery, duplicate notices, response loss, exhausted calls, paused runs and plugin disposal/restart. Core prepared-turn guards reject Send-now, retry and history changes that could escape the owned request or remove its native evidence. Passive updates remain visible without consuming provider turns. Native V3 acceptance verifies the intended counted-response path, while the remaining graph/provider variants and later Factory episode bounds retain their own gates.

## Ownership and integration order

The current independent step is partitioned as follows:

| Partition              | Owned surface                                            | Dependency                                              |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Live Workspace backend | Narrow ARC runtime projection contract/service and tests | Existing persisted run/effect/native facts              |
| Live Workspace UI      | `plugins/arc/workspace/`, app wiring and Workspace view  | Stable projection contract and existing task components |
| Matching CLI           | ARC command dispatch/help/docs and projection output     | The same public RPC contract                            |

Subsequent partitions should be assigned only after their contract is agreed:

| Partition                  | Proposed owned surface                                                           | Integration boundary                                                  |
| -------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Team authoring             | New `plugins/arc/teams/` contract, persistence, authoring operations and builder | Immutable validated team revision                                     |
| Graph compiler and adapter | Existing ARC runtime compiler, contract, data, adapter and receipt handling      | Versioned manifest plus exact control/required-gate references        |
| Scheduler controls         | Workflows owned contract, ledger, execution and recovery tests                   | Typed owner-control decisions and enforceable dependency alternatives |
| Policy and orchestrator    | New ARC policy/control modules and tools                                         | Resolved policy, admitted requests and revision checks                |
| Workspace extension        | Team grouping, graph execution overlays and actual collaboration handoffs        | Immutable team snapshot and retained control/dispatch facts           |

Keep one owner for overlapping ARC runtime files. Publish pure schemas first; consumers depend on those schemas rather than another plugin's service implementation. Coordinate generators and Turbo execution because their outputs are shared. No daemon protocol extension is assumed by this design; any later wire change follows the explicit compatibility/version rule in AGENTS.md.

## Remaining acceptance gates

Phase 4 is complete only after the live Workspace, validated team builder, graph execution, configured collaboration and project/session policy all work through UI and SDK/CLI. Retain the full product walkthrough, including assisted team creation and actual chats, checks, repair and handoffs.

Inspect the actual application at 1366x768, 1920x1080 and 2560x1440 with Windows scaling, keyboard/screen-reader and reduced motion. Verify that a 200-node graph and four live chats remain usable. Keep performance targets separate from measurements and record the observed evidence in ARC-PROGRESS.

Phase 5 retrieval quality/scale, Phase 6 factory release behavior, Phase 7 appearance/onboarding and Phase 8 clean-machine Windows/provider/release gates remain pending according to ARC-PLAN. A visible disabled release stage or a successful developer-machine Workspace check does not satisfy those later gates.

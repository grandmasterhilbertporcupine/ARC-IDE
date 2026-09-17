# ARC implementation contract

Status: approved product direction; implementation in progress. This document is the scope and acceptance reference. Evidence and current work live in [ARC-PROGRESS.md](ARC-PROGRESS.md). A milestone is complete only when its acceptance evidence exists.

## Product

ARC helps people without a computer science background build software with coding agent teams. It retains the BB/WNDR IDE foundation and replaces forecasting with visible, configurable agent orchestration. MonoCode informs the clean, compact presentation; it is not the source fork. Windows is the first release platform. The release objective is public source and a public Windows release, not a private prototype.

The default is BB dark mode. Keep the inherited provider integrations, editor, terminal, project management and conversation behavior. Preserve internal BB package, SDK and CLI identifiers where needed for compatibility. ARC must use separate application identity, storage and updates so it can coexist with WNDR.

## User experience

1. **Workspace:** One main composer and orchestrator anchored at the upper left. Show team-colored agent groups, model icon and agent name, real work status, inspectable conversations and tool events. Animate actual task handoffs. Worker panels show their real transcripts; activity is never fabricated. Keep the workspace useful at laptop sizes through focus, collapse and detail views.
2. **Agent Studio:** A reusable agent library, guided form and synchronized Markdown editor, attached context files, version history and a real test conversation. An assistant sidebar belongs to this creation surface. Beginners can describe an agent and review what the assistant changes. Role examples include frontend builder, backend builder, test engineer, reviewer and coordinator; a role is guidance, not an invented permission boundary.
3. **Team builder:** A visual graph with the agent library at the left, named/colorable groups, parallel paths, joins, checks, reviews, conditions, bounded repair loops, approvals, integration and release stages. Organizational groups and collaboration permissions are distinct from execution dependencies. Agents can delegate or review another agent only as configured. Validate graphs before execution and explain errors in ordinary language.
4. **Context:** Each project has a shared, maintained knowledge base and a persistent user context section. Show source, revision, indexing status, errors and approved knowledge. Rules, references and proposals have different authority. Agents share the appropriate project snapshot and learn when relevant instructions change.
5. **Factory:** Users choose Goal-driven or Approved backlog mode. They choose autonomy (Guided, Collaborative, Autonomous), preferred teams or no preference, and optional team restriction. Collaborative and no preferred team are defaults. Configure build/test/review/repair, integration and GitHub Actions release behavior. Configured automation may merge and deploy; the product must not imply permission to do that without configuration.
6. **Appearance:** BB dark by default; optional still-image backgrounds, dim/tint/blur, glass, ASCII/dither/pixel filters, presets and team colors. Respect reduced motion and readable text. Animated wallpaper is deferred; handoff animation is included.

## Delivery order and gates

### Approved Threads integration milestone

The next UI milestone makes a MonoCode-inspired thread browser ARC's default conversation entrance. Core owns a slim project rail, a resizable thread pane and the existing selected conversation. BB dark and existing message, tool, editor and composer components remain the foundation. Appearance backgrounds/glass/filters remain Phase 7 work.

Rows show provider/model identity, readable titles, branch context and real status. Existing global sections, pins, ordering and parent relationships are preserved; project selection filters their visible membership. Workers stay below their main conversation, with exact pinned agent/team labels and real activity counters. Organization does not change execution permissions.

Chat is the default view. A narrow experimental plugin thread-view contribution adds ARC's Team companion beside the stable core main chat/composer, sharing the browser and deep-link context. Multiple runs use an explicit selector, defaulting to the newest active run across history or the latest run. Empty Team state links to current orchestration setup. Worker conversations, graph and run evidence reuse the current Workspace implementation. Selecting or switching views must dispatch no work.

Thread list metadata is projected in batches from retained model requests; content search filters by project before result limits/counts. Activity presets and content search remain distinct views because live activity requires runtime projection. ARC contributes bounded per-project annotations from exact run/effect bindings through SDK/CLI-visible reads, with no per-row transcript/default/model/diff queries.

Default rail/browser widths are 224/336px. Navigation collapses first as space contracts; the browser uses the existing persistent responsive drawer when content needs the space. Verify current actions, groups, hierarchy, search, drafts/scroll/stream retention, split navigation, multiple/continued runs, cache/reconnect/missing states, 1,000-thread windowing, reduced motion and rendered 1366/1920/2560 layouts. Run relevant Turbo checks and a packaged Windows navigation smoke. Every two implementation cycles compare the diff and rendered behavior with this milestone and record actual evidence in ARC-PROGRESS.

| Phase | Deliverable                                                          | Acceptance gate                                                                                                                                                     |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Verified source snapshot, provenance, plan and screen/state contract | Current WNDR files and tracked deletions copied; original source unchanged; existing ARC assets preserved                                                           |
| 1     | ARC identity and forecasting removal                                 | Isolated ARC storage/update identity; no forecasting tools, navigation or Python payload; inherited IDE builds and targeted Windows/package smoke passes            |
| 2     | Agent Studio                                                         | Create/edit/revise/copy an agent, attach context, ask the assistant and run a real test chat; matching SDK/CLI operations; first turn receives the correct revision |
| 3     | Runtime vertical slice                                               | Parallel writers isolated in worktrees, required review/check, serial integration, real failed-check repair, durable pause/recovery and bounded execution           |
| 4     | Team builder and live Workspace                                      | Validated graph compiles to existing Workflows; real messages/handoffs and project/session configuration; laptop/desktop and accessibility verification             |
| 5     | Shared Context                                                       | On-device incremental retrieval and PDF/DOCX/XLSX ingestion with provenance, explicit coverage, promotion and invalidation; retrieval quality and scale gates pass  |
| 6     | Software factory                                                     | Both modes, durable intake, GitHub Actions checks and configured merge/deploy/health/rollback policy; uncertain remote effects reconciled after restart             |
| 7     | Product polish                                                       | Beginner onboarding, appearance, empty/error/loading states, reduced motion and performance checked in the actual application                                       |
| 8     | Public release candidate                                             | Source/release documentation, signed Windows installer/update pipeline, clean-machine acceptance and real verification for every advertised provider                |

Independent foundational work may proceed in parallel, but later features do not make an earlier failed gate complete. Record incomplete and externally blocked checks explicitly.

## Architecture and contracts

- Build one ARC product plugin with focused extensions to core/SDK/host where existing surfaces cannot carry the behavior. Extend the existing Workflows runtime; do not create another scheduler.
- Canonical agent instructions are Markdown with validated structured metadata. Team definitions are canonical validated graphs. Publish immutable definition revisions and bind runs to exact revisions in SQLite. Personal library entries are copied into projects as versioned project definitions; library changes never silently update projects or active runs.
- Bind execution context before a worker can start: agent/team revision, instruction snapshot, provider choice, environment/worktree identity, context revision, graph node/iteration, operational policy and limits. Avoid the existing post-spawn instruction attachment race.
- Compile execution as a DAG with structured bounded loops. Organizational nesting may flatten during compilation. Preserve explicit outcomes and required-success joins; legacy helpers that suppress failures must not let ARC release stages advance.
- Give each active writer an isolated managed worktree and use a run-owned integration worktree. Serialize integration/release per target branch/environment. Preserve the original checkout. Ordinary non-Git projects can run serially; parallel writing requires Git setup.
- Checks execute as trusted host effects with exact source revision, command, exit code, output and timestamps. Tests and reviews must cover the final integrated candidate. Target-branch movement invalidates dependent verification.
- Journal effects with stable IDs, intent and receipt: approval, check, integration, delegation and release. Reconcile ambiguous remote outcomes before retrying. A local journal cannot guarantee remote exactly-once execution.
- Waiting parents release active scheduler slots. Defaults are four concurrent agents, three repair rounds per stage, 100 calls and two hours of active time per work item. Counters survive restart; paused and CI-wait time is excluded. No hard dollar ceiling is claimed where provider usage data cannot support it.
- Pause is durable and stops new dispatch. Preserve inherited provider/close semantics and report the observed state; do not claim suspended provider tokens or OS processes. External CI status is separate and reconciles on reopen. There is no hidden continuation while the computer is off.
- Library/editor changes are revisions, not live mutation of a running snapshot. Applying new rules pauses affected work and invalidates affected downstream results.
- Operational authority, limits and required checks live outside worker-controlled inputs. Retrieved text and knowledge promotion cannot expand tool access, budgets, release authority or promotion rights. Scope/role labels do not invent sandbox enforcement.
- Ship UI features with typed SDK and bb CLI operations. Document experimental public SDK additions and update the plugin API map. Bump the daemon protocol when wire behavior changes unless backward compatibility is intentional and tested.

## Context implementation

Run ingestion and local inference in a host worker. Reuse SQLite FTS5 and the host watcher. Pin the embedding model, tokenizer, chunker and native runtime; bundle their files, checksums and licenses with the desktop build. Disable remote model loading. First use needs no Python, GPU, API key or model download. Relevant excerpts still go to the selected coding provider.

The initial implementation candidate is Transformers.js 4.2.0 / ONNX Runtime Node 1.24.3 with quantized `Xenova/all-MiniLM-L6-v2`, model revision `751bff37182d3f1213fa05d7196b954e230abad9`, 384-dimensional normalized vectors. Chunk at meaningful boundaries inside the tokenizer limit, including metadata. Validate these pinned dependencies against the Windows package before declaring support.

Combine lexical and semantic retrieval with reciprocal rank fusion and bounded excerpt budgets. Use cancellable SQLite batches, bounded top-K and a limited vector cache. 25,000 chunks is a performance reference, not an indexing cap. Larger corpora must have complete visible coverage and bounded resources.

Store imported originals by content hash and keep source identity separate. Indexes are rebuildable caches. Key code context by project/environment/worktree identity rather than branch name alone. Unmerged worker code is not accepted shared main code. Watch edits, renames, deletions, atomic saves and branch switches; mark stale immediately, update incrementally and reconcile after missed events.

Supported inputs are text/source/config/Markdown, text PDFs, DOCX and XLSX. Use PDF.js text extraction with page provenance, Mammoth raw text with paragraph provenance, and bounded non-streaming ExcelJS extraction with sheet/cell provenance. Preserve formulas and cached values separately without recalculating them. Mark hidden content and cached-value limitations. Never execute macros, embedded objects or external links. OCR, legacy binary Office formats, macro-enabled documents and presentations are outside the first release. Enforce parser file/ZIP expansion/entry/time/memory limits and show every skipped or failed input.

Separate approved rules/decisions, references and proposals. Authorized orchestrator promotion requires current source citations, scope validation and conflict checks; record an immutable diff, approver, evidence and rollback history. Protected operational configuration cannot be promoted. Unresolved contradictions require review. Notify and refresh affected execution snapshots after approved changes. Avoid recursive generated mega-summaries.

## Factory implementation

Goal-driven mode creates a backlog within the approved goal, finishes it, then waits for configured maintenance. Approved backlog mode claims explicitly approved items and does not invent features. Use durable intake IDs, acceptance-criteria snapshots and deduplication. Updates to claimed items are scope-change proposals.

Setup captures the goal/backlog source, teams, autonomy, required checks, target branch, merge behavior, workflow/environment, health criteria and optional rollback target. GitHub Actions is the first complete CI/CD integration. Obey branch/environment protections. Editing or weakening required checks, CI/factory settings or authority invalidates authorization; ordinary test improvements remain allowed.

Build and release the exact tested integrated commit and record its artifact digest. Recheck the merge result and target branch. Save external intent/correlation before push/merge/dispatch and a receipt afterward. Ambiguous effects show Needs reconciliation and block release. Deployment failure halts the lane and preserves failed and last-successful evidence. Automatic rollback is only available when explicitly configured with a defined target and health criterion.

## Verification contract

- Use existing Turbo/Vitest orchestration and real migrated SQLite for database tests. Add meaningful tests for graph outcomes, required joins, bounds, delegation slots, revisions, pre-spawn binding, writer isolation/conflicts, pause/crash/replay, stale revisions, duplicate events and provider failures/capability limits.
- Exercise a disposable app/repository through assisted team creation, parallel frontend/backend work, real chats/context, integration, planted test failure and repair, checks, merge, Actions deployment and health checks. Repeat recovery at ambiguous effects and cover both factory modes. Mocks are unit-test tools, not acceptance evidence.
- Review 100 retrieval questions with 30 untouched holdout questions. Release targets: Recall@8 >= 90%, MRR@8 >= .75, provenance on every result and no stale/deleted authoritative hit.
- On Windows 11 with four physical cores, 16 GB RAM and SSD, target warm query p95 <= 500 ms at 25k chunks and <= 1 s with four concurrent queries; lexical updates <= 2 s and semantic <= 10 s. Test 100k coverage, cancellation and bounded resources. These are targets until measured.
- Inspect actual UI at 1366x768, 1920x1080 and 2560x1440, Windows scaling, keyboard/screen-reader and reduced motion. A 200-node graph plus four live chats must remain usable. Run a beginner walkthrough.
- Clean standard-user Windows 11 x64: fresh install, offline Context, Unicode/spaced paths, terminal, sleep/reopen, upgrade, uninstall, WNDR coexistence and process cleanup. Test every advertised provider with real credentials. Developer-machine or UI-only smoke does not certify a clean-machine installer.
- Preserve MIT and upstream notices. Publish truthful build/contribution/security docs and model manifests. Sign the per-user installer and isolate the ARC GitHub Releases update feed with publisher verification and interrupted-upgrade recovery. Owner-supplied release destination/signing identity and unavailable provider credentials are launch prerequisites, not reasons to fabricate results.

## Alignment rule

Every two implementation work cycles, compare the active diff and next step with this plan. Update ARC-PROGRESS with phase, evidence, unresolved gates and any justified deviation. Mention meaningful scope changes to the user. Do not silently drop requirements, convert real functionality to a mock, or call a later phase done because its UI exists.

## Approved visual teams milestone — September 15, 2026

Deliver the connected choose/build team → address in chat → observe collaboration → inspect Preview workflow. This milestone extends the existing Workflows runtime, Team Builder, skill registry and Electron browser. Public publishing is paused by the owner; the previous release authorization does not authorize a source push or release now.

The approved dependency order is immutable assigned skills and definition compatibility; editable Efficient Build templates with project model/check setup; linked Team/Workflow canvas views and explicit directional permissions; bounded source-linked reports, durable messaging and coordinated addressed admission; managed local Preview with Windows inspection and screenshot-to-draft; usage/results and packaged acceptance. Organization does not silently grant execution or messaging rights. Existing fixed workflows remain valid without leaders. Published revisions and active snapshots remain immutable.

All addressed recipients share one admitted graph and budget, preserve internal restrictions, and finish against a checked and independently reviewed combined candidate. Questions may admit bounded response turns; information does not automatically wake workers. Direct worker steering remains blocked. Native reads remain provider guidance; ARC reading tools enforce their own limits. Measured provider usage is shown when available, with no claimed token savings before comparative acceptance.

Preview owns only its recorded terminal/process session. Preserve HMR, isolated HTML assets, renewable leases, bounded diagnostics and immediate user takeover. Remote hosts require existing configured connections. Template updates never overwrite edited project copies. Every user-facing surface includes its SDK/CLI path.

Verification includes source-pinned skills, permissions and hierarchy, keyboard/drag/drop/undo, multiple recipient deduplication, real reader handoff, check failure and repair, independent combined review, bounded dialogue with pause/restart/exhaustion, packaged Windows Preview and provider-backed baseline comparisons. Run heavy verification serially on this PC. Unattended Factory, automatic merge/deploy, expanded remote Preview and public publishing remain outside this milestone.

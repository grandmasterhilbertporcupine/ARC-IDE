# ARC

ARC provides visual coding-agent orchestration with a Windows IDE, providers, conversations, a terminal and the default dark theme.

## Agent Studio

Create agents in a personal library or project using a guided form and canonical Markdown document. Saved drafts and immutable published revisions remain separate. Edits require the expected draft version. Published references retain exact bytes: up to 25 MB per file, 32 files and 100 MB per manifest.

The authoring assistant pins a saved draft and proposes changes for review. Test conversations pin a published revision as operating instructions. Both use real ARC conversations and inherited provider permissions. Later library edits do not alter project copies or running sessions.

## Team Builder

Build graphs from published agents. Name/color nested groups; membership does not grant authority. Delegation/review permissions and execution edges are separate. Save drafts with diagnostics, publish, restore, archive or copy revisions into projects with their exact agents and references.

Graphs include tasks, joins, native checks, reviews, conditions, bounded repair, approvals, integration and delegation. Conditions use true/false connections; completion gates use all/any. Presentation changes preserve the operational hash. Release awaits Factory.

A bound assistant receives the saved draft before its first turn and proposes versioned changes for review. Applying edits the draft; publication is separate. Stale edits fail.

Graph runs seal a published project team and project/session settings before Workflows admission. Guided approves assignments; Collaborative approves the plan; Autonomous follows configured bounds. Exact preferred/restricted team revisions and limits are versioned. Release requires the future factory capability. Publishing alone never runs a graph.

## Runs and Workspace

Runs pin published project agents, resolved model settings, source commit and a required check. Workflows is the sole scheduler. Parallel writers use detached Git worktrees; all must finish before serial integration. Failed checks permit up to three repair rounds, followed by an explicit reviewer verdict and final candidate verification. The original checkout is preserved.

Pause fences dispatch before interruption; unknown effects require reconciliation. Workers have single-turn admission and passive parent notifications. Defaults are four active agents, 100 calls and two active hours. Manual main-chat activity is separate.

Workspace shows the real main composer, worker transcripts, attempts and native handoffs. Initial load does not replay animation. Fixed runs have no team snapshot; publishing a team does not retroactively group their workers.

## SDK, CLI and limits

Use `sdk.plugins.callRpc({pluginId:"arc",method,input})` or `bb arc agents|teams|runs|workspace|policy|orchestrator`. `runs rpc startTeamRun` pins a team; `listRunControls`/`resolveRunControl` inspect/answer decisions. `policy show|history` exposes settings. RPC supports JSON and host input/output files. See `bb arc --help` and the `agents` skill.

Main agents use `arc_orchestration_context` then `arc_team_run_request`. V3 adds one counted completion in the same chat and budget. User SDK/CLI uses `requestTeamRun`; `reconcileOrchestratedRun({runId})` recovers admission. Automatic completion cannot mint fresh limits. Native V3 passed; see `docs/ARC-PROGRESS.md`.

Directory runs use `getDirectoryRunSetup` then `requestDirectoryTeamRun`, retaining the inspection ID on retry. V4 uses serial copies and one counted main response. Native tools are `arc_directory_source_inspect` and `arc_directory_team_run_request`. Links and unsupported graphs report errors. Native V4 passed with Codex.

Shared Context, Factory, appearance and release remain pending. PDF/Office extraction is unavailable. Plugin controls do not sandbox provider terminal access or replace ARC's trusted local-user RPC boundary.

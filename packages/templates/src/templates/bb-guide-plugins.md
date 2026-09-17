---
kind: instruction
title: ARC Guide — Plugins
summary: Command reference for installing, configuring, running, and authoring ARC plugins and their contributed CLI commands.
intent: Provide complete plugin command documentation plus an authoring walkthrough for agents and humans building ARC plugins.
editingNotes: Keep flags accurate against the CLI implementation (apps/cli/src/commands/plugin.ts, apps/cli/src/commands/marketplace.ts) and the server plugin service; a CLI test asserts every `bb plugin` and `bb marketplace` subcommand appears in this chapter. The full authoring reference is the bb-plugin-authoring builtin skill.
---

Plugin commands

An ARC plugin is a TypeScript package that extends the ARC server in-process and
may also declare one bundled Node entry for enrolled hosts: background
services, cron schedules, HTTP/RPC endpoints, thread lifecycle handlers,
settings, storage, host-local operations — and `bb` CLI subcommands that agents
and humans run like any other command. Plugins are full-trust code in both
runtimes.

Plugins are on by default. Builtin plugins (`builtin:<name>`) ship with ARC;
user-installed plugins come from `bb plugin install` or the official store.
Plugin state lives under `<bb-data-dir>/plugins/<id>/` (per-plugin SQLite file,
secrets, logs).

The builtin Custom instructions plugin adds a multiline editor under Settings
→ Custom instructions. Saved text is persisted on this ARC host and included in
agent task instructions; blank text contributes nothing.

ARC's Context view and `bb arc context rpc <method> --input <json>` share
the typed `sdk.plugins.callRpc({pluginId:"arc",method,input})` surface.
Start with `getContextSetup({projectId,hostId:null})`; its target selects the
registered checkout. Use `reindexContext({target,operationId})`,
`getContextStatus({target})`, `listContextSources({target,cursor:null,limit:50})`
and `searchContext({target,query,limit:8})`. `readContextExcerpt` checks the
exact index/chunk/source generation and content hash. `cancelContextIndexing`
requires the current operation ID. Unconfirmed model shutdown returns a failed
index with `embedding_stop_unresolved`
and blocks replacement rather than claiming cancellation. A recorded helper
generation may be reconciled by a later explicit request; an unknown generation
remains blocked pending cleanup verification, including across plugin reloads.
Import text with `importContextSource`; originals persist even when indexing
fails. Import and archive return a typed
`outcome`: `applied` includes the saved reference and nullable `indexError`;
`rejected` includes a capacity, revision, missing-source or operation-conflict
code and message. Correct a rejected request before submitting a new operation;
retry uncertain transport failures with the unchanged operation ID and input.
`listContextReferences` and
`readContextReference` retrieve saved versions independently of the host cache.
This initial text surface is user-only; agent retrieval needs a sealed execution
snapshot. Results are references and never grant operational authority. See the
ARC `agents` skill's Context section for inputs and explicit coverage limits.

ARC's builtin Agent Studio exposes `bb arc agents list`, `show`, `history`,
`rpc`, `attach`, and `download`. Run `bb arc agents --help` for their arguments.
Use `rpc --input-file <absolute-path>` for multiline documents and
`--output-file <absolute-path>` for large results. File operations require an
explicit `--host <host-id>` for user calls; agent calls use their current
thread's host. Downloads create a new file unless its existing content hash is
explicitly supplied. The plugin's `agents` skill documents the typed operations,
published versions, reviewable proposals and session binding.

Assigned skills use immutable `{id,name}` references. `agents rpc`
`saveAgentSkillBundle` and `readAgentSkillBundle` save/read complete SKILL.md
directories; `parseAgentSkillMarkdown` and `renderAgentSkillMarkdown` support
the guided Name, When to use and Instructions editor while retaining other
frontmatter. Keep every unchanged supporting file when saving a new bundle.
The bound authoring assistant can prepare an unassigned skill and propose its
reference for review; it cannot apply or publish the assignment.

ARC's Team Builder exposes `bb arc teams list`, `show <team-id>`,
`history <team-id>` and `rpc <method> --input <json>`. Add `--project <id>`
for project teams; RPC uses the explicit library/project scope in its JSON.
Input-file/output-file and host options match Agent Studio. The equivalent
SDK call is `sdk.plugins.callRpc({pluginId:"arc",method,input})`.

Use `saveTeamDraft` with the latest `expectedDraftVersion` to edit the same
builder definition: `name`, optional `presentation.color` (six-digit hex), and
each member's optional `modelOverride:{providerId,model,reasoningLevel,serviceTier}`.
All four model fields are explicit; service tier is `default` or `fast`.
Omit the override to inherit that pinned agent's defaults. Overrides keep the
reusable agent and permission mode unchanged. Publication affects new runs;
active snapshots change only through the existing operational-rule review.

`bb arc templates list` lists bundled versioned teams. The `templates rpc`
surface includes `getTeamTemplateSetup` and `instantiateTeamTemplate` for
Efficient Build: choose connected models and an explicit project check, then
create an editable project copy with a stable operation ID. New template
versions do not overwrite user copies; creating a copy does not start work.

Saved team drafts retain unfinished graph configurations and actionable
diagnostics. Publishing requires structural validity and creates an immutable
revision with exact published agent members. Named, colorable nested groups
organize the canvas; directed messaging/delegation/review grants remain separate
from membership and execution edges. Graph stages include agent tasks, parallel
paths, all/selected joins, checks, reviews, typed conditions, bounded repair,
approval, integration, release and bounded delegation, with all/any required
completion gates. Copying a library revision into a project atomically copies
its pinned agent revisions and reference files.

Use `createTeam`, `getTeam`, `saveTeamDraft`, `validateTeamDraft`,
`publishTeamRevision`, `copyTeamToProject`, history/archive methods and the
proposal methods through `teams rpc`. Writes require `expectedDraftVersion`;
stale changes reject. `startTeamAssistant` pins a saved draft before its first
bound conversation turn; `listTeamSessions` exposes the actual session IDs.
The assistant submits before/after proposals for user review. Applying edits
the draft; publishing is separate. The ARC `agents` skill documents exact
inputs, pinned references, hashes and caller permissions.

`runs rpc startTeamRun` seals a published project team and the observed project
and session policy versions. Its V2 graph uses the existing Workflows scheduler;
publishing alone never executes it. Release needs the later factory capability.
Existing fixed runs retain their original version and replay behavior.

`bb arc policy show|history --project <id> [--thread <id>]` exposes versioned
orchestration settings. `policy rpc getOrchestrationPolicy`, `saveProjectPolicy`
and `saveSessionPolicy` share their typed SDK contracts with the settings UI.
Explicit no preference differs from inheritance. New runs pin exact team
revisions, autonomy and limits; changed versions cannot alter an active run.
`runs rpc listRunControls` reads pending decisions; `resolveRunControl` requires
the exact context hash, revision and stable operation ID. Only user callers may
approve/reject decisions. The ARC `agents` skill documents complete inputs.

`bb arc orchestrator show --project <id> --thread <id>` discovers exact
eligible/preferred team versions and the main conversation's source and policy.
`runs rpc getProjectRunSetup` identifies Git or a plain directory. For folders,
`runs rpc getDirectoryRunSetup` starts/polls one stable inspection operation.
`orchestrator rpc requestDirectoryTeamRun` uses its sourceInspectionId and
expectedSource rootIdentity/manifestDigest to run serially in retained copies
with one counted main response. `discardDirectoryRunRequest` retires an exact
unused request; `reconcileOrchestratedRun` also accepts saved directory runs.
Links, parallel stages and candidate-changing checks report explicit errors.
The agents skill documents complete input fields and current acceptance.
`runs rpc resolveDirectoryRunControl` returns checking/resolved plus the control;
repeat the exact decision operation, context hash and revision while checking.
The folder approval UI waits for that inspection before displaying a saved decision.

`orchestrator rpc requestTeamRun` accepts the existing `startTeamRun` fields
and adds one counted main-chat response in the same run. Native main agents use
`arc_orchestration_context` then `arc_team_run_request`; ARC derives their real
invocation identity. Contextual agent CLI calls cannot request these runs.
User `reconcileOrchestratedRun({runId})` recovers the saved immutable request,
including a lost native admission response. `discardOrchestratedRunRequest`
retires an exact unused user request. All use the same SDK plugin RPC and file
options. Automatic completion cannot use the ARC tool to mint fresh limits;
further bounded rounds belong to Factory. Direct user RPC retains ARC's local
trust boundary, not a provider shell sandbox. Native acceptance is tracked in
`docs/ARC-PROGRESS.md`.

ARC's `bb arc runs list --project <id>`, `show <run-id>` and
`rpc <method> --input <json>` expose saved team runs, native evidence and
durable pause/resume/cancel controls. Runtime RPC supports the same input-file
and output-file options as Agent Studio. Start requests require a stable
`operationId`; retry the identical request after a lost response. Controls also
require an operation ID and the observed control version. The ARC `agents`
skill documents the required run fields and evidence methods.

For explicit instruction changes, `runs rpc previewRunInstructionUpdate` reviews
a newer published revision of the same team. `applyRunInstructionUpdate` pauses
the predecessor; `pollRunInstructionUpdate` advances its linked continuation.
Retain `operationId`, `previewId` and `previewHash` across Apply/Cancel retries.
`cancelRunInstructionUpdate` also takes the predecessor `runId`.
`getRunInstructionUpdateState({runId})` reads lineage without advancing work.
The whole team reruns from the verified original source; consumed calls, active
time and repair rounds carry forward. Publishing alone changes no active work.
See `docs/ARC-INSTRUCTION-UPDATES.md` for supported changes and recovery.

For policy/check/permission changes, `runs rpc previewRunRuleUpdate` takes
`runId`, an exact `team` pin and the observed project/session policy versions.
It returns a no-op, typed blockers, or a reviewable restart preview. The current
team revision supports settings-only updates. `applyRunRuleUpdate` retains
`operationId`, `previewId`, `previewHash`; `pollRunRuleUpdate` advances that
operation. `cancelRunRuleUpdate` also takes `runId`; keep cancellation intent
after lost replies. `getRunUpdateState` reads both kinds of update lineage.
New totals include all previously consumed calls, active time and per-stage
repairs. `getRunReviewAuthority` reads directed review-grant eligibility
separately from file verification. See `docs/ARC-RULE-UPDATES.md`.

To revise a saved start request, `runs rpc discardTeamRunRequest` takes its
exact original input and returns either the already saved run or confirmation
that the unused request is permanently retired. Retry the same recovery after
an uncertain response; create a new operation ID only after confirmed retirement.

`bb arc workspace show <run-id>` and `workspace rpc getWorkspace --input <json>`
expose the live Workspace's actual conversation IDs, pinned worker identities,
attempts, saved Team graph and recorded dispatch milestones. A nullable worker
`graphNodeId` comes from the compiled stage mapping; fixed runs have no graph.
The latest 100 worker attempts are a bounded window, not complete stage history.
Input/output file options match
the other ARC RPC commands. A null cursor establishes a baseline; pass its
returned cursor for later events and drain `hasMoreEvents`. Queued requests
are distinguished from native provider acceptance. See the ARC `agents` skill.

Use `bb arc workspace usage <run-id>` for available provider-reported tokens,
`results <run-id>` for retained check/review evidence, `reports <run-id>` for
source-pinned handoffs, and `messages <run-id>` for explicit team messages.
The matching SDK plugin RPCs are `getRunUsage({runId,offset,limit})`,
`getRunResults({runId,offset,limit})` and
`listRunCollaboration({runId,kind,cursor,limit})`, where kind is reports or messages.
Call them through `workspace rpc <method> --input <json>` for additional pages.
Follow the returned nextOffset or nextCursor until null. Unreported usage is
unavailable, not zero; do not add repeated refresh pages to usage totals.

The builtin Account Pooler plugin is disabled on fresh installations. It stores
Claude and Codex account tokens in per-account 0600 secret files and proxies
provider API requests through the ARC server. Enable it and add an account:

```
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider claude --import
bb pool account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id>
bb pool account priority <id> <n>
bb pool account reorder <claude|codex> <id>...
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>
bb pool token rotate --machine <id-or-name>
bb pool bypass <thread-id> [--off]
```

Claude `--login` starts a ten-minute in-memory PKCE session, prints the browser
sign-in URL and session ID, then exits. After sign-in, pipe the manual callback
code to `account login-complete` with that session ID. The browser does not need
to run on the ARC server machine, and neither the code nor account tokens enter
process arguments. Codex `--login` prints a device verification URL, one-time
code, session ID, and an `account login-poll` command that waits for
authorization. Both flows are available in the plugin settings page through
the **Sign in to Claude** and **Sign in to Codex** buttons. The CLI Codex import
path continues to read the ARC server host's `~/.codex/auth.json`.

The hub starts immediately, even before an account is configured, so newly
added or enabled accounts are available without a plugin reload. With an
enabled account whose secret file remains readable and valid, the plugin
contributes its provider-specific server route and a distinct secret token to
Claude Code or Codex sessions on every host. Claude Code also receives
`ENABLE_TOOL_SEARCH=true` so tool search stays on through the hub. Codex
receives `CODEX_OPENAI_BASE_URL` and the secret `CODEX_POOL_AUTH_TOKEN`; its
app server uses those values without editing `~/.codex/config.toml`. Tokens are
never printed. `status` prunes tokens for
unenrolled machines and shows token timestamps plus recently routed threads
whose machines need a local Claude login before the pool can be disabled
safely. Rotation keeps the prior token valid for ten minutes. Agents should use
`--api-key-stdin`, which reads exactly one non-empty key from piped standard
input. The compatibility form `--api-key <key>` exposes the key in process
arguments, shell history, and agent transcripts. Prefer `--import` when Claude
Code is already signed in. OAuth quota refreshes on add or enable and every
five minutes while the account is idle. Account tables add columns for the
family buckets Anthropic reports, and JSON status exposes the same observations
under `familyWeekly`. Selection skips an account only for a spent requested
family while retaining it for other families. When Claude Code supplies an
account UUID in `metadata.user_id`, the hub aligns it with the selected OAuth
account. `bb pool config` prints the quota switch threshold and both upstream
URLs. Use `bb pool config set <key> <value>` to change one; the two URL values
are QA-only overrides. Upgrading from a build that stored these values through
plugin settings resets the threshold and QA overrides to their defaults.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 30 idle minutes,
and the pool retains the 4,096 most recently used pins.

Use the up/down arrows in Account Pooler settings, or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

The builtin Keep Awake plugin prevents macOS idle sleep while ARC is running.
Its settings page lets you target all hosts or selected hosts. The CLI
equivalents are:

```
bb keep-awake status [--json]
bb keep-awake enable [--json]
bb keep-awake disable [--json]
bb keep-awake hosts all
bb keep-awake hosts <host-id>...
```

It reconciles when the plugin starts, a host connects, its configuration
changes, or a worker exits unexpectedly. Disabling the plugin disposes its host
workers and their child processes.

The builtin Concurrency limit plugin controls how many threads run at once.
Its settings page has an optional overall limit and one limit per host. Host
limits default to Auto: one thread per available processor.
Leave an override blank to return it to Auto; use 0 to pause new work. The CLI
equivalents are:

```
bb concurrency-limit status [--json]
bb concurrency-limit global [unlimited|<limit>] [--json]
bb concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The builtin Provider retry plugin is enabled on fresh installations. It retries
Codex and Claude Code turns after structured provider overloads and subscription
window limits. A pending retry is a queued row on the thread, so a server
restart does not lose it, and that row — on the queue card above the composer,
with its reason, its time and its own Cancel — is the only place the wait is
narrated. Inspect it with `bb provider-retry status`. See
`bb guide providers` for the eligibility rules. The plugin only reacts to a
failed turn — it never blocks a send. Prior output or tool activity does not
block recovery. Its `maximumWait` setting defaults to `6 hours`; choose
`24 hours` or `No limit` from the plugin detail page, or configure it with
`bb plugin config provider-retry set maximumWait <value>`.

The builtin Workflows plugin runs durable provider-independent JavaScript
orchestration. It is disabled on fresh installations; enable `workflows` under
Settings → Installed plugins or run `bb plugin enable workflows` before using:

bb workflows validate (--script '<javascript>'|--source '<javascript>'|
--file <path>|--name <name>)
bb workflows run (--script '<javascript>'|--source '<javascript>'|
--file <path>|--name <name>)
[--args '<json>'] [--resume <run-id>]
bb workflows status <run-id>
bb workflows history <run-id> [--cursor <call-index>] [--limit <1-100>]
bb workflows list [--limit <1-50>]
bb workflows stop <run-id>

Commands must run from an ARC project thread. Workflows has six plugin
settings, configurable with `bb plugin config workflows set <key> <value>`:
`maxActiveRuns` (default 4, range 1–32), `maxConcurrentAgents` (8, 1–64),
`maxAgentCalls` (100, 1–1000), `totalRunTimeoutMs` (86400000, 60000–604800000),
`retentionDays` (7, 1–3650), and `maxNotificationBytes` (16384,
1024–262144). `maxActiveRuns` applies live; the other five are snapshotted for
each new run. Settings changes do not require a plugin reload.

`status` is a bounded polling summary, and `list` returns only compact run
summaries. Detailed run and call records are paged JSONL: redirect `history`
into `$BB_THREAD_STORAGE` before inspecting it, and continue with the final
page record's `nextCursor`. The invoking shell writes
that file on the thread's execution host, so this works the same on local and
remote hosts without granting the plugin arbitrary filesystem access. Use `bb
provider list --environment "$BB_ENVIRONMENT_ID" --json` and then `bb provider
models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json` before writing
an explicit selection; never guess ACP model IDs.

The Memory plugin is an opt-in install, bundled with the app:
`bb plugin install memory`. Once installed, it injects a compact global and
current-project memory index into agent context and progressively discloses
full records through CLI-only commands. Because its store works across
providers, we recommend disabling provider-native memory under Settings →
Providers to avoid duplicate or conflicting stores. Settings → Memory lists
every global and project memory and supports version-checked edits and soft
deletion.

bb memory catalog [--scope project|global|all] [--json]
bb memory search <query> [--scope project|global|all] [--json]
bb memory get <id> [--scope project|global|all] [--json]
bb memory add --scope project|global --name <name> --summary <text>
--details <text> --reason <text> [--kind <kind>]
[--tag <tag>]... [--importance <0-100>] [--pinned] [--json]
bb memory update <id> --expected-version <n> [fields...] [--json]
bb memory forget <id> --expected-version <n> --reason <text> [--json]
bb memory history <id> [--scope project|global|all] [--limit 1-100] [--json]

Project writes use the invoking CLI's current project. Global writes require
the explicit `--scope global` flag.

The Docs plugin is an opt-in official plugin bundled with the app:
`bb plugin install docs`. Read-only discovery remains direct, while edits use
a manifest-backed local workspace:

bb docs vaults [--json]
bb docs list [--vault <id>] [--json]
bb docs read <path> [--vault <id>]
bb docs pull <path> [--folder] [--vault <id>] [--into <dir>]
bb docs pull --all [--vault <id>] [--into <dir>]
bb docs status [workspace-dir] [--delete] [--diff] [--json]
bb docs push [workspace-dir] [--delete] [--dry-run] [--diff] [--json]

Pull preserves vault-relative paths and writes `.bb-docs-state.json`; edit the
ordinary files and leave that state file untouched. Push uses pulled SHA-256
versions as compare-and-swap guards. Concurrent changes stop with exit 3.
Status exits 0 when no changes exist and exits 4 when changes exist. Exit 4 is
a successful result. Review its output, then run push separately. Do not
connect status and push with `&&`.
Local file and empty-directory deletions are warnings unless `--delete` is
explicit; a pulled folder root is retained, so pull its parent or the whole
vault to remove that folder. Use `--workspace-host <id>` when a standalone
CLI's working directory is on a non-primary host. Direct `write`, `mkdir`,
`move`, and `remove` remain only as deprecated compatibility commands.

The Tasks plugin is an opt-in official plugin bundled with the app:
`bb plugin install tasks`. It adds a task tracker, agent delegation,
and the `bb tasks` command. Common agent operations are:

bb tasks show <key-or-id> [--json]
bb tasks list [--project <prefix-or-id>] [filters...] [--sort manual|priority|due] [--limit 1-500] [--cursor <opaque>] [--json]
bb tasks comment <key-or-id> (--body <markdown> | --body-file <path>) [--json]
bb tasks attachment add <key-or-comment-id> --file <path> [--json]
bb tasks attachment get <attachment-id> --out <path> [--json]
bb tasks attach <key-or-id> [--thread <thread-id>] [--json]
bb tasks detach <key-or-id> [--thread <thread-id>] [--json]
bb tasks update <key-or-id> --status in_review [--json]
bb tasks update <key-or-id> (--parent <parent-key-or-id> | --no-parent) [--json]

Run `bb tasks --help` for project, folder, task, label, attachment, and demo-data
commands, plus preset management, delegation, and attached-thread inspection.
Delegated threads are attached automatically; use `bb tasks attach` only when
work started outside Tasks, and `bb tasks detach` when a thread is done with a
task or a respawned worker replaced it. `bb tasks threads <key>` lists live
threads first, newest first. Task update resolves both task keys and IDs for
`--parent`; use `--no-parent` to promote a subtask to the top level. File paths
in tasks commands resolve on the invoking machine (the thread's machine inside
an agent thread, otherwise the server's); pass `--machine <id-or-name>` to
target another enrolled machine.
Task lists default to 100 rows. JSON pages include `nextCursor`; human pages
print the exact continuation option when more rows exist. Cursors are bound to
the filters, sort, and task-list revision. Any add, removal, reorder, update,
label-link/name change, active-thread change, or project-prefix change invalidates an
outstanding cursor; restart without `--cursor` instead of accepting a mixed
snapshot.

The builtin Secrets plugin provides a secure credential form and guarded
dotenv reconciliation:

bb secret request <NAME...> --write-env <path>
[--purpose <text>] [--describe <NAME> <text>]...

The command blocks until the user submits or cancels the form. Secret values
never appear in command arguments, model-visible output, or persisted
interaction data; success prints only the path, variable names, and
added/updated/unchanged counts.

bb plugin search <query> Search the store: the plugins bundled with
the app plus every registered marketplace
catalog. Results include a Category column
bb plugin install <entry> Install a bundled official plugin by name
(github, docs, memory, tasks),
<entry-id>@<marketplace>, a Git repository
URL, local path, builtin:<name>,
git:<url>[@<ref|semver-range>], or
npm:<package>[@<version|tag|range>]
(npm: needs npm on PATH; installs prompt —
pass --yes to skip). Managed git:/npm:
installs refuse engines.bb / engines.bbPluginSdk
mismatches, manifest/artifact identity
mismatches, and ids reserved by bundled plugins
Omitted npm specs, ranges, dist-tags, omitted
Git refs, Git branches, and Git semver ranges
track; exact npm versions, Git tags, and Git
commits are pinned
--subdirectory <path> installs one plugin
directory of a multi-plugin git:/path:
repository; --plugin <name> installs the
.bb/plugins.json entry with that name
(the two flags are mutually exclusive)
--tag-prefix <prefix> resolves a git: semver
range over <prefix>vX.Y.Z tags
Installing a local path for an id that is
already installed from another local path
moves it there and keeps its settings
bb plugin outdated Check installed plugins for compatible
updates (table; --json for raw results).
Columns: installed, latest compatible,
blocked newer (incompatible releases not
selected), status. Dev builds (ARC 0.0.0)
annotate that engines.bb is not enforced
bb plugin update <id> | --all Apply compatible updates for one plugin or
every tracking plugin with an update. Same
full-trust confirmation as
install (--yes skips; non-TTY refuses without
--yes). Use outdated to preview; pinned
installs stay put
bb plugin list Status, services, schedules, handler timings.
`bb status` also names enabled plugins that
are incompatible, failed, or missing
bb plugin source <id> [--json] Show requested/resolved source, subdirectory,
semver range with its tag prefix and resolved
tag, engine ranges, install time, and recent
activation history
bb plugin enable|disable <id> Load or unload an installed plugin
bb plugin reload [id] Re-run factories against current sources.
Exits 1 when a plugin does not come up on
them (previous instance kept, or degraded
because a service ignored its abort)
bb plugin config <id> [set <key> <value> | unset <key>]
Show or change a plugin's declared settings
bb plugin logs <id> [-n N] [-f] Print (or follow) a plugin's bb.log output
bb plugin run <id> [args...] Run a plugin command explicitly (also works when core owns its name)
bb plugin token <id> [--rotate] Print the token for auth:"token" HTTP
routes; --rotate generates a new token,
invalidating the old one
bb plugin remove <id> Uninstall and delete the plugin's settings,
secrets, and schedules (managed git:/npm:
files deleted; local path sources stay on
disk; builtin removals are remembered)
bb plugin new <name> Scaffold a todo-list plugin (server.ts,
app.tsx with a sidebar page, a `bb <id>` CLI
command, and a skill) and install its npm
dependencies, including @get-bb/plugin-sdk
pinned to this ARC's exact SDK version (no
server required)
bb plugin types [path] Sync a plugin's @get-bb/plugin-sdk surface to
this ARC (default: cwd): repin the npm
devDependency to this ARC's SDK version and
the type-only devDependencies of the packages
ARC shims at runtime (sonner, vaul, the portal
radix families, ...) to this ARC's versions, or
rewrite the vendored types/ of a plugin that
still carries them; --check writes nothing
and exits non-zero on a mismatch
bb plugin migrate [path] Switch a plugin that still vendors types/ to
the @get-bb/plugin-sdk npm package (default:
cwd): pin the devDependency, drop the tsconfig
path map, delete the vendored declarations.
Prints the plan and asks first; --yes skips
the prompt (required when stdin is not a
terminal). The old layout keeps working, so
nothing migrates unless you ask
bb plugin build [path] Compile the plugin into dist/ — the backend
bundle (server.js, server.meta.json); when
bb.app is declared, the minified frontend
bundle (app.js, app.css, app.meta.json); when
bb.host is declared, the self-contained Node
host bundle (host.js, host.js.map,
host.meta.json recording its digest — host
daemons fetch and verify the bundle by that
digest, and run it as a host RPC worker, a
provider bridge, or both). Each
\*.meta.json is stamped with SDK
major/version, artifactFormatVersion,
pluginId, pluginVersion, and builtWith (ARC +
plugin SDK versions); no server required
bb plugin dev [path] Watch a plugin's sources (default: cwd) and
on every change rebuild its declared frontend
(unminified, for readable stack traces),
host, and provider-bridge bundles, then
reload the plugin; Ctrl+C to stop

bb marketplace add <source> Add a marketplace from an https manifest URL,
git:<url>[@<ref>], or path:<directory>. ARC
validates the manifest, caches the catalog,
and fetches the entry icons. Adding a
marketplace installs nothing
bb marketplace list Name, source, entry count, and last refresh of
every marketplace (--json for raw rows)
bb marketplace refresh [name] Re-read one catalog, or every one of them.
Discovery metadata and icons only — a refresh
never installs, updates, or runs plugin code.
A failed refresh keeps the last catalog ARC
validated and exits non-zero
bb marketplace remove <name> Forget a marketplace. Its catalog rows and
cached icons are deleted; plugins installed
from it keep running as direct installs and
keep checking for updates from their recorded
source. bb-official and bb-community cannot
be removed

Multi-plugin repositories

One repository can hold several plugins. Each plugin directory stays an
ordinary plugin package with its own package.json and ARC manifest. An optional
collection manifest at .bb/plugins.json indexes them:

{
"$schema": "https://getbb.app/schemas/plugins.schema.json",
"schemaVersion": 1,
"name": "acme-plugins",
"plugins": [
{ "name": "sidebar", "source": "./plugins/sidebar" },
{ "name": "status", "source": "./apps/status" }
]
}

Every source is a repository-relative directory that starts with "./".
Absolute paths, "..", and a source that selects the repository root are
rejected, and so are duplicate entry names and unknown fields. The file is an
index only: identity, branding, entry points, and engine ranges stay in each
plugin's own manifest.

Install one plugin of the repository:

bb plugin install git:github.com/acme/repo@main --plugin sidebar
bb plugin install git:github.com/acme/repo@main --subdirectory plugins/sidebar
bb plugin install path:/work/repo --plugin sidebar

--subdirectory is the primitive and works without a collection manifest.
--plugin resolves a name from .bb/plugins.json. Installs from one repository
and commit share a single checkout. When a repository has a collection
manifest, is not a plugin itself, and neither flag is given, the install fails
and lists the entry names. ARC records the subdirectory, so outdated, update,
rollback, and remove keep working per plugin.

Plugins included with ARC

The bundled plugins ship inside ARC. The reserved `bb-official`
marketplace describes these plugins with the standard v2 format. Its catalog
uses a local path. It never uses the network. `bb marketplace list` shows it
first. You cannot add or remove it.

The plugins appear in the first Browse shelf, Included with ARC. They also appear in
their category shelves. Install a plugin by its bare name or its qualified name.
For example, use
`bb plugin install docs` or `bb plugin install docs@bb-official`. ARC copies the
plugin from the app bundle. An app update also updates the bundled copy.

The Community marketplace has the reserved name `bb-community`. It lists
reviewed plugins that live outside the app bundle. ARC requests the v2 manifest
from https://getbb.app/marketplace/v2/marketplace.json. A 404 response makes
ARC request the v1 manifest. Other errors do not cause this fallback. Set
BB_MARKETPLACE_URL to override the URL. ARC reads the manifest at startup and
every two hours.

ARC stores the last catalog that it validated. An invalid manifest keeps that
catalog. The app also includes a seed snapshot for the first offline start. A
refresh changes discovery data and icons only. It never installs, updates, or
runs plugin code. The server fetches and serves entry icons. The detail page
loads screenshots from the URLs that the marketplace declares. An entry can
also carry a long-form markdown description. The detail page renders it below
the short description, and `bb plugin search --json` returns it as `overview`.
An install uses the normal git or npm source pipeline. ARC records the source
marketplace.

The Community marketplace also publishes install counts beside its
manifest, at https://getbb.app/marketplace/v1/stats.json. ARC re-reads that
file on every refresh — the counts move while the manifest sits unchanged —
and shows them in the store and in the Installs column of `bb plugin search`.
The number is how many installations reported installing the plugin
through anonymous telemetry, so it undercounts: telemetry is opt-out and only
production builds report. No third-party marketplace has counts; ARC measures
them itself rather than repeating a publisher's claim.

Included with ARC entries use the same counts. ARC finds each count in the upstream
Community `stats.json` file by the plugin id.

Third-party marketplaces

Anyone can host a marketplace manifest. Add one with its https manifest URL,
with git:<url>[@<ref>] (ARC reads marketplace.json from the checkout), or with
path:<directory> on the ARC server's machine:

bb marketplace add https://plugins.acme.dev/marketplace.json
bb marketplace add git:github.com/acme/bb-marketplace@main
bb marketplace add path:/work/acme-marketplace

The manifest `name` is the marketplace identity. ARC refuses a duplicate name.
The `bb-official` and `bb-community` names are reserved. You cannot add or
remove them. A third-party marketplace can use manifest v1 or v2. A git or
path marketplace reads icons
from its checkout. An HTTPS marketplace resolves relative icon URLs against
the manifest URL. The server fetches and serves all icons. The detail page
loads screenshots from the URLs that the marketplace declares. ARC clones a
git marketplace into a temporary checkout. ARC keeps only the validated
manifest and icon bytes.

ARC ignores unknown v2 fields, except in npm and git source objects. ARC rejects
unknown source keys because a source key changes the installed code.

Install an entry of a specific marketplace with <entry-id>@<marketplace>:

bb plugin install thread-hover-cards@acme-plugins

A bare id resolves across every marketplace. Exactly one match installs.
Several matches fail and list the id@marketplace choices. Every other source
form — Git repository URLs, path:, npm:, git:, builtin:, and path-like
syntax — is unchanged and still bypasses catalog resolution.

Before an install from a third-party marketplace, ARC resolves and
shows the true source: the npm package with its range or dist-tag, or the git
URL with its ref or semver range, its subdirectory, and the exact release tag
and commit that range currently lands on. The confirmation names the
marketplace and the entry's author. `--yes` skips the prompt, not the
resolution. The same disclosure appears in the app's install dialog, and
Settings → Plugin marketplaces adds, refreshes, and removes marketplaces with
the same server routes the CLI uses.
The install must still match these confirmed source facts. ARC refuses the
install when the listing or its resolved git commit changes after confirmation.

Removing a marketplace never disturbs installed code. Each plugin it listed
becomes a direct install that keeps its full source intent and exact
resolution, so `bb plugin outdated` and `bb plugin update` keep working from
the recorded source. Only the catalog rows and the cached icons are deleted.

The Browse tab groups entries by publisher: Included with ARC for the plugins
bundled with the app, Community for the curated marketplace's listings, and
each third-party marketplace under its own display name. Grouping keys on the
marketplace identity, not on the display name, so a marketplace cannot join
another publisher's group by copying its name. Only the two reserved
marketplaces can use the Included with ARC or Community labels. Entry cards show
the author.

For direct git:/npm: installs, updates are manual: `bb plugin outdated`
checks tracking sources and `bb plugin update` applies compatible candidates.
Reinstalling an already-installed managed plugin is refused — use
`bb plugin update`. A failed activation restores the pre-update snapshot and
leaves the latest failure visible as needing attention. Exact npm versions,
git tags and commits, path sources, and bundled official plugins are pinned;
npm ranges/omitted specs/dist-tags, omitted Git refs (the repository default
branch), Git branches, and Git semver ranges track compatible updates. A
pinned git:/npm: source changes only through `bb plugin remove` (which
deletes the plugin's settings, secrets, and schedules) and a fresh install. A
local path plugin is never removed to change it: edit it in place and
`bb plugin reload <id>`, or `bb plugin install path:<new dir>` to move it to
another directory; both keep its configuration.

Git semver ranges

A git source can track releases the way an npm range does, over the
repository's tags:

bb plugin install git:github.com/acme/repo@^1.2.0
bb plugin install git:github.com/acme/repo@semver:^1.2.0
bb plugin install git:github.com/acme/repo@^1.2.0 --tag-prefix notes/

ARC lists refs/tags, keeps the tags named [<tag-prefix>]vX.Y.Z that parse as
semver, and installs the highest one the range allows. Prereleases are
excluded unless the range itself names one (^1.0.0-beta.1), exactly as for an
npm range. Without --tag-prefix the tags are repository-wide (v1.2.3); with
it they version one plugin of a repository (notes/v1.2.3).

ARC records the tag it selected and the commit that tag pointed at. If that
tag later points at another commit, ARC refuses to resolve it and names both
commits: a released version is not allowed to change under you. Remove and
reinstall the plugin to accept the new commit.

A bare spec that reads as a range (`^1.2.0`, `1.x`, `>=1 <2`) resolves over
tags only when the repository has no branch or tag of that literal name; when
it has both, the install fails and asks you to choose. Write
`@semver:<range>` for the range or `@ref:<name>` for the literal ref. Bare
version tags such as `v1` and `v1.2.3` are always the literal tag.

`bb plugin search <query>` matches an id, name, description, category, or tag.
It searches bb-official and each other registered marketplace. The output has a
Category column. Status shows installed, compatible, or requires newer ARC.
Install a bundled plugin by its bare name. Direct
HTTP(S) Git repository URLs, `path:`, `npm:`, `git:`, and `builtin:`
sources—and path-like syntax—continue to bypass official-plugin resolution.

Builds are automatic once installed. Git installs run `npm install`
(lifecycle scripts disabled), then compile both bundles — so a git plugin may
depend on third-party packages. node_modules is kept, because bundling cannot
inline data files a dependency reads at runtime. A committed dist/ is always
replaced by the bundles ARC builds. Path installs compile dist/ at install time
from dependencies you have already installed. A build failure fails the
install. npm packages must ship a metadata-validated prebuilt app or the
install is refused. The server rebuilds source-built apps after a ARC upgrade.

Installing or updating a git plugin requires `npm` on PATH. Checking for
updates does not: a check reads the candidate's manifest and stops, so
polling never resolves a dependency tree or builds. A candidate that fails to
build is reported as available and fails when you apply it.

ARC ships no build toolchain. The first time a git or path plugin is built on
a machine, ARC downloads a pinned esbuild + Tailwind set into
`<dataDir>/plugins/toolchain-<versions>/` and reuses it afterwards. Installing
a prebuilt npm plugin never triggers that download.

To build a plugin yourself — in CI, or to check it compiles without a running
ARC — depend on the published `bb-app` package and call the CLI:

```jsonc
// your plugin's package.json
"devDependencies": { "bb-app": "^0.35.1" },
"scripts": { "build": "bb plugin build" }
```

`bb plugin build` talks to no server. Depending on `bb-app@X` builds with
exactly that release's shim configuration, so the bundle cannot be built
against a mismatched host runtime. Cache the toolchain directory in CI to skip
the download on later runs. Only `bb plugin dev` needs a running ARC, because
it reloads the installed plugin after each rebuild.

The backend half is prebuilt too: when a builtin/official/git/npm install ships
a dist/server.js built for the running SDK major, the server loads it instead
of the TypeScript source. A declared `bb.host` is bundled into a self-contained
Node 22 ESM artifact and delivered lazily to the targeted daemon after digest
verification. Host production code may import public
`@get-bb/plugin-sdk` entrypoints, Node APIs, and ordinary dependencies, but no
private `@bb/*` workspace packages; the host build rejects direct, transitive,
type-only, and relative imports that resolve into those packages.
Keep the SDK in exact devDependencies: the builder supplies and bundles its
small host runtime, so managed installs and remote workers do not resolve an
SDK package at runtime. That covers the bare `@get-bb/plugin-sdk` import. An
SDK subpath (`@get-bb/plugin-sdk/host`, `/provider-bridge`,
`/provider-bridge/acp`, `/ai-services`) imported from server or host code is
bundled from the plugin's own installed SDK, so a plugin that imports one
needs the SDK as a real dependency; the build names the missing install
rather than shipping an import ARC cannot serve.
Path installs always load server.ts from source, so `bb plugin dev`/reload see
edits immediately.

The `@get-bb/plugin-sdk/provider-bridge` entrypoint exposes experimental native
process helpers for host plugins and provider bridges:

- `experimental_spawnPortableProcess({ command, args, cwd, env, stdio, detached })`
  launches a command with a separate argument array, resolves Windows command
  shims, and hides its console window. Build `env` with
  `sanitizeInheritedChildProcessEnv` and pass only the additional variables the
  child needs.
- `experimental_supportsProcessGroups()` reports whether the platform supports
  the Unix process-group cleanup path. Use its result for `detached` when the
  plugin owns and supervises the child.
- `experimental_killProcessGroup({ child, signal })` stops an owned child group
  on Unix. On Windows it uses `taskkill /PID <owned-pid> /T /F` while the leader
  is still alive and refuses invalid or current-process IDs. Observe the child's
  termination before reporting it stopped; retain uncertain outcomes when
  termination cannot be confirmed. These helpers supervise owned processes;
  filesystem restrictions and crash containment remain the host runtime's
  responsibility.
- `experimental_resolveWindowsPowerShell(env)` selects an existing `pwsh.exe`
  from the supplied PATH, then the conventional PowerShell 7 installation,
  then Windows PowerShell under SystemRoot. Pass the selected executable and
  its arguments separately to the spawn helper.

`bb plugin dev` is the edit loop: it requires the directory to already be
installed as a plugin (`bb plugin install .` first), ignores dist/,
node_modules/, and .git/, batches saves, and prints one line per cycle. A
build or reload failure prints the error and keeps watching (a failed build
skips that cycle's reload). Reloads reach open app pages live — changed
frontend bundles re-import and their UI slots remount without a page refresh —
and replace host worker generations on their next call.

Frontend entries (app.tsx) default-export `definePluginApp` from
`@get-bb/plugin-sdk/app` and register UI slots: homepageSection (root compose),
settingsSection (per-plugin settings page below the host-rendered settings
form; no props in V1, optional host-rendered title),
navPanel (own sidebar entry + /plugins/<id>/<path>/\* route; the remainder
arrives as the component's subPath prop for panel-internal deep links; the
host always renders the shared plugin title bar and the component owns a
zero-padding full-bleed body, including its scrolling; optional
experimental_sidebarAccessory mounts a presentational live-value component at
the trailing edge of the sidebar row on wide viewports, bounded to one short
line, replaced visually by the host options button on hover/focus, and omitted
on compact viewports),
threadPanelAction
(a thread-only entry in an existing thread's right-panel new-tab Actions list;
it is never offered on root compose, and its run() can
open closable panel tabs with recursive `JsonValue` params; restored
components read a required `threadId` plus `JsonValue | null`),
experimental_newThreadPanelAction (the root New thread counterpart, with
`projectId: string | null` instead of `threadId`), pendingInteraction (temporarily replace a thread composer with a
plugin form), fileOpener (register as a per-extension file viewer/editor;
users pick defaults under Settings → File openers and can right-click a
file link for a one-off choice), and messageDirective (replace a leaf
`::name{k="v"}` block inside assistant / nested-agent Markdown with a plugin
component; unknown, disabled, incomplete, code-fenced, or crashing
directives fall back to the original source; components receive a nullable
openWorkspaceFile(path) callback for opening a worktree-relative file in the
host workspace viewer and a nullable
openThreadPanel({ actionId, title?, params? }) callback for opening one of the
same plugin's thread-panel actions). Hooks:
useRpc, useRealtime, useRealtimeConnectionState (the shared realtime socket's
connecting/connected/reconnecting lifecycle; reconcile on later connected
transitions, not the initial connection), useSettings (secrets excluded),
useBbContext,
useBbNavigate (including openUrl(url), which applies the current
client's in-app/external-browser preference, plus
experimental_openFilePreview({ target, location }) and
experimental_openFileExternally({ target, location }) for explicit live
workspace/host/thread-storage files), useComposer
(read/replace/update/clear scoped composer text,
apply a class-based text effect, lock input, quote selections, insert mention
pills, and focus the composer), and useComposerView (reactive bound scope,
layout, draft, and run state). Plain-text edits preserve attachments and
reconcile only inline mentions overlapped by the edit. Define RPC methods with `defineRpcContract`
and Standard Schema-compatible input/output validators (Zod works directly),
register via `bb.rpc.register(contract, handlers)`, then use a type-only
backend contract import with `useRpc<typeof contract>()` for exact frontend
method/input/result inference. The server validates both schemas and rejects
non-JSON results (including cyclic and non-finite values) with structured
error codes. Components are vendored shadcn source the plugin owns (the
shadcn model): `bb plugin new` pre-vendors a starter set into
components/ui/ and `npx shadcn add @bb/<name>` pulls more from the ARC
component registry (the full stock shadcn set, version-matched to the
running ARC via the pinned ref in components.json). Product capabilities are
the exception: UrlLink renders a real anchor whose ordinary
HTTP(S) activation uses the same client preference as first-party links while
leaving app routes, modifiers, copying, unsupported schemes, and explicit
targets browser-owned. A `_blank` or named target preserves your `rel` tokens
but adds `noopener noreferrer` unless `rel` explicitly contains `opener`.
experimental_FileLink renders a real explicit live-file anchor whose ordinary activation uses the same
preview/file-opener controller as first-party links. Valid targets expose an
encoded, scheme-safe href; traversal paths, ill-formed Unicode, and other
malformed runtime targets are inert in both the app and SDK test harness. Its
lazy context menu adds Open with, preferred-external, installed-app, and copy
actions without reading the file or discovering editors on mount.
experimental_ProviderModelPicker is the controlled
`{ providerId, model, reasoningLevel, serviceTier? }` selector backed by the
same catalog and picker as ARC's composers; provider switches emit only after
the target provider's verified defaults and capabilities resolve. Its optional
`routing` targets a host or existing environment; `disabled` renders the same
selection summary read-only. Tasks presets and Automations use this component
instead of plugin-owned catalog RPCs.
Every `fixedTabs` registration must include `panelId` equal to its
containing nav panel's `id`; it is also an owner-scoped reference. Add
`experimental_target: { validate }` for a typed JSON-safe transient target,
select it with `experimental_useAppPanel().openFixedTab({ surface: { kind:
"current" }, tab, target? })`, and read the target state inside the fixed tab
with `experimental_useFixedTabTarget(tab)`. Target state survives tab, panel,
and route remounts for the current app session; call `clear()` when returning to
the tab's untargeted state. Selection persists across refreshes, but targets do
not. A plugin can address only its own eligible tab on the current nav panel.
`import { toast } from
"sonner"` reaches the host toaster; react, the portaling radix families,
sonner, vaul, @pierre/diffs, and the host-resident clsx, tailwind-merge, and
class-variance-authority libraries are runtime-shimmed (never bundled). Shimmed
does not mean undeclared: tsc resolves their declarations through node_modules,
so each shimmed package a plugin imports is a type-only devDependency at the
host's version — the scaffold declares all of them and `bb plugin types`
repins them; never list one in dependencies, which would bundle a second copy —
though source and diffs should go through the host's own
experimental_SourceCode / experimental_Diff components rather than
@pierre/diffs directly, so ARC owns patch normalization, syntax
highlighting, and the live code theme. A Diff caller that has loaded complete
old/new UTF-8 file contents can pass them through
`experimental_fullFileContents` to enable
expand-context controls without exposing Pierre types. ARC's original renderer
validates those paths and hunk lines before enabling expansion; a replacement
that implements its own expansion must do the same.
Everything else (zod included) bundles from the plugin's node_modules (`npm install` for authors; ARC installs
release packages with their declared production dependencies). A crashing slot collapses to a
"plugin <id> crashed" chip without
touching the rest of the app. Installed plugins and their declared settings
(same data as `bb plugin config`) also appear under Settings → Installed plugins.

Plugin CLI commands: a plugin can register one top-level subcommand (for
example `bb github …`). Unknown `bb` commands are looked up against installed
plugins and proxied to the server, so plugin commands work exactly like core
commands; core command names always win. A collision logs an activation warning,
and `bb plugin list` shows the required `bb plugin run <id>` form. Inside agent
threads the generated `plugin-commands` skill lists the available plugin commands.

Settings changes do not auto-reload a plugin — run `bb plugin reload <id>`
after configuring. Add --json to plugin commands for machine-readable output.
Plugin CLI stdout plus stderr is capped at 1,048,576 UTF-8 bytes from the
shared `@get-bb/plugin-sdk` constant. Results above the ceiling are rejected in
full with a structured `plugin_cli_output_too_large` error; output is never
silently clipped. Page growing collections and use file/streaming commands for
large content.

Authoring a plugin

The loop: `bb plugin new <name>` scaffolds `./bb-plugin-<name>` — a working
todo list with a backend, a sidebar page, a `bb <name>` command, and a skill;
delete what you do not need; `bb plugin install .` registers it; `bb plugin
dev` watches and reloads on every save. The manifest is package.json: required
`bb.name` and `bb.description` human identity, required `bb.branding` with at
least `icon` or `logo.light`, `bb.server`
(backend entry, loaded as TypeScript — no build step), optional `bb.app`
(frontend entry), optional singular `bb.host` (full-trust Node entry run by
targeted enrolled daemons), optional `bb.skills` (static skill directories auto-imported
into agent threads unless filtered by `bb.agents.configure`; default
`skills/`), `engines.bb` (supported ARC range),
and optional `engines.bbPluginSdk` (the lowest plugin SDK you need, read as a
floor rather than a ceiling; scaffold writes `">=0.4.3"` for SDK 0.4.3). Use
`bb-plugin-hello` for the package name by
default. Scoped names such as `@acme/bb-plugin-hello` are also supported. The
plugin id is the final package-name component minus `bb-plugin-`, so both forms
use `hello`.

The scaffold also writes `PLUGIN_OVERVIEW.md` beside package.json: the
long-form store listing, shown in an Overview section under `bb.description` on
the plugin detail page in the app and on getbb.app. It says the same thing as
`bb.description` at length, so update both together. Keep it under 4000
characters, use headings, paragraphs, emphasis, code, blockquotes, lists,
thematic breaks, and absolute https links only, and do not open with a `#`
title. A submission to the Community marketplace requires the file.

Plugins can contribute palettes with `bb.themes`: an array of
`{ id, name, description?, css, codeTheme? }`, where `css` is a
plugin-relative `.css` file and optional `codeTheme` is
`{ dark?, light? }` (a bundled Shiki / Pierre name or a plugin-relative
VS Code theme `.json`). Loaded plugin palettes appear in Settings →
Appearance and `bb theme list`; their selectable id is
`plugin:<plugin-id>:<theme-id>`. Disabling or removing the owning plugin
makes ARC fall back to the default palette.

Branding is explicit. Declare `bb.branding.icon` as either the plugin's
canonical ARC icon name or a plugin-relative compact SVG such as
`./assets/icon.svg`. ARC validates and hash-serves path-shaped SVGs, then
renders them as masks that inherit the surrounding text color. Compact chrome
prefers the manifest icon, then a contribution's local icon hint, and finally
Zap. Roomy surfaces reuse the same icon when no logo override is declared.

Add `bb.branding.logo.light` only for intentionally different rich/full-size
identity artwork; optional `bb.branding.logo.dark` is preferred in dark mode.
Logo paths must be plugin-relative `.svg`, `.png`, or `.webp` files.
`bb plugin build` refuses an SVG logo that carries a script vector (a
`script`, `handler` or `listener` element, an `on*` attribute, or a
`javascript:` href) and takes any other tool export as-is; install and load
never refuse a logo, and every SVG ARC serves carries `nosniff` and a
`default-src 'none'` CSP. Root logo files are not auto-detected, and a dark
logo requires a light logo. Logo-only
manifests remain supported for compatibility, so at least an icon or light logo
is required. Do not duplicate the same artwork across fields. ARC rejects nulls,
empty strings, missing or escaping assets, and unsupported extensions. Reload
the plugin to pick up branding changes.

The backend entry default-exports a factory receiving the full plugin API:

import type { BbPluginApi } from "@get-bb/plugin-sdk";
export default async function plugin(bb: BbPluginApi) { ... }

The import is type-only and erased at load; the scaffold depends on the npm
package @get-bb/plugin-sdk, pinned to this ARC's exact SDK version, so
`npm install && npx tsc --noEmit` typechecks anywhere — no ARC checkout
needed. The full API lands at
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts (plus
-app.d.ts and -host.d.ts): ordinary readable declarations, not a minified
bundle — read them
for an exact signature. Plugins scaffolded before this switch instead vendor
the root/app declarations in types/, mapped through tsconfig; that layout still
works for existing entries. Run `bb plugin migrate` before adding `bb.host` so
the `/host` and `/testing/host` declaration subpaths are available; migration
shows every change and asks first.
The SDK surface grows every release, so `bb plugin types` syncs a plugin to
the running ARC — repinning the SDK devDependency and the shimmed packages'
type-only devDependencies, or rewriting types/ for a plugin that still
vendors them. Run it in a cloned or older plugin, and `bb
plugin types --check` in CI. `bb plugin build` and `bb plugin dev` keep a
vendored plugin in step for you. Need a symbol the types
don't explain? Clone the repo: https://github.com/get-bb/bb. The API in
one line each — bb.log (plugin-scoped logger behind `bb plugin logs`);
bb.settings.define (declarative settings incl. secrets, editable via
`bb plugin config`); bb.storage.kv (JSON rows ≤256KB) and
bb.storage.database()+migrate (the plugin's own database); bb.sdk (the full
ARC SDK — handlers/services only, not the factory; spawned threads are
attributed to the plugin; `visibility: "hidden"` creates directly addressable
background workers omitted from sidebar organization and unread/pending
favicon attention, with other behavior unchanged; a child thread inherits
its parent's visibility and still notifies that parent; plugins must archive
finished hidden workers when appropriate and call `threads.stop` in a
`finally` block to release each agent runtime promptly);
bb.events.on (observe thread.created/idle/failed/deleted);
bb.http.route (routes under /api/v1/plugins/<id>/http/\* with
local/token/none auth); defineRpcContract + bb.rpc.register (Standard
Schema-validated frontend data plane with inferred backend handlers and
type-only frontend method/input/result inference);
bb.rpc.experimental_registerInternal + bb.rpc.experimental_client (private
server-plugin calls using the same Standard Schema contracts; handlers receive
`{callerPluginId, signal}` from core, and cannot be invoked through public RPC,
HTTP, CLI or agent tools. A saved client belongs to its original plugin
generation. Caller or target disposal aborts the handler signal and rejects
late results; asynchronous validation rechecks both generations before invoking
the handler. A failed call never proves that its effect did not occur);
bb.experimental_threads (durable `prepare`, read-only `getPreparation`, and
`startPrepared` for plugin-owned workers. `prepare` requires an owner-local
operationId, projectId, parentThreadId or null, executionContextId, explicit
title, visibility, turnPolicy, environment, execution tuple and nonempty input.
The explicit tuple includes providerId, model, reasoningLevel, serviceTier and
permissionMode. Core reserves the task ID and canonical request hash before
asynchronous provisioning; identical retries return the same reservation and
changed requests reject. Preparation provisions the existing environment path
without a provider turn or queued first prompt. A named managed base branch
retains existing ref-resolution semantics, not a pinned SHA; use a verified
host-created worktree through an unmanaged path when exact Git source matters.
`startPrepared` requires operationId, expectedRevision and the returned exact
`{hostId, environmentId, path}`. It atomically admits one sealed queue row and
retains that row ID plus the actual clientTurnRequestId after queue consumption.
An identical accepted start is observation only. `turnPolicy: "single"` rejects
additional sends, retries, Send-now, prompt edits, clear and manual compaction;
native provider compaction within the admitted turn is unaffected.
`conversation` allows ordinary continuation after its first dispatch.
Set optional `parentNotification: "owner-controlled"` with a non-null
parentThreadId when the owner admits orchestration. Core records child outcomes
and needs-attention notices as passive, durable `system/operation` events
(`owned_child_notice`) in the parent's history without starting or steering its
provider, including queued notices. Explicit worker-to-parent sends reject and
must go through a separate owner admission. Normal worker transcripts and parent
relationships remain intact. The option is sealed in the reservation; omission
preserves inherited automatic notifications and old request hashes. This does
not itself admit an orchestrator response or count ordinary parent turns.
Stop or deletion retains the reservation tombstone. Owner disposal or a restart with
unfinished effects requires reconciliation; it does not replay provisioning,
setup or a native turn. A new admitted operation may reuse a verified ready
environment. Git verification before release is a preflight, not an atomic
provider-start guarantee. A `started` observation requires persisted native
`turn/input/accepted` matching clientTurnRequestId. For completion, match that
acceptance's turn scope to `turn/completed` through `bb.sdk.threads.events`;
thread status or agent prose alone is insufficient);
bb.experimental_turns (`prepare`, `getPreparation`, `startPrepared`, `interrupt`
admit one owned input in an existing conversation. Preparation requires owner-local
operationId, projectId, threadId, executionContextId, exact environment
`{hostId, environmentId, path}`, the explicit execution tuple and nonempty resolved
input without dynamic mentions. Retry identical immutable requests safely;
changed input under the same operation rejects. Release uses operationId and
expectedRevision and requires an idle conversation without pending interaction.
`prepared_turn_busy` is retryable and leaves the retained preparation unchanged.
The queue is separate from manual messages, cannot be edited, grouped, sent now
or retried outside its owner, and atomically retains the actual client request.
`bb.agents.configure` receives `experimental_turnContext` only for the owner of
that exact admitted input; use its operationId/executionContextId/request identity
to resolve sealed instructions. Existing origin and permanent thread context do
not change. All other callbacks receive null for this transient context.
Interruption before request allocation is terminal cancelled; resume needs a new
admitted operation. Lifecycle loss before allocation may explicitly reconcile
the same operation at its current revision. Once a client request exists it can
never allocate another. Conditional stop matches only that native request and
turn; unknown or lost replies remain needs-reconciliation until native evidence.
`started` requires exact accepted input, and terminal states expose accepted and
terminal event IDs. Manual inputs wait for an active owned input to settle.
Native plugin tools receive `experimental_invocation` with providerThreadId,
turnId, callId and `ownedTurn`. Its ownerPluginId/operationId/executionContextId/
clientTurnRequestId identify any owned input, including another plugin's input.
Null means proven unowned. Missing, stale or ambiguous native mappings reject
before the tool callback; do not treat a retryable attribution error as manual
authorization. Non-native test contexts may omit identity. The fake host accepts
`experimental_preparedTurns` for testing the real owner boundary);
defineRpcContract + bb.hosts.experimental_client (typed calls, typed ephemeral
host signals, and unexpected-worker-exit notifications to the plugin's own
`bb.host` entry; the host context also provides plugin-scoped data/temp paths
and daemon-owned native file watching; active calls and watches retain the
lazy worker automatically, while independent background work can hold an
explicit `experimental_retainWorker()` lease; the host entry uses
experimental_defineHostEntry from
`@get-bb/plugin-sdk/host` and can be unit-tested with
experimental_createHostEntryHarness from
`@get-bb/plugin-sdk/testing/host`);
bb.realtime.publish (ephemeral signals to open app pages);
bb.background.service (long-lived, AbortSignal, restart w/ backoff) and
bb.background.schedule (durable cron rows); bb.cli.register (a top-level
`bb <name>` command agents run through bash, with a shared 1 MiB combined
stdout/stderr ceiling and atomic structured over-limit errors); bb.agents.registerTool
(static native tools with zod or JSON-schema parameters) and
bb.agents.configure (one synchronous per-resolution callback selecting this
plugin's own tool/skill ids and optional dynamic instructions; tools apply on
the next provider session start/resume, while busy skill runtimes defer catalog
changes); bb.ui
registerMentionProvider (host-rendered UI — no
frontend bundle needed); bb.status.needsConfiguration (report
"unconfigured" instead of crashing); bb.onDispose (LIFO cleanup on
reload/disable/shutdown).

Addressed composer work uses `PluginMentionItem.experimental_recipient` with
`{kind: "agent" | "team", entityId, versionId, scopeKey}`. Keep search and
selection read-only. Register one `bb.ui.experimental_registerAddressedDispatch`
handler to receive `{projectId, threadId, operationId, prompt, recipients}` only
after Send and workspace preparation. Core serializes sends per conversation,
rejects conflicting retries, and suppresses an ordinary provider turn. Revalidate
the scope and published revision; retain durable operation identity before side
effects. Return `{runId, status: "started" | "continued", summary, path?}` with
an optional local `/plugins/<your-plugin-id>/...` path. All recipients in one
message must use one coordinator. Scheduled addressed dispatch is unsupported.
`sdk.threads.experimental_retryAddressed({threadId,operationId,senderThreadId?})` recovers a failed
Send from its retained server request, preserving prompt, attachments and pinned
recipients. The timeline Retry action and `bb thread retry-addressed` use this
same method. Successful duplicate retries return the existing run receipt.
Agent SDK callers preserve `senderThreadId` on addressed spawn, send and retry.
Core resolves its persisted execution context and preparation before routing or
receipt replay, rejecting owned workers. Creation accepts `senderThreadId` only
with `experimental_addressing`. Browser-origin guarding remains the public API's
trusted-local-process boundary; it does not authenticate an omitted or falsified
worker identity.

An execution-context owning plugin can return
`PluginAgentConfiguration.experimental_skillSnapshots` from `bb.agents.configure`.
Each immutable snapshot contains `{name, description, files}`; each file uses
`{path, contentBase64, executable}`, including a standard root `SKILL.md`.
The server validates content identity and skill metadata and stages the full tree.
Assigned snapshots override inherited skills with the same name while other
shared skills remain available. Required delivery fails before dispatch if the
provider bridge cannot configure skills or an active runtime has conflicting
contents. Delivery makes skills available; it does not guarantee model invocation
or grant additional tool permissions. Use the exported
`experimental_assignedSkillSnapshotSchema` at external boundaries.

Frontend entries register React slots (homepageSection, settingsSection,
navPanel, threadPanelAction, experimental_newThreadPanelAction, fileOpener,
messageDirective) and composer
customizations via `app.composer.customize({ actions, plusMenu, banners,
richText })`; action/banner components use `useComposer()` and
`useComposerView()`, while the host renders plus-menu rows and editor
decorations. The deprecated pre-1.0 `slots.composerAccessory` footer API was
removed; migrate controls to actions or the plus menu and larger content to
banners. Register all frontend surfaces via
definePluginApp, use the hooks
listed above, and render vendored components; styling is Tailwind against
the host theme's tokens only (semantic classes like bg-background and
tw-animate-css utilities compile in plugin builds).

For the complete authoring reference — exact signatures, working snippets
for every surface, the reload lifecycle, testing tips, and gotchas — use
the built-in `bb-plugin-authoring` skill (agents: it loads on demand;
humans: apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/
in a checkout). The builtin `inline-vis` plugin renders
`::inline-vis{file="demo.html" height="480"}` through the sidebar's
path-shaped, sandboxed worktree HTML iframe preview; `height` is optional.
Its card header includes an open-in-sidebar action for the source HTML file.
The `plugins/` directory contains every bundled plugin: the auto-installed
builtins and the store-only Included with ARC GitHub, Docs, Memory, and Tasks
plugins. The `examples/plugins/` reference plugins cover slack-bot (webhook
bot), agent-enrichment (agent surfaces), and composer-customization (all
composer regions). Thread Hover
Cards installs from the Community marketplace (source: the bb-plugins
repo).

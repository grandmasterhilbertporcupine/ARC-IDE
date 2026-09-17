---
name: agents
description: Read and author ARC agents and teams, inspect immutable revisions and bound sessions, and submit reviewable draft proposals through the `bb` CLI and tools.
---

# ARC agents, teams and runs

## Project Context

The Context tab and `bb arc context rpc <method> --input <json>` call the same
typed SDK surface: `sdk.plugins.callRpc({pluginId:"arc",method,input})`.
`--input-file <absolute-path> --host <id>` and `--output-file` work as for the
other ARC RPC commands. This first text index is a user surface. Agent-thread
queries are refused until execution snapshots bind the appropriate corpus;
do not treat project-only identity as permission to read another worktree.

- `getContextSetup({projectId,hostId:null})` returns registered sources and a
  target `{projectId,hostId,environmentId:null}`. A non-null environment must be
  ready and belong to the same project and host. Callers never choose root paths.
- `reindexContext({target,operationId})` admits a watched background index.
  Retain its operation ID on retry. `getContextStatus({target})` reports actual
  coverage/counts, model readiness and errors; unknown coverage is not complete.
- `listContextSources({target,cursor:null,limit:50})` pages indexed, pending,
  stale, skipped, failed and deleted sources with their reasons. Follow nextCursor.
- `searchContext({target,query,limit:8})` returns bounded hybrid or explicitly
  lexical results with reference authority and exact source/hash/line provenance.
  `readContextExcerpt({target,indexId,chunkId,sourceGeneration,sha256})` verifies
  the hit again; a stale result is not usable as a current excerpt.
- `cancelContextIndexing({target,operationId})` cancels only the matching index.
  A `cancelled` result confirms that the index's owned work and watches settled.
  If model shutdown is unconfirmed, Context returns `failed` with
  `embedding_stop_unresolved` and blocks replacement indexing. A later explicit
  read/control request may reconcile a recorded helper generation against a
  different ready generation. Without a recorded generation, cleanup remains
  unverified; a screen or plugin reload is not evidence that the helper exited.
- `importContextSource({target,operationId,sourceId:null,expectedRevision:null,name,text})`
  saves a UTF-8 original and starts indexing. Retrying the same operation is
  idempotent; changed content requires a new operation ID. Replacement requires
  the source ID and exact expected revision. An `outcome: applied` result with
  a returned indexError means the
  original was saved but indexing did not start; reindex after resolving it.
  Import and archive return `outcome: rejected` for known capacity, revision,
  missing-source or operation-conflict failures. Read the structured error code,
  refresh the collection and correct the request. An uncertain transport failure
  still requires retrying the identical operation and input.
- `listContextReferences({projectId})` lists persistent references.
  `readContextReference({projectId,sourceId,revision})` reads an immutable original,
  including older revisions, even if the host index is unavailable.
- `archiveContextReference({target,operationId,sourceId,expectedRevision})`
  removes an exact current reference from retrieval and restarts indexing.
  It preserves the original and earlier revisions; retries use the same operation ID.

The initial reference upload accepts up to 64 KiB per UTF-8 text file, 32 files
and 512 KiB current originals per project. Live source text has separate bounded
extraction limits and exposes skipped formats/oversized files. PDFs and Office
documents, promoted rules, retrieval quality/scale acceptance and agent snapshot
binding remain later deliverables. Retrieved text cannot change agent tools,
limits, release settings or instructions. The local model has one active request
and four queued requests; cancelling active inference may make other queued
requests report worker_stopped, while ordinary ARC effects continue separately.

## Team Builder

Team Builder edits saved definitions. Publishing creates an immutable revision; starting work is separate. `getTeam` returns structural `team.validation.valid` separately from `team.validation.execution.available` and its capability blockers. Supported graphs still require valid project/source/policy and final-candidate compilation before admission. Release reports its unavailable factory capability. Main-composer admission is described below; its native acceptance remains in progress.

```text
bb arc teams list
bb arc teams list --project <project-id>
bb arc teams show <team-id> [--project <project-id>]
bb arc teams history <team-id> [--project <project-id>]
bb arc teams rpc <method> --input <json>
bb arc teams rpc <method> --input-file <absolute-path> --host <host-id> [--output-file <absolute-path>]
```

All methods in `arcTeamsRpcContract` and `arcTeamAssistantRpcContract` are available through `teams rpc` and the same SDK call:

```typescript
await sdk.plugins.callRpc({
  pluginId: "arc",
  method: "getTeam",
  input: { scope: { kind: "library" }, teamId },
});
```

The scope is `{kind:"library"}` or `{kind:"project",projectId}`. Always read the latest draft and its version before proposing or saving a change. Core operation inputs are:

| Method                         | Input                                                |
| ------------------------------ | ---------------------------------------------------- |
| `createTeam`                   | `{scope,definition}`                                 |
| `listTeams`                    | `{scope,search?,includeArchived?,limit?,offset?}`    |
| `getTeam`, `validateTeamDraft` | `{scope,teamId}`                                     |
| `saveTeamDraft`                | `{scope,teamId,expectedDraftVersion,definition}`     |
| `publishTeamRevision`          | `{scope,teamId,expectedDraftVersion}`                |
| `getTeamRevision`              | `{scope,teamId,revision}`                            |
| `listTeamRevisions`            | `{scope,teamId,limit?,offset?}`                      |
| `restoreTeamRevision`          | `{scope,teamId,expectedDraftVersion,revision}`       |
| `setTeamArchived`              | `{scope,teamId,expectedDraftVersion,archived}`       |
| `copyTeamToProject`            | `{scope:{kind:"library"},teamId,revision,projectId}` |

Drafts retain incomplete task text, unassigned references and unfinished connections with actionable diagnostics. Publishing rejects structural errors. Archived teams retain their histories and must be restored before editing. Copying a library revision atomically copies each distinct pinned agent/revision and its owned reference files once, remaps member references and publishes the project team. Later library edits do not update the project copy.

Version 1 definitions remain byte-compatible. New team organization features use `schemaVersion:2` with `{name,description,leaderMemberId,groups,members,permissions,graph,presentation}`. Members retain `{id,agentId,revision,groupId}` and can add `role`, `responsibility`, `leaderMemberId` (reports to) and pinned `skills`. An empty role inherits the published agent role. The team-level leader is nullable; existing fixed workflows do not need one. Groups have `{id,name,color,parentGroupId}`, with a six-digit hex color and nullable parent. Directed grants have `{id,fromMemberId,toMemberId,action}`, where action is `message`, `delegate` or `review`. Named/color groups and leadership do not create grants, execution dependencies or provider permissions.

The builder edits the team's `name` and optional `presentation.color` (a six-digit hex color; omit for the theme default). A member's optional `modelOverride` is `{providerId,model,reasoningLevel,serviceTier}` with explicit non-null values and `serviceTier:"default"|"fast"`. Use ARC's supported reasoning choices and an available model on the target host. Omit the entire override to inherit the pinned agent's model configuration. Overrides affect only that member in this team; they never edit the reusable agent revision or change its permission mode. Save through `saveTeamDraft` using the latest draft version, then explicitly publish for new runs. Existing run snapshots remain pinned; applying a model change to active work requires operational-rule review, not an instruction-only update.

The Team view edits people and typed relationships; Workflow edits execution order. Drag a published agent from the palette, set its responsibility in the inspector, and connect members using Can message, Can delegate, Can review or Reports to. Reports to points from the reporting member to its leader. Can message can be added in both directions explicitly. Add subagent creates parent-to-child delegation and messages both ways, shown in the definition. The keyboard connection controls provide the same operations. Undo/redo includes member changes, connections and positioning; publishing remains a separate action. Deleting a member leaves their workflow stages visibly unassigned until corrected.

`graph` contains `nodes`, `edges`, `entryNodeIds` and `requiredGates`. Each gate is `{id,mode:"all"|"any",nodeIds}` and requires successful evidence. Nodes have stable IDs and labels. All stage kinds are retained: `agent`, `parallel`, `join`, `check`, `review`, `condition`, `repair`, `approval`, `integration`, `release`, and `delegation`. The graph is a DAG; use an explicit bounded repair stage rather than a connection cycle.

Edges have `{id,source,target,sourceHandle,requiredOutcome}`. Ordinary outputs use `next`; conditions use `true`/`false` and a successful recorded decision. `requiredOutcome` is `succeeded`, `failed` or `completed`; completed means settled success/failure, excluding interrupted/unknown, and is distinct from a native provider completion event. Selected joins identify the controlling `decisionNodeId`; all joins cannot demand mutually exclusive branches. Conditions inspect typed prior outcomes, check exit codes, review verdicts or approval decisions. Do not provide JavaScript or prose predicates.

Candidate references are `{kind:"source"}` or `{kind:"node",nodeId}` for an earlier writing, integration or repair stage. A repair stage retains `checkNodeId`, body `{memberId,task}` and `maxRounds` from one through three. Its `repaired` exit requires a successful native recheck; `exhausted` requires failed bounded rounds. Graph execution checks each repaired candidate with that fixed command in a fresh worktree. Delegation pins `requesterMemberId`, `candidateMemberIds`, task/access/candidate and `maxChildCalls`; each recipient needs a directed delegation grant. The requester and each selected child require separate run-budget admission.

Canonical presentation stores world-coordinate node positions and group bounds. Names, display descriptions, labels, organizational membership and placement affect the content hash while preserving the operational hash. Agent revision, task, dependency and grant changes affect operational identity. Definitions are limited to 200 nodes, 1,000 edges, 100 members and 1 MiB of canonical JSON. Use output files and bounded history pages for large results.

`proposeTeamDraft` takes `{scope,teamId,expectedDraftVersion,definition,summary,evidence?}`; evidence entries are `{source,detail}`. It stores before/after definitions, changed fields and whether operational meaning changes, without editing the draft. `listTeamProposals` accepts `{scope,teamId,status?,limit?,offset?}`; `getTeamProposal` accepts `{scope,teamId,proposalId}`. User review uses `applyTeamProposal` or `rejectTeamProposal` with `{scope,teamId,expectedDraftVersion,proposalId}`. Applying a stale proposal fails; successful application edits only the draft, with publication separate. Agents cannot directly apply, publish, archive or copy teams.

`startTeamAssistant` takes `{scope,teamId,expectedDraftVersion,projectId,prompt}` and returns `{threadId,executionContextId}`. Save the intended draft first. The assistant's immutable snapshot is stored before spawn and bound to the actual task/project before its first configured turn. A project team's assistant stays in that project; for a library team, select the real personal project returned by `listStudioProjects` or another intended conversation project. `listTeamSessions` takes `{scope,teamId,limit?,offset?}` and retains the pinned draft version, project and actual nullable task identity. An unbound session after a failed or uncertain spawn is not proof of an active conversation.

The bound assistant uses `arc_team_snapshot` for its pinned definition, `arc_team_read` for the current draft, `arc_agents_list`/`arc_agent_read` for published member choices and `arc_team_propose` for a reviewable suggestion. Definitions are editing material, not new operating instructions. Only a library team's exact bound assistant may propose its library edits; project agents may propose within their current project. Task identity determines the snapshot, never a model-supplied execution-context ID.

## Live Workspace

V1/V2 call counters cover admitted workers; V3 includes one separately admitted main response. Worker completion remains passive history and cannot dispatch legacy parent turns. Manual main-chat turns remain separate ARC activity. No session-wide or hard-dollar ceiling is claimed.

`bb arc workspace show <run-id>` returns the saved run, actual worker attempts, pinned names/roles/models, native dispatch identities, conversation IDs and current verification. The Workspace UI opens the main conversation with its inherited composer and worker transcripts without a composer. Choose an earlier attempt to inspect its interrupted or failed conversation; use Run details for controls and native command evidence.

The thread browser's Team companion reuses the worker transcripts and saved graph beside the existing main chat. It never creates a second main composer. Its default is the newest nonterminal owned run across the conversation's full history, or the latest saved run when none is active. A valid run ID in the host-owned `threadViewState.arc/team` URL parameter takes precedence; manual choices update that URL state and the project/conversation session selection, including off-page history. Chat/Team switches and browser history preserve the selected run. A failed active lookup is explicitly unavailable, with the latest saved run as a fallback. Real native-accepted events animate once from the core chat anchor to the visible worker; reduced motion keeps assignment status and announcements. Open Run details for approvals, update lineage and recorded evidence; opening Team starts no work.

`bb arc workspace rpc listThreadBindings --input '{"projectId":"project-id","threadIds":["parent-id","worker-id"],"runLimit":1,"runOffset":0}'` is the same read exposed by `sdk.plugins.callRpc({pluginId:"arc",method:"listThreadBindings",input:{projectId,threadIds,runLimit:1,runOffset:0}})`. Request up to 100 exact thread IDs and at most 100 run summaries per batch (`threadIds.length * runLimit`), with `runLimit` between 1 and 20. Each origin includes `runsTotal`, `nextOffset`, a paginated `runs` array, the independent exact `defaultRun`, and `activeLookup`. Worker annotations require a retained effect-to-thread binding; arbitrary child threads are not treated as ARC workers. Names, agent revisions, groups, teams and configured models come from immutable run snapshots. Worker chat counts include admitted conversations, not every planned stage or currently active model call. The read performs no workspace scans, provider calls, preparation or scheduler advancement.

For graph runs, `run.definition.team` and `run.definition.members` retain the published plan and exact agent revisions used by the run. Each worker's nullable `graphNodeId` links its attempt to a declared stage through the compiled origin mapping, including repair rounds and delegated child slots. Fixed V1 runs and unavailable mappings return null. Never split runtime node IDs to infer a stage. The UI's Graph view inspects this saved plan without editing it, searches stages, and opens a selected worker attempt. The latest 100-attempt window is not complete stage history; missing workers do not prove a stage was skipped, unstarted or successful. Laptop Worker overview shows up to four chats with vertical scrolling; the conversation bar selects other workers, and graph navigation does not submit a composer turn.

`bb arc workspace rpc getWorkspace --input <json>` uses `{runId,cursor,eventLimit}`. A null cursor establishes a baseline and returns no historical animation events. Poll with the returned cursor to receive later `admitted`, `prepared` and `native-accepted` milestones; drain `hasMoreEvents` before waiting. The cursor belongs to the exact run and plan. A queued request is not native acceptance. Reconnection should establish a new baseline rather than replay old handoffs.

The same operation is available through `sdk.plugins.callRpc({pluginId:"arc",method:"getWorkspace",input})`. Use the shared `--input-file`, `--host` and `--output-file` options for large responses. Reads are limited to the caller's project in agent contexts. The response reports truncation after the latest 100 worker attempts and includes the total count; full execution records remain in the paged run evidence API. Existing fixed runs have no team snapshot, so membership remains null; publishing a team does not retroactively group their workers.

## Agent Studio

### Built-in Efficient Build team

The Team Builder catalog includes Efficient Build version 1 with Lead, Reader, Builder and Reviewer agents and pinned procedures. First use selects a connected provider/model for each role and an explicit project check `{executable,args,timeoutMs}`. The last successful role selection becomes a global default; a project's saved setup overrides it, and a check command never carries into a different project automatically. The result is an editable published project copy. New template versions never overwrite existing copies.

Use `bb arc templates list` or `bb arc templates rpc <method> --input <json>` with the same `sdk.plugins.callRpc({pluginId:"arc",method,input})` contract. `listTeamTemplates(null)` needs no provider. `getTeamTemplateSetup({templateId:"efficient-build",version:1,projectId})` returns configuration, inherited role defaults, host identity and blockers. `instantiateTeamTemplate({templateId:"efficient-build",version:1,projectId,operationId,configuration:{roles:{lead,reader,builder,reviewer},check}})` validates actual provider/model capabilities, copies pinned agents/skills and publishes the team. Every role uses the agent execution tuple `{providerId,model,reasoningLevel,serviceTier,permissionMode}`. Retry uncertain creation with the identical operation ID and configuration; changed arguments need a new operation ID. Instantiation never starts a run.

The workflow plans, reads, builds, runs the required command, allows at most two repair rounds, and requires an independent review of the final candidate. Git projects integrate the writer candidate; ordinary directories use the existing serial candidate path. Required check/review gates remain present on both direct success and repaired branches. Actual provider usage is reported separately; the template does not promise a savings percentage.

### Assigned skills

Agent schema version 1 stays byte-compatible. For skill assignments use schema version 2 and `skills:[{id,name}]`; IDs are immutable SHA-256 bundle identities returned by ARC. Team members can add the same pinned references; a same-named member assignment takes precedence over the published agent default. Shared and project skills remain available. Changes to skill assignments are operational changes in draft proposals and require review before application.

User-controlled RPCs are available through the same SDK and `bb arc agents rpc` surface:

- `listAssignedSkillCatalog({projectId,environmentId:null})` lists installed skill choices.
- `importInstalledAgentSkill({projectId,environmentId:null,skillId})` copies readable text skill files and rejects changed, truncated or binary inputs. Use direct directory import for binary supporting files.
- `saveAgentSkillBundle({files:[{path,contentBase64,executable}]})` validates and retains an immutable directory. Include `SKILL.md` with YAML `name` and `description`, Markdown instructions and every supporting file. Relative paths, 128 files and 1 MiB per directory are enforced.
- `readAgentSkillBundle({id})` retrieves exact retained contents. Editing and saving creates a new ID; it never mutates published definitions or admitted runs.
- `parseAgentSkillMarkdown({markdown})` returns `fields:{name,description,instructions}` for guided editing; description is the When to use field.
- `renderAgentSkillMarkdown({markdown,fields})` returns updated Markdown while retaining other frontmatter values. An unchanged form preserves the exact original Markdown bytes. Save the result with all retained supporting files using `saveAgentSkillBundle`.

The Skills editor offers Name, When to use and Instructions, a raw Markdown toggle, and supporting text-file add/edit/remove controls. Binary support files retain their exact bytes. Build with assistant saves the current agent/team draft and opens a composed request for the user to send. The bound authoring assistant can read assigned files with `arc_skill_bundle_read({id,path,offset,limit})`, where null path lists the manifest and limit is at most 8192 characters. `arc_skill_bundle_create({baseSkillId,fields,supportingFiles,removePaths})` prepares an immutable unassigned bundle: supporting text entries contain `{path,text,executable}`, and a nullable base preserves all unchanged files. Created bundles stay scoped to that authoring conversation until assigned. The assistant must then use `arc_agent_propose` or `arc_team_propose` to propose the exact returned reference for review; creation never applies, publishes or executes anything. Agent defaults belong in metadata.skills; team-specific additions belong only in the selected member's skills.

Use `--input-file` for directory bundles. Assign the returned `{id,name}` in the agent's draft, save, then publish when ready. The combined runtime selection is bounded to 32 skills and 4 MiB; missing pins and unsupported provider skill configuration block execution visibly. Put activation guidance in the SKILL.md description and role-specific guidance in the agent Markdown. Attachments stay reference material and are not skill assignments.

Use `bb arc agents list` for the personal library, or `bb arc agents list --project <project-id>` for project copies. `bb arc agents show <agent-id>` reads the saved draft and its version. `bb arc agents history <agent-id>` reads published revisions. Add `--project <project-id>` to read a project copy.

Every method in `arcAgentsRpcContract` is available through:

```text
bb arc agents rpc <method> --input <json>
```

The equivalent SDK call is:

```typescript
await sdk.plugins.callRpc({
  pluginId: "arc",
  method: "listAgents",
  input: { scope: { kind: "library" } },
});
```

For multiline JSON or large definitions, place the request in a UTF-8 JSON file on an ARC host and use its absolute path. The command reads through ARC's host API, never the server's local filesystem:

```powershell
bb arc agents rpc createAgent --input-file 'C:\ARC\agent-request.json' --host <host-id>
```

Find host IDs with `bb machine list`. User file commands require `--host`; inside an agent task, ARC derives the host from the task's actual environment and rejects a different explicit host. Files must have absolute host paths. For large JSON results add `--output-file 'C:\ARC\result.json'`; the command writes that file and prints its small file metadata response. ARC caps plugin stdout at 1 MiB, so use output files or small query pages for long revision/proposal histories.

`createAgent` expects `{scope,document}`. A scope is `{kind:"library"}` or `{kind:"project",projectId}`. The document starts with JSON metadata between `---` delimiters, then Markdown. Metadata contains `schemaVersion:1`, `name`, `description`, `specialty`, `role`, and `execution`. Execution contains nullable `providerId`, `model`, `reasoningLevel`, `serviceTier`, and `permissionMode`. Provider and model must be selected together or both null. Null inherits ARC's normal defaults.

Use `getAgent` before changing anything. `saveAgentDraft` requires `{agentId,scope,expectedDraftVersion,document,attachmentIds}`. `publishAgentRevision` requires `{agentId,scope,expectedDraftVersion}`. `copyAgentToProject` requires `{agentId,scope,revision,projectId}` and copies the specified immutable revision, including its references. Later library changes do not update that project copy. `restoreAgentRevision` restores the requested revision as the current published content while preserving previous revisions.

`addAgentAttachment` accepts `{agentId,scope,expectedDraftVersion,name,mimeType,contentBase64}`. Each file is at most 25 MB; each manifest holds at most 32 files and 100 MB. Reusing a filename replaces the draft reference while retaining old revision bytes. `readAgentAttachment` accepts `{agentId,scope,attachmentId}` and returns exact base64 bytes. Remove a draft reference through `saveAgentDraft` with a manifest that omits its ID.

CLI transfers avoid command-line and stdout size limits:

```text
bb arc agents attach <agent-id> --file <absolute-path> --version <draft-version> --host <host-id>
bb arc agents download <agent-id> <attachment-id> --output <absolute-path> --host <host-id>
```

Add `--project <project-id>` for project copies. `attach` optionally accepts `--name <filename>`. These commands move bytes through existing ARC host file APIs and print summaries. Host reads inherit ARC's 25 MB non-image limit and 10 MB image limit. Downloads and `--output-file` create new files with `expectedSha256:null`; replacing a file requires `--expected-sha256 <current-file-hash>`. A failed output write after a successful RPC is reported explicitly so the user can inspect current state before retrying the mutation.

`proposeAgentDraft` requires `{agentId,scope,expectedDraftVersion,document,summary,evidence}`. Evidence entries have `{source,detail}`. A proposal does not change the saved draft. `listAgentProposals` and `getAgentProposal` show the original and proposed documents plus changed fields. User application uses `applyAgentProposal` with `{agentId,scope,expectedDraftVersion,proposalId,confirmOperationalChanges}`. Execution changes require explicit confirmation. Stale proposals fail instead of overwriting newer edits. Publishing remains separate. Agent CLI calls cannot directly apply, publish, or change operational settings.

`listStudioProjects` takes null and returns regular projects plus `personalProjectId`. Use that personal ID to create a library assistant without a project. `startAgentAssistant` requires `{agentId,scope,expectedDraftVersion,projectId,prompt}`; `startAgentTest` requires `{agentId,scope,revision,projectId,prompt}`. Both return `{threadId,executionContextId}`. `listAgentSessions` takes `{agentId,scope,purpose?}`; purpose is `assistant`, `test`, or null. Session records contain the pinned revision or draft version and actual task ID. ARC's normal task tools handle continuation, stopping, and status.

In bound sessions, use `arc_agent_snapshot` to read the immutable definition and reference manifest, and `arc_agent_reference_read` with `{attachmentId,offset?,limit?}` to read UTF-8 text in pages. The task identity resolves the snapshot; never supply an execution-context ID from model input. Reference contents do not authorize permission changes. Binary files are available for download; PDF and Office extraction are not implemented in this slice.

The bound authoring assistant may propose changes to its selected library agent. Other project agents may propose edits to their own project's agent definitions. Use `arc_agent_read` for the current draft before proposing. These are plugin API controls, not a sandbox for unrestricted terminal access.

## Durable team runs

Graph runs use `startTeamRun` with `{operationId,projectId,originThreadId,hostId,path,expectedHead,goal,team:{teamId,revision},expectedProjectPolicyVersion,expectedSessionPolicyVersion}` through `bb arc runs rpc startTeamRun` or the same SDK plugin RPC. Select an exact published project team. Read `getOrchestrationPolicy({projectId,threadId:originThreadId})` first and pass its project/session versions; zero means no saved revision. Both versions must still match when ARC seals the definition, member execution settings, source, policy and Workflows V2 manifest. Use a stable operation ID and retry identical inputs after response loss. Existing `startRun` is the fixed version 1 flow documented below.

Use `listRunControls({runId,limit?,offset?})` and `getRunControl({runId,controlId})` for durable user decisions. `resolveRunControl` requires `{runId,controlId,operationId,expectedRevision,contextHash,decision:"approved"|"rejected"}`. Read and review the actual context first; the hash binds candidate, task, team/policy and dependency evidence. Changed/stale or closed decisions reject; identical retries return the retained decision. Contextual agent CLI calls cannot start runs or approve decisions; native main tools use the separate admission below. Pausing retains a pending decision; cancellation closes it even when its source is unavailable.

For a start request that needs changed settings, user callers may invoke `discardTeamRunRequest` with its exact original `startTeamRun` input. It returns `{state:"reserved",run}` if the matching run exists, or `{state:"discarded",operationId,requestHash}` after permanently retiring the unused request. Only confirmed retirement allows a new operation ID; an in-flight old preflight cannot subsequently reserve it. Retry the same discard after response loss. This never implicitly cancels an existing run and is unavailable to agent callers.

Graph workers and repair attempts receive fresh candidate-derived Git worktrees. V2 serial integration preserves full candidate history; V1 keeps its existing integration behavior. Final successful checks, explicit review and verification must cover the same candidate. Release stages and serial non-Git execution remain unavailable pending their accepted implementation gates.

## Orchestration settings

Use `bb arc policy show|history --project <id> [--thread <id>]`, `policy rpc <method>` or the matching SDK operations. `getOrchestrationPolicy` takes `{projectId,threadId:null|string}`. `listPolicySessions` takes `{projectId,limit,offset}`; `listPolicyRevisions` takes `{projectId,threadId:null|string,limit,offset}`. User writes are `saveProjectPolicy({projectId,expectedVersion,policy})` and `saveSessionPolicy({projectId,threadId,expectedVersion,overrides})`. Writes append immutable versions and reject stale observations. Agents may read settings in their current project but cannot change them.

The project policy is `{schemaVersion:1,autonomy:"guided"|"collaborative"|"autonomous",preferredTeams:[{teamId,revision}],restrictedTeams:null|[{teamId,revision}],limits:{maxConcurrentAgents,maxAgentCalls,maxRepairRounds,maxActiveMs}}`. Team pins must be published and unarchived in that project. Preferred pins must also satisfy any restriction. `[]` preference means none; a null restriction permits any otherwise eligible team, while an empty restriction permits none. Defaults are Collaborative, no preference, unrestricted teams, four concurrent agents, 100 calls, three repair rounds and two active hours.

Session overrides use `autonomy:null|mode` and `limits:null|limits` for inheritance. `preferredTeams` is `{kind:"inherit"}`, `{kind:"none"}` or `{kind:"teams",teams:[pins]}`. `restrictedTeams` is `{kind:"inherit"}`, `{kind:"unrestricted"}` or `{kind:"teams",teams:[pins]}`. Project settings are defaults and an authorized user may explicitly override them. An inherited preference conflicting with a new restriction produces an unresolved-policy error; never silently drop it. Later settings do not mutate a saved run. Reviewed agent instruction-body updates use the continuation below; broader operational-rule updates remain a separate pending gate.

User SDK/CLI can explicitly update active V2/V3/V4 graph instructions. `bb arc runs rpc previewRunInstructionUpdate` takes `{runId,team:{teamId,revision}}` for a newer revision of the same project team. Review its exact changed bodies, affected nodes, source identity and rerun consequence. `applyRunInstructionUpdate({operationId,previewId,previewHash})` pauses and applies that review; `pollRunInstructionUpdate({runId,operationId})` advances the saved operation. `getRunInstructionUpdateState({runId})` reads incoming/outgoing lineage without advancing work. `cancelRunInstructionUpdate({runId,operationId,previewId,previewHash})` retains terminal cancellation even if the original Apply response was lost. Retry identical IDs/hash and preserve cancellation intent across reloads. Once successor admission is sealed, cancellation cannot restore the predecessor. Earlier cancellation leaves a paused predecessor for explicit Resume if pause had begun.

Only agent instruction bodies may change through this path; metadata, references, graph/tasks/checks, authority and policy must remain unchanged, and restrictions must permit the exact new team pin. The whole team reruns from the verified original source in a linked immutable continuation, carrying consumed calls, active time and repair rounds within the same limits. Previous candidates and receipts are historical. Publication alone never changes active work. Worker-context CLI mutation is refused; these decisions belong to the user. Fixed V1 runs and broader configuration changes need separate handling. See `docs/ARC-INSTRUCTION-UPDATES.md` and `docs/ARC-PROGRESS.md` for contracts and actual acceptance.

Operational rules use the separate user-only `previewRunRuleUpdate({runId,team:{teamId,revision},expectedProjectPolicyVersion,expectedSessionPolicyVersion})`. Read current policy versions first. The current team revision supports settings-only changes. No-op and blocked results have no applicable preview. Review a restart preview's exact autonomy, limits, grants, checks/gates, repair ceilings, configured/resolved execution and any simultaneous instruction changes before `applyRunRuleUpdate({operationId,previewId,previewHash})`. `pollRunRuleUpdate({runId,operationId})` advances the retained operation; `cancelRunRuleUpdate({runId,operationId,previewId,previewHash})` retains exact cancellation intent. These share the instruction-update lock and engine. `getRunUpdateState({runId})` reads mixed `{kind,application}` lineage; opening a view starts no Apply. Usage remains cumulative under the reviewed total grant, including disabled/re-enabled repair stages. See `docs/ARC-RULE-UPDATES.md` for supported fields, no-op/blocker semantics and replay.

Review grants run from reviewer to every distinct other contributor in the candidate, preserving earlier serial authors, integrated bases/writers, repairers and every permitted writing-delegation child. Self-review needs no self-grant. Revoking a grant while retaining a graph that needs it blocks publication/application; colors and groups do not supply authority. `getRunReviewAuthority({runId})` returns authorized/invalid/legacy diagnostics from the immutable retained team, separately from a file-proof hash or timestamp. Existing raw receipts remain historical; ungranted new review/verdict/final-completion work is blocked. These grants do not create a filesystem sandbox.

Guided approves each agent assignment and dynamic assignment proposal. Collaborative approves the initial plan and permits declared work within it. Autonomous permits work within sealed bounds. Explicit graph approval stages, grants, required checks, provider permissions and budgets still apply. Pure user/CI waits consume no agent slot and exclude active time only when no native work remains active; dependency and owner reconciliation waits remain charged.

At an admitted delegation point, its bound requester may call `arc_run_delegate({assignments:[{memberId}]})`. ARC derives the requester from the actual task, validates its candidate roster/directed grants/count and retains that ordered proposal. Each chosen child is separately admitted and charged. The requester cannot add graph nodes, change policy or enlarge limits. Passive child updates cause no hidden parent turn.

## Serial non-Git projects

Use `getProjectRunSetup({projectId,hostId:null|string})` to distinguish Git from a plain folder without scanning or starting providers. For a directory, `getDirectoryRunSetup({operationId,projectId,originThreadId,hostId})` starts or polls one saved full-source inspection. Repeat its exact operation while pending. Ready returns `sourceInspectionId` and `source.{rootIdentity,manifestDigest}`; failed returns the named path/error, and consumed returns its saved `runId`.

User `requestDirectoryTeamRun` takes the graph start fields without `expectedHead`, plus `sourceInspectionId` and `expectedSource:{rootIdentity,manifestDigest}`. It seals V4, consumes the inspection atomically with reservation and adds one counted response in the same main conversation. Use `bb arc orchestrator rpc requestDirectoryTeamRun` and the matching SDK. `discardDirectoryRunRequest` retires an exact unused user request; `reconcileOrchestratedRun({runId})` also recovers V4.

User `resolveDirectoryRunControl({runId,controlId,operationId,expectedRevision,contextHash,decision})` verifies and saves a directory approval/rejection. It returns `{state:"checking"|"resolved",control}`; repeat the exact request while checking. Resume a paused run before verifying its decision. The original `resolveRunControl` remains available and reports `validation_pending` while directory evidence is unfinished. Native workers cannot approve decisions.

Native main agents use `arc_directory_source_inspect({hostId,operationId:null})` after context identifies a directory, then poll with its returned operation ID. Request through `arc_directory_team_run_request`; actual core invocation supplies operation/project/thread identity. Finish after admission. Serial copies preserve the original and failed candidates; checks/review cover exact retained snapshots. Links, Git integration, parallel writing and checks that modify candidate files are explicit errors, never silently omitted work. Full contracts, the passed Codex native gate and remaining acceptance are in `docs/ARC-DIRECTORY-RUNTIME.md` and `docs/ARC-PROGRESS.md`.

## Main-composer team requests

Selecting an Agent or Team mention only selects a published recipient. Work begins on Send through `threads.spawn` or `threads.send` with `experimental_addressing:{operationId,recipients}`; the CLI equivalents are `bb thread spawn --addressing-file <path>` and `bb thread tell <id> <message> --addressing-file <path>`. Each recipient pins `{pluginId:"arc",kind:"agent"|"team",entityId,versionId,scopeKey:"library"|"project:<id>",label}`. Reuse the UUID only to retry the same Send. One lead coordinates multiple recipients and returns one admitted main response.

Owned workers cannot use addressed Send or Retry to request another run or a user follow-up, including by targeting a different main conversation. Use the pinned run's `arc_run_message` grants and admitted response slots. SDK agent callers preserve `senderThreadId`; core validates its retained execution context and preparation before routing or replaying an operation. Public HTTP calls remain within the existing trusted-local-process boundary, without per-worker authentication for omitted or falsified context.

Further addressed Sends retain the conversation's cumulative calls, active-time and repair consumption. Up to twelve follow-ups wait in order for the current pass to settle, then continue from its exact verified integration candidate. Changed recipients pin their published definitions and skills on Send; the revised graph retains mandatory verification and supported check-based branch choices on its final candidate. Pause holds the queue, Stop never automatically restarts it, and missing or changed candidate evidence remains an actionable saved request. No follow-up silently restarts from the original project.

If earlier verification depends on approval/release controls, nested conditions or another decision ARC cannot safely replay, changing recipients leaves the follow-up action-required. Cancel that unadmitted follow-up, restore the previous recipient versions and send again to retain the verified candidate, consumed limits and existing gates. Do not remove gates or start an independent run to work around this limitation.

Inspect this queue with `bb arc runs rpc getAddressedFollowups --input '{"projectId":"<id>","threadId":"<id>"}'` or the matching `sdk.plugins.callRpc({pluginId:"arc",method:"getAddressedFollowups",input})`. User-only `retryAddressedFollowup` and `cancelAddressedFollowup` take `{projectId,threadId,operationId,expectedUpdatedAt}` from the current queue entry. A compiled successor can still be cancelled before Workflows consumes its reservation; once admitted, reconcile it and use its run controls. Workspace exposes the same queue, errors and actions. Scheduling addressed messages for later is not supported.

Use `arc_orchestration_context({search?,limit?,offset?})` in the active project's main conversation. It derives project/thread identity, effective policy and exact versions, registered source on that conversation's enrolled host, recent runs and published team candidates. Preferred exact versions appear first, then current unrestricted or exact allowed versions. Preferences are advisory; restrictions are mandatory. Invalid pins and unavailable sources remain explicit errors. Discovery never starts work.

The main agent can call `arc_team_run_request({hostId,path,expectedHead,goal,team:{teamId,revision},expectedProjectPolicyVersion,expectedSessionPolicyVersion})`. Use source and policy versions from context. Core supplies native provider-conversation/turn/tool identity; ARC derives the operation ID and actual project/main conversation. Worker/assistant callers, missing native identity and already owned automatic turns are refused. A cancelled tool call cannot complete preflight and newly admit work. Once admitted, control the saved run through its durable pause/cancel interface.

Direct user SDK/CLI callers use `requestTeamRun` with the same fields as `startTeamRun`, including their own stable `operationId`. This seals ARC definition V3 with one counted same-chat completion. Use `bb arc orchestrator show --project <id> --thread <id>`, `orchestrator rpc requestTeamRun --input <json>` or `sdk.plugins.callRpc({pluginId:"arc",method,input})`; RPC also supports the documented input/output-file flags. `getOrchestratorContext` takes `{projectId,threadId,search?,limit?,offset?}`. User `discardOrchestratedRunRequest` retires the exact unused V3 user request. User `reconcileOrchestratedRun({runId})` retries the retained immutable request, including a native request whose original tool response was lost. Open the saved Runs entry and choose Reconcile saved request; never invent another request to recover it.

V3 preserves V2 graph execution and adds one main completion step in the same Workflows call/concurrency/active-time budget. It uses the originating conversation's exact environment and model tuple, independently of worker defaults. Required native evidence must settle before release. The completion reports success or deterministic required-gate failure; it cannot satisfy a check/review gate. Exhausted limits, pause/cancel and uncertain native work do not trigger extra provider work. Automatic completion may propose follow-up work but cannot use ARC's native admission tool to reset budgets. Additional autonomous rounds belong to a separately bounded Factory episode, not this slice.

Contextual CLI and native tool restrictions do not sandbox inherited provider shell/network access. Direct user SDK/HTTP calls retain ARC's trusted-local-user boundary. Actual native V3 acceptance and unresolved gates are recorded in `docs/ARC-PROGRESS.md`.

## Fixed version 1 runs

Use the Runs UI or `bb arc runs` for the first runtime flow. It uses the existing Workflows scheduler. `runs list --project <id>` lists retained requests; `runs show <run-id>` shows the pinned definition and current workflow state. `runs rpc <method> --input <json>` and `--input-file <absolute-path> --host <id>` call the same typed operations as `sdk.plugins.callRpc({pluginId:"arc",method,input})`. Use `--output-file` for complete definitions and command receipts that exceed the CLI stdout limit.

`getRunSetup` takes `{projectId,hostId:null}` (or a selected host ID) and returns registered checkouts, the selected native Git HEAD/clean status and up to 50 main conversations. `startRun` requires `{operationId,projectId,originThreadId,hostId,path,expectedHead,goal,writers,reviewer,repairer,check}`. Each writer has `{agent:{agentId,revision},task}`; reviewer and repairer each have `{agentId,revision}`. All agents must be published project agents. `check` is `{executable,args,timeoutMs}` and executes directly in the integrated worktree, with no implicit shell. Quote or pass arguments as separate array entries, never embed an entire shell command in `executable`.

The start seals the exact source commit, full published definitions and resolved provider settings. Use a stable operation ID and retry the identical request after an uncertain response; changing a saved request requires a new operation ID. A retry retains its original snapshots and cannot silently adopt newer revisions. Native dispatch uses run-owned detached Git worktrees. Required writer completion, serial integration, native checks, at most three check-repair rounds, an explicit reviewer verdict and unchanged final candidate gate completion. The default limits are four active agents, 100 provider calls and two hours of charged active work. A review rejection stops the run; automated review repair is not part of this initial path.

`getRun` takes `{runId}` and returns historical workflow state alongside current candidate `verification` (`pending`, `current`, `stale` or `unavailable`). A later candidate change does not rewrite the historical outcome; it invalidates current verification. `listRuns` takes `{projectId,offset?,limit?}`. `listRunEffects` takes `{runId,offset?,limit?}`; `getRunEffect` takes `{runId,effectId}` and returns the actual resource and retained observation/receipt. Host receipts include command arguments, exit status, bounded output and full output digests, timestamps and source states. Failed, interrupted, stale and uncertain evidence are distinct from success.

`controlRun` takes `{runId,operationId,expectedVersion,action}`; action is `pause`, `resume` or `cancel`, and expectedVersion is the current workflow controlVersion. Retry a lost control response with the same operation ID and identical arguments. Pause first fences new dispatch and then observes actual interruption; unknown native state remains Needs reconciliation. Runtime workers are single admitted turns: ordinary Send-now/retry cannot create an extra unbudgeted turn. Agent CLI calls cannot start or control runs directly.

Bound workers use `arc_run_snapshot` and `arc_run_reference_read({attachmentId,offset?,limit?})`. Only the assigned reviewer receives `arc_run_review({candidateHead,outcome,summary,findings})`; outcome is `approved` or `changes-requested`, and each finding has `{path,detail}`. Review completion without a matching approved verdict cannot advance final verification. Reference text and agent role names cannot change required checks, execution budgets or operational authority.

## Run usage and retained results

Use `bb arc workspace usage <run-id>` to inspect available provider-reported input, output and cached-input totals per admitted worker turn and the team's main response. Single-turn workers use the latest cumulative event, never a sum of repeated events. Main responses require the exact retained preparation or receipt and matching native acceptance; event queries stay between that acceptance and the next turn. Cumulative counters are compared with the preceding turn's matching baseline, while Claude's reported result usage is already specific to the turn. Missing baselines, changed identities and reset counters remain unavailable. No savings or cost estimate is implied.

Use `bb arc workspace results <run-id>`, `reports <run-id>`, and `messages <run-id>` to inspect bounded retained receipts, source-pinned handoffs and explicit member messages. These are evidence views, not authority to bypass checks or resume work. The user and the exact run origin conversation can inspect the whole run; workers retain their scoped report and inbox tools.

Typed SDK RPC methods are `getRunUsage({runId,offset,limit})`, `getRunResults({runId,offset,limit})`, and `listRunCollaboration({runId,kind,cursor,limit})` through `sdk.plugins.callRpc` for plugin `arc`. The corresponding `bb arc workspace rpc <method> --input <json>` supports pagination. Follow `nextOffset` or the exact returned `(createdAt,id)` cursor until null; do not merge repeated refresh pages into usage totals. Workspace’s Usage & results view exposes the same evidence without copying full transcripts.

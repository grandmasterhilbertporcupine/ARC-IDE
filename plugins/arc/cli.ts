import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import path from "node:path";
import { arcAgentsRpcContract, type AgentScope } from "./contract.js";
import { type AgentActor, type ArcAgentService } from "./service.js";
import { arcRunsRpcContract } from "./runtime/contract.js";
import type { ArcRunService } from "./runtime/service.js";
import { arcWorkspaceRpcContract } from "./workspace/contract.js";
import type { ArcWorkspaceService } from "./workspace/service.js";
import {
  arcTeamsRpcContract,
  arcTeamAssistantRpcContract,
} from "./teams/contract.js";
import type { ArcTeamService } from "./teams/service.js";
import type { TeamAssistantService } from "./teams/assistant.js";
import { arcPolicyRpcContract } from "./policy/contract.js";
import type { PolicyService } from "./policy/service.js";
import type { OrchestratorService } from "./orchestrator/service.js";
import { arcOrchestratorRpcContract } from "./orchestrator/contract.js";
import { arcContextRpcContract } from "./context/contract.js";
import type { ArcContextService } from "./context/service.js";
import { arcTemplatesRpcContract } from "./templates/contract.js";
import type { ArcTemplateService } from "./templates/service.js";

const HELP = `Usage: bb arc <agents|teams|templates|runs|workspace|policy|orchestrator|context> <command>

Templates:
  templates list                      List bundled versioned teams
  templates rpc <method> --input <json>
Template methods: ${Object.keys(arcTemplatesRpcContract).join(", ")}
Use getTeamTemplateSetup to inspect saved role models and project checks, then
instantiateTeamTemplate with a stable operationId to create editable copies.

  list [--project <id>]                 List library or project agents
  show <id> [--project <id>]            Show an agent and its persistent draft
  history <id> [--project <id>]         Show immutable published revisions
  rpc <method> --input <json>           Call any typed Agent Studio method
  rpc <method> --input-file <path> --host <id> [--output-file <path>]
  attach <id> --file <path> --version <n> --host <id> [--project <id>]
  download <id> <file-id> --output <path> --host <id> [--project <id>]

Library scope is the default. All commands return JSON. RPC input uses the
same contract as sdk.plugins.callRpc({ pluginId: "arc", ... }).
Methods: ${Object.keys(arcAgentsRpcContract).join(", ")}

Runtime:
  runs list --project <id>              List the project's retained runs
  runs show <run-id>                    Inspect one run and its workflow state
  runs rpc <method> --input <json>      Start, inspect or control a run
  runs rpc <method> --input-file <path> --host <id> [--output-file <path>]
Runtime methods: ${Object.keys(arcRunsRpcContract).join(", ")}
Starts use a stable operationId. Retrying the same request reconciles it;
changing its contents requires a new operationId. Controls require the
current controlVersion and their own operationId. Runtime workers cannot
change run configuration through these commands.

Instruction updates:
  runs rpc previewRunInstructionUpdate  Review a newer published team revision
  runs rpc applyRunInstructionUpdate    Pause and apply the exact reviewed change
  runs rpc pollRunInstructionUpdate     Continue the saved operation
  runs rpc cancelRunInstructionUpdate   Cancel the exact reviewed operation
  runs rpc getRunInstructionUpdateState Inspect predecessor/successor links
  runs rpc previewRunRuleUpdate        Review saved policy, checks and permissions
  runs rpc applyRunRuleUpdate          Pause and apply the exact reviewed rules
  runs rpc pollRunRuleUpdate           Continue the saved rule operation
  runs rpc cancelRunRuleUpdate         Cancel the exact reviewed rule operation
  runs rpc getRunUpdateState           Inspect instruction/rule update lineage
  runs rpc getRunReviewAuthority       Inspect retained review permissions
Publishing never changes active work. Applying reruns the team from the verified
original source in a linked run, carrying consumed calls, active time and repair
rounds forward within the same limits. Retain operationId, previewId and previewHash
when retrying Apply or Cancel. Status reads never advance an update.

Workspace:
  workspace show <run-id>               Inspect the saved graph, workers and chats
  workspace usage <run-id>              Read available cumulative worker tokens
  workspace results <run-id>            Read retained change/check/review receipts
  workspace reports <run-id>            Read source-pinned handoff reports
  workspace messages <run-id>           Read bounded team messages
  workspace rpc getRunUsage --input '{"runId":"…","offset":0,"limit":20}'
  workspace rpc getRunResults --input '{"runId":"…","offset":0,"limit":20}'
  workspace rpc listRunCollaboration --input '{"runId":"…","kind":"reports","cursor":null,"limit":10}'
  Follow nextOffset or nextCursor for additional pages. Usage is provider-reported;
  unavailable fields are not zero. Repeated cumulative events are never added.
  workspace rpc listThreadBindings --input '{"projectId":"…","threadIds":["…"],"runLimit":20,"runOffset":0}'
                                       Read exact run and worker bindings for up to 100 threads
  workspace rpc getWorkspace --input <json>
  workspace rpc getWorkspace --input-file <path> --host <id> [--output-file <path>]
Workspace methods: ${Object.keys(arcWorkspaceRpcContract).join(", ")}
A null cursor establishes the current activity baseline. Pass the returned
cursor to get later observed milestones; drain hasMoreEvents before polling.

Teams:
  teams list [--project <id>]          List versioned teams
  teams show <team-id> [--project <id>] Inspect a draft and validation
  teams history <team-id> [--project <id>] Inspect published revisions
  teams rpc <method> --input <json>
  teams rpc <method> --input-file <path> --host <id> [--output-file <path>]
Team methods: ${Object.keys(arcTeamsRpcContract).join(", ")}, ${Object.keys(arcTeamAssistantRpcContract).join(", ")}
Draft changes require expectedDraftVersion. Publishing pins agent revisions.
Project copies include exact agent definitions and references. Structural
validation and execution availability are separate; unsupported graphs cannot run.

Orchestration settings:
  policy show --project <id> [--thread <id>]
  policy history --project <id> [--thread <id>]
  policy rpc <method> --input <json>
  policy rpc <method> --input-file <path> --host <id> [--output-file <path>]
Policy methods: ${Object.keys(arcPolicyRpcContract).join(", ")}
Writes require expectedVersion and user authority. Session settings distinguish
inheritance from explicit no preference. New runs seal the resolved settings;
existing runs retain their original policy. A changed version requires review.

Main orchestrator:
  orchestrator show --project <id> --thread <id>
  orchestrator rpc <method> --input <json>
  orchestrator rpc <method> --input-file <path> --host <id> [--output-file <path>]
Methods: ${Object.keys(arcOrchestratorRpcContract).join(", ")}
requestTeamRun accepts the same input as runs.startTeamRun and additionally
admits one counted completion response in the main conversation. A direct user
call must retain its operationId when retrying. Agent CLI mutation is refused;
the main agent uses arc_team_run_request with authoritative native identity.
The automatic response cannot create another run and reset its limits.

Project folders:
  runs rpc getProjectRunSetup          Identify the selected Git or folder source
  runs rpc getDirectoryRunSetup        Start/poll one saved folder inspection
  runs rpc resolveDirectoryRunControl  Verify and save one exact folder decision
  orchestrator rpc requestDirectoryTeamRun
  orchestrator rpc discardDirectoryRunRequest
Use the exact sourceInspectionId, rootIdentity and manifestDigest returned by
the inspection. Directory runs execute serially in retained copies, include
one counted main response, and use the same run controls. Inspections retain
their operationId across retries. Links, parallel stages and changed check
inputs are explicit errors. See the agents skill for complete request fields.

Project Context:
  context rpc <method> --input <json>
  context rpc <method> --input-file <path> --host <id> [--output-file <path>]
Methods: ${Object.keys(arcContextRpcContract).join(", ")}
Use getContextSetup to select a registered project source. Index and query
methods take target {projectId,hostId,environmentId}; null environmentId selects
the registered checkout. Import stores a persistent UTF-8 reference and starts
indexing. Retain operationId for retries. Source replacements also require
sourceId and expectedRevision. Index failures do not discard imported originals.
All hits remain references; they cannot change agent instructions or permissions.
Agent-thread Context access is unavailable until execution snapshots are bound.

File paths must be absolute on the chosen ARC host. In an agent task, the
current environment supplies its host; an explicit different host is refused.
Downloads and --output-file create new files. To replace an existing file,
pass --expected-sha256 <current-hash>. Large results should use --output-file
or download, because ARC limits plugin CLI stdout to 1 MiB.

When invoked inside an agent thread, direct mutation commands are refused.
Use proposeAgentDraft for a reviewable draft proposal in the current project.`;

function actorFromContext(context: PluginCliContext): AgentActor {
  if (context.threadId) {
    if (!context.projectId)
      throw new Error("Agent CLI calls require their project context");
    return {
      kind: "agent",
      threadId: context.threadId,
      projectId: context.projectId,
    };
  }
  return { kind: "user" };
}

function options(
  argv: string[],
  allowed: readonly string[],
): { values: string[]; flags: Map<string, string> } {
  const values: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      values.push(item);
      continue;
    }
    if (!allowed.includes(item) || flags.has(item))
      throw new Error(`Unknown or duplicate option ${item}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${item} requires a value`);
    flags.set(item, value);
  }
  return { values, flags };
}

function absoluteFile(value: string | undefined): string {
  if (
    !value ||
    value.includes("\0") ||
    (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))
  )
    throw new Error("Specify an absolute file path on the selected host");
  return value;
}

export function registerArcCli(
  bb: BbPluginApi,
  service: ArcAgentService,
  runs: ArcRunService,
  workspace: ArcWorkspaceService,
  teams: ArcTeamService,
  teamAssistants: TeamAssistantService,
  policy: PolicyService,
  orchestrator: OrchestratorService,
  arcContext: ArcContextService,
  templates: ArcTemplateService,
): void {
  const teamService = {
    call(method: string, input: unknown, actor: AgentActor): Promise<unknown> {
      return Object.hasOwn(arcTeamAssistantRpcContract, method)
        ? teamAssistants.call(method, input, actor)
        : teams.call(method, input, actor);
    },
  };
  async function fileHost(
    flags: Map<string, string>,
    context: PluginCliContext,
  ): Promise<string> {
    const requestedHost = flags.get("--host");
    if (!context.threadId) {
      if (!requestedHost)
        throw new Error(
          "File operations require --host <id>; use bb machine list to choose the host containing the file",
        );
      return requestedHost;
    }
    const thread = await bb.sdk.threads.get({ threadId: context.threadId });
    if (thread.projectId !== context.projectId || !thread.environmentId)
      throw new Error("The current task has no matching file environment");
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (requestedHost && requestedHost !== environment.hostId)
      throw new Error("Agent file operations must use the current task's host");
    return environment.hostId;
  }

  async function writeOutput(
    hostId: string,
    file: string,
    content: string,
    contentEncoding: "utf8" | "base64",
    flags: Map<string, string>,
  ) {
    const expectedSha256 = flags.get("--expected-sha256") ?? null;
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/iu.test(expectedSha256))
      throw new Error(
        "--expected-sha256 must be the existing file's SHA-256 hash",
      );
    return bb.sdk.files.write({
      hostId,
      path: file,
      content,
      contentEncoding,
      expectedSha256,
    });
  }

  bb.cli.register({
    name: "arc",
    summary: "ARC agents, teams, live workspaces and durable runs",
    commands: [
      {
        name: "templates",
        summary: "Choose bundled teams and create editable project copies",
        usage: "bb arc templates <list|rpc> [arguments]",
      },
      {
        name: "context",
        summary:
          "Index project files, retain references and search exact source excerpts",
        usage: "bb arc context rpc <method> --input <json>",
      },
      {
        name: "orchestrator",
        summary:
          "Discover eligible teams and request one bounded run with a main-chat response",
        usage: "bb arc orchestrator <show|rpc> [arguments]",
      },
      {
        name: "policy",
        summary:
          "Set project and session autonomy, team choices and execution limits",
        usage: "bb arc policy <show|history|rpc> [arguments]",
      },
      {
        name: "teams",
        summary:
          "Author teams, graphs, revisions, project copies and assistant proposals",
        usage: "bb arc teams <list|show|history|rpc> [arguments]",
      },
      {
        name: "workspace",
        summary: "Inspect live run conversations and recorded handoffs",
        usage: "bb arc workspace <show|rpc> [arguments]",
      },
      {
        name: "runs",
        summary: "Start, inspect and control durable ARC team runs",
        usage: "bb arc runs <list|show|rpc> [arguments]",
      },
      {
        name: "agents",
        summary:
          "Manage library and project agents, revisions, files, proposals, and sessions",
        usage:
          "bb arc agents <list|show|history|rpc|attach|download> [arguments]",
      },
    ],
    async run(argv, context) {
      if (argv.length === 0 || argv.includes("--help") || argv.includes("-h"))
        return { exitCode: 0, stdout: HELP };
      try {
        const [area, command, ...rest] = argv;
        if (
          area !== "agents" &&
          area !== "templates" &&
          area !== "teams" &&
          area !== "runs" &&
          area !== "policy" &&
          area !== "orchestrator" &&
          area !== "context" &&
          area !== "workspace"
        )
          throw new Error(
            "Expected 'agents', 'teams', 'runs', 'workspace', 'policy', 'orchestrator' or 'context'; run bb arc --help",
          );
        if (area === "context" && command !== "rpc")
          throw new Error(
            "Use bb arc context rpc <method>; run bb arc context --help for methods",
          );
        const actor = actorFromContext(context);
        const selectedService =
          area === "templates"
            ? templates
            : area === "context"
              ? {
                  call: (method: string, input: unknown, actor: AgentActor) =>
                    arcContext.call(method, input, actor, context.signal),
                }
              : area === "orchestrator"
                ? orchestrator
                : area === "policy"
                  ? policy
                  : area === "runs"
                    ? runs
                    : area === "workspace"
                      ? workspace
                      : area === "teams"
                        ? teamService
                        : service;
        let method: string;
        let input: unknown;
        if (area === "templates" && command === "list" && rest.length === 0) {
          method = "listTeamTemplates";
          input = null;
        } else if (command === "rpc") {
          const { values, flags } = options(rest, [
            "--input",
            "--input-file",
            "--output-file",
            "--host",
            "--expected-sha256",
          ]);
          if (
            values.length !== 1 ||
            flags.has("--input") === flags.has("--input-file")
          )
            throw new Error(
              "Use rpc <method> with exactly one of --input <json> or --input-file <absolute-path>",
            );
          method = values[0];
          if (flags.has("--expected-sha256") && !flags.has("--output-file"))
            throw new Error("--expected-sha256 requires --output-file");
          if (
            flags.has("--host") &&
            !flags.has("--input-file") &&
            !flags.has("--output-file")
          )
            throw new Error("--host requires a file operation");
          if (flags.has("--output-file"))
            absoluteFile(flags.get("--output-file"));
          const expectedOutputHash = flags.get("--expected-sha256");
          if (
            expectedOutputHash !== undefined &&
            !/^[a-f0-9]{64}$/iu.test(expectedOutputHash)
          )
            throw new Error(
              "--expected-sha256 must be the existing file's SHA-256 hash",
            );
          let hostId: string | null = null;
          if (flags.has("--input-file") || flags.has("--output-file"))
            hostId = await fileHost(flags, context);
          if (flags.has("--input-file")) {
            if (!hostId) throw new Error("File host is required");
            const file = await bb.sdk.files.read({
              hostId,
              path: absoluteFile(flags.get("--input-file")),
              signal: context.signal,
            });
            if (file.contentEncoding !== "utf8")
              throw new Error("RPC input file must contain UTF-8 JSON");
            input = JSON.parse(file.content.replace(/^\uFEFF/u, ""));
          } else input = JSON.parse(flags.get("--input") ?? "");
          const output = await selectedService.call(method, input, actor);
          if (flags.has("--output-file")) {
            if (!hostId) throw new Error("File host is required");
            try {
              const written = await writeOutput(
                hostId,
                absoluteFile(flags.get("--output-file")),
                JSON.stringify(output, null, 2),
                "utf8",
                flags,
              );
              return { exitCode: 0, stdout: JSON.stringify(written, null, 2) };
            } catch (error) {
              throw new Error(
                `RPC ${method} completed, but its output file could not be saved: ${error instanceof Error ? error.message : String(error)}. Read the current state before retrying this operation.`,
              );
            }
          }
          return { exitCode: 0, stdout: JSON.stringify(output, null, 2) };
        } else if (area === "orchestrator") {
          const { values, flags } = options(rest, ["--project", "--thread"]);
          if (
            command !== "show" ||
            values.length !== 0 ||
            !flags.has("--project") ||
            !flags.has("--thread")
          )
            throw new Error(
              "Use orchestrator show --project <id> --thread <id>, or orchestrator rpc <method>",
            );
          method = "getOrchestratorContext";
          input = {
            projectId: flags.get("--project"),
            threadId: flags.get("--thread"),
          };
        } else if (area === "policy") {
          const { values, flags } = options(rest, ["--project", "--thread"]);
          if (
            values.length !== 0 ||
            !flags.has("--project") ||
            (command !== "show" && command !== "history")
          )
            throw new Error(
              "Use policy show|history --project <id> [--thread <id>] or policy rpc <method>",
            );
          method =
            command === "show"
              ? "getOrchestrationPolicy"
              : "listPolicyRevisions";
          input = {
            projectId: flags.get("--project"),
            threadId: flags.get("--thread") ?? null,
            ...(command === "history" ? { limit: 50, offset: 0 } : {}),
          };
        } else if (area === "teams") {
          const { values, flags } = options(rest, ["--project"]);
          const scope: AgentScope = flags.has("--project")
            ? { kind: "project", projectId: flags.get("--project") ?? "" }
            : { kind: "library" };
          if (command === "list" && values.length === 0) {
            method = "listTeams";
            input = { scope };
          } else if (
            (command === "show" || command === "history") &&
            values.length === 1
          ) {
            method = command === "show" ? "getTeam" : "listTeamRevisions";
            input = { teamId: values[0], scope };
          } else
            throw new Error(
              "Use teams list, teams show <id>, teams history <id>, or teams rpc <method>",
            );
        } else if (area === "workspace") {
          if (
            !["show", "usage", "results", "reports", "messages"].includes(
              command,
            ) ||
            rest.length !== 1 ||
            rest[0].startsWith("--")
          )
            throw new Error(
              "Use workspace show <run-id> or workspace rpc getWorkspace",
            );
          method =
            command === "usage"
              ? "getRunUsage"
              : command === "results"
                ? "getRunResults"
                : command === "reports" || command === "messages"
                  ? "listRunCollaboration"
                  : "getWorkspace";
          input =
            command === "reports" || command === "messages"
              ? { runId: rest[0], kind: command }
              : { runId: rest[0] };
        } else if (area === "runs") {
          const { values, flags } = options(rest, ["--project"]);
          if (
            command === "list" &&
            values.length === 0 &&
            flags.has("--project")
          ) {
            method = "listRuns";
            input = { projectId: flags.get("--project") };
          } else if (
            command === "show" &&
            values.length === 1 &&
            flags.size === 0
          ) {
            method = "getRun";
            input = { runId: values[0] };
          } else
            throw new Error(
              "Use runs list --project <id>, runs show <run-id>, or runs rpc <method>",
            );
        } else if (command === "attach" || command === "download") {
          const { values, flags } = options(
            rest,
            command === "attach"
              ? ["--file", "--version", "--host", "--project", "--name"]
              : ["--output", "--host", "--project", "--expected-sha256"],
          );
          if (values.length !== (command === "attach" ? 1 : 2))
            throw new Error("Invalid file command; use bb arc --help");
          const scope: AgentScope = flags.has("--project")
            ? { kind: "project", projectId: flags.get("--project") ?? "" }
            : { kind: "library" };
          const hostId = await fileHost(flags, context);
          if (command === "attach") {
            if (actor.kind !== "user")
              throw new Error(
                "Agent reference-file mutations require user review",
              );
            const filePath = absoluteFile(flags.get("--file"));
            const file = await bb.sdk.files.read({
              hostId,
              path: filePath,
              signal: context.signal,
            });
            const contentBase64 =
              file.contentEncoding === "base64"
                ? file.content
                : Buffer.from(file.content, "utf8").toString("base64");
            const { agent } =
              arcAgentsRpcContract.addAgentAttachment.output.parse(
                await service.call(
                  "addAgentAttachment",
                  {
                    agentId: values[0],
                    scope,
                    expectedDraftVersion: Number(flags.get("--version")),
                    name:
                      flags.get("--name") ??
                      path.win32.basename(path.posix.basename(filePath)),
                    mimeType: file.mimeType ?? "application/octet-stream",
                    contentBase64,
                  },
                  actor,
                ),
              );
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                {
                  agentId: agent.id,
                  draftVersion: agent.draft.version,
                  attachments: agent.draft.attachments,
                },
                null,
                2,
              ),
            };
          }
          const output = arcAgentsRpcContract.readAgentAttachment.output.parse(
            await service.call(
              "readAgentAttachment",
              { agentId: values[0], scope, attachmentId: values[1] },
              actor,
            ),
          );
          const written = await writeOutput(
            hostId,
            absoluteFile(flags.get("--output")),
            output.contentBase64,
            "base64",
            flags,
          );
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              { attachment: output.attachment, file: written },
              null,
              2,
            ),
          };
        } else {
          const projectIndex = rest.indexOf("--project");
          const scope: AgentScope =
            projectIndex === -1
              ? { kind: "library" }
              : { kind: "project", projectId: rest[projectIndex + 1] ?? "" };
          if (scope.kind === "project" && !scope.projectId)
            throw new Error("--project requires a project ID");
          const values =
            projectIndex === -1
              ? rest
              : rest.filter(
                  (_, index) =>
                    index !== projectIndex && index !== projectIndex + 1,
                );
          if (values.some((value) => value.startsWith("--")))
            throw new Error("Unknown argument; run bb arc --help");
          if (command === "list" && values.length === 0) {
            method = "listAgents";
            input = { scope };
          } else if (
            (command === "show" || command === "history") &&
            values.length === 1
          ) {
            method = command === "show" ? "getAgent" : "listAgentRevisions";
            input = { agentId: values[0], scope };
          } else {
            throw new Error("Invalid command or arguments; run bb arc --help");
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            await selectedService.call(method, input, actor),
            null,
            2,
          ),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

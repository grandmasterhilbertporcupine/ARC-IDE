import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type { AgentStore } from "../data.js";
import { AgentStoreError } from "../data.js";
import type { AgentActor } from "../service.js";
import type { TeamStore } from "../teams/data.js";
import type { PolicyService } from "../policy/service.js";
import type { ArcRunService } from "../runtime/service.js";
import { runtimeHash } from "../runtime/hash.js";
import { createOrchestratorContext } from "./context.js";
import {
  arcOrchestratorRpcContract,
  orchestratorToolRequestSchema,
  directoryToolRequestSchema,
  directoryToolInspectionSchema,
} from "./contract.js";

export function createOrchestratorService(
  bb: BbPluginApi,
  agents: AgentStore,
  teams: TeamStore,
  policy: PolicyService,
  runs: ArcRunService,
) {
  const context = createOrchestratorContext(bb, agents, teams, policy, runs);
  const requireUser = (actor: AgentActor) => {
    if (actor.kind !== "user")
      throw new AgentStoreError(
        "approval_required",
        "Use the native team request tool in the main conversation. Agent-context CLI calls cannot request or reconcile an automatic run.",
      );
  };
  function nativeRequest(ctx: PluginAgentToolContext) {
    ctx.signal.throwIfAborted();
    const invocation = ctx.experimental_invocation;
    if (!invocation)
      throw new AgentStoreError(
        "invocation_required",
        "Team admission requires a current native main-conversation tool call. Refresh its context and retry from the main composer.",
      );
    if (invocation.ownedTurn !== null)
      throw new AgentStoreError(
        "episode_boundary",
        "This is already an automatically admitted turn. Report its result and propose follow-up work; it cannot start an independent run with fresh limits.",
      );
    const identity = {
      providerThreadId: invocation.providerThreadId,
      turnId: invocation.turnId,
      callId: invocation.callId,
    };
    const scope = { projectId: ctx.projectId, originThreadId: ctx.threadId };
    return {
      ...scope,
      operationId: `main_${runtimeHash({ ...scope, invocation: identity })}`,
      invocation: identity,
    };
  }
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<typeof arcOrchestratorRpcContract> {
    return {
      requestDirectoryTeamRun(input) {
        requireUser(actor);
        return runs.startDirectoryRun({ ...input, invocation: null });
      },
      discardDirectoryRunRequest(input) {
        requireUser(actor);
        return runs.discardOrchestratedRunRequest({
          ...input,
          invocation: null,
        });
      },
      reconcileOrchestratedRun(input) {
        requireUser(actor);
        return runs.reconcileOrchestratedRun(input.runId);
      },
      getOrchestratorContext: (input) => context(input, actor),
      requestTeamRun(input) {
        requireUser(actor);
        return runs.startOrchestratedRun({ ...input, invocation: null });
      },
      discardOrchestratedRunRequest(input) {
        requireUser(actor);
        return runs.discardOrchestratedRunRequest({
          ...input,
          invocation: null,
        });
      },
    };
  }
  return {
    handlers,
    async requestFromTool(input: unknown, ctx: PluginAgentToolContext) {
      const request = nativeRequest(ctx);
      const selected = orchestratorToolRequestSchema.parse(input);
      return runs.startOrchestratedRun({ ...selected, ...request }, ctx.signal);
    },
    async requestDirectoryFromTool(
      input: unknown,
      ctx: PluginAgentToolContext,
    ) {
      const request = nativeRequest(ctx);
      const selected = directoryToolRequestSchema.parse(input);
      return runs.startDirectoryRun({ ...selected, ...request }, ctx.signal);
    },
    async inspectDirectoryFromTool(
      input: unknown,
      ctx: PluginAgentToolContext,
    ) {
      const request = nativeRequest(ctx);
      const selected = directoryToolInspectionSchema.parse(input);
      return runs.inspectDirectory(
        {
          operationId: selected.operationId ?? request.operationId,
          projectId: ctx.projectId,
          originThreadId: ctx.threadId,
          hostId: selected.hostId,
        },
        { kind: "agent", projectId: ctx.projectId, threadId: ctx.threadId },
        ctx.signal,
      );
    },
    async call(method: string, input: unknown, actor: AgentActor) {
      const api = handlers(actor);
      switch (method) {
        case "requestDirectoryTeamRun":
          return api.requestDirectoryTeamRun(
            arcOrchestratorRpcContract.requestDirectoryTeamRun.input.parse(
              input,
            ),
          );
        case "discardDirectoryRunRequest":
          return api.discardDirectoryRunRequest(
            arcOrchestratorRpcContract.discardDirectoryRunRequest.input.parse(
              input,
            ),
          );
        case "reconcileOrchestratedRun":
          return api.reconcileOrchestratedRun(
            arcOrchestratorRpcContract.reconcileOrchestratedRun.input.parse(
              input,
            ),
          );
        case "getOrchestratorContext":
          return api.getOrchestratorContext(
            arcOrchestratorRpcContract.getOrchestratorContext.input.parse(
              input,
            ),
          );
        case "requestTeamRun":
          return api.requestTeamRun(
            arcOrchestratorRpcContract.requestTeamRun.input.parse(input),
          );
        case "discardOrchestratedRunRequest":
          return api.discardOrchestratedRunRequest(
            arcOrchestratorRpcContract.discardOrchestratedRunRequest.input.parse(
              input,
            ),
          );
        default:
          throw new AgentStoreError(
            "unknown_method",
            `Unknown ARC orchestration method: ${method}`,
          );
      }
    },
  };
}

export type OrchestratorService = ReturnType<typeof createOrchestratorService>;

import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import type { AgentActor } from "../service.js";
import { runtimeNodeKey } from "./compiler.js";
import type { ArcRunStore } from "./data.js";
import { graphRuntimeReceiptSchema } from "./graph-receipt.js";
import { directoryRuntimeReceiptSchema } from "./directory-receipt.js";
import { orchestratorReceiptSchema } from "./orchestrated-receipt.js";
import type { OrchestratorRuntimeNode } from "./orchestrated-contract.js";
import {
  arcRunUsageRpcContract,
  resultReceiptSchema,
  usageWorkerSchema,
  type RunResultReceipt,
  type RunUsageWorker,
  type RunDialogueState,
} from "./usage-contract.js";

type Effect = ReturnType<ArcRunStore["effect"]>;
type UsageEvent = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
>[number];
export function cumulativeWorkerUsage(
  events: UsageEvent[],
  threadId: string,
  turnId: string,
) {
  const event = events
    .filter(
      (value) =>
        value.threadId === threadId &&
        value.type === "thread/tokenUsage/updated" &&
        value.scope.kind === "turn" &&
        value.scope.turnId === turnId,
    )
    .sort((a, b) => b.seq - a.seq)[0];
  if (!event || event.type !== "thread/tokenUsage/updated") return null;
  const total = event.data.tokenUsage.total;
  const available = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  return {
    inputTokens: available(total.inputTokens),
    outputTokens: available(total.outputTokens),
    cachedInputTokens: available(total.cachedInputTokens),
  };
}

export function projectRunReceipt(
  effect: Effect,
  directory: boolean,
): RunResultReceipt {
  const observation = effect.observation;
  const result: RunResultReceipt = {
    effectId: effect.effectId,
    nodeId: effect.request.nodeId,
    state: observation?.state ?? "admitted",
    validity:
      observation && "validity" in observation
        ? observation.validity.state
        : null,
    reason: observation && "reason" in observation ? observation.reason : null,
    changes: null,
    checks: [],
    checksTruncated: false,
    review: null,
    artifact: null,
  };
  if (!observation || !("receipt" in observation)) return result;
  const mainReceipt = orchestratorReceiptSchema.safeParse(observation.receipt);
  if (mainReceipt.success) {
    result.reason =
      mainReceipt.data.kind === "orchestrator"
        ? `Main conversation response ${mainReceipt.data.terminalStatus}`
        : (mainReceipt.data.reason ??
          `Main conversation preparation ${mainReceipt.data.state}`);
    return resultReceiptSchema.parse(result);
  }
  const receipt = directory
    ? directoryRuntimeReceiptSchema.parse(observation.receipt)
    : graphRuntimeReceiptSchema.parse(observation.receipt);
  if (!("kind" in receipt)) return result;
  if (
    receipt.kind === "preparation" ||
    receipt.kind === "directory-preparation"
  ) {
    result.reason = receipt.reason;
    return result;
  }
  if (receipt.kind === "native" || receipt.kind === "directory-native") {
    result.reason = receipt.receipt.reason;
    const processes = receipt.receipt.processes;
    result.checks = processes.slice(0, 20).map((process) => ({
      command: [process.executable, ...process.args].join(" ").slice(0, 2000),
      exitCode: process.exitCode,
      interrupted: process.interrupted,
      truncated: process.truncated,
    }));
    result.checksTruncated = processes.length > 20;
    if (receipt.kind === "native") {
      const before = receipt.receipt.before,
        after = receipt.receipt.after;
      if (before && after)
        result.changes =
          before.contentDigest === after.contentDigest
            ? "No content change recorded by this operation"
            : "Workspace content changed between this operation’s snapshots";
      const artifact = receipt.receipt.artifact;
      if (artifact.workspacePath || artifact.commitSha || artifact.treeSha)
        result.artifact = {
          path: artifact.workspacePath,
          identity: artifact.commitSha ?? artifact.treeSha,
        };
    } else {
      const before = receipt.receipt.before,
        after = receipt.receipt.after;
      if (before && after)
        result.changes =
          before.manifestDigest === after.manifestDigest
            ? "No folder change recorded by this operation"
            : "Folder contents changed between this operation’s snapshots";
      if (receipt.candidate)
        result.artifact = {
          path: receipt.candidate.workspace.path,
          identity: receipt.candidate.manifestDigest,
        };
    }
  } else {
    result.review = receipt.review
      ? {
          outcome: receipt.review.outcome,
          summary: receipt.review.summary,
          findings: receipt.review.findings.length,
        }
      : null;
    if (receipt.kind === "agent") {
      result.changes = receipt.workspace.clean
        ? "Clean workspace recorded after the worker turn"
        : "Uncommitted workspace changes recorded after the worker turn";
      result.artifact = {
        path: receipt.workspace.path,
        identity: receipt.workspace.head,
      };
    } else {
      result.changes = receipt.observed
        ? `Recorded folder manifest ${receipt.observed.manifestDigest}`
        : null;
      result.artifact = {
        path: receipt.snapshot.workspace.path,
        identity: receipt.snapshot.manifestDigest,
      };
    }
  }
  return resultReceiptSchema.parse(result);
}

export function createArcRunUsageService(bb: BbPluginApi, store: ArcRunStore) {
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });
  async function dialogue(
    retained: ReturnType<ArcRunStore["get"]>,
  ): Promise<RunDialogueState> {
    const checkpoints = retained.compiled.workflow.steps
      .filter((step) => {
        const node = retained.compiled.nodes[runtimeNodeKey(step)];
        return (
          node.kind === "control" && node.operation.type === "message-response"
        );
      })
      .map(({ nodeId, iteration }) => ({ nodeId, iteration }));
    const counts = store.collaboration.dialogueState(
      retained.summary.runId,
      checkpoints,
    );
    const result: RunDialogueState = {
      ...counts,
      remainingAgentCalls: null,
      remainingActiveMs: null,
      state: counts.unansweredQuestions === 0 ? "answered" : "unavailable",
      nextAction:
        counts.unansweredQuestions === 0
          ? "No unanswered questions are currently retained."
          : "Inspect run state before deciding how to address the retained questions.",
    };
    if (!counts.unansweredQuestions) return result;
    if (retained.summary.workflowRunId === null) return result;
    try {
      const { run } = await workflows.call("inspectOwnedRun", {
        workflowRunId: retained.summary.workflowRunId,
      });
      if (
        run.ownerRunId !== retained.summary.runId ||
        run.projectId !== retained.summary.projectId
      )
        throw new AgentStoreError(
          "scope_denied",
          "Dialogue evidence belongs to a different run",
        );
      result.remainingAgentCalls = Math.max(
        0,
        run.limits.maxAgentCalls - run.agentCalls,
      );
      result.remainingActiveMs = Math.max(
        0,
        run.limits.maxActiveMs - run.chargedActiveMs,
      );
      if (result.remainingAgentCalls === 0 || result.remainingActiveMs === 0) {
        result.state = "limits-exhausted";
        result.nextAction =
          "Shared run limits are exhausted. Review the unanswered questions and request a separate follow-up; no additional response is promised.";
      } else if (
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          run.state,
        ) ||
        (counts.remainingCheckpoints === 0 && run.activeAgents === 0)
      ) {
        result.state = "no-further-checkpoint";
        result.nextAction =
          "No further response checkpoint is available in this run. Review the unanswered questions and request a separate follow-up.";
      } else {
        result.state = "pending-work";
        result.nextAction =
          "Unanswered questions remain. An active turn or a later eligible checkpoint may reply within the shared limits; completion is not guaranteed.";
      }
    } catch (error) {
      if (error instanceof AgentStoreError) throw error;
    }
    return result;
  }
  async function scope(runId: string, actor: AgentActor) {
    const retained = store.get(runId);
    const request = retained.compiled.definition.request;
    if (
      actor.kind === "agent" &&
      (actor.projectId !== request.projectId ||
        actor.threadId !== request.originThreadId)
    )
      throw new AgentStoreError(
        "scope_denied",
        "Run usage and results are available to the user and this run’s main conversation",
      );
    await bb.sdk.projects.get({ projectId: request.projectId });
    return retained;
  }
  async function workerUsage(
    effect: Effect,
    retained: ReturnType<ArcRunStore["get"]>,
  ): Promise<RunUsageWorker | null> {
    const node = retained.compiled.nodes[runtimeNodeKey(effect.request)];
    if (node.kind === "orchestrator") return mainUsage(effect, node, retained);
    if (node.kind !== "agent") return null;
    const result: RunUsageWorker = {
      effectId: effect.effectId,
      threadId: effect.threadId,
      name: node.agent.definition.metadata.name,
      role:
        (retained.compiled.definition.schemaVersion !== 1 && "memberId" in node
          ? retained.compiled.definition.team.definition.members.find(
              (member) => member.id === node.memberId,
            )?.role
          : null) || node.agent.definition.metadata.role,
      purpose: node.purpose,
      providerId: node.agent.execution.providerId,
      model: node.agent.execution.model,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reason: null,
    };
    if (!effect.threadId) {
      result.reason = "Worker conversation has not been created";
      return result;
    }
    try {
      const thread = await bb.sdk.threads.get({ threadId: effect.threadId });
      if (
        thread.projectId !== retained.summary.projectId ||
        thread.experimental_executionContextId !== effect.executionContextId
      )
        throw new AgentStoreError(
          "scope_denied",
          "Usage does not match the admitted worker conversation",
        );
      const accepted = await bb.sdk.threads.events.list({
        threadId: effect.threadId,
        types: ["turn/input/accepted"],
        order: "asc",
        limit: "2",
      });
      const event = accepted[0];
      if (
        accepted.length !== 1 ||
        !event ||
        event.threadId !== effect.threadId ||
        event.type !== "turn/input/accepted" ||
        event.scope.kind !== "turn"
      ) {
        result.reason = "Usage requires one identifiable admitted worker turn";
        return result;
      }
      const resource =
        effect.observation && "resource" in effect.observation
          ? effect.observation.resource
          : null;
      const requestId =
        resource?.kind === "agent"
          ? resource.turnRequestId
          : (
              await bb.experimental_threads.getPreparation({
                operationId: effect.effectId,
              })
            )?.dispatch?.clientTurnRequestId;
      if (!requestId || event.data.clientRequestId !== requestId) {
        result.reason =
          "Usage cannot be attributed to the admitted worker turn";
        return result;
      }
      const events = await bb.sdk.threads.events.list({
        threadId: effect.threadId,
        types: ["thread/tokenUsage/updated"],
        order: "desc",
        limit: "1",
      });
      const usage = cumulativeWorkerUsage(
        events,
        effect.threadId,
        event.scope.turnId,
      );
      if (usage) Object.assign(result, usage);
      else
        result.reason = "Provider has not reported token usage for this turn";
    } catch (failure) {
      if (failure instanceof AgentStoreError) throw failure;
      result.reason = "Provider usage is currently unavailable";
    }
    return usageWorkerSchema.parse(result);
  }
  async function mainUsage(
    effect: Effect,
    node: OrchestratorRuntimeNode,
    retained: ReturnType<ArcRunStore["get"]>,
  ): Promise<RunUsageWorker> {
    const threadId = node.completion.threadId;
    const result: RunUsageWorker = {
      effectId: effect.effectId,
      threadId,
      name: "Main conversation",
      role: "Team lead",
      purpose: node.purpose,
      providerId: node.completion.execution.providerId,
      model: node.completion.execution.model,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reason:
        "Main response usage is unavailable until its exact admitted turn is retained",
    };
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        thread.projectId !== retained.summary.projectId ||
        threadId !== retained.compiled.definition.request.originThreadId ||
        (effect.threadId !== null && effect.threadId !== threadId)
      )
        throw new AgentStoreError(
          "scope_denied",
          "Usage does not match the admitted main conversation",
        );
      const receipt = orchestratorReceiptSchema.safeParse(
        effect.observation && "receipt" in effect.observation
          ? effect.observation.receipt
          : null,
      );
      let identity: {
        turnRequestId: string;
        turnId: string;
        acceptedEventId: string;
        providerThreadId: string;
      };
      if (receipt.success) {
        if (
          receipt.data.operationId !== effect.effectId ||
          receipt.data.threadId !== threadId ||
          receipt.data.executionContextId !== effect.executionContextId ||
          (receipt.data.kind === "orchestrator" &&
            receipt.data.definitionHash !== effect.request.definitionHash)
        )
          throw new AgentStoreError(
            "scope_denied",
            "Main usage receipt belongs to another admitted effect",
          );
        if (receipt.data.kind === "orchestrator-preparation") {
          result.reason =
            receipt.data.reason ??
            `Main response preparation ${receipt.data.state} before a provider turn`;
          return result;
        }
        identity = receipt.data;
      } else {
        const preparation = await bb.experimental_turns.getPreparation({
          operationId: effect.effectId,
        });
        if (!preparation) return result;
        if (
          preparation.operationId !== effect.effectId ||
          preparation.threadId !== threadId ||
          preparation.executionContextId !== effect.executionContextId ||
          preparation.environment.hostId !==
            node.completion.environment.hostId ||
          preparation.environment.environmentId !==
            node.completion.environment.environmentId ||
          preparation.environment.path !== node.completion.environment.path
        )
          throw new AgentStoreError(
            "scope_denied",
            "Main usage preparation belongs to another admitted effect",
          );
        if (!preparation.turn || !preparation.dispatch?.clientTurnRequestId)
          return result;
        identity = {
          ...preparation.turn,
          turnRequestId: preparation.dispatch.clientTurnRequestId,
        };
      }
      const accepted = await bb.sdk.threads.events.list({
        threadId,
        types: ["turn/input/accepted"],
        order: "desc",
        limit: "100",
      });
      const event = accepted.find(
        (value) => value.id === identity.acceptedEventId,
      );
      if (
        !event ||
        event.type !== "turn/input/accepted" ||
        event.threadId !== threadId ||
        event.scope.kind !== "turn" ||
        event.scope.turnId !== identity.turnId ||
        event.data.providerThreadId !== identity.providerThreadId ||
        event.data.clientRequestId !== identity.turnRequestId
      ) {
        result.reason =
          "The exact accepted main response is unavailable within the bounded event history";
        return result;
      }
      const next = accepted
        .filter((value) => value.seq > event.seq)
        .sort((a, b) => a.seq - b.seq)[0];
      const previous = accepted
        .filter((value) => value.seq < event.seq)
        .sort((a, b) => b.seq - a.seq)[0];
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        afterSeq: String(event.seq),
        ...(next ? { beforeSeq: String(next.seq) } : {}),
        order: "desc",
        limit: "100",
      });
      const latest = events.find(
        (value) =>
          value.type === "thread/tokenUsage/updated" &&
          value.threadId === threadId &&
          value.scope.kind === "turn" &&
          value.scope.turnId === identity.turnId &&
          value.data.providerThreadId === identity.providerThreadId,
      );
      if (!latest || latest.type !== "thread/tokenUsage/updated") {
        result.reason =
          "Provider has not reported token usage for this main response";
        return result;
      }
      if (result.providerId === "claude-code") {
        const last = latest.data.tokenUsage.last;
        const available = (value: number) =>
          Number.isFinite(value) && value >= 0 ? value : null;
        result.inputTokens = available(last.inputTokens);
        result.outputTokens = available(last.outputTokens);
        result.cachedInputTokens = available(last.cachedInputTokens);
        result.reason = null;
        return usageWorkerSchema.parse(result);
      }
      const [baseline] = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        beforeSeq: String(event.seq),
        order: "desc",
        limit: "1",
      });
      if (
        !previous ||
        previous.type !== "turn/input/accepted" ||
        previous.scope.kind !== "turn" ||
        previous.data.providerThreadId !== identity.providerThreadId ||
        !baseline ||
        baseline.type !== "thread/tokenUsage/updated" ||
        baseline.threadId !== threadId ||
        baseline.scope.kind !== "turn" ||
        baseline.scope.turnId !== previous.scope.turnId ||
        baseline.data.providerThreadId !== identity.providerThreadId ||
        baseline.seq <= previous.seq
      ) {
        result.reason =
          "The preceding turn has no matching cumulative usage baseline; main response totals are unavailable";
        return result;
      }
      const total = latest.data.tokenUsage.total;
      const before = baseline.data.tokenUsage.total;
      const difference = (current: number, prior: number) =>
        Number.isFinite(current) &&
        Number.isFinite(prior) &&
        prior >= 0 &&
        current >= prior
          ? current - prior
          : null;
      result.inputTokens = difference(total.inputTokens, before.inputTokens);
      result.outputTokens = difference(total.outputTokens, before.outputTokens);
      result.cachedInputTokens = difference(
        total.cachedInputTokens,
        before.cachedInputTokens,
      );
      result.reason =
        result.inputTokens === null ||
        result.outputTokens === null ||
        result.cachedInputTokens === null
          ? "Some cumulative provider counters were missing or reset; those totals are unavailable"
          : null;
    } catch (failure) {
      if (failure instanceof AgentStoreError) throw failure;
      result.reason = "Provider usage is currently unavailable";
    }
    return usageWorkerSchema.parse(result);
  }
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<typeof arcRunUsageRpcContract> {
    return {
      async getRunUsage(input) {
        const retained = await scope(input.runId, actor);
        const page = store.listEffectIds(
          input.runId,
          input.limit,
          input.offset,
        );
        const workers: RunUsageWorker[] = [];
        for (let offset = 0; offset < page.ids.length; offset += 4) {
          const batch = await Promise.all(
            page.ids
              .slice(offset, offset + 4)
              .map((id) => workerUsage(store.effect(id), retained)),
          );
          for (const worker of batch) if (worker) workers.push(worker);
        }
        return {
          workers,
          effectsTotal: page.total,
          nextOffset:
            input.offset + page.ids.length < page.total
              ? input.offset + page.ids.length
              : null,
        };
      },
      async getRunResults(input) {
        const retained = await scope(input.runId, actor);
        const page = store.listEffectIds(
          input.runId,
          input.limit,
          input.offset,
        );
        return {
          dialogue: await dialogue(retained),
          receipts: page.ids.map((id) =>
            projectRunReceipt(
              store.effect(id),
              retained.compiled.definition.schemaVersion === 4,
            ),
          ),
          effectsTotal: page.total,
          nextOffset:
            input.offset + page.ids.length < page.total
              ? input.offset + page.ids.length
              : null,
        };
      },
      async listRunCollaboration(input) {
        await scope(input.runId, actor);
        if (input.kind === "reports") {
          const page = store.collaboration.reportsPage(
            input.runId,
            input.cursor,
            input.limit,
          );
          return {
            reports: page.items,
            messages: [],
            nextCursor: page.nextCursor,
          };
        }
        const page = store.collaboration.messagesPage(
          input.runId,
          input.cursor,
          input.limit,
        );
        return {
          reports: [],
          messages: page.items,
          nextCursor: page.nextCursor,
        };
      },
    };
  }
  return {
    handlers,
    async call(method: string, input: unknown, actor: AgentActor) {
      const api = handlers(actor);
      if (method === "getRunUsage")
        return api.getRunUsage(
          arcRunUsageRpcContract.getRunUsage.input.parse(input),
        );
      if (method === "getRunResults")
        return api.getRunResults(
          arcRunUsageRpcContract.getRunResults.input.parse(input),
        );
      if (method === "listRunCollaboration")
        return api.listRunCollaboration(
          arcRunUsageRpcContract.listRunCollaboration.input.parse(input),
        );
      throw new AgentStoreError(
        "unknown_method",
        `Unknown usage method: ${method}`,
      );
    },
  };
}

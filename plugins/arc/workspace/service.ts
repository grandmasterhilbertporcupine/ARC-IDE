import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createArcRunUsageService } from "../runtime/usage-service.js";
import { arcRunUsageRpcContract } from "../runtime/usage-contract.js";
import { AgentStoreError } from "../data.js";
import { runtimeNodeKey } from "../runtime/compiler.js";
import type {
  RetainedCompiledRun,
  RetainedRuntimeNode as RuntimeNode,
} from "../runtime/compiled.js";
import { runEffectViewSchema } from "../runtime/contract.js";
import type { ArcRunStore } from "../runtime/data.js";
import { runtimeReceiptSchema } from "../runtime/receipt.js";
import { directoryRuntimeReceiptSchema } from "../runtime/directory-receipt.js";
import type { ArcRunService } from "../runtime/service.js";
import type { AgentActor } from "../service.js";
import { createArcThreadBrowserService } from "../threads/service.js";
import {
  arcWorkspaceRpcContract,
  workspaceViewSchema,
  type ArcWorkspaceView,
  type ArcWorkspaceWorker,
} from "./contract.js";

type Effect = ReturnType<ArcRunStore["effect"]>;
type WorkerNode = Extract<RuntimeNode, { kind: "agent" }>;
type WorkspaceEvent = ArcWorkspaceView["events"][number];

export function createArcWorkspaceService(
  bb: BbPluginApi,
  store: ArcRunStore,
  runs: Pick<ArcRunService, "handlers">,
) {
  const browser = createArcThreadBrowserService(bb, store);
  const usage = createArcRunUsageService(bb, store);
  async function projectWorker(
    effect: Effect,
    node: WorkerNode,
    compiled: RetainedCompiledRun,
  ) {
    const observation = effect.observation;
    const resource =
      observation !== null &&
      "resource" in observation &&
      observation.resource?.kind === "agent"
        ? observation.resource
        : null;
    if (
      resource !== null &&
      (resource.threadId !== effect.threadId ||
        resource.executionContextId !== effect.executionContextId)
    )
      throw new AgentStoreError(
        "effect_conflict",
        "The observed resource belongs to a different worker",
      );
    const definition = compiled.definition;
    const member =
      definition.schemaVersion !== 1 && "memberId" in node
        ? definition.team.definition.members.find(
            (member) => member.id === node.memberId,
          )
        : null;
    const group =
      definition.schemaVersion !== 1 && member?.groupId
        ? (definition.team.definition.groups.find(
            (group) => group.id === member.groupId,
          ) ?? null)
        : null;
    const worker: ArcWorkspaceWorker = {
      effectId: effect.effectId,
      nodeId: effect.request.nodeId,
      graphNodeId:
        "references" in compiled
          ? (compiled.references.origins[runtimeNodeKey(effect.request)]
              ?.graphNodeId ?? null)
          : null,
      iteration: effect.request.iteration,
      attempt: effect.request.attempt,
      createdAt: effect.createdAt,
      state: "admitted",
      threadId: effect.threadId,
      executionContextId: effect.executionContextId,
      environmentId: resource?.environmentId ?? null,
      turnRequestId: resource?.turnRequestId ?? null,
      name: node.agent.definition.metadata.name,
      role: node.agent.definition.metadata.role,
      purpose: node.purpose,
      execution: {
        providerId: node.agent.execution.providerId,
        model: node.agent.execution.model,
      },
      task: node.task,
      agentId: node.agent.definition.agentId,
      revision: node.agent.definition.revision,
      group,
      dispatchKey: null,
      reason: null,
    };
    let prepared = false;
    let accepted = false;
    const terminal = observation !== null && "receipt" in observation;
    if (terminal) {
      const receipt =
        definition.schemaVersion === 4
          ? directoryRuntimeReceiptSchema.parse(observation.receipt)
          : runtimeReceiptSchema.parse(observation.receipt);
      if (
        !("kind" in receipt) ||
        (receipt.kind !== "agent" &&
          receipt.kind !== "preparation" &&
          receipt.kind !== "directory-agent" &&
          receipt.kind !== "directory-preparation")
      )
        throw new AgentStoreError(
          "effect_conflict",
          "An agent attempt contains a host receipt",
        );
      if (
        receipt.threadId !== effect.threadId ||
        ((receipt.kind === "agent" || receipt.kind === "directory-agent") &&
          (receipt.executionContextId !== effect.executionContextId ||
            receipt.turnRequestId !== resource?.turnRequestId ||
            receipt.definitionHash !== effect.request.definitionHash))
      )
        throw new AgentStoreError(
          "effect_conflict",
          "The worker receipt does not match its admitted identity",
        );
      worker.state = observation.state;
      if (receipt.kind === "agent" || receipt.kind === "directory-agent") {
        accepted = true;
        prepared = true;
      } else worker.reason = receipt.reason;
      if (observation.validity.state !== "current")
        worker.reason = observation.validity.reason;
    } else if (effect.threadId !== null) {
      try {
        const preparation = await bb.experimental_threads.getPreparation({
          operationId: effect.effectId,
        });
        if (preparation === null) {
          worker.state = "needs-reconciliation";
          worker.reason =
            "The retained worker has no available preparation record";
        } else if (
          preparation.operationId !== effect.effectId ||
          preparation.threadId !== effect.threadId
        ) {
          throw new AgentStoreError(
            "scope_denied",
            "The preparation belongs to a different worker",
          );
        } else {
          worker.environmentId =
            preparation.environment?.environmentId ?? worker.environmentId;
          worker.turnRequestId =
            preparation.dispatch?.clientTurnRequestId ?? worker.turnRequestId;
          prepared = ["prepared", "start-requested", "started"].includes(
            preparation.state,
          );
          worker.state =
            preparation.state === "prepared"
              ? "prepared"
              : preparation.state === "start-requested" ||
                  preparation.state === "started"
                ? "dispatch-requested"
                : preparation.state === "failed" ||
                    preparation.state === "cancelled" ||
                    preparation.state === "needs-reconciliation"
                  ? "needs-reconciliation"
                  : "preparing";
          worker.reason = preparation.reason;
          if (
            (preparation.state === "failed" ||
              preparation.state === "cancelled") &&
            preparation.dispatch?.clientTurnRequestId == null
          ) {
            worker.state =
              preparation.state === "failed" ? "failed" : "interrupted";
          }
          if (worker.turnRequestId !== null) {
            const events = await bb.sdk.threads.events.list({
              threadId: effect.threadId,
              types: ["turn/input/accepted"],
              order: "asc",
              limit: "200",
            });
            accepted = events.some(
              (event) =>
                event.type === "turn/input/accepted" &&
                event.threadId === effect.threadId &&
                event.scope.kind === "turn" &&
                event.data.clientRequestId === worker.turnRequestId,
            );
            if (accepted) {
              prepared = true;
              if (worker.state !== "needs-reconciliation")
                worker.state = "native-accepted";
            }
          }
        }
      } catch (error) {
        if (error instanceof AgentStoreError) throw error;
        worker.state = "unavailable";
        worker.reason = error instanceof Error ? error.message : String(error);
      }
    } else if (effect.workerBinding !== null) worker.state = "preparing";
    if (
      !terminal &&
      observation?.state === "needs-reconciliation" &&
      worker.state !== "failed" &&
      worker.state !== "interrupted"
    ) {
      worker.state = "needs-reconciliation";
      worker.reason = observation.reason;
    }
    if (accepted && worker.turnRequestId !== null)
      worker.dispatchKey = `${effect.effectId}:native-accepted:${worker.turnRequestId}`;
    const events: WorkspaceEvent[] = [];
    for (const milestone of [
      "admitted",
      "prepared",
      "native-accepted",
    ] as const) {
      if (milestone === "prepared" && !prepared) continue;
      if (milestone === "native-accepted" && worker.dispatchKey === null)
        continue;
      const key =
        milestone === "native-accepted"
          ? worker.dispatchKey
          : `${effect.effectId}:${milestone}`;
      if (key === null) continue;
      events.push({
        key,
        effectId: effect.effectId,
        milestone,
        threadId: worker.threadId,
        turnRequestId:
          milestone === "native-accepted" ? worker.turnRequestId : null,
      });
    }
    return { worker, events };
  }

  async function origin(
    threadId: string,
    projectId: string,
  ): Promise<ArcWorkspaceView["origin"]> {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      return { threadId, title: null, providerId: null, model: null };
    }
    if (thread.projectId !== projectId)
      throw new AgentStoreError(
        "scope_denied",
        "The orchestrator belongs to another project",
      );
    return {
      threadId,
      title: thread.title,
      providerId: thread.providerId,
      model: null,
    };
  }

  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<typeof arcWorkspaceRpcContract> {
    return {
      ...browser.handlers(actor),
      ...usage.handlers(actor),
      async getWorkspace(input) {
        const retained = store.get(input.runId);
        if (
          actor.kind === "agent" &&
          actor.projectId !== retained.summary.projectId
        )
          throw new AgentStoreError(
            "scope_denied",
            "This workspace belongs to another project",
          );
        if (
          input.cursor !== null &&
          (input.cursor.runId !== input.runId ||
            input.cursor.planHash !== retained.summary.planHash)
        )
          throw new AgentStoreError(
            "cursor_mismatch",
            "Refresh the workspace before following a different run",
          );
        const page = store.workspaceEffects(input.runId);
        const projected: Awaited<ReturnType<typeof projectWorker>>[] = [];
        for (let offset = 0; offset < page.workers.length; offset += 4) {
          const batch = await Promise.all(
            page.workers.slice(offset, offset + 4).map((effect) => {
              const node =
                retained.compiled.nodes[runtimeNodeKey(effect.request)];
              if (node.kind !== "agent")
                throw new AgentStoreError(
                  "effect_conflict",
                  "The worker no longer matches its sealed plan",
                );
              return projectWorker(effect, node, retained.compiled);
            }),
          );
          projected.push(...batch);
        }
        const workers = projected.map(({ worker }) => worker);
        const allEvents = [...projected]
          .reverse()
          .flatMap(({ events }) => events);
        const validKeys = new Set(
          workers.flatMap((worker) => {
            const prefix = `${worker.effectId}:native-accepted:`;
            const acceptedKey =
              worker.turnRequestId === null
                ? input.cursor?.seenKeys.find((key) => key.startsWith(prefix))
                : `${prefix}${worker.turnRequestId}`;
            return [
              `${worker.effectId}:admitted`,
              `${worker.effectId}:prepared`,
              ...(acceptedKey === undefined ? [] : [acceptedKey]),
            ];
          }),
        );
        const seen = new Set(
          input.cursor?.seenKeys.filter((key) => validKeys.has(key)) ??
            allEvents.map(({ key }) => key),
        );
        const pending = allEvents.filter(({ key }) => !seen.has(key));
        const events = pending.slice(0, input.eventLimit);
        for (const { key } of events) seen.add(key);
        const [run, parent] = await Promise.all([
          runs.handlers(actor).getRun({ runId: input.runId }),
          origin(
            retained.compiled.definition.request.originThreadId,
            retained.summary.projectId,
          ),
        ]);
        return workspaceViewSchema.parse({
          run,
          origin: parent,
          workers,
          workersTotal: page.workersTotal,
          workersTruncated: page.workersTotal > workers.length,
          effects: page.effects.map((effect) =>
            runEffectViewSchema.parse({
              effectId: effect.effectId,
              nodeId: effect.request.nodeId,
              iteration: effect.request.iteration,
              attempt: effect.request.attempt,
              createdAt: effect.createdAt,
              state: effect.observation?.state ?? "admitted",
              resource:
                effect.observation !== null && "resource" in effect.observation
                  ? effect.observation.resource
                  : effect.threadId === null
                    ? null
                    : {
                        kind: "agent",
                        threadId: effect.threadId,
                        executionContextId: effect.executionContextId,
                        environmentId: null,
                        turnRequestId: null,
                      },
            }),
          ),
          effectsTotal: page.effectsTotal,
          events,
          cursor: {
            runId: input.runId,
            planHash: retained.summary.planHash,
            seenKeys: [...seen],
          },
          hasMoreEvents: pending.length > events.length,
        });
      },
    };
  }

  return {
    handlers,
    async call(method: string, input: unknown, actor: AgentActor) {
      if (Object.hasOwn(arcRunUsageRpcContract, method))
        return usage.call(method, input, actor);
      if (method === "listThreadBindings")
        return handlers(actor).listThreadBindings(
          arcWorkspaceRpcContract.listThreadBindings.input.parse(input),
        );
      if (method !== "getWorkspace")
        throw new AgentStoreError(
          "unknown_method",
          `Unknown ARC workspace method: ${method}`,
        );
      return handlers(actor).getWorkspace(
        arcWorkspaceRpcContract.getWorkspace.input.parse(input),
      );
    },
  };
}

export type ArcWorkspaceService = ReturnType<typeof createArcWorkspaceService>;

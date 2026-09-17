import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import {
  ownedWorkflowRpcContract,
  type OwnedRunView,
} from "bb-plugin-workflows/owned-contract";
import { AgentStoreError } from "../data.js";
import type { AgentActor } from "../service.js";
import type { ArcRunStore } from "../runtime/data.js";
import { runtimeNodeKey } from "../runtime/compiler.js";
import {
  arcThreadBrowserRpcContract,
  threadBindingsSchema,
  type ArcThreadRun,
} from "./contract.js";

export function createArcThreadBrowserService(
  bb: BbPluginApi,
  store: ArcRunStore,
) {
  const workflows = bb.rpc.experimental_client({
    pluginId: "workflows",
    contract: ownedWorkflowRpcContract,
  });
  function handlers(
    actor: AgentActor = { kind: "user" },
  ): PluginRpcHandlers<typeof arcThreadBrowserRpcContract> {
    return {
      async listThreadBindings(input) {
        if (actor.kind === "agent" && actor.projectId !== input.projectId)
          throw new AgentStoreError(
            "scope_denied",
            "These conversations belong to another project",
          );
        await bb.sdk.projects.get({ projectId: input.projectId });
        const ids = [...new Set(input.threadIds)];
        const page = store.threadBrowser.page(
          input.projectId,
          ids,
          input.runLimit,
          input.runOffset,
        );
        const latest =
          input.runOffset === 0 && input.runLimit === 1
            ? page
            : store.threadBrowser.latest(input.projectId, ids);
        const effects = store.threadBrowser
          .workers(input.projectId, ids)
          .map(({ effectId }) => store.effect(effectId));
        let activeLookup: "available" | "unavailable" = "available";
        const active = await workflows
          .call("findActiveOwnedThreadRuns", {
            projectId: input.projectId,
            originThreadIds: ids,
          })
          .then(
            (result) => result.runs,
            () => {
              activeLookup = "unavailable";
              return [];
            },
          );
        const retained = new Map<string, ReturnType<ArcRunStore["get"]>>();
        const load = (runId: string) => {
          let run = retained.get(runId);
          if (!run) {
            run = store.get(runId);
            if (run.summary.projectId !== input.projectId)
              throw new AgentStoreError(
                "scope_denied",
                "This run belongs to another project",
              );
            retained.set(runId, run);
          }
          return run;
        };
        for (const item of active) {
          const run = load(item.ownerRunId);
          if (
            run.summary.workflowRunId !== item.workflowRunId ||
            run.compiled.definition.request.originThreadId !==
              item.originThreadId
          )
            throw new AgentStoreError(
              "run_conflict",
              "The active workflow does not match its saved ARC origin",
            );
        }
        for (const item of [...page, ...latest]) load(item.runId);
        const states = new Map<string, OwnedRunView["state"] | null>();
        const entries = [...retained.values()];
        for (let offset = 0; offset < entries.length; offset += 4)
          await Promise.all(
            entries
              .slice(offset, offset + 4)
              .map(async ({ summary, compiled }) => {
                if (summary.workflowRunId === null) {
                  states.set(summary.runId, null);
                  return;
                }
                try {
                  const { run } = await workflows.call("inspectOwnedRun", {
                    workflowRunId: summary.workflowRunId,
                  });
                  if (
                    run.ownerRunId !== summary.runId ||
                    run.projectId !== input.projectId ||
                    run.originThreadId !==
                      compiled.definition.request.originThreadId ||
                    run.planHash !== summary.planHash
                  )
                    throw new AgentStoreError(
                      "run_conflict",
                      "The workflow does not match its saved ARC run",
                    );
                  states.set(summary.runId, run.state);
                } catch (error) {
                  if (error instanceof AgentStoreError) throw error;
                  states.set(summary.runId, null);
                }
              }),
          );
        const summaries = new Map<string, ArcThreadRun>();
        const summary = (runId: string): ArcThreadRun => {
          const existing = summaries.get(runId);
          if (existing) return existing;
          const { compiled, summary: saved } = load(runId);
          const definition = compiled.definition;
          const value: ArcThreadRun = {
            runId,
            originThreadId: definition.request.originThreadId,
            goal: saved.goal,
            planHash: saved.planHash,
            createdAt: saved.createdAt,
            state: states.get(runId) ?? null,
            submission: saved.submission,
            team:
              definition.schemaVersion === 1
                ? null
                : {
                    teamId: definition.team.teamId,
                    revision: definition.team.revision,
                    name: definition.team.definition.name,
                  },
            workerThreadsTotal: store.threadBrowser.workerCount(runId),
            ...store.threadBrowser.lineage(runId),
          };
          summaries.set(runId, value);
          return value;
        };
        const workers = effects.flatMap((effect) => {
          if (effect.threadId === null) return [];
          const { compiled } = load(effect.runId);
          const node = compiled.nodes[runtimeNodeKey(effect.request)];
          if (!node || node.kind !== "agent") return [];
          const definition = compiled.definition;
          const member =
            definition.schemaVersion !== 1 && "memberId" in node
              ? definition.team.definition.members.find(
                  (value) => value.id === node.memberId,
                )
              : null;
          const group =
            definition.schemaVersion !== 1 && member?.groupId
              ? (definition.team.definition.groups.find(
                  (value) => value.id === member.groupId,
                ) ?? null)
              : null;
          return [
            {
              threadId: effect.threadId,
              originThreadId: definition.request.originThreadId,
              runId: effect.runId,
              effectId: effect.effectId,
              agentId: node.agent.definition.agentId,
              revision: node.agent.definition.revision,
              name: node.agent.definition.metadata.name,
              role: node.agent.definition.metadata.role,
              purpose: node.purpose,
              providerId: node.agent.execution.providerId,
              model: node.agent.execution.model,
              group,
              team: summary(effect.runId).team,
            },
          ];
        });
        return threadBindingsSchema.parse({
          origins: ids.map((threadId) => {
            const newest = latest.find(
              (value) => value.originThreadId === threadId,
            );
            const current = active.find(
              (value) => value.originThreadId === threadId,
            );
            const runs = page
              .filter((value) => value.originThreadId === threadId)
              .map((value) => summary(value.runId));
            const total = newest?.total ?? 0;
            return {
              threadId,
              runs,
              runsTotal: total,
              defaultRun: current
                ? summary(current.ownerRunId)
                : newest
                  ? summary(newest.runId)
                  : null,
              activeLookup,
              nextOffset:
                input.runOffset + runs.length < total
                  ? input.runOffset + runs.length
                  : null,
            };
          }),
          workers,
        });
      },
    };
  }
  return { handlers };
}

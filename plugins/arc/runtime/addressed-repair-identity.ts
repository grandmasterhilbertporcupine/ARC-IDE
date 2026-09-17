import { AgentStoreError } from "../data.js";
import type { TeamStore } from "../teams/data.js";
import { addressedRecipientScope } from "../addressing/mentions.js";
import type { CompiledOrchestratedRun } from "./orchestrated-compiler.js";
import type { CompiledDirectoryRun } from "./directory-compiler.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";

type Compiled = CompiledOrchestratedRun | CompiledDirectoryRun;
const scopedId = (prefix: string, value: string) => {
  const id = `${prefix}${value}`;
  return id.length <= 80
    ? id
    : `${id.slice(0, 60)}-${runtimeHash(id).slice(0, 16)}`;
};

export function addressedRepairIdentities(
  compiled: Compiled,
  teams: TeamStore,
) {
  const recipients = compiled.definition.request.addressedRecipients ?? [];
  const ordered = [
    ...recipients.filter((recipient) => recipient.kind === "team"),
    ...recipients.filter((recipient) => recipient.kind === "agent"),
  ];
  const result = new Map<string, string>();
  for (const step of compiled.workflow.steps) {
    if (!step.repair || result.has(step.repair.stageId)) continue;
    const graphNodeId =
      compiled.references.origins[runtimeNodeKey(step)]?.graphNodeId;
    if (graphNodeId == null)
      throw new AgentStoreError(
        "repair_identity_missing",
        "A follow-up repair stage is missing its published graph identity.",
      );
    const position =
      ordered.length === 1
        ? 0
        : Number(/^recipient(\d+)-/.exec(graphNodeId)?.[1]);
    const recipient = ordered[position];
    if (!recipient)
      throw new AgentStoreError(
        "repair_identity_missing",
        "The repair stage does not identify a pinned recipient.",
      );
    const prefix = ordered.length === 1 ? "" : `recipient${position}-`;
    let stageId: string;
    if (recipient.kind === "team") {
      const revision = teams.getRevision({
        scope: addressedRecipientScope(
          recipient.scopeKey,
          compiled.definition.request.projectId,
        ),
        teamId: recipient.entityId,
        revision: recipient.versionId,
      });
      const stage = revision.definition.graph.nodes.find(
        (node) =>
          node.kind === "repair" && scopedId(prefix, node.id) === graphNodeId,
      );
      if (!stage)
        throw new AgentStoreError(
          "repair_identity_missing",
          "The repair stage no longer matches its pinned published team.",
        );
      stageId = stage.id;
    } else {
      if (graphNodeId !== `${prefix}repair`)
        throw new AgentStoreError(
          "repair_identity_missing",
          "The directly addressed repair stage is not recognized.",
        );
      stageId = "repair";
    }
    result.set(
      step.repair.stageId,
      `arc-repair:${runtimeHash({ kind: recipient.kind, scopeKey: recipient.scopeKey, entityId: recipient.entityId, stageId }).slice(0, 48)}`,
    );
  }
  return result;
}

export function stabilizeAddressedRepairStages<T extends Compiled>(
  compiled: T,
  identities: ReadonlyMap<string, string>,
): T {
  if (![...identities].some(([from, to]) => from !== to)) return compiled;
  const steps = compiled.workflow.steps.map((step) =>
    step.repair === null
      ? step
      : {
          ...step,
          repair: {
            ...step.repair,
            stageId: identities.get(step.repair.stageId) ?? step.repair.stageId,
          },
        },
  );
  return {
    ...compiled,
    workflow: {
      ...compiled.workflow,
      steps,
      planHash: runtimeHash({
        planHash: compiled.workflow.planHash,
        repairStages: [...identities].sort(([a], [b]) =>
          a.localeCompare(b, "en"),
        ),
      }),
    },
  };
}

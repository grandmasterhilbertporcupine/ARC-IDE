import type { OwnedRuleContext } from "bb-plugin-workflows/owned-contract";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type {
  TeamDefinition,
  TeamNode,
  TeamRevision,
} from "../teams/contract.js";
import type { ResolvedRunPolicy } from "../policy/contract.js";
import { parseAgentDocument } from "../document.js";
import { validateTeamDefinition } from "../teams/validation.js";
import type { RetainedCompiledRun } from "./compiled.js";
import type { RunAgentSnapshot } from "./definition.js";
import { runtimeHash } from "./hash.js";
import { configuredMemberExecution } from "./execution-snapshot.js";
import type {
  RuleBlocker,
  RuleChange,
  RuleReview,
} from "./rule-update-contract.js";

type TeamRun = Exclude<RetainedCompiledRun["definition"], { schemaVersion: 1 }>;
const same = <A extends JsonValue, B extends JsonValue>(a: A, b: B) =>
  runtimeHash(a) === runtimeHash(b);
function structure(team: TeamDefinition) {
  return {
    members: team.members.map(({ id, agentId }) => ({ id, agentId })),
    nodes: team.graph.nodes.map((node) => {
      const { label: _label, ...rest } = node;
      if (rest.kind === "check") {
        const { command: _command, ...fixed } = rest;
        return fixed;
      }
      if (rest.kind === "repair") {
        const { maxRounds: _rounds, ...fixed } = rest;
        return fixed;
      }
      if (rest.kind === "delegation") {
        const { candidateMemberIds: _roster, ...fixed } = rest;
        return fixed;
      }
      return rest;
    }),
    edges: team.graph.edges,
    entryNodeIds: team.graph.entryNodeIds,
  };
}
function direction(
  increased: boolean,
  decreased: boolean,
): RuleChange["impact"] {
  return increased && decreased
    ? "mixed-authority"
    : increased
      ? "increases-authority"
      : decreased
        ? "reduces-authority"
        : "future-only";
}
function setDirection(before: string[], after: string[]) {
  return direction(
    after.some((id) => !before.includes(id)),
    before.some((id) => !after.includes(id)),
  );
}
function metadata(team: TeamDefinition) {
  return {
    name: team.name,
    description: team.description,
    groups: team.groups,
    presentation: team.presentation,
  };
}

export function ruleBudgetBlockers(
  policy: ResolvedRunPolicy,
  stages: RuleReview["repairStages"],
  context: OwnedRuleContext,
): RuleBlocker[] {
  const blockers: RuleBlocker[] = [];
  const add = (
    code: RuleBlocker["code"],
    message: string,
    nodeIds: string[] = [],
  ) => blockers.push({ code, message, nodeIds, memberIds: [] });
  if (context.run.agentCalls > policy.limits.maxAgentCalls)
    add(
      "budget-below-usage",
      `This run already used ${context.run.agentCalls} agent calls; the proposed total is ${policy.limits.maxAgentCalls}.`,
    );
  if (context.run.chargedActiveMs > policy.limits.maxActiveMs)
    add(
      "budget-below-usage",
      `This run already used ${context.run.chargedActiveMs} active milliseconds; the proposed total is ${policy.limits.maxActiveMs}.`,
    );
  for (const usage of context.run.repairRounds) {
    const stage = stages.find((item) => item.stageId === usage.stageId);
    if (!stage || usage.rounds > stage.afterMaxRounds)
      add(
        "repair-cap-below-usage",
        `Repair stage '${usage.stageId}' already used ${usage.rounds} rounds; its proposed cumulative ceiling is ${stage?.afterMaxRounds ?? 0}.`,
        [usage.stageId],
      );
  }
  return blockers;
}

export function compareRuleSelection(input: {
  before: TeamRun;
  team: TeamRevision;
  members: Record<string, RunAgentSnapshot>;
  resolutions: Record<string, RunAgentSnapshot["execution"] | null>;
  policy: ResolvedRunPolicy;
  context: OwnedRuleContext;
}) {
  const { before, team, members, resolutions, policy, context } = input;
  const prior = before.team.definition;
  const next = team.definition;
  const changes: RuleChange[] = [];
  const blockers: RuleBlocker[] = [];
  const seeds = new Set<string>();
  const add = (
    code: RuleBlocker["code"],
    message: string,
    nodeIds: string[] = [],
    memberIds: string[] = [],
  ) => blockers.push({ code, message, nodeIds, memberIds });
  if (!same(structure(prior), structure(next)))
    add(
      "unsupported-structure",
      "Keep the same Team members, agent identities, node kinds, tasks, candidate references and execution connections for this rule update.",
    );
  if (!same(metadata(prior), metadata(next)))
    changes.push({
      kind: "presentation",
      impact: "future-only",
      before: metadata(prior),
      after: metadata(next),
    });
  if (before.policy.autonomy !== policy.autonomy) {
    const rank = { guided: 0, collaborative: 1, autonomous: 2 };
    changes.push({
      kind: "autonomy",
      impact: direction(
        rank[policy.autonomy] > rank[before.policy.autonomy],
        rank[policy.autonomy] < rank[before.policy.autonomy],
      ),
      before: before.policy.autonomy,
      after: policy.autonomy,
    });
  }
  if (!same(before.policy.limits, policy.limits)) {
    const keys = [
      "maxAgentCalls",
      "maxActiveMs",
      "maxConcurrentAgents",
      "maxRepairRounds",
    ] as const;
    changes.push({
      kind: "limits",
      impact: direction(
        keys.some((key) => policy.limits[key] > before.policy.limits[key]),
        keys.some((key) => policy.limits[key] < before.policy.limits[key]),
      ),
      before: before.policy.limits,
      after: policy.limits,
    });
  }
  if (!same(before.policy.restrictedTeams, policy.restrictedTeams)) {
    const priorPins = before.policy.restrictedTeams;
    const nextPins = policy.restrictedTeams;
    changes.push({
      kind: "restricted-teams",
      impact:
        priorPins === null
          ? "reduces-authority"
          : nextPins === null
            ? "increases-authority"
            : setDirection(
                priorPins.map((pin) => `${pin.teamId}:${pin.revision}`),
                nextPins.map((pin) => `${pin.teamId}:${pin.revision}`),
              ),
      before: priorPins,
      after: nextPins,
    });
  }
  if (!same(before.policy.preferredTeams, policy.preferredTeams))
    changes.push({
      kind: "preferred-teams",
      impact: "future-only",
      before: before.policy.preferredTeams,
      after: policy.preferredTeams,
    });
  if (
    policy.restrictedTeams !== null &&
    !policy.restrictedTeams.some(
      (pin) => pin.teamId === team.teamId && pin.revision === team.revision,
    )
  )
    add(
      "team-restricted",
      "The selected exact Team revision is outside the reviewed allowed teams.",
    );
  for (const id of new Set(
    [...prior.permissions, ...next.permissions].map((grant) => grant.id),
  )) {
    const a = prior.permissions.find((grant) => grant.id === id) ?? null;
    const b = next.permissions.find((grant) => grant.id === id) ?? null;
    if (!same(a, b))
      changes.push({
        kind: "collaboration-grant",
        grantId: id,
        impact:
          a === null
            ? "increases-authority"
            : b === null
              ? "reduces-authority"
              : "mixed-authority",
        before: a,
        after: b,
      });
  }
  for (const id of new Set(
    [...prior.graph.requiredGates, ...next.graph.requiredGates].map(
      (gate) => gate.id,
    ),
  )) {
    const a = prior.graph.requiredGates.find((gate) => gate.id === id) ?? null;
    const b = next.graph.requiredGates.find((gate) => gate.id === id) ?? null;
    if (!same(a, b)) {
      const impact =
        a === null
          ? "reduces-authority"
          : b === null
            ? "increases-authority"
            : direction(
                (a.mode === "all" && b.mode === "any") ||
                  a.nodeIds.some((node) => !b.nodeIds.includes(node)),
                (a.mode === "any" && b.mode === "all") ||
                  b.nodeIds.some((node) => !a.nodeIds.includes(node)),
              );
      changes.push({
        kind: "required-gate",
        gateId: id,
        impact,
        before: a,
        after: b,
      });
      for (const node of [...(a?.nodeIds ?? []), ...(b?.nodeIds ?? [])])
        seeds.add(node);
    }
  }
  const repairStages: RuleReview["repairStages"] = [];
  for (const node of next.graph.nodes) {
    const old = prior.graph.nodes.find((value) => value.id === node.id);
    if (
      node.kind === "check" &&
      old?.kind === "check" &&
      !same(node.command, old.command)
    ) {
      changes.push({
        kind: "native-check",
        impact: "behavior",
        nodeId: node.id,
        label: node.label,
        before: old.command,
        after: node.command,
      });
      seeds.add(node.id);
    }
    if (
      node.kind === "delegation" &&
      old?.kind === "delegation" &&
      !same(node.candidateMemberIds, old.candidateMemberIds)
    ) {
      changes.push({
        kind: "delegation-roster",
        impact: setDirection(old.candidateMemberIds, node.candidateMemberIds),
        nodeId: node.id,
        label: node.label,
        before: old.candidateMemberIds,
        after: node.candidateMemberIds,
      });
      seeds.add(node.id);
    }
    if (node.kind === "repair" && old?.kind === "repair") {
      const stage = {
        stageId: node.id,
        label: node.label,
        beforeNodeMaxRounds: old.maxRounds,
        afterNodeMaxRounds: node.maxRounds,
        beforeMaxRounds: Math.min(
          old.maxRounds,
          before.policy.limits.maxRepairRounds,
        ),
        afterMaxRounds: Math.min(node.maxRounds, policy.limits.maxRepairRounds),
      };
      repairStages.push(stage);
      const recorded =
        context.repairCatalog.source === "legacy-zero"
          ? 0
          : context.repairCatalog.stages.find(
              (value) => value.stageId === node.id,
            )?.maxRounds;
      if (
        recorded !== stage.beforeMaxRounds &&
        !(
          recorded === undefined &&
          stage.beforeMaxRounds === 0 &&
          context.repairCatalog.source === "manifest"
        )
      )
        add(
          "invalid-team",
          `The retained repair ceiling for '${node.id}' disagrees with its original Team snapshot.`,
          [node.id],
        );
      if (
        old.maxRounds !== node.maxRounds ||
        stage.beforeMaxRounds !== stage.afterMaxRounds
      ) {
        changes.push({
          kind: "repair-ceiling",
          impact:
            stage.beforeMaxRounds === stage.afterMaxRounds
              ? "future-only"
              : direction(
                  stage.afterMaxRounds > stage.beforeMaxRounds,
                  stage.afterMaxRounds < stage.beforeMaxRounds,
                ),
          nodeId: node.id,
          label: node.label,
          beforeNodeMaxRounds: stage.beforeNodeMaxRounds,
          afterNodeMaxRounds: stage.afterNodeMaxRounds,
          beforeMaxRounds: stage.beforeMaxRounds,
          afterMaxRounds: stage.afterMaxRounds,
        });
        seeds.add(node.id);
      }
    }
  }
  if (context.repairCatalog.source !== "legacy-zero")
    for (const stage of context.repairCatalog.stages)
      if (!repairStages.some((item) => item.stageId === stage.stageId))
        add(
          "unsupported-structure",
          `Keep the retained repair stage '${stage.stageId}'.`,
          [stage.stageId],
        );
  for (const member of next.members) {
    const old = before.members[member.id];
    const target = members[member.id];
    if (!old || !target) continue;
    const { execution: _oldExecution, ...oldMetadata } =
      old.definition.metadata;
    const { execution: _newExecution, ...newMetadata } =
      target.definition.metadata;
    if (
      !same(oldMetadata, newMetadata) ||
      !same(old.definition.attachments, target.definition.attachments) ||
      target.definition.agentId !== old.definition.agentId ||
      target.definition.revision < old.definition.revision
    )
      add(
        "unsupported-agent-metadata",
        "Keep agent identity, descriptive metadata and attached references unchanged. Only instruction bodies and execution choices can change in this update.",
        [],
        [member.id],
      );
    const identity = {
      memberId: member.id,
      agentId: member.agentId,
      name: target.definition.metadata.name,
      oldRevision: old.definition.revision,
      newRevision: target.definition.revision,
    };
    const a = parseAgentDocument(old.definition.document).body;
    const b = parseAgentDocument(target.definition.document).body;
    if (a !== b)
      changes.push({
        kind: "instructions",
        impact: "behavior",
        ...identity,
        before: a,
        after: b,
      });
    const resolved = resolutions[member.id] ?? null;
    const oldConfigured = configuredMemberExecution(
      old.definition,
      prior.members.find((item) => item.id === member.id)?.modelOverride,
    );
    const newConfigured = configuredMemberExecution(
      target.definition,
      member.modelOverride,
    );
    if (resolved === null)
      add(
        "execution-unavailable",
        `Resolve execution settings for '${identity.name}' before applying rules.`,
        [],
        [member.id],
      );
    if (!same(oldConfigured, newConfigured) || !same(old.execution, resolved))
      changes.push({
        kind: "execution",
        impact: same(old.execution, resolved) ? "future-only" : "behavior",
        ...identity,
        before: {
          configured: oldConfigured,
          resolved: old.execution,
        },
        after: { configured: newConfigured, resolved },
      });
    if (a !== b || !same(old.execution, resolved))
      for (const node of next.graph.nodes)
        if (nodeMember(node).includes(member.id)) seeds.add(node.id);
  }
  const validation = validateTeamDefinition(next, (id, revision) =>
    Object.values(members).some(
      (member) =>
        member.definition.agentId === id &&
        member.definition.revision === revision,
    ),
  );
  for (const issue of validation.diagnostics)
    add(
      issue.code === "review_grant_required"
        ? "review-grant-required"
        : issue.code === "delegation_grant_required"
          ? "delegation-grant-required"
          : "invalid-team",
      issue.message,
      issue.nodeIds,
    );
  blockers.push(...ruleBudgetBlockers(policy, repairStages, context));
  if (
    changes.some((change) =>
      [
        "autonomy",
        "limits",
        "restricted-teams",
        "collaboration-grant",
      ].includes(change.kind),
    )
  )
    for (const node of next.graph.nodes) seeds.add(node.id);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of next.graph.edges)
      if (seeds.has(edge.source) && !seeds.has(edge.target)) {
        seeds.add(edge.target);
        expanded = true;
      }
  }
  return {
    changes,
    blockers,
    repairStages: repairStages.sort((a, b) =>
      a.stageId.localeCompare(b.stageId, "en"),
    ),
    affectedNodes: next.graph.nodes
      .filter((node) => seeds.has(node.id))
      .map(({ id: nodeId, label, kind }) => ({ nodeId, label, kind })),
  };
}

function nodeMember(node: TeamNode): string[] {
  if (node.kind === "agent" || node.kind === "review") return [node.memberId];
  if (node.kind === "repair") return [node.body.memberId];
  if (node.kind === "delegation")
    return [node.requesterMemberId, ...node.candidateMemberIds];
  return [];
}

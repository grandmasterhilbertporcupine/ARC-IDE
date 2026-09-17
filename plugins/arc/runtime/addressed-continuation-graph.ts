import type { TeamRevision, TeamNode, TeamEdge } from "../teams/contract.js";
import { teamHashes } from "../teams/validation.js";
import { AgentStoreError } from "../data.js";
import type { AddressedComponent } from "./addressed-composition.js";
import { runtimeHash } from "./hash.js";

type Check = Extract<TeamNode, { kind: "check" }>;
type Condition = Extract<TeamNode, { kind: "condition" }>;
type Clauses = string[][];
type Guard = { decision: string; output: "true" | "false" };
type FinalGate = { checkNodeId: string; reviewNodeId: string };

const unsupported = () =>
  new AgentStoreError(
    "followup_verification_unsupported",
    "The earlier verification depends on a decision that cannot be safely replayed with changed recipients. Cancel this unadmitted follow-up in Workspace and send again with the existing recipients and versions to retain its candidate, budget, and gates.",
  );
const normalize = (clauses: Clauses): Clauses => {
  const unique = [
    ...new Map(
      clauses.map((clause) => {
        const value = [...new Set(clause)].sort();
        return [JSON.stringify(value), value];
      }),
    ).values(),
  ];
  return unique.filter(
    (clause, index) =>
      !unique.some(
        (other, at) =>
          at !== index &&
          other.length < clause.length &&
          other.every((id) => clause.includes(id)),
      ),
  );
};
const any = (groups: Clauses[]): Clauses => {
  if (groups.some((group) => group.length === 0)) return [];
  let clauses: Clauses = [[]];
  for (const group of groups) {
    if (clauses.length * group.length > 128) throw unsupported();
    clauses = normalize(
      clauses.flatMap((left) => group.map((right) => [...left, ...right])),
    );
  }
  return clauses;
};

function verification(
  previous: TeamRevision,
  finalGates: readonly FinalGate[],
) {
  const graph = previous.definition.graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = (id: string) =>
    graph.edges.filter((edge) => edge.target === id);
  const guardCache = new Map<string, Guard[]>();
  const conditions = new Map<string, Condition>();
  for (const node of graph.nodes)
    if (node.kind === "condition") conditions.set(node.id, node);
  const guards = (id: string): Guard[] => {
    const cached = guardCache.get(id);
    if (cached) return cached;
    const node = nodes.get(id);
    if (!node) throw unsupported();
    if (node.kind === "repair") return guards(node.checkNodeId);
    const values = new Map<string, Guard>();
    for (const edge of incoming(id)) {
      for (const guard of guards(edge.source))
        values.set(guard.decision, guard);
      const source = nodes.get(edge.source);
      if (source?.kind === "condition") {
        if (edge.sourceHandle !== "true" && edge.sourceHandle !== "false")
          throw unsupported();
        values.set(source.id, {
          decision: source.id,
          output: edge.sourceHandle,
        });
      } else if (edge.requiredOutcome === "failed") {
        if (source?.kind !== "check") throw unsupported();
        const decision = `failed:${source.id}`;
        conditions.set(decision, {
          id: decision,
          kind: "condition",
          label: "Retained check outcome",
          predicate: {
            kind: "outcome",
            sourceNodeId: source.id,
            equals: "failed",
          },
        });
        values.set(decision, { decision, output: "true" });
      }
    }
    if (node.kind === "join" && node.mode === "selected" && node.decisionNodeId)
      values.delete(node.decisionNodeId);
    const result = [...values.values()];
    guardCache.set(id, result);
    return result;
  };
  const obligations = new Map<string, Clauses>();
  const success = (id: string): Clauses => {
    const cached = obligations.get(id);
    if (cached) return cached;
    const node = nodes.get(id);
    if (!node) throw unsupported();
    if (node.kind === "approval" || node.kind === "release")
      throw unsupported();
    if (node.kind === "repair") return success(node.checkNodeId);
    const edges = incoming(id);
    const fromEdge = (edge: TeamEdge) =>
      edge.requiredOutcome === "succeeded" ? success(edge.source) : [];
    let inputs: Clauses;
    if (
      node.kind === "join" &&
      node.mode === "selected" &&
      node.decisionNodeId
    ) {
      const decision = node.decisionNodeId;
      const branch = (edge: TeamEdge) =>
        guards(edge.source).find((guard) => guard.decision === decision)
          ?.output ??
        (edge.source === decision &&
        ["true", "false"].includes(edge.sourceHandle)
          ? edge.sourceHandle
          : null);
      inputs = [
        ...edges.filter((edge) => branch(edge) === null).flatMap(fromEdge),
        ...any(
          ["true", "false"].map((output) =>
            edges.filter((edge) => branch(edge) === output).flatMap(fromEdge),
          ),
        ),
      ];
    } else inputs = edges.flatMap(fromEdge);
    const result = normalize([
      ...(node.kind === "check" ? [[id]] : []),
      ...inputs,
    ]);
    obligations.set(id, result);
    return result;
  };
  const clauses = normalize([
    ...graph.requiredGates.flatMap((gate) => {
      const alternatives = gate.nodeIds.map(success);
      return gate.mode === "all" ? alternatives.flat() : any(alternatives);
    }),
    ...any(
      finalGates.map((gate) => [
        ...success(gate.checkNodeId),
        ...success(gate.reviewNodeId),
      ]),
    ),
  ]);
  if (clauses.some((clause) => clause.length === 0)) throw unsupported();
  const checks = new Map<string, Check>();
  const neededConditions = new Map<string, Condition>();
  const include = (id: string) => {
    if (checks.has(id)) return;
    const node = nodes.get(id);
    if (node?.kind !== "check") throw unsupported();
    checks.set(id, node);
    for (const guard of guards(id)) includeCondition(guard.decision);
  };
  const includeCondition = (id: string) => {
    if (neededConditions.has(id)) return;
    const condition = conditions.get(id);
    if (
      !condition ||
      !["outcome", "check-exit"].includes(condition.predicate.kind) ||
      nodes.get(condition.predicate.sourceNodeId)?.kind !== "check"
    )
      throw unsupported();
    neededConditions.set(id, condition);
    include(condition.predicate.sourceNodeId);
  };
  for (const id of clauses.flat()) include(id);
  const checkKeys = new Map<string, string>();
  const conditionKeys = new Map<string, string>();
  const conditionKey = (id: string): string => {
    const cached = conditionKeys.get(id);
    if (cached) return cached;
    const condition = neededConditions.get(id)!;
    const { sourceNodeId, ...predicate } = condition.predicate;
    const key = runtimeHash({ predicate, source: checkKey(sourceNodeId) });
    conditionKeys.set(id, key);
    return key;
  };
  const checkKey = (id: string): string => {
    const cached = checkKeys.get(id);
    if (cached) return cached;
    const key = runtimeHash({
      command: checks.get(id)!.command,
      guards: guards(id)
        .map((guard) => ({
          decision: conditionKey(guard.decision),
          output: guard.output,
        }))
        .sort((a, b) => a.decision.localeCompare(b.decision)),
    });
    checkKeys.set(id, key);
    return key;
  };
  for (const id of checks.keys()) checkKey(id);
  return {
    clauses,
    checks,
    conditions: neededConditions,
    guards,
    checkKey,
    conditionKey,
  };
}

export function preserveAddressedVerification(
  previous: TeamRevision,
  next: AddressedComponent,
  finalReviewIds: readonly string[],
  previousFinalGates: readonly FinalGate[],
): AddressedComponent {
  const definition = structuredClone(next.revision.definition);
  const plan = verification(previous, previousFinalGates);
  const reviews = definition.graph.nodes.filter(
    (node): node is Extract<TeamNode, { kind: "review" }> =>
      node.kind === "review" && finalReviewIds.includes(node.id),
  );
  if (reviews.length === 0)
    throw new AgentStoreError(
      "followup_review_missing",
      "The revised recipients must retain an independent final review of the combined candidate.",
    );
  const collision = () =>
    new AgentStoreError(
      "followup_verification_collision",
      "A revised team conflicts with retained verification. Rename the conflicting node or gate before continuing.",
    );
  const existingNodes = new Set(definition.graph.nodes.map((node) => node.id));
  const retained = new Set<string>();
  const addNode = (node: TeamNode) => {
    const existing = definition.graph.nodes.find((item) => item.id === node.id);
    if (existing && runtimeHash(existing) !== runtimeHash(node))
      throw collision();
    if (!existing) definition.graph.nodes.push(node);
  };
  const addEdge = (edge: Omit<TeamEdge, "id">) => {
    const value = { ...edge, id: `edge-${runtimeHash(edge).slice(0, 40)}` };
    const existing = definition.graph.edges.find(
      (item) => item.id === value.id,
    );
    if (existing && runtimeHash(existing) !== runtimeHash(value))
      throw collision();
    if (!existing && (retained.has(edge.source) || retained.has(edge.target)))
      throw collision();
    if (!existing) definition.graph.edges.push(value);
  };
  const gateGroups = new Map<string, string[]>();
  for (const review of reviews) {
    const suffix = runtimeHash(review.id).slice(0, 12);
    const checkId = (id: string) =>
      `prior-check-${plan.checkKey(id).slice(0, 24)}-${suffix}`;
    const conditionId = (id: string) =>
      `prior-choice-${plan.conditionKey(id).slice(0, 24)}-${suffix}`;
    const waitId = (id: string) =>
      `prior-wait-${plan.conditionKey(id).slice(0, 24)}-${suffix}`;
    const owned = new Set([
      ...[...plan.checks.keys()].map(checkId),
      ...[...plan.conditions.keys()].flatMap((id) => [
        conditionId(id),
        waitId(id),
      ]),
    ]);
    for (const id of owned) if (existingNodes.has(id)) retained.add(id);
    const incoming = definition.graph.edges.filter(
      (edge) => edge.target === review.id && !owned.has(edge.source),
    );
    const anchor = (id: string) => {
      if (incoming.length)
        for (const edge of incoming)
          addEdge({
            source: edge.source,
            sourceHandle: edge.sourceHandle,
            requiredOutcome: edge.requiredOutcome,
            target: id,
          });
      else if (!definition.graph.entryNodeIds.includes(id))
        definition.graph.entryNodeIds.push(id);
    };
    for (const [id, check] of plan.checks) {
      addNode({
        ...check,
        id: checkId(id),
        label: "Retained project verification",
        candidate: review.candidate,
      });
      anchor(checkId(id));
      for (const guard of plan.guards(id))
        addEdge({
          source: conditionId(guard.decision),
          target: checkId(id),
          sourceHandle: guard.output,
          requiredOutcome: "succeeded",
        });
      if (plan.guards(id).length === 0)
        addEdge({
          source: checkId(id),
          target: review.id,
          sourceHandle: "next",
          requiredOutcome: "completed",
        });
    }
    for (const [id, condition] of plan.conditions) {
      const mapped = conditionId(id);
      addNode({
        ...condition,
        id: mapped,
        label: "Retained verification decision",
        predicate: {
          ...condition.predicate,
          sourceNodeId: checkId(condition.predicate.sourceNodeId),
        },
      });
      addEdge({
        source: checkId(condition.predicate.sourceNodeId),
        target: mapped,
        sourceHandle: "next",
        requiredOutcome: "completed",
      });
      const joinId = waitId(id);
      addNode({
        id: joinId,
        label: "Wait for retained verification",
        kind: "join",
        mode: "selected",
        decisionNodeId: mapped,
      });
      for (const output of ["true", "false"] as const) {
        const branchChecks = [...plan.checks.keys()].filter((check) =>
          plan
            .guards(check)
            .some((guard) => guard.decision === id && guard.output === output),
        );
        if (
          branchChecks.some((check) =>
            plan.guards(check).some((guard) => guard.decision !== id),
          )
        )
          throw unsupported();
        if (branchChecks.length)
          for (const check of branchChecks)
            addEdge({
              source: checkId(check),
              target: joinId,
              sourceHandle: "next",
              requiredOutcome: "completed",
            });
        else throw unsupported();
      }
      if (plan.guards(condition.predicate.sourceNodeId).length)
        throw unsupported();
      addEdge({
        source: joinId,
        target: review.id,
        sourceHandle: "next",
        requiredOutcome: "succeeded",
      });
    }
    for (const clause of plan.clauses) {
      const key = runtimeHash([...new Set(clause.map(plan.checkKey))].sort());
      gateGroups.set(key, [
        ...(gateGroups.get(key) ?? []),
        ...clause.map(checkId),
      ]);
    }
  }
  for (const [key, nodeIds] of gateGroups) {
    const gate = {
      id: `prior-check-${key.slice(0, 24)}`,
      mode: "any" as const,
      nodeIds: [...new Set(nodeIds)].sort(),
    };
    const existing = definition.graph.requiredGates.find(
      (item) => item.id === gate.id,
    );
    if (existing && runtimeHash(existing) !== runtimeHash(gate))
      throw collision();
    if (!existing) definition.graph.requiredGates.push(gate);
  }
  definition.schemaVersion = 2;
  return {
    revision: { ...next.revision, ...teamHashes(definition) },
    members: next.members,
  };
}

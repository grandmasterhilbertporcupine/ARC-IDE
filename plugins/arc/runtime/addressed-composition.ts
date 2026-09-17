import type {
  TeamDefinition,
  TeamEdge,
  TeamNode,
  TeamRevision,
} from "../teams/contract.js";
import { teamHashes, validateTeamDefinition } from "../teams/validation.js";
import { AgentStoreError } from "../data.js";
import type { RunAgentSnapshot } from "./definition.js";
import { runtimeHash } from "./hash.js";
import { validateDirectoryTeamGraph } from "./directory-graph-validation.js";
import { analyzeTeamReviewGrants } from "../teams/review-grants.js";
import type { CompositionAuthorization } from "./composition-authorization-contract.js";

export type AddressedComponent = {
  revision: TeamRevision;
  members: Record<string, RunAgentSnapshot>;
  compositionAuthorization?: CompositionAuthorization;
};
type Candidate = Extract<TeamNode, { kind: "agent" }>["candidate"];
type ExportedResult = { candidate: Candidate; dependencies: string[] };
const scopedId = (prefix: string, value: string) => {
  const id = `${prefix}${value}`;
  return id.length <= 80
    ? id
    : `${id.slice(0, 60)}-${runtimeHash(id).slice(0, 16)}`;
};
const edgeId = (source: string, target: string) =>
  `edge-${runtimeHash({ source, target }).slice(0, 40)}`;

export function addressedIdentity(value: string, prefix: "team" | "agent") {
  const digest = runtimeHash(value);
  return `${prefix}_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function namespacedNode(
  node: TeamNode,
  prefix: string,
  source: Candidate,
): TeamNode {
  const id = (value: string) => scopedId(prefix, value);
  const candidate = (value: Candidate): Candidate =>
    value.kind === "source"
      ? source
      : { kind: "node", nodeId: id(value.nodeId) };
  const base = { ...node, id: id(node.id) };
  switch (base.kind) {
    case "agent":
    case "review":
      return {
        ...base,
        memberId: id(base.memberId),
        candidate: candidate(base.candidate),
      };
    case "check":
    case "release":
      return { ...base, candidate: candidate(base.candidate) };
    case "approval":
      return {
        ...base,
        candidate: base.candidate === null ? null : candidate(base.candidate),
      };
    case "condition":
      return {
        ...base,
        predicate: {
          ...base.predicate,
          sourceNodeId: id(base.predicate.sourceNodeId),
        },
      };
    case "repair":
      return {
        ...base,
        body: { ...base.body, memberId: id(base.body.memberId) },
        checkNodeId: id(base.checkNodeId),
      };
    case "integration":
      return {
        ...base,
        writerNodeIds: base.writerNodeIds.map(id),
        baseCandidate: candidate(base.baseCandidate),
      };
    case "delegation":
      return {
        ...base,
        requesterMemberId: id(base.requesterMemberId),
        candidateMemberIds: base.candidateMemberIds.map(id),
        candidate: candidate(base.candidate),
      };
    case "join":
      return {
        ...base,
        decisionNodeId:
          base.decisionNodeId === null ? null : id(base.decisionNodeId),
      };
    case "parallel":
      return base;
  }
}

function exportReviewedResult(team: TeamDefinition): ExportedResult {
  const nodes = new Map(team.graph.nodes.map((node) => [node.id, node]));
  const outgoing = (id: string) =>
    team.graph.edges.filter((edge) => edge.source === id);
  const reachable = (from: string, to: string) => {
    const pending = [from];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...outgoing(current).map((edge) => edge.target));
    }
    return false;
  };
  const branch = (decision: string, input: string) => {
    const outputs = new Set<string>();
    for (const edge of outgoing(decision)) {
      const pending = [edge.target];
      const seen = new Set<string>();
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const node = nodes.get(current);
        if (
          node?.kind === "join" &&
          node.mode === "selected" &&
          node.decisionNodeId === decision
        )
          continue;
        if (current === input) {
          outputs.add(edge.sourceHandle);
          break;
        }
        pending.push(...outgoing(current).map((next) => next.target));
      }
    }
    return outputs;
  };
  let sequence = 0;
  const occupied = new Set([
    ...nodes.keys(),
    ...team.graph.edges.map((edge) => edge.id),
  ]);
  const fresh = () => {
    let id: string;
    do {
      id = `arc-result-${sequence++}`;
    } while (occupied.has(id));
    occupied.add(id);
    return id;
  };
  const connect = (
    source: string,
    target: string,
    sourceHandle: TeamEdge["sourceHandle"] = "next",
    requiredOutcome: TeamEdge["requiredOutcome"] = "succeeded",
  ) => {
    team.graph.edges.push({
      id: fresh(),
      source,
      target,
      sourceHandle,
      requiredOutcome,
    });
  };
  const reviews = team.graph.nodes.filter((node) => node.kind === "review");
  let outputs = reviews
    .filter(
      (node) =>
        !reviews.some(
          (other) => other.id !== node.id && reachable(node.id, other.id),
        ),
    )
    .map((node) => ({ id: node.id, candidate: node.candidate }));
  if (!outputs.length)
    throw new AgentStoreError(
      "recipient_review_required",
      `${team.name} needs an independently reviewed result before composing recipients`,
    );
  const sameCandidate = (values: typeof outputs) =>
    new Set(values.map((value) => JSON.stringify(value.candidate))).size === 1;
  const synthesized = new Set<string>();
  while (outputs.length > 1) {
    const conditions = [...nodes.values()].filter(
      (node) => node.kind === "condition",
    );
    let joined = false;
    for (const decision of conditions) {
      const alternatives = outputs.filter(
        (output) => branch(decision.id, output.id).size === 1,
      );
      const yes = alternatives.filter((output) =>
        branch(decision.id, output.id).has("true"),
      );
      const no = alternatives.filter((output) =>
        branch(decision.id, output.id).has("false"),
      );
      if (
        !yes.length ||
        !no.length ||
        !sameCandidate(yes) ||
        !sameCandidate(no)
      )
        continue;
      if (
        alternatives.some((output) =>
          conditions.some(
            (nested) =>
              nested.id !== decision.id &&
              reachable(decision.id, nested.id) &&
              branch(nested.id, output.id).size > 0,
          ),
        )
      )
        continue;
      const id = fresh();
      const join: TeamNode = {
        id,
        kind: "join",
        label: "Select verified recipient result",
        mode: "selected",
        decisionNodeId: decision.id,
      };
      nodes.set(id, join);
      team.graph.nodes.push(join);
      for (const output of alternatives) connect(output.id, id);
      outputs = [
        ...outputs.filter((output) => !alternatives.includes(output)),
        { id, candidate: { kind: "node", nodeId: id } },
      ];
      joined = true;
      break;
    }
    if (joined) continue;
    let conditioned = false;
    for (const repair of [...nodes.values()].filter(
      (node) => node.kind === "repair",
    )) {
      if (synthesized.has(repair.id)) continue;
      const check = nodes.get(repair.checkNodeId);
      if (check?.kind !== "check") continue;
      const repaired = outputs.filter(
        (output) =>
          output.candidate.kind === "node" &&
          output.candidate.nodeId === repair.id,
      );
      const passed = outputs.filter(
        (output) =>
          JSON.stringify(output.candidate) === JSON.stringify(check.candidate),
      );
      if (!repaired.length || !passed.length) continue;
      const id = fresh();
      const condition: TeamNode = {
        id,
        kind: "condition",
        label: "Select checked result",
        predicate: {
          kind: "outcome",
          sourceNodeId: check.id,
          equals: "succeeded",
        },
      };
      nodes.set(id, condition);
      team.graph.nodes.push(condition);
      connect(check.id, id, "next", "completed");
      for (const output of passed) connect(id, output.id, "true");
      connect(id, repair.id, "false");
      synthesized.add(repair.id);
      conditioned = true;
      break;
    }
    if (conditioned) continue;
    if (sameCandidate(outputs))
      return {
        candidate: outputs[0]!.candidate,
        dependencies: outputs.map((output) => output.id),
      };
    throw new AgentStoreError(
      "recipient_output_ambiguous",
      `${team.name} has independent reviewed results. Add a combined candidate or an explicit condition and selected join before composing it.`,
    );
  }
  return { candidate: outputs[0]!.candidate, dependencies: [outputs[0]!.id] };
}

export function composeAddressedTeams(input: {
  operationId: string;
  components: AddressedComponent[];
  lead: RunAgentSnapshot;
  reviewer: RunAgentSnapshot;
  check: Extract<TeamNode, { kind: "check" }>["command"];
  createdAt: number;
  sourceKind?: "git" | "directory";
}): AddressedComponent {
  if (input.components.length === 0)
    throw new AgentStoreError(
      "recipients_missing",
      "Choose at least one recipient",
    );
  const serial = input.sourceKind === "directory";
  const definition: TeamDefinition = {
    schemaVersion: 2,
    name: "Addressed work",
    description:
      "One coordinated request with pinned recipient definitions, shared limits and combined verification.",
    leaderMemberId: "coordinator",
    groups: [],
    members: [
      {
        id: "coordinator",
        agentId: input.lead.definition.agentId,
        revision: input.lead.definition.revision,
        groupId: null,
        role: "Lead",
        responsibility:
          "Divide the request into recipient assignments and resolve questions within the admitted graph.",
        leaderMemberId: null,
        skills: [],
      },
      {
        id: "combined-reviewer",
        agentId: input.reviewer.definition.agentId,
        revision: input.reviewer.definition.revision,
        groupId: null,
        role: "Reviewer",
        responsibility: "Independently review the complete checked candidate.",
        leaderMemberId: null,
        skills: [],
      },
    ],
    permissions: [],
    graph: {
      nodes: [
        {
          id: "coordinate",
          label: "Coordinate recipients",
          kind: "agent",
          memberId: "coordinator",
          access: "read",
          candidate: { kind: "source" },
          task: "Inspect the request and pinned recipients. Publish arc_run_report with concise divided assignments identifying each recipient's scope, dependencies and acceptance criteria. Existing member tasks, permissions, checks and limits remain authoritative; do not dispatch outside this graph.",
        },
      ],
      edges: [],
      entryNodeIds: ["coordinate"],
      requiredGates: [],
    },
    presentation: { nodes: [], groups: [], members: [] },
  };
  const members: Record<string, RunAgentSnapshot> = {
    coordinator: input.lead,
    "combined-reviewer": input.reviewer,
  };
  const candidates: string[] = [];
  const finalDependencies: string[] = [];
  let previous: ExportedResult = {
    candidate: { kind: "source" },
    dependencies: ["coordinate"],
  };
  input.components.forEach((component, index) => {
    const prefix = `recipient${index}-`;
    const id = (value: string) => scopedId(prefix, value);
    const source = structuredClone(component.revision.definition);
    const validation = validateTeamDefinition(source, (agentId, revision) =>
      Object.values(component.members).some(
        (member) =>
          member.definition.agentId === agentId &&
          member.definition.revision === revision,
      ),
    );
    if (!validation.valid || !validation.execution.available)
      throw new AgentStoreError(
        "recipient_workflow_invalid",
        `Complete ${source.name}'s workflow before addressing it`,
      );
    if (serial) {
      const support = validateDirectoryTeamGraph(source);
      if (!support.valid)
        throw new AgentStoreError(
          "recipient_directory_workflow_unsupported",
          `${source.name}: ${support.diagnostics.map((item) => item.message).join(" ")}`,
        );
    }
    const result = exportReviewedResult(source);
    if (result.candidate.kind !== "node")
      throw new AgentStoreError(
        "recipient_output_missing",
        `${source.name} needs a reviewed candidate stage to combine`,
      );
    const candidate: Candidate = {
      kind: "node",
      nodeId: id(result.candidate.nodeId),
    };
    candidates.push(candidate.nodeId);
    const dependencies = result.dependencies.map(id);
    definition.groups.push(
      ...source.groups.map((group) => ({
        ...group,
        id: id(group.id),
        parentGroupId:
          group.parentGroupId === null ? null : id(group.parentGroupId),
      })),
    );
    definition.members.push(
      ...source.members.map((member) => ({
        ...member,
        id: id(member.id),
        groupId: member.groupId === null ? null : id(member.groupId),
        ...(member.leaderMemberId === undefined
          ? {}
          : {
              leaderMemberId:
                member.leaderMemberId === null
                  ? null
                  : id(member.leaderMemberId),
            }),
      })),
    );
    for (const [key, snapshot] of Object.entries(component.members))
      members[id(key)] = snapshot;
    definition.permissions.push(
      ...source.permissions.map((grant) => ({
        ...grant,
        id: id(grant.id),
        fromMemberId: id(grant.fromMemberId),
        toMemberId: id(grant.toMemberId),
      })),
    );
    definition.graph.nodes.push(
      ...source.graph.nodes.map((node) =>
        namespacedNode(
          node,
          prefix,
          serial ? previous.candidate : { kind: "source" },
        ),
      ),
    );
    definition.graph.edges.push(
      ...source.graph.edges.map((edge) => ({
        ...edge,
        id: id(edge.id),
        source: id(edge.source),
        target: id(edge.target),
      })),
    );
    definition.graph.requiredGates.push(
      ...source.graph.requiredGates.map((gate) => ({
        ...gate,
        id: id(gate.id),
        nodeIds: gate.nodeIds.map(id),
      })),
    );
    for (const entry of source.graph.entryNodeIds)
      for (const dependency of serial ? previous.dependencies : ["coordinate"])
        definition.graph.edges.push({
          id: edgeId(dependency, id(entry)),
          source: dependency,
          target: id(entry),
          sourceHandle: "next",
          requiredOutcome: "succeeded",
        });
    finalDependencies.push(...dependencies);
    const teamLead = source.leaderMemberId ?? source.members[0]?.id;
    if (teamLead) {
      const lead = definition.members.find(
        (member) => member.id === id(teamLead),
      );
      if (lead && lead.leaderMemberId == null)
        lead.leaderMemberId = "coordinator";
      definition.permissions.push(
        {
          id: `coordinate-${id(teamLead)}`,
          fromMemberId: "coordinator",
          toMemberId: id(teamLead),
          action: "message",
        },
        {
          id: `report-${id(teamLead)}`,
          fromMemberId: id(teamLead),
          toMemberId: "coordinator",
          action: "message",
        },
      );
    }
    for (const member of source.members)
      definition.permissions.push({
        id: `combined-review-${id(member.id)}`,
        fromMemberId: "combined-reviewer",
        toMemberId: id(member.id),
        action: "review",
      });
    previous = { candidate, dependencies };
  });
  const combinedCandidate: Candidate = serial
    ? previous.candidate
    : { kind: "node", nodeId: "combine" };
  if (!serial) {
    definition.graph.nodes.push({
      id: "combine",
      label: "Combine recipient results",
      kind: "integration",
      writerNodeIds: candidates,
      baseCandidate: { kind: "source" },
    });
    for (const nodeId of new Set(finalDependencies))
      definition.graph.edges.push({
        id: edgeId(nodeId, "combine"),
        source: nodeId,
        target: "combine",
        sourceHandle: "next",
        requiredOutcome: "succeeded",
      });
  }
  definition.graph.nodes.push(
    {
      id: "combined-check",
      label: "Check combined result",
      kind: "check",
      command: input.check,
      candidate: combinedCandidate,
    },
    {
      id: "combined-review",
      label: "Review combined result",
      kind: "review",
      memberId: "combined-reviewer",
      task: "Independently review the exact combined candidate and its required check. Verify each addressed request, conflicts and omissions. Submit arc_run_review with concrete findings; chat alone is not approval.",
      candidate: combinedCandidate,
    },
  );
  for (const source of serial ? previous.dependencies : ["combine"])
    definition.graph.edges.push({
      id: edgeId(source, "combined-check"),
      source,
      target: "combined-check",
      sourceHandle: "next",
      requiredOutcome: "succeeded",
    });
  definition.graph.edges.push({
    id: "check-review",
    source: "combined-check",
    target: "combined-review",
    sourceHandle: "next",
    requiredOutcome: "succeeded",
  });
  definition.graph.requiredGates.push({
    id: "combined-verification",
    mode: "all",
    nodeIds: ["combined-check", "combined-review"],
  });
  if (serial) {
    for (const review of analyzeTeamReviewGrants(definition).reviews) {
      for (const memberId of review.missingMemberIds) {
        const reviewerScope = /^recipient(\d+)-/u.exec(
          review.reviewerMemberId,
        )?.[1];
        const contributorScope = /^recipient(\d+)-/u.exec(memberId)?.[1];
        if (
          reviewerScope === undefined ||
          contributorScope === undefined ||
          Number(contributorScope) >= Number(reviewerScope)
        )
          continue;
        if (
          definition.permissions.some(
            (grant) =>
              grant.action === "review" &&
              grant.fromMemberId === review.reviewerMemberId &&
              grant.toMemberId === memberId,
          )
        )
          continue;
        definition.permissions.push({
          id: `carry-review-${runtimeHash([review.reviewerMemberId, memberId]).slice(0, 24)}`,
          action: "review",
          fromMemberId: review.reviewerMemberId,
          toMemberId: memberId,
        });
      }
    }
  }
  const validation = validateTeamDefinition(definition, (agentId, revision) =>
    Object.values(members).some(
      (member) =>
        member.definition.agentId === agentId &&
        member.definition.revision === revision,
    ),
  );
  if (!validation.valid || !validation.execution.available)
    throw new AgentStoreError(
      "composed_workflow_invalid",
      [...validation.diagnostics, ...validation.execution.blockers]
        .map((item) => item.message)
        .join("; "),
    );
  if (serial) {
    const support = validateDirectoryTeamGraph(definition);
    if (!support.valid)
      throw new AgentStoreError(
        "composed_directory_workflow_invalid",
        support.diagnostics.map((item) => item.message).join("; "),
      );
  }
  return {
    revision: {
      teamId: addressedIdentity(input.operationId, "team"),
      revision: 1,
      ...teamHashes(definition),
      createdAt: input.createdAt,
    },
    members,
  };
}

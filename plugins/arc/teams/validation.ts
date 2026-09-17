import { createHash } from "node:crypto";
import { analyzeTeamReviewGrants } from "./review-grants.js";
import {
  MAX_TEAM_DEFINITION_BYTES,
  teamDefinitionSchema,
  type TeamDefinition,
  type TeamDiagnostic,
  type TeamNode,
  type TeamValidation,
} from "./contract.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function canonicalTeamDefinition(input: TeamDefinition): TeamDefinition {
  const value = teamDefinitionSchema.parse(input);
  const byId = <T extends { id: string }>(items: T[]) =>
    items.sort((a, b) => a.id.localeCompare(b.id, "en"));
  byId(value.groups);
  byId(value.members);
  byId(value.permissions);
  byId(value.graph.nodes);
  byId(value.graph.edges);
  byId(value.graph.requiredGates);
  value.graph.entryNodeIds.sort();
  for (const gate of value.graph.requiredGates) gate.nodeIds.sort();
  for (const node of value.graph.nodes) {
    if (node.kind === "delegation") node.candidateMemberIds.sort();
  }
  value.presentation.nodes.sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId, "en"),
  );
  value.presentation.groups.sort((a, b) =>
    a.groupId.localeCompare(b.groupId, "en"),
  );
  value.presentation.members?.sort((a, b) =>
    a.memberId.localeCompare(b.memberId, "en"),
  );
  for (const group of value.groups) group.color = group.color.toLowerCase();
  if (value.presentation.color !== undefined)
    value.presentation.color = value.presentation.color.toLowerCase();
  if (Buffer.byteLength(canonicalJson(value)) > MAX_TEAM_DEFINITION_BYTES)
    throw new Error("team_too_large: A team definition cannot exceed 1 MB");
  return value;
}

export function teamHashes(input: TeamDefinition) {
  const definition = canonicalTeamDefinition(input);
  const operational = {
    schemaVersion: definition.schemaVersion,
    ...(definition.leaderMemberId === undefined
      ? {}
      : { leaderMemberId: definition.leaderMemberId }),
    members: definition.members.map(
      ({
        id,
        agentId,
        revision,
        role,
        responsibility,
        leaderMemberId,
        skills,
        modelOverride,
      }) => ({
        id,
        agentId,
        revision,
        ...(role === undefined ? {} : { role }),
        ...(responsibility === undefined ? {} : { responsibility }),
        ...(leaderMemberId === undefined ? {} : { leaderMemberId }),
        ...(skills === undefined ? {} : { skills }),
        ...(modelOverride === undefined ? {} : { modelOverride }),
      }),
    ),
    permissions: definition.permissions,
    graph: {
      ...definition.graph,
      nodes: definition.graph.nodes.map(({ label: _label, ...node }) => node),
    },
  };
  const digest = (value: unknown) =>
    createHash("sha256").update(canonicalJson(value)).digest("hex");
  return {
    definition,
    contentHash: digest(definition),
    operationalHash: digest(operational),
  };
}

export function describeTeamChanges(
  before: TeamDefinition,
  after: TeamDefinition,
) {
  const a = teamHashes(before);
  const b = teamHashes(after);
  const keys = [
    "name",
    "description",
    "leaderMemberId",
    "groups",
    "members",
    "permissions",
    "graph",
    "presentation",
  ] as const;
  return {
    changedFields: keys.filter(
      (key) =>
        canonicalJson(a.definition[key]) !== canonicalJson(b.definition[key]),
    ),
    operationalChanges: a.operationalHash !== b.operationalHash,
  };
}

export function validateTeamDefinition(
  input: TeamDefinition,
  agentAvailable: (agentId: string, revision: number) => boolean,
): TeamValidation {
  const definition = canonicalTeamDefinition(input);
  const diagnostics: TeamDiagnostic[] = [];
  const add = (
    code: string,
    message: string,
    path: string,
    nodeIds: string[] = [],
  ) => diagnostics.push({ code, message, path, nodeIds });
  if (!definition.name)
    add("name_required", "Give this team a name before publishing.", "name");
  const unique = (values: string[], path: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value))
        add("duplicate_id", `Remove the duplicate reference '${value}'.`, path);
      seen.add(value);
    }
  };
  const groups = new Map(definition.groups.map((group) => [group.id, group]));
  const members = new Map(
    definition.members.map((member) => [member.id, member]),
  );
  const nodes = new Map(definition.graph.nodes.map((node) => [node.id, node]));
  for (const [name, values] of [
    ["groups", definition.groups],
    ["members", definition.members],
    ["permissions", definition.permissions],
    ["graph.nodes", definition.graph.nodes],
    ["graph.edges", definition.graph.edges],
    ["graph.requiredGates", definition.graph.requiredGates],
  ] as const)
    unique(
      values.map((value) => value.id),
      name,
    );
  unique(definition.graph.entryNodeIds, "graph.entryNodeIds");
  unique(
    definition.presentation.nodes.map((node) => node.nodeId),
    "presentation.nodes",
  );
  unique(
    definition.presentation.groups.map((group) => group.groupId),
    "presentation.groups",
  );
  for (const group of definition.groups) {
    if (!group.name)
      add(
        "name_required",
        "Give this group a name before publishing.",
        `groups.${group.id}.name`,
      );
    if (group.parentGroupId !== null && !groups.has(group.parentGroupId))
      add(
        "missing_group",
        `Choose an existing parent group for '${group.name}'.`,
        `groups.${group.id}`,
      );
    const seen = new Set([group.id]);
    let parent = group.parentGroupId;
    while (parent !== null) {
      if (seen.has(parent)) {
        add(
          "group_cycle",
          `Move '${group.name}' outside its own descendant groups.`,
          `groups.${group.id}`,
        );
        break;
      }
      seen.add(parent);
      parent = groups.get(parent)?.parentGroupId ?? null;
    }
  }
  for (const member of definition.members) {
    if (member.leaderMemberId != null && !members.has(member.leaderMemberId))
      add(
        "missing_leader",
        `Choose an existing leader for '${member.id}'.`,
        `members.${member.id}.leaderMemberId`,
      );
    const ancestors = new Set([member.id]);
    let leader = member.leaderMemberId;
    while (leader != null && members.has(leader)) {
      if (ancestors.has(leader)) {
        add(
          "leadership_cycle",
          "Leadership cannot loop back to the same member.",
          `members.${member.id}.leaderMemberId`,
        );
        break;
      }
      ancestors.add(leader);
      leader = members.get(leader)?.leaderMemberId;
    }
    if (member.groupId !== null && !groups.has(member.groupId))
      add(
        "missing_group",
        `Choose an existing group for member '${member.id}'.`,
        `members.${member.id}`,
      );
    if (!agentAvailable(member.agentId, member.revision))
      add(
        "agent_revision_unavailable",
        `Choose a published agent revision available in this team's scope for '${member.id}'.`,
        `members.${member.id}`,
      );
  }
  if (definition.leaderMemberId != null) {
    const leader = members.get(definition.leaderMemberId);
    if (!leader)
      add(
        "missing_team_leader",
        "Choose an existing member as the team lead.",
        "leaderMemberId",
      );
    else if (leader.leaderMemberId != null)
      add(
        "team_leader_reports_to",
        "The team lead cannot report to another member.",
        "leaderMemberId",
      );
  }
  unique(
    (definition.presentation.members ?? []).map((item) => item.memberId),
    "presentation.members",
  );
  for (const position of definition.presentation.members ?? [])
    if (!members.has(position.memberId))
      add(
        "missing_member",
        "Remove the position for a member that no longer exists.",
        "presentation.members",
      );
  const grants = new Set<string>();
  for (const grant of definition.permissions) {
    if (!members.has(grant.fromMemberId) || !members.has(grant.toMemberId))
      add(
        "missing_member",
        "Choose existing members for both ends of this collaboration grant.",
        `permissions.${grant.id}`,
      );
    if (grant.fromMemberId === grant.toMemberId)
      add(
        "self_grant",
        "Choose a different member as the collaboration recipient.",
        `permissions.${grant.id}`,
      );
    const key = `${grant.fromMemberId}:${grant.action}:${grant.toMemberId}`;
    if (grants.has(key))
      add(
        "duplicate_grant",
        "Remove this duplicate collaboration grant.",
        `permissions.${grant.id}`,
      );
    grants.add(key);
  }
  for (const item of definition.presentation.nodes) {
    if (!nodes.has(item.nodeId))
      add(
        "missing_node",
        "Remove the position for a node that no longer exists.",
        `presentation.nodes.${item.nodeId}`,
      );
  }
  for (const item of definition.presentation.groups) {
    if (!groups.has(item.groupId))
      add(
        "missing_group",
        "Remove the bounds for a group that no longer exists.",
        `presentation.groups.${item.groupId}`,
      );
  }
  const incoming = new Map<string, typeof definition.graph.edges>();
  const outgoing = new Map<string, typeof definition.graph.edges>();
  for (const node of nodes.values()) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  const edgeKeys = new Set<string>();
  for (const edge of definition.graph.edges) {
    const source = nodes.get(edge.source);
    if (!source || !nodes.has(edge.target)) {
      add(
        "missing_node",
        "Reconnect this edge to existing nodes.",
        `graph.edges.${edge.id}`,
        [edge.source, edge.target],
      );
      continue;
    }
    const edgeKey = `${edge.source}:${edge.sourceHandle}:${edge.target}`;
    if (edgeKeys.has(edgeKey))
      add(
        "duplicate_edge",
        "Remove this duplicate connection.",
        `graph.edges.${edge.id}`,
        [edge.source, edge.target],
      );
    edgeKeys.add(edgeKey);
    incoming.get(edge.target)?.push(edge);
    outgoing.get(edge.source)?.push(edge);
    const handles =
      source.kind === "condition"
        ? ["true", "false"]
        : source.kind === "repair"
          ? ["repaired", "exhausted"]
          : ["next"];
    if (!handles.includes(edge.sourceHandle))
      add(
        "invalid_handle",
        `Use ${handles.join(" or ")} as the output of '${source.label}'.`,
        `graph.edges.${edge.id}`,
        [source.id],
      );
    if (source.kind === "condition" && edge.requiredOutcome !== "succeeded")
      add(
        "invalid_branch_outcome",
        "Branch edges require a recorded successful decision; choose succeeded.",
        `graph.edges.${edge.id}`,
        [source.id],
      );
    if (
      source.kind === "repair" &&
      edge.requiredOutcome !==
        (edge.sourceHandle === "repaired" ? "succeeded" : "failed")
    )
      add(
        "invalid_repair_outcome",
        "Repaired requires a successful recheck; exhausted requires failed repair rounds.",
        `graph.edges.${edge.id}`,
        [source.id],
      );
  }
  function reachable(start: string, goal: string): boolean {
    const pending = [start];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      if (current === goal) return true;
      seen.add(current);
      for (const edge of outgoing.get(current) ?? []) pending.push(edge.target);
    }
    return false;
  }
  function unresolvedHandles(decisionId: string, inputId: string): Set<string> {
    const result = new Set<string>();
    for (const branch of outgoing.get(decisionId) ?? []) {
      const pending = [branch.target];
      const seen = new Set<string>();
      while (pending.length) {
        const current = pending.pop();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        const node = nodes.get(current);
        if (
          node?.kind === "join" &&
          node.mode === "selected" &&
          node.decisionNodeId === decisionId
        )
          continue;
        if (current === inputId) {
          result.add(branch.sourceHandle);
          break;
        }
        for (const edge of outgoing.get(current) ?? [])
          pending.push(edge.target);
      }
    }
    return result;
  }
  const indegrees = new Map(
    [...nodes.keys()].map((key) => [key, incoming.get(key)?.length ?? 0]),
  );
  const pending = [...indegrees]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) continue;
    visited++;
    for (const edge of outgoing.get(current) ?? []) {
      const count = (indegrees.get(edge.target) ?? 0) - 1;
      indegrees.set(edge.target, count);
      if (count === 0) pending.push(edge.target);
    }
  }
  if (visited !== nodes.size)
    add(
      "graph_cycle",
      "Remove the cycle; use a bounded repair stage for repeated work.",
      "graph.edges",
      [...indegrees].filter(([, count]) => count > 0).map(([key]) => key),
    );
  if (!nodes.size)
    add("nodes_required", "Add a stage to this team graph.", "graph.nodes");
  if (!definition.graph.entryNodeIds.length)
    add(
      "entry_required",
      "Choose at least one starting stage.",
      "graph.entryNodeIds",
    );
  for (const entry of definition.graph.entryNodeIds) {
    if (!nodes.has(entry))
      add(
        "missing_node",
        "Choose an existing starting stage.",
        "graph.entryNodeIds",
        [entry],
      );
    else if (incoming.get(entry)?.length)
      add(
        "entry_has_dependencies",
        "A starting stage cannot depend on another stage.",
        "graph.entryNodeIds",
        [entry],
      );
  }
  const requireAncestor = (reference: string, node: TeamNode, path: string) => {
    if (
      !nodes.has(reference) ||
      reference === node.id ||
      !reachable(reference, node.id)
    )
      add(
        "missing_dependency",
        `Connect the referenced stage '${reference}' before '${node.label}'.`,
        path,
        [node.id, reference],
      );
  };
  const memberReference = (reference: string, node: TeamNode) => {
    if (!members.has(reference))
      add(
        "missing_member",
        `Choose an existing member for '${node.label}'.`,
        `graph.nodes.${node.id}`,
        [node.id],
      );
  };
  const candidateReference = (
    reference: string,
    node: TeamNode,
    path: string,
  ) => {
    requireAncestor(reference, node, path);
    const candidate = nodes.get(reference);
    if (
      candidate &&
      !(
        candidate.kind === "integration" ||
        candidate.kind === "repair" ||
        (definition.schemaVersion === 2 &&
          candidate.kind === "join" &&
          candidate.mode === "selected") ||
        ((candidate.kind === "agent" || candidate.kind === "delegation") &&
          candidate.access === "write")
      )
    )
      add(
        "invalid_candidate",
        "Choose a writing stage, repair stage, integration, or version 2 selected join as the candidate source.",
        path,
        [node.id, candidate.id],
      );
  };
  for (const node of nodes.values()) {
    const path = `graph.nodes.${node.id}`;
    if (!node.label)
      add(
        "label_required",
        "Give this stage a name before publishing.",
        `${path}.label`,
        [node.id],
      );
    if ("task" in node && !node.task)
      add(
        "task_required",
        "Describe the work this stage should perform.",
        `${path}.task`,
        [node.id],
      );
    if (node.kind === "repair" && !node.body.task)
      add(
        "task_required",
        "Describe the repair work to perform after a failed check.",
        `${path}.body.task`,
        [node.id],
      );
    if (node.kind === "approval" && !node.message)
      add(
        "message_required",
        "Describe what the user will approve.",
        `${path}.message`,
        [node.id],
      );
    if (node.kind === "check" && !node.command.executable)
      add(
        "command_required",
        "Choose the executable for this native check.",
        `${path}.command.executable`,
        [node.id],
      );
    const inputs = incoming.get(node.id) ?? [];
    const outputs = outgoing.get(node.id) ?? [];
    if (
      !definition.graph.entryNodeIds.some((entry) => reachable(entry, node.id))
    )
      add(
        "unreachable_node",
        `Connect '${node.label}' to a starting stage.`,
        path,
        [node.id],
      );
    if (node.kind === "agent" || node.kind === "review")
      memberReference(node.memberId, node);
    if ("candidate" in node && node.candidate?.kind === "node") {
      candidateReference(node.candidate.nodeId, node, `${path}.candidate`);
    }
    if (node.kind === "parallel" && outputs.length < 2)
      add(
        "parallel_branches",
        "Connect at least two branches to this parallel stage.",
        path,
        [node.id],
      );
    if (node.kind === "condition") {
      requireAncestor(node.predicate.sourceNodeId, node, `${path}.predicate`);
      const source = nodes.get(node.predicate.sourceNodeId);
      const expected =
        node.predicate.kind === "check-exit"
          ? "check"
          : node.predicate.kind === "review-verdict"
            ? "review"
            : node.predicate.kind === "approval"
              ? "approval"
              : null;
      if (expected && source?.kind !== expected)
        add(
          "invalid_condition_source",
          `Choose a ${expected} stage for this condition.`,
          `${path}.predicate`,
          [node.id],
        );
      for (const handle of ["true", "false"])
        if (!outputs.some((edge) => edge.sourceHandle === handle))
          add(
            "missing_branch",
            `Connect the ${handle} branch of '${node.label}'.`,
            path,
            [node.id],
          );
    }
    if (node.kind === "join") {
      if (inputs.length < 2)
        add(
          "join_inputs",
          "Connect at least two branches to this join.",
          path,
          [node.id],
        );
      if (node.mode === "all" && node.decisionNodeId !== null)
        add(
          "invalid_join_decision",
          "Use selected mode for a condition-controlled join, or clear its decision.",
          path,
          [node.id],
        );
      if (node.mode === "selected") {
        const decision =
          node.decisionNodeId === null
            ? undefined
            : nodes.get(node.decisionNodeId);
        if (decision?.kind !== "condition")
          add(
            "missing_join_decision",
            "Choose the condition whose selected branch this join waits for.",
            path,
            [node.id],
          );
        else {
          requireAncestor(decision.id, node, `${path}.decisionNodeId`);
          const coverage = new Set<string>();
          for (const edge of inputs) {
            const handles =
              edge.source === decision.id
                ? new Set([edge.sourceHandle])
                : unresolvedHandles(decision.id, edge.source);
            if (handles.size !== 1)
              add(
                "outside_selected_branch",
                "Each selected join input must belong to one unreconciled branch of its controlling condition.",
                path,
                [node.id, edge.source],
              );
            for (const handle of handles) coverage.add(handle);
            for (const nested of nodes.values()) {
              if (
                nested.kind === "condition" &&
                nested.id !== decision.id &&
                reachable(decision.id, nested.id) &&
                unresolvedHandles(nested.id, edge.source).size
              )
                add(
                  "unresolved_nested_branch",
                  "Join the nested condition's alternatives before feeding its enclosing selected join.",
                  path,
                  [node.id, nested.id],
                );
            }
          }
          if (!coverage.has("true") || !coverage.has("false"))
            add(
              "missing_join_branch",
              "Connect both alternatives of the controlling condition to its selected join.",
              path,
              [node.id, decision.id],
            );
        }
      }
      if (node.mode === "all") {
        for (const decision of nodes.values()) {
          if (decision.kind !== "condition") continue;
          const reachesInput = (handle: string) =>
            inputs.some((edge) =>
              edge.source === decision.id
                ? edge.sourceHandle === handle
                : unresolvedHandles(decision.id, edge.source).has(handle),
            );
          if (reachesInput("true") && reachesInput("false"))
            add(
              "exclusive_all_join",
              "Use a selected join bound to the condition when joining its alternative branches.",
              path,
              [node.id, decision.id],
            );
        }
      }
    }
    if (node.kind === "repair") {
      memberReference(node.body.memberId, node);
      requireAncestor(node.checkNodeId, node, `${path}.checkNodeId`);
      if (nodes.get(node.checkNodeId)?.kind !== "check")
        add(
          "invalid_repair_check",
          "Choose a native check stage whose command will be repeated after each repair.",
          path,
          [node.id],
        );
      if (
        !inputs.some(
          (edge) =>
            edge.source === node.checkNodeId &&
            edge.requiredOutcome === "failed",
        )
      )
        add(
          "repair_failure_required",
          "Connect the selected check's failed outcome directly to this repair stage.",
          path,
          [node.id],
        );
    }
    if (node.kind === "integration") {
      unique(node.writerNodeIds, `${path}.writerNodeIds`);
      if (!node.writerNodeIds.length)
        add(
          "writers_required",
          "Choose writing stages to integrate in the listed order.",
          path,
          [node.id],
        );
      if (node.baseCandidate.kind === "node")
        candidateReference(
          node.baseCandidate.nodeId,
          node,
          `${path}.baseCandidate`,
        );
      for (const writerId of node.writerNodeIds) {
        requireAncestor(writerId, node, `${path}.writerNodeIds`);
        const writer = nodes.get(writerId);
        if (
          !writer ||
          !(
            ((writer.kind === "agent" || writer.kind === "delegation") &&
              writer.access === "write") ||
            (definition.schemaVersion === 2 &&
              (writer.kind === "repair" ||
                writer.kind === "integration" ||
                (writer.kind === "join" && writer.mode === "selected")))
          )
        )
          add(
            "invalid_writer",
            "Integration inputs must reference writing stages or version 2 candidate-producing repair, integration, or selected join stages.",
            path,
            [node.id, writerId],
          );
      }
    }
    if (node.kind === "delegation") {
      memberReference(node.requesterMemberId, node);
      if (!node.candidateMemberIds.length)
        add(
          "delegation_candidates_required",
          "Choose at least one permitted delegation recipient.",
          path,
          [node.id],
        );
      unique(node.candidateMemberIds, `${path}.candidateMemberIds`);
      for (const candidate of node.candidateMemberIds) {
        memberReference(candidate, node);
        if (!grants.has(`${node.requesterMemberId}:delegate:${candidate}`))
          add(
            "delegation_grant_required",
            "Add a directed delegation grant from the requester to each permitted candidate.",
            path,
            [node.id],
          );
      }
    }
  }
  if (!definition.graph.requiredGates.length)
    add(
      "gates_required",
      "Choose the checks, reviews, or approvals required for completion.",
      "graph.requiredGates",
    );
  for (const gate of definition.graph.requiredGates) {
    unique(gate.nodeIds, `graph.requiredGates.${gate.id}`);
    if (!gate.nodeIds.length)
      add(
        "empty_gate",
        "Choose at least one required stage for this gate.",
        `graph.requiredGates.${gate.id}`,
      );
    for (const nodeId of gate.nodeIds) {
      const node = nodes.get(nodeId);
      if (
        !node ||
        !["check", "review", "approval", "repair", "release"].includes(
          node.kind,
        )
      )
        add(
          "invalid_gate",
          "Required gates must reference checks, reviews, approvals, bounded rechecks, or releases.",
          `graph.requiredGates.${gate.id}`,
          [nodeId],
        );
    }
  }
  for (const decision of nodes.values()) {
    if (decision.kind !== "condition") continue;
    const onBranch = (handle: string) =>
      definition.graph.requiredGates.flatMap((gate) =>
        gate.mode === "all"
          ? gate.nodeIds.filter((nodeId) =>
              unresolvedHandles(decision.id, nodeId).has(handle),
            )
          : gate.nodeIds.length &&
              gate.nodeIds.every((nodeId) => {
                const handles = unresolvedHandles(decision.id, nodeId);
                return handles.size === 1 && handles.has(handle);
              })
            ? gate.nodeIds
            : [],
      );
    const trueNodes = onBranch("true");
    const falseNodes = onBranch("false");
    if (trueNodes.length && falseNodes.length)
      add(
        "exclusive_required_gates",
        "Required completion cannot demand both alternatives of a condition. Use an any gate for alternatives or place the required gate after their selected join.",
        "graph.requiredGates",
        [...new Set([...trueNodes, ...falseNodes])],
      );
  }
  diagnostics.push(...analyzeTeamReviewGrants(definition).diagnostics);
  const blockers: TeamDiagnostic[] = [];
  for (const node of nodes.values())
    if (node.kind === "release")
      blockers.push({
        code: "release_unavailable",
        message:
          "Release requires the later configured factory capability; this stage cannot run or count as successful.",
        path: `graph.nodes.${node.id}`,
        nodeIds: [node.id],
      });
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    execution: {
      available: diagnostics.length === 0 && blockers.length === 0,
      blockers,
    },
  };
}

import {
  ownedRunStartV2Schema,
  type OwnedAdmittedStepV2,
  type OwnedControlDeclaration,
  type OwnedReceiptRequirement,
  type OwnedRequirement,
  type OwnedRunStartV2,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import type { TeamEdge, TeamNode } from "../teams/contract.js";
import { teamHashes, validateTeamDefinition } from "../teams/validation.js";
import { runtimeNodeKey } from "./compiler.js";
import {
  graphCompilerReferencesSchema,
  graphRunDefinitionSchema,
  graphRuntimeNodeSchema,
  type GraphCompilerReferences,
  type GraphControlOperation,
  type GraphNodeOutput,
  type GraphRunDefinition,
  type GraphRuntimeNode,
} from "./graph-contract.js";
import { runtimeHash } from "./hash.js";
import { compositionAllowedByPolicy } from "./composition-authorization.js";
import { validateDirectoryTeamGraph } from "./directory-graph-validation.js";
import {
  directoryRunDefinitionSchema,
  directoryRuntimeNodeSchema,
  type DirectoryRunDefinition,
  type DirectoryRuntimeNode,
} from "./directory-contract.js";

export const compiledGraphRunSchema = z
  .object({
    definition: graphRunDefinitionSchema,
    nodes: z.record(z.string(), graphRuntimeNodeSchema),
    workflow: ownedRunStartV2Schema,
    references: graphCompilerReferencesSchema,
  })
  .strict();
export type CompiledGraphRun = z.infer<typeof compiledGraphRunSchema>;

export class GraphCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nodeIds: string[] = [],
  ) {
    super(message);
    this.name = "GraphCompileError";
  }
}

type Guard = { decision: OwnedStepRef; output: string };
type Guards = Map<string, Guard>;
type OutcomeGuards = Map<string, Set<"succeeded" | "failed">>;
type Repair = OwnedAdmittedStepV2["repair"];

const receipt = (
  step: OwnedStepRef,
  outcomes: OwnedReceiptRequirement["outcomes"] = ["succeeded"],
): OwnedReceiptRequirement => ({ kind: "receipt", step, outcomes });
const selection = (
  decision: OwnedStepRef,
  output: string,
): OwnedRequirement => ({ kind: "selection", decision, output });
const nextOutput: OwnedControlDeclaration = {
  outputs: [{ id: "next", outcome: "succeeded" }],
};
const conditionOutputs: OwnedControlDeclaration = {
  outputs: [
    { id: "true", outcome: "succeeded" },
    { id: "false", outcome: "succeeded" },
  ],
};
const repairOutputs: OwnedControlDeclaration = {
  outputs: [
    { id: "repaired", outcome: "succeeded" },
    { id: "exhausted", outcome: "failed" },
  ],
};
const approvalOutputs: OwnedControlDeclaration = {
  outputs: [
    { id: "approved", outcome: "succeeded" },
    { id: "rejected", outcome: "failed" },
  ],
};
const delegationOutputs: OwnedControlDeclaration = {
  outputs: [
    { id: "next", outcome: "succeeded" },
    { id: "rejected", outcome: "failed" },
  ],
};

function stepRef(nodeId: string, role: string, iteration = 0): OwnedStepRef {
  return {
    nodeId: `arcg_${runtimeHash({ nodeId, role }).slice(0, 32)}`,
    iteration,
  };
}

function sourceProgram(
  steps: OwnedAdmittedStepV2[],
  gates: OwnedRunStartV2["requiredGates"],
  compact: boolean,
): string {
  const refs = steps.map(({ nodeId, iteration }) => [nodeId, iteration]);
  const indexes = new Map(
    steps.map((step, index) => [runtimeNodeKey(step), index]),
  );
  const indexOf = (ref: OwnedStepRef): number => {
    const index = indexes.get(runtimeNodeKey(ref));
    if (index === undefined)
      throw new GraphCompileError(
        "missing_compiled_step",
        "A compiled requirement references an unavailable step.",
      );
    return index;
  };
  const compactReceipt = (value: OwnedReceiptRequirement) => [
    indexOf(value.step),
    value.outcomes,
  ];
  const compactRequirement = (value: OwnedRequirement) =>
    value.kind === "receipt"
      ? [0, ...compactReceipt(value)]
      : value.kind === "selection"
        ? [1, indexOf(value.decision), value.output]
        : [
            2,
            indexOf(value.decision),
            value.branches.map((branch) => [
              branch.output,
              branch.receipts.map(compactReceipt),
            ]),
          ];
  const program = steps.map((step) =>
    step.requirements.map(compactRequirement),
  );
  const compactGates = gates.map((gate) => [
    gate.gateId,
    gate.mode,
    gate.steps.map(indexOf),
  ]);
  const data = compact
    ? `const refs = ${JSON.stringify(refs)}.map(([nodeId,iteration]) => ({nodeId,iteration}));
const readReceipt = ([index,outcomes]) => ({kind:"receipt",step:refs[index],outcomes});
const readRequirement = value => value[0] === 0 ? readReceipt(value.slice(1)) : value[0] === 1 ? {kind:"selection",decision:refs[value[1]],output:value[2]} : {kind:"selected",decision:refs[value[1]],branches:value[2].map(([output,receipts]) => ({output,receipts:receipts.map(readReceipt)}))};
const plan = Object.fromEntries(${JSON.stringify(program)}.map((requirements,index) => [refs[index].nodeId + ":" + refs[index].iteration,{ref:refs[index],requirements:requirements.map(readRequirement)}]));
const gates = ${JSON.stringify(compactGates)}.map(([gateId,mode,indexes]) => ({gateId,mode,steps:indexes.map(index => refs[index])}));`
    : `const plan = ${JSON.stringify(Object.fromEntries(steps.map((step) => [runtimeNodeKey(step), { ref: { nodeId: step.nodeId, iteration: step.iteration }, requirements: step.requirements }])))};
const gates = ${JSON.stringify(gates)};`;
  return `export const meta = { name: "arc-graph-run", description: "Published team graph with admitted decisions and exact candidate verification" };
${data}
const pending = {};
const key = ref => ref.nodeId + ":" + ref.iteration;
async function run(ref) {
  const id = key(ref);
  if (pending[id]) return pending[id];
  const item = plan[id];
  if (!item) throw new Error("Compiled step is unavailable: " + id);
  pending[id] = (async () => {
    for (const requirement of item.requirements) {
      if (requirement.kind !== "selection") continue;
      const decision = await run(requirement.decision);
      if (decision.state === "inactive") return decision;
      if (!decision.receipt || !Array.isArray(decision.receipt.selectedOutputs)) throw new Error("Missing recorded branch decision");
      if (!decision.receipt.selectedOutputs.includes(requirement.output)) return {state:"inactive",receipt:null};
    }
    for (const requirement of item.requirements) {
      if (requirement.kind === "selection") continue;
      let receipts;
      if (requirement.kind === "receipt") receipts = [requirement];
      else {
        const decision = await run(requirement.decision);
        if (decision.state === "inactive") return decision;
        if (!decision.receipt || !Array.isArray(decision.receipt.selectedOutputs)) throw new Error("Missing recorded join decision");
        receipts = [];
        for (const output of decision.receipt.selectedOutputs) {
          const branch = requirement.branches.find(branch => branch.output === output);
          if (!branch) throw new Error("Unadmitted selected branch");
          receipts.push(...branch.receipts);
        }
      }
      for (const required of receipts) {
        const result = await run(required.step);
        if (!required.outcomes.includes(result.state)) return {state:"inactive",receipt:null};
      }
    }
    try { return {state:"succeeded",receipt:await step(ref.nodeId,ref.iteration,null)}; }
    catch (error) {
      if (!error.stepFailure || error.stepFailure.state !== "failed") throw error;
      return {state:"failed",receipt:error.stepFailure.receipt};
    }
  })();
  return pending[id];
}
const outcomes = await parallelSettled(Object.values(plan).map(item => async () => run(item.ref)));
requireSuccess(outcomes);
const completed = [];
for (const gate of gates) {
  const results = await Promise.all(gate.steps.map(run));
  const successful = results.filter(result => result.state === "succeeded");
  if (gate.mode === "all" ? successful.length !== results.length : successful.length === 0) throw new Error("Required gate did not succeed: " + gate.gateId);
  completed.push(gate.gateId);
}
return {requiredGates:completed};`;
}

export function lowerArcTeamGraph(
  input: GraphRunDefinition | DirectoryRunDefinition,
) {
  const definition =
    input.schemaVersion === 4
      ? directoryRunDefinitionSchema.parse(input)
      : graphRunDefinitionSchema.parse(input);
  const team = definition.team.definition;
  const hashes = teamHashes(team);
  if (
    hashes.contentHash !== definition.team.contentHash ||
    hashes.operationalHash !== definition.team.operationalHash
  )
    throw new GraphCompileError(
      "team_revision_changed",
      "The sealed team content does not match its published revision.",
    );
  if (
    definition.team.teamId !== definition.request.team.teamId ||
    definition.team.revision !== definition.request.team.revision
  )
    throw new GraphCompileError(
      "team_revision_mismatch",
      "Select the exact published team revision used by this run.",
    );
  if (
    definition.schemaVersion !== 4 &&
    definition.source.head !== definition.request.expectedHead
  )
    throw new GraphCompileError(
      "source_changed",
      "The source revision changed before the graph was sealed.",
    );
  if (
    !compositionAllowedByPolicy({
      projectId: definition.request.projectId,
      team: definition.team,
      members: definition.members,
      policy: definition.policy,
      ...(definition.compositionAuthorization === undefined
        ? {}
        : { compositionAuthorization: definition.compositionAuthorization }),
    })
  )
    throw new GraphCompileError(
      "team_restricted",
      "This team revision is outside the resolved session restriction.",
    );
  if (Object.keys(definition.members).length !== team.members.length)
    throw new GraphCompileError(
      "member_snapshot_mismatch",
      "Every team member must have one exact agent snapshot.",
    );
  for (const member of team.members) {
    const snapshot = definition.members[member.id];
    if (
      !snapshot ||
      snapshot.definition.agentId !== member.agentId ||
      snapshot.definition.revision !== member.revision
    )
      throw new GraphCompileError(
        "member_snapshot_mismatch",
        `Member '${member.id}' does not match its published agent revision.`,
      );
    if (
      member.modelOverride !== undefined &&
      (snapshot.execution.providerId !== member.modelOverride.providerId ||
        snapshot.execution.model !== member.modelOverride.model ||
        snapshot.execution.reasoningLevel !==
          member.modelOverride.reasoningLevel ||
        snapshot.execution.serviceTier !== member.modelOverride.serviceTier)
    )
      throw new GraphCompileError(
        "member_execution_mismatch",
        `Member '${member.id}' does not match its pinned team model selection.`,
      );
  }
  const validation = validateTeamDefinition(team, (agentId, revision) =>
    team.members.some(
      (member) => member.agentId === agentId && member.revision === revision,
    ),
  );
  if (!validation.valid) {
    const issue = validation.diagnostics[0];
    throw new GraphCompileError(
      issue?.code ?? "invalid_team",
      issue?.message ?? "The team graph is invalid.",
      issue?.nodeIds,
    );
  }
  const release = team.graph.nodes.find((node) => node.kind === "release");
  if (release)
    throw new GraphCompileError(
      "release_unavailable",
      "Release stages require the configured Phase 6 factory capability.",
      [release.id],
    );

  if (definition.schemaVersion === 4) {
    if (
      definition.source.path !== definition.request.path ||
      definition.source.manifestDigest !==
        definition.request.expectedSource.manifestDigest ||
      runtimeHash(definition.source.rootIdentity) !==
        runtimeHash(definition.request.expectedSource.rootIdentity)
    )
      throw new GraphCompileError(
        "source_changed",
        "The directory source changed before the graph was sealed.",
      );
    const issue = validateDirectoryTeamGraph(team).diagnostics[0];
    if (issue)
      throw new GraphCompileError(issue.code, issue.message, issue.nodeIds);
  }
  const nodes: Record<string, GraphRuntimeNode | DirectoryRuntimeNode> = {};
  const steps: OwnedAdmittedStepV2[] = [];
  const source: OwnedStepRef = { nodeId: "arcg_source", iteration: 0 };
  const planApproval: OwnedStepRef | null =
    definition.policy.autonomy === "collaborative"
      ? { nodeId: "arcg_plan_approval", iteration: 0 }
      : null;
  const references: GraphCompilerReferences = {
    source,
    outputs: {},
    origins: {},
    consumedFailures: [],
    finalGates: [],
  };
  const graphNodes = new Map(team.graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(
    team.graph.nodes.map((node) => [
      node.id,
      team.graph.edges.filter((edge) => edge.target === node.id),
    ]),
  );
  const guards = new Map<string, Guards>();
  const outcomeGuards = new Map<string, OutcomeGuards>();
  const ancestors = new Map<string, Set<string>>();
  const lineage = new Map<string, Set<string>>();

  function outputFor(id: string): GraphNodeOutput {
    const result = references.outputs[id];
    if (!result)
      throw new GraphCompileError(
        "missing_compiled_output",
        `Stage '${id}' has no compiled output.`,
        [id],
      );
    return result;
  }
  function candidateFor(
    candidate: { kind: "source" } | { kind: "node"; nodeId: string },
  ): OwnedStepRef {
    if (candidate.kind === "source") return source;
    const output = outputFor(candidate.nodeId).candidate;
    if (!output)
      throw new GraphCompileError(
        "candidate_unavailable",
        `Stage '${candidate.nodeId}' does not produce a candidate.`,
        [candidate.nodeId],
      );
    return output;
  }
  function add(
    ref: OwnedStepRef,
    node: GraphRuntimeNode | DirectoryRuntimeNode,
    requirements: OwnedRequirement[],
    graphNodeId: string | null,
    member: string | null = null,
    repair: Repair = null,
    control: OwnedControlDeclaration | null = null,
  ): OwnedStepRef {
    if (steps.length >= 4096)
      throw new GraphCompileError(
        "compiled_graph_too_large",
        "Reduce delegation slots or stages to keep the compiled graph within 4,096 admitted steps.",
        graphNodeId ? [graphNodeId] : [],
      );
    const key = runtimeNodeKey(ref);
    if (nodes[key])
      throw new GraphCompileError(
        "duplicate_compiled_step",
        `Duplicate compiled identity '${key}'.`,
      );
    nodes[key] =
      definition.schemaVersion === 4
        ? directoryRuntimeNodeSchema.parse(node)
        : graphRuntimeNodeSchema.parse(node);
    references.origins[key] = { graphNodeId, memberId: member };
    const workspace = "workspace" in node ? node.workspace : null;
    steps.push({
      ...ref,
      kind:
        node.kind === "control"
          ? "owner-control"
          : node.kind === "agent"
            ? "agent"
            : "host-effect",
      definitionHash: runtimeHash(node),
      requirements: [...requirements],
      control,
      repair,
      lane:
        definition.schemaVersion === 4
          ? node.kind === "control" || node.kind === "verify"
            ? null
            : {
                hostId: definition.request.hostId,
                repositoryId: runtimeHash({
                  kind: "directory",
                  hostId: definition.request.hostId,
                  originalPath: definition.source.path,
                  rootIdentity: definition.source.rootIdentity,
                }),
                target: {
                  kind: "environment",
                  id: `${definition.runId}:directory`,
                },
              }
          : workspace === null
            ? null
            : {
                hostId: definition.request.hostId,
                repositoryId: runtimeHash({
                  hostId: definition.request.hostId,
                  commonGitDir: definition.source.commonGitDir,
                }),
                target: {
                  kind: "environment",
                  id: `${definition.runId}:${runtimeNodeKey(workspace)}`,
                },
              },
    });
    return ref;
  }
  function control(
    id: string,
    role: string,
    operation: GraphControlOperation,
    requirements: OwnedRequirement[],
    declaration = nextOutput,
    iteration = 0,
    repair: Repair = null,
  ): OwnedStepRef {
    return add(
      stepRef(id, role, iteration),
      { kind: "control", operation },
      requirements,
      id,
      null,
      repair,
      declaration,
    );
  }
  function fork(
    id: string,
    role: string,
    candidate: OwnedStepRef,
    requirements: OwnedRequirement[],
    iteration = 0,
    repair: Repair = null,
  ): OwnedStepRef {
    const ref = stepRef(id, role, iteration);
    return add(
      ref,
      {
        kind:
          definition.schemaVersion === 4
            ? "materialize-directory"
            : "fork-worktree",
        workspaceKey: runtimeHash({ id, role, iteration }).slice(0, 40),
        candidate,
      },
      [...requirements, receipt(candidate)],
      id,
      null,
      repair,
    );
  }
  function agent(
    id: string,
    role: string,
    member: string,
    purpose: Extract<GraphRuntimeNode, { kind: "agent" }>["purpose"],
    access: "read" | "write",
    task: string,
    candidate: OwnedStepRef,
    requirements: OwnedRequirement[],
    iteration = 0,
    failure: OwnedStepRef | null = null,
    repair: Repair = null,
    delegationPoint: string | null = null,
    replyDecision: OwnedStepRef | null = null,
  ): { outcome: OwnedStepRef; candidate: OwnedStepRef } {
    const snapshot = definition.members[member];
    if (!snapshot)
      throw new GraphCompileError(
        "member_snapshot_mismatch",
        `Member '${member}' has no sealed agent snapshot.`,
        [id],
      );
    const workspace =
      purpose === "review" && definition.schemaVersion !== 4
        ? candidate
        : fork(
            id,
            `${role}-workspace`,
            candidate,
            requirements,
            iteration,
            repair,
          );
    const communication =
      replyDecision === null
        ? dialogueCheckpoint(
            id,
            role,
            workspace,
            [...requirements, receipt(workspace)],
            iteration,
          )
        : null;
    const prerequisites = [
      ...requirements,
      receipt(workspace),
      ...(communication === null ? [] : [receipt(communication)]),
    ];
    if (definition.policy.autonomy === "guided") {
      const approval = control(
        id,
        `${role}-approval`,
        {
          type: "approval",
          message: `Allow ${snapshot.definition.metadata.name} to ${access === "write" ? "edit" : "inspect"} this candidate for the assigned task?\n\n${task}`,
          candidate: workspace,
        },
        prerequisites,
        approvalOutputs,
        iteration,
        repair,
      );
      prerequisites.push(receipt(approval));
    }
    const worker = add(
      stepRef(id, role, iteration),
      {
        kind: "agent",
        purpose,
        memberId: member,
        access,
        agent: snapshot,
        task,
        workspace,
        candidate: workspace,
        failure,
        delegationPoint,
        ...(replyDecision === null ? {} : { replyDecision }),
      },
      prerequisites,
      id,
      member,
      repair,
    );
    if (access === "read") return { outcome: worker, candidate };
    const commit = add(
      stepRef(id, `${role}-commit`, iteration),
      definition.schemaVersion === 4
        ? {
            kind: "capture-directory",
            workspace,
            worker,
            workspaceKey: runtimeHash({
              id,
              role,
              iteration,
              phase: "capture",
            }).slice(0, 40),
          }
        : {
            kind: "commit",
            workspace,
            worker,
            message: `ARC: ${definition.runId} ${id} ${role} ${iteration}`,
          },
      [receipt(worker)],
      id,
      member,
      repair,
    );
    return { outcome: commit, candidate: commit };
  }
  function dialogueCheckpoint(
    id: string,
    role: string,
    candidate: OwnedStepRef,
    requirements: OwnedRequirement[],
    iteration: number,
  ): OwnedStepRef | null {
    const eligible = [
      ...new Set(
        team.permissions
          .filter(
            (grant) =>
              grant.action === "message" &&
              team.permissions.some(
                (reverse) =>
                  reverse.action === "message" &&
                  reverse.fromMemberId === grant.toMemberId &&
                  reverse.toMemberId === grant.fromMemberId,
              ),
          )
          .map((grant) => grant.toMemberId),
      ),
    ];
    if (eligible.length === 0) return null;
    let current = candidate;
    for (let round = 0; round < 2; round++) {
      const slot = `${role}-dialogue-${round}`;
      const decision = control(
        id,
        `${slot}-decision`,
        {
          type: "message-response",
          candidate: current,
          candidateMemberIds: eligible,
        },
        [...requirements, receipt(current)],
        {
          outputs: [
            { id: "skip", outcome: "succeeded" },
            ...eligible.map((member) => ({
              id: `member:${member}`,
              outcome: "succeeded" as const,
            })),
          ],
        },
        iteration,
      );
      const branches = [{ output: "skip", candidate: current, check: null }];
      const selectedBranches = [
        { output: "skip", receipts: [receipt(current)] },
      ];
      for (const member of eligible) {
        const response = agent(
          id,
          `${slot}-${runtimeHash(member).slice(0, 12)}`,
          member,
          "reader",
          "read",
          "Answer the one selected inbox question using the pinned workspace. Submit arc_run_message kind reply referencing that question. Do not edit files or alter workflow authority. You may ask a further permitted question; later checkpoints admit responses within the shared limits.",
          current,
          [
            ...requirements,
            selection(decision, `member:${member}`),
            receipt(decision),
            receipt(current),
          ],
          iteration,
          null,
          null,
          null,
          decision,
        );
        branches.push({
          output: `member:${member}`,
          candidate: current,
          check: null,
        });
        selectedBranches.push({
          output: `member:${member}`,
          receipts: [receipt(response.outcome), receipt(current)],
        });
      }
      current = control(
        id,
        `${slot}-result`,
        { type: "candidate-choice", decision, branches },
        [
          ...requirements,
          { kind: "selected", decision, branches: selectedBranches },
        ],
        nextOutput,
        iteration,
      );
    }
    return current;
  }
  function edgeGuard(edge: TeamEdge): Guards {
    const result = new Map(guards.get(edge.source));
    if (edge.sourceHandle !== "next") {
      const decision = outputFor(edge.source).outcome;
      result.set(runtimeNodeKey(decision), {
        decision,
        output: edge.sourceHandle,
      });
    }
    return result;
  }
  function mergeGuards(parts: Guards[], removed: string | null): Guards {
    const result: Guards = new Map();
    for (const part of parts)
      for (const [key, value] of part) {
        if (key === removed) continue;
        const previous = result.get(key);
        if (previous && previous.output !== value.output)
          throw new GraphCompileError(
            "exclusive_graph_inputs",
            "Alternative writing paths require an explicit selected join.",
          );
        result.set(key, value);
      }
    return result;
  }
  function conditions(values: Guards): OwnedRequirement[] {
    return [...values.values()].map((value) =>
      selection(value.decision, value.output),
    );
  }
  function requirementsFor(
    node: TeamNode,
    edges: TeamEdge[],
  ): OwnedRequirement[] {
    const decision =
      node.kind === "join" &&
      node.mode === "selected" &&
      node.decisionNodeId !== null
        ? outputFor(node.decisionNodeId).outcome
        : null;
    const inputGuards = edges.map(edgeGuard);
    const sharedGuards =
      decision !== null && team.schemaVersion === 2
        ? inputGuards.map(
            (values) =>
              new Map(
                [...values].filter(([key, value]) =>
                  inputGuards.every(
                    (other) => other.get(key)?.output === value.output,
                  ),
                ),
              ),
          )
        : inputGuards;
    const nodeGuards = mergeGuards(
      sharedGuards,
      decision === null ? null : runtimeNodeKey(decision),
    );
    guards.set(node.id, nodeGuards);
    const edgeOutcomes = edges.map((edge) => {
      const values = new Map(outcomeGuards.get(edge.source));
      values.set(
        runtimeNodeKey(outputFor(edge.source).outcome),
        new Set(
          edge.requiredOutcome === "completed"
            ? ["succeeded", "failed"]
            : [edge.requiredOutcome],
        ),
      );
      return values;
    });
    const outcomes: OutcomeGuards = new Map();
    for (const values of edgeOutcomes)
      for (const [key, possible] of values) {
        if (decision !== null) {
          if (edgeOutcomes.every((entry) => entry.has(key)))
            outcomes.set(
              key,
              new Set(
                edgeOutcomes.flatMap((entry) => [...(entry.get(key) ?? [])]),
              ),
            );
        } else {
          const previous = outcomes.get(key);
          outcomes.set(
            key,
            new Set(
              [...possible].filter(
                (value) => previous === undefined || previous.has(value),
              ),
            ),
          );
        }
      }
    outcomeGuards.set(node.id, outcomes);
    const requirements = [
      ...conditions(nodeGuards),
      ...(planApproval === null ? [] : [receipt(planApproval)]),
    ];
    const fromEdge = (edge: TeamEdge) =>
      receipt(
        outputFor(edge.source).outcome,
        edge.requiredOutcome === "completed"
          ? ["succeeded", "failed"]
          : [edge.requiredOutcome],
      );
    if (decision !== null) {
      const declared = steps.find(
        (step) => runtimeNodeKey(step) === runtimeNodeKey(decision),
      )?.control;
      if (!declared)
        throw new GraphCompileError(
          "selected_join_decision",
          "The selected join needs a declared branch decision.",
          [node.id],
        );
      const branches = declared.outputs.map(({ id }) => ({
        output: id,
        receipts: edges
          .filter(
            (edge) =>
              edgeGuard(edge).get(runtimeNodeKey(decision))?.output === id,
          )
          .map(fromEdge),
      }));
      for (const edge of edges)
        if (!edgeGuard(edge).has(runtimeNodeKey(decision)))
          requirements.push(fromEdge(edge));
      requirements.push({ kind: "selected", decision, branches });
    } else requirements.push(...edges.map(fromEdge));
    return requirements;
  }

  if (planApproval !== null)
    add(
      planApproval,
      {
        kind: "control",
        operation: {
          type: "approval",
          message: `Approve this published team plan for the requested goal?\n\n${definition.request.goal}`,
          candidate: null,
        },
      },
      [],
      null,
      null,
      null,
      approvalOutputs,
    );
  add(
    source,
    {
      kind:
        definition.schemaVersion === 4 ? "capture-source" : "prepare-worktree",
      workspaceKey: "graph-source",
    },
    planApproval === null ? [] : [receipt(planApproval)],
    null,
  );
  const remaining = new Set(team.graph.nodes.map((node) => node.id));
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        (incoming.get(id) ?? []).every((edge) => !remaining.has(edge.source)),
      )
      .sort();
    if (!ready.length)
      throw new GraphCompileError(
        "graph_cycle",
        "The execution graph must be acyclic.",
      );
    for (const id of ready) {
      const node = graphNodes.get(id);
      if (!node)
        throw new GraphCompileError(
          "missing_graph_node",
          `Stage '${id}' is missing.`,
        );
      const edges = incoming.get(id) ?? [];
      const requirements = requirementsFor(node, edges);
      ancestors.set(
        id,
        new Set(
          edges.flatMap((edge) => [
            edge.source,
            ...(ancestors.get(edge.source) ?? []),
          ]),
        ),
      );
      let outcome: GraphNodeOutput;
      let candidateLineage = new Set<string>();
      if ("candidate" in node && node.candidate?.kind === "node")
        candidateLineage = new Set(lineage.get(node.candidate.nodeId));
      switch (node.kind) {
        case "agent": {
          const result = agent(
            id,
            "worker",
            node.memberId,
            node.access === "write" ? "writer" : "reader",
            node.access,
            node.task,
            candidateFor(node.candidate),
            requirements,
          );
          outcome = {
            outcome: result.outcome,
            candidate: node.access === "write" ? result.candidate : null,
            checks: [],
          };
          if (node.access === "write") candidateLineage.add(id);
          break;
        }
        case "join": {
          if (
            team.schemaVersion === 2 &&
            node.mode === "selected" &&
            node.decisionNodeId !== null
          ) {
            const decision = outputFor(node.decisionNodeId).outcome;
            const branches = ["true", "false"].map((output) => {
              const alternatives = edges.filter(
                (edge) =>
                  edgeGuard(edge).get(runtimeNodeKey(decision))?.output ===
                  output,
              );
              const candidates = new Map(
                alternatives.flatMap((edge) => {
                  const candidate = outputFor(edge.source).candidate;
                  return candidate === null
                    ? []
                    : [[runtimeNodeKey(candidate), candidate] as const];
                }),
              );
              return { output, candidates, alternatives };
            });
            if (branches.some((branch) => branch.candidates.size > 0)) {
              if (branches.some((branch) => branch.candidates.size !== 1))
                throw new GraphCompileError(
                  "selected_join_candidate_ambiguous",
                  "Each selected branch must produce exactly one candidate before forwarding it.",
                  [id],
                );
              const choices = branches.map((branch) => ({
                output: branch.output,
                candidate: [...branch.candidates.values()][0]!,
                check: null,
              }));
              const chosen = control(
                id,
                "selected-candidate",
                { type: "candidate-choice", decision, branches: choices },
                requirements,
              );
              candidateLineage = new Set(
                branches.flatMap((branch) =>
                  branch.alternatives.flatMap((edge) => [
                    ...(lineage.get(edge.source) ?? []),
                  ]),
                ),
              );
              outcome = { outcome: chosen, candidate: chosen, checks: [] };
              break;
            }
          }
          outcome = {
            outcome: control(id, "barrier", { type: "barrier" }, requirements),
            candidate: null,
            checks: [],
          };
          break;
        }
        case "parallel":
          outcome = {
            outcome: control(id, "barrier", { type: "barrier" }, requirements),
            candidate: null,
            checks: [],
          };
          break;
        case "check": {
          const candidate = candidateFor(node.candidate);
          const workspace =
            definition.schemaVersion === 4
              ? fork(id, "check-workspace", candidate, requirements)
              : candidate;
          const checked = add(
            stepRef(id, "check"),
            {
              kind: "check",
              workspace,
              candidate,
              command: node.command,
            },
            [
              ...requirements,
              receipt(candidate),
              ...(definition.schemaVersion === 4 ? [receipt(workspace)] : []),
            ],
            id,
          );
          outcome = { outcome: checked, candidate, checks: [checked] };
          break;
        }
        case "review": {
          const candidate = candidateFor(node.candidate);
          const result = agent(
            id,
            "review",
            node.memberId,
            "review",
            "read",
            node.task,
            candidate,
            requirements,
          );
          outcome = { outcome: result.outcome, candidate, checks: [] };
          break;
        }
        case "condition": {
          const { sourceNodeId, ...predicate } = node.predicate;
          const source = outputFor(sourceNodeId).outcome;
          outcome = {
            outcome: control(
              id,
              "condition",
              { type: "condition", predicate: { ...predicate, source } },
              [...requirements, receipt(source, ["succeeded", "failed"])],
              conditionOutputs,
            ),
            candidate: null,
            checks: [],
          };
          break;
        }
        case "approval": {
          const candidate =
            node.candidate === null ? null : candidateFor(node.candidate);
          outcome = {
            outcome: control(
              id,
              "approval",
              { type: "approval", message: node.message, candidate },
              [
                ...requirements,
                ...(candidate === null ? [] : [receipt(candidate)]),
              ],
              approvalOutputs,
            ),
            candidate: null,
            checks: [],
          };
          break;
        }
        case "integration": {
          const base = candidateFor(node.baseCandidate);
          const commits = node.writerNodeIds.map((writerId) => {
            const candidate = outputFor(writerId).candidate;
            if (!candidate)
              throw new GraphCompileError(
                "integration_candidate_missing",
                "Each integrated writer needs a committed candidate.",
                [id, writerId],
              );
            return candidate;
          });
          let candidate = fork(id, "integration-workspace", base, [
            ...requirements,
            ...commits.map((commit) => receipt(commit)),
          ]);
          for (const [index, commit] of commits.entries()) {
            const workspace =
              index === 0
                ? candidate
                : fork(id, "integration-next", candidate, requirements, index);
            candidate = add(
              stepRef(id, "integrate", index),
              {
                kind: "integrate",
                strategy: "merge-candidate",
                workspace,
                candidate: workspace,
                commit,
              },
              [...requirements, receipt(workspace), receipt(commit)],
              id,
            );
          }
          candidateLineage = new Set(
            node.writerNodeIds.flatMap((writer) => [
              ...(lineage.get(writer) ?? []),
            ]),
          );
          if (node.baseCandidate.kind === "node")
            for (const ancestor of lineage.get(node.baseCandidate.nodeId) ?? [])
              candidateLineage.add(ancestor);
          outcome = { outcome: candidate, candidate, checks: [] };
          break;
        }
        case "repair": {
          const originalCheck = outputFor(node.checkNodeId);
          if (originalCheck.candidate === null)
            throw new GraphCompileError(
              "repair_candidate_missing",
              "The failed check has no candidate.",
              [id],
            );
          const checkNode = graphNodes.get(node.checkNodeId);
          if (checkNode?.kind !== "check")
            throw new GraphCompileError(
              "repair_check_missing",
              "Repair requires an exact native check definition.",
              [id],
            );
          const rounds = Math.min(
            node.maxRounds,
            definition.policy.limits.maxRepairRounds,
          );
          const roundResults: Array<{
            candidate: OwnedStepRef;
            check: OwnedStepRef;
            decision: OwnedStepRef;
            previousDecision: OwnedStepRef | null;
          }> = [];
          let priorCheck = originalCheck.outcome;
          let priorCandidate = originalCheck.candidate;
          let priorDecision: OwnedStepRef | null = null;
          for (let round = 1; round <= rounds; round += 1) {
            const repair = { stageId: id, round };
            const required = [
              ...requirements,
              receipt(priorCheck, ["failed"]),
              ...(priorDecision === null
                ? []
                : [selection(priorDecision, "false")]),
            ];
            const result = agent(
              id,
              "repair",
              node.body.memberId,
              "repair",
              "write",
              node.body.task,
              priorCandidate,
              required,
              round,
              priorCheck,
              repair,
            );
            references.consumedFailures.push({
              failure: priorCheck,
              consumer: stepRef(id, "repair", round),
              candidate: priorCandidate,
            });
            const workspace =
              definition.schemaVersion === 4
                ? fork(
                    id,
                    "recheck-workspace",
                    result.candidate,
                    required,
                    round,
                    repair,
                  )
                : result.candidate;
            const checked = add(
              stepRef(id, "recheck", round),
              {
                kind: "check",
                workspace,
                candidate: result.candidate,
                command: checkNode.command,
              },
              [
                ...required,
                receipt(result.candidate),
                ...(definition.schemaVersion === 4 ? [receipt(workspace)] : []),
              ],
              id,
              null,
              repair,
            );
            const decision = control(
              id,
              "repair-decision",
              {
                type: "condition",
                predicate: {
                  kind: "outcome",
                  source: checked,
                  equals: "succeeded",
                },
              },
              [...required, receipt(checked, ["succeeded", "failed"])],
              conditionOutputs,
              round,
              repair,
            );
            roundResults.push({
              candidate: result.candidate,
              check: checked,
              decision,
              previousDecision: priorDecision,
            });
            priorCheck = checked;
            priorCandidate = result.candidate;
            priorDecision = decision;
          }
          let result: OwnedStepRef | null = null;
          for (let index = roundResults.length - 1; index >= 0; index -= 1) {
            const current = roundResults[index];
            const next = result;
            result = control(
              id,
              "repair-result",
              {
                type: "repair-result",
                decision: current.decision,
                candidate: current.candidate,
                check: current.check,
                next,
              },
              [
                ...requirements,
                receipt(current.check, ["succeeded", "failed"]),
                ...(current.previousDecision === null
                  ? []
                  : [selection(current.previousDecision, "false")]),
                {
                  kind: "selected",
                  decision: current.decision,
                  branches: [
                    {
                      output: "true",
                      receipts: [
                        receipt(current.candidate),
                        receipt(current.check),
                      ],
                    },
                    {
                      output: "false",
                      receipts:
                        next === null
                          ? [
                              receipt(current.candidate),
                              receipt(current.check, ["failed"]),
                            ]
                          : [receipt(next, ["succeeded", "failed"])],
                    },
                  ],
                },
              ],
              repairOutputs,
              index + 1,
            );
          }
          if (result === null)
            result = control(
              id,
              "repair-result",
              {
                type: "repair-result",
                decision: null,
                candidate: originalCheck.candidate,
                check: originalCheck.outcome,
                next: null,
              },
              [
                ...requirements,
                receipt(originalCheck.outcome, ["failed"]),
                receipt(originalCheck.candidate),
              ],
              repairOutputs,
            );
          candidateLineage = new Set(lineage.get(node.checkNodeId));
          candidateLineage.add(id);
          outcome = { outcome: result, candidate: result, checks: [result] };
          break;
        }
        case "delegation": {
          const candidate = candidateFor(node.candidate);
          const requester = agent(
            id,
            "requester",
            node.requesterMemberId,
            "delegation",
            "read",
            node.task,
            candidate,
            requirements,
            0,
            null,
            null,
            id,
          ).outcome;
          const decision = control(
            id,
            "delegation",
            {
              type: "delegation",
              requester,
              candidate,
              candidateMemberIds: node.candidateMemberIds,
              maxChildCalls: node.maxChildCalls,
              task: node.task,
              access: node.access,
            },
            [...requirements, receipt(requester), receipt(candidate)],
            delegationOutputs,
          );
          let current = candidate;
          for (let slot = 0; slot < node.maxChildCalls; slot += 1) {
            const slotDecision = control(
              id,
              "delegation-slot",
              {
                type: "delegation-slot",
                decision,
                slot,
                candidateMemberIds: node.candidateMemberIds,
              },
              [...requirements, receipt(decision)],
              {
                outputs: [
                  { id: "skip", outcome: "succeeded" },
                  ...node.candidateMemberIds.map((member) => ({
                    id: `member:${member}`,
                    outcome: "succeeded" as const,
                  })),
                ],
              },
              slot,
            );
            const branches: Array<{
              output: string;
              candidate: OwnedStepRef;
              check: OwnedStepRef | null;
            }> = [{ output: "skip", candidate: current, check: null }];
            const selectedBranches: Array<{
              output: string;
              receipts: OwnedReceiptRequirement[];
            }> = [{ output: "skip", receipts: [receipt(current)] }];
            for (const member of node.candidateMemberIds) {
              const result = agent(
                id,
                `child-${runtimeHash(member).slice(0, 16)}`,
                member,
                node.access === "write" ? "writer" : "reader",
                node.access,
                node.task,
                current,
                [
                  ...requirements,
                  selection(slotDecision, `member:${member}`),
                  receipt(decision),
                  receipt(current),
                ],
                slot,
              );
              branches.push({
                output: `member:${member}`,
                candidate: result.candidate,
                check: null,
              });
              selectedBranches.push({
                output: `member:${member}`,
                receipts: [receipt(result.outcome), receipt(result.candidate)],
              });
            }
            current = control(
              id,
              "delegation-result",
              { type: "candidate-choice", decision: slotDecision, branches },
              [
                ...requirements,
                {
                  kind: "selected",
                  decision: slotDecision,
                  branches: selectedBranches,
                },
              ],
              nextOutput,
              slot,
            );
          }
          if (node.access === "write") candidateLineage.add(id);
          outcome = {
            outcome: current,
            candidate: node.access === "write" ? current : null,
            checks: [],
          };
          break;
        }
        case "release":
          throw new GraphCompileError(
            "release_unavailable",
            "Release stages require the configured Phase 6 factory capability.",
            [id],
          );
      }
      references.outputs[id] = outcome;
      lineage.set(id, candidateLineage);
      remaining.delete(id);
    }
  }

  const writingNodes = team.graph.nodes.filter(
    (node) =>
      node.kind === "repair" ||
      ((node.kind === "agent" || node.kind === "delegation") &&
        node.access === "write"),
  );
  function compatible(a: Guards, b: Guards): boolean {
    return [...a].every(
      ([key, value]) => !b.has(key) || b.get(key)?.output === value.output,
    );
  }
  function compatibleOutcomes(a: OutcomeGuards, b: OutcomeGuards): boolean {
    return [...a].every(
      ([key, possible]) =>
        !b.has(key) || [...possible].some((value) => b.get(key)?.has(value)),
    );
  }
  for (const node of team.graph.nodes) {
    if (node.kind !== "review") continue;
    const output = outputFor(node.id);
    const candidate = candidateFor(node.candidate);
    const activeGuards = guards.get(node.id) ?? new Map();
    const checked = [...(ancestors.get(node.id) ?? [])].flatMap((ancestor) => {
      const value = outputFor(ancestor);
      return value.candidate !== null &&
        runtimeNodeKey(value.candidate) === runtimeNodeKey(candidate)
        ? value.checks
        : [];
    });
    const coversWriters = writingNodes.every(
      (writer) =>
        !compatible(activeGuards, guards.get(writer.id) ?? new Map()) ||
        !compatibleOutcomes(
          outcomeGuards.get(node.id) ?? new Map(),
          outcomeGuards.get(writer.id) ?? new Map(),
        ) ||
        lineage.get(node.id)?.has(writer.id),
    );
    if (!coversWriters) continue;
    for (const [index, check] of checked.entries()) {
      const communication = dialogueCheckpoint(
        node.id,
        `final-${index}`,
        candidate,
        [
          ...conditions(activeGuards),
          receipt(candidate),
          receipt(check),
          receipt(output.outcome),
        ],
        index,
      );
      const verify = add(
        stepRef(node.id, "verify", index),
        { kind: "verify", workspace: candidate, check, review: output.outcome },
        [
          ...conditions(activeGuards),
          receipt(candidate),
          receipt(check),
          receipt(output.outcome),
          ...(communication === null ? [] : [receipt(communication)]),
        ],
        node.id,
        node.memberId,
      );
      references.finalGates.push({
        candidate,
        check,
        review: output.outcome,
        verify,
      });
    }
  }
  if (!references.finalGates.length)
    throw new GraphCompileError(
      "final_verification_required",
      "Add a native check and review of the final candidate containing every selected writing stage.",
    );
  const requiredGates: OwnedRunStartV2["requiredGates"] =
    team.graph.requiredGates.map((gate) => ({
      gateId: `team:${gate.id}`,
      mode: gate.mode,
      steps: gate.nodeIds.map((id) => outputFor(id).outcome),
    }));
  requiredGates.push({
    gateId: "arc:final-candidate",
    mode: "any",
    steps: references.finalGates.map((gate) => gate.verify),
  });
  const sourceCode = sourceProgram(
    steps,
    requiredGates,
    team.schemaVersion === 2,
  );
  if (Buffer.byteLength(sourceCode) > 512 * 1024)
    throw new GraphCompileError(
      "compiled_graph_too_large",
      "Reduce graph connections or delegation choices to fit the admitted workflow source limit.",
    );
  const planHash = runtimeHash({
    definition,
    nodes,
    references,
    source: sourceCode,
  });
  const workflow = ownedRunStartV2Schema.parse({
    schemaVersion: 2,
    ownerRunId: definition.runId,
    projectId: definition.request.projectId,
    originThreadId: definition.request.originThreadId,
    planHash,
    source: sourceCode,
    args: null,
    steps,
    requiredGates,
    limits: definition.policy.limits,
  });
  return {
    definition,
    nodes,
    workflow,
    references,
  };
}

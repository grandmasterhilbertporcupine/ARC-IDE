import {
  DEFAULT_OWNED_RUN_LIMITS,
  ownedRunStartSchema,
  type OwnedAdmittedStep,
  type OwnedRunStart,
  type OwnedStepRef,
} from "bb-plugin-workflows/owned-contract";
import { ownedStepRefSchema } from "bb-plugin-workflows/owned-contract";
import { z } from "zod";
import {
  runAgentSnapshotSchema,
  runCheckSchema,
  runDefinitionSchema,
  type ArcRunDefinition,
} from "./contract.js";
import { runtimeHash } from "./hash.js";

type Dependency = OwnedAdmittedStep["dependencies"][number];
export const runtimeNodeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("prepare-worktree"), workspaceKey: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      purpose: z.enum(["writer", "repair", "review"]),
      agent: runAgentSnapshotSchema,
      task: z.string(),
      workspace: ownedStepRefSchema,
      candidate: ownedStepRefSchema,
      failure: ownedStepRefSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      workspace: ownedStepRefSchema,
      worker: ownedStepRefSchema,
      message: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("integrate"),
      workspace: ownedStepRefSchema,
      candidate: ownedStepRefSchema,
      commit: ownedStepRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("check"),
      workspace: ownedStepRefSchema,
      candidate: ownedStepRefSchema,
      command: runCheckSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("verify"),
      workspace: ownedStepRefSchema,
      check: ownedStepRefSchema,
      review: ownedStepRefSchema,
    })
    .strict(),
]);
export type RuntimeNode = z.infer<typeof runtimeNodeSchema>;

export interface CompiledRun {
  definition: ArcRunDefinition;
  nodes: Record<string, RuntimeNode>;
  workflow: OwnedRunStart;
}

export const compiledRunSchema = z
  .object({
    definition: runDefinitionSchema,
    nodes: z.record(z.string(), runtimeNodeSchema),
    workflow: ownedRunStartSchema,
  })
  .strict();

export function runtimeNodeKey(ref: OwnedStepRef): string {
  return `${ref.nodeId}:${ref.iteration}`;
}

export function compileArcRun(input: ArcRunDefinition): CompiledRun {
  const definition = runDefinitionSchema.parse(input);
  if (definition.writers.length !== definition.request.writers.length)
    throw new Error("Each writer must have an immutable agent snapshot");
  if (definition.source.head !== definition.request.expectedHead)
    throw new Error("The source revision changed before this run was sealed");
  for (const [snapshot, selection] of [
    ...definition.writers.map(
      (agent, index) =>
        [agent, definition.request.writers[index].agent] as const,
    ),
    [definition.reviewer, definition.request.reviewer] as const,
    [definition.repairer, definition.request.repairer] as const,
  ]) {
    if (
      snapshot.definition.agentId !== selection.agentId ||
      snapshot.definition.revision !== selection.revision
    )
      throw new Error(
        "An agent snapshot does not match the selected published revision",
      );
  }
  const nodes: Record<string, RuntimeNode> = {};
  const steps: OwnedAdmittedStep[] = [];
  const succeeded = (ref: OwnedStepRef): Dependency => ({
    ...ref,
    requiredOutcome: "succeeded",
  });
  const add = (
    nodeId: string,
    iteration: number,
    node: RuntimeNode,
    dependencies: Dependency[],
    repairRound: number | null = null,
  ): OwnedStepRef => {
    const ref = { nodeId, iteration };
    nodes[runtimeNodeKey(ref)] = node;
    steps.push({
      ...ref,
      kind: node.kind === "agent" ? "agent" : "host-effect",
      definitionHash: runtimeHash(node),
      dependencies,
      lane:
        node.kind === "integrate" ||
        node.kind === "commit" ||
        node.kind === "check" ||
        node.kind === "verify"
          ? {
              hostId: definition.request.hostId,
              repositoryId: runtimeHash({
                hostId: definition.request.hostId,
                commonGitDir: definition.source.commonGitDir,
              }),
              target: {
                kind: "environment",
                id: `${definition.runId}:${runtimeNodeKey(node.workspace)}`,
              },
            }
          : null,
      repair:
        repairRound === null
          ? null
          : { stageId: "integrated-check", round: repairRound },
    });
    return ref;
  };
  const calls: string[] = [];
  const call = (ref: OwnedStepRef) =>
    `step(${JSON.stringify(ref.nodeId)}, ${ref.iteration}, null)`;
  const commits = definition.writers.map((agent, index) => {
    const workspace = add(
      `writer-${index}-workspace`,
      0,
      { kind: "prepare-worktree", workspaceKey: `writer-${index}` },
      [],
    );
    const worker = add(
      `writer-${index}`,
      0,
      {
        kind: "agent",
        purpose: "writer",
        agent,
        task: definition.request.writers[index].task,
        workspace,
        candidate: workspace,
        failure: null,
      },
      [succeeded(workspace)],
    );
    const commit = add(
      `writer-${index}-commit`,
      0,
      {
        kind: "commit",
        workspace,
        worker,
        message: `ARC: ${definition.runId} writer ${index + 1}`,
      },
      [succeeded(worker)],
    );
    calls.push(
      `async () => { await ${call(workspace)}; await ${call(worker)}; return ${call(commit)}; }`,
    );
    return commit;
  });
  const workspace = add(
    "integration-workspace",
    0,
    { kind: "prepare-worktree", workspaceKey: "integration" },
    commits.map(succeeded),
  );
  let candidate = workspace;
  const integrationCalls: string[] = [];
  for (const [index, commit] of commits.entries()) {
    candidate = add(
      `integrate-${index}`,
      0,
      { kind: "integrate", workspace, candidate, commit },
      [succeeded(candidate), succeeded(commit)],
    );
    integrationCalls.push(`await ${call(candidate)};`);
  }
  const branches: string[] = [];
  const finalGates: OwnedStepRef[] = [];
  for (
    let round = 0;
    round <= DEFAULT_OWNED_RUN_LIMITS.maxRepairRounds;
    round += 1
  ) {
    const check = add(
      "check",
      round,
      {
        kind: "check",
        workspace,
        candidate,
        command: definition.request.check,
      },
      [succeeded(candidate)],
      round === 0 ? null : round,
    );
    const review = add(
      "review",
      round,
      {
        kind: "agent",
        purpose: "review",
        agent: definition.reviewer,
        task: definition.request.goal,
        workspace,
        candidate: check,
        failure: null,
      },
      [succeeded(check)],
    );
    const verify = add(
      "verify",
      round,
      { kind: "verify", workspace, check, review },
      [succeeded(check), succeeded(review)],
    );
    finalGates.push(verify);
    let repairBranch = "throw checkError;";
    if (round < DEFAULT_OWNED_RUN_LIMITS.maxRepairRounds) {
      const repair = add(
        "repair",
        round + 1,
        {
          kind: "agent",
          purpose: "repair",
          agent: definition.repairer,
          task: definition.request.goal,
          workspace,
          candidate: check,
          failure: check,
        },
        [{ ...check, requiredOutcome: "failed" }],
        round + 1,
      );
      candidate = add(
        "repair-commit",
        round + 1,
        {
          kind: "commit",
          workspace,
          worker: repair,
          message: `ARC: ${definition.runId} repair ${round + 1}`,
        },
        [succeeded(repair)],
        round + 1,
      );
      repairBranch = `await ${call(repair)}; await ${call(candidate)};`;
    }
    branches.push(`{
      let checkPassed = false;
      try { await ${call(check)}; checkPassed = true; }
      catch (checkError) { if (!checkError.stepFailure || checkError.stepFailure.state !== "failed") throw checkError; ${repairBranch} }
      if (checkPassed) { await ${call(review)}; return ${call(verify)}; }
    }`);
  }
  const source = `export const meta = { name: "arc-team-run", description: "Isolated writers with required integrated verification" };
const writers = await parallelSettled([${calls.join(",\n")}]);
requireSuccess(writers);
await ${call(workspace)};
${integrationCalls.join("\n")}
${branches.join("\n")}
throw new Error("Required integrated verification did not finish");`;
  const planHash = runtimeHash({ definition, nodes, source });
  const workflow = ownedRunStartSchema.parse({
    ownerRunId: definition.runId,
    projectId: definition.request.projectId,
    originThreadId: definition.request.originThreadId,
    planHash,
    source,
    args: null,
    steps,
    requiredGates: [
      { gateId: "integrated-candidate", mode: "any", steps: finalGates },
    ],
    limits: { ...DEFAULT_OWNED_RUN_LIMITS },
  });
  return { definition, nodes, workflow };
}

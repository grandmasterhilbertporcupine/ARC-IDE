import { z } from "zod";
import {
  ownedRunStartV2Schema,
  ownedStepRefSchema,
} from "bb-plugin-workflows/owned-contract";
import { runtimeNodeKey } from "./compiler.js";
import { completionProgram } from "./completion-program.js";
import {
  directoryRunDefinitionSchema,
  directoryRuntimeNodeSchema,
  type DirectoryRunDefinition,
} from "./directory-contract.js";
import { graphCompilerReferencesSchema } from "./graph-contract.js";
import { GraphCompileError, lowerArcTeamGraph } from "./graph-lowering.js";
import { runtimeHash } from "./hash.js";
import { orchestratorRuntimeNodeSchema } from "./orchestrated-contract.js";
export { validateDirectoryTeamGraph } from "./directory-graph-validation.js";

export const compiledDirectoryRunSchema = z
  .object({
    definition: directoryRunDefinitionSchema,
    nodes: z.record(z.string(), directoryRuntimeNodeSchema),
    workflow: ownedRunStartV2Schema,
    references: graphCompilerReferencesSchema.extend({
      mainCompletion: ownedStepRefSchema,
    }),
  })
  .strict();
export type CompiledDirectoryRun = z.infer<typeof compiledDirectoryRunSchema>;

export function compileArcDirectoryRun(
  input: DirectoryRunDefinition,
): CompiledDirectoryRun {
  const definition = directoryRunDefinitionSchema.parse(input);
  if (
    definition.completion.threadId !== definition.request.originThreadId ||
    definition.completion.environment.hostId !== definition.request.hostId
  )
    throw new GraphCompileError(
      "completion_binding_mismatch",
      "The main response must use the exact originating conversation and project environment.",
    );
  const compiled = lowerArcTeamGraph(definition);
  const mainCompletion = { nodeId: "arc:main-completion", iteration: 0 };
  const node = orchestratorRuntimeNodeSchema.parse({
    kind: "orchestrator",
    purpose: "completion",
    completion: definition.completion,
  });
  const nodes = { ...compiled.nodes, [runtimeNodeKey(mainCompletion)]: node };
  const references = { ...compiled.references, mainCompletion };
  const source = completionProgram(
    compiled.workflow.source,
    mainCompletion,
    "arc-directory-run",
    "Serial published team work on retained directory snapshots and one admitted main response",
  );
  if (Buffer.byteLength(source) > 512 * 1024)
    throw new GraphCompileError(
      "compiled_graph_too_large",
      "Reduce graph connections to leave room for the admitted main response.",
    );
  return compiledDirectoryRunSchema.parse({
    definition,
    nodes,
    references,
    workflow: {
      ...compiled.workflow,
      source,
      planHash: runtimeHash({ definition, nodes, references, source }),
      steps: [
        ...compiled.workflow.steps,
        {
          ...mainCompletion,
          definitionHash: runtimeHash(node),
          kind: "agent",
          requirements: [],
          control: null,
          lane: null,
          repair: null,
        },
      ],
      requiredGates: [
        ...compiled.workflow.requiredGates,
        { gateId: "arc:main-completion", mode: "all", steps: [mainCompletion] },
      ],
    },
  });
}

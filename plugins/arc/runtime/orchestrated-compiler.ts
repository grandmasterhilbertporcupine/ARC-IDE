import { z } from "zod";
import {
  ownedRunStartV2Schema,
  ownedStepRefSchema,
} from "bb-plugin-workflows/owned-contract";
import { runtimeNodeKey } from "./compiler.js";
import { compileArcGraphRun, GraphCompileError } from "./graph-compiler.js";
import {
  graphCompilerReferencesSchema,
  graphRuntimeNodeSchema,
} from "./graph-contract.js";
import { runtimeHash } from "./hash.js";
import { completionProgram } from "./completion-program.js";
import {
  orchestratedRunDefinitionSchema,
  orchestratorRuntimeNodeSchema,
  type OrchestratedRunDefinition,
} from "./orchestrated-contract.js";

export const compiledOrchestratedRunSchema = z
  .object({
    definition: orchestratedRunDefinitionSchema,
    nodes: z.record(
      z.string(),
      z.union([graphRuntimeNodeSchema, orchestratorRuntimeNodeSchema]),
    ),
    workflow: ownedRunStartV2Schema,
    references: graphCompilerReferencesSchema.extend({
      mainCompletion: ownedStepRefSchema,
    }),
  })
  .strict();
export type CompiledOrchestratedRun = z.infer<
  typeof compiledOrchestratedRunSchema
>;

export function compileArcOrchestratedRun(
  input: OrchestratedRunDefinition,
): CompiledOrchestratedRun {
  const definition = orchestratedRunDefinitionSchema.parse(input);
  if (
    definition.completion.threadId !== definition.request.originThreadId ||
    definition.completion.environment.hostId !== definition.request.hostId
  )
    throw new GraphCompileError(
      "completion_binding_mismatch",
      "The main response must use the exact originating conversation and project environment.",
    );
  const {
    invocation: _invocation,
    addressedRecipients: _addressedRecipients,
    addressedAttachments: _addressedAttachments,
    ...request
  } = definition.request;
  const { completion: _completion, ...graph } = definition;
  const compiled = compileArcGraphRun({ ...graph, schemaVersion: 2, request });
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
    "arc-orchestrated-run",
    "Published team work and one admitted response in its main conversation",
  );
  if (Buffer.byteLength(source) > 512 * 1024)
    throw new GraphCompileError(
      "compiled_graph_too_large",
      "Reduce graph connections to leave room for the admitted main response.",
    );
  const workflow = ownedRunStartV2Schema.parse({
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
  });
  return compiledOrchestratedRunSchema.parse({
    definition,
    nodes,
    workflow,
    references,
  });
}

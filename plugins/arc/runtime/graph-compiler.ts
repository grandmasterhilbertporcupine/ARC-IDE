import {
  graphRunDefinitionSchema,
  type GraphRunDefinition,
} from "./graph-contract.js";
import {
  compiledGraphRunSchema,
  lowerArcTeamGraph,
  type CompiledGraphRun,
} from "./graph-lowering.js";

export {
  compiledGraphRunSchema,
  GraphCompileError,
  type CompiledGraphRun,
} from "./graph-lowering.js";

export function compileArcGraphRun(
  input: GraphRunDefinition,
): CompiledGraphRun {
  return compiledGraphRunSchema.parse(
    lowerArcTeamGraph(graphRunDefinitionSchema.parse(input)),
  );
}

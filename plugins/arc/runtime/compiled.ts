import { z } from "zod";
import { compiledRunSchema, type RuntimeNode } from "./compiler.js";
import { compiledGraphRunSchema } from "./graph-compiler.js";
import type { GraphRuntimeNode } from "./graph-contract.js";
import { compiledOrchestratedRunSchema } from "./orchestrated-compiler.js";
import type { OrchestratorRuntimeNode } from "./orchestrated-contract.js";
import { compiledDirectoryRunSchema } from "./directory-compiler.js";
import type { DirectoryRuntimeNode } from "./directory-contract.js";

export const retainedGitCompiledRunSchema = z.union([
  compiledRunSchema,
  compiledGraphRunSchema,
  compiledOrchestratedRunSchema,
]);
export const retainedCompiledRunSchema = z.union([
  retainedGitCompiledRunSchema,
  compiledDirectoryRunSchema,
]);
export type RetainedCompiledRun = z.infer<typeof retainedCompiledRunSchema>;
export type RetainedRuntimeNode =
  | RuntimeNode
  | GraphRuntimeNode
  | OrchestratorRuntimeNode
  | DirectoryRuntimeNode;

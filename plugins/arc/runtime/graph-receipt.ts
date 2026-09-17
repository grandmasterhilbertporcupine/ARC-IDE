import { z } from "zod";
import { ownedDependencyReceiptSchema } from "bb-plugin-workflows/owned-contract";
import { hostWorkspaceStateSchema } from "../host-contract.js";
import { runtimeReceiptSchema } from "./receipt.js";
import { graphControlDecisionSchema } from "./graph-control-decision.js";
export { graphControlDecisionSchema } from "./graph-control-decision.js";

export const graphControlReceiptSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    selectedOutputs: z.array(z.string().min(1)).min(1).max(100),
    data: z
      .object({
        workspace: hostWorkspaceStateSchema.nullable(),
        decision: graphControlDecisionSchema,
        check: ownedDependencyReceiptSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type GraphControlReceipt = z.infer<typeof graphControlReceiptSchema>;
export const graphRuntimeReceiptSchema = z.union([
  runtimeReceiptSchema,
  graphControlReceiptSchema,
]);
export type GraphRuntimeReceipt = z.infer<typeof graphRuntimeReceiptSchema>;

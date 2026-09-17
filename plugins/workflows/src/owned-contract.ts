import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { JsonValue } from "./types.js";

export const DEFAULT_OWNED_RUN_LIMITS = {
  maxConcurrentAgents: 4,
  maxAgentCalls: 100,
  maxRepairRounds: 3,
  maxActiveMs: 7_200_000,
} as const;

const MAX_JSON_BYTES = 1024 * 1024;
const identifier = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function isBoundedJson(value: unknown): value is JsonValue {
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit: boolean }> = [
    { value, depth: 0, exit: false },
  ];
  let count = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const current = entry.value;
    if (entry.exit) {
      if (typeof current === "object" && current !== null)
        ancestors.delete(current);
      continue;
    }
    count += 1;
    if (count > 100_000 || entry.depth > 64) return false;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (current.length > MAX_JSON_BYTES) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return false;
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (!array && prototype !== null && prototype !== Object.prototype)
      return false;
    ancestors.add(current);
    stack.push({ value: current, depth: entry.depth, exit: true });
    const keys = Reflect.ownKeys(current);
    if (keys.length > 100_000) return false;
    if (array && keys.length !== current.length + 1) return false;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        return false;
      if (
        array &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)
      )
        return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        return false;
      stack.push({
        value: descriptor.value,
        depth: entry.depth + 1,
        exit: false,
      });
    }
  }
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_JSON_BYTES
  );
}

export const ownedJsonValueSchema = z.custom<JsonValue>(isBoundedJson, {
  error:
    "Expected finite plain JSON within 1 MiB, 100,000 values and 64 levels",
});

export function canonicalOwnedJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalOwnedJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOwnedJson(value[key]!)}`)
    .join(",")}}`;
}

export const ownedStepRefSchema = z
  .object({
    nodeId: identifier,
    iteration: counter,
  })
  .strict();

export const ownedDependencyAdmissionSchema = ownedStepRefSchema
  .extend({
    requiredOutcome: z.enum(["succeeded", "failed"]),
  })
  .strict();

export const ownedLaneIdentitySchema = z
  .object({
    hostId: identifier,
    repositoryId: identifier,
    target: z
      .object({
        kind: z.enum(["git-ref", "environment"]),
        id: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict();

export const ownedAdmittedStepSchema = ownedStepRefSchema
  .extend({
    kind: z.enum(["agent", "host-effect"]),
    definitionHash: hash,
    dependencies: z.array(ownedDependencyAdmissionSchema).max(4096),
    lane: ownedLaneIdentitySchema.nullable(),
    repair: z
      .object({ stageId: identifier, round: counter.min(1) })
      .strict()
      .nullable(),
  })
  .strict();

export const ownedRunLimitsSchema = z
  .object({
    maxConcurrentAgents: counter.min(1).max(64),
    maxAgentCalls: counter.min(1).max(1000),
    maxRepairRounds: counter.max(100),
    maxActiveMs: counter.min(1).max(2_592_000_000),
  })
  .strict();

export const ownedRequiredGateSchema = z
  .object({
    gateId: identifier,
    mode: z.enum(["all", "any"]),
    steps: z.array(ownedStepRefSchema).min(1).max(4096),
  })
  .strict();

export function ownedStepRefKey(
  ref: z.infer<typeof ownedStepRefSchema>,
): string {
  return JSON.stringify([ref.nodeId, ref.iteration]);
}

export const ownedRunStartSchema = z
  .object({
    ownerRunId: identifier,
    projectId: identifier,
    originThreadId: identifier,
    planHash: hash,
    source: z
      .string()
      .min(1)
      .max(512 * 1024),
    args: ownedJsonValueSchema,
    steps: z.array(ownedAdmittedStepSchema).min(1).max(4096),
    requiredGates: z.array(ownedRequiredGateSchema).min(1).max(4096),
    limits: ownedRunLimitsSchema,
  })
  .strict()
  .superRefine((run, context) => {
    const steps = new Map(
      run.steps.map((step) => [ownedStepRefKey(step), step]),
    );
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (steps.size !== run.steps.length)
      issue("Step identities must be unique");
    if (
      new Set(run.requiredGates.map((gate) => gate.gateId)).size !==
      run.requiredGates.length
    )
      issue("Gate identities must be unique");
    for (const step of run.steps) {
      if (
        step.repair !== null &&
        step.repair.round > run.limits.maxRepairRounds
      )
        issue(`Repair round exceeds the limit for ${step.nodeId}`);
      const keys = step.dependencies.map(ownedStepRefKey);
      if (new Set(keys).size !== keys.length)
        issue(`Dependencies must be unique for ${step.nodeId}`);
      if (keys.some((key) => !steps.has(key)))
        issue(`Unknown dependency for ${step.nodeId}`);
    }
    for (const gate of run.requiredGates) {
      const keys = gate.steps.map(ownedStepRefKey);
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key) => !steps.has(key))
      )
        issue(`Invalid step identities for gate ${gate.gateId}`);
    }
    const remaining = new Map(
      [...steps].map(([key, step]) => [
        key,
        new Set(step.dependencies.map(ownedStepRefKey)),
      ]),
    );
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key);
    while (ready.length > 0) {
      const key = ready.pop()!;
      remaining.delete(key);
      for (const [other, dependencies] of remaining) {
        if (dependencies.delete(key) && dependencies.size === 0)
          ready.push(other);
      }
    }
    if (remaining.size > 0)
      issue("Step dependencies must form an acyclic graph");
  });

export const ownedStepKeySchema = ownedStepRefSchema
  .extend({
    workflowRunId: identifier,
    ownerRunId: identifier,
    attempt: counter.min(1),
    effectId: identifier,
    requestHash: hash,
  })
  .strict();

export const ownedDependencyReceiptSchema = ownedStepRefSchema
  .extend({
    effectId: identifier,
    receiptHash: hash,
    outcome: z.enum(["succeeded", "failed"]),
  })
  .strict();

export const ownedLaneClaimSchema = z
  .object({ key: hash, fence: counter.min(1) })
  .strict();

export const ownedStepRequestSchema = ownedStepKeySchema
  .extend({
    dispatchGeneration: counter,
    definitionHash: hash,
    dependencyReceipts: z.array(ownedDependencyReceiptSchema).max(4096),
    lane: ownedLaneClaimSchema.nullable(),
    input: ownedJsonValueSchema,
  })
  .strict();

export const ownedStepLookupSchema = ownedStepKeySchema
  .extend({ dispatchGeneration: counter })
  .strict();

export const ownedStepResourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent"),
      threadId: identifier,
      executionContextId: identifier,
      environmentId: identifier.nullable(),
      turnRequestId: identifier.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("host-effect"),
      hostId: identifier,
      effectId: identifier,
    })
    .strict(),
]);

export const ownedReceiptValiditySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("current"), identityHash: hash }).strict(),
  z
    .object({
      state: z.literal("stale"),
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
]);

const terminalObservationFields = {
  resource: ownedStepResourceSchema.nullable(),
  receipt: ownedJsonValueSchema,
  receiptHash: hash,
  validity: ownedReceiptValiditySchema,
};

export const ownedStepObservationSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("running"),
        resource: ownedStepResourceSchema,
      })
      .strict(),
    z
      .object({ state: z.literal("succeeded"), ...terminalObservationFields })
      .strict(),
    z
      .object({ state: z.literal("failed"), ...terminalObservationFields })
      .strict(),
    z
      .object({ state: z.literal("interrupted"), ...terminalObservationFields })
      .strict(),
    z
      .object({
        state: z.literal("not-started"),
        reason: z.string().max(16_384).nullable(),
      })
      .strict(),
    z
      .object({
        state: z.literal("needs-reconciliation"),
        reason: z.string().min(1).max(16_384),
      })
      .strict(),
  ])
  .superRefine((observation, context) => {
    if (
      observation.state === "succeeded" &&
      (observation.resource === null ||
        (observation.resource.kind === "agent" &&
          (observation.resource.environmentId === null ||
            observation.resource.turnRequestId === null)))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Successful effects require a bound native resource and dispatched turn identity",
      });
    }
  });

export const ownedRunStateSchema = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "needs-reconciliation",
  "succeeded",
  "failed",
  "cancelled",
]);

export const ownedStepFailureSchema = ownedStepKeySchema
  .extend({
    state: z.enum(["failed", "interrupted"]),
    receipt: ownedJsonValueSchema,
    receiptHash: hash,
  })
  .strict();

export const ownedRunViewSchema = z
  .object({
    workflowRunId: identifier,
    ownerRunId: identifier,
    projectId: identifier,
    originThreadId: identifier,
    planHash: hash,
    state: ownedRunStateSchema,
    desiredControl: z.enum(["run", "pause", "cancel"]),
    controlVersion: counter,
    dispatchGeneration: counter,
    limits: ownedRunLimitsSchema,
    agentCalls: counter,
    activeAgents: counter,
    chargedActiveMs: counter,
    repairRounds: z
      .array(z.object({ stageId: identifier, rounds: counter }).strict())
      .max(4096),
    result: z.discriminatedUnion("available", [
      z.object({ available: z.literal(false) }).strict(),
      z
        .object({ available: z.literal(true), value: ownedJsonValueSchema })
        .strict(),
    ]),
    error: z.string().max(16_384).nullable(),
  })
  .strict();

export const ownedRunControlSchema = z
  .object({
    workflowRunId: identifier,
    operationId: identifier,
    expectedVersion: counter,
    action: z.enum(["pause", "resume", "cancel"]),
  })
  .strict();

export const ownedReceiptRequirementSchema = z
  .object({
    kind: z.literal("receipt"),
    step: ownedStepRefSchema,
    outcomes: z
      .array(z.enum(["succeeded", "failed"]))
      .min(1)
      .max(2),
  })
  .strict()
  .refine((value) => new Set(value.outcomes).size === value.outcomes.length, {
    message: "Receipt outcomes must be unique",
  });

export const ownedRequirementSchema = z.discriminatedUnion("kind", [
  ownedReceiptRequirementSchema,
  z
    .object({
      kind: z.literal("selection"),
      decision: ownedStepRefSchema,
      output: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selected"),
      decision: ownedStepRefSchema,
      branches: z
        .array(
          z
            .object({
              output: identifier,
              receipts: z.array(ownedReceiptRequirementSchema).max(4096),
            })
            .strict(),
        )
        .min(1)
        .max(4096),
    })
    .strict(),
]);

export const ownedControlDeclarationSchema = z
  .object({
    outputs: z
      .array(
        z
          .object({
            id: identifier,
            outcome: z.enum(["succeeded", "failed"]),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.outputs.map((output) => output.id)).size ===
      value.outputs.length,
    {
      message: "Control output identities must be unique",
    },
  );

export const ownedAdmittedStepV2Schema = ownedAdmittedStepSchema
  .omit({ dependencies: true, kind: true })
  .extend({
    kind: z.enum(["agent", "host-effect", "owner-control"]),
    requirements: z.array(ownedRequirementSchema).max(4096),
    control: ownedControlDeclarationSchema.nullable(),
  })
  .strict()
  .superRefine((step, context) => {
    if (
      step.kind === "owner-control"
        ? step.control === null || step.lane !== null
        : step.control !== null
    )
      context.addIssue({
        code: "custom",
        message:
          "Owner controls require a control declaration and no lane; native steps cannot declare controls",
      });
  });

export function ownedRequirementStepRefs(
  requirement: z.infer<typeof ownedRequirementSchema>,
): Array<z.infer<typeof ownedStepRefSchema>> {
  switch (requirement.kind) {
    case "receipt":
      return [requirement.step];
    case "selection":
      return [requirement.decision];
    case "selected":
      return [
        requirement.decision,
        ...requirement.branches.flatMap((branch) =>
          branch.receipts.map((receipt) => receipt.step),
        ),
      ];
  }
}

export const ownedRunStartV2Schema = z
  .object({
    ...ownedRunStartSchema.shape,
    schemaVersion: z.literal(2),
    steps: z.array(ownedAdmittedStepV2Schema).min(1).max(4096),
  })
  .strict()
  .superRefine((run, context) => {
    const steps = new Map(
      run.steps.map((step) => [ownedStepRefKey(step), step]),
    );
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (steps.size !== run.steps.length)
      issue("Step identities must be unique");
    if (
      new Set(run.requiredGates.map((gate) => gate.gateId)).size !==
      run.requiredGates.length
    )
      issue("Gate identities must be unique");
    for (const step of run.steps) {
      if (
        step.repair !== null &&
        step.repair.round > run.limits.maxRepairRounds
      )
        issue(`Repair round exceeds the limit for ${step.nodeId}`);
      const keys = step.requirements
        .flatMap(ownedRequirementStepRefs)
        .map(ownedStepRefKey);
      if (keys.some((key) => !steps.has(key)))
        issue(`Unknown requirement for ${step.nodeId}`);
      for (const requirement of step.requirements) {
        if (requirement.kind === "receipt") continue;
        const decision = steps.get(ownedStepRefKey(requirement.decision));
        if (decision?.kind !== "owner-control" || decision.control === null) {
          issue(
            `Selection requires an admitted owner control for ${step.nodeId}`,
          );
          continue;
        }
        const outputs = new Set(
          decision.control.outputs.map((output) => output.id),
        );
        if (requirement.kind === "selection") {
          if (!outputs.has(requirement.output))
            issue(`Unknown selected output for ${step.nodeId}`);
        } else {
          const selected = new Set(
            requirement.branches.map((branch) => branch.output),
          );
          if (
            selected.size !== requirement.branches.length ||
            selected.size !== outputs.size ||
            [...selected].some((output) => !outputs.has(output))
          )
            issue(
              `Selected requirements must cover each declared output once for ${step.nodeId}`,
            );
        }
      }
    }
    for (const gate of run.requiredGates) {
      const keys = gate.steps.map(ownedStepRefKey);
      if (
        new Set(keys).size !== keys.length ||
        keys.some((key) => !steps.has(key))
      )
        issue(`Invalid step identities for gate ${gate.gateId}`);
    }
    const remaining = new Map(
      [...steps].map(([key, step]) => [
        key,
        new Set(
          step.requirements
            .flatMap(ownedRequirementStepRefs)
            .map(ownedStepRefKey),
        ),
      ]),
    );
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key);
    while (ready.length > 0) {
      const key = ready.pop()!;
      remaining.delete(key);
      for (const [other, dependencies] of remaining) {
        if (dependencies.delete(key) && dependencies.size === 0)
          ready.push(other);
      }
    }
    if (remaining.size > 0)
      issue("Step requirements must form an acyclic graph");
  });

export const ownedRunStartInputSchema = z.union([
  ownedRunStartSchema,
  ownedRunStartV2Schema,
]);
export const ownedStepRequestV2Schema = ownedStepRequestSchema
  .extend({ schemaVersion: z.literal(2) })
  .strict();
export const ownedStepRequestInputSchema = z.union([
  ownedStepRequestSchema,
  ownedStepRequestV2Schema,
]);
export const ownedStepLookupV2Schema = ownedStepLookupSchema
  .extend({ schemaVersion: z.literal(2) })
  .strict();
export const ownedStepLookupInputSchema = z.union([
  ownedStepLookupSchema,
  ownedStepLookupV2Schema,
]);

export const ownedValidationAcknowledgementSchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        validationId: identifier,
        state: z.literal("checking"),
        generation: counter,
        activity: z.enum(["running", "quiescent"]),
      })
      .strict(),
    z
      .object({
        validationId: identifier,
        state: z.enum(["current", "stale"]),
        generation: counter,
        activity: z.null(),
      })
      .strict(),
  ],
);
export const ownedStepObservationLookupInputSchema = z.union([
  ownedStepLookupInputSchema,
  ownedStepLookupSchema
    .extend({ validation: ownedValidationAcknowledgementSchema })
    .strict(),
  ownedStepLookupV2Schema
    .extend({ validation: ownedValidationAcknowledgementSchema })
    .strict(),
]);

export const ownedControlResourceSchema = z
  .object({ kind: z.literal("owner-control"), controlId: identifier })
  .strict();
export const ownedStepResourceV2Schema = z.union([
  ownedStepResourceSchema,
  ownedControlResourceSchema,
]);
export const ownedControlReceiptSchema = z
  .object({
    revision: counter,
    selectedOutputs: z.array(identifier).min(1).max(4096),
    data: ownedJsonValueSchema,
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.selectedOutputs).size === value.selectedOutputs.length,
    {
      message: "Selected control outputs must be unique",
    },
  );
export const ownedControlWaitReasonSchema = z.enum([
  "user",
  "ci",
  "dependency",
  "owner",
]);
export const ownedControlWaitingSchema = z
  .object({
    state: z.literal("waiting"),
    resource: ownedControlResourceSchema,
    revision: counter,
    waitReason: ownedControlWaitReasonSchema,
  })
  .strict();
export const ownedStepObservationV2Schema = z.union([
  ownedStepObservationSchema,
  ownedControlWaitingSchema,
  z
    .object({
      ...terminalObservationFields,
      state: z.enum(["succeeded", "failed"]),
      resource: ownedControlResourceSchema,
      receipt: ownedControlReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...terminalObservationFields,
      state: z.literal("interrupted"),
      resource: ownedControlResourceSchema,
    })
    .strict(),
]);

export const ownedValidationReceiptValiditySchema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("checking"),
        validationId: identifier,
        activity: z.enum(["running", "quiescent"]),
        reason: z.string().min(1).max(16_384),
      })
      .strict(),
    z
      .object({
        state: z.literal("current"),
        identityHash: hash,
        validationId: identifier,
      })
      .strict(),
    z
      .object({
        state: z.literal("stale"),
        reason: z.string().min(1).max(16_384),
        validationId: identifier,
      })
      .strict(),
  ],
);

export const ownedReceiptValidityInputSchema = z.union([
  ownedReceiptValiditySchema,
  ownedValidationReceiptValiditySchema,
]);

export const ownedStepObservationInputSchema = z.union([
  ownedStepObservationV2Schema,
  z
    .object({
      state: z.enum(["succeeded", "failed", "interrupted"]),
      resource: ownedStepResourceV2Schema.nullable(),
      receipt: ownedJsonValueSchema,
      receiptHash: hash,
      validity: ownedValidationReceiptValiditySchema,
    })
    .strict()
    .superRefine((observation, context) => {
      if (
        observation.state === "succeeded" &&
        (observation.resource === null ||
          (observation.resource.kind === "agent" &&
            (observation.resource.environmentId === null ||
              observation.resource.turnRequestId === null)))
      )
        context.addIssue({
          code: "custom",
          message:
            "Successful effects require a bound native resource and dispatched turn identity",
        });
      if (
        observation.resource?.kind === "owner-control" &&
        observation.state !== "interrupted"
      ) {
        const receipt = ownedControlReceiptSchema.safeParse(
          observation.receipt,
        );
        if (!receipt.success)
          context.addIssue({
            code: "custom",
            message:
              "Terminal owner controls require an exact declared selection receipt",
          });
      }
    }),
]);

export function resolveOwnedRequirements(
  step: OwnedAdmittedStepV2,
  readDecision: (ref: OwnedStepRef) => OwnedControlReceipt | null,
):
  | { state: "ready"; receipts: OwnedReceiptRequirement[] }
  | { state: "pending"; decision: OwnedStepRef }
  | { state: "unselected"; decision: OwnedStepRef; output: string } {
  const receipts: OwnedReceiptRequirement[] = [];
  for (const requirement of step.requirements) {
    if (requirement.kind === "receipt") {
      receipts.push(requirement);
      continue;
    }
    const decision = readDecision(requirement.decision);
    if (decision === null)
      return { state: "pending", decision: requirement.decision };
    receipts.push({
      kind: "receipt",
      step: requirement.decision,
      outcomes: ["succeeded", "failed"],
    });
    if (requirement.kind === "selection") {
      if (!decision.selectedOutputs.includes(requirement.output))
        return {
          state: "unselected",
          decision: requirement.decision,
          output: requirement.output,
        };
      continue;
    }
    for (const output of decision.selectedOutputs) {
      const branch = requirement.branches.find(
        (candidate) => candidate.output === output,
      );
      if (branch === undefined)
        throw new Error("Selected output has no admitted dependency branch");
      receipts.push(...branch.receipts);
    }
  }
  return { state: "ready", receipts };
}

export const ownedContinuationKeySchema = z
  .object({ predecessorWorkflowRunId: identifier, operationId: identifier })
  .strict();
export const ownedContinuationReserveSchema = ownedContinuationKeySchema
  .extend({
    expectedControlVersion: counter,
    successorOwnerRunId: identifier,
  })
  .strict();
export const ownedContinuationStartSchema = ownedContinuationKeySchema
  .extend({ successor: ownedRunStartInputSchema })
  .strict();
const repairStageCeiling = z.number().int().min(0).max(100);
function compareRepairStageIds(left: string, right: string) {
  return (
    left.localeCompare(right, "en") ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}
const repairStageListSchema = z
  .array(
    z.object({ stageId: identifier, maxRounds: repairStageCeiling }).strict(),
  )
  .max(4096)
  .superRefine((stages, ctx) => {
    if (new Set(stages.map((stage) => stage.stageId)).size !== stages.length)
      ctx.addIssue({
        code: "custom",
        message: "Repair stage IDs must be unique",
      });
  })
  .transform((stages) =>
    stages.sort((a, b) => compareRepairStageIds(a.stageId, b.stageId)),
  );
export const ownedRepairCatalogSchema = z
  .object({ schemaVersion: z.literal(1), stages: repairStageListSchema })
  .strict();
export const ownedRuleContinuationAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewHash: hash,
    repairStages: z
      .array(
        z
          .object({
            stageId: identifier,
            beforeMaxRounds: repairStageCeiling,
            afterMaxRounds: repairStageCeiling,
          })
          .strict(),
      )
      .max(4096)
      .superRefine((stages, ctx) => {
        if (
          new Set(stages.map((stage) => stage.stageId)).size !== stages.length
        )
          ctx.addIssue({
            code: "custom",
            message: "Repair stage IDs must be unique",
          });
      })
      .transform((stages) =>
        stages.sort((a, b) => compareRepairStageIds(a.stageId, b.stageId)),
      ),
  })
  .strict();
export const ownedRuleContinuationStartSchema = ownedContinuationKeySchema
  .extend({
    successor: ownedRunStartV2Schema,
    authorization: ownedRuleContinuationAuthorizationSchema,
  })
  .strict();
export const ownedAddressedContinuationAuthorizationSchema = z
  .object({
    kind: z.literal("addressed"),
    requestHash: hash,
    predecessorPlanHash: hash,
    repairStageMappings: z
      .array(
        z.object({ fromStageId: identifier, toStageId: identifier }).strict(),
      )
      .max(4096)
      .superRefine((entries, context) => {
        if (
          new Set(entries.map((entry) => entry.fromStageId)).size !==
            entries.length ||
          new Set(entries.map((entry) => entry.toStageId)).size !==
            entries.length
        )
          context.addIssue({
            code: "custom",
            message: "Repair stage mappings must be one-to-one",
          });
      }),
  })
  .strict();
export const ownedAddressedContinuationStartSchema = ownedContinuationKeySchema
  .extend({
    successor: ownedRunStartV2Schema,
    authorization: ownedAddressedContinuationAuthorizationSchema,
  })
  .strict();
export const ownedRuleContextSchema = z
  .object({
    run: ownedRunViewSchema,
    repairCatalog: z.union([
      z
        .object({
          source: z.enum(["stored", "manifest"]),
          stages: repairStageListSchema,
        })
        .strict(),
      z.object({ source: z.literal("legacy-zero") }).strict(),
    ]),
  })
  .strict();
export const ownedContinuationViewSchema = ownedContinuationKeySchema
  .extend({
    successorOwnerRunId: identifier,
    successorPlanHash: hash.nullable(),
    state: z.enum(["pausing", "ready", "retiring", "started", "cancelled"]),
    predecessor: ownedRunViewSchema,
    successor: ownedRunViewSchema.nullable(),
  })
  .strict();

export const ownedWorkflowRpcContract = defineRpcContract({
  findActiveOwnedThreadRuns: {
    input: z
      .object({
        projectId: identifier,
        originThreadIds: z.array(identifier).min(1).max(100),
      })
      .strict(),
    output: z
      .object({
        runs: z
          .array(
            z
              .object({
                workflowRunId: identifier,
                ownerRunId: identifier,
                originThreadId: identifier,
                state: ownedRunStateSchema,
                createdAt: counter,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  },
  startOwnedRun: {
    input: ownedRunStartInputSchema,
    output: z.object({ run: ownedRunViewSchema }).strict(),
  },
  controlOwnedRun: {
    input: ownedRunControlSchema,
    output: z.object({ run: ownedRunViewSchema }).strict(),
  },
  inspectOwnedRun: {
    input: z.object({ workflowRunId: identifier }).strict(),
    output: z.object({ run: ownedRunViewSchema }).strict(),
  },
  inspectOwnedRuleContext: {
    input: z.object({ workflowRunId: identifier }).strict(),
    output: ownedRuleContextSchema,
  },
  reserveOwnedContinuation: {
    input: ownedContinuationReserveSchema,
    output: z.object({ continuation: ownedContinuationViewSchema }).strict(),
  },
  inspectOwnedContinuation: {
    input: ownedContinuationKeySchema,
    output: z
      .object({ continuation: ownedContinuationViewSchema.nullable() })
      .strict(),
  },
  cancelOwnedContinuation: {
    input: ownedContinuationKeySchema,
    output: z.object({ continuation: ownedContinuationViewSchema }).strict(),
  },
  startOwnedContinuation: {
    input: ownedContinuationStartSchema,
    output: z.object({ continuation: ownedContinuationViewSchema }).strict(),
  },
  startOwnedRuleContinuation: {
    input: ownedRuleContinuationStartSchema,
    output: z.object({ continuation: ownedContinuationViewSchema }).strict(),
  },
  startOwnedAddressedContinuation: {
    input: ownedAddressedContinuationStartSchema,
    output: z.object({ continuation: ownedContinuationViewSchema }).strict(),
  },
});

export const ownedAdapterRpcContract = defineRpcContract({
  executeStep: {
    input: ownedStepRequestInputSchema,
    output: ownedStepObservationInputSchema,
  },
  observeStep: {
    input: ownedStepObservationLookupInputSchema,
    output: ownedStepObservationInputSchema,
  },
  interruptStep: {
    input: ownedStepObservationLookupInputSchema,
    output: ownedStepObservationInputSchema,
  },
});

export type OwnedRunStart = z.infer<typeof ownedRunStartSchema>;
export type OwnedContinuationKey = z.infer<typeof ownedContinuationKeySchema>;
export type OwnedContinuationReserve = z.infer<
  typeof ownedContinuationReserveSchema
>;
export type OwnedContinuationStart = z.infer<
  typeof ownedContinuationStartSchema
>;
export type OwnedContinuationView = z.infer<typeof ownedContinuationViewSchema>;
export type OwnedRepairCatalog = z.infer<typeof ownedRepairCatalogSchema>;
export type OwnedRuleContext = z.infer<typeof ownedRuleContextSchema>;
export type OwnedRuleContinuationAuthorization = z.infer<
  typeof ownedRuleContinuationAuthorizationSchema
>;
export type OwnedAddressedContinuationAuthorization = z.infer<
  typeof ownedAddressedContinuationAuthorizationSchema
>;
export type OwnedAddressedContinuationStart = z.infer<
  typeof ownedAddressedContinuationStartSchema
>;
export type OwnedRuleContinuationStart = z.infer<
  typeof ownedRuleContinuationStartSchema
>;
export type OwnedRunLimits = z.infer<typeof ownedRunLimitsSchema>;
export type OwnedRunView = z.infer<typeof ownedRunViewSchema>;
export type OwnedRunState = z.infer<typeof ownedRunStateSchema>;
export type OwnedRunControl = z.infer<typeof ownedRunControlSchema>;
export type OwnedStepRef = z.infer<typeof ownedStepRefSchema>;
export type OwnedAdmittedStep = z.infer<typeof ownedAdmittedStepSchema>;
export type OwnedStepKey = z.infer<typeof ownedStepKeySchema>;
export type OwnedStepRequest = z.infer<typeof ownedStepRequestSchema>;
export type OwnedStepLookup = z.infer<typeof ownedStepLookupSchema>;
export type OwnedStepObservation = z.infer<typeof ownedStepObservationSchema>;
export type OwnedStepResource = z.infer<typeof ownedStepResourceSchema>;
export type OwnedDependencyReceipt = z.infer<
  typeof ownedDependencyReceiptSchema
>;
export type OwnedReceiptValidity = z.infer<typeof ownedReceiptValiditySchema>;
export type OwnedLaneClaim = z.infer<typeof ownedLaneClaimSchema>;
export type OwnedStepFailure = z.infer<typeof ownedStepFailureSchema>;
export type OwnedRunStartV2 = z.infer<typeof ownedRunStartV2Schema>;
export type OwnedRunStartInput = z.infer<typeof ownedRunStartInputSchema>;
export type OwnedAdmittedStepV2 = z.infer<typeof ownedAdmittedStepV2Schema>;
export type OwnedReceiptRequirement = z.infer<
  typeof ownedReceiptRequirementSchema
>;
export type OwnedRequirement = z.infer<typeof ownedRequirementSchema>;
export type OwnedControlDeclaration = z.infer<
  typeof ownedControlDeclarationSchema
>;
export type OwnedControlResource = z.infer<typeof ownedControlResourceSchema>;
export type OwnedControlReceipt = z.infer<typeof ownedControlReceiptSchema>;
export type OwnedControlWaitReason = z.infer<
  typeof ownedControlWaitReasonSchema
>;
export type OwnedStepRequestV2 = z.infer<typeof ownedStepRequestV2Schema>;
export type OwnedStepRequestInput = z.infer<typeof ownedStepRequestInputSchema>;
export type OwnedStepLookupV2 = z.infer<typeof ownedStepLookupV2Schema>;
export type OwnedStepLookupInput = z.infer<typeof ownedStepLookupInputSchema>;
export type OwnedValidationAcknowledgement = z.infer<
  typeof ownedValidationAcknowledgementSchema
>;
export type OwnedStepObservationLookupInput = z.infer<
  typeof ownedStepObservationLookupInputSchema
>;
export type OwnedStepObservationV2 = z.infer<
  typeof ownedStepObservationV2Schema
>;
export type OwnedStepResourceV2 = z.infer<typeof ownedStepResourceV2Schema>;
export type OwnedValidationReceiptValidity = z.infer<
  typeof ownedValidationReceiptValiditySchema
>;
export type OwnedReceiptValidityInput = z.infer<
  typeof ownedReceiptValidityInputSchema
>;
export type OwnedStepObservationInput = z.infer<
  typeof ownedStepObservationInputSchema
>;

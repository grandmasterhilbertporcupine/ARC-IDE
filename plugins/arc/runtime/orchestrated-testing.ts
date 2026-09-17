import Database from "better-sqlite3";
import type { OwnedStepObservationV2 } from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { terminalReceipt } from "../../workflows/src/owned-test-fixtures.js";
import { executeWorkflowScript } from "../../workflows/src/runtime.js";
import { parseWorkflowSource } from "../../workflows/src/parser.js";
import { migrations } from "../data.js";
import { runtimeNodeKey } from "./compiler.js";
import {
  createArcRunStore,
  runtimeMigrations,
  type ArcRunEffect,
} from "./data.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import type { OrchestratedRunDefinition } from "./orchestrated-contract.js";
import { runtimeHash } from "./hash.js";
import type { TeamDefinition } from "../teams/contract.js";
import { graphControlReceiptSchema } from "./graph-receipt.js";
import { collaborationMigrations } from "./collaboration-data.js";

export function orchestratedDefinitionFixture(
  update?: (team: TeamDefinition) => void,
): OrchestratedRunDefinition {
  const graph = graphRunDefinitionFixture(update);
  graph.policy.autonomy = "autonomous";
  return {
    ...graph,
    schemaVersion: 3,
    request: {
      ...graph.request,
      invocation: {
        providerThreadId: "provider-main",
        turnId: "native-main",
        callId: "call-main",
      },
    },
    completion: {
      threadId: graph.request.originThreadId,
      environment: {
        hostId: graph.request.hostId,
        environmentId: "environment-main",
        path: graph.request.path,
      },
      execution: Object.values(graph.members)[0].execution,
    },
  };
}

export function createOrchestratedTestRun(
  definition = orchestratedDefinitionFixture(),
) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...workflowMigrations,
      ...collaborationMigrations,
    ].join(";\n"),
  );
  const compiled = compileArcOrchestratedRun(definition);
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  const claimed = claimOwnedRun(db, 4);
  if (!claimed) throw new Error("Fixture run was not claimed");
  store.submitted(definition.runId, workflow.workflowRunId);
  const dispatched: string[] = [];
  let mainEffect: ArcRunEffect | null = null;
  return {
    db,
    compiled,
    store,
    workflow,
    dispatched,
    generation: claimed.row.dispatch_generation,
    mainEffect: () => {
      if (!mainEffect) throw new Error("Main response was not admitted");
      return store.effect(mainEffect.effectId);
    },
    view: () => viewOwnedRun(db, workflow.workflowRunId),
    execute(
      options: {
        failedCheck?: boolean;
        interruptedCheck?: boolean;
        rejectApproval?: boolean;
        before?: (kind: string) => Promise<void>;
        main?: (effect: ArcRunEffect) => Promise<OwnedStepObservationV2>;
        native?: (effect: ArcRunEffect) => OwnedStepObservationV2;
      } = {},
    ) {
      return executeWorkflowScript({
        args: null,
        body: parseWorkflowSource(compiled.workflow.source).body,
        capabilities: {
          agent: async () => {
            throw new Error("Unadmitted provider dispatch");
          },
          async step(nodeId, iteration) {
            const ref = { nodeId, iteration };
            const node = compiled.nodes[runtimeNodeKey(ref)];
            if (!node) throw new Error("Unknown compiled step");
            const attempt = admitOwnedStep(
              db,
              workflow.workflowRunId,
              ref,
              null,
              claimed.row.dispatch_generation,
            );
            if (!attempt)
              throw new Error("Fixture unexpectedly exhausted concurrency");
            store.reserveEffect(attempt.request);
            dispatched.push(node.kind);
            await options.before?.(node.kind);
            let observation: OwnedStepObservationV2;
            if (node.kind === "orchestrator") {
              mainEffect = store.effect(attempt.row.effect_id);
              observation = options.main
                ? await options.main(mainEffect)
                : terminalReceipt(
                    attempt.request,
                    "succeeded",
                    { main: true },
                    "agent",
                  );
            } else if (node.kind === "control") {
              if (node.operation.type === "condition") {
                const predicate = node.operation.predicate;
                const source = store
                  .completionEffects(definition.runId)
                  .find(
                    (effect) =>
                      runtimeNodeKey(effect.request) ===
                      runtimeNodeKey(predicate.source),
                  )?.observation;
                if (!source || !("receipt" in source))
                  throw new Error("Fixture condition source is missing");
                const value =
                  predicate.kind === "outcome"
                    ? source.state === predicate.equals
                    : predicate.kind === "check-exit"
                      ? (predicate.operator === "eq") ===
                        ((source.state === "succeeded" ? 0 : 1) ===
                          predicate.value)
                      : false;
                const receipt = graphControlReceiptSchema.parse({
                  revision: 1,
                  selectedOutputs: [String(value)],
                  data: {
                    workspace: null,
                    check: null,
                    decision: { kind: "condition", value },
                  },
                });
                observation = {
                  state: "succeeded",
                  resource: {
                    kind: "owner-control",
                    controlId: attempt.row.effect_id,
                  },
                  receipt,
                  receiptHash: runtimeHash(receipt),
                  validity: {
                    state: "current",
                    identityHash: attempt.request.definitionHash,
                  },
                };
              } else {
                if (
                  node.operation.type !== "approval" &&
                  node.operation.type !== "barrier"
                )
                  throw new Error(
                    "Fixture supports only approval/barrier controls",
                  );
                const failed =
                  node.operation.type === "approval" && options.rejectApproval;
                const receipt = graphControlReceiptSchema.parse({
                  revision: 1,
                  selectedOutputs: [
                    node.operation.type === "approval"
                      ? failed
                        ? "rejected"
                        : "approved"
                      : "next",
                  ],
                  data: {
                    workspace: null,
                    check: null,
                    decision:
                      node.operation.type === "approval"
                        ? {
                            kind: "approval",
                            value: failed ? "rejected" : "approved",
                            operationId: "decision",
                            contextHash: "a".repeat(64),
                          }
                        : { kind: "barrier" },
                  },
                });
                observation = {
                  state: failed ? "failed" : "succeeded",
                  resource: {
                    kind: "owner-control",
                    controlId: attempt.row.effect_id,
                  },
                  receipt,
                  receiptHash: runtimeHash(receipt),
                  validity: {
                    state: "current",
                    identityHash: attempt.request.definitionHash,
                  },
                };
              }
            } else {
              const state =
                node.kind === "check" && options.interruptedCheck
                  ? "interrupted"
                  : node.kind === "check" && options.failedCheck
                    ? "failed"
                    : "succeeded";
              observation =
                options.native?.(store.effect(attempt.row.effect_id)) ??
                terminalReceipt(
                  attempt.request,
                  state,
                  { node: nodeId },
                  node.kind === "agent" ? "agent" : "host-effect",
                );
            }
            store.recordObservation(attempt.row.effect_id, observation);
            recordOwnedObservation(
              db,
              attempt.row.effect_id,
              claimed.row.dispatch_generation,
              observation,
            );
            if (!("receipt" in observation))
              throw new Error("Fixture step must settle");
            if (observation.state !== "succeeded")
              throw Object.assign(new Error("Recorded native step failed"), {
                stepFailure: {
                  workflowRunId: attempt.request.workflowRunId,
                  ownerRunId: attempt.request.ownerRunId,
                  nodeId: attempt.request.nodeId,
                  iteration: attempt.request.iteration,
                  attempt: attempt.request.attempt,
                  effectId: attempt.request.effectId,
                  requestHash: attempt.request.requestHash,
                  state: observation.state,
                  receipt: observation.receipt,
                  receiptHash: observation.receiptHash,
                },
              });
            return observation.receipt;
          },
          log() {},
          phase() {},
        },
      });
    },
  };
}

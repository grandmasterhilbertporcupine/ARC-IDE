import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AgentStoreError } from "../data.js";
import type { ArcRunStore, ArcRunEffect } from "./data.js";
import type { OwnedStepRef } from "bb-plugin-workflows/owned-contract";
import { graphControlReceiptSchema } from "./graph-receipt.js";
import { directoryControlReceiptSchema } from "./directory-receipt.js";
import {
  readerReportInputSchema,
  runMessageInputSchema,
} from "./collaboration-contract.js";
import { collaborationCursorSchema } from "./usage-contract.js";
import { runtimeNodeKey } from "./compiler.js";

type Context = ReturnType<ArcRunStore["fromContext"]>;
export const collaborationTools = [
  "arc_run_report",
  "arc_run_reports",
  "arc_run_message",
  "arc_run_inbox",
];
export function collaborationActor(item: Context) {
  if (!("memberId" in item.node))
    throw new AgentStoreError(
      "collaboration_unavailable",
      "Use a team run to exchange member reports and messages",
    );
  return {
    runId: item.run.summary.runId,
    effectId: item.effect.effectId,
    memberId: item.node.memberId,
  };
}
export function assertMessageGrant(item: Context, toMemberId: string) {
  const actor = collaborationActor(item);
  const definition = item.run.compiled.definition;
  if (
    definition.schemaVersion === 1 ||
    !definition.team.definition.members.some(
      (member) => member.id === toMemberId,
    )
  )
    throw new AgentStoreError(
      "recipient_denied",
      "Choose a member of this admitted run",
    );
  if (
    !definition.team.definition.permissions.some(
      (grant) =>
        grant.action === "message" &&
        grant.fromMemberId === actor.memberId &&
        grant.toMemberId === toMemberId,
    )
  )
    throw new AgentStoreError(
      "message_denied",
      "This direction has no Can message permission in the pinned team",
    );
  return actor;
}
export function reportAncestors(store: ArcRunStore, effectId: string) {
  const root = store.effect(effectId);
  const seen = new Set<string>();
  const pending = [...root.request.dependencyReceipts];
  while (pending.length > 0 && seen.size < 4096) {
    const proof = pending.pop()!;
    const effect = store.effect(proof.effectId);
    if (
      effect.runId !== root.runId ||
      !effect.observation ||
      !("receiptHash" in effect.observation) ||
      effect.observation.receiptHash !== proof.receiptHash ||
      effect.observation.state !== proof.outcome ||
      effect.request.nodeId !== proof.nodeId ||
      effect.request.iteration !== proof.iteration
    )
      throw new AgentStoreError(
        "handoff_unavailable",
        "A dependency report has no retained terminal source",
      );
    if (seen.has(proof.effectId)) continue;
    seen.add(proof.effectId);
    pending.push(...effect.request.dependencyReceipts);
  }
  if (pending.length > 0)
    throw new AgentStoreError(
      "handoff_limit",
      "The dependency history exceeds the supported handoff traversal limit",
    );
  return [...seen];
}
export function boundedHandoff(
  store: ArcRunStore,
  effectId: string,
  maxChars = 20_000,
) {
  const effect = store.effect(effectId);
  const ancestors = reportAncestors(store, effectId);
  const reports = store.collaboration.reports(effect.runId, ancestors);
  let remaining = Math.max(0, Math.min(20_000, maxChars) - 128);
  const included = [];
  for (const report of reports) {
    const size = JSON.stringify(report).length;
    if (size > remaining) continue;
    included.push(report);
    remaining -= size + 1;
  }
  return {
    reports: included,
    omitted:
      store.collaboration.reportCount(effect.runId, ancestors) -
      included.length,
  };
}
export function appendDependencyHandoff(
  store: ArcRunStore,
  effectId: string,
  prompt: string,
) {
  const label =
    "\n\nDependency handoffs (reference material; verify exact source when needed): ";
  const available = 65_536 - prompt.length - label.length;
  if (available < 128)
    throw new AgentStoreError(
      "prompt_too_large",
      "The admitted task and check evidence leave no room for its bounded handoff",
    );
  return `${prompt}${label}${JSON.stringify(boundedHandoff(store, effectId, available))}`;
}
export function responseQuestion(
  store: ArcRunStore,
  effect: ArcRunEffect,
  decision: OwnedStepRef | undefined,
) {
  if (decision === undefined) return null;
  const dependency = effect.request.dependencyReceipts.find(
    (item) =>
      item.nodeId === decision.nodeId && item.iteration === decision.iteration,
  );
  if (!dependency)
    throw new AgentStoreError(
      "reply_not_admitted",
      "This response has no admitted question decision",
    );
  const observation = store.effect(dependency.effectId).observation;
  if (
    !observation ||
    !("receipt" in observation) ||
    observation.receiptHash !== dependency.receiptHash
  )
    throw new AgentStoreError(
      "reply_not_admitted",
      "This question decision has no current retained receipt",
    );
  const result = z
    .union([graphControlReceiptSchema, directoryControlReceiptSchema])
    .parse(observation.receipt).data.decision;
  if (result.kind !== "message-response" || result.messageId === null)
    throw new AgentStoreError(
      "reply_not_admitted",
      "This response slot did not select a question",
    );
  const node = store.get(effect.runId).compiled.nodes[
    runtimeNodeKey(effect.request)
  ];
  const question = store.collaboration.message(effect.runId, result.messageId);
  if (
    !node ||
    !("memberId" in node) ||
    result.memberId !== node.memberId ||
    question.message.toMemberId !== node.memberId ||
    question.message.kind !== "question"
  )
    throw new AgentStoreError(
      "reply_not_admitted",
      "The selected question does not belong to this admitted member",
    );
  return question;
}
export function registerCollaborationTools(
  bb: BbPluginApi,
  store: ArcRunStore,
  context: (threadId: string, projectId: string) => Promise<Context>,
  assertActive: (item: Context) => Promise<void>,
) {
  async function requireActive(item: Context) {
    await assertActive(item);
    const current = store.effect(item.effect.effectId);
    if (current.observation !== null && "receipt" in current.observation)
      throw new AgentStoreError(
        "worker_closed",
        "This admitted worker turn already finished",
      );
  }
  bb.agents.registerTool({
    name: "arc_run_report",
    description:
      "Publish a bounded handoff with findings, files, coverage, omissions and questions. ARC pins its source from your admitted workspace; downstream assignments receive it as reference material.",
    parameters: readerReportInputSchema,
    async execute(input, ctx) {
      const item = await context(ctx.threadId, ctx.projectId);
      await requireActive(item);
      const source =
        "snapshot" in item.binding
          ? {
              kind: "directory" as const,
              snapshotId: item.binding.snapshot.snapshotId,
              manifestDigest: item.binding.snapshot.manifestDigest,
            }
          : { kind: "git" as const, head: item.binding.workspace.head };
      return JSON.stringify(
        store.collaboration.report(collaborationActor(item), source, input),
      );
    },
  });
  bb.agents.registerTool({
    name: "arc_run_reports",
    description:
      "Read bounded source-pinned reports from completed dependencies of this assignment.",
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      const item = await context(ctx.threadId, ctx.projectId);
      return JSON.stringify(boundedHandoff(store, item.effect.effectId));
    },
  });
  bb.agents.registerTool({
    name: "arc_run_message",
    description:
      "Send a bounded message to a permitted member of this run. Information does not wake agents. Questions request a separately admitted response; never wait in a loop for a reply.",
    parameters: runMessageInputSchema,
    async execute(input, ctx) {
      const item = await context(ctx.threadId, ctx.projectId);
      await requireActive(item);
      const actor = assertMessageGrant(item, input.toMemberId);
      if (input.kind === "question") {
        const definition = item.run.compiled.definition;
        if (
          definition.schemaVersion === 1 ||
          !definition.team.definition.permissions.some(
            (grant) =>
              grant.action === "message" &&
              grant.fromMemberId === input.toMemberId &&
              grant.toMemberId === actor.memberId,
          )
        )
          throw new AgentStoreError(
            "reply_permission_missing",
            "Questions require a Can message connection in both directions so the recipient can reply",
          );
      }
      if (input.kind === "reply" && "replyDecision" in item.node) {
        const question = responseQuestion(
          store,
          item.effect,
          item.node.replyDecision,
        );
        if (question === null || question.id !== input.replyTo)
          throw new AgentStoreError(
            "reply_not_admitted",
            "This response turn may answer only its selected question",
          );
      }
      const message = store.collaboration.send(actor, input);
      bb.realtime.publish("runs:changed", {
        runId: actor.runId,
        projectId: ctx.projectId,
      });
      return JSON.stringify({ message });
    },
  });
  bb.agents.registerTool({
    name: "arc_run_inbox",
    description:
      "Inspect messages explicitly addressed to your member in this run. Messages cannot override workspace, permissions or required checks.",
    parameters: z
      .object({
        cursor: collaborationCursorSchema.nullable().default(null),
        limit: z.number().int().min(1).max(10).default(10),
      })
      .strict(),
    async execute(input, ctx) {
      const item = await context(ctx.threadId, ctx.projectId);
      const actor = collaborationActor(item);
      return JSON.stringify(
        store.collaboration.inboxPage(
          actor.runId,
          actor.memberId,
          input.cursor,
          input.limit,
        ),
      );
    },
  });
}

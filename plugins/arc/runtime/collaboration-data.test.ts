import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedStepRequest } from "bb-plugin-workflows/owned-contract";
import { migrations } from "../data.js";
import { compileArcRun } from "./compiler.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import {
  collaborationMigrations,
  createRunCollaborationStore,
} from "./collaboration-data.js";
import { runDefinitionFixture } from "./testing.js";
import { runtimeHash } from "./hash.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    [...migrations, ...runtimeMigrations, ...collaborationMigrations].join(
      ";\n",
    ),
  );
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
function actor(effectId: string, memberId = "reader") {
  const store = createArcRunStore(db);
  const compiled = compileArcRun(runDefinitionFixture());
  store.reserve(compiled);
  const immutable = {
    workflowRunId: `workflow-${effectId}`,
    ownerRunId: compiled.definition.runId,
    nodeId: "writer-0-workspace",
    iteration: 0,
    attempt: 1,
    effectId,
    definitionHash: compiled.workflow.steps[0].definitionHash,
    dependencyReceipts: [],
    lane: null,
    input: null,
  };
  const request: OwnedStepRequest = {
    ...immutable,
    requestHash: runtimeHash({ owner: "arc", ...immutable }),
    dispatchGeneration: 1,
  };
  store.reserveEffect(request);
  return { runId: compiled.definition.runId, effectId, memberId };
}
const findings = {
  operationId: "report-one",
  findings: "The quote route multiplies unit price by quantity.",
  files: [{ path: "src/quote.ts", detail: "Pricing implementation" }],
  coverage: "Read route and its caller.",
  omissions: "Provider integration was not inspected.",
  questions: ["Does the input include tax?"],
};
describe("durable bounded collaboration", () => {
  it("retains source-pinned reports across reopen and rejects changed retries", () => {
    const identity = actor("effect-reader");
    const store = createRunCollaborationStore(db);
    const source = { kind: "git" as const, head: "a".repeat(40) };
    const report = store.report(identity, source, findings);
    expect(store.report(identity, source, findings)).toEqual(report);
    expect(
      createRunCollaborationStore(db).reports(identity.runId, [
        identity.effectId,
      ]),
    ).toEqual([report]);
    expect(() =>
      store.report(identity, source, {
        ...findings,
        findings: "Changed finding",
      }),
    ).toThrow("report_conflict");
    expect(store.reports(identity.runId, ["other-effect"])).toEqual([]);
    expect(() =>
      store.report(identity, source, {
        ...findings,
        operationId: "escape",
        files: [{ path: "../secrets", detail: "outside" }],
      }),
    ).toThrow("relative path");
  });
  it("enforces content and per-turn report bounds", () => {
    const identity = actor("effect-reader");
    const store = createRunCollaborationStore(db);
    const source = { kind: "git" as const, head: "a".repeat(40) };
    expect(() =>
      store.report(identity, source, {
        ...findings,
        findings: "a".repeat(8001),
      }),
    ).toThrow();
    for (let i = 0; i < 4; i++)
      store.report(identity, source, {
        ...findings,
        operationId: `report-${i}`,
      });
    expect(() => store.report(identity, source, findings)).toThrow(
      "report_limit",
    );
  });
  it("deduplicates messages and binds replies to the addressed member and run", () => {
    const sender = actor("effect-sender", "builder");
    const outsider = actor("effect-outsider", "lead");
    const store = createRunCollaborationStore(db);
    const input = {
      operationId: "question-one",
      kind: "question" as const,
      toMemberId: "lead",
      text: "Should invalid quantities return HTTP 400?",
      replyTo: null,
    };
    const question = store.send(sender, input);
    expect(store.send(sender, input)).toEqual(question);
    expect(
      createRunCollaborationStore(db).inbox(sender.runId, "lead", 0),
    ).toEqual([question]);
    expect(store.inbox(outsider.runId, "lead", 0)).toEqual([]);
    const reply = {
      operationId: "reply-one",
      kind: "reply" as const,
      toMemberId: "builder",
      text: "Yes. Preserve the existing error contract.",
      replyTo: question.id,
    };
    expect(() => store.send(outsider, reply)).toThrow("message_not_found");
    expect(() =>
      store.send({ ...sender, memberId: "reviewer" }, reply),
    ).toThrow("reply_denied");
    const answer = store.send({ ...sender, memberId: "lead" }, reply);
    expect(store.send({ ...sender, memberId: "lead" }, reply)).toEqual(answer);
    expect(() =>
      store.send(
        { ...sender, memberId: "lead" },
        { ...reply, operationId: "another-reply" },
      ),
    ).toThrow("question_answered");
  });
  it("rejects changed message retries and caps per-turn inbox traffic", () => {
    const sender = actor("effect-sender");
    const store = createRunCollaborationStore(db);
    const input = {
      operationId: "info-one",
      kind: "information" as const,
      toMemberId: "builder",
      text: "See the pinned report.",
      replyTo: null,
    };
    store.send(sender, input);
    expect(() => store.send(sender, { ...input, text: "Changed" })).toThrow(
      "message_conflict",
    );
    for (let i = 1; i < 16; i++)
      store.send(sender, { ...input, operationId: `info-${i}` });
    expect(() =>
      store.send(sender, { ...input, operationId: "overflow" }),
    ).toThrow("message_limit");
    expect(store.inbox(sender.runId, "builder", 0, 5)).toHaveLength(5);
  });
  it("pages same-millisecond inbox messages without repeating or dropping recipients", () => {
    const sender = actor("effect-sender");
    const store = createRunCollaborationStore(db);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    for (let index = 0; index < 8; index++)
      store.send(sender, {
        operationId: `info-${index}`,
        kind: "information",
        toMemberId: index === 7 ? "reviewer" : "builder",
        text: "Pinned finding",
        replyTo: null,
      });
    const first = store.inboxPage(sender.runId, "builder", null, 5);
    expect(first.messages).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const last = store.inboxPage(sender.runId, "builder", first.nextCursor, 5);
    expect(last.messages).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([...first.messages, ...last.messages].map((item) => item.id))
        .size,
    ).toBe(7);
  });
});

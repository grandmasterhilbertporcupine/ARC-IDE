import { describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { filterBrowserThreads } from "./threadBrowserState";

describe("thread browser project and activity scope", () => {
  it("keeps a delegated child in its ancestor project and hides internal threads", () => {
    const parent = makeThreadListEntry({
      id: "parent",
      projectId: "project-a",
    });
    const child = makeThreadListEntry({
      id: "child",
      projectId: "project-b",
      parentThreadId: parent.id,
    });
    const hidden = makeThreadListEntry({
      id: "hidden",
      projectId: "project-a",
      visibility: "hidden",
    });
    const other = makeThreadListEntry({ id: "other", projectId: "project-b" });
    expect(
      filterBrowserThreads(
        [parent, child, hidden, other],
        "project-a",
        "all",
      ).map((thread) => thread.id),
    ).toEqual(["parent", "child"]);
    expect(
      filterBrowserThreads(
        [parent, child, hidden, other],
        "project-b",
        "all",
      ).map((thread) => thread.id),
    ).toEqual(["other"]);
  });

  it("includes the ancestor chain for working children without unrelated siblings", () => {
    const parent = makeThreadListEntry({ id: "parent" });
    const child = makeThreadListEntry({
      id: "child",
      parentThreadId: "parent",
    });
    const worker = makeThreadListEntry({
      id: "worker",
      parentThreadId: "child",
      activity: { activeWorkflowCount: 1 },
    });
    const sibling = makeThreadListEntry({
      id: "sibling",
      parentThreadId: "parent",
    });
    expect(
      filterBrowserThreads(
        [parent, child, worker, sibling],
        null,
        "working",
      ).map((thread) => thread.id),
    ).toEqual(["parent", "child", "worker"]);
  });

  it("uses real pending interactions and queue failures for attention", () => {
    const ready = makeThreadListEntry({
      id: "ready",
      lastReadAt: 10,
      latestAttentionAt: 1,
    });
    const input = makeThreadListEntry({
      id: "input",
      hasPendingInteraction: true,
    });
    const failed = makeThreadListEntry({ id: "failed", queuedWork: "failed" });
    const waiting = makeThreadListEntry({
      id: "waiting",
      queuedWork: "waiting",
    });
    expect(
      filterBrowserThreads(
        [ready, input, failed, waiting],
        null,
        "attention",
      ).map((thread) => thread.id),
    ).toEqual(["input", "failed"]);
  });

  it("terminates on a malformed parent cycle and leaves source records unchanged", () => {
    const a = makeThreadListEntry({ id: "a", parentThreadId: "b" });
    const b = makeThreadListEntry({
      id: "b",
      parentThreadId: "a",
      hasPendingInteraction: true,
    });
    const before = structuredClone([a, b]);
    expect(filterBrowserThreads([a, b], null, "attention")).toHaveLength(2);
    expect([a, b]).toEqual(before);
  });
});

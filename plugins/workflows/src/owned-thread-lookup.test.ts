import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "./data.js";
import { createOwnedRun, findActiveOwnedThreadRuns } from "./owned-data.js";
import { ownedRunInput } from "./owned-test-fixtures.js";
import { ownedWorkflowRpcContract } from "./owned-contract.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("owned thread active lookup", () => {
  it("finds the newest nonterminal run across history and scopes owner, project and exact origin", () => {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(migrations.join("\n"));
    const add = (
      ownerRunId: string,
      createdAt: number,
      overrides = {},
      owner = "arc",
    ) =>
      createOwnedRun(
        db,
        owner,
        ownedRunInput({ ownerRunId, ...overrides }),
        createdAt,
      );
    const older = add("old-active", 1);
    const newer = add("new-active", 2);
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'paused' WHERE id = ?",
    ).run(newer.workflowRunId);
    for (let i = 0; i < 25; i += 1) {
      const run = add(`finished-${i}`, 10 + i);
      db.prepare(
        "UPDATE workflow_owned_runs SET state = 'succeeded' WHERE id = ?",
      ).run(run.workflowRunId);
    }
    add("foreign-owner", 100, {}, "other-plugin");
    add("foreign-project", 101, { projectId: "elsewhere" });
    add("foreign-origin", 102, { originThreadId: "elsewhere" });
    const result = findActiveOwnedThreadRuns(db, "arc", {
      projectId: "project-1",
      originThreadIds: ["origin-1"],
    });
    expect(result).toEqual([
      {
        workflowRunId: newer.workflowRunId,
        ownerRunId: "new-active",
        originThreadId: "origin-1",
        state: "paused",
        createdAt: 2,
      },
    ]);
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'cancelled' WHERE id = ?",
    ).run(newer.workflowRunId);
    expect(
      findActiveOwnedThreadRuns(db, "arc", {
        projectId: "project-1",
        originThreadIds: ["origin-1"],
      })[0].workflowRunId,
    ).toBe(older.workflowRunId);
    expect(
      findActiveOwnedThreadRuns(db, "none", {
        projectId: "project-1",
        originThreadIds: ["origin-1"],
      }),
    ).toEqual([]);
  });

  it("bounds the authenticated batch contract and rejects extra authority fields", () => {
    const schema = ownedWorkflowRpcContract.findActiveOwnedThreadRuns.input;
    expect(
      schema.safeParse({ projectId: "p", originThreadIds: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        projectId: "p",
        originThreadIds: Array.from({ length: 101 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ projectId: "p", originThreadIds: ["t"], owner: "arc" })
        .success,
    ).toBe(false);
  });
});

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { createAgentStore, migrations } from "../data.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { createArcRunService } from "./service.js";
import { graphServicesFixture, runDefinitionFixture } from "./testing.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function fixture(kind: "git" | "directory" | "unavailable") {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec([...migrations, ...runtimeMigrations].join(";\n"));
  const agents = createAgentStore(db);
  const original = runDefinitionFixture();
  const methods: string[] = [];
  const fake = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        get: () => ({
          id: "project-a",
          kind: "standard",
          sources: [
            { hostId: "host-other", path: "C:/Other folder", isDefault: false },
            { hostId: "host-a", path: original.source.path, isDefault: true },
          ],
        }),
      },
      threads: {
        list: () => [{ id: "thread-parent", title: "Main conversation" }],
      },
    },
    async experimental_callHostRpc(call) {
      methods.push(call.method);
      expect(call.hostId).toBe("host-a");
      if (call.method === "inspectProjectSource") {
        if (kind === "unavailable")
          throw new Error("Access denied while identifying the project source");
        return { kind, path: original.source.path };
      }
      if (call.method === "inspectWorkspace")
        return {
          path: original.source.path,
          topLevel: original.source.path,
          gitDir: original.source.commonGitDir,
          commonGitDir: original.source.commonGitDir,
          head: original.source.head,
          currentBranch: "main",
          clean: false,
          trackedDigest: "b".repeat(64),
          untrackedDigest: "b".repeat(64),
          contentDigest: "b".repeat(64),
          stateDigest: original.source.stateHash,
        };
      throw new Error(`Unexpected source setup effect: ${call.method}`);
    },
  });
  hosts.push(fake);
  const runs = createArcRunService(
    fake.bb,
    createArcRunStore(db),
    agents,
    graphServicesFixture(db, agents, fake.bb),
  );
  return { runs, methods, db };
}

describe("project source setup", () => {
  it("identifies a plain folder without inventing a Git identity or starting work", async () => {
    const { runs, methods, db } = fixture("directory");
    const result = await runs
      .handlers()
      .getProjectRunSetup({ projectId: "project-a", hostId: null });
    expect(result.selected).toEqual({
      kind: "directory",
      hostId: "host-a",
      path: "C:/Project 東京",
    });
    expect(methods).toEqual(["inspectProjectSource"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM arc_runs").get()).toEqual({
      count: 0,
    });
  });

  it("preserves the actual dirty Git state for an explicitly selected host", async () => {
    const { runs, methods } = fixture("git");
    const result = await runs
      .handlers()
      .getProjectRunSetup({ projectId: "project-a", hostId: "host-a" });
    expect(result.selected).toMatchObject({
      kind: "git",
      head: "a".repeat(40),
      clean: false,
    });
    expect(methods).toEqual(["inspectProjectSource", "inspectWorkspace"]);
  });

  it("does not reinterpret a host failure as a plain directory", async () => {
    const { runs, methods } = fixture("unavailable");
    await expect(
      runs
        .handlers()
        .getProjectRunSetup({ projectId: "project-a", hostId: null }),
    ).rejects.toThrow("Access denied");
    expect(methods).toEqual(["inspectProjectSource"]);
  });

  it("rejects a missing selected host without inspecting another source", async () => {
    const { runs, methods } = fixture("directory");
    await expect(
      runs
        .handlers()
        .getProjectRunSetup({ projectId: "project-a", hostId: "not-enrolled" }),
    ).rejects.toMatchObject({ code: "project_source_missing" });
    expect(methods).toEqual([]);
  });

  it("rejects cross-project agent context before host inspection", async () => {
    const { runs, methods } = fixture("directory");
    await expect(
      runs
        .handlers({
          kind: "agent",
          projectId: "other-project",
          threadId: "thread-parent",
        })
        .getProjectRunSetup({ projectId: "project-a", hostId: null }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(methods).toEqual([]);
  });
});

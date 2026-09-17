import { describe, expect, it } from "vitest";
import { getThread, listEnvironments } from "@bb/db";
import { handleUpdateEnvironmentDirectoryToolCall } from "../../src/services/threads/thread-environment-directory.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";

describe("thread environment directory paths", () => {
  it.each([
    String.raw`C:\work\ARC Project`,
    String.raw`\\server\share\ARC Project`,
    "/home/user/arc-project",
  ])("switches to an existing environment at %s", async (path) => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const currentEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/current",
      });
      const target = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path,
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: currentEnvironment.id,
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: currentEnvironment.id,
        turnId: "turn_path",
      });
      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        { currentEnvironment, input: { path }, thread, turnId: "turn_path" },
      );
      expect(result.success).toBe(true);
      expect(getThread(harness.db, thread.id)?.environmentId).toBe(target.id);
      expect(listEnvironments(harness.db, project.id)).toHaveLength(2);
    });
  });

  it.each([
    "../relative",
    "C:relative",
    "C:\\",
    "/",
    String.raw`\\server\share`,
    String.raw`\\?\C:\work`,
    "/project\u0000bad",
  ])(
    "rejects invalid project directory %s without mutating the thread",
    async (path) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const currentEnvironment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/current",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: currentEnvironment.id,
        });
        const result = await handleUpdateEnvironmentDirectoryToolCall(
          harness.deps,
          { currentEnvironment, input: { path }, thread, turnId: "turn_path" },
        );
        expect(result.success).toBe(false);
        expect(getThread(harness.db, thread.id)?.environmentId).toBe(
          currentEnvironment.id,
        );
        expect(listEnvironments(harness.db, project.id)).toHaveLength(1);
      });
    },
  );
});

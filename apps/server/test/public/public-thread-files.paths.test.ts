import { hostDaemonSessions } from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  listQueuedCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe.each([
  { name: "POSIX", root: "/srv/remote data", separator: "/" },
  { name: "Windows drive", root: "D:\\Remote Data", separator: "\\" },
  { name: "Windows UNC", root: "\\\\remote\\share\\data", separator: "\\" },
])("remote $name thread paths", ({ root, separator }) => {
  it("preserves remote storage, worktree and absolute file paths in host reads", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      harness.db
        .update(hostDaemonSessions)
        .set({ dataDir: root })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();
      harness.deps.hub.recordDaemonSessionPlatform(
        session.id,
        separator === "/" ? "linux" : "win32",
      );
      const worktreePath = `${root}${separator}project`;
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: worktreePath,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: worktreePath,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const storagePath = `${root}${separator}thread-storage${separator}${thread.id}`;
      const threadUrl = `/api/v1/threads/${thread.id}`;
      const locationResponse = await harness.app.request(
        `${threadUrl}/thread-storage/location`,
      );
      expect(locationResponse.status).toBe(200);
      await expect(readJson(locationResponse)).resolves.toEqual({
        hostId: host.id,
        storageRootPath: storagePath,
      });

      const content = "<!doctype html><h1>Remote preview</h1>";
      const storageFile = `${storagePath}${separator}reports${separator}preview v2.html`;
      const worktreeFile = `${worktreePath}${separator}reports${separator}preview v2.html`;
      const absoluteFile = `${root}${separator}reports${separator}preview v2.html`;
      for (const { url, path, rootPath } of [
        {
          url: `${threadUrl}/thread-storage/files/reports/preview%20v2.html`,
          path: storageFile,
          rootPath: storagePath,
        },
        {
          url: `${threadUrl}/thread-storage/content?path=reports%2Fpreview%20v2.html`,
          path: storageFile,
          rootPath: storagePath,
        },
        {
          url: `${threadUrl}/worktree/files/reports/preview%20v2.html`,
          path: worktreeFile,
          rootPath: worktreePath,
        },
        {
          url: `${threadUrl}/files/raw?path=${encodeURIComponent(`${root}${separator}reports${separator}old${separator}..${separator}preview v2.html`)}`,
          path: absoluteFile,
          rootPath: undefined,
        },
      ]) {
        const responsePromise = harness.app.request(url);
        const fileCommand = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "host.read_file",
        );
        expect(fileCommand.row.hostId).toBe(host.id);
        expect(fileCommand.command).toEqual({
          type: "host.read_file",
          path,
          ...(rootPath === undefined ? {} : { rootPath }),
        });
        await reportQueuedCommandSuccess(harness, fileCommand, {
          path,
          content,
          contentEncoding: "utf8",
          mimeType: "text/html",
          sizeBytes: Buffer.byteLength(content),
          sha256: "0".repeat(64),
        });
        const response = await responsePromise;
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(content);
      }

      for (const relativePath of [
        "reports/../outside.html",
        "reports\\..\\outside.html",
      ]) {
        const response = await harness.app.request(
          `${threadUrl}/thread-storage/content?path=${encodeURIComponent(relativePath)}`,
        );
        expect(response.status).toBe(400);
      }
      for (const relativePath of ["relative/report.html", "C:report.html"]) {
        const response = await harness.app.request(
          `${threadUrl}/files/raw?path=${encodeURIComponent(relativePath)}`,
        );
        expect(response.status).toBe(400);
      }
      expect(listQueuedCommands(harness, "host.read_file")).toEqual([]);
    });
  });
});

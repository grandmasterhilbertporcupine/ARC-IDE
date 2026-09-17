import { archiveThread, insertEvents } from "@bb/db";
import { threadScope } from "@bb/domain";
import { threadSearchResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public thread search route", () => {
  it("scopes search to the requested project and includes its last requested model", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const own = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/own",
      }).project;
      const other = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/other",
      }).project;
      const thread = seedThread(harness.deps, {
        projectId: own.id,
        title: "needle",
        providerId: "custom-provider",
      });
      seedThread(harness.deps, { projectId: other.id, title: "needle" });
      insertEvents(harness.deps.db, harness.deps.hub, [
        {
          threadId: thread.id,
          sequence: 1,
          type: "client/turn/requested",
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ execution: { model: "retained-model" } }),
        },
      ]);
      const response = await harness.app.request(
        `/api/v1/threads/search?query=needle&projectId=${own.id}&limitPerGroup=1`,
      );
      expect(response.status).toBe(200);
      const body = threadSearchResponseSchema.parse(await readJson(response));
      expect(body.active.total).toBe(1);
      expect(body.active.results.map((result) => result.thread.id)).toEqual([
        thread.id,
      ]);
      expect(body.active.results[0]?.thread.lastRequestedModel).toEqual({
        providerId: "custom-provider",
        model: "retained-model",
      });
      const global = await harness.app.request(
        "/api/v1/threads/search?query=needle&limitPerGroup=1",
      );
      expect(
        threadSearchResponseSchema.parse(await readJson(global)).active.total,
      ).toBe(2);
      const unknown = await harness.app.request(
        "/api/v1/threads/search?query=needle&projectId=missing",
      );
      expect(
        threadSearchResponseSchema.parse(await readJson(unknown)).active,
      ).toEqual({ total: 0, results: [] });
      expect(
        (
          await harness.app.request(
            "/api/v1/threads/search?query=needle&projectId=",
          )
        ).status,
      ).toBe(400);
    });
  });

  it("returns active and archived search result groups", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "routeactive",
        titleFallback: "routeactive",
      });
      const archivedThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "routearchived",
        titleFallback: "routearchived",
      });
      archiveThread(harness.deps.db, harness.deps.hub, archivedThread.id);
      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "routehidden",
        titleFallback: "routehidden",
        visibility: "hidden",
      });
      const hiddenArchivedThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "routehiddenarchived",
        titleFallback: "routehiddenarchived",
        visibility: "hidden",
      });
      archiveThread(harness.deps.db, harness.deps.hub, hiddenArchivedThread.id);

      const response = await harness.app.request(
        "/api/v1/threads/search?query=route&limitPerGroup=10",
      );

      expect(response.status).toBe(200);
      const body = threadSearchResponseSchema.parse(await readJson(response));
      expect(body.active.results.map((result) => result.thread.id)).toContain(
        activeThread.id,
      );
      expect(body.archived.results.map((result) => result.thread.id)).toContain(
        archivedThread.id,
      );
      expect(
        [...body.active.results, ...body.archived.results].map(
          (result) => result.thread.id,
        ),
      ).not.toContain(hiddenThread.id);
      expect(
        [...body.active.results, ...body.archived.results].map(
          (result) => result.thread.id,
        ),
      ).not.toContain(hiddenArchivedThread.id);
    });
  });

  it("validates required query and limit parameters before the thread-id route", async () => {
    await withTestHarness(async (harness) => {
      const missingQueryResponse = await harness.app.request(
        "/api/v1/threads/search",
      );
      expect(missingQueryResponse.status).toBe(400);

      const shortQueryResponse = await harness.app.request(
        "/api/v1/threads/search?query=x",
      );
      expect(shortQueryResponse.status).toBe(400);

      const badLimitResponse = await harness.app.request(
        "/api/v1/threads/search?query=valid&limitPerGroup=bad",
      );
      expect(badLimitResponse.status).toBe(400);
    });
  });
});

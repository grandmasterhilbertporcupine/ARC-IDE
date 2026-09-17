import { upsertProjectExecutionDefaults } from "@bb/db";
import { sidebarBootstrapResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("project reads before provider readiness", () => {
  it("loads a fresh sidebar and unset defaults without an available provider", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        expect(
          harness.deps.providerRegistry
            .list()
            .some(({ info }) => info.available),
        ).toBe(false);
        const response = await harness.app.request("/api/v1/sidebar-bootstrap");
        expect(response.status).toBe(200);
        const bootstrap = sidebarBootstrapResponseSchema.parse(
          await readJson(response),
        );
        expect(bootstrap.personalProject.defaultExecutionOptions).toBeNull();
        expect(bootstrap.projects).toEqual([]);
        const defaults = await harness.app.request(
          `/api/v1/projects/${bootstrap.personalProject.id}/default-execution-options`,
        );
        expect(defaults.status).toBe(200);
        expect(await readJson(defaults)).toBeNull();
      },
    );
  });

  it("preserves saved defaults when their provider is unavailable", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/unavailable-project-provider",
      });
      const defaults = {
        providerId: "unavailable-test-provider",
        model: "gpt-5-mini",
        serviceTier: "default" as const,
        reasoningLevel: "medium" as const,
        permissionMode: "full" as const,
      };
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        ...defaults,
      });
      const registration = harness.deps.providerRegistry.get("codex");
      if (!registration) throw new Error("Missing provider fixture");
      const unavailable = harness.deps.providerRegistry.register({
        ...registration,
        info: {
          ...registration.info,
          id: defaults.providerId,
          available: false,
        },
      });
      try {
        const bootstrapResponse = await harness.app.request(
          "/api/v1/sidebar-bootstrap",
        );
        expect(bootstrapResponse.status).toBe(200);
        const bootstrap = sidebarBootstrapResponseSchema.parse(
          await readJson(bootstrapResponse),
        );
        expect(
          bootstrap.projects.find(({ id }) => id === project.id)
            ?.defaultExecutionOptions,
        ).toEqual(defaults);
        const listed = await harness.app.request(
          "/api/v1/projects?include=threads",
        );
        expect(listed.status).toBe(200);
        expect(await readJson(listed)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: project.id,
              defaultExecutionOptions: defaults,
            }),
          ]),
        );
        const stored = await harness.app.request(
          `/api/v1/projects/${project.id}/default-execution-options`,
        );
        expect(stored.status).toBe(200);
        expect(await readJson(stored)).toEqual(defaults);
      } finally {
        unavailable.dispose();
      }
    });
  });

  it("still refuses to start work without an enabled provider", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/no-project-provider",
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: "/tmp/no-project-provider",
        });
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            input: [{ type: "text", text: "Start work" }],
            environment: { type: "reuse", environmentId: environment.id },
          }),
        });
        expect(response.status).toBe(409);
        expect(await readJson(response)).toMatchObject({
          code: "no_provider_available",
        });
      },
    );
  });
});

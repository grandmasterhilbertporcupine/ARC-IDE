// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TeamTemplateCatalog } from "./panel.js";
import type { TemplateConfiguration } from "./contract.js";

const harness = vi.hoisted(() => ({ rpc: { call: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  experimental_ProviderModelPicker: ({
    value,
    routing,
  }: {
    value: { model: string };
    routing: { hostId: string };
  }) => (
    <span data-host={routing.hostId}>{value.model || "Choose a model"}</span>
  ),
}));

const execution = {
  providerId: "codex",
  model: "available-model",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  serviceTier: "default",
} as const;
const configuration: TemplateConfiguration = {
  roles: {
    lead: execution,
    reader: execution,
    builder: execution,
    reviewer: execution,
  },
  check: { executable: "node", args: ["--test"], timeoutMs: 120000 },
};
const created = {
  team: {
    id: "created-team",
    scope: { kind: "project", projectId: "project-1" },
  },
  reused: false,
};
const onOpen = vi.fn();
const renderCatalog = () =>
  render(
    <TeamTemplateCatalog
      projects={[{ id: "project-1", name: "Project one" }]}
      projectId="project-1"
      onOpen={onOpen}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(cleanup);

describe("bundled template setup", () => {
  it("loads global choices for the actual host but requires this project's check before creation", async () => {
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getTeamTemplateSetup"
        ? {
            configuration: null,
            defaultRoles: configuration.roles,
            defaultsSource: "global",
            hostId: "host-project",
            blockers: [],
          }
        : created,
    );
    renderCatalog();
    expect(harness.rpc.call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use this team" }));
    const executable = await screen.findByRole("textbox", {
      name: "Template check executable",
    });
    expect(
      screen.getByText(/Using your last successful model choices/),
    ).toBeTruthy();
    expect(
      screen
        .getAllByText("available-model")
        .every((node) => node.dataset.host === "host-project"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Create project team" }),
    ).toHaveProperty("disabled", true);
    fireEvent.change(executable, { target: { value: "node" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Template check arguments" }),
      { target: { value: "--test\ntests/check.mjs" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create project team" }),
    );
    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(created.team.scope, "created-team"),
    );
    expect(harness.rpc.call).toHaveBeenCalledWith(
      "instantiateTeamTemplate",
      expect.objectContaining({
        projectId: "project-1",
        configuration: {
          ...configuration,
          check: {
            ...configuration.check,
            args: ["--test", "tests/check.mjs"],
          },
        },
      }),
    );
  });

  it("restores an uncertain creation after remount and retries the same operation without duplicating a team", async () => {
    let failed = false;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "getTeamTemplateSetup")
        return {
          configuration,
          defaultRoles: configuration.roles,
          defaultsSource: "project",
          hostId: "host-project",
          blockers: [],
        };
      if (!failed) {
        failed = true;
        throw new Error("Connection interrupted");
      }
      return { ...created, reused: true };
    });
    renderCatalog();
    fireEvent.click(screen.getByRole("button", { name: "Use this team" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Create project team" }),
    );
    await screen.findByRole("alert");
    const first = harness.rpc.call.mock.calls.find(
      ([method]) => method === "instantiateTeamTemplate",
    )?.[1];
    expect(onOpen).not.toHaveBeenCalled();
    cleanup();
    renderCatalog();
    fireEvent.click(screen.getByRole("button", { name: "Use this team" }));
    await screen.findByText(/Restored your unfinished setup/);
    fireEvent.click(
      screen.getByRole("button", { name: "Create project team" }),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    const calls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "instantiateTeamTemplate",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(first);
    expect(
      localStorage.getItem("arc.template.efficient-build.1.project-1"),
    ).toBeNull();
  });
});

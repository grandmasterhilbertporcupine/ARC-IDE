// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GraphRunForm } from "./graph-panel.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { defaultSessionOverrides } from "../policy/contract.js";
import { runtimeHash } from "./hash.js";
import type { ArcRunView } from "./contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toPluginPanel: vi.fn(), toThread: vi.fn() },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  useBbNavigate: () => harness.navigate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(cleanup);

function fixture() {
  const definition = directoryDefinitionFixture();
  const input = definition.request;
  const run: ArcRunView = {
    definition,
    summary: {
      runId: definition.runId,
      projectId: input.projectId,
      goal: input.goal,
      planHash: runtimeHash(definition),
      createdAt: 1,
      workflowRunId: null,
      submission: "reserved",
      submissionError: null,
    },
    workflow: null,
    verification: {
      kind: "directory",
      state: "pending",
      reason: null,
      snapshotId: null,
      manifestDigest: null,
      checkedAt: null,
      workspacePath: null,
    },
  };
  const started = vi.fn();
  const inspect = vi.fn(async (request: { operationId: string }) => ({
    state: "ready",
    operationId: request.operationId,
    sourceInspectionId: input.sourceInspectionId,
    hostId: input.hostId,
    path: input.path,
    source: definition.source,
  }));
  const start = vi.fn(async () => run);
  harness.rpc.call.mockImplementation(
    async (method: string, request: unknown) => {
      switch (method) {
        case "getTeamRevision":
          return { revision: definition.team };
        case "getAgentRevision":
          return { revision: definition.members.builder.definition };
        case "getProjectRunSetup":
          return {
            sources: [{ hostId: input.hostId, path: input.path }],
            selected: {
              kind: "directory",
              hostId: input.hostId,
              path: input.path,
            },
            threads: [],
          };
        case "listPolicySessions":
          return {
            threads: [{ id: input.originThreadId, title: "Main conversation" }],
            hasMore: false,
          };
        case "getOrchestrationPolicy":
          return {
            project: {
              projectId: input.projectId,
              version: 0,
              policy: definition.policy,
              createdAt: null,
            },
            session: {
              projectId: input.projectId,
              threadId: input.originThreadId,
              version: 0,
              overrides: defaultSessionOverrides(),
              createdAt: null,
            },
            effective: definition.policy,
            errors: [],
          };
        case "getDirectoryRunSetup": {
          if (
            !request ||
            typeof request !== "object" ||
            !("operationId" in request) ||
            typeof request.operationId !== "string"
          )
            throw new Error("Missing inspection identity");
          return inspect({ operationId: request.operationId });
        }
        case "requestDirectoryTeamRun":
          return start();
        default:
          throw new Error(`Unexpected UI operation ${method}`);
      }
    },
  );
  function mount() {
    return render(
      <GraphRunForm
        projectId={input.projectId}
        teamId={input.team.teamId}
        revision={input.team.revision}
        onStarted={started}
      />,
    );
  }
  async function enter() {
    await screen.findByRole("option", { name: "Main conversation" });
    fireEvent.change(screen.getByLabelText("Main conversation"), {
      target: { value: input.originThreadId },
    });
    fireEvent.change(screen.getByLabelText("What should the team deliver?"), {
      target: { value: "Build the requested app in this folder" },
    });
    await screen.findByRole("button", { name: "Inspect project folder" });
  }
  return { definition, input, run, inspect, start, started, mount, enter };
}

describe("plain folder run form", () => {
  it("offers a fresh inspection when a retained setup permanently conflicts", async () => {
    const f = fixture();
    f.inspect.mockRejectedValueOnce(
      new Error("The main environment changed. Refresh the folder inspection."),
    );
    f.mount();
    await f.enter();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect project folder" }),
    );
    await screen.findByText(
      "The main environment changed. Refresh the folder inspection.",
    );
    expect(
      screen.getByRole("button", { name: "Retry saved inspection" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Start new inspection" }),
    );
    await waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(2));
    expect(f.inspect.mock.calls[1][0].operationId).not.toBe(
      f.inspect.mock.calls[0][0].operationId,
    );
    expect(f.start).not.toHaveBeenCalled();
  });

  it("requires the real inspection result and submits its exact snapshot through the counted main-run method", async () => {
    const f = fixture();
    f.mount();
    await f.enter();
    expect(
      (
        screen.getByRole("button", {
          name: "Start published team run",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(f.inspect).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect project folder" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Start published team run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start published team run" }),
    );
    await waitFor(() => expect(f.started).toHaveBeenCalledWith(f.run));
    const call = harness.rpc.call.mock.calls.find(
      ([method]) => method === "requestDirectoryTeamRun",
    );
    expect(call?.[1]).toMatchObject({
      sourceInspectionId: f.input.sourceInspectionId,
      expectedSource: f.input.expectedSource,
      originThreadId: f.input.originThreadId,
      team: f.input.team,
    });
    expect(call?.[1]).not.toHaveProperty("expectedHead");
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "startTeamRun" || method === "getRunSetup",
      ),
    ).toBe(false);
  });

  it("keeps a saved directory run request identical across a lost response and remount", async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(
      new Error("Acknowledgement lost; retry the same request"),
    );
    const mounted = f.mount();
    await f.enter();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect project folder" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Start published team run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start published team run" }),
    );
    await screen.findByText("Acknowledgement lost; retry the same request");
    mounted.unmount();
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry saved team request" }),
    );
    await waitFor(() => expect(f.started).toHaveBeenCalledWith(f.run));
    const calls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "requestDirectoryTeamRun",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(
      new Set(f.inspect.mock.calls.map(([request]) => request.operationId))
        .size,
    ).toBe(1);
  });

  it("shows an inspection failure and does not enable a run with missing evidence", async () => {
    const f = fixture();
    f.inspect.mockRejectedValueOnce(
      new Error("Unsupported link at node_modules/package"),
    );
    f.mount();
    await f.enter();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect project folder" }),
    );
    await screen.findByText("Unsupported link at node_modules/package");
    expect(
      (
        screen.getByRole("button", {
          name: "Start published team run",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved inspection" }),
    );
    await waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(2));
    expect(f.inspect.mock.calls[1][0]).toEqual(f.inspect.mock.calls[0][0]);
  });
});

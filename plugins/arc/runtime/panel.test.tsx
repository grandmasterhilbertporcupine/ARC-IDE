// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RuntimePanel } from "./panel.js";
import { runDefinitionFixture } from "./testing.js";
import { compileArcRun } from "./compiler.js";
import type { ArcRunView } from "./contract.js";
import { directoryDefinitionFixture } from "./directory-testing.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  useBbNavigate: () => harness.navigate,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function runFixture() {
  const { definition, workflow } = compileArcRun(runDefinitionFixture());
  return {
    definition,
    summary: {
      runId: definition.runId,
      projectId: "project-a",
      goal: definition.request.goal,
      planHash: workflow.planHash,
      createdAt: 1,
      workflowRunId: "workflow-a",
      submission: "submitted",
      submissionError: null,
    },
    workflow: {
      workflowRunId: "workflow-a",
      ownerRunId: definition.runId,
      projectId: "project-a",
      originThreadId: "thread-parent",
      planHash: workflow.planHash,
      state: "running",
      desiredControl: "run",
      controlVersion: 2,
      dispatchGeneration: 1,
      limits: workflow.limits,
      agentCalls: 2,
      activeAgents: 2,
      chargedActiveMs: 1000,
      repairRounds: [],
      result: { available: false },
      error: null,
    },
    verification: {
      state: "pending",
      reason: null,
      head: null,
      workspacePath: null,
    },
  } satisfies ArcRunView;
}

describe("ARC run controls", () => {
  it("labels retained directory evidence with its timestamp instead of implying continuous verification", async () => {
    const definition = directoryDefinitionFixture();
    const base = runFixture();
    const run: ArcRunView = {
      ...base,
      definition,
      summary: { ...base.summary, runId: definition.runId },
      workflow: {
        ...base.workflow,
        ownerRunId: definition.runId,
        state: "succeeded",
      },
      verification: {
        kind: "directory",
        state: "current",
        reason: null,
        snapshotId: "snapshot-final",
        manifestDigest: "a".repeat(64),
        checkedAt: "2026-09-10T13:00:00.000Z",
        workspacePath: "C:/Retained folder",
      },
    };
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "getRun") return run;
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "listRunControls") return { controls: [], total: 0 };
      if (method === "getRunReviewAuthority")
        return { state: "authorized", diagnostics: [] };
      if (method === "getRunUpdateState")
        return { incoming: null, outgoing: null };
      throw new Error(`Unexpected ${method}`);
    });
    const { container } = render(<RuntimePanel subPath={definition.runId} />);
    await screen.findByText("Last verified candidate", { exact: false });
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-10T13:00:00.000Z",
    );
    expect(
      screen.getByText("New actions check the folder again.", { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "getDirectoryRunSetup",
      ),
    ).toBe(false);
  });

  it("retries a lost pause response with the exact operation and observed version", async () => {
    const run = runFixture();
    let controls = 0;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "getRun") return run;
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "controlRun") {
        controls += 1;
        if (controls === 1) throw new Error("Control response lost");
        return {
          ...run,
          workflow: {
            ...run.workflow,
            state: "paused",
            desiredControl: "pause",
            controlVersion: 3,
          },
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    render(<RuntimePanel subPath={run.summary.runId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const retry = await screen.findByRole("button", { name: "Retry pause" });
    expect(
      screen
        .getByRole("button", { name: "Cancel run" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Resume" });
    const requests = harness.rpc.call.mock.calls
      .filter(([method]) => method === "controlRun")
      .map(([, request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      runId: run.summary.runId,
      expectedVersion: 2,
      action: "pause",
    });
  });

  it("retains the exact start request after an uncertain response", async () => {
    const run = runFixture();
    if (run.definition.schemaVersion !== 1)
      throw new Error("Expected a legacy run");
    const selected = run.definition.writers[0].definition;
    let starts = 0;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listStudioProjects")
        return {
          projects: [{ id: "project-a", name: "Project A" }],
          personalProjectId: null,
        };
      if (method === "listRuns") return { runs: [], total: 0 };
      if (method === "getRunSetup")
        return {
          sources: [{ hostId: "host-a", path: run.definition.source.path }],
          selected: {
            hostId: "host-a",
            path: run.definition.source.path,
            head: run.definition.source.head,
            clean: true,
          },
          threads: [{ id: "thread-parent", title: "Build app" }],
        };
      if (method === "listAgents")
        return {
          agents: [
            {
              id: selected.agentId,
              name: selected.metadata.name,
              currentRevision: 1,
            },
          ],
          total: 1,
        };
      if (method === "startRun") {
        starts += 1;
        if (starts === 1) throw new Error("Run response lost");
        return run;
      }
      throw new Error(`Unexpected ${method}`);
    });
    render(<RuntimePanel subPath="legacy" />);
    await screen.findByRole("option", { name: "Project A" });
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "project-a" },
    });
    await screen.findByText("Clean checkout", { exact: false });
    await waitFor(() =>
      expect(
        screen.getAllByRole("option", { name: "Builder · v1" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.change(screen.getByLabelText("What should the team deliver?"), {
      target: { value: "Build the requested app" },
    });
    for (const select of screen.getAllByLabelText("Agent", { exact: true }))
      fireEvent.change(select, { target: { value: selected.agentId } });
    for (const textarea of screen.getAllByLabelText("Assignment"))
      fireEvent.change(textarea, {
        target: { value: "Implement the assigned portion" },
      });
    fireEvent.change(screen.getByLabelText("Final reviewer"), {
      target: { value: selected.agentId },
    });
    fireEvent.change(screen.getByLabelText("Agent for check repairs"), {
      target: { value: selected.agentId },
    });
    fireEvent.change(screen.getByLabelText("Executable"), {
      target: { value: "node" },
    });
    fireEvent.change(screen.getByLabelText("Arguments · one per line"), {
      target: { value: "check.mjs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start team run" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry saved request" }),
    );
    await waitFor(() =>
      expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith("runs", {
        subPath: run.summary.runId,
      }),
    );
    const requests = harness.rpc.call.mock.calls
      .filter(([method]) => method === "startRun")
      .map(([, request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("shows stale verification separately from historical run success", async () => {
    const run = runFixture();
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "getRun")
        return {
          ...run,
          workflow: { ...run.workflow, state: "succeeded" },
          verification: {
            state: "stale",
            reason: "The checked candidate changed",
            head: run.definition.source.head,
            workspacePath: "C:/Retained worktree",
          },
        };
      throw new Error(`Unexpected ${method}`);
    });
    render(<RuntimePanel subPath={run.summary.runId} />);
    await screen.findByText("Verification is stale", { exact: false });
    expect(screen.getByRole("alert").textContent).toBe(
      "The checked candidate changed",
    );
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});

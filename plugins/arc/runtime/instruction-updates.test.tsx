// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RuntimePanel } from "./panel.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import type { ArcRunView } from "./contract.js";
import type {
  InstructionUpdateApplication,
  InstructionUpdatePreview,
} from "./instruction-update-contract.js";

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
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture() {
  const definition = directoryDefinitionFixture();
  const hash = "a".repeat(64);
  const run: ArcRunView = {
    definition,
    summary: {
      runId: definition.runId,
      projectId: definition.request.projectId,
      goal: definition.request.goal,
      planHash: hash,
      createdAt: 1,
      workflowRunId: "workflow-a",
      submission: "submitted",
      submissionError: null,
    },
    workflow: {
      workflowRunId: "workflow-a",
      ownerRunId: definition.runId,
      projectId: definition.request.projectId,
      originThreadId: definition.request.originThreadId,
      planHash: hash,
      state: "running",
      desiredControl: "run",
      controlVersion: 1,
      dispatchGeneration: 1,
      limits: definition.policy.limits,
      agentCalls: 2,
      activeAgents: 1,
      chargedActiveMs: 1000,
      repairRounds: [],
      result: { available: false },
      error: null,
    },
    verification: {
      kind: "directory",
      state: "current",
      reason: null,
      snapshotId: "snapshot-a",
      manifestDigest: hash,
      checkedAt: "2026-09-10T13:00:00.000Z",
      workspacePath: "C:/Retained candidate",
    },
  };
  const preview: InstructionUpdatePreview = {
    previewId: "preview-a",
    previewHash: hash,
    runId: definition.runId,
    projectId: definition.request.projectId,
    planHash: hash,
    controlVersion: 1,
    oldTeam: { teamId: definition.team.teamId, revision: 1, name: "App team" },
    newTeam: { teamId: definition.team.teamId, revision: 2, name: "App team" },
    changes: [
      {
        memberId: "repair",
        agentId: "agent-repair",
        name: "Repair",
        oldRevision: 1,
        newRevision: 2,
        before: "Fix the calculation.",
        after: "Fix the calculation and export the reviewed marker.",
      },
    ],
    affectedNodes: [
      { nodeId: "repair", label: "Repair pricing", kind: "agent" },
      { nodeId: "review", label: "Review candidate", kind: "agent" },
    ],
    rerun: "entire-team-from-original",
    source: {
      kind: "directory",
      path: "C:/Original source",
      identityHash: hash,
    },
    createdAt: 1,
  };
  let outgoing: InstructionUpdateApplication | null = null;
  let incoming: InstructionUpdateApplication | null = null;
  let applyError: string | null = null;
  let cancelError: string | null = null;
  let nextState: InstructionUpdateApplication["state"] = "applied";
  let cancelState: InstructionUpdateApplication["state"] = "cancelled";
  let commitCancelBeforeError = false;
  let currentPreview = preview;
  function application(
    operationId: string,
    state: InstructionUpdateApplication["state"],
  ) {
    return {
      operationId,
      runId: definition.runId,
      successorRunId: "run-successor",
      preview,
      state,
      reason: null,
      createdAt: 2,
      updatedAt: 3,
    };
  }
  harness.rpc.call.mockImplementation(
    async (method: string, input: Record<string, string>) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "getRun") return run;
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "listRunControls") return { controls: [], total: 0 };
      if (method === "getRunReviewAuthority")
        return { state: "authorized", diagnostics: [] };
      if (method === "getRunUpdateState")
        return {
          incoming: incoming
            ? { kind: "instructions", application: incoming }
            : null,
          outgoing: outgoing
            ? { kind: "instructions", application: outgoing }
            : null,
        };
      if (method === "listTeamRevisions")
        return {
          revisions: [
            {
              ...definition.team,
              revision: 2,
              definition: { ...definition.team.definition, name: "App team" },
            },
          ],
          total: 2,
        };
      if (method === "previewRunInstructionUpdate") return currentPreview;
      if (method === "applyRunInstructionUpdate") {
        if (applyError) throw new Error(applyError);
        outgoing = application(input.operationId, nextState);
        return outgoing;
      }
      if (method === "pollRunInstructionUpdate") return outgoing;
      if (method === "cancelRunInstructionUpdate") {
        if (commitCancelBeforeError)
          outgoing = application(input.operationId, cancelState);
        if (cancelError) throw new Error(cancelError);
        outgoing = application(input.operationId, cancelState);
        return outgoing;
      }
      throw new Error(`Unexpected ${method}`);
    },
  );
  return {
    run,
    preview,
    application,
    setOutgoing(value: InstructionUpdateApplication | null) {
      outgoing = value;
    },
    setIncoming(value: InstructionUpdateApplication) {
      incoming = value;
    },
    failApply(message: string | null) {
      applyError = message;
    },
    failCancel(message: string | null) {
      cancelError = message;
    },
    nextState(value: InstructionUpdateApplication["state"]) {
      nextState = value;
    },
    cancelState(value: InstructionUpdateApplication["state"]) {
      cancelState = value;
    },
    commitCancelBeforeError() {
      commitCancelBeforeError = true;
    },
    previewResult(value: InstructionUpdatePreview) {
      currentPreview = value;
    },
  };
}

async function review(runId: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Update instructions" }),
  );
  const select = await screen.findByRole("combobox", {
    name: "Published team revision",
  });
  await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
  fireEvent.change(select, { target: { value: "2" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Review instruction changes" }),
  );
  await screen.findByText("Repair · agent v1 → v2");
  expect(
    harness.rpc.call.mock.calls.find(
      ([method]) => method === "previewRunInstructionUpdate",
    )?.[1],
  ).toMatchObject({ runId, team: { revision: 2 } });
}

describe("reviewed instruction updates", () => {
  it("releases a saved retry after read-only cancellation confirmation and applies a fresh review", async () => {
    const f = fixture();
    f.failApply("Apply response lost");
    f.failCancel("Cancellation committed but response lost");
    f.commitCancelBeforeError();
    const first = render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    fireEvent.click(
      screen.getByRole("button", { name: "Pause and apply instructions" }),
    );
    await screen.findByText("Apply response lost");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel instruction update" }),
    );
    await screen.findByText("Cancellation committed but response lost");
    first.unmount();
    if (!f.run.workflow) throw new Error("Expected fixture workflow");
    f.run.workflow.controlVersion = 2;
    f.run.workflow.state = "paused";
    f.run.workflow.desiredControl = "pause";
    f.previewResult({
      ...f.preview,
      previewId: "preview-b",
      previewHash: "b".repeat(64),
      controlVersion: 2,
    });
    f.failApply(null);
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await screen.findByText("The update was cancelled.", { exact: false });
    await waitFor(() =>
      expect(
        sessionStorage.getItem(
          `arc:instruction-update:v1:${f.run.summary.runId}`,
        ),
      ).toBeNull(),
    );
    const select = await screen.findByRole("combobox", {
      name: "Published team revision",
    });
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Review instruction changes" }),
    );
    const apply = await screen.findByRole("button", {
      name: "Pause and apply instructions",
    });
    await waitFor(() => expect(apply.hasAttribute("disabled")).toBe(false));
    fireEvent.click(apply);
    await screen.findByRole("button", { name: "Open continuation" });
    const requests = harness.rpc.call.mock.calls
      .filter(([method]) => method === "applyRunInstructionUpdate")
      .map(([, input]) => input);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      previewId: "preview-b",
      previewHash: "b".repeat(64),
    });
    expect(requests[1].operationId).not.toBe(requests[0].operationId);
  });
  it("explains a sealed admission when cancellation is too late and requires explicit continuation", async () => {
    const f = fixture();
    f.setOutgoing(f.application("operation-a", "starting"));
    f.cancelState("starting");
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update instructions" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel instruction update" }),
    );
    await screen.findByText("Successor admission was already sealed", {
      exact: false,
    });
    expect(
      screen
        .getByRole("button", { name: "Continue instruction update" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) =>
          method === "applyRunInstructionUpdate" ||
          method === "pollRunInstructionUpdate",
      ),
    ).toBe(false);
    expect(
      sessionStorage.getItem(
        `arc:instruction-update:v1:${f.run.summary.runId}`,
      ),
    ).toBeNull();
  });
  it("shows the exact changes and rerun consequence without applying a published revision", async () => {
    const f = fixture();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    expect(screen.getByText(f.preview.changes[0].before)).toBeTruthy();
    expect(screen.getByText(f.preview.changes[0].after)).toBeTruthy();
    expect(
      screen.getByText("The entire team starts again", { exact: false }),
    ).toBeTruthy();
    expect(
      screen.getByText("Affected steps: Repair pricing, Review candidate"),
    ).toBeTruthy();
    expect(
      harness.rpc.call.mock.calls.some(([method]) =>
        [
          "applyRunInstructionUpdate",
          "controlRun",
          "pollRunInstructionUpdate",
        ].includes(method),
      ),
    ).toBe(false);
  });

  it("retains the exact reviewed operation across a lost apply response and reload", async () => {
    const f = fixture();
    f.failApply("Apply response lost");
    const first = render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    fireEvent.click(
      screen.getByRole("button", { name: "Pause and apply instructions" }),
    );
    await screen.findByText("Apply response lost");
    const initial = harness.rpc.call.mock.calls.find(
      ([method]) => method === "applyRunInstructionUpdate",
    )?.[1];
    expect(
      screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled"),
    ).toBe(true);
    first.unmount();
    f.failApply(null);
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue instruction update",
      }),
    );
    await screen.findByRole("button", { name: "Open continuation" });
    const requests = harness.rpc.call.mock.calls
      .filter(([method]) => method === "applyRunInstructionUpdate")
      .map(([, request]) => request);
    expect(requests).toEqual([initial, initial]);
    expect(
      screen.getByText(
        "Historical candidate · replaced by instruction update",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(
      sessionStorage.getItem(
        `arc:instruction-update:v1:${f.run.summary.runId}`,
      ),
    ).toBeNull();
  });

  it("retries cancellation after reload without replaying apply", async () => {
    const f = fixture();
    f.failApply("Apply response lost");
    f.failCancel("Cancel response lost");
    const first = render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    fireEvent.click(
      screen.getByRole("button", { name: "Pause and apply instructions" }),
    );
    await screen.findByText("Apply response lost");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel instruction update" }),
    );
    await screen.findByText("Cancel response lost");
    first.unmount();
    f.failCancel(null);
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry cancellation" }),
    );
    await screen.findByText("The update was cancelled.", { exact: false });
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "applyRunInstructionUpdate",
      ),
    ).toHaveLength(1);
    const cancellations = harness.rpc.call.mock.calls
      .filter(([method]) => method === "cancelRunInstructionUpdate")
      .map(([, request]) => request);
    expect(cancellations[1]).toEqual(cancellations[0]);
  });

  it("does not continue a saved application merely by opening the run", async () => {
    const f = fixture();
    f.setOutgoing(f.application("operation-a", "checking"));
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update instructions" }),
    );
    await screen.findByRole("button", { name: "Continue instruction update" });
    expect(
      screen
        .getByRole("button", { name: "Cancel run" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      harness.rpc.call.mock.calls.some(([method]) =>
        ["pollRunInstructionUpdate", "applyRunInstructionUpdate"].includes(
          method,
        ),
      ),
    ).toBe(false);
  });

  it("stops advancing a pending operation after unmount", async () => {
    const f = fixture();
    f.nextState("checking");
    const mounted = render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: "Pause and apply instructions" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    mounted.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "pollRunInstructionUpdate",
      ),
    ).toBe(false);
    expect(
      sessionStorage.getItem(
        `arc:instruction-update:v1:${f.run.summary.runId}`,
      ),
    ).not.toBeNull();
  });

  it("requires a new review when control version changes", async () => {
    const f = fixture();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review(f.run.summary.runId);
    if (!f.run.workflow) throw new Error("Expected workflow fixture");
    f.run.workflow.controlVersion = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Run controls changed.", { exact: false });
    expect(
      screen
        .getByRole("button", { name: "Pause and apply instructions" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("links the predecessor and explains inherited budget on the successor", async () => {
    const f = fixture();
    f.setIncoming(f.application("operation-a", "applied"));
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Previous run" }),
    );
    expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith("runs", {
      subPath: f.run.summary.runId,
    });
    expect(
      screen.getByText("Calls, active time and repair usage carry forward.", {
        exact: false,
      }),
    ).toBeTruthy();
  });
});

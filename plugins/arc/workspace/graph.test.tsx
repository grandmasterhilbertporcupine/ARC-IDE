// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TeamCanvas } from "../teams/canvas.js";
import { WorkspaceGraph } from "./graph.js";
import type { ArcWorkspaceView, ArcWorkspaceWorker } from "./contract.js";
import { graphRunDefinitionFixture } from "../runtime/graph-testing.js";
import { orchestratedDefinitionFixture } from "../runtime/orchestrated-testing.js";
import { directoryDefinitionFixture } from "../runtime/directory-testing.js";
import { runDefinitionFixture } from "../runtime/testing.js";
import { runtimeHash } from "../runtime/hash.js";

const harness = vi.hoisted(() => ({ canvas: vi.fn(), width: 1100 }));
vi.mock("../teams/canvas.js", () => ({
  TeamCanvas: (props: ComponentProps<typeof TeamCanvas>) => {
    harness.canvas(props);
    return <div data-testid="saved-canvas" />;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  harness.width = 1100;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        private callback: (
          entries: { contentRect: { width: number } }[],
        ) => void,
      ) {}
      observe() {
        this.callback([{ contentRect: { width: harness.width } }]);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    clearTimeout(handle),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function run(
  definition: ArcWorkspaceView["run"]["definition"] = graphRunDefinitionFixture(),
): ArcWorkspaceView["run"] {
  return {
    definition,
    summary: {
      runId: definition.runId,
      projectId: definition.request.projectId,
      goal: definition.request.goal,
      planHash: runtimeHash(definition),
      createdAt: definition.createdAt,
      workflowRunId: "workflow",
      submission: "submitted",
      submissionError: null,
    },
    workflow: null,
    verification: {
      state: "pending",
      reason: null,
      head: null,
      workspacePath: null,
    },
  };
}
function props(value = run()): ComponentProps<typeof WorkspaceGraph> {
  return {
    run: value,
    visible: true,
    workers: [],
    workersTruncated: false,
    onWorker: vi.fn(),
    onRunDetails: vi.fn(),
  };
}
function worker(
  overrides: Partial<ArcWorkspaceWorker> = {},
): ArcWorkspaceWorker {
  return {
    effectId: "effect-one",
    nodeId: "opaque-runtime-reference",
    graphNodeId: "write",
    iteration: 0,
    attempt: 1,
    createdAt: 1,
    state: "native-accepted",
    threadId: "thread-one",
    executionContextId: "context",
    environmentId: "environment",
    turnRequestId: "turn-one",
    name: "Assigned builder",
    role: "Builder",
    purpose: "writer",
    execution: { providerId: "codex", model: "saved-model" },
    task: "Build",
    agentId: "agent-one",
    revision: 1,
    group: null,
    dispatchKey: null,
    reason: null,
    ...overrides,
  };
}
function select(value: string) {
  const picker = screen.getByRole("combobox", {
    name: "Inspect saved stage or connection",
  });
  picker.focus();
  fireEvent.change(picker, { target: { value } });
  return picker;
}

describe("saved Workspace graph", () => {
  it("keeps legacy runs explicit without inventing a Team graph", () => {
    const p = props(run(runDefinitionFixture()));
    render(<WorkspaceGraph {...p} />);
    expect(
      screen.getByText(/earlier run has no saved Team graph/),
    ).toBeTruthy();
    expect(harness.canvas).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Run details" }));
    expect(p.onRunDetails).toHaveBeenCalledOnce();
  });

  it.each([
    graphRunDefinitionFixture,
    orchestratedDefinitionFixture,
    directoryDefinitionFixture,
  ])(
    "uses pinned Team and member snapshots for each supported definition",
    (definition) => {
      const p = props(run(definition()));
      render(<WorkspaceGraph {...p} />);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search saved plan" }),
        { target: { value: "builder" } },
      );
      select("node:write");
      const details = screen.getByRole("region", {
        name: "Saved plan details",
      });
      expect(within(details).getByText("Saved member · builder")).toBeTruthy();
      expect(within(details).getByText(/agent v1/)).toBeTruthy();
      expect(within(details).getByText(/codex · test-model/)).toBeTruthy();
      expect(
        within(details).getByText("Build the requested app."),
      ).toBeTruthy();
      const last = harness.canvas.mock.calls.at(-1)![0];
      expect(last.mode).toBe("inspect");
      expect(last.onChange).toBeUndefined();
      expect(last.definition).toEqual(
        p.run.definition.schemaVersion === 1
          ? null
          : p.run.definition.team.definition,
      );
    },
  );

  it("lists all exact projected attempts and never guesses from runtime node IDs", () => {
    const first = worker(),
      second = worker({
        effectId: "effect-two",
        threadId: "thread-two",
        purpose: "repair",
        iteration: 1,
        attempt: 2,
        state: "interrupted",
      });
    const p = props();
    p.workers = [
      first,
      second,
      worker({
        effectId: "unmapped",
        nodeId: "write",
        graphNodeId: null,
        name: "Do not infer this worker",
      }),
    ];
    render(<WorkspaceGraph {...p} />);
    select("node:write");
    const attempts = screen.getByRole("region", {
      name: "Worker attempts for selected stage",
    });
    expect(
      within(attempts).getByText("Working · iteration 0 · attempt 1"),
    ).toBeTruthy();
    expect(
      within(attempts).getByText("Interrupted · iteration 1 · attempt 2"),
    ).toBeTruthy();
    expect(within(attempts).queryByText(/Do not infer/)).toBeNull();
    fireEvent.click(
      within(attempts).getByRole("button", {
        name: "Open Assigned builder · attempt 2",
      }),
    );
    expect(p.onWorker).toHaveBeenCalledExactlyOnceWith(second);
  });

  it.each(["revision", "agentId"] as const)(
    "rejects a mismatched saved member %s in labels, search and details",
    (field) => {
      const definition = graphRunDefinitionFixture();
      if (field === "revision")
        definition.members.builder.definition.revision += 1;
      else definition.members.builder.definition.agentId = "agent-other";
      definition.members.builder.definition.metadata.name =
        "Wrong snapshot name";
      definition.members.builder.execution.model = "wrong-snapshot-model";
      render(<WorkspaceGraph {...props(run(definition))} />);
      const names = harness.canvas.mock.calls.at(-1)![0].members;
      expect(names.get("builder").name).toBe(
        "builder · saved agent unavailable",
      );
      expect(names.get("builder").model).toBe("Saved model unavailable");
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search saved plan" }),
        { target: { value: "Wrong snapshot name" } },
      );
      expect(screen.getByText("0 matching items")).toBeTruthy();
      fireEvent.change(
        screen.getByRole("textbox", { name: "Search saved plan" }),
        { target: { value: "builder" } },
      );
      select("node:write");
      expect(
        screen.getByText(
          /Saved agent snapshot is unavailable or does not match/,
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Wrong snapshot name")).toBeNull();
      expect(screen.queryByText("wrong-snapshot-model")).toBeNull();
    },
  );

  it("discloses incomplete attempt coverage without inventing a stage outcome", () => {
    const p = props();
    p.workersTruncated = true;
    render(<WorkspaceGraph {...p} />);
    select("node:check");
    expect(screen.getByText(/Only part of the worker history/)).toBeTruthy();
    expect(
      screen.getByText(/does not establish whether the stage ran/),
    ).toBeTruthy();
    expect(screen.queryByText("Not started")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Run details" }));
    expect(p.onRunDetails).toHaveBeenCalledOnce();
  });

  it("shows exact declared connection outcomes and grouping semantics", () => {
    const p = props();
    if (p.run.definition.schemaVersion === 1)
      throw new Error("Expected graph fixture");
    const edge = p.run.definition.team.definition.graph.edges.find(
      (value) => value.source === "write" && value.target === "check",
    );
    if (!edge) throw new Error("Expected writer-to-check fixture connection");
    render(<WorkspaceGraph {...p} />);
    select(`edge:${edge.id}`);
    const details = screen.getByRole("region", { name: "Saved plan details" });
    expect(within(details).getByText("Success")).toBeTruthy();
    expect(within(details).getByText("Next")).toBeTruthy();
    expect(within(details).getByText("Build (write)")).toBeTruthy();
    select("group:blue");
    expect(screen.getByText(/Color does not grant permission/)).toBeTruthy();
  });

  it("reaches a stage in a 200-stage plan without rebuilding the saved graph on poll or search", () => {
    const definition = graphRunDefinitionFixture((team) => {
      team.graph.nodes = Array.from({ length: 200 }, (_, index) => ({
        id: `stage-${index}`,
        kind: "check",
        label: `Check ${index}`,
        candidate: { kind: "source" },
        command: { executable: "node", args: [String(index)], timeoutMs: 1000 },
      }));
      team.graph.edges = Array.from({ length: 199 }, (_, index) => ({
        id: `edge-${index}`,
        source: `stage-${index}`,
        target: `stage-${index + 1}`,
        sourceHandle: "next",
        requiredOutcome: "succeeded",
      }));
      team.graph.entryNodeIds = ["stage-0"];
      team.graph.requiredGates = [
        { id: "all-checks", mode: "all", nodeIds: ["stage-199"] },
      ];
      team.presentation.nodes = [];
    });
    const p = props(run(definition)),
      original = runtimeHash(definition);
    const { rerender } = render(<WorkspaceGraph {...p} />);
    const canvasCalls = harness.canvas.mock.calls.length;
    const saved = harness.canvas.mock.calls.at(-1)![0].definition;
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search saved plan" }),
      { target: { value: "stage-199" } },
    );
    expect(
      screen.getByRole("option", { name: "Check 199 (stage-199)" }),
    ).toBeTruthy();
    expect(harness.canvas.mock.calls).toHaveLength(canvasCalls);
    select("node:stage-199");
    expect(screen.getByText(/node\s+\["199"\]/)).toBeTruthy();
    const afterSelection = harness.canvas.mock.calls.length;
    rerender(
      <WorkspaceGraph
        {...p}
        run={structuredClone(p.run)}
        workers={[worker()]}
      />,
    );
    expect(harness.canvas.mock.calls).toHaveLength(afterSelection);
    expect(harness.canvas.mock.calls.at(-1)![0].definition).toBe(saved);
    expect(runtimeHash(definition)).toBe(original);
  });

  it("closes desktop details with Escape and returns focus to its selection control", () => {
    render(<WorkspaceGraph {...props()} />);
    const picker = select("node:write");
    const close = screen.getByRole("button", { name: "Close details" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Saved plan details" }),
    ).toBeNull();
    expect(document.activeElement).toBe(picker);
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });

  it("closes a compact persistent drawer when Graph hides and keeps it closed on reopen", async () => {
    harness.width = 600;
    const p = props();
    const { rerender, container } = render(<WorkspaceGraph {...p} />);
    select("node:write");
    await screen.findByRole("button", { name: "Close details" });
    expect(container.hasAttribute("inert")).toBe(false);
    expect(container.getAttribute("aria-hidden")).toBeNull();
    rerender(<WorkspaceGraph {...p} visible={false} />);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Close details" }),
      ).toBeNull(),
    );
    rerender(<WorkspaceGraph {...p} visible />);
    expect(screen.queryByRole("button", { name: "Close details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "node:write",
    );
    const picker = screen.getByRole("combobox");
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const close = await screen.findByRole("button", { name: "Close details" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Close details" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(picker));
  });
});

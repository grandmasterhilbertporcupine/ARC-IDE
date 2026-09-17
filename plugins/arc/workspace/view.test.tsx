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
import { TeamWorkspace, WorkspacePanel } from "./view.js";
import type { ArcWorkspaceView, ArcWorkspaceWorker } from "./contract.js";
import { compileArcRun } from "../runtime/compiler.js";
import { runDefinitionFixture } from "../runtime/testing.js";
import { orchestratedDefinitionFixture } from "../runtime/orchestrated-testing.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() },
  animate: vi.fn(),
  reduced: false,
  width: 1600,
  graph: vi.fn(),
}));
vi.mock("./graph.js", () => ({
  WorkspaceGraph: (props: {
    run: ArcWorkspaceView["run"];
    workers: ArcWorkspaceWorker[];
    onWorker(worker: ArcWorkspaceWorker): void;
  }) => {
    harness.graph(props);
    return (
      <div data-testid="workspace-graph">
        <span>{props.run.summary.planHash}</span>
        <button onClick={() => props.onWorker(props.workers[0])}>
          Inspect first worker
        </button>
      </div>
    );
  },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  useBbNavigate: () => harness.navigate,
  experimental_useProviders: () => ({ status: "ready", providers: [] }),
  ThreadChat: ({
    threadId,
    variant,
  }: {
    threadId: string;
    variant: string;
  }) => (
    <div
      data-testid="thread-chat"
      data-thread={threadId}
      data-variant={variant}
    >
      {variant !== "timeline" && <textarea aria-label="Main composer" />}
    </div>
  ),
}));

const originalAnimate = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "animate",
);
beforeEach(() => {
  vi.clearAllMocks();
  harness.reduced = false;
  harness.width = 1600;
  harness.animate.mockReturnValue({ cancel: vi.fn(), onfinish: null });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: harness.animate,
  });
  vi.stubGlobal("matchMedia", () => ({ matches: harness.reduced }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-workspace-effect"))
        return new DOMRect(600, 120, 360, 480);
      if (
        this.id === "core-main" ||
        this.getAttribute("aria-label") === "Main orchestrator conversation"
      )
        return new DOMRect(40, 120, 480, 480);
      return new DOMRect(20, 80, 1000, 650);
    },
  );
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate)
    Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

function fixture(count = 2): ArcWorkspaceView {
  const { definition, workflow } = compileArcRun(runDefinitionFixture());
  const workers: ArcWorkspaceWorker[] = Array.from(
    { length: count },
    (_, index) => ({
      effectId: `effect-${index}`,
      nodeId: `writer-${index}`,
      graphNodeId: null,
      iteration: 0,
      attempt: 1,
      createdAt: index,
      state: "native-accepted",
      threadId: `worker-thread-${index}`,
      executionContextId: `execution-${index}`,
      environmentId: `environment-${index}`,
      turnRequestId: `request-${index}`,
      name: `Builder ${index + 1}`,
      role: "Build",
      purpose: "writer",
      execution: { providerId: "codex", model: "pinned-model" },
      task: `Assignment ${index + 1}`,
      agentId: definition.writers[0].definition.agentId,
      revision: 1,
      group: null,
      dispatchKey: `effect-${index}:native-accepted:request-${index}`,
      reason: null,
    }),
  );
  return {
    run: {
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
        controlVersion: 1,
        dispatchGeneration: 1,
        limits: workflow.limits,
        agentCalls: count,
        activeAgents: count,
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
    },
    origin: {
      threadId: "thread-parent",
      title: "Build app",
      providerId: "codex",
      model: null,
    },
    workers,
    workersTotal: count,
    workersTruncated: false,
    effects: [],
    effectsTotal: 0,
    events: [],
    cursor: {
      runId: definition.runId,
      planHash: workflow.planHash,
      seenKeys: [],
    },
    hasMoreEvents: false,
  };
}

describe("ARC live Workspace", () => {
  it("animates a newly accepted worker from the host main anchor across companion clipping and cleans up on switch", async () => {
    const view = fixture(1);
    harness.rpc.call.mockResolvedValue(view);
    const mounted = render(
      <div>
        <section id="core-main">
          <textarea aria-label="Core draft" defaultValue="Keep this draft" />
        </section>
        <TeamWorkspace
          runId={view.run.summary.runId}
          threadId={view.origin.threadId}
          projectId={view.run.summary.projectId}
          mainElementId="core-main"
        />
      </div>,
    );
    await screen.findByTestId("thread-chat");
    const draft = screen.getByRole("textbox", { name: "Core draft" });
    expect(harness.animate).not.toHaveBeenCalled();
    harness.rpc.call.mockResolvedValue({
      ...view,
      events: [
        {
          key: "actual-handoff",
          effectId: view.workers[0].effectId,
          milestone: "native-accepted",
          threadId: view.workers[0].threadId,
          turnRequestId: view.workers[0].turnRequestId,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.animate).toHaveBeenCalledTimes(1));
    const overlay = document.querySelector<HTMLElement>(
      '[data-workspace-handoff="actual-handoff"]',
    );
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay?.style).toMatchObject({
      position: "fixed",
      left: "40px",
      width: "920px",
      overflow: "hidden",
      pointerEvents: "none",
    });
    expect(screen.getByRole("textbox", { name: "Core draft" })).toBe(draft);
    expect(screen.queryByRole("textbox", { name: "Main composer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.rpc.call).toHaveBeenCalledTimes(3));
    expect(harness.animate).toHaveBeenCalledTimes(1);
    mounted.unmount();
    expect(document.querySelector("[data-workspace-handoff]")).toBeNull();
  });
  it("shows real worker timelines in the narrow Team companion without a second main composer", async () => {
    harness.width = 420;
    const view = fixture(2);
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : structuredClone(view),
    );
    render(
      <TeamWorkspace
        runId={view.run.summary.runId}
        threadId={view.origin.threadId}
        projectId={view.run.summary.projectId}
        mainElementId="core-main"
      />,
    );
    await screen.findByTestId("thread-chat");
    expect(screen.queryByRole("textbox", { name: "Main composer" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Main conversation" }),
    ).toBeNull();
    expect(
      screen
        .getAllByTestId("thread-chat")
        .every((element) => element.dataset.variant === "timeline"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Run details" })).toBeTruthy();
  });

  it("does not render a companion run from another parent conversation", async () => {
    const view = fixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : structuredClone(view),
    );
    render(
      <TeamWorkspace
        runId={view.run.summary.runId}
        threadId="different-parent"
        projectId={view.run.summary.projectId}
        mainElementId="core-main"
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "different conversation",
    );
    expect(screen.queryByTestId("thread-chat")).toBeNull();
  });
  it("inspects the pinned graph without remounting the main composer or four worker transcripts", async () => {
    const view = fixture(4);
    view.run.definition = orchestratedDefinitionFixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : method === "getRunReviewAuthority"
          ? { state: "authorized", diagnostics: [] }
          : structuredClone(view),
    );
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    const composer = await screen.findByRole("textbox", {
      name: "Main composer",
    });
    const transcripts = screen.getAllByTestId("thread-chat");
    fireEvent.change(composer, { target: { value: "Keep this unsent draft" } });
    expect(screen.queryByTestId("workspace-graph")).toBeNull();
    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Graph" }));
      expect(
        screen.getByRole("region", { name: "Workspace graph pane" }),
      ).toBeTruthy();
      screen
        .getAllByTestId("thread-chat")
        .forEach((element, position) =>
          expect(element).toBe(transcripts[position]),
        );
      fireEvent.click(screen.getByRole("button", { name: "Hide graph" }));
      screen
        .getAllByTestId("thread-chat")
        .forEach((element, position) =>
          expect(element).toBe(transcripts[position]),
        );
    }
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        harness.rpc.call.mock.calls.filter(
          ([method]) => method === "getWorkspace",
        ),
      ).toHaveLength(2),
    );
    expect(screen.getByRole("textbox", { name: "Main composer" })).toBe(
      composer,
    );
    expect(screen.getByDisplayValue("Keep this unsent draft")).toBe(composer);
    screen
      .getAllByTestId("thread-chat")
      .forEach((element, position) =>
        expect(element).toBe(transcripts[position]),
      );
    expect(harness.graph.mock.lastCall?.[0].run.definition).toEqual(
      view.run.definition,
    );
    expect(harness.animate).not.toHaveBeenCalled();
  });

  it("opens an exact graph worker attempt outside the four-pane window without adding a composer", async () => {
    const view = fixture(6);
    view.run.definition = orchestratedDefinitionFixture();
    const first = view.workers[0];
    view.workers.push({
      ...first,
      effectId: "first-retry",
      attempt: 2,
      threadId: "first-retry-thread",
      createdAt: 10,
    });
    view.workersTotal = view.workers.length;
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : method === "getRunReviewAuthority"
          ? { state: "authorized", diagnostics: [] }
          : view,
    );
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect first worker" }),
    );
    const pane = screen.getByRole("region", {
      name: "Builder 1 Builder conversation",
    });
    expect(within(pane).getByTestId("thread-chat").dataset.thread).toBe(
      first.threadId,
    );
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(5);
    expect(
      screen.getAllByRole("textbox", { name: "Main composer" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Workspace graph pane" }),
    ).toBeTruthy();
  });

  it("keeps laptop graph navigation paired with the selected chat and restores the compact main view", async () => {
    harness.width = 1000;
    const view = fixture(4);
    view.run.definition = orchestratedDefinitionFixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : method === "getRunReviewAuthority"
          ? { state: "authorized", diagnostics: [] }
          : view,
    );
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    const composer = await screen.findByRole("textbox", {
      name: "Main composer",
    });
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect first worker" }),
    );
    expect(screen.getByRole("textbox", { name: "Main composer" })).toBe(
      composer,
    );
    fireEvent.click(screen.getByRole("button", { name: "Worker overview" }));
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(5);
    expect(screen.getByRole("textbox", { name: "Main composer" })).toBe(
      composer,
    );
    fireEvent.click(screen.getByRole("button", { name: "Worker overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide graph" }));
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(2);
  });

  it("retains a compact composer draft while the graph has focus and returns focus when hidden", async () => {
    harness.width = 650;
    const view = fixture(4);
    view.run.definition = orchestratedDefinitionFixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : method === "getRunReviewAuthority"
          ? { state: "authorized", diagnostics: [] }
          : view,
    );
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    const composer = await screen.findByRole("textbox", {
      name: "Main composer",
    });
    fireEvent.change(composer, { target: { value: "Compact draft" } });
    const toggle = screen.getByRole("button", { name: "Graph" });
    fireEvent.click(toggle);
    expect(screen.queryByRole("textbox", { name: "Main composer" })).toBeNull();
    expect(screen.getByDisplayValue("Compact draft")).toBe(composer);
    expect(
      screen.getByRole("region", { name: "Workspace graph pane" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide graph" }));
    expect(screen.getByRole("textbox", { name: "Main composer" })).toBe(
      composer,
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("counts the admitted main response while keeping the actual main conversation composer", async () => {
    const view = fixture();
    const definition = orchestratedDefinitionFixture();
    view.run.definition = definition;
    view.origin.threadId = definition.completion.threadId;
    if (view.run.workflow === null)
      throw new Error("Fixture workflow is missing");
    view.run.workflow.agentCalls = 3;
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "getRunUpdateState"
        ? { incoming: null, outgoing: null }
        : method === "getRunReviewAuthority"
          ? { state: "authorized", diagnostics: [] }
          : view,
    );
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    expect(screen.getByText(/3 \/ 100 agent calls/)).toBeTruthy();
    const main = screen.getByRole("region", {
      name: "Main orchestrator conversation",
    });
    expect(within(main).getByTestId("thread-chat").dataset.thread).toBe(
      definition.completion.threadId,
    );
    expect(
      screen.getAllByRole("textbox", { name: "Main composer" }),
    ).toHaveLength(1);
  });
  it("renders one main composer and four real transcript identities without replaying old handoffs", async () => {
    const view = fixture(4);
    harness.rpc.call.mockResolvedValue(view);
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(5);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(
      screen
        .getAllByTestId("thread-chat")
        .filter((element) => element.dataset.variant === "timeline"),
    ).toHaveLength(4);
    expect(harness.animate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.rpc.call).toHaveBeenCalledTimes(2));
    expect(harness.animate).not.toHaveBeenCalled();
    expect(harness.rpc.call.mock.calls[1][1].cursor).toEqual(view.cursor);
  });

  it("animates native acceptance once and retains actual messages when refreshing fails", async () => {
    const view = fixture();
    harness.rpc.call.mockResolvedValueOnce(view);
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    const accepted = {
      ...view,
      events: [
        {
          key: "accepted-new",
          effectId: "effect-0",
          milestone: "native-accepted" as const,
          threadId: "worker-thread-0",
          turnRequestId: "request-0",
        },
      ],
    };
    harness.rpc.call.mockResolvedValue(accepted);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.animate).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("Builder 1 accepted its builder assignment."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.rpc.call).toHaveBeenCalledTimes(3));
    expect(harness.animate).toHaveBeenCalledTimes(1);
    harness.rpc.call.mockRejectedValueOnce(new Error("Connection unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Showing the last observed state",
    );
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(3);
    harness.rpc.call.mockResolvedValue(view);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(harness.rpc.call.mock.calls.at(-1)?.[1].cursor).toBeNull();
    expect(harness.animate).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier conversations accessible when more than four logical workers exist", async () => {
    const view = fixture(6);
    harness.rpc.call.mockResolvedValue(view);
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    expect(
      screen.queryByRole("region", { name: "Builder 1 Builder conversation" }),
    ).toBeNull();
    const navigation = screen.getByRole("navigation", {
      name: "Workspace conversations",
    });
    expect(
      within(navigation)
        .getByRole("button", { name: "Overview" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      within(navigation).getByRole("button", { name: "Builder 1 · Builder" }),
    );
    expect(
      screen.getByRole("region", { name: "Builder 1 Builder conversation" }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(1);
    expect(screen.getByTestId("thread-chat").dataset.thread).toBe(
      "worker-thread-0",
    );
    expect(
      within(navigation)
        .getByRole("button", { name: "Builder 1 · Builder" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(navigation)
        .getByRole("button", { name: "Overview" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(
      within(navigation).getByRole("button", { name: "Overview" }),
    );
    expect(screen.getAllByTestId("thread-chat")).toHaveLength(5);
  });

  it("offers the interrupted attempt without adding a worker composer and respects reduced motion", async () => {
    harness.reduced = true;
    const view = fixture();
    view.workers.push({
      ...view.workers[0],
      effectId: "older-effect",
      attempt: 1,
      state: "interrupted",
      threadId: "interrupted-thread",
    });
    view.workers[0] = { ...view.workers[0], attempt: 2 };
    harness.rpc.call.mockResolvedValue(view);
    render(<WorkspacePanel subPath={view.run.summary.runId} />);
    await screen.findByRole("textbox", { name: "Main composer" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Builder 1 Builder attempt" }),
      { target: { value: "older-effect" } },
    );
    const pane = screen.getByRole("region", {
      name: "Builder 1 Builder conversation",
    });
    expect(within(pane).getByTestId("thread-chat").dataset.thread).toBe(
      "interrupted-thread",
    );
    expect(within(pane).queryByRole("textbox")).toBeNull();
    harness.rpc.call.mockResolvedValue({
      ...view,
      events: [
        {
          key: "reduced-event",
          effectId: "effect-1",
          milestone: "native-accepted",
          threadId: "worker-thread-1",
          turnRequestId: "request-1",
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Builder 2 accepted its builder assignment.");
    expect(harness.animate).not.toHaveBeenCalled();
  });
});

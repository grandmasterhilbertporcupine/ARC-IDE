// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ArcThreadTeam } from "./view.js";
import { ArcThreadAnnotations, threadAnnotations } from "./annotations.js";
import type { ArcThreadBindings, ArcThreadRun } from "./contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toPluginPanel: vi.fn() },
  viewStateChange: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useBbNavigate: () => harness.navigate,
  useRealtime: (_name: string, callback: () => void) => {
    harness.listeners.add(callback);
  },
}));
vi.mock("../workspace/view.js", () => ({
  TeamWorkspace: ({ runId, threadId }: { runId: string; threadId: string }) => (
    <div data-testid="team-workspace" data-run={runId} data-thread={threadId} />
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
const viewProps = {
  mainElementId: "core-main",
  viewState: null,
  onViewStateChange: harness.viewStateChange,
};
const run = (id: string, createdAt: number): ArcThreadRun => ({
  runId: id,
  originThreadId: "parent",
  goal: id,
  planHash: "a".repeat(64),
  createdAt,
  state: "running",
  submission: "submitted",
  team: { teamId: "team", revision: 2, name: "Builders" },
  workerThreadsTotal: 4,
  predecessorRunId: null,
  successor: null,
});
const binding = (
  runs: ArcThreadRun[],
  defaultRun = runs[0] ?? null,
): ArcThreadBindings => ({
  origins: [
    {
      threadId: "parent",
      runs,
      runsTotal: runs.length,
      defaultRun,
      activeLookup: "available",
      nextOffset: null,
    },
  ],
  workers: [],
});

describe("ARC thread Team view", () => {
  it("prefers an exact URL run over saved selection and follows host history changes", async () => {
    const first = run("run_00000000-0000-0000-0000-000000000001", 1);
    const second = run("run_00000000-0000-0000-0000-000000000002", 2);
    sessionStorage.setItem("arc:thread-team:v1:project:parent", second.runId);
    harness.rpc.call.mockResolvedValue(binding([second, first], second));
    const mounted = render(
      <ArcThreadTeam
        {...viewProps}
        threadId="parent"
        projectId="project"
        viewState={first.runId}
      />,
    );
    expect((await screen.findByTestId("team-workspace")).dataset.run).toBe(
      first.runId,
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: second.runId },
    });
    expect(harness.viewStateChange).toHaveBeenCalledWith(second.runId);
    mounted.rerender(
      <ArcThreadTeam
        {...viewProps}
        threadId="parent"
        projectId="project"
        viewState={second.runId}
      />,
    );
    expect(screen.getByTestId("team-workspace").dataset.run).toBe(second.runId);
    mounted.rerender(
      <ArcThreadTeam
        {...viewProps}
        threadId="parent"
        projectId="project"
        viewState={first.runId}
      />,
    );
    expect(screen.getByTestId("team-workspace").dataset.run).toBe(first.runId);
    mounted.unmount();
    render(
      <ArcThreadTeam
        {...viewProps}
        threadId="parent"
        projectId="project"
        viewState={first.runId}
      />,
    );
    expect((await screen.findByTestId("team-workspace")).dataset.run).toBe(
      first.runId,
    );
  });

  it("identifies malformed run URL state without passing it to Workspace", async () => {
    harness.rpc.call.mockResolvedValue(binding([]));
    render(
      <ArcThreadTeam
        {...viewProps}
        threadId="parent"
        projectId="project"
        viewState="../../foreign"
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "run link is invalid",
    );
    expect(screen.queryByTestId("team-workspace")).toBeNull();
  });
  it("uses the exact default and retains the user's chosen historical run through refresh and remount", async () => {
    const active = run("active-old", 1);
    const newest = run("newest-finished", 2);
    newest.state = "succeeded";
    harness.rpc.call.mockResolvedValue(binding([newest, active], active));
    const mounted = render(
      <ArcThreadTeam {...viewProps} threadId="parent" projectId="project" />,
    );
    expect((await screen.findByTestId("team-workspace")).dataset.run).toBe(
      "active-old",
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "newest-finished" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(harness.rpc.call).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("team-workspace").dataset.run).toBe(
      "newest-finished",
    );
    mounted.unmount();
    render(
      <ArcThreadTeam {...viewProps} threadId="parent" projectId="project" />,
    );
    expect((await screen.findByTestId("team-workspace")).dataset.run).toBe(
      "newest-finished",
    );
    expect(
      harness.rpc.call.mock.calls.every(
        ([method]) => method === "listThreadBindings",
      ),
    ).toBe(true);
  });

  it("keeps an off-page user selection explicit and loads older history without replacing it", async () => {
    sessionStorage.setItem("arc:thread-team:v1:project:parent", "saved-old");
    harness.rpc.call.mockImplementation(
      async (_method: string, input: { runOffset: number }) => {
        const data = binding(
          input.runOffset === 0 ? [run("new", 2)] : [run("saved-old", 1)],
        );
        data.origins[0].runsTotal = 21;
        data.origins[0].nextOffset = input.runOffset === 0 ? 20 : null;
        return data;
      },
    );
    render(
      <ArcThreadTeam {...viewProps} threadId="parent" projectId="project" />,
    );
    await screen.findByRole("button", { name: "Older runs" });
    expect(
      screen.getByRole("option", { name: "Saved run · saved-old" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Older runs" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: "Saved run · saved-old" }),
      ).toBeNull(),
    );
    expect(screen.getByTestId("team-workspace").dataset.run).toBe("saved-old");
    expect(harness.rpc.call).toHaveBeenCalledWith(
      "listThreadBindings",
      expect.objectContaining({ runOffset: 20 }),
    );
  });

  it("offers existing orchestration without starting a run and rejects stale async parent results", async () => {
    let release: (value: ArcThreadBindings) => void = () => undefined;
    harness.rpc.call.mockImplementationOnce(
      () =>
        new Promise<ArcThreadBindings>((resolve) => {
          release = resolve;
        }),
    );
    harness.rpc.call.mockResolvedValue({
      origins: [{ ...binding([]).origins[0], threadId: "next" }],
      workers: [],
    });
    const mounted = render(
      <ArcThreadTeam {...viewProps} threadId="parent" projectId="project" />,
    );
    mounted.rerender(
      <ArcThreadTeam {...viewProps} threadId="next" projectId="project" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Orchestration" }),
    );
    release(binding([run("old-response", 1)]));
    await waitFor(() =>
      expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith(
        "orchestration",
        { subPath: "" },
      ),
    );
    expect(screen.queryByTestId("team-workspace")).toBeNull();
  });
});

describe("ARC browser annotations", () => {
  it("labels sealed agent and team identity separately and counts admitted worker chats", () => {
    const data = binding([run("run", 1)]);
    data.workers = [
      {
        threadId: "worker",
        originThreadId: "parent",
        runId: "run",
        effectId: "effect",
        agentId: "agent",
        revision: 3,
        name: "Builder",
        role: "Frontend",
        purpose: "writer",
        providerId: "codex",
        model: "pinned-model",
        group: {
          id: "blue",
          name: "Blue team",
          color: "#2563eb",
          parentGroupId: null,
        },
        team: data.origins[0].defaultRun!.team,
      },
    ];
    const annotations = threadAnnotations(data);
    expect(annotations[0].counters).toContainEqual({
      id: "workers",
      label: "worker chats in this run",
      value: 4,
    });
    expect(annotations[1]).toMatchObject({
      threadId: "worker",
      identities: [
        {
          kind: "agent",
          label: "Builder",
          detail: "Frontend · v3 · codex / pinned-model",
          color: "#2563eb",
        },
        { kind: "group", label: "Blue team" },
      ],
      viewId: null,
    });
  });

  it("batches a large visible list and never publishes a previous project's late reply", async () => {
    let release: (value: ArcThreadBindings) => void = () => undefined;
    harness.rpc.call.mockImplementationOnce(
      () =>
        new Promise<ArcThreadBindings>((resolve) => {
          release = resolve;
        }),
    );
    harness.rpc.call.mockResolvedValue(binding([]));
    const publish = vi.fn();
    const mounted = render(
      <ArcThreadAnnotations
        projectId="previous"
        threadIds={["parent"]}
        onChange={publish}
      />,
    );
    mounted.rerender(
      <ArcThreadAnnotations
        projectId="current"
        threadIds={Array.from({ length: 250 }, (_, index) => `thread-${index}`)}
        onChange={publish}
      />,
    );
    await waitFor(() => expect(harness.rpc.call).toHaveBeenCalledTimes(4));
    release(binding([run("stale", 1)]));
    await waitFor(() =>
      expect(publish.mock.calls.every(([value]) => value.length === 0)).toBe(
        true,
      ),
    );
    expect(
      harness.rpc.call.mock.calls
        .slice(1)
        .map(([, input]) => input.threadIds.length),
    ).toEqual([100, 100, 50]);
  });
});

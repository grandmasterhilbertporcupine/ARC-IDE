// @vitest-environment jsdom

import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalThreadViewProps } from "@get-bb/plugin-sdk";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { useThreadView } from "./PluginThreadView";

const mounts = vi.fn();
const unmounts = vi.fn();
function Companion({
  threadId,
  projectId,
  mainElementId,
}: ExperimentalThreadViewProps) {
  useEffect(() => {
    mounts();
    return () => unmounts();
  }, []);
  return (
    <div data-main-element-id={mainElementId}>
      {projectId}/{threadId} team
    </div>
  );
}
function Harness({ isRootThread = true }: { isRootThread?: boolean }) {
  const { controls, companion, mainElementId } = useThreadView({
    threadId: "thr-a",
    projectId: "proj-a",
    isRootThread,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  return (
    <>
      <header>{controls}</header>
      <div id={mainElementId} data-testid="main-chat">
        <textarea
          aria-label="Main draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      <div>{companion}</div>
      <output aria-label="Location">
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
function register(component = Companion) {
  setPluginSlotRegistrations(
    "extension",
    makePluginRegistrationSet({
      threadViews: [{ id: "team", label: "Team", component }],
    }),
  );
}
afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
  resetAllCrashedPluginSlotsForTest();
  mounts.mockClear();
  unmounts.mockClear();
  vi.restoreAllMocks();
});

describe("thread companion navigation", () => {
  it("keeps delegated workers in chat and removes an inapplicable companion link", async () => {
    register();
    markPluginFrontendsSettled();
    render(
      <MemoryRouter
        initialEntries={[
          "/projects/proj-a/threads/thr-a?threadView=extension%2Fteam&keep=one",
        ]}
      >
        <Harness isRootThread={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "Team" })).toBeNull();
    expect(mounts).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByLabelText("Location").textContent).toBe(
        "/projects/proj-a/threads/thr-a?keep=one",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Main draft" })).toBeTruthy();
  });
  it("mounts only the selected companion and preserves the main draft through URL history", async () => {
    register();
    markPluginFrontendsSettled();
    render(
      <MemoryRouter
        initialEntries={["/projects/proj-a/threads/thr-a?keep=one"]}
      >
        <Harness />
      </MemoryRouter>,
    );
    const draft = screen.getByRole("textbox", { name: "Main draft" });
    const main = screen.getByTestId("main-chat");
    fireEvent.change(draft, { target: { value: "Unsent draft" } });
    expect(mounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(await screen.findByText("proj-a/thr-a team")).toBeTruthy();
    expect(
      screen
        .getByText("proj-a/thr-a team")
        .getAttribute("data-main-element-id"),
    ).toBe(main.id);
    expect(document.getElementById(main.id)).toBe(main);
    expect(screen.getByLabelText("Location").textContent).toContain(
      "keep=one&threadView=extension%2Fteam",
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByText("proj-a/thr-a team")).toBeNull();
    expect(unmounts).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("proj-a/thr-a team");
    expect(document.getElementById(main.id)).toBe(main);
    expect(screen.getByRole("textbox", { name: "Main draft" })).toBe(draft);
    expect(draft).toHaveProperty("value", "Unsent draft");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() =>
      expect(screen.queryByText("proj-a/thr-a team")).toBeNull(),
    );
  });
  it("uses unique main anchors across simultaneously mounted panes", () => {
    render(
      <MemoryRouter>
        <Harness />
        <Harness />
      </MemoryRouter>,
    );
    const panes = screen.getAllByTestId("main-chat");
    expect(panes[0]?.id).not.toBe(panes[1]?.id);
    expect(
      panes.every(
        (pane) =>
          pane.id.length > 0 && document.getElementById(pane.id) === pane,
      ),
    ).toBe(true);
  });
  it("preserves scoped view state across Chat switches and restores it through browser history", async () => {
    function StatefulCompanion({
      viewState,
      onViewStateChange,
    }: ExperimentalThreadViewProps) {
      return (
        <>
          <output aria-label="View state">{viewState ?? "none"}</output>
          <button onClick={() => onViewStateChange("run-two")}>
            Choose run two
          </button>
          <button onClick={() => onViewStateChange(null)}>Clear run</button>
          <button onClick={() => onViewStateChange("x".repeat(513))}>
            Oversized state
          </button>
        </>
      );
    }
    register(StatefulCompanion);
    markPluginFrontendsSettled();
    render(
      <MemoryRouter
        initialEntries={[
          "/projects/proj-a/threads/thr-a?keep=one&threadView=extension%2Fteam&threadViewState.extension%2Fteam=run-one&threadViewState.other%2Fteam=other-run#anchor",
        ]}
      >
        <Harness />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("View state").textContent).toBe("run-one");
    fireEvent.click(screen.getByRole("button", { name: "Choose run two" }));
    expect(screen.getByLabelText("View state").textContent).toBe("run-two");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByLabelText("Location").textContent).toContain(
      "threadViewState.extension%2Fteam=run-two",
    );
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(screen.getByLabelText("View state").textContent).toBe("run-two");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(screen.getByLabelText("View state").textContent).toBe("run-one"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Oversized state" }));
    expect(screen.getByLabelText("View state").textContent).toBe("run-one");
    fireEvent.click(screen.getByRole("button", { name: "Clear run" }));
    expect(screen.getByLabelText("View state").textContent).toBe("none");
    expect(screen.getByLabelText("Location").textContent).toContain("keep=one");
    expect(screen.getByLabelText("Location").textContent).toContain(
      "threadViewState.other%2Fteam=other-run",
    );
    expect(screen.getByLabelText("Location").textContent).toContain("#anchor");
  });
  it("retains a deep link while plugins boot, then falls back when the selected plugin disappears", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/projects/proj-a/threads/thr-a?keep=one&threadView=extension%2Fteam",
        ]}
      >
        <Harness />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Location").textContent).toContain(
      "threadView",
    );
    act(() => {
      register();
      markPluginFrontendsSettled();
    });
    await screen.findByText("proj-a/thr-a team");
    act(() => removePluginSlotRegistrations("extension"));
    await waitFor(() =>
      expect(screen.getByLabelText("Location").textContent).toBe(
        "/projects/proj-a/threads/thr-a?keep=one",
      ),
    );
    expect(screen.queryByRole("region", { name: "Team" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Main draft" })).toBeTruthy();
  });
  it("contains a companion crash and restores Chat without removing the main composer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    register(() => {
      throw new Error("broken companion");
    });
    markPluginFrontendsSettled();
    render(
      <MemoryRouter
        initialEntries={[
          "/projects/proj-a/threads/thr-a?threadView=extension%2Fteam",
        ]}
      >
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Location").textContent).toBe(
        "/projects/proj-a/threads/thr-a",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Main draft" })).toBeTruthy();
  });
});

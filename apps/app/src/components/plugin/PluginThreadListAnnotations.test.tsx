// @vitest-environment jsdom

import { useEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalThreadListAnnotationsProps } from "@get-bb/plugin-sdk";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import {
  PluginThreadListAnnotationsProvider,
  useThreadListAnnotation,
} from "./PluginThreadListAnnotations";

const callbacks = new Map<
  string,
  ExperimentalThreadListAnnotationsProps["onChange"]
>();
const mounts = vi.fn();
function Publisher({
  projectId,
  threadIds,
  onChange,
}: ExperimentalThreadListAnnotationsProps) {
  useEffect(() => {
    mounts(projectId, threadIds);
    callbacks.set(projectId, onChange);
  }, [projectId, threadIds, onChange]);
  return null;
}
function Row({ id }: { id: string }) {
  return (
    <output aria-label={id}>
      {JSON.stringify(useThreadListAnnotation(id))}
    </output>
  );
}
const annotation = (threadId: string, label: string) => ({
  threadId,
  identities: [
    {
      kind: "agent" as const,
      id: "agent-v1",
      label,
      detail: "v1",
      color: null,
    },
  ],
  counters: [{ id: "runs", label: "Runs", value: 2 }],
  viewId: "team",
});
function register() {
  setPluginSlotRegistrations(
    "extension",
    makePluginRegistrationSet({
      threadViews: [{ id: "team", label: "Team", component: () => null }],
      threadListAnnotations: [{ id: "bindings", component: Publisher }],
    }),
  );
}
afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  callbacks.clear();
  mounts.mockClear();
  vi.restoreAllMocks();
});

describe("batched thread annotations", () => {
  it("mounts one publisher per represented project and filters foreign rows", () => {
    register();
    render(
      <MemoryRouter>
        <PluginThreadListAnnotationsProvider
          threads={[
            { id: "a", projectId: "p1" },
            { id: "child", projectId: "p1" },
            { id: "b", projectId: "p2" },
          ]}
        >
          <Row id="a" />
          <Row id="child" />
          <Row id="b" />
        </PluginThreadListAnnotationsProvider>
      </MemoryRouter>,
    );
    expect(mounts).toHaveBeenCalledTimes(2);
    expect(mounts).toHaveBeenCalledWith("p1", ["a", "child"]);
    act(() =>
      callbacks.get("p1")!([
        annotation("a", "Pinned agent"),
        annotation("child", "Child agent"),
        annotation("b", "Wrong project"),
      ]),
    );
    expect(screen.getByLabelText("a").textContent).toContain(
      '"pluginId":"extension"',
    );
    expect(screen.getByLabelText("child").textContent).toContain("Child agent");
    expect(screen.getByLabelText("b").textContent).toBe("[]");
    expect(mounts).toHaveBeenCalledTimes(2);
  });
  it("drops old project replies and removes annotations when their plugin disappears", () => {
    register();
    const tree = (projectId: string) => (
      <MemoryRouter>
        <PluginThreadListAnnotationsProvider threads={[{ id: "a", projectId }]}>
          <Row id="a" />
        </PluginThreadListAnnotationsProvider>
      </MemoryRouter>
    );
    const view = render(tree("p1"));
    const old = callbacks.get("p1")!;
    act(() => old([annotation("a", "Old")]));
    view.rerender(tree("p2"));
    expect(screen.getByLabelText("a").textContent).toBe("[]");
    act(() => callbacks.get("p2")!([annotation("a", "New")]));
    act(() => old([annotation("a", "Late old")]));
    expect(screen.getByLabelText("a").textContent).toContain("New");
    expect(screen.getByLabelText("a").textContent).not.toContain("Late old");
    act(() => removePluginSlotRegistrations("extension"));
    expect(screen.getByLabelText("a").textContent).toBe("[]");
  });
  it("clears malformed metadata and refuses another plugin's view id", () => {
    setPluginSlotRegistrations(
      "extension",
      makePluginRegistrationSet({
        threadListAnnotations: [{ id: "bindings", component: Publisher }],
      }),
    );
    setPluginSlotRegistrations(
      "other",
      makePluginRegistrationSet({
        threadViews: [{ id: "team", label: "Team", component: () => null }],
      }),
    );
    render(
      <MemoryRouter>
        <PluginThreadListAnnotationsProvider
          threads={[{ id: "a", projectId: "p1" }]}
        >
          <Row id="a" />
        </PluginThreadListAnnotationsProvider>
      </MemoryRouter>,
    );
    const publish = callbacks.get("p1")!;
    act(() => publish([annotation("a", "Pinned")]));
    expect(screen.getByLabelText("a").textContent).toContain('"viewId":null');
    act(() =>
      publish([
        {
          ...annotation("a", "Invalid"),
          counters: [{ id: "runs", label: "Runs", value: -1 }],
        },
      ]),
    );
    expect(screen.getByLabelText("a").textContent).toBe("[]");
    act(() =>
      publish([
        {
          ...annotation("a", "Duplicate"),
          counters: [
            { id: "runs", label: "Runs", value: 1 },
            { id: "runs", label: "Runs", value: 2 },
          ],
        },
      ]),
    );
    expect(screen.getByLabelText("a").textContent).toBe("[]");
  });
  it("merges independent publishers and clears only the crashed publisher's metadata", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let crash: (() => void) | undefined;
    function Fragile({ onChange }: ExperimentalThreadListAnnotationsProps) {
      const [broken, setBroken] = useState(false);
      useEffect(() => {
        onChange([annotation("a", "Fragile agent")]);
        crash = () => setBroken(true);
      }, [onChange]);
      if (broken) throw new Error("Publisher failed");
      return null;
    }
    register();
    setPluginSlotRegistrations(
      "other",
      makePluginRegistrationSet({
        threadListAnnotations: [{ id: "bindings", component: Fragile }],
      }),
    );
    render(
      <MemoryRouter>
        <PluginThreadListAnnotationsProvider
          threads={[{ id: "a", projectId: "p1" }]}
        >
          <Row id="a" />
        </PluginThreadListAnnotationsProvider>
      </MemoryRouter>,
    );
    act(() => callbacks.get("p1")!([annotation("a", "Healthy agent")]));
    expect(screen.getByLabelText("a").textContent).toContain("Healthy agent");
    expect(screen.getByLabelText("a").textContent).toContain("Fragile agent");
    act(() => crash?.());
    expect(screen.getByLabelText("a").textContent).toContain("Healthy agent");
    expect(screen.getByLabelText("a").textContent).not.toContain(
      "Fragile agent",
    );
  });
});

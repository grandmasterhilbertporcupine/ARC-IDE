// @vitest-environment jsdom

import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import type {
  ExperimentalThreadListAnnotation,
  ExperimentalThreadListAnnotationsProps,
} from "@get-bb/plugin-sdk";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { useThreadListAnnotation } from "@/components/plugin/PluginThreadListAnnotations";
import {
  ThreadBrowserRows,
  useRegisterThreadBrowserRow,
} from "./ThreadBrowserRows";

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: [] }),
}));

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("thread browser row visibility", () => {
  it("retires annotation subscriptions while disabled and restores them without remounting rows", async () => {
    const thread = makeThreadListEntry({
      id: "parent",
      projectId: "project-a",
    });
    const subscribers: ExperimentalThreadListAnnotationsProps[] = [];
    const retire = vi.fn();
    function Publisher({
      projectId,
      threadIds,
      onChange,
    }: ExperimentalThreadListAnnotationsProps) {
      useEffect(() => {
        const props = { projectId, threadIds, onChange };
        subscribers.push(props);
        return () => retire(props);
      }, [projectId, threadIds, onChange]);
      return null;
    }
    function RetainedRow() {
      useRegisterThreadBrowserRow(thread);
      const annotations = useThreadListAnnotation(thread.id);
      return (
        <div data-testid="retained-row">
          <textarea aria-label="Draft" />
          <output aria-label="Annotations">
            {JSON.stringify(annotations)}
          </output>
        </div>
      );
    }
    const annotation = (label: string): ExperimentalThreadListAnnotation => ({
      threadId: thread.id,
      identities: [
        { kind: "agent", id: "agent-v1", label, detail: "v1", color: null },
      ],
      counters: [{ id: "runs", label: "Runs", value: 2 }],
      viewId: "team",
    });
    setPluginSlotRegistrations(
      "extension",
      makePluginRegistrationSet({
        threadViews: [{ id: "team", label: "Team", component: () => null }],
        threadListAnnotations: [{ id: "bindings", component: Publisher }],
      }),
    );
    const tree = (enabled: boolean) => (
      <MemoryRouter>
        <ThreadBrowserRows enabled={enabled}>
          <RetainedRow />
        </ThreadBrowserRows>
      </MemoryRouter>
    );
    const view = render(tree(true));
    await waitFor(() => expect(subscribers).toHaveLength(1));
    const first = subscribers[0]!;
    expect(first.projectId).toBe(thread.projectId);
    expect(first.threadIds).toEqual([thread.id]);
    act(() => first.onChange([annotation("Pinned agent")]));
    expect(screen.getByLabelText("Annotations").textContent).toContain(
      "Pinned agent",
    );
    const row = screen.getByTestId("retained-row");
    const draft = screen.getByLabelText("Draft");
    fireEvent.change(draft, { target: { value: "Keep this draft" } });

    view.rerender(tree(false));
    expect(retire).toHaveBeenCalledWith(first);
    expect(screen.getByLabelText("Annotations").textContent).toBe("[]");
    expect(screen.getByTestId("retained-row")).toBe(row);
    expect(screen.getByLabelText("Draft")).toBe(draft);
    expect(screen.getByDisplayValue("Keep this draft")).toBe(draft);
    act(() => first.onChange([annotation("Late hidden reply")]));
    expect(screen.getByLabelText("Annotations").textContent).toBe("[]");
    expect(subscribers).toHaveLength(1);

    view.rerender(tree(true));
    await waitFor(() => expect(subscribers).toHaveLength(2));
    const resumed = subscribers[1]!;
    expect(resumed.projectId).toBe(thread.projectId);
    expect(resumed.threadIds).toEqual([thread.id]);
    expect(resumed.onChange).not.toBe(first.onChange);
    act(() => resumed.onChange([annotation("Refreshed agent")]));
    act(() => first.onChange([annotation("Retired reply")]));
    expect(screen.getByLabelText("Annotations").textContent).toContain(
      "Refreshed agent",
    );
    expect(screen.getByLabelText("Annotations").textContent).not.toContain(
      "Retired reply",
    );
    expect(screen.getByTestId("retained-row")).toBe(row);
    expect(screen.getByLabelText("Draft")).toBe(draft);
    expect(screen.getByDisplayValue("Keep this draft")).toBe(draft);
  });
});

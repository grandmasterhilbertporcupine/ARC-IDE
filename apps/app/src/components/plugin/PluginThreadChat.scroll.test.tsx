// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginThreadChat } from "./PluginThreadChat";

const mocks = vi.hoisted(() => ({
  rows: {} as Record<string, Array<{ id: string; height: number }>>,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: (threadId: string) => ({
    data: {
      id: threadId,
      projectId: "project-scroll",
      providerId: "codex",
      environmentId: null,
    },
    error: null,
  }),
}));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviderInfo: () => null,
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: null }),
}));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));
vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ isLocalDaemonHost: () => true }),
}));
vi.mock("@/components/thread/timeline/ThreadTimelineNavigationContext", () => ({
  useThreadTimelineNavigation: () => null,
}));
vi.mock("@/components/thread/embedded-chat", () => ({
  EmbeddedThreadChat: () => <textarea aria-label="Unexpected composer" />,
}));
vi.mock("@/components/thread/timeline", () => ({
  ThreadTimelinePanelContent: ({ threadId }: { threadId: string }) => (
    <div data-timeline-row-list="top-level">
      {(mocks.rows[threadId] ?? []).map((row) => (
        <div
          key={row.id}
          data-timeline-row-id={row.id}
          data-height={row.height}
        >
          {row.id}
        </div>
      ))}
    </div>
  ),
}));

class ResizeObserverFixture implements ResizeObserver {
  static active = new Set<ResizeObserverFixture>();
  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverFixture.active.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverFixture.active.delete(this);
  }
}

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const portHeight = 200;

function rowsIn(element: Element): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>("[data-height]"));
}

function contentHeight(element: Element): number {
  return rowsIn(element).reduce(
    (sum, row) => sum + Number(row.dataset.height),
    0,
  );
}

function settleLayout() {
  act(() => {
    for (const observer of ResizeObserverFixture.active)
      observer.callback([], observer);
    for (let round = 0; frames.size > 0 && round < 10; round += 1) {
      const current = [...frames.values()];
      frames.clear();
      for (const callback of current) callback(performance.now());
    }
  });
}

function scrollPort(container: HTMLElement): HTMLElement {
  const element = container.querySelector(".overflow-y-auto");
  if (!(element instanceof HTMLElement))
    throw new Error("Expected a contained transcript scroll port");
  return element;
}

function history(count: number, prefix = "message") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    height: 200,
  }));
}

function mount(
  threadId = "attempt-a",
  layout: "contained" | "document" = "contained",
) {
  const store = createStore();
  const content = (id: string) => (
    <Provider store={store}>
      <MemoryRouter>
        <PluginThreadChat threadId={id} variant="timeline" layout={layout} />
      </MemoryRouter>
    </Provider>
  );
  const view = render(content(threadId));
  settleLayout();
  return {
    ...view,
    update(id = threadId) {
      view.rerender(content(id));
      settleLayout();
    },
  };
}

beforeEach(() => {
  mocks.rows = {};
  frames.clear();
  ResizeObserverFixture.active.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverFixture);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      return contentHeight(this);
    },
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(
    portHeight,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (!(this instanceof HTMLElement) || this.dataset.height === undefined)
        return new DOMRect(0, 0, 300, portHeight);
      const port = this.closest(".overflow-y-auto");
      if (!(port instanceof HTMLElement)) return new DOMRect();
      const rows = rowsIn(port);
      const index = rows.indexOf(this);
      const top = rows
        .slice(0, index)
        .reduce((sum, row) => sum + Number(row.dataset.height), 0);
      return new DOMRect(
        0,
        top - port.scrollTop,
        300,
        Number(this.dataset.height),
      );
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("contained plugin transcripts", () => {
  it("opens a completed conversation at its latest response without a composer", () => {
    mocks.rows["attempt-a"] = [
      { id: "long-first-prompt", height: 1600 },
      { id: "final-response", height: 200 },
    ];
    const view = mount();
    const port = scrollPort(view.container);
    expect(port.scrollTop).toBe(port.scrollHeight - port.clientHeight);
    expect(view.queryByRole("textbox")).toBeNull();
  });

  it("follows delayed initial rows, appended messages and a growing final message", () => {
    const view = mount();
    const port = scrollPort(view.container);
    mocks.rows["attempt-a"] = history(4);
    view.update();
    expect(port.scrollTop).toBe(600);
    mocks.rows["attempt-a"] = history(5);
    view.update();
    expect(port.scrollTop).toBe(800);
    mocks.rows["attempt-a"]![4]!.height = 400;
    view.update();
    expect(port.scrollTop).toBe(1000);
  });

  it("preserves history while detached and resumes following when the user returns to the bottom", () => {
    mocks.rows["attempt-a"] = history(6);
    const view = mount();
    const port = scrollPort(view.container);
    fireEvent.wheel(port, { deltaY: -500 });
    port.scrollTop = 120;
    fireEvent.scroll(port);
    mocks.rows["attempt-a"] = history(7);
    view.update();
    expect(port.scrollTop).toBe(120);
    fireEvent.wheel(port, { deltaY: 1500 });
    port.scrollTop = port.scrollHeight - port.clientHeight;
    fireEvent.scroll(port);
    mocks.rows["attempt-a"] = history(8);
    view.update();
    expect(port.scrollTop).toBe(1400);
  });

  it("starts a new attempt at its tail and restores the earlier attempt's history position", () => {
    mocks.rows["attempt-a"] = history(6, "a");
    mocks.rows["attempt-b"] = history(4, "b");
    const view = mount();
    const port = scrollPort(view.container);
    fireEvent.wheel(port, { deltaY: -500 });
    port.scrollTop = 250;
    fireEvent.scroll(port);
    view.update("attempt-b");
    expect(scrollPort(view.container).scrollTop).toBe(600);
    view.update("attempt-a");
    expect(scrollPort(view.container).scrollTop).toBe(250);
  });

  it("leaves document-layout scrolling to the embedding document", () => {
    mocks.rows["attempt-a"] = history(6);
    const view = mount("attempt-a", "document");
    expect(view.container.querySelector(".overflow-y-auto")).toBeNull();
    expect(view.getByText("message-5")).toBeTruthy();
    expect(view.queryByRole("textbox")).toBeNull();
  });
});

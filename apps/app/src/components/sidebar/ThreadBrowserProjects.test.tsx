// @vitest-environment jsdom

import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { createStore, Provider } from "jotai";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectResponse,
  SidebarBootstrapResponse,
} from "@bb/server-contract";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  sidebarManualSectionOrderAtom,
  sidebarSectionOrderAtom,
} from "./sidebarCollapsedAtoms";
import { threadBrowserProjectAtom } from "./threadBrowserState";
import { ThreadBrowserProjects } from "./ThreadBrowserProjects";

const navigation = vi.hoisted(
  (): {
    data: SidebarBootstrapResponse | undefined;
    isSuccess: boolean;
    isPlaceholderData: boolean;
    isPending: boolean;
    isError: boolean;
    refetch: () => Promise<void>;
  } => ({
    data: undefined,
    isSuccess: true,
    isPlaceholderData: false,
    isPending: false,
    isError: false,
    refetch: async () => {},
  }),
);

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => navigation,
}));
vi.mock("@/components/project/ProjectActionsMenu", () => ({
  ProjectActionsContextMenu: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ProjectActionsMenu: ({ project }: { project: ProjectResponse }) => (
    <button type="button" aria-label={`${project.name} actions`}>
      Actions
    </button>
  ),
}));

const alpha = makeProjectWithThreadsResponse({ id: "proj_a", name: "Alpha" });
const beta = makeProjectWithThreadsResponse({ id: "proj_b", name: "Beta" });
const savedOrder = ["threads", "project:proj_b", "pinned", "project:proj_a"];

beforeEach(() => {
  localStorage.clear();
  navigation.data = makeSidebarBootstrapResponse({ projects: [alpha, beta] });
  navigation.isSuccess = true;
  navigation.isPlaceholderData = false;
  navigation.isPending = false;
  navigation.isError = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup() {
  const store = createStore();
  store.set(sidebarSectionOrderAtom, savedOrder);
  store.set(sidebarManualSectionOrderAtom, [
    "section:custom",
    "pinned",
    "threads",
  ]);
  const onNavigate = vi.fn();
  const content = (
    <Provider store={store}>
      <MemoryRouter>
        <ThreadBrowserProjects
          onNavigate={onNavigate}
          isCreatingProject={false}
        />
      </MemoryRouter>
    </Provider>
  );
  const view = render(content);
  return { store, onNavigate, view, rerender: () => view.rerender(content) };
}

function projectLabels() {
  return screen
    .getAllByRole("button")
    .map((button) => button.textContent)
    .filter((name) => name === "Alpha" || name === "Beta");
}

describe("thread browser project rail", () => {
  it("preserves saved project order and independent named thread groups", () => {
    const { store, onNavigate } = setup();
    expect(projectLabels()).toEqual(["Beta", "Alpha"]);
    expect(store.get(sidebarSectionOrderAtom)).toEqual(savedOrder);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual([
      "section:custom",
      "pinned",
      "threads",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(store.get(threadBrowserProjectAtom)).toBe("proj_b");
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Beta actions" })).toBeTruthy();
  });

  it("does not prune saved order while only a partial cached bootstrap is available", async () => {
    navigation.data = makeSidebarBootstrapResponse({ projects: [alpha] });
    navigation.isPlaceholderData = true;
    const { store, view, onNavigate } = setup();
    expect(store.get(sidebarSectionOrderAtom)).toEqual(savedOrder);
    expect(
      screen
        .getByRole("button", { name: "Alpha" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    navigation.data = makeSidebarBootstrapResponse({ projects: [alpha, beta] });
    navigation.isPlaceholderData = false;
    view.rerender(
      <Provider store={store}>
        <MemoryRouter>
          <ThreadBrowserProjects
            onNavigate={onNavigate}
            isCreatingProject={false}
          />
        </MemoryRouter>
      </Provider>,
    );
    await waitFor(() => expect(projectLabels()).toEqual(["Beta", "Alpha"]));
    expect(store.get(sidebarSectionOrderAtom)).toEqual(savedOrder);
  });

  it("reorders through the shared keyboard drag mechanism without navigating", async () => {
    const { store, onNavigate } = setup();
    for (const [index, name] of ["Beta", "Alpha"].entries()) {
      const button = screen.getByRole("button", { name });
      const wrapper = button.parentElement;
      if (!wrapper) throw new Error("Project row wrapper missing");
      vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, index * 40, 200, 34),
      );
    }
    const button = screen.getByRole("button", { name: "Beta" });
    button.focus();
    fireEvent.keyDown(button, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(document.body.dataset.sidebarDragging).toBe("true"),
    );
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(document, { key: " ", code: "Space" });
    });
    await waitFor(() => expect(projectLabels()).toEqual(["Alpha", "Beta"]));
    expect(store.get(sidebarSectionOrderAtom)).toEqual([
      "threads",
      "pinned",
      "project:proj_a",
      "project:proj_b",
    ]);
    expect(store.get(sidebarManualSectionOrderAtom)).toEqual([
      "section:custom",
      "pinned",
      "threads",
    ]);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

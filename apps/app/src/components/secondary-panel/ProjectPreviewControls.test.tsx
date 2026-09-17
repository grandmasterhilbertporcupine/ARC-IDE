// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPreviewControls } from "./ProjectPreviewControls";
import type { ProjectPreview } from "@bb/sdk/browser";

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  configure: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  detach: vi.fn(),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: {
    experimental_previews: mock,
    hosts: {
      list: async () => [
        { id: "host", name: "My computer", status: "connected" },
      ],
    },
    files: {
      read: async () => ({
        contentEncoding: "utf8",
        content: '{"scripts":{"dev":"vite"},"packageManager":"pnpm@9"}',
      }),
    },
  },
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({
    data: { projectId: "project", hostId: "host", path: "C:\\Project" },
  }),
}));
vi.mock("@/lib/bb-desktop", () => ({
  getDesktopBrowserApi: () => ({ getTarget: async () => ({ hostId: "host" }) }),
}));
const empty: ProjectPreview = {
  projectId: "project",
  revision: 0,
  config: null,
  terminal: null,
  status: "unconfigured",
  url: null,
  logs: "",
  error: null,
  cleanup: null,
  detachedSessions: [],
};
afterEach(() => {
  cleanup();
  for (const value of Object.values(mock)) value.mockReset();
});
function renderControls() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onNavigate = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ProjectPreviewControls environmentId="env" onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
  return onNavigate;
}

describe("project preview controls", () => {
  it("keeps saving separate from launching, offers discovered scripts and persists explicit launch settings", async () => {
    mock.get.mockResolvedValue(empty);
    mock.configure.mockImplementation(async ({ config }) => ({
      ...empty,
      revision: 1,
      config,
      status: "stopped",
    }));
    renderControls();
    const configure = await screen.findByRole("button", {
      name: "Set launch command",
    });
    await waitFor(() => expect(configure.hasAttribute("disabled")).toBe(false));
    fireEvent.click(configure);
    fireEvent.click(
      await screen.findByRole("button", { name: "pnpm run dev" }),
    );
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Preview launch command",
      }).value,
    ).toBe("pnpm run dev");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.configure).toHaveBeenCalledWith({
        projectId: "project",
        expectedRevision: 0,
        config: {
          hostId: "host",
          cwd: "C:\\Project",
          command: "pnpm run dev",
          url: "",
        },
      }),
    );
    expect(mock.start).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: /^Start$/ });
  });
  it("shows a failed start without inventing a running preview or navigating", async () => {
    mock.get.mockResolvedValue({
      ...empty,
      revision: 1,
      status: "stopped",
      config: {
        hostId: "host",
        cwd: "C:\\Project",
        command: "npm run dev",
        url: "",
      },
    });
    mock.start.mockRejectedValue(new Error("Machine disconnected"));
    const navigate = renderControls();
    await act(async () =>
      fireEvent.click(await screen.findByRole("button", { name: /^Start$/ })),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Machine disconnected",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^Start$/ }).hasAttribute("disabled"),
    ).toBe(false);
  });
  it("requires review and acknowledgment of the exact lost session before releasing tracking", async () => {
    const lost: ProjectPreview = {
      ...empty,
      revision: 7,
      status: "failed",
      config: {
        hostId: "host",
        cwd: "C:\\Project",
        command: "npm run dev",
        url: "",
      },
      cleanup: { hostId: "host", terminalId: "lost-terminal-7" },
      logs: "Last owned output",
      error: "Process exit not confirmed",
    };
    mock.get.mockResolvedValue(lost);
    mock.detach.mockResolvedValue({
      ...lost,
      status: "detached",
      revision: 8,
      cleanup: null,
      error: null,
    });
    const navigate = renderControls();
    const recovery = await screen.findByRole("button", {
      name: "Detach lost session",
    });
    expect(screen.queryByRole("button", { name: /^Start$/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Restart" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Configure" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Retry Stop" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(recovery);
    const confirm = await screen.findByRole("button", {
      name: "Detach this session",
    });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("lost-terminal-7")).toBeTruthy();
    expect(screen.getByText(/It does not stop the old processes/)).toBeTruthy();
    expect(mock.detach).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed this session/ }),
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mock.detach).toHaveBeenCalledExactlyOnceWith({
        projectId: "project",
        expectedRevision: 7,
        terminalId: "lost-terminal-7",
        acknowledgeUnconfirmedProcess: true,
      }),
    );
    await screen.findByRole("button", { name: /^Start$/ });
    expect(screen.getByText(/Tracking released/)).toBeTruthy();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.stop).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

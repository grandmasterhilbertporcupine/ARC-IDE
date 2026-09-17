// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { ProviderOnboarding } from "./ProviderOnboarding";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  close: vi.fn(),
  refresh: vi.fn(),
  openGuide: vi.fn(),
  connected: true,
  status: "unknown",
}));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({
    data: [
      {
        id: "local-host",
        name: "This PC",
        status: mocks.connected ? "connected" : "disconnected",
      },
    ],
    isPending: false,
  }),
}));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviderStates: () => ({
    data: {
      providers: [
        {
          providerId: "codex",
          displayName: "Codex",
          status: mocks.status,
          loginCommand: "provider-owned-login",
          accountEmail: null,
          planLabel: null,
          installedVersion: "1.0.0",
          statusMessage: null,
        },
      ],
    },
    isPending: false,
    isFetching: false,
    refetch: mocks.refresh,
  }),
  useHostProviderCliStatus: () => ({
    data: {},
    isFetching: false,
    refetch: mocks.refresh,
  }),
  useSystemProviderUsageLimits: () => ({ usage: {}, refetch: mocks.refresh }),
}));
vi.mock("@/components/provider-cli/provider-cli-install", () => ({
  buildProviderCliIssue: () => null,
  hasProviderCliAction: () => false,
  useProviderCliInstallRunner: () => ({
    runningJobKey: null,
    queuedJobKeys: new Set(),
    startInstall: vi.fn(),
  }),
}));
vi.mock("@/components/secondary-panel/TerminalHostSelector", () => ({
  resolveTerminalHost: ({
    hosts,
  }: {
    hosts: { id: string; status: string }[];
  }) => hosts[0],
  TerminalHostSelector: () => <span>This PC</span>,
}));
vi.mock("@/components/thread/terminal/ThreadTerminalView", () => ({
  ThreadTerminalView: () => <div>Provider terminal</div>,
}));
vi.mock("@/lib/sdk", () => ({
  sdk: { terminals: { create: mocks.create, close: mocks.close } },
}));
vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: mocks.openGuide,
}));

const provider = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  strings: {
    installUrl: "https://learn.chatgpt.com/docs/app-server",
    signInHint: "Sign in with Codex",
    expiredHint: "Sign in again",
  },
});
beforeEach(() => {
  mocks.connected = true;
  mocks.status = "unknown";
  mocks.create.mockResolvedValue({
    id: "owned-login",
    title: "Codex sign-in",
    status: "running",
  });
  mocks.close.mockResolvedValue({});
  mocks.refresh.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Provider onboarding", () => {
  it("does not equate an installed runtime with verified authentication", () => {
    render(<ProviderOnboarding providers={[provider]} disabled={false} />);
    expect(screen.getByText("Readiness unverified")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    expect(mocks.openGuide).toHaveBeenCalledWith(provider.strings?.installUrl);
  });
  it("starts the exact provider command on the selected host and cancels only its owned terminal", async () => {
    render(<ProviderOnboarding providers={[provider]} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    await screen.findByText("Provider terminal");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "host_path", hostId: "local-host", cwd: null },
        start: { mode: "command", command: "provider-owned-login" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() =>
      expect(mocks.close).toHaveBeenCalledWith({
        terminalId: "owned-login",
        mode: "force",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Provider terminal")).toBeNull(),
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it("does not launch sign-in on an offline host", () => {
    mocks.connected = false;
    render(<ProviderOnboarding providers={[provider]} disabled={false} />);
    const signIn = screen.getByRole("button", { name: "Sign in to Codex" });
    expect(signIn.hasAttribute("disabled")).toBe(true);
    fireEvent.click(signIn);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("cleans up an active login when leaving settings", async () => {
    const result = render(
      <ProviderOnboarding providers={[provider]} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
    await screen.findByText("Provider terminal");
    result.unmount();
    expect(mocks.close).toHaveBeenCalledWith({
      terminalId: "owned-login",
      mode: "force",
    });
  });
});

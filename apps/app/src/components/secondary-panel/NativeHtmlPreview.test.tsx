// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeHtmlPreview } from "./NativeHtmlPreview";
import type { BrowserTabContent } from "./BrowserTabContent";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  content: vi.fn(),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: {
    files: {
      createPreview: mocks.create,
      experimental_refreshPreview: mocks.refresh,
    },
  },
}));
vi.mock("@/lib/bb-desktop", () => ({
  getDesktopBrowserApi: () => ({ reload: mocks.reload }),
}));
vi.mock("./BrowserTabContent", () => ({
  BrowserTabContent: (props: ComponentProps<typeof BrowserTabContent>) => {
    mocks.content(props);
    return <div data-testid="native-preview">{props.initialUrl}</div>;
  },
}));

const source = {
  hostId: "host",
  rootPath: "C:\\Site",
  filePath: "pages/example file.htm",
};
function props() {
  return {
    source,
    tabId: "preview",
    threadId: "thread",
    environmentId: "env",
    initialUrl: "http://localhost/api/v1/file-previews/expired/index.html",
    addressFocusRequest: null,
    canShowNativeBrowserView: true,
    visibilityCoordinator: null,
    onUpdate: vi.fn(),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  mocks.create.mockResolvedValue({
    baseUrl: "/api/v1/file-previews/fresh",
    expiresAtMs: Date.now() + 600_000,
  });
  mocks.refresh.mockResolvedValue({
    expiresAtMs: Date.now() + 600_000,
    changed: true,
    trackedFiles: 33,
    truncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("native HTML preview ownership", () => {
  it("replaces a persisted expired URL with a fresh root-scoped lease and renews assets without a file tab", async () => {
    const input = props();
    const view = render(<NativeHtmlPreview {...input} />);
    expect(screen.queryByTestId("native-preview")).toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("native-preview").textContent).toBe(
      `${window.location.origin}/api/v1/file-previews/fresh/pages/example%20file.htm`,
    );
    expect(mocks.create).toHaveBeenCalledWith({
      hostId: "host",
      rootPath: "C:\\Site",
      signal: expect.any(AbortSignal),
    });
    const content: ComponentProps<typeof BrowserTabContent> =
      mocks.content.mock.calls.at(-1)![0];
    expect(content.navigateOnAttach).toBe(true);
    act(() =>
      content.onUpdate({
        tabId: "preview",
        title: "Old state",
        url: input.initialUrl,
      }),
    );
    expect(input.onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ htmlSource: source }),
    );
    act(() =>
      content.onUpdate({
        tabId: "preview",
        title: "Page",
        url: content.initialUrl,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.refresh).toHaveBeenCalledWith({
      previewId: "fresh",
      signal: expect.any(AbortSignal),
    });
    expect(mocks.reload).toHaveBeenCalledWith("preview");
    act(() =>
      content.onUpdate({
        tabId: "preview",
        title: "Elsewhere",
        url: "https://example.com/",
      }),
    );
    expect(input.onUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ htmlSource: null }),
    );
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0].signal.aborted).toBe(true);
  });

  it("keeps failed or hidden previews detached and acquires a new lease after reopening", async () => {
    const input = props();
    mocks.create.mockRejectedValueOnce(new Error("Machine disconnected"));
    const view = render(<NativeHtmlPreview {...input} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain(
      "Machine disconnected",
    );
    expect(mocks.content).not.toHaveBeenCalled();
    view.rerender(
      <NativeHtmlPreview {...input} canShowNativeBrowserView={false} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    view.rerender(<NativeHtmlPreview {...input} />);
    await act(async () => {});
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("native-preview")).not.toBeNull();
  });
});

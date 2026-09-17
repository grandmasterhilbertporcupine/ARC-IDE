// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AddressedRetryAction } from "./AddressedRetryAction";

const retry = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { experimental_retryAddressed: retry } },
}));
vi.mock("@/components/ui/app-toast", () => ({
  appToast: { success: vi.fn(), error: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("retries only the saved operation and leaves setup errors actionable", async () => {
  const { wrapper, queryClient } = createQueryClientTestHarness();
  retry.mockRejectedValueOnce(new Error("Choose a valid project provider"));
  retry.mockResolvedValueOnce({
    ok: true,
    delivery: "sent",
    experimental_addressed: {
      runId: "run-1",
      status: "started",
      summary: "Resumed",
    },
  });
  render(
    <MemoryRouter>
      <AddressedRetryAction threadId="thread-1" operationId="saved-operation" />
    </MemoryRouter>,
    { wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry saved Send" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a valid project provider",
    ),
  );
  expect(
    screen.getByRole("link", { name: "Provider setup" }).getAttribute("href"),
  ).toBe("/settings/providers");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved Send" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Resumed" }).hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(retry.mock.calls).toEqual([
    [{ threadId: "thread-1", operationId: "saved-operation" }],
    [{ threadId: "thread-1", operationId: "saved-operation" }],
  ]);
  queryClient.clear();
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AddressedFollowups } from "./addressed-followups.js";

const mocks = vi.hoisted(() => ({ call: vi.fn(), navigate: vi.fn() }));
const rpc = { call: mocks.call };
const navigate = { toPluginPanel: mocks.navigate };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  useRealtime: () => {},
  useBbNavigate: () => navigate,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const item = {
  operationId: "5c9b8e55-c7e8-4f16-b72d-9a324bbfca29",
  goal: "Keep the existing changes and add keyboard support",
  predecessorRunId: "original",
  successorRunId: "continued",
  state: "action-required",
  error:
    "The candidate changed outside this run. Verify the saved work before retrying.",
  createdAt: 1,
  updatedAt: 5,
};
describe("addressed follow-up recovery", () => {
  it("retains the user's request and sends the exact revision when retrying a blocked continuation", async () => {
    mocks.call.mockImplementation(async (method: string) =>
      method === "getAddressedFollowups" ? { followups: [item] } : item,
    );
    render(<AddressedFollowups projectId="project" threadId="thread" />);
    expect(await screen.findByText(item.goal)).toBeTruthy();
    expect(screen.getByText(item.error)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith("retryAddressedFollowup", {
        projectId: "project",
        threadId: "thread",
        operationId: item.operationId,
        expectedUpdatedAt: 5,
      }),
    );
  });
  it("opens the admitted successor and does not offer retry or cancellation for completed admission", async () => {
    mocks.call.mockResolvedValue({
      followups: [{ ...item, state: "applied", error: null }],
    });
    render(<AddressedFollowups projectId="project" threadId="thread" />);
    const open = await screen.findByRole("button", {
      name: "Open continuation",
      hidden: true,
    });
    fireEvent.click(open);
    expect(mocks.navigate).toHaveBeenCalledWith("workspace", {
      subPath: "continued",
    });
    expect(
      screen.queryByRole("button", { name: "Retry", hidden: true }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cancel follow-up", hidden: true }),
    ).toBeNull();
  });
});

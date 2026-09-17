// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RunUsageWorker } from "../runtime/usage-contract.js";
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: vi.fn() }),
}));
import { usageGroups } from "./results.js";
function worker(
  effectId: string,
  inputTokens: number | null,
  cachedInputTokens: number | null = null,
): RunUsageWorker {
  return {
    effectId,
    threadId: effectId,
    name: "Reader",
    role: "Research",
    purpose: "reader",
    model: "model-a",
    providerId: "provider-a",
    inputTokens,
    outputTokens: inputTokens === null ? null : 5,
    cachedInputTokens,
    reason: null,
  };
}
describe("reported worker token totals", () => {
  it("shows unavailable fields and incomplete coverage rather than treating missing providers as zero", () => {
    expect(usageGroups([worker("one", 10, 0), worker("two", null)])).toEqual([
      {
        role: "Research",
        model: "model-a",
        providerId: "provider-a",
        workers: 2,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        missing: 1,
      },
    ]);
    expect(usageGroups([worker("none", null)])[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      missing: 1,
    });
  });
  it("keeps different models and providers separate while grouping the same role", () => {
    expect(
      usageGroups([
        worker("one", 10),
        { ...worker("two", 20), model: "model-b" },
        { ...worker("three", 30), providerId: "provider-b" },
      ]),
    ).toHaveLength(3);
  });
});

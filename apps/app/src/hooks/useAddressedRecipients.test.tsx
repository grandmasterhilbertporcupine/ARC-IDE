// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptTextMention } from "@bb/domain";
import {
  transferAddressedRecipients,
  useAddressedRecipients,
} from "./useAddressedRecipients";

const recipient = {
  pluginId: "arc",
  kind: "agent" as const,
  entityId: "builder",
  versionId: 2,
  scopeKey: "library",
  label: "Builder",
};
const input = [
  { type: "text" as const, text: "Build a preview", mentions: [] },
];

describe("persistent addressed recipients", () => {
  it("pins selection without sending and reuses an operation for failed-send retries", async () => {
    const projectId = crypto.randomUUID();
    const mentions: PromptTextMention[] = [
      {
        start: 0,
        end: 8,
        resource: {
          kind: "plugin",
          pluginId: "arc",
          itemId: "agents:builder",
          label: "Builder",
          experimental_recipient: {
            kind: "agent",
            entityId: "builder",
            versionId: 2,
            scopeKey: "library",
          },
        },
      },
    ];
    const { result, rerender } = renderHook(
      ({ ranges }) =>
        useAddressedRecipients({
          projectId,
          threadId: null,
          mentions: ranges,
          removeMention: vi.fn(),
        }),
      { initialProps: { ranges: mentions } },
    );
    expect(result.current.recipients).toEqual([recipient]);
    let first: Awaited<ReturnType<typeof result.current.forSend>>;
    await act(async () => {
      first = await result.current.forSend(input);
    });
    await act(async () => {
      expect(await result.current.forSend(input)).toEqual(first);
    });
    rerender({ ranges: [] });
    expect(result.current.recipients).toEqual([recipient]);
    act(() => {
      result.current.acknowledge(first?.operationId);
    });
    await act(async () => {
      expect((await result.current.forSend(input))?.operationId).not.toBe(
        first?.operationId,
      );
    });
  });

  it("persists a bounded digest and keeps one operation for concurrent retries", async () => {
    const projectId = crypto.randomUUID();
    transferAddressedRecipients(projectId, "large", [recipient]);
    const { result } = renderHook(() =>
      useAddressedRecipients({
        projectId,
        threadId: "large",
        mentions: [],
        removeMention: vi.fn(),
      }),
    );
    const large = [
      {
        type: "text" as const,
        text: "x".repeat(6 * 1024 * 1024),
        mentions: [],
      },
    ];
    await act(async () => {
      const [first, second] = await Promise.all([
        result.current.forSend(large),
        result.current.forSend(large),
      ]);
      expect(first).toEqual(second);
      const retained = localStorage.getItem(
        `arc.recipients.v1:${projectId}:large`,
      )!;
      expect(retained.length).toBeLessThan(1024);
      expect(JSON.parse(retained).pending.fingerprint).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const later = await result.current.forSend(input);
      result.current.acknowledge(first?.operationId);
      expect(await result.current.forSend(input)).toEqual(later);
    });
  });

  it("copies recipients to the created conversation and keeps other projects separate", () => {
    const projectId = crypto.randomUUID();
    transferAddressedRecipients(projectId, "created", [recipient]);
    const { result } = renderHook(() =>
      useAddressedRecipients({
        projectId,
        threadId: "created",
        mentions: [],
        removeMention: vi.fn(),
      }),
    );
    expect(result.current.recipients).toEqual([recipient]);
    const other = renderHook(() =>
      useAddressedRecipients({
        projectId: "other-" + projectId,
        threadId: "created",
        mentions: [],
        removeMention: vi.fn(),
      }),
    );
    expect(other.result.current.recipients).toEqual([]);
  });
});

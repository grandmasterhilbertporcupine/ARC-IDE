import { describe, expect, it } from "vitest";
import { codexVisibilityMetadata } from "./visibility.js";

describe("codex visibility raw events", () => {
  it("normalizes native warnings while retaining unknown notification methods", () => {
    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "warning",
        params: { threadId: null, message: "Skills context budget reached" },
      }),
    ).toEqual({ kind: "warning", coverage: "normalized" });
    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "future/warning",
        params: { message: "Keep this visible" },
      }),
    ).toEqual({ kind: "future/warning", coverage: "unknown" });
  });

  it("classifies Codex MCP startup status updates as noise", () => {
    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "mcpServer/startupStatus/updated",
        params: {
          name: "codex_apps",
          status: "failed",
          error: "MCP client failed to start",
        },
      }),
    ).toEqual({
      kind: "mcpServer/startupStatus/updated",
      coverage: "noise",
    });

    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "mcpServer/startupStatus/updated",
        params: {
          name: "codex_apps",
          status: "ready",
          error: null,
        },
      }),
    ).toEqual({
      kind: "mcpServer/startupStatus/updated",
      coverage: "noise",
    });
  });

  it("classifies Codex turn moderation metadata as noise", () => {
    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "turn/moderationMetadata",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          metadata: {
            prompt: {},
            generation: {},
            tool_call: {},
            tool_response: {},
          },
        },
      }),
    ).toEqual({
      kind: "turn/moderationMetadata",
      coverage: "noise",
    });
  });

  it("classifies Codex raw response completions as noise", () => {
    expect(
      codexVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: "response-1",
          usage: {
            totalTokens: 19_206,
            inputTokens: 18_971,
            cachedInputTokens: 11_008,
            cacheWriteInputTokens: 0,
            outputTokens: 235,
            reasoningOutputTokens: 53,
          },
        },
      }),
    ).toEqual({
      kind: "rawResponse/completed",
      coverage: "noise",
    });
  });
});

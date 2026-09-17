import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiVoiceTranscribeInput,
} from "@get-bb/plugin-sdk/ai-services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeCodexInference,
  transcribeCodexVoice,
} from "./openai-client.js";

const inference: ExperimentalAiInferenceCompleteInput = {
  serviceId: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "none",
  prompt: "Return a title",
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string" } },
  },
  timeoutMs: 10_000,
};
const voice: ExperimentalAiVoiceTranscribeInput = {
  serviceId: "codex",
  model: "gpt-4o-mini-transcribe",
  audioBase64: Buffer.from("audio").toString("base64"),
  mimeType: "audio/webm",
  filename: "prompt.webm",
  prompt: null,
  timeoutMs: 10_000,
};
function event(delta: string): string {
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`;
}

beforeEach(() => vi.stubEnv("OPENAI_API_KEY", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI API helpers", () => {
  it("requires an explicit API key for inference and voice without reusing Codex credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeCodexInference(inference)).rejects.toMatchObject({
      code: "auth_required",
      detailCode: "openai_api_key_required",
    });
    await expect(transcribeCodexVoice(voice)).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("streams structured responses through the public API without subscription headers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(event('{"title":"Forecast"}')));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeCodexInference(inference)).resolves.toEqual({
      ok: true,
      model: inference.model,
      value: { title: "Forecast" },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-api-key");
    expect(headers.has("chatgpt-account-id")).toBe(false);
    expect(headers.has("OpenAI-Beta")).toBe(false);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream: true,
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
  });
  it("transcribes multipart audio through the public API", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ text: "Forecast next quarter" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeCodexVoice(voice)).resolves.toEqual({
      ok: true,
      model: voice.model,
      text: "Forecast next quarter",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has("chatgpt-account-id")).toBe(false);
  });
  it("reports authentication failures and rate limits", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Invalid key" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Rate limit" } }, { status: 429 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeCodexInference(inference)).rejects.toMatchObject({
      code: "auth_required",
    });
    await expect(completeCodexInference(inference)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
  it("rejects malformed and oversized model output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(event("not JSON")))
      .mockResolvedValueOnce(new Response(event("x".repeat(2 * 1024 * 1024))));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeCodexInference(inference)).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(completeCodexInference(inference)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("times out a stalled stream after headers arrive", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-api-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(new ReadableStream<Uint8Array>())),
    );
    await expect(
      completeCodexInference({ ...inference, timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

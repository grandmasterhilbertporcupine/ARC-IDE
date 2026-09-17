import {
  contextEmbeddingInputSchema,
  contextEmbeddingStatusSchema,
  contextEmbeddingResultSchema,
  contextTokenCountResultSchema,
  type HostContextEmbeddings,
  type ContextEmbeddingFailure,
} from "@bb/host-daemon-contract";

const cancelled: ContextEmbeddingFailure = {
  code: "cancelled",
  message: "Context operation was cancelled",
};
const unavailable: ContextEmbeddingFailure = {
  code: "runtime_unavailable",
  message: "This test harness has no Context runtime",
};

export function contextEmbeddingsHarness(
  lifecycle: AbortSignal,
  runtime?: HostContextEmbeddings,
): HostContextEmbeddings {
  return {
    async status(options) {
      const signal = AbortSignal.any([lifecycle, options.signal]);
      if (signal.aborted) return { state: "unavailable", error: cancelled };
      if (!runtime) return { state: "unavailable", error: unavailable };
      const result = contextEmbeddingStatusSchema.safeParse(
        await runtime.status({ signal }),
      );
      if (!result.success)
        return {
          state: "unavailable",
          error: {
            code: "protocol_error",
            message: "The Context fixture returned invalid status",
          },
        };
      return signal.aborted &&
        !(
          result.data.state === "unavailable" &&
          result.data.error.code === "stop_unresolved"
        )
        ? { state: "unavailable", error: cancelled }
        : result.data;
    },
    async countTokens(input, options) {
      const signal = AbortSignal.any([lifecycle, options.signal]);
      if (signal.aborted) return { state: "failed", error: cancelled };
      const parsed = contextEmbeddingInputSchema.safeParse(input);
      if (!parsed.success)
        return {
          state: "failed",
          error: {
            code: "invalid_request",
            message: "Context token-count input is invalid",
          },
        };
      if (!runtime) return { state: "failed", error: unavailable };
      const result = contextTokenCountResultSchema.safeParse(
        await runtime.countTokens(parsed.data, { signal }),
      );
      if (
        !result.success ||
        (result.data.state === "completed" &&
          (result.data.requestId !== input.requestId ||
            result.data.manifestDigest !== input.expectedManifestDigest ||
            result.data.generation !== input.expectedGeneration ||
            result.data.items.length !== input.items.length ||
            result.data.items.some(
              (item, index) => item.id !== input.items[index]?.id,
            )))
      )
        return {
          state: "failed",
          error: {
            code: "protocol_error",
            message: "The Context fixture returned mismatched token counts",
          },
        };
      return signal.aborted &&
        !(
          result.data.state === "failed" &&
          result.data.error.code === "stop_unresolved"
        )
        ? { state: "failed", error: cancelled }
        : result.data;
    },
    async embed(input, options) {
      const signal = AbortSignal.any([lifecycle, options.signal]);
      if (signal.aborted) return { state: "failed", error: cancelled };
      const parsed = contextEmbeddingInputSchema.safeParse(input);
      if (!parsed.success)
        return {
          state: "failed",
          error: {
            code: "invalid_request",
            message: "Context embedding input is invalid",
          },
        };
      if (!runtime) return { state: "failed", error: unavailable };
      const result = contextEmbeddingResultSchema.safeParse(
        await runtime.embed(parsed.data, { signal }),
      );
      if (
        !result.success ||
        (result.data.state === "completed" &&
          (result.data.requestId !== input.requestId ||
            result.data.manifestDigest !== input.expectedManifestDigest ||
            result.data.generation !== input.expectedGeneration ||
            result.data.items.length !== input.items.length ||
            result.data.items.some(
              (item, index) => item.id !== input.items[index]?.id,
            )))
      )
        return {
          state: "failed",
          error: {
            code: "protocol_error",
            message: "The Context fixture returned mismatched embeddings",
          },
        };
      return signal.aborted &&
        !(
          result.data.state === "failed" &&
          result.data.error.code === "stop_unresolved"
        )
        ? { state: "failed", error: cancelled }
        : result.data;
    },
  };
}

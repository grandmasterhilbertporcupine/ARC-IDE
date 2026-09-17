import { randomUUID } from "node:crypto";
import {
  contextEmbeddingInputSchema,
  contextEmbeddingStatusSchema,
  contextEmbeddingResultSchema,
  contextTokenCountResultSchema,
  contextEmbeddingLimits,
  type HostContextEmbeddings,
  type ContextEmbeddingFailure,
} from "@bb/host-daemon-contract";
import { boundedContextMessage } from "./contract.js";
import {
  contextBridgeRequestSchema,
  contextBridgeResultSchema,
  contextBridgeCancelledSchema,
  type ContextBridgeRequest,
  type ContextBridgeResult,
} from "./bridge-contract.js";

type Pending = {
  request: ContextBridgeRequest;
  resolve: (result: ContextBridgeResult["output"]) => void;
  signal: AbortSignal;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
  failure: ContextEmbeddingFailure | null;
  cancelling: boolean;
};

export class ContextEmbeddingProxy {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly lifecycle: AbortSignal,
    private readonly send: (frame: object) => void,
  ) {}

  capability(callId: string): HostContextEmbeddings {
    return {
      status: async ({ signal }) =>
        contextEmbeddingStatusSchema.parse(
          await this.request(
            {
              type: "context.request",
              requestId: randomUUID(),
              callId,
              operation: "status",
              input: null,
            },
            signal,
          ),
        ),
      countTokens: async (input, { signal }) => {
        const parsed = contextEmbeddingInputSchema.safeParse(input);
        if (!parsed.success)
          return {
            state: "failed",
            error: {
              code: "invalid_request",
              message: "Context token-count input is invalid",
            },
          };
        return contextTokenCountResultSchema.parse(
          await this.request(
            {
              type: "context.request",
              requestId: randomUUID(),
              callId,
              operation: "countTokens",
              input: parsed.data,
            },
            signal,
          ),
        );
      },
      embed: async (input, { signal }) => {
        const parsed = contextEmbeddingInputSchema.safeParse(input);
        if (!parsed.success)
          return {
            state: "failed",
            error: {
              code: "invalid_request",
              message: "Context embedding input is invalid",
            },
          };
        return contextEmbeddingResultSchema.parse(
          await this.request(
            {
              type: "context.request",
              requestId: randomUUID(),
              callId,
              operation: "embed",
              input: parsed.data,
            },
            signal,
          ),
        );
      },
    };
  }

  receive(value: unknown): void {
    if (!boundedContextMessage(value)) return;
    const acknowledgement = contextBridgeCancelledSchema.safeParse(value);
    if (acknowledgement.success) {
      const pending = this.pending.get(acknowledgement.data.requestId);
      if (!pending || !pending.cancelling) return;
      this.finish(
        pending,
        this.failed(
          pending.request.operation,
          acknowledgement.data.error ??
            pending.failure ?? {
              code: "cancelled",
              message: "Context operation was cancelled",
            },
        ),
      );
      return;
    }
    const parsed = contextBridgeResultSchema.safeParse(value);
    const requestId =
      typeof value === "object" &&
      value !== null &&
      "requestId" in value &&
      typeof value.requestId === "string"
        ? value.requestId
        : null;
    const pending =
      requestId === null ? undefined : this.pending.get(requestId);
    if (!pending) return;
    if (
      !parsed.success ||
      pending.request.operation !== parsed.data.operation
    ) {
      pending.failure = {
        code: "protocol_error",
        message: "Context reply is invalid for the exact request",
      };
      pending.abort();
      return;
    }
    const request = pending.request;
    const result = parsed.data.output;
    if (
      request.operation !== "status" &&
      result.state === "completed" &&
      (result.requestId !== request.input.requestId ||
        result.manifestDigest !== request.input.expectedManifestDigest ||
        result.generation !== request.input.expectedGeneration ||
        result.items.length !== request.input.items.length ||
        result.items.some(
          (item, index) => item.id !== request.input.items[index]?.id,
        ))
    ) {
      pending.failure = {
        code: "protocol_error",
        message: "Context reply does not match the exact request",
      };
      pending.abort();
      return;
    }
    const output = parsed.data.output;
    if (
      pending.cancelling &&
      (output.state === "completed" || output.state === "ready")
    )
      return;
    this.finish(
      pending,
      (pending.cancelling ||
        pending.signal.aborted ||
        this.lifecycle.aborted) &&
        !("error" in output && output.error.code === "stop_unresolved")
        ? this.failed(
            pending.request.operation,
            pending.failure ?? {
              code: "cancelled",
              message: "Context operation was cancelled",
            },
          )
        : output,
    );
  }

  private finish(
    pending: Pending,
    output: ContextBridgeResult["output"],
  ): void {
    this.pending.delete(pending.request.requestId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    this.lifecycle.removeEventListener("abort", pending.abort);
    pending.resolve(output);
  }

  private failed(
    operation: ContextBridgeRequest["operation"],
    error: ContextEmbeddingFailure,
  ): ContextBridgeResult["output"] {
    return operation === "status"
      ? { state: "unavailable", error }
      : { state: "failed", error };
  }

  private request(
    request: ContextBridgeRequest,
    signal: AbortSignal,
  ): Promise<ContextBridgeResult["output"]> {
    if (
      !boundedContextMessage(request) ||
      !contextBridgeRequestSchema.safeParse(request).success
    )
      return Promise.resolve(
        this.failed(request.operation, {
          code: "invalid_request",
          message: "Context bridge request is invalid",
        }),
      );
    if (signal.aborted || this.lifecycle.aborted)
      return Promise.resolve(
        this.failed(request.operation, {
          code: "cancelled",
          message: "Context operation was cancelled before admission",
        }),
      );
    if (this.pending.size >= contextEmbeddingLimits.queuedRequests + 1)
      return Promise.resolve(
        this.failed(request.operation, {
          code: "queue_full",
          message: "Context request queue is full",
        }),
      );
    return new Promise((resolve) => {
      const abort = () => {
        const pending = this.pending.get(request.requestId);
        if (!pending || pending.cancelling) return;
        pending.cancelling = true;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
          () =>
            this.finish(
              pending,
              this.failed(request.operation, {
                code: "stop_unresolved",
                message:
                  "Context cancellation acknowledgement was not received",
              }),
            ),
          15_000,
        );
        this.send({ type: "context.cancel", requestId: request.requestId });
      };
      const timer = setTimeout(abort, 240_000);
      this.pending.set(request.requestId, {
        request,
        resolve,
        signal,
        abort,
        timer,
        failure: null,
        cancelling: false,
      });
      signal.addEventListener("abort", abort, { once: true });
      this.lifecycle.addEventListener("abort", abort, { once: true });
      this.send(request);
    });
  }
}

import { randomUUID } from "node:crypto";
import {
  contextEmbeddingFailureSchema,
  contextEmbeddingStatusSchema,
  contextEmbeddingLimits,
  type ContextEmbeddingFailure,
} from "@bb/host-daemon-contract";
import type { ContextEmbeddingClient } from "./client.js";
import { ContextRuntimeError, boundedContextMessage } from "./contract.js";
import {
  contextBridgeRequestSchema,
  contextBridgeResultSchema,
  type ContextBridgeRequest,
  type ContextBridgeResult,
} from "./bridge-contract.js";

type Client = Pick<
  ContextEmbeddingClient,
  "status" | "countTokens" | "embed" | "cancel" | "dispose"
>;
type Entry = {
  request: ContextBridgeRequest;
  privateId: string;
  cancelled: boolean;
  done: Promise<void>;
  cancel: Promise<void> | null;
};
const cancelled: ContextEmbeddingFailure = {
  code: "cancelled",
  message: "Context operation was cancelled",
};

function failure(error: unknown): ContextEmbeddingFailure {
  const parsed = contextEmbeddingFailureSchema.safeParse(
    error instanceof Error && "code" in error
      ? { code: error.code, message: error.message }
      : error,
  );
  return parsed.success
    ? parsed.data
    : {
        code: "runtime_unavailable",
        message: "The packaged Context runtime is unavailable",
      };
}

async function packagedClient(): Promise<Client> {
  const moduleUrl = new URL(
    import.meta.url.endsWith("/context/bridge.ts")
      ? "../../dist/context/client.mjs"
      : "./context/client.mjs",
    import.meta.url,
  );
  const module = (await import(moduleUrl.href)) as typeof import("./client.js");
  return new module.ContextEmbeddingClient();
}

export class ContextEmbeddingBridge {
  private readonly owners = new Map<object, Map<string, Entry>>();
  private readonly retired = new WeakSet<object>();
  private client: Promise<Client> | null = null;
  private stopping: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly createClient: () => Promise<Client> = packagedClient,
  ) {}

  has(owner: object, callId?: string): boolean {
    const requests = this.owners.get(owner);
    return (
      requests !== undefined &&
      [...requests.values()].some(
        (entry) => callId === undefined || entry.request.callId === callId,
      )
    );
  }

  handle(
    owner: object,
    value: unknown,
    send: (result: ContextBridgeResult) => void,
    settled: () => void,
  ): void {
    const parsed = boundedContextMessage(value)
      ? contextBridgeRequestSchema.safeParse(value)
      : null;
    if (!parsed?.success) return;
    const request = parsed.data;
    const respond = (error: ContextEmbeddingFailure) =>
      send(
        contextBridgeResultSchema.parse({
          type: "context.result",
          requestId: request.requestId,
          operation: request.operation,
          output: {
            state: request.operation === "status" ? "unavailable" : "failed",
            error,
          },
        }),
      );
    if (this.closed || this.retired.has(owner))
      return respond({
        code: "disposed",
        message: "The requesting plugin generation has retired",
      });
    const requests = this.owners.get(owner) ?? new Map<string, Entry>();
    if (requests.has(request.requestId)) return;
    if (
      [...this.owners.values()].reduce(
        (sum, entries) => sum + entries.size,
        0,
      ) >=
      contextEmbeddingLimits.queuedRequests + 1
    )
      return respond({
        code: "queue_full",
        message: "The shared Context queue is full",
      });
    const entry: Entry = {
      request,
      privateId: randomUUID(),
      cancelled: false,
      done: Promise.resolve(),
      cancel: null,
    };
    requests.set(request.requestId, entry);
    this.owners.set(owner, requests);
    entry.done = Promise.resolve()
      .then(async () => {
        const client = await this.getClient(request.operation);
        if (entry.cancelled)
          throw new ContextRuntimeError(cancelled.code, cancelled.message);
        if (request.operation === "status") {
          const result = await client.status();
          if (entry.cancel) await entry.cancel;
          if (entry.cancelled || this.retired.has(owner))
            return respond(cancelled);
          const output =
            result.state === "ready"
              ? {
                  state: "ready",
                  generation: result.generation,
                  descriptor: result.descriptor,
                }
              : result;
          send(
            contextBridgeResultSchema.parse({
              type: "context.result",
              requestId: request.requestId,
              operation: "status",
              output: contextEmbeddingStatusSchema.parse(output),
            }),
          );
        } else {
          const input = { ...request.input, requestId: entry.privateId };
          const output = await (request.operation === "embed"
            ? client.embed(input)
            : client.countTokens(input));
          if (entry.cancel) await entry.cancel;
          if (entry.cancelled || this.retired.has(owner))
            return respond(cancelled);
          send(
            contextBridgeResultSchema.parse({
              type: "context.result",
              requestId: request.requestId,
              operation: request.operation,
              output: {
                ...output,
                requestId: request.input.requestId,
                state: "completed",
              },
            }),
          );
        }
      })
      .catch(async (error: unknown) => {
        const original = failure(error);
        try {
          if (entry.cancel) await entry.cancel;
        } catch (stopError) {
          return respond(
            original.code === "stop_unresolved" ? original : failure(stopError),
          );
        }
        respond(
          original.code === "stop_unresolved"
            ? original
            : entry.cancelled
              ? cancelled
              : original,
        );
      })
      .finally(() => {
        requests.delete(request.requestId);
        if (requests.size === 0) this.owners.delete(owner);
        settled();
      });
  }

  async cancel(
    owner: object,
    requestId: string,
  ): Promise<{ state: "cancelled" | "absent" }> {
    const entry = this.owners.get(owner)?.get(requestId);
    if (!entry) return { state: "absent" };
    entry.cancelled = true;
    entry.cancel ??= (async () => {
      const client = await this.client;
      if (!client) return;
      if (entry.request.operation === "status") await this.reset(client);
      else await client.cancel(entry.privateId);
    })();
    await entry.cancel;
    await entry.done;
    return { state: "cancelled" };
  }

  async cancelCall(owner: object, callId: string): Promise<void> {
    await Promise.all(
      [...(this.owners.get(owner)?.values() ?? [])]
        .filter((entry) => entry.request.callId === callId)
        .map((entry) => this.cancel(owner, entry.request.requestId)),
    );
  }

  async retire(owner: object): Promise<void> {
    this.retired.add(owner);
    await Promise.all(
      [...(this.owners.get(owner)?.keys() ?? [])].map((requestId) =>
        this.cancel(owner, requestId),
      ),
    );
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.owners.keys()].map((owner) => this.retire(owner)),
    );
    const client = await this.client;
    if (client) await this.reset(client);
  }

  private async getClient(
    operation: ContextBridgeRequest["operation"],
  ): Promise<Client> {
    if (this.stopping)
      throw new ContextRuntimeError(
        operation === "status" ? "stop_unresolved" : "worker_stopped",
        operation === "status"
          ? "The previous Context helper has not finished stopping"
          : "Context request was not admitted while the helper was resetting",
      );
    this.client ??= this.createClient().catch((error: unknown) => {
      this.client = null;
      throw error;
    });
    return this.client;
  }

  private reset(client: Client): Promise<void> {
    this.stopping ??= client.dispose().then(() => {
      this.client = null;
      this.stopping = null;
    });
    return this.stopping;
  }
}

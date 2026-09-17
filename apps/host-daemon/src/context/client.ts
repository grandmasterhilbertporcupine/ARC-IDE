import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  contextEmbeddingOutputSchema,
  contextTokenCountOutputSchema,
  type ContextEmbeddingOutput,
  type ContextTokenCountOutput,
} from "@bb/host-daemon-contract";
import {
  boundedContextMessage,
  CONTEXT_LIMITS,
  contextEmbedInputSchema,
  contextRequestSchema,
  contextResponseSchema,
  ContextRuntimeError,
  type ContextEmbedInput,
  type ContextRequest,
  type ContextResponse,
  type ContextStatus,
} from "./contract.js";

type Ready = Extract<ContextStatus, { state: "ready" }>;
type Pending = {
  resolve: (response: ContextResponse) => void;
  reject: (error: ContextRuntimeError) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Worker = {
  child: ChildProcess;
  generation: string;
  exited: Promise<void>;
  exitObserved: boolean;
  stopping: Promise<void> | null;
  pending: Map<string, Pending>;
  ready: Promise<Ready>;
};
type Job = {
  kind: "embed" | "countTokens";
  input: ContextEmbedInput;
  resolve: (result: ContextEmbeddingOutput | ContextTokenCountOutput) => void;
  reject: (error: ContextRuntimeError) => void;
  cancelled: ContextRuntimeError | null;
};

function runtimeError(error: unknown): ContextRuntimeError {
  return error instanceof ContextRuntimeError
    ? error
    : new ContextRuntimeError(
        "runtime_unavailable",
        "The local Context runtime is unavailable",
      );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "PATH",
  ]) {
    const entry = Object.entries(process.env).find(
      ([key]) => key.toUpperCase() === name.toUpperCase(),
    );
    if (entry) env[name] = entry[1];
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.OMP_NUM_THREADS = "2";
  env.ORT_LOG_SEVERITY_LEVEL = "3";
  return env;
}

export class ContextEmbeddingClient {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private active: Job | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  async status(): Promise<ContextStatus> {
    try {
      this.assertAvailable();
      return await this.getWorker().ready;
    } catch (error) {
      const failure = runtimeError(error);
      return {
        state: "unavailable",
        error: { code: failure.code, message: failure.message },
      };
    }
  }

  async embed(input: ContextEmbedInput): Promise<ContextEmbeddingOutput> {
    return contextEmbeddingOutputSchema.parse(
      await this.enqueue(input, "embed"),
    );
  }

  async countTokens(
    input: ContextEmbedInput,
  ): Promise<ContextTokenCountOutput> {
    return contextTokenCountOutputSchema.parse(
      await this.enqueue(input, "countTokens"),
    );
  }

  private enqueue(
    input: ContextEmbedInput,
    kind: Job["kind"],
  ): Promise<ContextEmbeddingOutput | ContextTokenCountOutput> {
    try {
      const parsed = contextEmbedInputSchema.safeParse(input);
      if (!parsed.success || !boundedContextMessage(input))
        throw new ContextRuntimeError(
          "invalid_request",
          "Context input does not match the bounded embedding contract",
        );
      this.requireWorker(parsed.data.expectedGeneration);
      if (
        this.active?.input.requestId === input.requestId ||
        this.queue.some((job) => job.input.requestId === input.requestId)
      )
        throw new ContextRuntimeError(
          "invalid_request",
          "Context request ID is already pending",
        );
      if (this.queue.length >= CONTEXT_LIMITS.queuedRequests)
        throw new ContextRuntimeError(
          "queue_full",
          "Context embedding queue is full",
        );
      return new Promise((resolve, reject) => {
        this.queue.push({
          kind,
          input: parsed.data,
          resolve,
          reject,
          cancelled: null,
        });
        this.pump();
      });
    } catch (error) {
      return Promise.reject(runtimeError(error));
    }
  }

  async cancel(requestId: string): Promise<{ state: "cancelled" | "absent" }> {
    const queued = this.queue.findIndex(
      (job) => job.input.requestId === requestId,
    );
    if (queued >= 0) {
      this.queue
        .splice(queued, 1)[0]!
        .reject(
          new ContextRuntimeError(
            "cancelled",
            "Queued Context request was cancelled",
          ),
        );
      return { state: "cancelled" };
    }
    if (this.active?.input.requestId !== requestId) return { state: "absent" };
    this.active.cancelled = new ContextRuntimeError(
      "cancelled",
      "Active Context request was cancelled",
    );
    const worker = this.worker;
    if (worker)
      await this.stop(
        worker,
        new ContextRuntimeError(
          "cancelled",
          "Active Context request was cancelled",
        ),
      );
    return { state: "cancelled" };
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const failure = new ContextRuntimeError(
      "disposed",
      "Context client has been disposed",
    );
    if (this.active) this.active.cancelled = failure;
    for (const job of this.queue.splice(0)) job.reject(failure);
    this.disposal = this.worker
      ? this.stop(this.worker, failure, true)
      : Promise.resolve();
    return this.disposal;
  }

  private assertAvailable(): void {
    if (this.disposed)
      throw new ContextRuntimeError(
        "disposed",
        "Context client has been disposed",
      );
    if (this.worker?.stopping && !this.worker.exitObserved)
      throw new ContextRuntimeError(
        "stop_unresolved",
        "The previous Context child has not exited",
      );
  }

  private getWorker(): Worker {
    this.assertAvailable();
    if (this.worker) return this.worker;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./worker.mjs", import.meta.url))],
      {
        env: childEnvironment(),
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        serialization: "json",
      },
    );
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const generation = randomUUID();
    const worker: Worker = {
      child,
      generation,
      exited,
      exitObserved: false,
      stopping: null,
      pending: new Map(),
      ready: Promise.resolve()
        .then(async (): Promise<Ready> => {
          const response = await this.invoke(
            worker,
            {
              schemaVersion: 3,
              generation,
              requestId: randomUUID(),
              type: "initialize",
            },
            CONTEXT_LIMITS.initializeMs,
          );
          if (response.type !== "ready" || response.process.pid !== child.pid)
            throw new ContextRuntimeError(
              "protocol_error",
              "Context initialization did not return the owned child identity",
            );
          return {
            state: "ready",
            generation,
            descriptor: response.descriptor,
            process: response.process,
          };
        })
        .catch(async (error: unknown) => {
          const failure = runtimeError(error);
          await this.stop(worker, failure);
          throw failure;
        }),
    };
    this.worker = worker;
    child.on("message", (value: unknown) => {
      if (worker.exitObserved || worker.stopping) return;
      const parsed = boundedContextMessage(value)
        ? contextResponseSchema.safeParse(value)
        : null;
      if (!parsed?.success || parsed.data.generation !== generation) {
        void this.stop(
          worker,
          new ContextRuntimeError(
            "protocol_error",
            "Context child returned an invalid message",
          ),
        ).catch(() => {});
        return;
      }
      const response = parsed.data;
      const pending = worker.pending.get(response.requestId);
      if (!pending) return;
      worker.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.type === "error")
        pending.reject(
          new ContextRuntimeError(response.error.code, response.error.message),
        );
      else pending.resolve(response);
    });
    const observeExit = () => {
      if (worker.exitObserved) return;
      worker.exitObserved = true;
      exit();
      if (this.worker === worker) this.worker = null;
      if (!worker.stopping) {
        this.rejectPending(
          worker,
          new ContextRuntimeError(
            "worker_exit",
            "Context child exited before completing its request",
          ),
        );
        for (const job of this.queue.splice(0))
          job.reject(
            new ContextRuntimeError(
              "worker_stopped",
              "Context child exited; queued work was not retried",
            ),
          );
      }
    };
    child.once("exit", observeExit);
    child.once("error", () => {
      if (child.pid === undefined) observeExit();
      else
        void this.stop(
          worker,
          new ContextRuntimeError(
            "worker_exit",
            "Context child process failed",
          ),
        ).catch(() => {});
    });
    return worker;
  }

  private requireWorker(expectedGeneration: string): Worker {
    if (this.disposed)
      throw new ContextRuntimeError(
        "disposed",
        "Context client has been disposed",
      );
    const worker = this.worker;
    if (
      !worker ||
      worker.generation !== expectedGeneration ||
      worker.exitObserved
    )
      throw new ContextRuntimeError(
        "worker_stopped",
        "Context request targets a helper generation that is no longer available",
      );
    if (worker.stopping)
      throw new ContextRuntimeError(
        "stop_unresolved",
        "The expected Context helper has not exited",
      );
    return worker;
  }

  private invoke(
    worker: Worker,
    request: ContextRequest,
    timeoutMs: number,
  ): Promise<ContextResponse> {
    if (worker.exitObserved || worker.stopping)
      return Promise.reject(
        new ContextRuntimeError(
          "worker_stopped",
          "Context child is no longer available",
        ),
      );
    contextRequestSchema.parse(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.stop(
          worker,
          new ContextRuntimeError(
            "worker_timeout",
            "Context child did not complete within its bounded request time",
          ),
        ).catch(reject);
      }, timeoutMs);
      worker.pending.set(request.requestId, { resolve, reject, timer });
      worker.child.send(request, (error) => {
        if (error)
          void this.stop(
            worker,
            new ContextRuntimeError(
              "worker_exit",
              "Context child did not accept its request",
            ),
          ).catch(reject);
      });
    });
  }

  private rejectPending(worker: Worker, failure: ContextRuntimeError): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    worker.pending.clear();
  }

  private stop(
    worker: Worker,
    failure: ContextRuntimeError,
    graceful = false,
  ): Promise<void> {
    if (worker.stopping) return worker.stopping;
    worker.stopping = (async () => {
      for (const job of this.queue.splice(0))
        job.reject(
          new ContextRuntimeError(
            "worker_stopped",
            "Context child is stopping; queued work was not retried",
          ),
        );
      if (!worker.exitObserved) {
        if (graceful && !this.active && worker.child.connected) {
          worker.child.send(
            {
              schemaVersion: 3,
              generation: worker.generation,
              requestId: randomUUID(),
              type: "dispose",
            },
            () => {},
          );
        } else worker.child.kill("SIGKILL");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const didExit = await Promise.race([
          worker.exited.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), CONTEXT_LIMITS.stopMs);
          }),
        ]);
        clearTimeout(timer);
        if (!didExit && graceful) {
          worker.child.kill("SIGKILL");
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const killed = await Promise.race([
            worker.exited.then(() => true),
            new Promise<false>((resolve) => {
              killTimer = setTimeout(
                () => resolve(false),
                CONTEXT_LIMITS.stopMs,
              );
            }),
          ]);
          clearTimeout(killTimer);
          if (!killed)
            throw new ContextRuntimeError(
              "stop_unresolved",
              "Context child exit has not been observed after shutdown",
            );
        } else if (!didExit)
          throw new ContextRuntimeError(
            "stop_unresolved",
            "Context child exit has not been observed after cancellation",
          );
      }
      this.rejectPending(worker, failure);
      if (this.worker === worker) this.worker = null;
    })().catch((error: unknown) => {
      const failure = runtimeError(error);
      this.rejectPending(worker, failure);
      throw failure;
    });
    return worker.stopping;
  }

  private pump(): void {
    if (this.active || this.disposed || this.worker?.stopping) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void (async () => {
      const worker = this.requireWorker(job.input.expectedGeneration);
      const ready = await worker.ready;
      if (job.cancelled) {
        await worker.stopping;
        throw job.cancelled;
      }
      this.requireWorker(job.input.expectedGeneration);
      if (ready.descriptor.manifestDigest !== job.input.expectedManifestDigest)
        throw new ContextRuntimeError(
          "manifest_mismatch",
          "Context input targets a different verified manifest",
        );
      const response = await this.invoke(
        worker,
        {
          schemaVersion: 3,
          generation: worker.generation,
          requestId: randomUUID(),
          type: job.kind,
          expectedManifestDigest: job.input.expectedManifestDigest,
          expectedGeneration: job.input.expectedGeneration,
          items: job.input.items,
        },
        CONTEXT_LIMITS.requestMs,
      );
      if (job.cancelled) {
        await worker.stopping;
        throw job.cancelled;
      }
      if (
        (response.type !== "embedded" && response.type !== "counted") ||
        (job.kind === "embed"
          ? response.type !== "embedded"
          : response.type !== "counted") ||
        response.manifestDigest !== job.input.expectedManifestDigest ||
        response.items.length !== job.input.items.length ||
        response.items.some(
          (item, index) => item.id !== job.input.items[index]!.id,
        )
      ) {
        const failure = new ContextRuntimeError(
          "protocol_error",
          "Context result does not match its exact request",
        );
        await this.stop(worker, failure);
        throw failure;
      }
      job.resolve({
        generation: worker.generation,
        requestId: job.input.requestId,
        manifestDigest: response.manifestDigest,
        items: response.items,
      });
    })()
      .catch((error: unknown) => {
        const failure = runtimeError(error);
        job.reject(
          failure.code === "stop_unresolved"
            ? failure
            : (job.cancelled ?? failure),
        );
      })
      .finally(() => {
        if (this.active === job) this.active = null;
        this.pump();
      });
  }
}

export { ContextRuntimeError } from "./contract.js";

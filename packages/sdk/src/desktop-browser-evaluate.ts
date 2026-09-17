import { WebSocket } from "ws";
import { z } from "zod";
import type { ExperimentalDesktopBrowserConnection } from "@bb/server-contract";

const targetSchema = z.object({
  targetId: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
});
export type ExperimentalDesktopBrowserTargetInfo = z.infer<typeof targetSchema>;
const responseSchema = z.object({
  id: z.number().optional(),
  result: z.record(z.string(), z.json()).optional(),
  error: z.object({ message: z.string() }).optional(),
});

async function withConnection<T>(
  connection: ExperimentalDesktopBrowserConnection,
  timeoutMs: number,
  run: (
    send: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(connection.wsEndpoint);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error(
      "Browser control requires its private loopback connection on the selected browser host",
    );
  if (connection.expiresAt <= Date.now())
    throw new Error(
      "Browser connection expired; request a new connection for the current lease",
    );
  const socket = new WebSocket(endpoint, { maxPayload: 1_048_576 });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  socket.on("message", (raw) => {
    try {
      const response = responseSchema.parse(JSON.parse(raw.toString()));
      if (response.id === undefined) return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result ?? {});
    } catch {
      fail(new Error("Invalid browser control response"));
    }
  });
  socket.on("error", () =>
    fail(
      new Error(
        "Browser control connection failed. Run this operation on the browser host.",
      ),
    ),
  );
  socket.on("close", () =>
    fail(new Error("Browser control ended or was taken over")),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("Browser operation timed out");
        fail(error);
        socket.terminate();
        reject(error);
      }, timeoutMs);
    });
    const result = (async () => {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", () =>
          reject(
            new Error(
              "Browser control connection failed. Run this operation on the browser host.",
            ),
          ),
        );
      });
      return run(
        (method, params, sessionId) =>
          new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            socket.send(
              JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
              }),
              (error) => {
                if (error) {
                  pending.delete(id);
                  reject(new Error("Browser control send failed"));
                }
              },
            );
          }),
      );
    })();
    return await Promise.race([result, expired]);
  } finally {
    clearTimeout(timeout);
    fail(new Error("Browser operation completed"));
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else socket.terminate();
  }
}

export async function experimental_listDesktopBrowserTargets(
  connection: ExperimentalDesktopBrowserConnection,
): Promise<ExperimentalDesktopBrowserTargetInfo[]> {
  return withConnection(connection, 10_000, async (send) =>
    z
      .object({ targetInfos: z.array(targetSchema) })
      .parse(await send("Target.getTargets", {}))
      .targetInfos.filter((target) => target.type === "page"),
  );
}

export async function experimental_evaluateDesktopBrowser(input: {
  connection: ExperimentalDesktopBrowserConnection;
  expression: string;
  targetId?: string;
  timeoutMs?: number;
}): Promise<unknown> {
  if (!input.expression.trim() || input.expression.length > 20_000)
    throw new Error("Browser expression must contain 1–20000 characters");
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000)
    throw new Error(
      "Browser timeout must be between 1000 and 30000 milliseconds",
    );
  return withConnection(input.connection, timeoutMs + 1000, async (send) => {
    const targets = z
      .object({ targetInfos: z.array(targetSchema) })
      .parse(await send("Target.getTargets", {}))
      .targetInfos.filter((target) => target.type === "page");
    const target = input.targetId
      ? targets.find((entry) => entry.targetId === input.targetId)
      : targets.length === 1
        ? targets[0]
        : undefined;
    if (!target)
      throw new Error(
        "Choose one target ID from browser targets; the selected target must belong to this lease",
      );
    const { sessionId } = z.object({ sessionId: z.string() }).parse(
      await send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      }),
    );
    const result = z
      .object({
        result: z.object({
          value: z.json().optional(),
          description: z.string().optional(),
          subtype: z.string().optional(),
        }),
        exceptionDetails: z.unknown().optional(),
      })
      .parse(
        await send(
          "Runtime.evaluate",
          {
            expression: input.expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: timeoutMs,
          },
          sessionId,
        ),
      );
    if (
      result.exceptionDetails !== undefined ||
      result.result.subtype === "error"
    )
      throw new Error(
        `Browser evaluation failed: ${(result.result.description ?? "page script threw").slice(0, 1000)}`,
      );
    const value = result.result.value ?? null;
    if (JSON.stringify(value).length > 64_000)
      throw new Error(
        "Browser result exceeded 64000 characters; narrow the inspection",
      );
    return value;
  });
}

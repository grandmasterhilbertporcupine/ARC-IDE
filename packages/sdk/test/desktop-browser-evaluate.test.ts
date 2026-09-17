import { once } from "node:events";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  experimental_evaluateDesktopBrowser,
  experimental_listDesktopBrowserTargets,
} from "../src/desktop-browser-evaluate.js";

async function fixture(
  run: (
    connection: { hostId: string; wsEndpoint: string; expiresAt: number },
    messages: Array<{ method: string; sessionId?: string }>,
  ) => Promise<void>,
  options: { pages?: number; value?: unknown; closeOnEvaluate?: boolean } = {},
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing socket address");
  const messages: Array<{ method: string; sessionId?: string }> = [];
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const command = z
        .object({
          id: z.number(),
          method: z.string(),
          sessionId: z.string().optional(),
        })
        .parse(JSON.parse(raw.toString()));
      messages.push(command);
      if (command.method === "Runtime.evaluate" && options.closeOnEvaluate) {
        socket.close();
        return;
      }
      const result =
        command.method === "Target.getTargets"
          ? {
              targetInfos: Array.from(
                { length: options.pages ?? 1 },
                (_, i) => ({
                  targetId: `page-${i}`,
                  type: "page",
                  title: "Preview",
                  url: "http://localhost:5173/",
                }),
              ),
            }
          : command.method === "Target.attachToTarget"
            ? { sessionId: "scoped-session" }
            : { result: { value: options.value ?? { heading: "Hello" } } };
      socket.send(JSON.stringify({ id: command.id, result }));
    }),
  );
  try {
    await run(
      {
        hostId: "host",
        wsEndpoint: `ws://127.0.0.1:${address.port}/private-credential`,
        expiresAt: Date.now() + 60_000,
      },
      messages,
    );
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("native desktop browser evaluation", () => {
  it("discovers scoped targets and evaluates only after a flattened attachment", async () => {
    await fixture(async (connection, messages) => {
      expect(
        await experimental_listDesktopBrowserTargets(connection),
      ).toHaveLength(1);
      expect(
        await experimental_evaluateDesktopBrowser({
          connection,
          expression: "({heading: document.querySelector('h1').textContent})",
        }),
      ).toEqual({ heading: "Hello" });
      expect(messages.at(-1)).toMatchObject({
        method: "Runtime.evaluate",
        sessionId: "scoped-session",
      });
    });
  });
  it("refuses to infer a tab when multiple pages are leased", async () => {
    await fixture(
      async (connection, messages) => {
        await expect(
          experimental_evaluateDesktopBrowser({
            connection,
            expression: "document.title",
          }),
        ).rejects.toThrow("Choose one target");
        expect(
          messages.some((message) => message.method === "Runtime.evaluate"),
        ).toBe(false);
        await expect(
          experimental_evaluateDesktopBrowser({
            connection,
            expression: "document.title",
            targetId: "page-1",
          }),
        ).resolves.toBeDefined();
      },
      { pages: 2 },
    );
  });
  it("fails when takeover closes the leased connection and rejects oversized output", async () => {
    await fixture(
      async (connection) => {
        await expect(
          experimental_evaluateDesktopBrowser({
            connection,
            expression: "document.title",
          }),
        ).rejects.toThrow("taken over");
      },
      { closeOnEvaluate: true },
    );
    await fixture(
      async (connection) => {
        await expect(
          experimental_evaluateDesktopBrowser({
            connection,
            expression: "document.body.innerText",
          }),
        ).rejects.toThrow("exceeded");
      },
      { value: "x".repeat(64_001) },
    );
  });
  it("rejects arbitrary remote endpoints, expired connections and excessive execution budgets", async () => {
    const connection = {
      hostId: "host",
      wsEndpoint: "ws://example.test/private",
      expiresAt: Date.now() + 60_000,
    };
    await expect(
      experimental_evaluateDesktopBrowser({ connection, expression: "1" }),
    ).rejects.toThrow("loopback");
    await expect(
      experimental_evaluateDesktopBrowser({
        connection: {
          ...connection,
          wsEndpoint: "ws://127.0.0.1:1/private",
          expiresAt: 1,
        },
        expression: "1",
      }),
    ).rejects.toThrow("expired");
    await expect(
      experimental_evaluateDesktopBrowser({
        connection,
        expression: "1",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("30000");
  });
});

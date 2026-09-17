import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { seedHostSession, seedPrimaryHost } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const leaseSchema = z.object({ baseUrl: z.string(), expiresAtMs: z.number() });
const pathPolicy = {
  denyDotfiles: true,
  deniedExtensions: [
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".p8",
    ".jks",
    ".keystore",
  ],
};

function post(body: object, origin?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe("file preview capability boundary", () => {
  it("grants credentialless GET and HEAD only after a contained successful asset read", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const commands: string[] = [];
      const types = [
        ["index.html", "text/html"],
        ["classic.js", "application/javascript"],
        ["modules/main.mjs", "text/javascript"],
        ["modules/nested/dynamic.mjs", "text/javascript"],
        ["data.json", "application/json"],
        ["styles/theme.css", "text/css"],
        ["images/logo.svg", "image/svg+xml"],
        ["images/photo.png", "image/png"],
        ["fonts/font.woff2", "font/woff2"],
        ["document.xhtml", "application/xhtml+xml"],
        ["document.xml", "application/xml"],
        ["document.pdf", "application/pdf"],
        ["unknown.arc-document", "application/x-arc-document"],
      ];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.read_file")
            throw new Error(request.command.type);
          expect(request.command.rootPath).toBe("C:\\Owned Preview");
          expect(request.command.pathPolicy).toEqual(pathPolicy);
          commands.push(request.command.path);
          const name = request.command.path
            .slice("C:\\Owned Preview\\".length)
            .replaceAll("\\", "/");
          const mimeType = types.find(([file]) => file === name)?.[1];
          if (!mimeType)
            return {
              ok: false,
              errorCode: "ENOENT",
              errorMessage: "Owned fixture absent",
            };
          return {
            ok: true,
            result: {
              path: request.command.path,
              content: "asset",
              contentEncoding: "utf8",
              mimeType,
              sizeBytes: 5,
              sha256: "owned",
            },
          };
        },
      });
      const created = await harness.app.request(
        "/api/v1/files/previews",
        post({ rootPath: "C:\\Owned Preview" }),
      );
      expect(created.status).toBe(200);
      const lease = leaseSchema.parse(await created.json());
      for (const [name, mimeType] of types) {
        for (const method of ["GET", "HEAD"]) {
          const response = await harness.app.request(
            `${lease.baseUrl}/${name}`,
            { method, headers: { origin: "null" } },
          );
          expect(response.status, `${method} ${name}`).toBe(200);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(response.headers.has("access-control-allow-credentials")).toBe(
            false,
          );
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
          if (mimeType === "text/html" || mimeType?.includes("xml"))
            expect(response.headers.get("content-security-policy")).toBe(
              "sandbox allow-scripts",
            );
          if (name === "unknown.arc-document")
            expect(response.headers.get("content-disposition")).toBe(
              "attachment",
            );
          if (method === "HEAD") expect(await response.text()).toBe("");
          else expect(await response.text()).toBe("asset");
        }
      }
      const allowed = await harness.app.request(`${lease.baseUrl}/data.json`, {
        headers: { origin: "https://project-preview.example" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("*");
      const beforeInvalid = commands.length;
      for (const name of [
        ".env",
        "nested/.git/config",
        "%2eenv",
        "%252eenv",
        "assets%2F..%2Foutside.txt",
        "assets%5C..%5Coutside.txt",
        "client.KEY",
        "client.PEM",
        "client.p12",
        "client.pfx",
        "client.jks",
        "client.key%20",
        "client.key%2e",
        "file.txt%3Aprivate",
        "file.txt%3A%3A$DATA",
        "file%00.txt",
      ]) {
        const response = await harness.app.request(`${lease.baseUrl}/${name}`, {
          headers: { origin: "null" },
        });
        expect(response.status, name).toBeGreaterThanOrEqual(400);
        expect(response.status, name).toBeLessThan(500);
        expect(response.headers.has("access-control-allow-origin"), name).toBe(
          false,
        );
      }
      expect(commands).toHaveLength(beforeInvalid);
      const credentialedHeaders: Record<string, string>[] = [
        { origin: "null", cookie: "owned=credential" },
        {
          origin: "https://foreign.example",
          authorization: "Bearer owned-test-value",
        },
      ];
      for (const headers of credentialedHeaders) {
        const response = await harness.app.request(
          `${lease.baseUrl}/data.json`,
          { headers },
        );
        expect(response.status).toBe(403);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
      expect(commands).toHaveLength(beforeInvalid);
      const missing = await harness.app.request(
        `${lease.baseUrl}/missing.json`,
        { headers: { origin: "null" } },
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.has("access-control-allow-origin")).toBe(false);
      const invalidLease = await harness.app.request(
        "/api/v1/file-previews/not-a-lease/data.json",
        { headers: { origin: "null" } },
      );
      expect(invalidLease.status).toBe(404);
      expect(invalidLease.headers.has("access-control-allow-origin")).toBe(
        false,
      );
    });
  });

  it("does not extend the capability to creation, renewal, ARC reads, writes or preflights", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const created = await harness.app.request(
        "/api/v1/files/previews",
        post({ rootPath: "/owned" }),
      );
      const lease = leaseSchema.parse(await created.json());
      for (const [url, body] of [
        ["/api/v1/files/previews", { rootPath: "/outside" }],
        [`${lease.baseUrl}/refresh`, {}],
        ["/api/v1/files/read", { path: "/outside/sentinel" }],
        [
          "/api/v1/files/write",
          { path: "/outside/sentinel", content: "changed" },
        ],
        [`${lease.baseUrl}/data.json`, {}],
      ] as const) {
        const response = await harness.app.request(url, post(body, "null"));
        expect(response.status, url).toBe(403);
        expect(response.headers.has("access-control-allow-origin"), url).toBe(
          false,
        );
        const preflight = await harness.app.request(url, {
          method: "OPTIONS",
          headers: {
            origin: "null",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        });
        expect(preflight.headers.has("access-control-allow-origin"), url).toBe(
          false,
        );
      }
      const invalidJson = await harness.app.request("/api/v1/files/previews", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ rootPath: "/outside" }),
      });
      expect(invalidJson.status).toBe(415);
      const threads = await harness.app.request("/api/v1/threads", {
        headers: { origin: "null" },
      });
      expect(threads.status).toBe(403);
      expect(threads.headers.has("access-control-allow-origin")).toBe(false);
      const renewed = await harness.app.request(
        `${lease.baseUrl}/refresh`,
        post({}),
      );
      expect(renewed.status).toBe(200);
    });
  });

  it("rejects expired leases before host access and rechecks expiry after an in-flight read", async () => {
    const RealDate = Date;
    let now = Date.now();
    vi.stubGlobal(
      "Date",
      class extends RealDate {
        static now() {
          return now;
        }
      },
    );
    try {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        seedPrimaryHost(harness.deps, host.id);
        let reads = 0;
        registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => {
            reads += 1;
            now += 60_001;
            return {
              ok: true,
              result: {
                path: "/owned/data.json",
                content: "{}",
                contentEncoding: "utf8",
                mimeType: "application/json",
                sizeBytes: 2,
                sha256: "owned",
              },
            };
          },
        });
        const created = await harness.app.request(
          "/api/v1/files/previews",
          post({ rootPath: "/owned", ttlMs: 60_000 }),
        );
        const lease = leaseSchema.parse(await created.json());
        const inFlight = await harness.app.request(
          `${lease.baseUrl}/data.json`,
          { headers: { origin: "null" } },
        );
        expect(inFlight.status).toBe(404);
        expect(inFlight.headers.has("access-control-allow-origin")).toBe(false);
        expect(reads).toBe(1);
        const expired = await harness.app.request(
          `${lease.baseUrl}/data.json`,
          { headers: { origin: "null" } },
        );
        expect(expired.status).toBe(404);
        expect(expired.headers.has("access-control-allow-origin")).toBe(false);
        expect(reads).toBe(1);
        const refresh = await harness.app.request(
          `${lease.baseUrl}/refresh`,
          post({}),
        );
        expect(refresh.status).toBe(404);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

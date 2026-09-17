import { uploadedPromptAttachmentSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("untrusted raw document routes", () => {
  it("preserves the selected project's host path family independently of the server platform", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const expectedPaths = new Map<string, string>();
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          const command = request.command;
          if (command.type !== "host.read_file") throw new Error(command.type);
          expect(command.path).toBe(expectedPaths.get(command.rootPath ?? ""));
          return {
            ok: true,
            result: {
              path: command.path,
              content: "<svg/>",
              contentEncoding: "utf8",
              mimeType: "image/svg+xml",
              sizeBytes: 6,
              sha256: "owned-document",
            },
          };
        },
      });
      for (const { root, separator } of [
        { root: "/owned project", separator: "/" },
        { root: "D:\\Owned Project", separator: "\\" },
        { root: "\\\\host\\share\\owned project", separator: "\\" },
      ]) {
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: root,
        });
        expectedPaths.set(
          root,
          `${root}${separator}nested${separator}document.svg`,
        );
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/files/content?path=nested%2Fdocument.svg`,
        );
        expect(
          response.status,
          `${root}: ${await response.clone().text()}`,
        ).toBe(200);
        expect(response.headers.get("content-security-policy")).toBe(
          "sandbox allow-scripts",
        );
      }
    });
  });

  it("sandboxes project, thread and attachment documents on fresh and conditional reads", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/owned",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/owned",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const documents = [
        {
          filename: "document.html",
          mimeType: "text/html",
          content:
            "<!doctype html><script>globalThis.documentRan=true</script>",
        },
        {
          filename: "document.svg",
          mimeType: "image/svg+xml",
          content:
            '<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.documentRan=true</script></svg>',
        },
        {
          filename: "document.xhtml",
          mimeType: "application/xhtml+xml",
          content:
            '<html xmlns="http://www.w3.org/1999/xhtml"><script>globalThis.documentRan=true</script></html>',
        },
        {
          filename: "document.xml",
          mimeType: "application/xml",
          content:
            '<html xmlns="http://www.w3.org/1999/xhtml"><script>globalThis.documentRan=true</script></html>',
        },
      ];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          const command = request.command;
          if (command.type !== "host.read_file") throw new Error(command.type);
          const document = documents.find(({ filename }) =>
            command.path.endsWith(`/${filename}`),
          );
          if (!document) throw new Error(`Unexpected path ${command.path}`);
          return {
            ok: true,
            result: {
              path: command.path,
              content: document.content,
              contentEncoding: "utf8",
              mimeType: document.mimeType,
              sizeBytes: Buffer.byteLength(document.content),
              sha256: "owned-document",
            },
          };
        },
      });
      for (const document of documents) {
        const form = new FormData();
        form.set(
          "file",
          new File([document.content], document.filename, {
            type: document.mimeType,
          }),
        );
        const upload = await harness.app.request(
          `/api/v1/projects/${project.id}/attachments`,
          { method: "POST", body: form },
        );
        expect(upload.status, document.filename).toBe(201);
        const attachment = uploadedPromptAttachmentSchema.parse(
          await upload.json(),
        );
        const urls = [
          `/api/v1/projects/${project.id}/files/content?path=${document.filename}`,
          `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(`/owned/${document.filename}`)}`,
          `/api/v1/threads/${thread.id}/thread-storage/content?path=${document.filename}`,
          `/api/v1/projects/${project.id}/attachments/content?path=${encodeURIComponent(attachment.path)}`,
        ];
        for (const url of urls) {
          const initial = await harness.app.request(url);
          expect(
            initial.status,
            `${url}: ${await initial.clone().text()}`,
          ).toBe(200);
          expect(await initial.text(), url).toBe(document.content);
          const etag = initial.headers.get("etag");
          expect(etag, url).toBeTruthy();
          const conditional = await harness.app.request(url, {
            headers: { "if-none-match": etag! },
          });
          expect(conditional.status, url).toBe(304);
          expect(await conditional.text(), url).toBe("");
          const head = await harness.app.request(url, { method: "HEAD" });
          expect(head.status, url).toBe(200);
          expect(await head.text(), url).toBe("");
          for (const response of [initial, conditional, head]) {
            expect(response.headers.get("content-security-policy"), url).toBe(
              "sandbox allow-scripts",
            );
            expect(response.headers.get("x-content-type-options"), url).toBe(
              "nosniff",
            );
            expect(response.headers.get("referrer-policy"), url).toBe(
              "no-referrer",
            );
          }
          const opaque = await harness.app.request(url, {
            headers: { origin: "null" },
          });
          expect(opaque.status, url).toBe(403);
          expect(opaque.headers.has("access-control-allow-origin"), url).toBe(
            false,
          );
        }
      }
    });
  });
});

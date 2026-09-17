import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runSmoke, requireWithin } from "./smoke-arc-windows.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(label, read) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`${label} was not observed within 20 seconds`);
}

function assertSandbox(headers) {
  assert.match(
    headers.get("content-security-policy") ?? "",
    /\bsandbox\s+allow-scripts\b/u,
  );
  assert.doesNotMatch(
    headers.get("content-security-policy") ?? "",
    /allow-same-origin/u,
  );
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
}

export async function runPreviewSecuritySmoke(executable, options = {}) {
  let previousLease;
  return runSmoke(executable, {
    ...options,
    async verifyFeatures(context) {
      const { root, saved, daemon, pass, baseUrl, debuggerClient, check } =
        context;
      const site = requireWithin(
        saved.workspace,
        join(saved.workspace, `preview-security-${pass}`),
      );
      const outside = requireWithin(
        saved.workspace,
        join(saved.workspace, `outside-preview-${pass}.txt`),
      );
      const sentinel = `OWNED_PREVIEW_BOUNDARY_${saved.token}_${pass}`;
      const artifact = requireWithin(
        root,
        join(root, `preview-security-${pass}.json`),
      );
      const evidence = {
        pass,
        status: "running",
        checks: [],
        scope: "Owned fixtures only; no provider turns or personal files",
        nativeDocuments: [],
      };
      const tabs = [];
      let scope;
      let fixturePluginId;
      const request = async (
        path,
        body,
        method = body === undefined ? "GET" : "POST",
      ) => {
        const response = await fetch(`${baseUrl}/api/v1${path}`, {
          method,
          headers: { "Content-Type": "application/json", Origin: baseUrl },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        const value = await response.json();
        assert(
          response.ok,
          `${path}: ${response.status}: ${JSON.stringify(value).slice(0, 600)}`,
        );
        return value;
      };
      const nativePage = async (url, expression) => {
        const code = `(async()=>{const c=process.mainModule.require('electron').webContents.getAllWebContents().find(c=>c.getURL()===${JSON.stringify(url)});return c?c.executeJavaScript(${JSON.stringify(expression)}):null;})()`;
        return (await debuggerClient.evaluate(code)).result.value;
      };
      const open = async (url) => {
        const result = await request("/desktop-browsers/create", {
          ...scope,
          url,
          presentation: "hidden",
        });
        tabs.push(result.tab.tabId);
        return result.tab.tabId;
      };
      const record = (message) => {
        evidence.checks.push(message);
        check(`Preview security pass ${pass + 1}: ${message}`);
      };
      try {
        await mkdir(join(site, "assets", "nested"), { recursive: true });
        await mkdir(join(site, ".private"));
        await writeFile(outside, sentinel, { flag: "wx" });
        const readPayload = { hostId: daemon.hostId, path: outside };
        const writePayload = {
          ...readPayload,
          content: "UNAUTHORIZED_PREVIEW_WRITE",
          contentEncoding: "utf8",
          createParents: false,
          expectedSha256: createHash("sha256").update(sentinel).digest("hex"),
        };
        await request("/files/write", { ...writePayload, content: sentinel });
        assert.equal(
          (await request("/files/read", readPayload)).content,
          sentinel,
        );
        const boundaryScript = `(async()=>{const proof={executed:true,origin:globalThis.origin,finished:false};for(const [name,path,payload] of ${JSON.stringify(
          [
            ["read", "/files/read", readPayload],
            ["write", "/files/write", writePayload],
          ],
        )}){try{const response=await fetch('/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});proof[name+'Status']=response.status;const value=await response.json();proof[name+'Succeeded']=response.ok;proof.outsideSentinelRead=proof.outsideSentinelRead||value.content===${JSON.stringify(sentinel)};}catch(error){proof[name+'Blocked']=String(error);}}proof.finished=true;window.__arcBoundaryProof=proof;document.querySelector('#proof').textContent='Preview isolation active';})()`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="140"><text id="proof" x="20" y="50">Checking Preview isolation</text><script><![CDATA[${boundaryScript}]]></script></svg>`;
        const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Owned XHTML fixture</title></head><body><p id="proof">Checking Preview isolation</p><script><![CDATA[${boundaryScript}]]></script></body></html>`;
        await writeFile(
          join(site, "entry.html"),
          "<!doctype html><title>Owned navigation fixture</title><script>location.replace('escape.svg')</script>",
        );
        await writeFile(join(site, "escape.svg"), svg);
        await writeFile(join(site, "escape.xhtml"), xhtml);
        await writeFile(join(site, "escape.xml"), xhtml);
        await writeFile(join(site, ".env"), "OWNED_SECRET=not-a-real-secret");
        await writeFile(
          join(site, ".private", "data.json"),
          '{"private":true}',
        );
        await writeFile(join(site, "private.KEY"), "OWNED_PRIVATE_KEY_FIXTURE");
        await writeFile(
          join(site, "unsupported.arc-document"),
          "Owned unknown document fixture",
        );
        await symlink(
          join(site, ".private"),
          join(site, "public-alias"),
          "junction",
        );
        await symlink(saved.workspace, join(site, "outside-alias"), "junction");
        await writeFile(join(site, "data.json"), '{"value":"initial"}');
        await writeFile(
          join(site, "assets", "classic.js"),
          "window.__arcAssets.classic=true;",
        );
        await writeFile(
          join(site, "assets", "module.js"),
          "import {nested} from './nested/value.js'; window.__arcAssets.nested=nested; window.__arcAssets.dynamic=(await import('./nested/dynamic.js')).dynamic; window.__arcAssets.module=true;",
        );
        await writeFile(
          join(site, "assets", "nested", "value.js"),
          "export const nested='nested-ok';",
        );
        await writeFile(
          join(site, "assets", "nested", "dynamic.js"),
          "export const dynamic='dynamic-ok';",
        );
        await writeFile(
          join(site, "assets", "style.css"),
          '@font-face{font-family:ArcFixture;src:url("fixture.woff2") format("woff2")}#proof{color:rgb(5,6,7);font-family:ArcFixture,sans-serif}',
        );
        const font = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../app/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
        );
        await writeFile(
          join(site, "assets", "fixture.woff2"),
          await readFile(font),
        );
        await writeFile(
          join(site, "assets", "pixel.png"),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        await writeFile(
          join(site, "modules.html"),
          `<!doctype html><title>ARC Preview asset verification</title><link rel="stylesheet" href="assets/style.css"><p id="proof">Modules, data, styles, images and fonts</p><img id="pixel" src="assets/pixel.png"><script>window.__arcAssets={classic:false,module:false};fetch('data.json').then(r=>r.json()).then(value=>window.__arcAssets.value=value.value).catch(error=>window.__arcAssets.error=String(error));fetch('data.json',{credentials:'include'}).then(r=>r.text()).then(()=>window.__arcAssets.credentialedRead=true).catch(()=>window.__arcAssets.credentialedBlocked=true);document.fonts.load('16px ArcFixture').then(fonts=>window.__arcAssets.font=fonts.length>0).catch(error=>window.__arcAssets.fontError=String(error));</script><script src="assets/classic.js"></script><script type="module" src="assets/module.js"></script>`,
        );
        if (previousLease) {
          const stale = await fetch(`${baseUrl}${previousLease}/entry.html`, {
            headers: { Origin: "null" },
          });
          assert.equal(stale.status, 404);
          assert.equal(stale.headers.get("access-control-allow-origin"), null);
          await stale.body?.cancel();
          record("server restart invalidated the previous file lease");
        }
        const preparationRequest = {
          operationId: `preview-security-${saved.token}-${pass}`,
          projectId: saved.project.id,
          parentThreadId: null,
          executionContextId: `preview-security-${saved.token}-${pass}`,
          title: `Preview security fixture ${pass + 1}`,
          visibility: "visible",
          turnPolicy: "single",
          execution: {
            providerId: "codex",
            model: "gpt-6-astra",
            reasoningLevel: "medium",
            serviceTier: "default",
            permissionMode: "accept-edits",
          },
          input: [
            {
              type: "text",
              text: "Owned Preview isolation fixture; prepare the workspace without starting a provider turn.",
              mentions: [],
            },
          ],
          environment: {
            type: "host",
            hostId: daemon.hostId,
            workspace: { type: "unmanaged", path: saved.workspace },
          },
        };
        const fixturePluginRoot = requireWithin(
          root,
          join(root, `preview-security-plugin-${pass}`),
        );
        await mkdir(fixturePluginRoot);
        await writeFile(
          join(fixturePluginRoot, "package.json"),
          JSON.stringify({
            name: `bb-plugin-arc-preview-security-fixture-${pass}`,
            version: "0.1.0",
            type: "module",
            bb: {
              name: "ARC Preview security fixture",
              description:
                "Owned native Preview verification workspace preparation.",
              branding: { icon: "EditFile" },
              server: "./server.js",
            },
          }),
        );
        await writeFile(
          join(fixturePluginRoot, "server.js"),
          `const request = ${JSON.stringify(preparationRequest)};
export default function plugin(bb) {
  bb.http.route("POST", "/prepare", async (context) => context.json(await bb.experimental_threads.prepare(request)), { auth: "local" });
  bb.http.route("GET", "/preparation", async (context) => context.json(await bb.experimental_threads.getPreparation({ operationId: request.operationId })), { auth: "local" });
}
`,
        );
        const installed = await request("/plugins/install", {
          source: `path:${fixturePluginRoot}`,
          selection: { kind: "root" },
        });
        assert.equal(
          installed.plugin.id,
          `arc-preview-security-fixture-${pass}`,
        );
        fixturePluginId = installed.plugin.id;
        const preparationPath = `/plugins/${fixturePluginId}/http`;
        const initialPreparation = await request(
          `${preparationPath}/prepare`,
          {},
        );
        assert.equal(initialPreparation.dispatch, null);
        const preparation = await until(
          "prepared Preview fixture workspace",
          async () => {
            const value = await request(`${preparationPath}/preparation`);
            evidence.preparation = value;
            assert(value, "Preview fixture preparation disappeared");
            assert.equal(value.dispatch, null, JSON.stringify(value));
            assert(
              ["reserved", "provisioning", "prepared"].includes(value.state),
              `Preview fixture preparation failed: ${JSON.stringify(value)}`,
            );
            return value.state === "prepared" ? value : null;
          },
        );
        assert.equal(preparation.threadId, initialPreparation.threadId);
        assert.equal(preparation.environment.hostId, daemon.hostId);
        assert.equal(
          resolve(preparation.environment.path),
          resolve(saved.workspace),
        );
        const thread = await request(`/threads/${preparation.threadId}`);
        assert.equal(
          thread.environmentId,
          preparation.environment.environmentId,
        );
        assert.equal(
          (await request(`/threads/${thread.id}/queued-messages`)).length,
          0,
        );
        record(
          "real thread workspace prepared and attached without provider dispatch",
        );
        const instances = await request("/desktop-browsers/instances", {
          hostId: daemon.hostId,
        });
        assert.equal(instances.instances.length, 1);
        scope = {
          hostId: daemon.hostId,
          instanceId: instances.instances[0].instanceId,
          generation: instances.instances[0].generation,
          threadId: thread.id,
        };
        const lease = await request("/files/previews", {
          hostId: daemon.hostId,
          rootPath: site,
        });
        previousLease = lease.baseUrl;
        const prefix = `${baseUrl}${lease.baseUrl}`;
        evidence.lease = {
          baseUrl: lease.baseUrl,
          expiresAtMs: lease.expiresAtMs,
        };
        for (const path of [
          "entry.html",
          "escape.svg",
          "escape.xhtml",
          "escape.xml",
        ]) {
          const response = await fetch(`${prefix}/${path}`, {
            headers: { Origin: "null" },
          });
          assert.equal(response.status, 200);
          assertSandbox(response.headers);
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            "*",
          );
          assert.equal(
            response.headers.get("access-control-allow-credentials"),
            null,
          );
          await response.body?.cancel();
        }
        const head = await fetch(`${prefix}/escape.svg`, {
          method: "HEAD",
          headers: { Origin: "null" },
        });
        assert.equal(head.status, 200);
        assertSandbox(head.headers);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        for (const path of [
          ".env",
          "%2eprivate/data.json",
          "private.KEY",
          "private.KEY.",
          "private.KEY%20",
          "private.KEY%3A%3A%24DATA",
          "public-alias/data.json",
          `outside-alias/outside-preview-${pass}.txt`,
          "..%5Coutside.txt",
          "%00bad",
          "missing.json",
        ]) {
          const response = await fetch(`${prefix}/${path}`, {
            headers: { Origin: "null" },
          });
          assert(
            response.status >= 400,
            `Preview admitted forbidden path: ${path}`,
          );
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            null,
          );
          await response.body?.cancel();
        }
        const unsupported = await fetch(`${prefix}/unsupported.arc-document`, {
          headers: { Origin: "null" },
        });
        assert.equal(unsupported.status, 200);
        assert.match(
          unsupported.headers.get("content-disposition") ?? "",
          /^attachment\b/u,
        );
        await unsupported.body?.cancel();
        record(
          "active document headers, HEAD, hidden/private paths, junction boundaries and unknown document downloads enforced",
        );
        const boundary = async (url, name, initialUrl = url) => {
          const response = await fetch(url);
          const responseBody = await response.text();
          assert.equal(
            response.status,
            200,
            `${name}: ${url}: HTTP ${response.status}: ${responseBody.slice(0, 1_200)}`,
          );
          assertSandbox(response.headers);
          const etag = response.headers.get("etag");
          if (etag) {
            const cached = await fetch(url, {
              headers: { "If-None-Match": etag },
            });
            const cachedBody = await cached.text();
            assert(
              [200, 304].includes(cached.status),
              `${name} conditional request: HTTP ${cached.status}: ${cachedBody.slice(0, 1_200)}`,
            );
            assertSandbox(cached.headers);
          }
          await open(initialUrl);
          const proof = await until(name, () =>
            nativePage(
              url,
              "window.__arcBoundaryProof?.finished ? window.__arcBoundaryProof : null",
            ),
          );
          assert.equal(proof.executed, true);
          assert.equal(proof.origin, "null");
          assert.notEqual(proof.outsideSentinelRead, true);
          assert.notEqual(proof.readSucceeded, true);
          assert.notEqual(proof.writeSucceeded, true);
          assert.equal(await readFile(outside, "utf8"), sentinel);
          evidence.nativeDocuments.push({ name, proof });
        };
        await boundary(
          `${prefix}/escape.svg`,
          "HTML to SVG navigation",
          `${prefix}/entry.html`,
        );
        await boundary(`${prefix}/escape.xhtml`, "direct XHTML navigation");
        await boundary(`${prefix}/escape.xml`, "direct XML navigation");
        const relativeSvg = `preview-security-${pass}/escape.svg`;
        await boundary(
          `${baseUrl}/api/v1/projects/${saved.project.id}/files/content?${new URLSearchParams({ hostId: daemon.hostId, path: relativeSvg })}`,
          "project raw SVG",
        );
        await boundary(
          `${baseUrl}/api/v1/threads/${thread.id}/host-files/content?${new URLSearchParams({ path: join(site, "escape.svg") })}`,
          "thread raw SVG",
        );
        const form = new FormData();
        form.set(
          "file",
          new File([svg], "fixture.svg", { type: "image/svg+xml" }),
        );
        const uploadResponse = await fetch(
          `${baseUrl}/api/v1/projects/${saved.project.id}/attachments`,
          { method: "POST", headers: { Origin: baseUrl }, body: form },
        );
        assert.equal(uploadResponse.status, 201);
        const attachment = await uploadResponse.json();
        assert.equal(typeof attachment.path, "string");
        await boundary(
          `${baseUrl}/api/v1/projects/${saved.project.id}/attachments/content?${new URLSearchParams({ path: attachment.path })}`,
          "uploaded SVG attachment",
        );
        record(
          "actual native HTML/SVG/XHTML/XML and raw attachment scripts cannot read outside the lease or mutate ARC",
        );
        const moduleUrl = `${prefix}/modules.html`;
        await open(moduleUrl);
        const assets = await until(
          "native modules, fetch, font and image",
          () =>
            nativePage(
              moduleUrl,
              "window.__arcAssets?.module && window.__arcAssets?.font && window.__arcAssets?.value && window.__arcAssets?.credentialedBlocked && document.querySelector('#pixel')?.naturalWidth===1 ? {...window.__arcAssets,color:getComputedStyle(document.querySelector('#proof')).color} : null",
            ),
        );
        assert.equal(assets.classic, true);
        assert.equal(assets.nested, "nested-ok");
        assert.equal(assets.dynamic, "dynamic-ok");
        assert.equal(assets.value, "initial");
        assert.equal(assets.color, "rgb(5, 6, 7)");
        assert.notEqual(assets.credentialedRead, true);
        evidence.assets = assets;
        record(
          "classic and nested/dynamic module scripts, credentialless JSON fetch, CSS, image and font load; credentialed CORS reads fail",
        );
        for (const [path, payload] of [
          ["/files/read", readPayload],
          ["/files/write", writePayload],
          [`${lease.baseUrl.replace("/api/v1", "")}/refresh`, {}],
          [
            "/files/previews",
            { hostId: daemon.hostId, rootPath: saved.workspace },
          ],
        ]) {
          const response = await fetch(`${baseUrl}/api/v1${path}`, {
            method: "POST",
            headers: { Origin: "null", "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          assert.equal(
            response.status,
            403,
            `Opaque origin admitted to ${path}`,
          );
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            null,
          );
          await response.body?.cancel();
        }
        const preflight = await fetch(`${prefix}/data.json`, {
          method: "OPTIONS",
          headers: {
            Origin: "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        });
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          null,
        );
        await preflight.body?.cancel();
        await writeFile(join(site, "data.json"), '{"value":"updated"}');
        const renewed = await request(
          `${lease.baseUrl.replace("/api/v1", "")}/refresh`,
          {},
        );
        assert.equal(renewed.changed, true);
        assert(renewed.expiresAtMs >= lease.expiresAtMs);
        await debuggerClient.evaluate(
          `(()=>{const c=process.mainModule.require('electron').webContents.getAllWebContents().find(c=>c.getURL()===${JSON.stringify(moduleUrl)});c.reload();return true;})()`,
        );
        await until("reloaded updated static data", () =>
          nativePage(
            moduleUrl,
            "window.__arcAssets?.value==='updated' && window.__arcAssets?.module && window.__arcAssets?.font",
          ),
        );
        const screenshot = (
          await debuggerClient.evaluate(
            `(async()=>{const c=process.mainModule.require('electron').webContents.getAllWebContents().find(c=>c.getURL()===${JSON.stringify(moduleUrl)});return (await c.capturePage()).toPNG().toString('base64');})()`,
          )
        ).result.value;
        assert.equal(typeof screenshot, "string");
        evidence.screenshot = requireWithin(
          root,
          join(root, `preview-assets-${pass}.png`),
        );
        await writeFile(evidence.screenshot, Buffer.from(screenshot, "base64"));
        evidence.modelTurnsAdmitted = (
          await request(
            `/threads/${thread.id}/events?types=turn%2Finput%2Faccepted&limit=1`,
          )
        ).length;
        assert.equal(evidence.modelTurnsAdmitted, 0);
        const retainedPreparation = await request(
          `${preparationPath}/preparation`,
        );
        assert.equal(retainedPreparation.state, "prepared");
        assert.equal(retainedPreparation.dispatch, null);
        assert.equal(await readFile(outside, "utf8"), sentinel);
        record(
          "API and renewal remain privileged; live asset renewal/reload works with zero provider turns",
        );
        evidence.status = "passed";
      } catch (error) {
        evidence.status = "failed";
        evidence.error = error.stack ?? String(error);
        throw error;
      } finally {
        evidence.cleanupErrors = [];
        for (const tabId of tabs) {
          try {
            await request("/desktop-browsers/close", { ...scope, tabId });
          } catch (error) {
            evidence.cleanupErrors.push(String(error));
          }
        }
        if (fixturePluginId) {
          try {
            await request(`/plugins/${fixturePluginId}`, undefined, "DELETE");
          } catch (error) {
            evidence.cleanupErrors.push(String(error));
          }
        }
        if (evidence.cleanupErrors.length) evidence.status = "failed";
        await writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
        assert.equal(
          evidence.cleanupErrors.length,
          0,
          "Native fixture tabs or preparation plugin did not clean up",
        );
      }
      return evidence;
    },
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      executable: { type: "string" },
      "artifacts-parent": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node apps/desktop/scripts/smoke-arc-preview-security.mjs [--executable <ARC IDE.exe>] [--artifacts-parent <directory>]\nRuns actual native Preview security and asset controls in owned profiles, twice across restart. No provider turns or personal files.",
    );
  else {
    const result = await runPreviewSecuritySmoke(
      values.executable ??
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../release/win-unpacked/ARC IDE.exe",
        ),
      values["artifacts-parent"]
        ? { artifactsParent: resolve(values["artifacts-parent"]) }
        : {},
    );
    if (result.status !== "passed") process.exitCode = 1;
  }
}

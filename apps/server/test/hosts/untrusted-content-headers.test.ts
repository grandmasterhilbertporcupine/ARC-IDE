import { describe, expect, it } from "vitest";
import { applyUntrustedContentHeaders } from "../../src/services/untrusted-content-headers.js";
import { createDaemonFileContentResponse } from "../../src/services/hosts/daemon-file-response.js";

describe("untrusted file responses", () => {
  it.each([
    "text/html",
    "Text/Html; charset=utf-8",
    "image/svg+xml",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
    "application/xslt+xml",
    "application/unknown+xml; charset=utf-8",
  ])("isolates %s documents even on conditional responses", (mimeType) => {
    for (const ifNoneMatch of [undefined, '"owned"']) {
      const response = createDaemonFileContentResponse(
        {
          path: "/owned/document",
          content: "<document/>",
          contentEncoding: "utf8",
          mimeType,
          sizeBytes: 11,
          sha256: "owned",
        },
        { ifNoneMatch },
      );
      expect(response.status).toBe(ifNoneMatch ? 304 : 200);
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.has("content-disposition")).toBe(false);
    }
  });

  it("adds an independent sandbox without weakening existing restrictions", () => {
    for (const existing of [
      "default-src 'none'; sandbox",
      "sandbox allow-same-origin; script-src 'none'",
      "default-src 'none', sandbox allow-forms",
    ]) {
      const headers = applyUntrustedContentHeaders(
        new Headers({
          "content-type": "image/svg+xml",
          "content-security-policy": existing,
        }),
      );
      expect(headers.get("content-security-policy")).toBe(
        `${existing}, sandbox allow-scripts`,
      );
      applyUntrustedContentHeaders(headers);
      expect(headers.get("content-security-policy")).toBe(
        `${existing}, sandbox allow-scripts`,
      );
    }
  });

  it.each([
    "application/javascript",
    "text/javascript",
    "text/css",
    "application/json",
    "application/wasm",
    "font/woff2",
    "image/png",
    "image/jpeg",
    "audio/mpeg",
    "video/mp4",
    "application/pdf",
    "text/plain",
    "text/markdown",
  ])("preserves supported %s assets and media", (mimeType) => {
    const headers = applyUntrustedContentHeaders(
      new Headers({ "content-type": mimeType }),
    );
    expect(headers.has("content-security-policy")).toBe(false);
    expect(headers.has("content-disposition")).toBe(false);
    expect(headers.get("content-type")).toBe(mimeType);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("forces unfamiliar documents to download, retaining a provided filename", () => {
    for (const mimeType of [
      undefined,
      "application/octet-stream",
      "application/x-unknown-document",
    ]) {
      const headers = new Headers({
        "content-disposition": 'inline; filename="owned.bin"',
      });
      if (mimeType) headers.set("content-type", mimeType);
      applyUntrustedContentHeaders(headers);
      expect(headers.get("content-disposition")).toBe(
        'attachment; filename="owned.bin"',
      );
      expect(headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
    }
    expect(
      applyUntrustedContentHeaders(new Headers()).get("content-disposition"),
    ).toBe("attachment");
  });
});

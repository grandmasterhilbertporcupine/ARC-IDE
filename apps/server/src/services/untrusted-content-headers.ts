const SANDBOX_POLICY = "sandbox allow-scripts";
const STATIC_ASSET_TYPES = new Set([
  "application/javascript",
  "application/ecmascript",
  "text/javascript",
  "text/ecmascript",
  "text/css",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/wasm",
  "application/vnd.ms-fontobject",
  "application/font-woff",
  "application/x-font-ttf",
  "application/x-font-opentype",
]);

export function applyUntrustedContentHeaders(headers: Headers): Headers {
  const mimeType = headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const document =
    mimeType === "text/html" ||
    mimeType === "text/xml" ||
    mimeType === "application/xml" ||
    mimeType?.endsWith("+xml") === true;
  const passive =
    !document &&
    (mimeType === "application/pdf" ||
      /^(?:image|audio|video|font)\//u.test(mimeType ?? "") ||
      STATIC_ASSET_TYPES.has(mimeType ?? ""));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if (!passive) {
    const policies = headers.get("content-security-policy")?.split(",") ?? [];
    if (!policies.some((policy) => policy.trim() === SANDBOX_POLICY))
      headers.append("content-security-policy", SANDBOX_POLICY);
    if (!document)
      headers.set(
        "content-disposition",
        headers.get("content-disposition")?.replace(/^[^;]*/u, "attachment") ??
          "attachment",
      );
  }
  return headers;
}

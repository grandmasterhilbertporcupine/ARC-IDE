import { createHash } from "node:crypto";
import type { HostEffectRequest } from "../host-contract.js";
import type { DirectoryEffectRequest } from "../host-directory-contract.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalHostEffectRequest(request: HostEffectRequest): string {
  return canonical(request);
}

export function hostEffectRequestHash(request: HostEffectRequest): string {
  return createHash("sha256")
    .update(canonicalHostEffectRequest(request))
    .digest("hex");
}

export function canonicalDirectoryEffectRequest(
  request: DirectoryEffectRequest,
): string {
  return canonical(request);
}

export function directoryEffectRequestHash(
  request: DirectoryEffectRequest,
): string {
  return createHash("sha256")
    .update(canonicalDirectoryEffectRequest(request))
    .digest("hex");
}

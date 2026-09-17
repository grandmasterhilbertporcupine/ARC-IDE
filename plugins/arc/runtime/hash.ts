import { createHash } from "node:crypto";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { canonicalOwnedJson } from "bb-plugin-workflows/owned-contract";

export function canonicalJson(value: JsonValue): string {
  return canonicalOwnedJson(value);
}

export function runtimeHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

import { resolve } from "node:path";
import { expect, it } from "vitest";
import { isWithinDirectory } from "./path-containment.js";

it("accepts nested native paths containing spaces and Unicode", () => {
  const root = resolve("WNDR Projects", "预报 Δ");
  expect(isWithinDirectory(root, resolve(root, "src", "app.tsx"))).toBe(true);
  expect(isWithinDirectory(root, root)).toBe(true);
});

it("rejects parent traversal and sibling directories with matching prefixes", () => {
  const root = resolve("WNDR Projects", "forecast");
  expect(isWithinDirectory(root, resolve(root, "..", "secret.ts"))).toBe(false);
  expect(isWithinDirectory(root, resolve(root + "-other", "server.ts"))).toBe(false);
  expect(isWithinDirectory(root, resolve(root, ".."))).toBe(false);
});

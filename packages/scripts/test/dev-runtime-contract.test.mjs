import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("development runtime contract", () => {
  it("pins the root engine floor for primary development", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    const nodePin = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();

    expect(packageJson.engines.node).toBe(`>=${nodePin}`);
  });
});

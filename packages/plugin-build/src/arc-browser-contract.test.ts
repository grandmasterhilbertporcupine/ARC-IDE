import { basename, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles retained ARC run contracts for browser consumers without Node builtins", async () => {
  const repository = resolve(import.meta.dirname, "../../..");
  const result = await build({
    absWorkingDir: repository,
    entryPoints: [
      "plugins/arc/runtime/graph-contract.ts",
      "plugins/arc/runtime/directory-contract.ts",
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    outdir: "dist",
    write: false,
    logLevel: "silent",
  });
  expect(result.outputFiles.map((file) => basename(file.path)).sort()).toEqual([
    "directory-contract.js",
    "graph-contract.js",
  ]);
});

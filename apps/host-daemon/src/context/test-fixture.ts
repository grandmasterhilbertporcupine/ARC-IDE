import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { contextManifestSchema, type ContextManifest } from "./contract.js";

export async function contextFixture(
  mode: "normal" | "initializing" = "normal",
) {
  const root = await mkdtemp(join(tmpdir(), "ARC Context Δ "));
  const context = join(root, "context");
  const events = join(root, "events.jsonl");
  await mkdir(context);
  const source = dirname(fileURLToPath(import.meta.url));
  await Promise.all(
    ["client", "worker"].map((entry) =>
      build({
        entryPoints: [join(source, `${entry}.ts`)],
        outfile: join(context, `${entry}.mjs`),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        logLevel: "silent",
      }),
    ),
  );
  async function write(path: string, value: string) {
    await mkdir(dirname(join(context, path)), { recursive: true });
    await writeFile(join(context, path), value);
  }
  await write(
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    `
import { appendFileSync } from "node:fs";
const record = (phase) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ phase, pid: process.pid }) + "\\n");
record("imported");
export const env = { version: "4.2.0" };
export async function pipeline(task, model, options) {
  if (task !== "feature-extraction" || env.allowRemoteModels !== false || env.useFSCache !== false || env.useCustomCache !== false || env.useBrowserCache !== false || env.useWasmCache !== false || options.device !== "cpu" || options.session_options.intraOpNumThreads !== 2) throw new Error("Invalid offline configuration");
  record("initializing");
  if (${JSON.stringify(mode)} === "initializing") await new Promise(() => { setInterval(() => {}, 1000); });
  const extractor = async (texts) => {
    record("embedding");
    if (texts.includes("hold")) await new Promise(() => { setInterval(() => {}, 1000); });
    if (texts.includes("crash")) process.exit(19);
    return { tolist: () => texts.map((text) => Array.from({ length: 384 }, (_, index) => text === "bad-vector" ? 0 : index === 0 ? 1 : 0)) };
  };
  extractor.tokenizer = { encode: (text) => {
    record("counting");
    if (text === "hold-count") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return Array(text.split(/\\s+/).length + 2).fill(1);
  } };
  extractor.dispose = async () => record("disposed");
  return extractor;
}
`,
  );
  for (const [name, version] of [
    ["@huggingface/transformers", "4.2.0"],
    ["onnxruntime-node", "1.24.3"],
    ["sharp", "0.35.4"],
  ])
    await write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version, type: "module" }),
    );
  for (const name of [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "README.md",
    "onnx/model_quantized.onnx",
  ])
    await write(
      `models/Xenova/all-MiniLM-L6-v2/${name}`,
      "lifecycle fixture asset",
    );
  await write(
    "notices/fixture.txt",
    "Lifecycle test fixture, not model inference evidence",
  );
  const files: ContextManifest["files"] = [];
  async function inventory(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else {
        const bytes = await readFile(path);
        files.push({
          path: relative(context, path).split(sep).join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await inventory(context);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = contextManifestSchema.parse({
    schemaVersion: 1,
    target: { platform: "win32", arch: "x64" },
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    runtime: { transformers: "4.2.0", onnx: "1.24.3", sharp: "0.35.4" },
    tokenizer: { policy: "minilm-total-tokens-v1", totalTokens: 256 },
    dimension: 384,
    dtype: "q8",
    pooling: "mean",
    normalize: true,
    files,
  });
  const manifestBytes = JSON.stringify(manifest);
  await write("manifest.json", manifestBytes);
  const { ContextEmbeddingClient } = (await import(
    pathToFileURL(join(context, "client.mjs")).href
  )) as typeof import("./client.js");
  const client = new ContextEmbeddingClient();
  return {
    root,
    context,
    events,
    client,
    manifest,
    digest: createHash("sha256").update(manifestBytes).digest("hex"),
    async dispose() {
      await client.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function waitForPhase(
  path: string,
  phase: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lines = await readFile(path, "utf8").catch(() => "");
    for (const line of lines.trim().split("\n").filter(Boolean)) {
      const event = z
        .object({ phase: z.string(), pid: z.number().int().positive() })
        .parse(JSON.parse(line));
      if (event.phase === phase) return event.pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Context fixture did not reach ${phase}`);
}

export function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return z.object({ code: z.literal("ESRCH") }).safeParse(error).success;
  }
}

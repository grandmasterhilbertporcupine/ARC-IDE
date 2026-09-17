import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { z } from "zod";
import {
  boundedContextMessage,
  CONTEXT_LIMITS,
  contextDescriptorSchema,
  contextEmbedInputSchema,
  contextEmbeddingSchema,
  contextManifestSchema,
  contextRequestSchema,
  contextResponseSchema,
  ContextRuntimeError,
  type ContextDescriptor,
  type ContextRequest,
  type ContextResponse,
} from "./contract.js";

const assetRoot = dirname(fileURLToPath(import.meta.url));
let generation: string | null = null;
let extractor: FeatureExtractionPipeline | null = null;
let descriptor: ContextDescriptor | null = null;
let active = false;
let stopping = false;

function send(response: ContextResponse): void {
  const checked = contextResponseSchema.parse(response);
  if (!boundedContextMessage(checked) || !process.send || !process.connected)
    process.exit(1);
  process.send(checked, (error) => {
    if (error) process.exit(1);
  });
}

function fail(request: ContextRequest, error: unknown): void {
  const failure =
    error instanceof ContextRuntimeError
      ? error
      : new ContextRuntimeError(
          request.type === "embed" ? "inference_failed" : "runtime_unavailable",
          "The local Context runtime could not complete this request",
        );
  send({
    schemaVersion: 3,
    generation: request.generation,
    requestId: request.requestId,
    type: "error",
    error: { code: failure.code, message: failure.message.slice(0, 2048) },
  });
}

async function verifyAssets(): Promise<ContextDescriptor> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new ContextRuntimeError(
      "unsupported_target",
      "Context embeddings require the verified Windows x64 CPU runtime",
    );
  const manifestPath = join(assetRoot, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 8_388_608
  )
    throw new ContextRuntimeError(
      "invalid_manifest",
      "Context manifest must be a bounded regular file",
    );
  const manifestBytes = await readFile(manifestPath);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new ContextRuntimeError(
      "invalid_manifest",
      "Context manifest is not valid JSON",
    );
  }
  const parsed = contextManifestSchema.safeParse(manifestValue);
  if (!parsed.success)
    throw new ContextRuntimeError(
      "invalid_manifest",
      "Context manifest does not match the pinned runtime contract",
    );
  const manifest = parsed.data;
  const root = await realpath(assetRoot);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const observed = new Set<string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (stopping)
        throw new ContextRuntimeError(
          "cancelled",
          "Context initialization was stopped",
        );
      const path = join(directory, entry.name);
      const asset = relative(assetRoot, path).split(sep).join("/");
      if (asset === "manifest.json") continue;
      if (entry.isSymbolicLink())
        throw new ContextRuntimeError(
          "asset_mismatch",
          "Context assets cannot contain links",
        );
      if (entry.isDirectory()) {
        if (
          ![...expected.keys()].some((candidate) =>
            candidate.startsWith(`${asset}/`),
          )
        )
          throw new ContextRuntimeError(
            "asset_mismatch",
            "Context contains an undeclared directory",
          );
        await visit(path);
        continue;
      }
      const declared = expected.get(asset);
      const stat = await lstat(path);
      const canonical = await realpath(path);
      if (
        !declared ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== declared.bytes ||
        !canonical.startsWith(`${root}${sep}`)
      )
        throw new ContextRuntimeError(
          "asset_mismatch",
          "Context contains a missing, replaced or undeclared asset",
        );
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) {
        if (stopping)
          throw new ContextRuntimeError(
            "cancelled",
            "Context initialization was stopped",
          );
        hash.update(chunk);
      }
      if (hash.digest("hex") !== declared.sha256)
        throw new ContextRuntimeError(
          "asset_mismatch",
          "Context asset digest does not match the installed manifest",
        );
      observed.add(asset);
    }
  }
  await visit(assetRoot);
  if (observed.size !== expected.size)
    throw new ContextRuntimeError(
      "asset_mismatch",
      "A declared Context asset is missing",
    );
  for (const [name, version] of [
    ["@huggingface/transformers", manifest.runtime.transformers],
    ["onnxruntime-node", manifest.runtime.onnx],
    ["sharp", manifest.runtime.sharp],
  ]) {
    const packageJson = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          await readFile(
            join(assetRoot, "node_modules", name!, "package.json"),
            "utf8",
          ),
        ),
      );
    if (packageJson.version !== version)
      throw new ContextRuntimeError(
        "asset_mismatch",
        "Context runtime package version does not match the manifest",
      );
  }
  return contextDescriptorSchema.parse({
    model: manifest.model,
    revision: manifest.revision,
    runtime: manifest.runtime,
    target: manifest.target,
    tokenizer: manifest.tokenizer,
    dimension: manifest.dimension,
    dtype: manifest.dtype,
    pooling: manifest.pooling,
    normalize: manifest.normalize,
    manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
  });
}

async function initialize(
  request: Extract<ContextRequest, { type: "initialize" }>,
): Promise<void> {
  try {
    descriptor = await verifyAssets();
  } catch (error) {
    throw error instanceof ContextRuntimeError
      ? error
      : new ContextRuntimeError(
          "asset_mismatch",
          "Context assets are missing or cannot be verified",
        );
  }
  if (stopping) return;
  globalThis.fetch = async () => {
    throw new ContextRuntimeError(
      "runtime_unavailable",
      "Network fetch is disabled for Context embeddings",
    );
  };
  const runtimeUrl = pathToFileURL(
    join(
      assetRoot,
      "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    ),
  ).href;
  const { env, pipeline } = (await import(
    runtimeUrl
  )) as typeof import("@huggingface/transformers");
  if (env.version !== descriptor.runtime.transformers)
    throw new ContextRuntimeError(
      "runtime_unavailable",
      "Loaded Context runtime has an unexpected version",
    );
  Object.assign(env, {
    allowRemoteModels: false,
    allowLocalModels: true,
    localModelPath: join(assetRoot, "models"),
    useBrowserCache: false,
    useFSCache: false,
    useCustomCache: false,
    useWasmCache: false,
    fetch: globalThis.fetch,
  });
  extractor = await pipeline("feature-extraction", descriptor.model, {
    revision: descriptor.revision,
    device: "cpu",
    dtype: "q8",
    local_files_only: true,
    session_options: {
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      executionMode: "sequential",
    },
  });
  if (stopping) return;
  send({
    schemaVersion: 3,
    generation: request.generation,
    requestId: request.requestId,
    type: "ready",
    descriptor,
    process: {
      pid: process.pid,
      execPath: process.execPath,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      modules: process.versions.modules,
      cpuThreads: 2,
      remoteModels: false,
      caches: false,
      fetch: "rejected",
    },
  });
}

async function embed(
  request: Extract<ContextRequest, { type: "embed" | "countTokens" }>,
): Promise<void> {
  if (!extractor || !descriptor)
    throw new ContextRuntimeError(
      "runtime_unavailable",
      "Context has not initialized",
    );
  const parsed = contextEmbedInputSchema.safeParse({
    requestId: request.requestId,
    expectedManifestDigest: request.expectedManifestDigest,
    expectedGeneration: request.expectedGeneration,
    items: request.items,
  });
  if (!parsed.success)
    throw new ContextRuntimeError(
      "invalid_request",
      "Context input exceeds the batch contract",
    );
  if (request.expectedGeneration !== generation)
    throw new ContextRuntimeError(
      "worker_stopped",
      "Context request targets a different helper generation",
    );
  if (request.expectedManifestDigest !== descriptor.manifestDigest)
    throw new ContextRuntimeError(
      "manifest_mismatch",
      "Context input targets a different verified manifest",
    );
  const tokenCounts = request.items.map(
    (item) =>
      extractor!.tokenizer.encode(item.text, { add_special_tokens: true })
        .length,
  );
  if (request.type === "countTokens") {
    send({
      schemaVersion: 3,
      generation: request.generation,
      requestId: request.requestId,
      type: "counted",
      manifestDigest: descriptor.manifestDigest,
      items: request.items.map((item, index) => ({
        id: item.id,
        tokenCount: tokenCounts[index]!,
      })),
    });
    return;
  }
  if (tokenCounts.some((count) => count > CONTEXT_LIMITS.tokens))
    throw new ContextRuntimeError(
      "token_limit",
      "Context text exceeds 256 total tokens; split the source before embedding",
    );
  const output = await extractor(
    request.items.map((item) => item.text),
    { pooling: "mean", normalize: true },
  );
  if (stopping) return;
  const vectors = z
    .array(z.array(z.number().finite()).length(CONTEXT_LIMITS.dimensions))
    .length(request.items.length)
    .parse(output.tolist());
  const items = request.items.map((item, index) =>
    contextEmbeddingSchema.parse({
      id: item.id,
      tokenCount: tokenCounts[index],
      vector: vectors[index],
    }),
  );
  send({
    schemaVersion: 3,
    generation: request.generation,
    requestId: request.requestId,
    type: "embedded",
    manifestDigest: descriptor.manifestDigest,
    items,
  });
}

async function dispose(request: ContextRequest): Promise<void> {
  stopping = true;
  if (active) return;
  await extractor?.dispose();
  send({
    schemaVersion: 3,
    generation: request.generation,
    requestId: request.requestId,
    type: "disposed",
  });
  process.disconnect();
}

process.on("disconnect", () => process.exit(0));
process.on("message", (value: unknown) => {
  if (!boundedContextMessage(value)) return process.exit(1);
  const parsed = contextRequestSchema.safeParse(value);
  if (!parsed.success) return process.exit(1);
  const request = parsed.data;
  if (generation !== null && generation !== request.generation)
    return process.exit(1);
  if (generation === null && request.type !== "initialize")
    return process.exit(1);
  generation ??= request.generation;
  if (request.type === "dispose") {
    void dispose(request).catch(() => process.exit(1));
    return;
  }
  if (stopping)
    return fail(
      request,
      new ContextRuntimeError("disposed", "Context is stopping"),
    );
  if (active || (request.type === "initialize" && descriptor))
    return fail(
      request,
      new ContextRuntimeError(
        "queue_full",
        "Context accepts one native operation at a time",
      ),
    );
  active = true;
  void (request.type === "initialize" ? initialize(request) : embed(request))
    .catch((error: unknown) => fail(request, error))
    .finally(() => {
      active = false;
      if (stopping) process.exit(0);
    });
});

if (!process.send) process.exitCode = 1;

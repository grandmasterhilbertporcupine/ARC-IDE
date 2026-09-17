import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "context-assets");
const cacheRoot = resolve(packageRoot, ".context-assets");
const outputRoot = resolve(packageRoot, "dist/context");
const modelId = "Xenova/all-MiniLM-L6-v2";
const revision = "751bff37182d3f1213fa05d7196b954e230abad9";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  model: z.literal(modelId),
  revision: z.literal(revision),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        bytes: z.number().int().positive().max(24_000_000),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        url: z.url(),
      }),
    )
    .length(7),
});

export async function ensureOwnedContextDirectory(anchor, directory) {
  const lexicalAnchor = resolve(anchor);
  const target = resolve(directory);
  const offset = relative(lexicalAnchor, target);
  assert(
    !isAbsolute(offset) &&
      offset !== ".." &&
      !offset.startsWith("../") &&
      !offset.startsWith("..\\"),
    "Context directory left its owned root",
  );
  const physicalAnchor = await realpath(lexicalAnchor);
  let current = lexicalAnchor;
  for (const part of offset.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      "Context directory must not redirect through a link",
    );
    const expected = resolve(physicalAnchor, relative(lexicalAnchor, current));
    assert.equal(
      await realpath(current),
      expected,
      "Context directory redirected outside its physical scope",
    );
  }
  return target;
}

function contained(root, path) {
  const candidate = resolve(root, path);
  const offset = relative(root, candidate);
  assert(
    offset.length > 0 &&
      !isAbsolute(offset) &&
      offset !== ".." &&
      !offset.startsWith("../") &&
      !offset.startsWith("..\\"),
    "Context asset path left its owned directory",
  );
  return candidate;
}

export async function prepareContextBundleOutput(anchor) {
  const directory = await ensureOwnedContextDirectory(
    anchor,
    resolve(anchor, "dist/context"),
  );
  for (const name of ["client.mjs", "worker.mjs"])
    await rm(resolve(directory, name), { force: true });
}

async function modelManifest() {
  const value = sourceManifestSchema.parse(
    JSON.parse(
      await readFile(resolve(sourceRoot, "model-manifest.json"), "utf8"),
    ),
  );
  const expected = [
    "README.md",
    "config.json",
    "onnx/model_quantized.onnx",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
  ]
    .map((path) => `models/${modelId}/${path}`)
    .sort();
  assert.deepEqual(value.files.map((file) => file.path).sort(), expected);
  for (const file of value.files) {
    const suffix = file.path.slice(`models/${modelId}/`.length);
    assert.equal(
      file.url,
      `https://huggingface.co/${modelId}/resolve/${revision}/${suffix}`,
    );
  }
  return value;
}

async function matches(path, expected) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes)
      return false;
    return hash(await readFile(path)) === expected.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function acquireContextAssets() {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const manifest = await modelManifest();
  for (const file of manifest.files) {
    const destination = contained(cacheRoot, file.path);
    await ensureOwnedContextDirectory(packageRoot, dirname(destination));
    if (await matches(destination, file)) continue;
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const response = await fetch(file.url, {
      signal: AbortSignal.timeout(120000),
    });
    assert(
      response.ok && response.body !== null,
      `Context asset acquisition failed: ${file.path} HTTP ${response.status}`,
    );
    const handle = await open(temporary, "wx");
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        assert(
          bytes <= file.bytes,
          `Context asset exceeds pinned size: ${file.path}`,
        );
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
      assert.equal(
        bytes,
        file.bytes,
        `Context asset size mismatch: ${file.path}`,
      );
      assert.equal(
        digest.digest("hex"),
        file.sha256,
        `Context asset checksum mismatch: ${file.path}`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  }
  console.log(
    `Context: verified ${manifest.files.length} pinned build-time model assets`,
  );
}

async function packageLocation(resolver, name, entry = name) {
  let current = dirname(resolver.resolve(entry));
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = JSON.parse(
        await readFile(resolve(current, "package.json"), "utf8"),
      );
      if (manifest.name === name)
        return { root: await realpath(current), manifest };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    assert.notEqual(
      parent,
      current,
      `Could not locate Context dependency ${name}`,
    );
    current = parent;
  }
  throw new Error(`Could not locate Context dependency ${name}`);
}

async function copyTree(source, destination, fileFilter = () => true) {
  const info = await lstat(source);
  assert(
    !info.isSymbolicLink(),
    `Context payload cannot contain a symlink: ${source}`,
  );
  if (info.isDirectory()) {
    for (const name of (await readdir(source)).sort())
      await copyTree(
        resolve(source, name),
        resolve(destination, name),
        fileFilter,
      );
  } else {
    assert(
      info.isFile(),
      `Context payload must contain ordinary files: ${source}`,
    );
    if (!fileFilter(source)) return;
    await ensureOwnedContextDirectory(packageRoot, dirname(destination));
    await copyFile(source, destination);
  }
}

async function listFiles(root, subpath = "") {
  const files = [];
  for (const entry of await readdir(resolve(root, subpath), {
    withFileTypes: true,
  })) {
    const path = [subpath, entry.name].filter(Boolean).join("/");
    assert(!entry.isSymbolicLink(), "Context output may not contain symlinks");
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else {
      assert(entry.isFile(), "Context output may only contain ordinary files");
      files.push(path);
    }
  }
  return files.sort();
}

export async function stageContextRuntime() {
  assert.equal(outputRoot, resolve(packageRoot, "dist/context"));
  await ensureOwnedContextDirectory(packageRoot, outputRoot);
  for (const path of ["models", "node_modules", "notices", "manifest.json"])
    await rm(contained(outputRoot, path), { recursive: true, force: true });
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log(
      "Context: this build target is unavailable; no native/model assets staged",
    );
    return;
  }
  const source = await modelManifest();
  for (const file of source.files) {
    const cached = contained(cacheRoot, file.path);
    await ensureOwnedContextDirectory(packageRoot, dirname(cached));
    assert(
      await matches(cached, file),
      `Missing verified build-time Context asset: ${file.path}. Run the context:assets Turbo prerequisite.`,
    );
    const destination = contained(outputRoot, file.path);
    await ensureOwnedContextDirectory(packageRoot, dirname(destination));
    await copyFile(cached, destination);
  }
  await copyTree(
    resolve(sourceRoot, "notices"),
    resolve(outputRoot, "notices"),
  );
  const resolver = createRequire(resolve(packageRoot, "package.json"));
  const locations = new Map();
  const recipes = [
    {
      name: "@huggingface/transformers",
      version: "4.2.0",
      paths: ["dist/transformers.node.mjs"],
    },
    {
      name: "onnxruntime-node",
      version: "1.24.3",
      paths: ["dist", "bin/napi-v6/win32/x64"],
    },
    {
      name: "onnxruntime-common",
      version: "1.24.3",
      from: "onnxruntime-node",
      paths: ["dist"],
    },
    { name: "sharp", version: "0.35.4", paths: ["dist"] },
    {
      name: "@img/sharp-win32-x64",
      entry: "@img/sharp-win32-x64/package",
      version: "0.35.4",
      from: "sharp",
      paths: ["index.cjs", "versions.json", "lib"],
    },
    { name: "@img/colour", from: "sharp", paths: null },
    { name: "detect-libc", from: "sharp", paths: null },
    { name: "semver", from: "sharp", paths: null },
  ];
  const shipped = new Set(recipes.map((recipe) => recipe.name));
  const packageRecords = [];
  for (const recipe of recipes) {
    const resolvedFrom = recipe.from
      ? createRequire(resolve(locations.get(recipe.from).root, "package.json"))
      : resolver;
    const location = await packageLocation(
      resolvedFrom,
      recipe.name,
      recipe.entry,
    );
    locations.set(recipe.name, location);
    if (recipe.version)
      assert.equal(
        location.manifest.version,
        recipe.version,
        `Context dependency version mismatch: ${recipe.name}`,
      );
    const destination = contained(outputRoot, `node_modules/${recipe.name}`);
    await ensureOwnedContextDirectory(packageRoot, destination);
    const paths =
      recipe.paths ??
      (await readdir(location.root)).filter(
        (name) =>
          ![
            "node_modules",
            "package.json",
            "test",
            "tests",
            "bin",
            "scripts",
            "install",
          ].includes(name),
      );
    for (const path of paths)
      await copyTree(
        contained(location.root, path),
        contained(destination, path),
        (path) => !path.endsWith(".map") && !/\.d\.(?:ts|mts|cts)$/.test(path),
      );
    for (const name of await readdir(location.root)) {
      if (/^(LICENSE|LICENCE|NOTICE|COPYING|README)/i.test(name))
        await copyTree(
          resolve(location.root, name),
          resolve(destination, name),
        );
    }
    const original = location.manifest;
    const metadata = { ...original };
    for (const field of [
      "scripts",
      "devDependencies",
      "bin",
      "funding",
      "files",
    ])
      delete metadata[field];
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (metadata[field])
        metadata[field] = Object.fromEntries(
          Object.entries(metadata[field]).filter(([name]) => shipped.has(name)),
        );
    }
    if (recipe.name === "@huggingface/transformers") {
      metadata.main = "./dist/transformers.node.mjs";
      metadata.exports = { ".": "./dist/transformers.node.mjs" };
      metadata.dependencies = {
        "onnxruntime-node": "1.24.3",
        "onnxruntime-common": "1.24.3",
        sharp: "0.35.4",
      };
    }
    await writeFile(
      resolve(destination, "package.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    const notice = contained(
      outputRoot,
      `notices/packages/${recipe.name.replaceAll("/", "_")}.json`,
    );
    await ensureOwnedContextDirectory(packageRoot, dirname(notice));
    await writeFile(
      notice,
      JSON.stringify(
        {
          package: recipe.name,
          version: original.version,
          runtimeProjection: true,
          originalPackage: original,
        },
        null,
        2,
      ) + "\n",
    );
    packageRecords.push({ name: recipe.name, version: original.version });
  }
  assert(!(await exists(resolve(outputRoot, "node_modules/adm-zip"))));
  assert(
    !(await exists(
      resolve(outputRoot, "node_modules/onnxruntime-node/script"),
    )),
  );
  const files = [];
  for (const path of await listFiles(outputRoot)) {
    const bytes = await readFile(contained(outputRoot, path));
    assert(bytes.length > 0, `Empty Context payload file: ${path}`);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = {
    schemaVersion: 1,
    target: { platform: "win32", arch: "x64" },
    model: modelId,
    revision,
    runtime: { transformers: "4.2.0", onnx: "1.24.3", sharp: "0.35.4" },
    tokenizer: { policy: "minilm-total-tokens-v1", totalTokens: 256 },
    dimension: 384,
    dtype: "q8",
    pooling: "mean",
    normalize: true,
    files,
  };
  await writeFile(
    resolve(outputRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      contextRuntime: "staged",
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      packages: packageRecords,
    }),
  );
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv[2], "acquire");
  await acquireContextAssets();
}

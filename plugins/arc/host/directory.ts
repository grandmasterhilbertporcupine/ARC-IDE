import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  directoryInventoryLimits,
  directoryRootSchema,
  directoryStateSchema,
  type DirectoryBinding,
  type DirectoryErrorCode,
  type DirectoryRoot,
  type DirectoryState,
  type ProjectSourceKind,
} from "../host-directory-contract.js";
import { canonicalPath, containedPath, git, samePath } from "./git.js";

export class DirectoryFailure extends Error {
  constructor(
    readonly code: DirectoryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DirectoryFailure";
  }
}

const fileEntrySchema = z
  .object({
    kind: z.literal("file"),
    path: z.string(),
    mode: z.number().int(),
    bytes: z.number().int().nonnegative(),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
const directoryEntrySchema = z
  .object({
    kind: z.literal("directory"),
    path: z.string(),
    mode: z.number().int(),
  })
  .strict();
export const directoryManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z.discriminatedUnion("kind", [fileEntrySchema, directoryEntrySchema]),
    ),
  })
  .strict();
export type DirectoryManifest = z.infer<typeof directoryManifestSchema>;
export type DirectoryInventory = {
  state: DirectoryState;
  manifest: DirectoryManifest;
  manifestJson: string;
};
type InventoryLimits = { [K in keyof typeof directoryInventoryLimits]: number };

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function statPath(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function identity(stat: BigIntStats): DirectoryRoot["rootIdentity"] {
  if (stat.ino <= 0n || stat.dev < 0n)
    throw new DirectoryFailure(
      "unsupported_entry",
      "The filesystem does not expose a stable directory identity.",
    );
  return { deviceId: stat.dev.toString(), fileId: stat.ino.toString() };
}

function statIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function changed(path: string): never {
  throw new DirectoryFailure(
    "directory_changed",
    `Entry changed during inspection or copying: ${path}`,
  );
}

async function checkedPath(path: string, stat: BigIntStats): Promise<void> {
  if (stat.isSymbolicLink())
    throw new DirectoryFailure(
      "unsupported_link",
      `Links and junctions are not supported: ${path}`,
    );
  if (!stat.isFile() && !stat.isDirectory())
    throw new DirectoryFailure(
      "unsupported_entry",
      `Only regular files and directories are supported: ${path}`,
    );
  if (!samePath(await realpath(path), path))
    throw new DirectoryFailure(
      "unsupported_link",
      `A redirected filesystem entry is not supported: ${path}`,
    );
}

export async function inspectDirectoryRoot(
  path: string,
): Promise<DirectoryRoot> {
  if (!isAbsolute(path))
    throw new DirectoryFailure(
      "invalid_path",
      `Directory path must be absolute: ${path}`,
    );
  const input = resolve(path);
  const stat = await statPath(input);
  for (let parent = input; ; parent = dirname(parent)) {
    const current = samePath(parent, input) ? stat : await statPath(parent);
    if (current.isSymbolicLink())
      throw new DirectoryFailure(
        "unsupported_link",
        `Links and junctions are not supported: ${parent}`,
      );
    if (dirname(parent) === parent) break;
  }
  if (!stat.isDirectory())
    throw new DirectoryFailure("invalid_path", `Expected a directory: ${path}`);
  const canonical = await canonicalPath(path);
  const after = await statPath(canonical);
  await checkedPath(canonical, after);
  if (statIdentity(stat) !== statIdentity(after)) changed(path);
  return directoryRootSchema.parse({
    kind: "directory",
    path: canonical,
    rootIdentity: identity(after),
  });
}

export function sameDirectoryRoot(a: DirectoryRoot, b: DirectoryRoot): boolean {
  return (
    samePath(a.path, b.path) &&
    a.rootIdentity.deviceId === b.rootIdentity.deviceId &&
    a.rootIdentity.fileId === b.rootIdentity.fileId
  );
}

export function sameDirectoryState(
  a: DirectoryState,
  b: DirectoryState,
): boolean {
  return (
    sameDirectoryRoot(a, b) &&
    a.manifestDigest === b.manifestDigest &&
    a.entryCount === b.entryCount &&
    a.fileBytes === b.fileBytes
  );
}

export function verifyDirectoryBinding(
  state: DirectoryState,
  binding: DirectoryRoot | DirectoryBinding,
): void {
  if (
    !sameDirectoryRoot(state, binding) ||
    ("expectedManifestDigest" in binding &&
      state.manifestDigest !== binding.expectedManifestDigest)
  )
    throw new DirectoryFailure(
      "directory_changed",
      `Directory identity or manifest changed: ${binding.path}`,
    );
}

async function gitMetadata(path: string): Promise<boolean> {
  if (
    await lstat(join(path, ".git")).then(
      () => true,
      (error) => {
        if (missing(error)) return false;
        throw error;
      },
    )
  )
    return true;
  const entries = await Promise.all(
    ["HEAD", "objects", "refs"].map((name) =>
      lstat(join(path, name)).then(
        () => true,
        (error) => {
          if (missing(error)) return false;
          throw error;
        },
      ),
    ),
  );
  return entries.every(Boolean);
}

export async function requireDirectorySource(
  path: string,
  signal: AbortSignal,
): Promise<DirectoryRoot> {
  signal.throwIfAborted();
  const root = await inspectDirectoryRoot(path);
  for (let parent = root.path; ; parent = dirname(parent)) {
    signal.throwIfAborted();
    if (await gitMetadata(parent))
      throw new DirectoryFailure(
        "git_source",
        `Git metadata is not supported in a directory source: ${parent}`,
      );
    if (dirname(parent) === parent) break;
  }
  signal.throwIfAborted();
  return root;
}

export async function inspectProjectSource(
  path: string,
  signal: AbortSignal,
): Promise<ProjectSourceKind> {
  signal.throwIfAborted();
  const canonical = await canonicalPath(path);
  if (!(await statPath(canonical)).isDirectory())
    throw new DirectoryFailure(
      "invalid_path",
      `Expected a project directory: ${path}`,
    );
  const root = { path: canonical };
  let metadata = false;
  for (let parent = root.path; ; parent = dirname(parent)) {
    signal.throwIfAborted();
    if (await gitMetadata(parent)) {
      metadata = true;
      break;
    }
    if (dirname(parent) === parent) break;
  }
  const result = await git(
    root.path,
    [
      "rev-parse",
      "--is-inside-work-tree",
      "--is-bare-repository",
      "--is-inside-git-dir",
    ],
    signal,
  );
  signal.throwIfAborted();
  if (result.exitCode === 0 && !result.truncated && !result.interrupted) {
    const flags = result.stdout.trim().split(/\r?\n/u);
    if (
      flags.length === 3 &&
      flags.every((flag) => flag === "true" || flag === "false") &&
      flags.includes("true")
    )
      return { kind: "git", path: root.path };
    throw new DirectoryFailure(
      "io_error",
      `Git returned an unexpected source-kind result for ${root.path}`,
    );
  }
  if (
    result.exitCode === 128 &&
    !metadata &&
    !result.truncated &&
    !result.interrupted &&
    /not a git repository/iu.test(result.stderr)
  ) {
    const directory = await inspectDirectoryRoot(path);
    return { kind: "directory", path: directory.path };
  }
  throw new DirectoryFailure(
    "io_error",
    `Unable to determine project source kind: ${root.path}: ${result.stderr || result.stdout}`,
  );
}

async function inventoryDirectory(
  path: string,
  signal: AbortSignal,
  limits: InventoryLimits,
): Promise<DirectoryInventory> {
  signal.throwIfAborted();
  const root = await inspectDirectoryRoot(path);
  const entries: DirectoryManifest["entries"] = [];
  let fileBytes = 0;
  let encodedBytes = 28;
  const append = (entry: DirectoryManifest["entries"][number]) => {
    encodedBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (
      entries.length >= limits.maxEntries ||
      encodedBytes > limits.maxManifestBytes
    )
      throw new DirectoryFailure(
        "inventory_limit",
        `Directory inventory exceeds its entry or manifest limit at ${entry.path}`,
      );
    entries.push(entry);
  };
  const visit = async (
    absolute: string,
    relative: string,
    depth: number,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (depth > limits.maxDepth || Buffer.byteLength(relative) > 32_768)
      throw new DirectoryFailure(
        "inventory_limit",
        `Directory nesting or path limit exceeded: ${absolute}`,
      );
    const before = await statPath(absolute);
    await checkedPath(absolute, before);
    if (before.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      if (
        names.some((name) => name.toLowerCase() === ".git") ||
        (names.includes("HEAD") &&
          names.includes("objects") &&
          names.includes("refs"))
      )
        throw new DirectoryFailure(
          "git_source",
          `Git metadata is not supported in a directory candidate: ${absolute}`,
        );
      append({
        kind: "directory",
        path: relative,
        mode: Number(before.mode & 0o777n),
      });
      for (const name of names) {
        if (name === "." || name === "..")
          throw new DirectoryFailure(
            "invalid_path",
            `Invalid directory entry: ${absolute}`,
          );
        const child = containedPath(root.path, join(absolute, name));
        await visit(
          child,
          relative === "." ? name : `${relative}/${name}`,
          depth + 1,
        );
      }
    } else {
      if (
        before.size > BigInt(limits.maxFileBytes) ||
        before.size > BigInt(limits.maxTotalBytes - fileBytes)
      )
        throw new DirectoryFailure(
          "inventory_limit",
          `File byte limit exceeded: ${absolute}`,
        );
      const file = await open(absolute, constants.O_RDONLY);
      try {
        if (
          statIdentity(await file.stat({ bigint: true })) !==
          statIdentity(before)
        )
          changed(absolute);
        const hash = createHash("sha256");
        let bytes = 0;
        const chunk = Buffer.allocUnsafe(256 * 1024);
        while (true) {
          signal.throwIfAborted();
          const read = await file.read(chunk, 0, chunk.length, null);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
          if (
            bytes > limits.maxFileBytes ||
            fileBytes + bytes > limits.maxTotalBytes
          )
            throw new DirectoryFailure(
              "inventory_limit",
              `File grew beyond its byte limit: ${absolute}`,
            );
          hash.update(chunk.subarray(0, read.bytesRead));
        }
        if (
          BigInt(bytes) !== before.size ||
          statIdentity(await file.stat({ bigint: true })) !==
            statIdentity(before)
        )
          changed(absolute);
        fileBytes += bytes;
        append({
          kind: "file",
          path: relative,
          mode: Number(before.mode & 0o777n),
          bytes,
          contentDigest: hash.digest("hex"),
        });
      } finally {
        await file.close();
      }
    }
    const after = await statPath(absolute);
    await checkedPath(absolute, after);
    if (statIdentity(before) !== statIdentity(after)) changed(absolute);
  };
  await visit(root.path, ".", 0);
  const afterRoot = await inspectDirectoryRoot(root.path);
  if (!sameDirectoryRoot(root, afterRoot)) changed(path);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: DirectoryManifest = { version: 1, entries };
  const manifestJson = JSON.stringify(manifest);
  if (Buffer.byteLength(manifestJson) > limits.maxManifestBytes)
    throw new DirectoryFailure(
      "inventory_limit",
      `Manifest byte limit exceeded: ${path}`,
    );
  const manifestDigest = createHash("sha256")
    .update(manifestJson)
    .digest("hex");
  return {
    state: directoryStateSchema.parse({
      ...root,
      manifestDigest,
      entryCount: entries.length,
      fileBytes,
    }),
    manifest,
    manifestJson,
  };
}

export async function scanDirectory(
  path: string,
  signal: AbortSignal,
  limits: InventoryLimits = directoryInventoryLimits,
): Promise<DirectoryInventory> {
  const first = await inventoryDirectory(path, signal, limits);
  const second = await inventoryDirectory(path, signal, limits);
  if (!sameDirectoryState(first.state, second.state)) changed(path);
  return second;
}

export async function copyDirectory(
  source: DirectoryInventory,
  destination: string,
  signal: AbortSignal,
  beforeMutation: () => void,
): Promise<DirectoryInventory> {
  signal.throwIfAborted();
  const exists = await lstat(destination).then(
    () => true,
    (error) => {
      if (missing(error)) return false;
      throw error;
    },
  );
  if (exists)
    throw new DirectoryFailure(
      "destination_exists",
      `Directory destination already exists: ${destination}`,
    );
  const sourceRoot = await inspectDirectoryRoot(source.state.path);
  if (!sameDirectoryRoot(sourceRoot, source.state)) changed(source.state.path);
  beforeMutation();
  await mkdir(destination);
  const root = await inspectDirectoryRoot(destination);
  const checkParent = async (path: string) => {
    signal.throwIfAborted();
    if (!sameDirectoryRoot(await inspectDirectoryRoot(root.path), root))
      changed(root.path);
    let parent = dirname(path);
    while (!samePath(parent, root.path)) {
      containedPath(root.path, parent);
      const stat = await statPath(parent);
      await checkedPath(parent, stat);
      if (!stat.isDirectory()) changed(parent);
      parent = dirname(parent);
    }
  };
  for (const entry of source.manifest.entries) {
    signal.throwIfAborted();
    if (entry.path === ".") continue;
    const segments = entry.path.split("/");
    const from = containedPath(
      source.state.path,
      resolve(source.state.path, ...segments),
    );
    const to = containedPath(root.path, resolve(root.path, ...segments));
    await checkParent(to);
    const before = await statPath(from);
    await checkedPath(from, before);
    if (entry.kind === "directory") {
      if (!before.isDirectory()) changed(from);
      beforeMutation();
      await mkdir(to);
      continue;
    }
    if (
      !before.isFile() ||
      before.size !== BigInt(entry.bytes) ||
      Number(before.mode & 0o777n) !== entry.mode
    )
      changed(from);
    const input = await open(from, constants.O_RDONLY);
    try {
      if (
        statIdentity(await input.stat({ bigint: true })) !==
        statIdentity(before)
      )
        changed(from);
      beforeMutation();
      const output = await open(to, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        const chunk = Buffer.allocUnsafe(256 * 1024);
        while (true) {
          signal.throwIfAborted();
          const read = await input.read(chunk, 0, chunk.length, null);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
          if (bytes > entry.bytes) changed(from);
          const part = chunk.subarray(0, read.bytesRead);
          hash.update(part);
          let written = 0;
          while (written < part.length) {
            signal.throwIfAborted();
            beforeMutation();
            const count = (
              await output.write(part, written, part.length - written, null)
            ).bytesWritten;
            if (count === 0)
              throw new DirectoryFailure(
                "io_error",
                `File write made no progress: ${to}`,
              );
            written += count;
          }
        }
        if (
          bytes !== entry.bytes ||
          hash.digest("hex") !== entry.contentDigest ||
          statIdentity(await input.stat({ bigint: true })) !==
            statIdentity(before)
        )
          changed(from);
        await checkParent(to);
        if (
          statIdentity(await output.stat({ bigint: true })) !==
          statIdentity(await statPath(to))
        )
          changed(to);
        await output.sync();
        await output.chmod(entry.mode);
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
    const after = await statPath(from);
    await checkedPath(from, after);
    if (statIdentity(before) !== statIdentity(after)) changed(from);
  }
  for (const entry of [...source.manifest.entries].reverse()) {
    if (entry.kind !== "directory") continue;
    signal.throwIfAborted();
    beforeMutation();
    const path =
      entry.path === "."
        ? root.path
        : containedPath(
            root.path,
            resolve(root.path, ...entry.path.split("/")),
          );
    if (entry.path !== ".") await checkParent(path);
    await checkedPath(path, await statPath(path));
    await chmod(path, entry.mode);
  }
  const copied = await scanDirectory(root.path, signal);
  const sourceAfter = await scanDirectory(source.state.path, signal);
  if (
    copied.state.manifestDigest !== source.state.manifestDigest ||
    !sameDirectoryState(source.state, sourceAfter.state)
  )
    changed(source.state.path);
  return copied;
}

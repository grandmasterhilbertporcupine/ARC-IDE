import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { HostContextStatus } from "../../host-context-contract.js";
import { hostContextLimits } from "../../host-context-contract.js";
import type { DirectoryRoot } from "../../host-directory-contract.js";
import { containedPath, git, samePath } from "../git.js";
import { hashText } from "./store.js";

const excludedDirectories = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  ".yarn",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "target",
  "release",
]);
const textExtensions = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".rst",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".jsonc",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".svg",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".csv",
  ".sql",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".fs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".vue",
  ".svelte",
  ".graphql",
  ".gql",
  ".proto",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".clj",
  ".cljs",
  ".scala",
  ".r",
  ".lua",
  ".dart",
  ".tex",
]);
const textNames = new Set([
  "dockerfile",
  "makefile",
  "cmakelists.txt",
  "license",
  "licence",
  "readme",
  "gitignore",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
]);
const sensitiveNames = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
]);

export class SourceReadFailure extends Error {
  constructor(
    readonly code: string,
    readonly size = 0,
  ) {
    super(code);
  }
}
export type ScanEntry = {
  path: string;
  name: string;
  reason: string | null;
  directory: boolean;
};
const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export async function* walkTextRoot(
  root: DirectoryRoot,
  signal: AbortSignal,
  subpath: string | null = null,
): AsyncGenerator<ScanEntry> {
  async function* visit(
    path: string,
    depth: number,
  ): AsyncGenerator<ScanEntry> {
    signal.throwIfAborted();
    let folder;
    try {
      folder = await opendir(path);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for await (const entry of folder) {
      signal.throwIfAborted();
      const child = join(path, entry.name);
      const suffix = relative(root.path, child).split(sep).join("/");
      let stat;
      try {
        stat = await lstat(child);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      let reason: string | null = null;
      if (stat.isSymbolicLink()) reason = "link_or_junction";
      else if (
        stat.isDirectory() &&
        excludedDirectories.has(entry.name.toLowerCase())
      )
        reason = "excluded_directory";
      else if (stat.isDirectory() && depth >= hostContextLimits.maxDepth)
        reason = "depth_limit";
      else if (!stat.isDirectory() && !stat.isFile())
        reason = "unsupported_entry";
      if (stat.isDirectory() && !reason) yield* visit(child, depth + 1);
      else
        yield {
          path: suffix,
          name: suffix,
          reason,
          directory: stat.isDirectory(),
        };
      await yieldTurn();
    }
  }
  if (subpath !== null) {
    const path = containedPath(root.path, resolve(root.path, subpath));
    const stat = await lstat(path);
    if (stat.isDirectory()) yield* visit(path, subpath.split("/").length);
    else
      yield {
        path: subpath,
        name: subpath,
        reason: stat.isSymbolicLink() ? "link_or_junction" : null,
        directory: false,
      };
  } else yield* visit(root.path, 0);
}

export function textSkipReason(path: string): string | null {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (sensitiveNames.has(name) || name.startsWith(".env."))
    return "credential_configuration";
  if (
    path.split("/").some((part) => excludedDirectories.has(part.toLowerCase()))
  )
    return "excluded_directory";
  if (textExtensions.has(extname(name)) || textNames.has(name)) return null;
  return "unsupported_format";
}

export async function verifyRoot(root: DirectoryRoot): Promise<void> {
  for (let path = root.path; ; path = dirname(path)) {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new SourceReadFailure("root_identity_changed");
    if (
      path === root.path &&
      (stat.dev.toString() !== root.rootIdentity.deviceId ||
        stat.ino.toString() !== root.rootIdentity.fileId)
    )
      throw new SourceReadFailure("root_identity_changed");
    if (dirname(path) === path) break;
  }
  if (!samePath(await realpath(root.path), root.path))
    throw new SourceReadFailure("root_identity_changed");
  const after = await lstat(root.path, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev.toString() !== root.rootIdentity.deviceId ||
    after.ino.toString() !== root.rootIdentity.fileId
  )
    throw new SourceReadFailure("root_identity_changed");
}

export async function readSourceText(
  root: DirectoryRoot,
  suffix: string,
  signal: AbortSignal,
): Promise<{ text: string; sha: string; size: number }> {
  signal.throwIfAborted();
  await verifyRoot(root);
  const path = containedPath(root.path, resolve(root.path, suffix));
  for (
    let parent = dirname(path);
    !samePath(parent, root.path);
    parent = dirname(parent)
  ) {
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new SourceReadFailure("link_or_junction");
    containedPath(root.path, parent);
  }
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !samePath(await realpath(path), path))
    throw new SourceReadFailure("link_or_junction");
  if (!before.isFile()) throw new SourceReadFailure("unsupported_entry");
  const size = Number(before.size);
  if (size > hostContextLimits.maxFileBytes)
    throw new SourceReadFailure("file_size_limit", size);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      throw new SourceReadFailure("source_changed");
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      offset !== size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink() ||
      !samePath(await realpath(path), path)
    )
      throw new SourceReadFailure("source_changed");
    await verifyRoot(root);
    const content = bytes.subarray(0, size);
    if (content.includes(0))
      throw new SourceReadFailure("binary_content", size);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        content,
      );
    } catch {
      throw new SourceReadFailure("invalid_utf8", size);
    }
    return { text, sha: hashText(content), size };
  } finally {
    await handle.close();
  }
}

export async function inspectContextGit(
  path: string,
  signal: AbortSignal,
): Promise<HostContextStatus["git"]> {
  const result = await git(
    path,
    [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    signal,
    16_384,
  );
  signal.throwIfAborted();
  if (result.exitCode !== 0) return null;
  if (result.truncated || result.interrupted)
    throw new SourceReadFailure("git_identity_unavailable");
  const lines = result.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 3 || !lines[0] || !lines[1] || !lines[2])
    throw new SourceReadFailure("git_identity_unavailable");
  const head = await git(path, ["rev-parse", "--verify", "HEAD"], signal, 4096);
  signal.throwIfAborted();
  if (head.truncated || head.interrupted)
    throw new SourceReadFailure("git_identity_unavailable");
  return {
    topLevel: await realpath(lines[0]),
    gitDir: await realpath(lines[1]),
    commonGitDir: await realpath(lines[2]),
    head: head.exitCode === 0 ? head.stdout.trim() : null,
  };
}

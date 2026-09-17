import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  HostWorkspaceBinding,
  HostWorkspaceState,
  HostProcessReceipt,
} from "../host-contract.js";
import { MAX_NATIVE_CAPTURE_BYTES, runNativeProcess } from "./process.js";

export function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

export function containedPath(root: string, path: string): string {
  const suffix = relative(root, path);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  )
    throw new Error("Workspace path is outside its owned root.");
  return resolve(path);
}

export async function canonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("Native workspace paths must be absolute.");
  if (
    process.platform === "win32" &&
    !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(path)
  )
    throw new Error(
      "Windows workspace paths must include an explicit drive or UNC share.",
    );
  return await realpath(path);
}

export async function git(
  path: string,
  args: string[],
  signal: AbortSignal,
  captureLimitBytes?: number,
): Promise<HostProcessReceipt> {
  return await runNativeProcess(
    {
      executable: "git",
      args: ["-C", path, ...args],
      cwd: path,
      signal,
      timeoutMs: 30_000,
    },
    captureLimitBytes,
  );
}

export async function gitInventory(
  path: string,
  args: string[],
  signal: AbortSignal,
  captureLimitBytes = MAX_NATIVE_CAPTURE_BYTES,
): Promise<HostProcessReceipt> {
  const result = await git(path, args, signal, captureLimitBytes);
  if (result.truncated)
    throw new Error(
      `Git workspace inventory exceeds the ${captureLimitBytes}-byte inspection limit.`,
    );
  if (result.exitCode !== 0 || result.interrupted)
    throw new Error(
      `Git workspace inventory failed: ${result.stderr.slice(0, 4096)}`,
    );
  return result;
}

function text(result: HostProcessReceipt): string {
  if (result.exitCode !== 0 || result.interrupted || result.truncated)
    throw new Error(`Git inspection failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const hash = (...values: string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

export async function inspectWorkspace(
  path: string,
  signal: AbortSignal,
): Promise<HostWorkspaceState> {
  path = await canonicalPath(path);
  const topLevel = await canonicalPath(
    text(await git(path, ["rev-parse", "--show-toplevel"], signal)),
  );
  const gitDir = await canonicalPath(
    text(await git(path, ["rev-parse", "--absolute-git-dir"], signal)),
  );
  const commonGitDir = await canonicalPath(
    text(
      await git(
        path,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      ),
    ),
  );
  const head = text(await git(path, ["rev-parse", "--verify", "HEAD"], signal));
  const branch = await git(
    path,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    signal,
  );
  if (branch.exitCode !== 0 && branch.exitCode !== 1) text(branch);
  const status = await gitInventory(
    path,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  const tracked = await git(path, ["diff", "--binary", "HEAD", "--"], signal);
  const staged = await git(
    path,
    ["diff", "--cached", "--binary", "HEAD", "--"],
    signal,
  );
  if (tracked.exitCode !== 0 || staged.exitCode !== 0)
    throw new Error("Unable to inspect tracked workspace state.");
  const untracked = await gitInventory(
    path,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    signal,
  );
  const untrackedHash = createHash("sha256");
  for (const file of untracked.stdout.split("\0").filter(Boolean).sort()) {
    signal.throwIfAborted();
    const absolute = containedPath(topLevel, resolve(topLevel, file));
    const stat = await lstat(absolute);
    untrackedHash.update(JSON.stringify([file, stat.mode]));
    if (stat.isSymbolicLink()) untrackedHash.update(await readlink(absolute));
    else if (stat.isFile()) {
      containedPath(topLevel, await canonicalPath(absolute));
      for await (const chunk of createReadStream(absolute)) {
        signal.throwIfAborted();
        untrackedHash.update(chunk);
      }
    } else throw new Error("Unexpected untracked workspace entry.");
    untrackedHash.update("\0");
  }
  const trackedDigest = hash(tracked.stdoutDigest, staged.stdoutDigest);
  const untrackedDigest = untrackedHash.digest("hex");
  const files = await gitInventory(
    path,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    signal,
  );
  const contentHash = createHash("sha256");
  for (const file of [
    ...new Set(files.stdout.split("\0").filter(Boolean)),
  ].sort()) {
    signal.throwIfAborted();
    const absolute = containedPath(topLevel, resolve(topLevel, file));
    const stat = await lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    contentHash.update(JSON.stringify([file, stat.mode]));
    if (stat.isSymbolicLink()) contentHash.update(await readlink(absolute));
    else if (stat.isFile()) {
      containedPath(topLevel, await canonicalPath(absolute));
      for await (const chunk of createReadStream(absolute)) {
        signal.throwIfAborted();
        contentHash.update(chunk);
      }
    } else
      throw new Error(
        "Nested repositories and non-file workspace entries require explicit review.",
      );
    contentHash.update("\0");
  }
  const contentDigest = contentHash.digest("hex");
  return {
    path,
    topLevel,
    gitDir,
    commonGitDir,
    head,
    currentBranch: branch.exitCode === 0 ? text(branch) : null,
    clean: status.stdoutBytes === 0,
    trackedDigest,
    untrackedDigest,
    contentDigest,
    stateDigest: hash(
      head,
      status.stdoutDigest,
      trackedDigest,
      untrackedDigest,
      contentDigest,
    ),
  };
}

export async function verifyBinding(
  state: HostWorkspaceState,
  binding: HostWorkspaceBinding,
  signal: AbortSignal,
): Promise<void> {
  const expectedPath = await canonicalPath(binding.path);
  const expectedCommon = await canonicalPath(binding.commonGitDir);
  const originalPath = await canonicalPath(binding.originalPath);
  const originalCommon = await canonicalPath(
    text(
      await git(
        originalPath,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      ),
    ),
  );
  if (
    !samePath(state.path, expectedPath) ||
    !samePath(state.topLevel, expectedPath) ||
    !samePath(state.commonGitDir, expectedCommon) ||
    !samePath(state.commonGitDir, originalCommon)
  )
    throw new Error("Workspace repository or worktree identity changed.");
  if (state.head !== binding.expectedHead)
    throw new Error("Workspace HEAD moved from the expected revision.");
  if (
    binding.expectedStateDigest !== null &&
    state.stateDigest !== binding.expectedStateDigest
  )
    throw new Error("Workspace files changed from the expected state.");
}

export function sameState(
  a: HostWorkspaceState,
  b: HostWorkspaceState,
): boolean {
  return (
    samePath(a.path, b.path) &&
    samePath(a.gitDir, b.gitDir) &&
    samePath(a.commonGitDir, b.commonGitDir) &&
    a.head === b.head &&
    a.stateDigest === b.stateDigest
  );
}

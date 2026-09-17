import path from "node:path";
import {
  getProjectPathValidationMessage,
  isAbsoluteProjectPath,
  isNativeWindowsProjectPath,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

const REPO_DIR_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export function deriveRepoDirName(sourcePath: string): string {
  const localPath = isAbsoluteProjectPath(sourcePath);
  const pathApi = isNativeWindowsProjectPath(sourcePath)
    ? path.win32
    : path.posix;
  const trimmed = sourcePath.replace(
    localPath && pathApi === path.win32 ? /[\\/]+$/ : /\/+$/,
    "",
  );

  const scpMatch = /^[^:/]+@[^:]+:(?<path>.+)$/.exec(trimmed);
  const pathPart =
    scpMatch?.groups?.path ?? tryParseUrlPath(trimmed) ?? trimmed;

  const basename = pathApi.basename(pathPart);
  const candidate = basename.endsWith(".git")
    ? basename.slice(0, -".git".length)
    : basename;

  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    (localPath
      ? getProjectPathValidationMessage(sourcePath) !== null ||
        /^[\s-]|[.\s]$|[<>:"/\\|?*\u0000-\u001f]/u.test(candidate) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(candidate)
      : !REPO_DIR_NAME_PATTERN.test(candidate))
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `Cannot derive repository directory name from source "${sourcePath}"`,
    );
  }
  return candidate;
}

function tryParseUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ssh:"
    ) {
      return url.pathname;
    }
  } catch {}
  return null;
}

interface ResolveManagedTargetPathArgs {
  dataDir: string;
  environmentId: string;
  sourcePath: string;
}

interface ResolvePersonalTargetPathArgs {
  dataDir: string;
  environmentId: string;
}

export function resolveManagedTargetPath(
  args: ResolveManagedTargetPathArgs,
): string {
  const pathApi = isNativeWindowsProjectPath(args.dataDir)
    ? path.win32
    : path.posix;
  return pathApi.join(
    args.dataDir,
    "worktrees",
    args.environmentId,
    deriveRepoDirName(args.sourcePath),
  );
}

export function resolvePersonalTargetPath(
  args: ResolvePersonalTargetPathArgs,
): string {
  const pathApi = isNativeWindowsProjectPath(args.dataDir)
    ? path.win32
    : path.posix;
  return pathApi.join(args.dataDir, "personal-workspaces", args.environmentId);
}

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  const pathApi = isNativeWindowsProjectPath(args.dataDir)
    ? path.win32
    : path.posix;
  return [
    pathApi.join(args.dataDir, "worktrees"),
    pathApi.join(args.dataDir, "personal-workspaces"),
  ].some((root) => {
    const relative = pathApi.relative(root, args.path);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${pathApi.sep}`) &&
        !pathApi.isAbsolute(relative))
    );
  });
}

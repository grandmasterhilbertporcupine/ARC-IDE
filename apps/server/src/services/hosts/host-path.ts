import path from "node:path";

function hostPathApi(value: string): path.PlatformPath {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
    ? path.win32
    : path.posix;
}

export function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function normalizeHostPath(value: string): string {
  return hostPathApi(value).normalize(value);
}

export function joinHostPath(rootPath: string, ...segments: string[]): string {
  return hostPathApi(rootPath).join(rootPath, ...segments);
}

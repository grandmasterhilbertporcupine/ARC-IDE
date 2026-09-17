const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]+$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:(?:[\\/]+)/u;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\/]+(?:[\\/]+)[^\\/]+/u;

export const INVALID_PROJECT_PATH_MESSAGE =
  "Project path must be an absolute path.";
export const PROJECT_PATH_ROOT_MESSAGE =
  "Project path must point to a project directory, not the filesystem root.";
const WINDOWS_UNC_ROOT_PATTERN = /^(?:\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+[\\/]*$/u;
const WINDOWS_DEVICE_PATH_PATTERN = /^(?:\\\\|\/\/)[?.][\\/]/u;

export function isNativeWindowsProjectPath(path: string): boolean {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return false;
  }

  return (
    WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmedPath) ||
    WINDOWS_UNC_PATH_PATTERN.test(trimmedPath)
  );
}

export function isAbsoluteProjectPath(path: string): boolean {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return false;
  }

  return (
    !WINDOWS_DEVICE_PATH_PATTERN.test(trimmedPath) &&
    (trimmedPath.startsWith("/") || isNativeWindowsProjectPath(trimmedPath))
  );
}

export function normalizeProjectPathInput(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "";
  }

  if (trimmedPath === "/" || WINDOWS_DRIVE_ROOT_PATTERN.test(trimmedPath)) {
    return trimmedPath;
  }

  return isNativeWindowsProjectPath(trimmedPath)
    ? trimmedPath.replace(/[\\/]+$/u, "")
    : trimmedPath.replace(/\/+$/u, "");
}

export function getProjectPathValidationMessage(path: string): string | null {
  const normalizedPath = normalizeProjectPathInput(path);
  if (!normalizedPath) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (
    !isAbsoluteProjectPath(normalizedPath) ||
    /[\u0000-\u001f]/u.test(normalizedPath)
  ) {
    return INVALID_PROJECT_PATH_MESSAGE;
  }
  if (
    normalizedPath === "/" ||
    WINDOWS_DRIVE_ROOT_PATTERN.test(normalizedPath) ||
    WINDOWS_UNC_ROOT_PATTERN.test(normalizedPath)
  ) {
    return PROJECT_PATH_ROOT_MESSAGE;
  }
  return null;
}

export function deriveProjectNameFromPath(path: string): string {
  const normalizedPath = normalizeProjectPathInput(path);
  if (
    !normalizedPath ||
    getProjectPathValidationMessage(normalizedPath) !== null
  ) {
    return "";
  }

  const segments = normalizedPath
    .split(isNativeWindowsProjectPath(normalizedPath) ? /[\\/]/u : "/")
    .filter(Boolean);
  return segments.at(-1) ?? "";
}

import { describe, expect, it } from "vitest";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  INVALID_PROJECT_PATH_MESSAGE,
  isAbsoluteProjectPath,
  isNativeWindowsProjectPath,
  normalizeProjectPathInput,
  PROJECT_PATH_ROOT_MESSAGE,
} from "../src/project-path.js";

describe("project-path", () => {
  it.each([
    ["/srv/repos/bb/", "bb"],
    ["/mnt/c/Users/me/WNDR IDE/", "WNDR IDE"],
    ["C:\\Users\\Collin Chen\\予測\\", "予測"],
    ["C:/Users/me/WNDR IDE/", "WNDR IDE"],
    ["\\\\server\\share\\forecast\\", "forecast"],
  ])("accepts project directories and derives names: %s", (input, name) => {
    expect(isAbsoluteProjectPath(input)).toBe(true);
    expect(getProjectPathValidationMessage(input)).toBeNull();
    expect(deriveProjectNameFromPath(input)).toBe(name);
  });

  it.each(["/", "C:\\", "D:/", "\\\\server\\share", "//server/share/"])(
    "rejects filesystem and share roots: %s",
    (input) => {
      expect(getProjectPathValidationMessage(input)).toBe(
        PROJECT_PATH_ROOT_MESSAGE,
      );
      expect(deriveProjectNameFromPath(input)).toBe("");
    },
  );

  it.each([
    "",
    "relative/path",
    "C:relative",
    "C:",
    "\\relative",
    "\\\\?\\C:\\secret",
    "\\\\.\\pipe\\name",
    "/repo\u0000name",
  ])("rejects ambiguous, relative, device, and control paths: %s", (input) => {
    expect(getProjectPathValidationMessage(input)).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
  });

  it("normalizes trailing native separators without converting absolute paths", () => {
    expect(normalizeProjectPathInput("C:\\Users\\me\\forecast\\")).toBe(
      "C:\\Users\\me\\forecast",
    );
    expect(normalizeProjectPathInput("/srv/forecast/")).toBe("/srv/forecast");
    expect(normalizeProjectPathInput("C:\\")).toBe("C:\\");
    expect(normalizeProjectPathInput("/")).toBe("/");
    expect(isNativeWindowsProjectPath("C:/Users/me/repo")).toBe(true);
    expect(isNativeWindowsProjectPath("/mnt/c/Users/me/repo")).toBe(false);
  });
});

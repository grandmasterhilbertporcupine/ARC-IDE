import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  deriveRepoDirName,
  isBbManagedWorkspacePath,
  resolveManagedTargetPath,
  resolvePersonalTargetPath,
} from "../../src/services/threads/worktree-paths.js";

describe("deriveRepoDirName", () => {
  it.each([
    ["local absolute path", "/Users/someone/code/my-repo", "my-repo"],
    [
      "local path with trailing slash",
      "/Users/someone/code/my-repo/",
      "my-repo",
    ],
    ["https URL", "https://github.com/octocat/Hello-World.git", "Hello-World"],
    ["ssh URL", "ssh://git@github.com/octocat/Hello-World.git", "Hello-World"],
    ["scp-style", "git@github.com:octocat/Hello-World.git", "Hello-World"],
    [
      "scp-style without .git",
      "git@github.com:octocat/Hello-World",
      "Hello-World",
    ],
    ["dotted name", "/Users/me/code/my.repo", "my.repo"],
    [
      "local spaces and Unicode",
      "/tmp/Native project Δ with spaces",
      "Native project Δ with spaces",
    ],
    [
      "Windows drive path",
      String.raw`B:\Collin's projects\Native project Δ with spaces`,
      "Native project Δ with spaces",
    ],
    [
      "Windows mixed separators",
      "B:\\projects/Native project Δ/",
      "Native project Δ",
    ],
    [
      "Windows UNC path",
      "\\\\server\\share\\Native project Δ\\",
      "Native project Δ",
    ],
  ])("derives %s", (_label, input, expected) => {
    expect(deriveRepoDirName(input)).toBe(expected);
  });

  it.each([
    ["root-only path", "/"],
    ["empty string", ""],
    ["bare .git", "/Users/me/code/.git"],
    ["parent traversal", "/Users/me/code/.."],
    ["current dir", "/Users/me/code/."],
    ["leading dash (could be interpreted as flag)", "/tmp/-dangerous"],
    ["Windows filesystem root", "C:\\"],
    ["UNC share root", "\\\\server\\share\\"],
    ["Windows reserved device name", String.raw`C:\projects\CON.txt`],
    ["Windows invalid filename", String.raw`C:\projects\bad:name`],
    ["trailing dot", "/tmp/project."],
    [
      "url with query parameter encoded into basename",
      "https://host/foo/bar.git;param=x",
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => deriveRepoDirName(input)).toThrowError(ApiError);
  });
});

describe("managed workspace paths", () => {
  it.each([
    {
      dataDir: "/home/user/.arc",
      sourcePath: "/projects/Native project Δ",
      managed: "/home/user/.arc/worktrees/env_123/Native project Δ",
      personal: "/home/user/.arc/personal-workspaces/env_123",
    },
    {
      dataDir: String.raw`C:\Users\Collin Chen\.arc`,
      sourcePath: String.raw`B:\projects\Native project Δ`,
      managed: String.raw`C:\Users\Collin Chen\.arc\worktrees\env_123\Native project Δ`,
      personal: String.raw`C:\Users\Collin Chen\.arc\personal-workspaces\env_123`,
    },
    {
      dataDir: String.raw`\\server\share\.arc`,
      sourcePath: String.raw`C:\projects\Native project Δ`,
      managed: String.raw`\\server\share\.arc\worktrees\env_123\Native project Δ`,
      personal: String.raw`\\server\share\.arc\personal-workspaces\env_123`,
    },
  ])(
    "uses the host path format for $dataDir",
    ({ dataDir, sourcePath, managed, personal }) => {
      expect(
        resolveManagedTargetPath({
          dataDir,
          sourcePath,
          environmentId: "env_123",
        }),
      ).toBe(managed);
      expect(
        resolvePersonalTargetPath({ dataDir, environmentId: "env_123" }),
      ).toBe(personal);
      expect(isBbManagedWorkspacePath({ dataDir, path: managed })).toBe(true);
      expect(isBbManagedWorkspacePath({ dataDir, path: personal })).toBe(true);
    },
  );

  it.each([
    [String.raw`c:\users\collin\.ARC\worktrees\env_123\project`, true],
    ["C:/Users/Collin/.arc/worktrees/env_123/project", true],
    [String.raw`C:\Users\Collin\.arc\worktrees-copy\project`, false],
    [String.raw`C:\Users\Collin\.arc\worktrees\..\..\.wndr\project`, false],
    [String.raw`D:\Users\Collin\.arc\worktrees\project`, false],
  ])("checks native Windows containment for %s", (candidate, expected) => {
    expect(
      isBbManagedWorkspacePath({
        dataDir: String.raw`C:\Users\Collin\.arc`,
        path: candidate,
      }),
    ).toBe(expected);
  });
});

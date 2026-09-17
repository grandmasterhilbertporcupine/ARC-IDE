import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  link,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyDirectory,
  directoryManifestSchema,
  inspectDirectoryRoot,
  inspectProjectSource,
  scanDirectory,
  verifyDirectoryBinding,
} from "./directory.js";
import { directoryInventoryLimits } from "../host-directory-contract.js";

const command = promisify(execFile);
let fixture: string;
let source: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "ARC directory 東京 '& "));
  source = join(fixture, "original");
  await mkdir(source);
});
afterEach(async () => {
  await rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});
const signal = () => AbortSignal.timeout(30_000);

describe("complete native directory inventory", () => {
  it("preserves hidden files, dependencies, empty entries and independent file bytes", async () => {
    await mkdir(join(source, ".config"));
    await mkdir(join(source, "empty"));
    await mkdir(join(source, "node_modules", "dependency"), {
      recursive: true,
    });
    await writeFile(join(source, ".config", "settings.json"), "{}");
    await writeFile(
      join(source, "node_modules", "dependency", "index.js"),
      "export default 1",
    );
    await writeFile(join(source, "zero"), "");
    const initial = await scanDirectory(source, signal());
    expect(
      directoryManifestSchema
        .parse(initial.manifest)
        .entries.map((entry) => entry.path),
    ).toEqual([
      ".",
      ".config",
      ".config/settings.json",
      "empty",
      "node_modules",
      "node_modules/dependency",
      "node_modules/dependency/index.js",
      "zero",
    ]);
    let mutations = 0;
    const copied = await copyDirectory(
      initial,
      join(fixture, "candidate"),
      signal(),
      () => {
        mutations++;
      },
    );
    expect(copied.state.manifestDigest).toBe(initial.state.manifestDigest);
    expect(copied.state.rootIdentity).not.toEqual(initial.state.rootIdentity);
    expect(mutations).toBeGreaterThan(0);
    await writeFile(
      join(copied.state.path, ".config", "settings.json"),
      "changed",
    );
    expect(
      await readFile(join(source, ".config", "settings.json"), "utf8"),
    ).toBe("{}");
    expect((await scanDirectory(source, signal())).state).toEqual(
      initial.state,
    );
  });

  it("detects equal-size edits, renames and deletes in the exact manifest", async () => {
    await writeFile(join(source, "file.txt"), "first");
    const initial = await scanDirectory(source, signal());
    await writeFile(join(source, "file.txt"), "other");
    const changed = await scanDirectory(source, signal());
    expect(changed.state.fileBytes).toBe(initial.state.fileBytes);
    expect(changed.state.manifestDigest).not.toBe(initial.state.manifestDigest);
    expect(() =>
      verifyDirectoryBinding(changed.state, {
        ...initial.state,
        workspaceId: "work",
        originalPath: source,
        expectedManifestDigest: initial.state.manifestDigest,
      }),
    ).toThrow("directory_changed");
    await rename(join(source, "file.txt"), join(source, "renamed.txt"));
    expect(
      (await scanDirectory(source, signal())).state.manifestDigest,
    ).not.toBe(changed.state.manifestDigest);
    await rm(join(source, "renamed.txt"));
    expect((await scanDirectory(source, signal())).state.entryCount).toBe(1);
  });

  it("rejects an internal pnpm-style junction without omitting it", async () => {
    await mkdir(join(source, "node_modules"));
    const target = join(fixture, "package-store");
    await mkdir(target);
    await writeFile(join(target, "index.js"), "original");
    await symlink(
      target,
      join(source, "node_modules", "dependency"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await expect(scanDirectory(source, signal())).rejects.toThrow(
        /unsupported_link.*dependency/u,
      );
      expect(await readFile(join(target, "index.js"), "utf8")).toBe("original");
    } finally {
      await unlink(join(source, "node_modules", "dependency"));
    }
  });

  it("rejects a redirected root and copies hardlinked source files independently", async () => {
    const target = join(fixture, "redirect");
    await symlink(
      source,
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(inspectDirectoryRoot(target)).rejects.toThrow(
      "unsupported_link",
    );
    await writeFile(join(source, "a"), "source");
    await link(join(source, "a"), join(source, "b"));
    const initial = await scanDirectory(source, signal());
    const copy = await copyDirectory(
      initial,
      join(fixture, "copy"),
      signal(),
      () => {},
    );
    await writeFile(join(copy.state.path, "a"), "output");
    expect(await readFile(join(copy.state.path, "b"), "utf8")).toBe("source");
    expect(await readFile(join(source, "a"), "utf8")).toBe("source");
  });

  it("rejects supported inventory limits rather than returning a partial manifest", async () => {
    await writeFile(join(source, "large"), "abcdef");
    await expect(
      scanDirectory(source, signal(), {
        ...directoryInventoryLimits,
        maxFileBytes: 5,
      }),
    ).rejects.toThrow(/inventory_limit.*large/u);
    await expect(
      scanDirectory(source, signal(), {
        ...directoryInventoryLimits,
        maxTotalBytes: 5,
      }),
    ).rejects.toThrow("inventory_limit");
    await expect(
      scanDirectory(source, signal(), {
        ...directoryInventoryLimits,
        maxEntries: 1,
      }),
    ).rejects.toThrow("inventory_limit");
    await expect(
      scanDirectory(source, signal(), {
        ...directoryInventoryLimits,
        maxManifestBytes: 25,
      }),
    ).rejects.toThrow("inventory_limit");
    await mkdir(join(source, "nested"));
    await expect(
      scanDirectory(source, signal(), {
        ...directoryInventoryLimits,
        maxDepth: 0,
      }),
    ).rejects.toThrow("inventory_limit");
  });

  it("retains a complete filename inventory beyond the public process output cap", async () => {
    const names = Array.from(
      { length: 750 },
      (_, index) =>
        `dependency-${String(index).padStart(4, "0")}-東京-${"x".repeat(70)}.js`,
    );
    for (let offset = 0; offset < names.length; offset += 50)
      await Promise.all(
        names
          .slice(offset, offset + 50)
          .map((name) => writeFile(join(source, name), "module.exports = 1")),
      );
    const inventory = await scanDirectory(source, signal());
    expect(Buffer.byteLength(inventory.manifestJson)).toBeGreaterThan(65_536);
    expect(inventory.state.entryCount).toBe(names.length + 1);
    expect(
      inventory.manifest.entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path),
    ).toEqual(names);
  });

  it("does not accept a copy when the source changed after its admitted scan", async () => {
    await writeFile(join(source, "a"), "first");
    const initial = await scanDirectory(source, signal());
    await writeFile(join(source, "a"), "other");
    await expect(
      copyDirectory(initial, join(fixture, "copy"), signal(), () => {}),
    ).rejects.toThrow("directory_changed");
    expect(await readFile(join(source, "a"), "utf8")).toBe("other");
  });

  it("rejects pre-existing destinations and a cancelled copy before any write", async () => {
    const initial = await scanDirectory(source, signal());
    await expect(
      copyDirectory(initial, source, signal(), () => {
        throw new Error("Must not mutate");
      }),
    ).rejects.toThrow("destination_exists");
    const abort = new AbortController();
    abort.abort();
    await expect(
      copyDirectory(initial, join(fixture, "cancelled"), abort.signal, () => {
        throw new Error("Must not mutate");
      }),
    ).rejects.toThrow();
    await expect(readFile(join(fixture, "cancelled"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("distinguishes plain directories, Git ancestors and invalid Git metadata", async () => {
    expect(await inspectProjectSource(source, signal())).toMatchObject({
      kind: "directory",
    });
    const alias = join(fixture, "source-alias");
    await symlink(
      source,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(inspectProjectSource(alias, signal())).rejects.toThrow(
      "unsupported_link",
    );
    await command("git", ["init", "--quiet", source], { windowsHide: true });
    expect(await inspectProjectSource(alias, signal())).toEqual({
      kind: "git",
      path: (await inspectDirectoryRoot(source)).path,
    });
    await mkdir(join(source, "subfolder"));
    expect(
      await inspectProjectSource(join(source, "subfolder"), signal()),
    ).toMatchObject({ kind: "git" });
    await expect(scanDirectory(source, signal())).rejects.toThrow("git_source");
    const invalid = join(fixture, "invalid");
    await mkdir(invalid);
    await writeFile(join(invalid, ".git"), "not a valid git link");
    await expect(inspectProjectSource(invalid, signal())).rejects.toThrow(
      "io_error",
    );
  });
});

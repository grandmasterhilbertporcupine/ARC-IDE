import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginDevLoop } from "./plugin-dev-loop.js";
import { createPluginSourceChangeFilter } from "./plugin-source-changes.js";

describe("plugin source content changes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-plugin-source-changes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("suppresses access and timestamp changes but detects equal-size content with restored mtime", async () => {
    const file = join(root, "server.ts");
    await writeFile(file, "before");
    await utimes(file, new Date("2020-01-01"), new Date("2024-01-01"));
    const initial = await stat(file);
    const filter = await createPluginSourceChangeFilter(root);

    await utimes(file, new Date("2020-01-01"), initial.mtime);
    const beforeRead = await stat(file, { bigint: true });
    await readFile(file);
    const afterRead = await stat(file, { bigint: true });
    expect(afterRead.ctimeNs).toBe(beforeRead.ctimeNs);
    expect(afterRead.mtimeNs).toBe(beforeRead.mtimeNs);
    expect(afterRead.atimeNs).toBeGreaterThanOrEqual(beforeRead.atimeNs);
    expect(await filter(["server.ts"])).toEqual([]);
    expect(await filter(["."])).toEqual([]);

    await writeFile(file, "after!");
    await utimes(file, initial.atime, initial.mtime);
    expect((await stat(file)).size).toBe(initial.size);
    expect((await stat(file)).mtimeMs).toBe(initial.mtimeMs);
    expect(await filter(["server.ts"])).toEqual(["server.ts"]);
    expect(await filter(["server.ts"])).toEqual([]);
  });

  it("tracks created files, renames, and deleted subtrees through unnamed notifications", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "before.ts"), "export {};");
    const filter = await createPluginSourceChangeFilter(root);

    await rename(join(root, "src", "before.ts"), join(root, "src", "after.ts"));
    expect(await filter(["."])).toEqual([
      join("src", "after.ts"),
      join("src", "before.ts"),
    ]);
    await mkdir(join(root, "src", "nested"));
    await writeFile(join(root, "src", "nested", "new.ts"), "new");
    expect(await filter(["src"])).toEqual([
      join("src", "nested"),
      join("src", "nested", "new.ts"),
    ]);
    await rm(join(root, "src"), { recursive: true });
    expect(await filter(["src"])).toEqual([
      "src",
      join("src", "after.ts"),
      join("src", "nested"),
      join("src", "nested", "new.ts"),
    ]);
    expect(await filter(["."])).toEqual([]);
  });

  it("does not resurface ignored build outputs during a parent directory scan", async () => {
    const filter = await createPluginSourceChangeFilter(root);
    for (const name of ["dist", "node_modules", ".git"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "generated.js"), "generated");
    }
    expect(await filter([".", "dist", "../outside.ts"])).toEqual([]);
    await writeFile(join(root, "app.tsx"), "app");
    expect(await filter(["."])).toEqual(["app.tsx"]);
  });

  it("initializes the real sources when the plugin directory is a symlink or junction", async () => {
    const sourceRoot = join(root, "plugin");
    const aliasRoot = join(root, "alias");
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "server.ts"), "before");
    await symlink(sourceRoot, aliasRoot, "junction");
    const filter = await createPluginSourceChangeFilter(aliasRoot);
    expect(await filter(["server.ts"])).toEqual([]);
    await writeFile(join(sourceRoot, "server.ts"), "after!");
    expect(await filter(["server.ts"])).toEqual(["server.ts"]);
  });

  it("retains one build and reload for a burst of actual source changes", async () => {
    await writeFile(join(root, "app.tsx"), "before");
    await writeFile(join(root, "server.ts"), "before");
    const calls: string[] = [];
    const lines: string[] = [];
    const loop = createPluginDevLoop({
      pluginId: "fixture",
      filterChanges: await createPluginSourceChangeFilter(root),
      debounceMs: 20,
      targets: async () => ({ hasApp: true, hasHost: false }),
      buildApp: async () => {
        calls.push("build");
      },
      buildHost: async () => {
        calls.push("host");
      },
      reloadPlugin: async () => {
        calls.push("reload");
      },
      log: (line) => {
        lines.push(line);
      },
    });
    try {
      await writeFile(join(root, "app.tsx"), "after!");
      await writeFile(join(root, "server.ts"), "after!");
      loop.handleChange("app.tsx");
      loop.handleChange("server.ts");
      loop.handleChange("app.tsx");
      await expect.poll(() => calls).toEqual(["build", "reload"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("2 files changed");

      await readFile(join(root, "app.tsx"));
      loop.handleChange("app.tsx");
      await sleep(50);
      await loop.settled();
      expect(calls).toEqual(["build", "reload"]);
      expect(lines).toHaveLength(1);
    } finally {
      loop.dispose();
      await loop.settled();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "settles real Windows access notifications and its own hash reads without reloading",
    async () => {
      const file = join(root, "server.ts");
      await writeFile(file, "before");
      const initial = await stat(file);
      let notifications = 0;
      let checks = 0;
      let reloads = 0;
      const lines: string[] = [];
      const filter = await createPluginSourceChangeFilter(root);
      const loop = createPluginDevLoop({
        pluginId: "native-fixture",
        filterChanges: async (paths) => {
          checks += 1;
          return filter(paths);
        },
        debounceMs: 20,
        targets: async () => ({ hasApp: false, hasHost: false }),
        buildApp: async () => {},
        buildHost: async () => {},
        reloadPlugin: async () => {
          reloads += 1;
        },
        log: (line) => {
          lines.push(line);
        },
      });
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        notifications += 1;
        loop.handleChange(filename || ".");
      });
      try {
        await utimes(file, new Date("2020-01-01"), initial.mtime);
        await readFile(file);
        await expect.poll(() => notifications).toBeGreaterThan(0);
        await expect.poll(() => checks).toBeGreaterThan(0);
        await sleep(200);
        const afterAccess = { notifications, checks };
        await sleep(200);
        expect({ notifications, checks }).toEqual(afterAccess);
        expect(reloads).toBe(0);
        expect(lines).toEqual([]);

        await writeFile(file, "after!");
        await utimes(file, new Date("2020-01-01"), initial.mtime);
        await expect.poll(() => reloads).toBe(1);
        await sleep(200);
        const afterWrite = { notifications, checks };
        await sleep(200);
        expect({ notifications, checks }).toEqual(afterWrite);
        expect(reloads).toBe(1);

        await rename(file, join(root, "renamed.ts"));
        await expect.poll(() => reloads).toBe(2);
        await rm(join(root, "renamed.ts"));
        await expect.poll(() => reloads).toBe(3);
        await writeFile(join(root, "created.ts"), "created");
        await expect.poll(() => reloads).toBe(4);
      } finally {
        watcher.close();
        loop.dispose();
        await loop.settled();
      }
    },
  );
});

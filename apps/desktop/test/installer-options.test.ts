import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { animationFile, bitmapFile } from "../scripts/installer-art.mjs";

const desktopRoot = process.cwd();
const require = createRequire(resolve(desktopRoot, "package.json"));
const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "electron-builder",
    "Cache",
  );

function cachedDirectory(
  prefix: string,
  requiredFile: string,
): string | undefined {
  if (process.platform !== "win32" || !existsSync(cacheRoot)) return undefined;
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const directory = join(cacheRoot, entry.name);
    if (existsSync(join(directory, requiredFile))) return directory;
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(directory, child.name);
      if (existsSync(join(nested, requiredFile))) return nested;
    }
  }
  return undefined;
}

const compilerRoot = cachedDirectory("nsis-", join("Bin", "makensis.exe"));
const pluginsRoot = cachedDirectory(
  "nsis-resources-",
  join("plugins", "x86-unicode", "WinShell.dll"),
);

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${executable} exited ${result.status}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

describe.skipIf(!compilerRoot || !pluginsRoot)(
  "native Windows installer options (requires cached NSIS compiler and plugins)",
  () => {
    let directory = "";
    const testId = randomUUID();
    const registryKey = `HKCU\\Software\\ARCInstallerOptionsTest-${testId}`;
    let installer = "";

    beforeAll(async () => {
      if (!compilerRoot || !pluginsRoot)
        throw new Error("NSIS cache unavailable");
      directory = await realpath(
        await mkdtemp(join(tmpdir(), "arc-options-Δ-")),
      );
      const resources = join(directory, "assets");
      const artDirectory = join(resources, "installer", "generated");
      await mkdir(artDirectory, { recursive: true });
      const frame = Buffer.from([16, 23, 34]);
      for (const suffix of ["", "-125", "-150", "-200"]) {
        await writeFile(
          join(artDirectory, `arc-still${suffix}.bmp`),
          bitmapFile(frame, 1, 1),
        );
        await writeFile(
          join(artDirectory, `arc-motion${suffix}.avi`),
          animationFile([frame, frame], 1, 1, 20),
        );
      }
      const electronBuilderRoot = dirname(
        require.resolve("electron-builder/package.json"),
      );
      const builderRoot = dirname(
        require.resolve("app-builder-lib/package.json", {
          paths: [electronBuilderRoot],
        }),
      );
      const fixture = join(
        desktopRoot,
        "test",
        "fixtures",
        "installer-options.nsi",
      );
      const commonArguments = [
        "/V2",
        `/DTEST_ROOT=${directory}`,
        `/DTEST_ID=${testId}`,
        `/DBUILD_RESOURCES_DIR=${resources}`,
        `/DPRODUCTION_INCLUDE=${join(desktopRoot, "assets", "installer.nsh")}`,
        `/DBUILDER_TEMPLATES=${join(builderRoot, "templates", "nsis")}`,
        `/DTEST_PLUGINS=${join(pluginsRoot, "plugins", "x86-unicode")}`,
      ];
      const compiler = join(compilerRoot, "Bin", "makensis.exe");
      installer = join(directory, "options-test.exe");
      run(compiler, [
        ...commonArguments,
        `/DTEST_OUTPUT=${installer}`,
        fixture,
      ]);
      run(compiler, [
        ...commonArguments,
        "/DBUILD_UNINSTALLER",
        `/DTEST_OUTPUT=${join(directory, "uninstaller-compile-test.exe")}`,
        fixture,
      ]);
    }, 60_000);

    afterAll(async () => {
      if (!directory) return;
      spawnSync("reg.exe", ["delete", registryKey, "/f", "/reg:32"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await rm(directory, { recursive: true, force: true });
    });

    async function execute(
      name: string,
      input: Record<string, string>,
      flags: string[] = [],
    ): Promise<{ path: string; result: Record<string, string> }> {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid test case name");
      const path = join(directory, name);
      await mkdir(path);
      const values = {
        DesktopType: "dword",
        StartMenuType: "dword",
        Desktop: "1",
        StartMenu: "1",
        keepShortcuts: "true",
        machineInstallation: "0",
        ...input,
      };
      await writeFile(
        join(path, "input.ini"),
        `\uFEFF[input]\r\n${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\r\n")}\r\n`,
        "utf16le",
      );
      await writeFile(join(path, "result.ini"), "\uFEFF", "utf16le");
      run(installer, ["/S", `--case=${name}`, ...flags]);
      const output = await readFile(join(path, "result.ini"), "utf16le");
      const result: Record<string, string> = {};
      for (const line of output.split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator > 0)
          result[line.slice(0, separator)] = line.slice(separator + 1);
      }
      expect(result.preservedRegister).toBe("register-sentinel");
      if (input.probeScope !== "1") {
        expect(result.preservedStack).toBe("stack-sentinel");
        expect(result.keepShortcuts).toBe(values.keepShortcuts);
        expect(result.launchLink).toBe(join(path, "arc-test-target.exe"));
      }
      expect(
        spawnSync("reg.exe", ["query", registryKey, "/reg:32"], {
          windowsHide: true,
          stdio: "ignore",
        }).status,
      ).toBe(1);
      return { path, result };
    }

    it.each([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ])(
      "creates only selected native shortcuts (%i, %i)",
      async (desktop, menu) => {
        const { path, result } = await execute(
          `combination-${desktop}-${menu}`,
          {
            Desktop: String(desktop),
            StartMenu: String(menu),
            erase: "1",
          },
        );
        expect(result.beforeDesktop).toBe("0");
        expect(result.beforeStartMenu).toBe("0");
        expect(result.savedDesktop).toBe(String(desktop));
        expect(result.savedStartMenu).toBe(String(menu));
        for (const [file, selected, target] of [
          ["desktop.lnk", desktop, result.desktopTarget],
          ["start-menu.lnk", menu, result.startMenuTarget],
        ] as const) {
          const link = join(path, file);
          expect(existsSync(link)).toBe(selected === 1);
          if (selected) expect(target).toBe(join(path, "arc-test-target.exe"));
        }
      },
    );

    it("retains cached choices until install mode changes, then reloads registry values", async () => {
      const { result } = await execute("reload", {
        Desktop: "0",
        StartMenu: "1",
        reload: "1",
        erase: "1",
      });
      expect(result.initialDesktop).toBe("0");
      expect(result.initialStartMenu).toBe("1");
      expect(result.sameModeDesktop).toBe("0");
      expect(result.sameModeStartMenu).toBe("1");
      expect(result.changedModeDesktop).toBe("1");
      expect(result.changedModeStartMenu).toBe("0");
      expect(result.savedDesktop).toBe("1");
      expect(result.savedStartMenu).toBe("0");
    });

    it.each([
      {
        name: "missing",
        DesktopType: "missing",
        StartMenuType: "missing",
        Desktop: "1",
        StartMenu: "1",
      },
      {
        name: "malformed",
        DesktopType: "string",
        StartMenuType: "dword",
        Desktop: "0",
        StartMenu: "2",
      },
    ])("defaults $name preferences to checked", async ({ name, ...input }) => {
      const { result } = await execute(name, input);
      expect(result.savedDesktop).toBe("1");
      expect(result.savedStartMenu).toBe("1");
    });

    it("honors --no-desktop-shortcut during a silent update and restores keepShortcuts=false", async () => {
      const { path, result } = await execute(
        "no-desktop",
        { keepShortcuts: "false" },
        ["--no-desktop-shortcut", "--updated"],
      );
      expect(result.initialDesktop).toBe("0");
      expect(result.savedDesktop).toBe("0");
      expect(existsSync(join(path, "desktop.lnk"))).toBe(false);
      expect(result.startMenuTarget).toBe(join(path, "arc-test-target.exe"));
    });

    it("does not remove or replace retained shortcuts when both choices are off", async () => {
      const { path, result } = await execute(
        "retained",
        { Desktop: "0", StartMenu: "0", retain: "1" },
        ["--updated", "--no-desktop-shortcut"],
      );
      expect(result.beforeDesktop).toBe("1");
      expect(result.beforeStartMenu).toBe("1");
      for (const target of [result.desktopTarget, result.startMenuTarget]) {
        expect(target).toBe(join(path, "retained-target.exe"));
      }
    });

    it.each(["0", "1"])(
      "preserves user-deleted or retained shortcuts during an update (retained=%s)",
      async (retain) => {
        const { path, result } = await execute(
          `update-retained-${retain}`,
          { retain },
          ["--updated"],
        );
        expect(result.savedDesktop).toBe("1");
        expect(result.savedStartMenu).toBe("1");
        for (const [file, target] of [
          ["desktop.lnk", result.desktopTarget],
          ["start-menu.lnk", result.startMenuTarget],
        ]) {
          expect(existsSync(join(path, file))).toBe(retain === "1");
          expect(target).toBe(
            retain === "1" ? join(path, "retained-target.exe") : "",
          );
        }
      },
    );

    it.each(["0", "1"])(
      "preloads the final silent install scope and restores current scope (machine=%s)",
      async (machineInstallation) => {
        const { result } = await execute(`scope-${machineInstallation}`, {
          Desktop: "0",
          StartMenu: "0",
          machineInstallation,
          probeScope: "1",
        });
        expect(result.initialDesktop).toBe(machineInstallation);
        expect(result.initialStartMenu).toBe(machineInstallation);
        expect(result.cachedMode).toBe(
          machineInstallation === "1" ? "all" : "CurrentUser",
        );
        expect(result.installMode).toBe("CurrentUser");
        expect(result.restoredContextDesktop).toBe("0");
      },
    );
  },
);

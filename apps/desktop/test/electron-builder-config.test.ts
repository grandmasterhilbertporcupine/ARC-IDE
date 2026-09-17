import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createDesktopUpdateConfig } from "../scripts/desktop-release-channel.mjs";

const desktopPackageRoot = process.cwd();
const require = createRequire(resolve(desktopPackageRoot, "package.json"));
const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("dmg"),
        })
        .passthrough(),
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["arc", "arc-nightly"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    extraResources: z.array(electronBuilderFileSetSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    win: z
      .object({
        executableName: z.enum(["ARC IDE", "ARC IDE Nightly"]),
        publish: z
          .array(
            z.object({
              channel: z.literal("latest"),
              provider: z.literal("github"),
              owner: z.literal("grandmasterhilbertporcupine"),
              repo: z.literal("ARC-IDE"),
            }),
          )
          .optional(),
      })
      .passthrough(),
    nsis: z
      .object({
        shortcutName: z.string().min(1),
        uninstallDisplayName: z.string().min(1),
      })
      .passthrough(),
    publish: z.array(
      z
        .object({
          channel: z.enum(["latest", "nightly"]),
          provider: z.literal("generic"),
          url: z.string().min(1),
        })
        .passthrough(),
    ),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
];
const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;
type EnvironmentOverrides = Record<string, string | undefined>;
type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};
type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;
type RunConfigScript = (
  overrides: EnvironmentOverrides,
  args?: string[],
) => Promise<ScriptRunResult>;
type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
  args?: string[],
) => Promise<ReadResolvedConfigResult>;
type RunNativePrepScript = (appOutDir: string) => Promise<ScriptRunResult>;

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env = { ...process.env };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }
  delete env.ARC_UPDATE_BASE_URL;
  delete env.BB_DESKTOP_RELEASE_CHANNEL;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (
  overrides,
  args = ["--mac"],
) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config", ...args],
    {
      cwd: desktopPackageRoot,
      env: createScriptEnvironment(overrides),
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScript: RunNativePrepScript = async (appOutDir) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir],
    {
      cwd: desktopPackageRoot,
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const readResolvedConfig: ReadResolvedConfig = async (overrides, args) => {
  const result = await runConfigScript(overrides, args);

  expect(result.exitCode).toBe(0);
  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM bb-app bridge with an explicit module extension", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.asarUnpack).toContain("dist/bb-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/bb-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
    const electronVersion = options.electronVersion;
    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "41.7.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );
    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps from packaged app files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContain("!**/*.map");
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/bb-app/server/dist/app-scaffold-template",
      to: "node_modules/bb-app/server/dist/app-scaffold-template",
    });
  });

  it("excludes installer artwork after builder normalization while retaining branding and scaffold files", async () => {
    const { config } = await readResolvedConfig({}, ["--win"]);
    type NormalizedConfig = Omit<ElectronBuilderConfig, "files"> & {
      files: Array<{ from?: string; to?: string; filter: string[] }>;
    };
    type AppMatcher = {
      from: string;
      to: string;
      createFilter(): (file: string, stats: Stats) => boolean;
    };
    const builderRequire = createRequire(
      require.resolve("electron-builder/package.json"),
    );
    const builderConfig: {
      doMergeConfigs(configs: ElectronBuilderConfig[]): NormalizedConfig;
    } = builderRequire("app-builder-lib/out/util/config/config.js");
    const fileMatcher: {
      getMainFileMatchers(
        appDir: string,
        destination: string,
        macroExpander: (pattern: string) => string,
        platformOptions: Record<string, never>,
        platformPackager: {
          info: {
            config: NormalizedConfig;
            projectDir: string;
            buildResourcesDir: string;
            isPrepackedAppAsar: false;
            debugLogger: { isEnabled: false };
          };
        },
        outDir: string,
        isElectronCompile: false,
      ): AppMatcher[];
      copyFiles(
        matchers: AppMatcher[],
        transformer: undefined,
        useHardLinks: false,
      ): Promise<void | void[]>;
    } = builderRequire("app-builder-lib/out/fileMatcher.js");
    const fixtureRoot = await mkdtemp(
      resolve(tmpdir(), "arc-installer-payload-Δ-"),
    );
    const appDir = resolve(fixtureRoot, "app");
    const outDir = resolve(fixtureRoot, "release");
    const destination = resolve(outDir, "app");
    const scaffoldPath =
      "node_modules/bb-app/server/dist/app-scaffold-template";
    const retained = [
      "package.json",
      "dist/main.js",
      "assets/arc-icon.png",
      "assets/arc-icon.ico",
      "assets/arc-icon.icns",
      "assets/BB-LICENSE.txt",
      "assets/UPSTREAM-NOTICE.txt",
      `${scaffoldPath}/package.json`,
      `${scaffoldPath}/nested/template.txt`,
    ];
    const excluded = [
      "assets/installer.nsh",
      "assets/installer/generated/arc-motion.avi",
      "assets/installer/generated/arc-motion-200.avi",
      "assets/installer/generated/arc-still.bmp",
      "assets/installer/generated/arc-preview.png",
      "assets/installer/generated/manifest.json",
      "dist/main.js.map",
    ];

    try {
      for (const file of [...retained, ...excluded]) {
        const source = resolve(appDir, file);
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, file);
      }
      const normalizedConfig = builderConfig.doMergeConfigs([config]);
      const matchers = fileMatcher.getMainFileMatchers(
        appDir,
        destination,
        (pattern) => pattern,
        {},
        {
          info: {
            config: normalizedConfig,
            projectDir: appDir,
            buildResourcesDir: "assets",
            isPrepackedAppAsar: false,
            debugLogger: { isEnabled: false },
          },
        },
        outDir,
        false,
      );
      const mainMatcher = matchers.find((matcher) => matcher.from === appDir);
      const scaffoldMatcher = matchers.find(
        (matcher) => matcher.from === resolve(appDir, scaffoldPath),
      );
      if (mainMatcher === undefined || scaffoldMatcher === undefined) {
        throw new Error("Expected app and scaffold file matchers");
      }
      expect(scaffoldMatcher.to).toBe(resolve(destination, scaffoldPath));
      const mainFilter = mainMatcher.createFilter();
      for (const file of ["assets/installer", ...excluded]) {
        const source = resolve(appDir, file);
        expect(mainFilter(source, await stat(source)), file).toBe(false);
      }
      for (const file of retained) {
        const source = resolve(appDir, file);
        const matcher = file.startsWith(`${scaffoldPath}/`)
          ? scaffoldMatcher
          : mainMatcher;
        expect(matcher.createFilter()(source, await stat(source)), file).toBe(
          true,
        );
      }
      await fileMatcher.copyFiles(matchers, undefined, false);
      for (const file of retained) {
        await expect(
          readFile(resolve(destination, file), "utf8"),
        ).resolves.toBe(file);
      }
      for (const file of excluded) {
        await expect(access(resolve(destination, file))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(["latest", "nightly"])(
    "copies complete Context resources without dependency filtering for %s",
    async (channel) => {
      const { config } = await readResolvedConfig({
        BB_DESKTOP_RELEASE_CHANNEL: channel,
      });
      type ResourceMatcher = {
        from: string;
        to: string;
        createFilter(): (file: string, stats: Stats) => boolean;
      };
      const builderRequire = createRequire(
        require.resolve("electron-builder/package.json"),
      );
      const fileMatcher: {
        getFileMatchers(
          config: ElectronBuilderConfig,
          name: "extraResources",
          destination: string,
          options: {
            macroExpander: (pattern: string) => string;
            customBuildOptions: Record<string, never>;
            globalOutDir: string;
            defaultSrc: string;
          },
        ): ResourceMatcher[] | null;
        getNodeModuleFileMatcher(
          appDir: string,
          destination: string,
          macroExpander: (pattern: string) => string,
          platformOptions: Record<string, never>,
          packager: {
            config: ElectronBuilderConfig;
            debugLogger: { isEnabled: false };
          },
        ): ResourceMatcher;
        copyFiles(
          matchers: ResourceMatcher[],
          transformer: undefined,
          useHardLinks: false,
        ): Promise<void | void[]>;
      } = builderRequire("app-builder-lib/out/fileMatcher.js");
      const fixtureRoot = await mkdtemp(
        resolve(tmpdir(), "arc-context-resources-Δ-"),
      );
      const hostDistPath = "node_modules/bb-app/host-daemon/dist";
      const contextPath = `${hostDistPath}/context`;
      const resourcesRoot = resolve(fixtureRoot, "release/resources");
      const expectedDestination = resolve(
        resourcesRoot,
        "app.asar.unpacked",
        contextPath,
      );
      const files: Array<[string, Buffer]> = [
        ["client.mjs", Buffer.from("export class ContextEmbeddingClient {}")],
        ["worker.mjs", Buffer.from("process.on('message', () => {});")],
        ["manifest.json", Buffer.from('{"schemaVersion":1}')],
        ["models/tokenizer.json", Buffer.from('{"tokenizer":"fixture"}')],
        [
          "models/onnx/model_quantized.onnx",
          Buffer.from([0, 1, 127, 128, 255]),
        ],
        ["notices/transformers.txt", Buffer.from("Apache-2.0 notice")],
        [
          "node_modules/@huggingface/transformers/LICENSE",
          Buffer.from("Apache License Version 2.0"),
        ],
        [
          "node_modules/@huggingface/transformers/package.json",
          Buffer.from('{"name":"@huggingface/transformers"}'),
        ],
        [
          "node_modules/@huggingface/transformers/dist/transformers.node.mjs",
          Buffer.from("export const fixture = true;"),
        ],
        [
          "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
          Buffer.from([0, 127, 128, 255, 17]),
        ],
        [
          "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
          Buffer.from([77, 90, 0, 255]),
        ],
        [
          "node_modules/parent/node_modules/child/.asset",
          Buffer.from("nested hidden asset"),
        ],
      ];

      try {
        for (const [file, bytes] of files) {
          const source = resolve(fixtureRoot, contextPath, file);
          await mkdir(dirname(source), { recursive: true });
          await writeFile(source, bytes);
        }
        const hostEntry = resolve(fixtureRoot, hostDistPath, "index.mjs");
        await writeFile(hostEntry, "export const host = true;");
        const matchers = fileMatcher.getFileMatchers(
          config,
          "extraResources",
          resourcesRoot,
          {
            macroExpander: (pattern) => pattern,
            customBuildOptions: {},
            globalOutDir: resolve(fixtureRoot, "release"),
            defaultSrc: fixtureRoot,
          },
        );
        expect(matchers).toHaveLength(1);
        if (matchers === null || matchers.length !== 1) {
          throw new Error("Expected one complete Context resource copy");
        }
        expect(matchers[0]?.from).toBe(resolve(fixtureRoot, hostDistPath));
        expect(matchers[0]?.to).toBe(dirname(expectedDestination));
        await fileMatcher.copyFiles(matchers, undefined, false);

        const dependencyFilter = fileMatcher
          .getNodeModuleFileMatcher(
            fixtureRoot,
            resolve(resourcesRoot, "app.asar.unpacked"),
            (pattern) => pattern,
            {},
            { config, debugLogger: { isEnabled: false } },
          )
          .createFilter();
        for (const [file, bytes] of files) {
          await expect(
            readFile(resolve(expectedDestination, file)),
          ).resolves.toEqual(bytes);
          const source = resolve(fixtureRoot, contextPath, file);
          expect(dependencyFilter(source, await stat(source))).toBe(false);
        }
        expect(dependencyFilter(hostEntry, await stat(hostEntry))).toBe(true);
        await expect(
          access(resolve(dirname(expectedDestination), "index.mjs")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");
    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );
    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScript(appOutDir);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );
      const expectedHelperMode = process.platform === "win32" ? 0o666 : 0o755;
      expect((await stat(helperPath)).mode & 0o777).toBe(expectedHelperMode);
      expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(
        expectedHelperMode,
      );
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("points mac signing entitlements at checked-in plist files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.target).toEqual([
      { arch: ["arm64"], target: "dmg" },
      { arch: ["arm64"], target: "zip" },
    ]);
  });

  it("packages a Linux AppImage for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "arc",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("keeps the base configuration inert until the release resolver chooses a feed", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.publish).toEqual([]);
    expect(config.win.publish).toBeUndefined();
  });

  it("embeds the public ARC GitHub provider only in stable Windows builds", async () => {
    const { config } = await readResolvedConfig({}, ["--win"]);
    expect(config.extraMetadata).toEqual({ name: "arc-desktop" });
    expect(config.win.publish).toEqual([
      {
        channel: "latest",
        provider: "github",
        owner: "grandmasterhilbertporcupine",
        repo: "ARC-IDE",
      },
    ]);
    expect(config.publish).toEqual([]);
    expect(config.mac).not.toHaveProperty("publish");
    expect(config.linux).not.toHaveProperty("publish");
    expect(config.win).not.toHaveProperty("publisherName");
    expect(createDesktopUpdateConfig("latest", undefined).feedConfig).toEqual(
      config.win.publish?.[0],
    );
  });

  it.each(["latest", "nightly"])(
    "preserves an explicit generic release feed for %s",
    async (channel) => {
      const { config } = await readResolvedConfig(
        {
          ARC_UPDATE_BASE_URL: "https://releases.example.test/arc/",
          BB_DESKTOP_RELEASE_CHANNEL: channel,
        },
        ["--win"],
      );
      expect(config.win.publish).toBeUndefined();
      expect(config.publish).toEqual([
        {
          channel,
          provider: "generic",
          url: `https://releases.example.test/arc/desktop-${channel}/`,
        },
      ]);
    },
  );

  it("rejects an insecure release origin before packaging", async () => {
    const result = await runConfigScript(
      {
        ARC_UPDATE_BASE_URL: "http://releases.example.test/arc",
      },
      ["--win"],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ARC_UPDATE_BASE_URL must use HTTPS");
  });

  it("creates a separate nightly app identity and update feed", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "nightly",
    });
    const nightlyRelease = createDesktopUpdateConfig("nightly", undefined);

    expect(config.appId).toBe("dev.arc.desktop.nightly");
    expect(config.extraMetadata).toEqual({ name: "arc-desktop-nightly" });
    expect(config.productName).toBe("ARC Nightly");
    expect(config.artifactName).toBe("ARC-nightly-${version}-${arch}.${ext}");
    expect(config.linux.icon).toBe("assets/arc-icon.png");
    expect(config.linux.executableName).toBe("arc-nightly");
    expect(config.win.executableName).toBe("ARC IDE Nightly");
    expect(config.nsis.shortcutName).toBe("ARC IDE Nightly");
    expect(config.nsis.uninstallDisplayName).toBe("ARC IDE Nightly");
    expect(config.mac.icon).toBe("assets/arc-icon.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/arc-icon.png")),
    ).resolves.toBeUndefined();
    expect(config.publish).toEqual([]);
    expect(config.win.publish).toBeUndefined();
    expect(nightlyRelease.updateReleaseBaseUrl).toBe("");
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      BB_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BB_DESKTOP_RELEASE_CHANNEL must be latest or nightly",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it.each(["--win", "--windows", "-w"])(
    "accepts Windows certificate credentials without Apple credentials for %s",
    async (target) => {
      const { config } = await readResolvedConfig(
        { CSC_LINK: "windows-certificate.p12", CSC_KEY_PASSWORD: "password" },
        [target, "--x64", "--publish", "never"],
      );

      expect(config.mac.notarize).toBe(false);
      expect(config.win.executableName).toBe("ARC IDE");
      expect(config.publish).toEqual([]);
    },
  );

  it("accepts Windows-specific signing credentials and ignores unrelated partial Apple credentials", async () => {
    const { config } = await readResolvedConfig(
      {
        WIN_CSC_LINK: "windows-certificate.p12",
        WIN_CSC_KEY_PASSWORD: "password",
        APPLE_ID: "builder@example.com",
      },
      ["--win"],
    );

    expect(config.mac.notarize).toBe(false);
    expect(config.publish).toEqual([]);
  });

  it("supports an unsigned local Windows build with updates disabled", async () => {
    const { config } = await readResolvedConfig(
      { CSC_IDENTITY_AUTO_DISCOVERY: "false", ARC_UPDATE_BASE_URL: "" },
      ["--win", "--x64", "--publish", "never"],
    );

    expect(config.win).toMatchObject({
      target: [{ target: "nsis", arch: ["x64"] }],
      signAndEditExecutable: true,
    });
    expect(config.publish).toEqual([]);
    expect(config.win.publish).toBeUndefined();
    expect(config.nsis).toMatchObject({
      include: "assets/installer.nsh",
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
    });
    expect(config.files).toContain("!assets/installer{,/**/*}");
    expect(config.files).toContain("!assets/installer.nsh");
  });

  it.each(["--mac", "--macos", "-m", "-o", "--mac=zip"])(
    "keeps macOS validation when a multi-platform build includes %s",
    async (target) => {
      const result = await runConfigScript(
        { CSC_LINK: "certificate.p12", CSC_KEY_PASSWORD: "password" },
        ["--win", target],
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Incomplete macOS signing/notarization");
    },
  );

  it("uses the host platform when no target flag is supplied", async () => {
    const result = await runConfigScript(
      { CSC_LINK: "certificate.p12", CSC_KEY_PASSWORD: "password" },
      [],
    );

    expect(result.exitCode).toBe(process.platform === "darwin" ? 1 : 0);
  });

  it("does not apply Apple signing validation to Linux builds", async () => {
    const result = await runConfigScript({ APPLE_ID: "builder@example.com" }, [
      "--linux",
    ]);

    expect(result.exitCode).toBe(0);
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(true);
    expect(completeAppleCredentials.config.dmg.sign).toBe(false);
  });
});

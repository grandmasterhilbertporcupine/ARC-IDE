import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { bbDesktopVersionFeedSchema } from "@bb/desktop-contract";

const root = process.cwd();
const release = resolve(root, "release");
const repository = "https://github.com/grandmasterhilbertporcupine/ARC-IDE";
const pkg = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .parse(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")));
const name = `ARC-${pkg.version}-x64.exe`;
const metadata = z
  .object({
    version: z.literal(pkg.version),
    path: z.literal(name),
    sha512: z.string().min(1),
    files: z
      .array(
        z.object({
          url: z.literal(name),
          sha512: z.string().min(1),
          size: z.number().int().positive(),
        }),
      )
      .length(1),
  })
  .parse(parse(await readFile(resolve(release, "latest.yml"), "utf8")));
const feed = bbDesktopVersionFeedSchema.parse(
  JSON.parse(
    await readFile(resolve(release, "desktop-version-windows.json"), "utf8"),
  ),
);
const config = z
  .object({
    provider: z.literal("github"),
    owner: z.literal("grandmasterhilbertporcupine"),
    repo: z.literal("ARC-IDE"),
    channel: z.literal("latest"),
    updaterCacheDirName: z.literal("arc-desktop-updater"),
  })
  .parse(
    parse(
      await readFile(
        resolve(release, "win-unpacked/resources/app-update.yml"),
        "utf8",
      ),
    ),
  );
if (
  feed.version !== pkg.version ||
  feed.platform !== "windows" ||
  feed.channel !== "latest" ||
  feed.path !== name ||
  feed.sha512 !== metadata.sha512 ||
  JSON.stringify(feed.files) !== JSON.stringify(metadata.files)
) {
  throw new Error(
    "The installer, GitHub update configuration and version feeds must agree.",
  );
}
const sha256 = createHash("sha256");
const sha512 = createHash("sha512");
for await (const chunk of createReadStream(resolve(release, name))) {
  sha256.update(chunk);
  sha512.update(chunk);
}
const digest = sha256.digest("hex");
const installerSize = (await stat(resolve(release, name))).size;
if (
  sha512.digest("base64") !== metadata.sha512 ||
  metadata.files[0].sha512 !== metadata.sha512 ||
  metadata.files[0].size !== installerSize ||
  (await stat(resolve(release, `${name}.blockmap`))).size === 0
) {
  throw new Error(
    "Installer bytes do not match the published update metadata.",
  );
}
await writeFile(resolve(release, `${name}.sha256`), `${digest}  ${name}\n`);
await writeFile(
  resolve(release, `ARC-${pkg.version}-x64.install.txt`),
  `ARC ${pkg.version} for Windows 11 x64\n\n` +
    `Download source: ${repository}/releases/tag/v${pkg.version}\n` +
    `Run ${name}; choose your installation folder and Desktop/Start menu shortcuts.\n` +
    `The uninstaller preserves ARC data and project files.\n\n` +
    `Electron, Node, the frontend, server, daemon, CLI, plugins and Context assets are bundled.\n` +
    `Install Git separately for repository operations. Open Settings > Providers for provider setup and sign-in.\n` +
    `Provider executables and accounts are external prerequisites; npm-based setup needs external Node/npm.\n\n` +
    `This personal build is unsigned. Check its source and SHA-256 before running.\n` +
    `SHA-256: ${digest}\n\n` +
    `GitHub updates are enabled: ARC checks on launch, periodically, and through Settings > Updates.\n` +
    `New stable releases download in the background and install on restart/quit.\n` +
    `Older local builds with updates disabled require this installer once to enable future updates.\n`,
);
console.log(
  JSON.stringify({
    version: pkg.version,
    installer: name,
    bytes: installerSize,
    sha256: digest,
    provider: config.provider,
  }),
);

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(resolve("package.json"));
const script = resolve("scripts/prepare-github-release.mts");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()))
      throw new Error("Unexpected fixture directory");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(resolve(tmpdir()), "arc-release-assets-"));
  roots.push(root);
  const release = join(root, "release");
  await mkdir(join(release, "win-unpacked/resources"), { recursive: true });
  const bytes = Buffer.from("installer test fixture");
  const name = "ARC-1.2.3-x64.exe";
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = {
    version: "1.2.3",
    path: name,
    sha512,
    files: [{ url: name, size: bytes.length, sha512 }],
  };
  const feed = {
    ...metadata,
    schemaVersion: 1,
    channel: "latest",
    platform: "windows",
    releaseDate: "2026-09-15T00:00:00.000Z",
    releaseName: "ARC 1.2.3",
    releaseNotes: null,
    minimumSystemVersion: null,
    stagingPercentage: null,
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version: "1.2.3" }),
  );
  await writeFile(join(release, name), bytes);
  await writeFile(join(release, `${name}.blockmap`), "blockmap fixture");
  await writeFile(join(release, "latest.yml"), JSON.stringify(metadata));
  await writeFile(
    join(release, "desktop-version-windows.json"),
    JSON.stringify(feed),
  );
  await writeFile(
    join(release, "win-unpacked/resources/app-update.yml"),
    JSON.stringify({
      provider: "github",
      owner: "grandmasterhilbertporcupine",
      repo: "ARC-IDE",
      channel: "latest",
      updaterCacheDirName: "arc-desktop-updater",
    }),
  );
  return { root, release, name, bytes, feed };
}

function prepare(root: string) {
  return run(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      pathToFileURL(require.resolve("tsx")).href,
      script,
    ],
    {
      cwd: root,
      windowsHide: true,
      timeout: 15_000,
    },
  );
}

describe("GitHub release asset verification", () => {
  it("emits a checksum and bootstrap instructions for an internally consistent release", async () => {
    const data = await fixture();
    await prepare(data.root);
    expect(
      await readFile(join(data.release, `${data.name}.sha256`), "utf8"),
    ).toBe(
      `${createHash("sha256").update(data.bytes).digest("hex")}  ${data.name}\n`,
    );
    expect(
      await readFile(join(data.release, "ARC-1.2.3-x64.install.txt"), "utf8"),
    ).toContain("require this installer once");
  });

  it("refuses changed installer bytes", async () => {
    const data = await fixture();
    await writeFile(join(data.release, data.name), "tampered payload");
    await expect(prepare(data.root)).rejects.toThrow(
      "Installer bytes do not match",
    );
  });

  it("refuses a JSON feed for another release", async () => {
    const data = await fixture();
    await writeFile(
      join(data.release, "desktop-version-windows.json"),
      JSON.stringify({ ...data.feed, version: "1.2.4" }),
    );
    await expect(prepare(data.root)).rejects.toThrow("must agree");
  });

  it("refuses an installer wired to a different GitHub repository", async () => {
    const data = await fixture();
    await writeFile(
      join(data.release, "win-unpacked/resources/app-update.yml"),
      JSON.stringify({
        provider: "github",
        owner: "another-owner",
        repo: "ARC-IDE",
        channel: "latest",
      }),
    );
    await expect(prepare(data.root)).rejects.toThrow(
      "grandmasterhilbertporcupine",
    );
  });
});

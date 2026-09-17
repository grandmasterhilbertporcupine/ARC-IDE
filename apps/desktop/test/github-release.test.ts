import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { releaseFixture } from "./release-fixture.js";

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
  it("finalizes only a source-bound, payload-verified installer with complete receipts", async () => {
    const data = await releaseFixture(roots);
    await rm(join(data.release, "desktop-version-windows.json"));
    await prepare(data.root);
    expect(
      await readFile(join(data.release, `${data.name}.sha256`), "utf8"),
    ).toBe(
      `${createHash("sha256").update(data.bytes).digest("hex")}  ${data.name}\n`,
    );
    expect(
      await readFile(join(data.release, "ARC-1.2.3-x64.install.txt"), "utf8"),
    ).toContain(data.source.commit);
    expect(await readFile(join(data.release, "SHA256SUMS"), "utf8")).toContain(
      "payload-manifest.json",
    );
  });

  it("refuses changed installer bytes even when the version is unchanged", async () => {
    const data = await releaseFixture(roots);
    await writeFile(join(data.release, data.name), "tampered payload");
    await expect(prepare(data.root)).rejects.toThrow(
      "Release asset bytes differ",
    );
    await expect(
      access(join(data.release, `${data.name}.sha256`)),
    ).rejects.toThrow();
  });

  it("refuses a JSON feed for another release", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.release, "desktop-version-windows.json"),
      JSON.stringify({ ...data.feed, version: "1.2.4" }),
    );
    await expect(prepare(data.root)).rejects.toThrow("must agree");
  });

  it("refuses an installer wired to a different GitHub repository", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.unpacked, "resources/app-update.yml"),
      JSON.stringify({
        provider: "github",
        owner: "another-owner",
        repo: "ARC-IDE",
        channel: "latest",
        updaterCacheDirName: "arc-desktop-updater",
      }),
    );
    await expect(prepare(data.root)).rejects.toThrow(
      "grandmasterhilbertporcupine",
    );
  });

  it("refuses an adjacent unpacked application that differs from the installed payload", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.unpacked, "resources/app.asar"),
      "new application with the same version",
    );
    await expect(prepare(data.root)).rejects.toThrow("payload differs");
  });

  it("refuses missing installed-payload verification", async () => {
    const data = await releaseFixture(roots);
    await rm(join(data.release, "installer-verification.json"));
    await rm(join(data.release, "desktop-version-windows.json"));
    await expect(prepare(data.root)).rejects.toThrow(
      "installer-verification.json",
    );
    await expect(
      access(join(data.release, `${data.name}.sha256`)),
    ).rejects.toThrow();
    await expect(
      access(join(data.release, "desktop-version-windows.json")),
    ).rejects.toThrow();
  });

  it("refuses same-version receipts from another build", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.release, "installer-verification.json"),
      JSON.stringify({ ...data.installerReceipt, buildSha256: "a".repeat(64) }),
    );
    await expect(prepare(data.root)).rejects.toThrow("stale buildSha256");
  });

  it("refuses source edits after the build was frozen", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.root, "package.json"),
      JSON.stringify({ version: "1.2.3", stale: true }),
    );
    await expect(prepare(data.root)).rejects.toThrow(
      "clean committed checkout",
    );
  });
});

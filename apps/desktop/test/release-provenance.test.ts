import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPayload,
  captureReleaseSource,
  createManifest,
  loadReleaseBuild,
  verifyInstallerReceipt,
  verifyManifest,
  verifyPackagedReceipt,
  verifySourceReceipt,
} from "../scripts/release-provenance.mjs";
import { releaseFixture } from "./release-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()))
      throw new Error("Unexpected fixture directory");
    await rm(root, { recursive: true, force: true });
  }
});

describe("release provenance and installed payload binding", () => {
  it("compares the installed files and permits only the installer-owned uninstaller addition", async () => {
    const data = await releaseFixture(roots);
    const installed = join(data.release, "installed");
    await cp(data.unpacked, installed, { recursive: true });
    await writeFile(
      join(installed, "Uninstall ARC IDE.exe"),
      "uninstaller fixture",
    );
    expect(await assertPayload(installed, data.payload, true)).toEqual(
      data.payload,
    );
    await writeFile(
      join(installed, "resources/app.asar"),
      "different same-version payload",
    );
    await expect(assertPayload(installed, data.payload, true)).rejects.toThrow(
      "payload differs",
    );
  });

  it("rejects a mismatched installer and payload manifest pair", async () => {
    const data = await releaseFixture(roots);
    const different = createManifest(
      data.payload.files.map((file) =>
        file.path === "resources/app.asar"
          ? { ...file, sha256: "b".repeat(64) }
          : file,
      ),
    );
    await writeFile(
      join(data.release, "payload-manifest.json"),
      JSON.stringify(different),
    );
    await expect(loadReleaseBuild(data.release)).rejects.toThrow(
      "Payload manifest bytes differ",
    );
  });

  it("rejects missing or additional runtime files, including updater configuration", async () => {
    const data = await releaseFixture(roots);
    await mkdir(join(data.release, "installed"));
    await cp(data.unpacked, join(data.release, "installed"), {
      recursive: true,
    });
    await rm(join(data.release, "installed/resources/app-update.yml"));
    await expect(
      assertPayload(join(data.release, "installed"), data.payload, true),
    ).rejects.toThrow("app-update.yml");
    await writeFile(join(data.unpacked, "extra-runtime.dll"), "unexpected");
    await expect(assertPayload(data.unpacked, data.payload)).rejects.toThrow(
      "payload differs",
    );
  });

  it("rejects receipts that omit a required source or packaged gate", async () => {
    const data = await releaseFixture(roots);
    expect(() =>
      verifySourceReceipt(
        {
          ...data.sourceReceipt,
          steps: data.sourceReceipt.steps.filter((step) => step.id !== "arc"),
        },
        data.source,
      ),
    ).toThrow("every required gate");
    expect(() =>
      verifyPackagedReceipt(
        {
          ...data.packagedReceipt,
          steps: data.packagedReceipt.steps.filter(
            (step) => step.id !== "preview-security",
          ),
        },
        data.buildSha256,
        data.payload.digest,
      ),
    ).toThrow("every required gate");
  });

  it("binds receipt identity to source, build, payload, installer, and lifecycle report", async () => {
    const data = await releaseFixture(roots);
    expect(() =>
      verifySourceReceipt(data.sourceReceipt, {
        ...data.source,
        commit: "a".repeat(40),
      }),
    ).toThrow("stale");
    expect(() =>
      verifyPackagedReceipt(
        data.packagedReceipt,
        "a".repeat(64),
        data.payload.digest,
      ),
    ).toThrow("another release build");
    const expected = {
      buildSha256: data.buildSha256,
      payloadDigest: data.payload.digest,
      installerSha256: data.installerReceipt.installerSha256,
      packagedVerificationSha256:
        data.installerReceipt.packagedVerificationSha256,
      reportSha256: data.installerReceipt.reportSha256,
    };
    for (const key of Object.keys(expected)) {
      expect(() =>
        verifyInstallerReceipt(
          { ...data.installerReceipt, [key]: "a".repeat(64) },
          expected,
        ),
      ).toThrow(`stale ${key}`);
    }
    expect(() =>
      verifyInstallerReceipt(
        { ...data.installerReceipt, reinstalledPayloadDigest: "a".repeat(64) },
        expected,
      ),
    ).toThrow("Reinstalled payload was not verified");
  });

  it("refuses untracked source before verification", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(data.repository, "untracked-source.js"),
      "export const version = 2;",
    );
    await expect(captureReleaseSource(data.repository)).rejects.toThrow(
      "clean committed checkout",
    );
  });

  it("refuses altered source-verification logs even when the receipt and version are unchanged", async () => {
    const data = await releaseFixture(roots);
    await writeFile(
      join(
        data.release,
        "verification-logs",
        data.sourceReceipt.steps[0].logPath,
      ),
      "not the recorded run",
    );
    await expect(loadReleaseBuild(data.release)).rejects.toThrow(
      "Verification log bytes differ",
    );
  });

  it("rejects duplicate Windows paths and unsafe manifest paths before filesystem access", () => {
    const file = {
      path: "resources/app.asar",
      size: 3,
      sha256: "a".repeat(64),
    };
    expect(() =>
      createManifest([file, { ...file, path: "Resources/App.asar" }]),
    ).toThrow("duplicate paths");
    for (const path of [
      "../outside",
      "/outside",
      "C:/outside",
      "resources/../outside",
      "resources\\outside",
    ]) {
      expect(() => createManifest([{ ...file, path }])).toThrow();
    }
    const manifest = createManifest([file]);
    expect(() =>
      verifyManifest({ ...manifest, digest: "b".repeat(64) }),
    ).toThrow("digest or file ordering");
  });
});

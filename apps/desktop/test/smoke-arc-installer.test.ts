import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSafeInstallationState,
  installerGuid,
  installerUninstallerName,
  nsisArguments,
  parseInstallerMetadata,
  requireValidSignature,
} from "../scripts/smoke-arc-installer.mjs";

const guid = "18e93f70-eb6a-52ed-a432-ef73f3b40ab2";
const empty = {
  installations: [],
  uninstallEntries: [],
  shortcuts: [],
  processes: [],
  profiles: [],
};

describe("ARC NSIS verification safety", () => {
  it("matches electron-builder's UUIDv5 application identity", () => {
    expect(installerGuid("dev.arc.desktop")).toBe(guid);
  });

  it("accepts a Windows zero revision while comparing the exact installed application version", () => {
    const metadata = {
      product: "ARC",
      version: "0.42.4.0",
      fileVersion: "0.42.4",
      signatureStatus: "NotSigned",
      signerThumbprint: null,
    };
    expect(parseInstallerMetadata(metadata, "0.42.4")).toEqual({
      ...metadata,
      version: "0.42.4",
    });
    expect(
      parseInstallerMetadata({ ...metadata, version: "0.42.4" }, "0.42.4")
        .version,
    ).toBe("0.42.4");
    for (const version of ["0.42.3", "0.42.3.0", "0.42.5.0"]) {
      expect(() =>
        parseInstallerMetadata({ ...metadata, version }, "0.42.4"),
      ).toThrow("version differs");
    }
    for (const version of [
      "0.42.4.1",
      "0.42.4.00",
      "0.42.4.0.0",
      "0.42.4.0-beta",
      "0.42",
      "v0.42.4",
    ]) {
      expect(() => parseInstallerMetadata({ ...metadata, version })).toThrow();
    }
    expect(
      parseInstallerMetadata({ ...metadata, version: "0.42.4-beta.0" }).version,
    ).toBe("0.42.4-beta.0");
    expect(() =>
      parseInstallerMetadata(
        { ...metadata, version: "0.42.4-beta.0" },
        "0.42.4",
      ),
    ).toThrow("version differs");
  });

  it("uses the validated builder executable name for its exact owned uninstaller", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "electron-builder.config.json"), "utf8"),
    );
    expect(installerUninstallerName(config)).toBe("Uninstall ARC IDE.exe");
    for (const executableName of ["ARC", "../other", "C:\\other\\ARC IDE"]) {
      expect(() =>
        installerUninstallerName({
          ...config,
          win: { ...config.win, executableName },
        }),
      ).toThrow("bounded per-user preservation");
    }
    for (const field of [
      "perMachine",
      "oneClick",
      "deleteAppDataOnUninstall",
    ]) {
      expect(() =>
        installerUninstallerName({
          ...config,
          nsis: { ...config.nsis, [field]: true },
        }),
      ).toThrow("bounded per-user preservation");
    }
  });

  it("refuses any existing install, stale shortcut, machine-wide registration or running ARC process", () => {
    expect(() => assertSafeInstallationState(empty, guid)).not.toThrow();
    expect(() =>
      assertSafeInstallationState(
        {
          ...empty,
          processes: [
            {
              id: 123,
              name: "ARC IDE",
              executablePath: join(tmpdir(), "other", "ARC IDE.exe"),
            },
          ],
        },
        guid,
      ),
    ).toThrow("already running");
    expect(() =>
      assertSafeInstallationState(
        {
          ...empty,
          shortcuts: [
            { path: "desktop/ARC IDE.lnk", target: "prior/ARC IDE.exe" },
          ],
        },
        guid,
      ),
    ).toThrow("already exists");
    expect(() =>
      assertSafeInstallationState(
        {
          ...empty,
          installations: [
            {
              hive: "CurrentUser",
              view: "Registry64",
              key: guid,
              location: "prior",
            },
          ],
        },
        guid,
      ),
    ).toThrow("already exists");
    const owned = join(tmpdir(), "ARC install Δ");
    const installed = {
      ...empty,
      installations: [
        { hive: "CurrentUser", view: "Registry64", key: guid, location: owned },
      ],
      uninstallEntries: [
        {
          hive: "CurrentUser",
          view: "Registry64",
          key: guid,
          displayName: "ARC",
        },
      ],
      shortcuts: [
        { path: "desktop/ARC IDE.lnk", target: join(owned, "ARC IDE.exe") },
      ],
    };
    expect(() =>
      assertSafeInstallationState(installed, guid, owned),
    ).not.toThrow();
    expect(() =>
      assertSafeInstallationState(installed, guid, join(tmpdir(), "other")),
    ).toThrow("outside the exact");
    expect(() =>
      assertSafeInstallationState(
        {
          ...installed,
          installations: [
            { ...installed.installations[0], hive: "LocalMachine" },
          ],
        },
        guid,
        owned,
      ),
    ).toThrow("outside the exact");
    expect(() =>
      assertSafeInstallationState(
        {
          ...installed,
          shortcuts: [
            {
              path: "desktop/ARC IDE.lnk",
              target: join(tmpdir(), "other", "ARC IDE.exe"),
            },
          ],
        },
        guid,
        owned,
      ),
    ).toThrow("outside the test-owned");
  });

  it("blocks unsigned, invalid and publisher-less public release artifacts", () => {
    expect(() =>
      requireValidSignature({
        signatureStatus: "Valid",
        signerThumbprint: "publisher-thumbprint",
      }),
    ).not.toThrow();
    for (const signatureStatus of ["NotSigned", "HashMismatch", "NotTrusted"]) {
      expect(() =>
        requireValidSignature({
          signatureStatus,
          signerThumbprint: "publisher-thumbprint",
        }),
      ).toThrow("valid Authenticode");
    }
    expect(() =>
      requireValidSignature({
        signatureStatus: "Valid",
        signerThumbprint: null,
      }),
    ).toThrow("valid Authenticode");
  });

  it("places NSIS's unquoted Unicode directory last and never requests all-users or app-data deletion", () => {
    const directory = join(tmpdir(), "ARC installed 東京");
    expect(nsisArguments(directory)).toEqual([
      "/S",
      "/currentuser",
      `/D=${directory}`,
    ]);
    expect(nsisArguments()).toEqual(["/S", "/currentuser"]);
    expect(() => nsisArguments("relative path")).toThrow("absolute directory");
    expect(() => nsisArguments(`${directory}"`)).toThrow("quote or control");
  });
});

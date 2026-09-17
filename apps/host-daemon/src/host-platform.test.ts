import { describe, expect, it } from "vitest";
import { hostPlatformSchema } from "@bb/host-daemon-contract";
import { resolveHostPlatform } from "./host-platform.js";

describe("host platform identification", () => {
  it("identifies native Windows even with inherited WSL variables", () => {
    expect(resolveHostPlatform("win32", {})).toBe("win32");
    expect(
      resolveHostPlatform("win32", { WSL_INTEROP: "/run/WSL/1_interop" }),
    ).toBe("win32");
  });

  it("keeps native Linux and WSL distinct", () => {
    expect(resolveHostPlatform("linux", {})).toBe("linux");
    expect(resolveHostPlatform("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(
      "wsl",
    );
    expect(
      resolveHostPlatform("linux", { WSL_INTEROP: "/run/WSL/1_interop" }),
    ).toBe("wsl");
  });

  it("preserves macOS and unsupported-platform behavior", () => {
    expect(resolveHostPlatform("darwin", {})).toBe("darwin");
    expect(resolveHostPlatform("freebsd", {})).toBe("unknown");
  });

  it("emits the native runtime value accepted by the wire contract", () => {
    const platform = resolveHostPlatform();
    expect(hostPlatformSchema.parse(platform)).toBe(platform);
    if (process.platform === "win32") expect(platform).toBe("win32");
  });
});

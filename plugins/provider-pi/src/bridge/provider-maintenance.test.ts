import { afterEach, describe, expect, it, vi } from "vitest";
import * as kit from "@get-bb/plugin-sdk/provider-bridge";
import { probePiVersion } from "./provider-maintenance.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("Pi version readiness", () => {
  it("preserves the configured runtime and arguments when probing its version", async () => {
    vi.stubEnv("BB_PI_BRIDGE_COMMAND", "C:\\Agent tools\\pi.cmd");
    vi.stubEnv("BB_PI_BRIDGE_ARGS", '["--profile","local"]');
    const output = vi.spyOn(kit, "experimental_commandOutput").mockResolvedValue("pi 0.84.0");
    await expect(probePiVersion()).resolves.toEqual({ version: "0.84.0", failure: null });
    expect(output).toHaveBeenCalledWith("C:\\Agent tools\\pi.cmd", ["--profile", "local", "--version"]);
  });
  it("does not certify a missing or failed runtime", async () => {
    vi.spyOn(kit, "experimental_commandOutput").mockResolvedValue(null);
    await expect(probePiVersion()).resolves.toMatchObject({ version: null, failure: expect.stringContaining("failed or timed out") });
  });
  it("rejects output without a version", async () => {
    vi.spyOn(kit, "experimental_commandOutput").mockResolvedValue("unknown flag");
    await expect(probePiVersion()).resolves.toMatchObject({ version: null, failure: expect.stringContaining("printed no version") });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { systemVersionResponseSchema } from "@bb/server-contract";
import { createAppVersionService } from "../../src/services/system/app-version.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ARC app version service", () => {
  it.each([true, false])(
    "disables upstream updates when development is %s",
    async (isDevelopment) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Network access is forbidden"));
      const service = createAppVersionService({
        config: { appVersion: "0.42.1", isDevelopment },
      });
      const expected = {
        currentVersion: "0.42.1",
        latestVersion: null,
        source: "disabled",
        updateAvailable: false,
        isDevelopment,
        upgradeCommand: "",
      };
      expect(await service.getSystemVersion()).toEqual(expected);
      expect(await service.getSystemVersion({ forceRefresh: true })).toEqual(
        expected,
      );
      expect(systemVersionResponseSchema.parse(expected)).toEqual(expected);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

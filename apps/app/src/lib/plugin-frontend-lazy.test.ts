import { describe, expect, it, vi } from "vitest";
import { createRetryingModuleLoader } from "./plugin-frontend-lazy";
import { resetPluginFrontendBootStateForTest } from "./plugin-frontend-boot-state";

const frontend = vi.hoisted(() => ({
  loaded: vi.fn(),
  bootPluginFrontends: vi.fn<() => Promise<void>>(),
  schedulePluginFrontendReconcile: vi.fn(),
}));

vi.mock("./plugin-frontend", () => {
  frontend.loaded();
  return frontend;
});

describe("createRetryingModuleLoader", () => {
  it("refetches after a rejection instead of replaying it", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk fetch failed"))
      .mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    await expect(loader()).rejects.toThrow("chunk fetch failed");
    await expect(loader()).resolves.toBe("module");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads once and shares the result across concurrent callers", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    const [first, second] = await Promise.all([loader(), loader()]);

    expect(first).toBe("module");
    expect(second).toBe("module");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the loaded module without refetching", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("module");
    const loader = createRetryingModuleLoader(load);

    await loader();
    await loader();

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("plugin frontend connection reconciliation", () => {
  it("retains preboot changes without importing early and waits for the initial inventory request", async () => {
    const lazy = await import("./plugin-frontend-lazy");
    let resolveInitialInventory = (): void => {};
    const initialInventory = new Promise<void>((resolve) => {
      resolveInitialInventory = resolve;
    });
    frontend.bootPluginFrontends.mockReturnValue(initialInventory);

    try {
      lazy.schedulePluginFrontendReconcile();
      lazy.schedulePluginFrontendReconcile();
      await Promise.resolve();
      expect(frontend.loaded).not.toHaveBeenCalled();

      const boot = lazy.bootPluginFrontends();
      await vi.waitFor(() => {
        expect(frontend.bootPluginFrontends).toHaveBeenCalledTimes(1);
      });
      expect(frontend.schedulePluginFrontendReconcile).not.toHaveBeenCalled();

      resolveInitialInventory();
      await boot;
      expect(frontend.schedulePluginFrontendReconcile).toHaveBeenCalledTimes(1);

      await lazy.bootPluginFrontends();
      expect(frontend.schedulePluginFrontendReconcile).toHaveBeenCalledTimes(1);

      lazy.schedulePluginFrontendReconcile();
      await vi.waitFor(() => {
        expect(frontend.schedulePluginFrontendReconcile).toHaveBeenCalledTimes(
          2,
        );
      });
    } finally {
      resolveInitialInventory();
      resetPluginFrontendBootStateForTest();
      vi.clearAllMocks();
    }
  });
});

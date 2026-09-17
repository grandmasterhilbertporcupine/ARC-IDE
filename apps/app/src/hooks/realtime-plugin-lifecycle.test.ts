import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";

const frontend = vi.hoisted(() => ({
  schedulePluginFrontendReconcile: vi.fn(),
}));

vi.mock("@/lib/plugin-frontend-lazy", () => frontend);

describe("plugin frontend connection recovery", () => {
  it.each([false, true] as const)(
    "reconciles missed plugin lifecycle events when reconnected is %s",
    (reconnected) => {
      const queryClient = new QueryClient();
      const effects = createRealtimeCacheEffects({ queryClient });
      try {
        effects.handleConnected(
          reconnected
            ? { reconnected, disconnectedAt: Date.now() }
            : { reconnected },
        );
        expect(frontend.schedulePluginFrontendReconcile).toHaveBeenCalledTimes(
          1,
        );
      } finally {
        effects.dispose();
        queryClient.clear();
        vi.clearAllMocks();
      }
    },
  );
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createArcHostEntry } from "./host.js";

it("retries native storage after an opening failure without restarting the host", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ARC host recovery Δ "));
  const dataDir = join(temporary, "host data");
  const harness = experimental_createHostEntryHarness(createArcHostEntry(), {
    experimental_paths: { dataDir, tempDir: temporary },
  });
  const identity = {
    runId: "storage-recovery-run",
    effectId: "storage-recovery-effect",
    requestHash: "a".repeat(64),
  };
  try {
    await writeFile(dataDir, "temporarily blocked");
    await expect(
      harness.experimental_call("observeEffect", identity),
    ).rejects.toThrow();
    await expect(
      harness.experimental_call("observeDirectoryEffect", identity),
    ).rejects.toThrow();

    await rm(dataDir);
    await expect(
      Promise.all([
        harness.experimental_call("observeEffect", identity),
        harness.experimental_call("observeDirectoryEffect", identity),
      ]),
    ).resolves.toEqual([null, null]);
  } finally {
    await harness.experimental_dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import watcher from "@parcel/watcher";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")(
  "native Windows file watching",
  () => {
    it("delivers Unicode workspace file changes through the native backend", async () => {
      const directory = await mkdtemp(join(tmpdir(), "WNDR 予測 watch "));
      const target = join(directory, "需要 data.csv");
      let complete: (path: string) => void = () => undefined;
      let fail: (error: Error) => void = () => undefined;
      const event = new Promise<string>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      const subscription = await watcher.subscribe(
        directory,
        (error, events) => {
          if (error) {
            fail(error);
            return;
          }
          for (const entry of events) {
            if (normalize(entry.path).toLowerCase() === target.toLowerCase())
              complete(entry.path);
          }
        },
      );
      const timeout = setTimeout(
        () => fail(new Error("Native file watcher timed out")),
        10000,
      );
      try {
        await writeFile(target, "date,demand\n2026-09-06,42\n", "utf8");
        expect(normalize(await event).toLowerCase()).toBe(target.toLowerCase());
      } finally {
        clearTimeout(timeout);
        await subscription.unsubscribe();
        await rm(directory, { recursive: true, force: true });
      }
    }, 15000);
  },
);

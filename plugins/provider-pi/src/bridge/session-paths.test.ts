import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiSessionFilePath } from "./session-paths.js";

describe("Pi managed session storage", () => {
  it("isolates identical thread IDs across managed ARC instances", () => {
    const firstDataDir = resolve(".arc-test", "one", "provider-pi");
    const secondDataDir = resolve(".arc-test", "two", "provider-pi");
    expect(
      resolvePiSessionFilePath({
        env: {},
        dataDir: firstDataDir,
        threadId: "thr_same",
      }),
    ).toBe(join(firstDataDir, "pi-bridge-sessions", "thr_same.jsonl"));
    expect(
      resolvePiSessionFilePath({
        env: {},
        dataDir: secondDataDir,
        threadId: "thr_same",
      }),
    ).not.toBe(
      resolvePiSessionFilePath({
        env: {},
        dataDir: firstDataDir,
        threadId: "thr_same",
      }),
    );
  });
  it("requires managed storage instead of falling back to the original ARC profile", () => {
    expect(() =>
      resolvePiSessionFilePath({ env: {}, threadId: "thr_one" }),
    ).toThrow("managed absolute data directory");
    expect(() =>
      resolvePiSessionFilePath({
        env: {},
        dataDir: "relative",
        threadId: "thr_one",
      }),
    ).toThrow("managed absolute data directory");
  });
  it("keeps the explicit session directory override", () => {
    const explicit = resolve(".arc-test", "explicit");
    expect(
      resolvePiSessionFilePath({
        env: { BB_PI_BRIDGE_SESSION_DIR: explicit },
        threadId: "thr_one",
      }),
    ).toBe(join(explicit, "thr_one.jsonl"));
  });
});

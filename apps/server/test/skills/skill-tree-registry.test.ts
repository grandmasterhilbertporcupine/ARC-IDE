import { describe, expect, it } from "vitest";
import {
  hashSkillTreeEntries,
  SkillTreeRegistry,
  type SkillTreeEntry,
} from "../../src/services/skills/injected-skills.js";

function tree(entries: SkillTreeEntry[]) {
  return { entries, treeHash: hashSkillTreeEntries(entries) };
}

function entry(content: string): SkillTreeEntry {
  return { path: "SKILL.md", mode: 0o644, bytes: Buffer.from(content) };
}

describe("immutable skill tree registry", () => {
  it("owns registered entries and never exposes mutable retained buffers", () => {
    const registry = new SkillTreeRegistry();
    const original = entry("original");
    const manifest = tree([original]);
    const expected = tree([entry("original")]);
    registry.register(manifest, "/original");

    original.bytes.fill(0);
    original.mode = 0o755;
    original.path = "changed.md";
    manifest.entries.push(entry("extra"));
    manifest.treeHash = "0".repeat(64);

    const fetched = registry.readManifest(expected.treeHash);
    expect(fetched).toEqual(expected);
    if (fetched === undefined) throw new Error("Registered tree was lost");
    for (const value of fetched.entries) {
      value.bytes.fill(1);
      value.mode = 0;
      value.path = "mutated-again.md";
    }
    fetched.treeHash = "1".repeat(64);

    expect(registry.readManifest(expected.treeHash)).toEqual(expected);
    expect(registry.resolve(expected.treeHash)).toBe("/original");
  });

  it.each([
    {
      resource: "bytes",
      limits: { maxBytes: 3, maxTrees: 10, maxEntries: 10 },
    },
    {
      resource: "hashes",
      limits: { maxBytes: 100, maxTrees: 1, maxEntries: 10 },
    },
    {
      resource: "entries",
      limits: { maxBytes: 100, maxTrees: 10, maxEntries: 1 },
    },
  ])(
    "deduplicates snapshots and refuses excess $resource without eviction",
    ({ limits }) => {
      const registry = new SkillTreeRegistry(limits);
      const first = tree([entry("one")]);
      const second = tree([entry("two")]);
      registry.register(first, "/first");
      registry.register(tree([entry("one")]), "/same-content");

      expect(() => registry.register(second, "/second")).toThrow(
        /capacity exhausted.*Restart the server/u,
      );
      expect(registry.resolve(second.treeHash)).toBeUndefined();
      expect(registry.readManifest(second.treeHash)).toBeUndefined();
      expect(registry.readManifest(first.treeHash)).toEqual(first);
      expect(registry.resolve(first.treeHash)).toBe("/same-content");
      expect(() => registry.register(first, "/first-again")).not.toThrow();
    },
  );

  it("rejects a hash that no longer describes the supplied manifest", () => {
    const registry = new SkillTreeRegistry();
    const manifest = tree([entry("original")]);
    manifest.entries[0]?.bytes.fill(0);
    expect(() =>
      registry.register(manifest, "/changed-before-registration"),
    ).toThrow("manifest hash mismatch");
    expect(registry.resolve(manifest.treeHash)).toBeUndefined();
    expect(registry.readManifest(manifest.treeHash)).toBeUndefined();
  });

  it("enforces host-compatible file and byte limits before registering", () => {
    const registry = new SkillTreeRegistry();
    const tooManyFiles = tree(
      Array.from({ length: 1_001 }, (_, index) => ({
        path: `file-${index}.md`,
        mode: 0o644,
        bytes: Buffer.alloc(0),
      })),
    );
    const tooManyBytes = tree([
      {
        path: "SKILL.md",
        mode: 0o644,
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
      },
    ]);
    for (const manifest of [tooManyFiles, tooManyBytes]) {
      expect(() => registry.register(manifest, "/oversized")).toThrow(
        "Reduce it to at most 1000 files and 10485760 bytes",
      );
      expect(registry.resolve(manifest.treeHash)).toBeUndefined();
      expect(registry.readManifest(manifest.treeHash)).toBeUndefined();
    }
  });
});

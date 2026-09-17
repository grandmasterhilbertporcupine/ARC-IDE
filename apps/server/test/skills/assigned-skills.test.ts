import { describe, expect, it } from "vitest";
import { stageAssignedSkillSnapshots } from "../../src/services/skills/assigned-skills.js";
import { SkillTreeRegistry } from "../../src/services/skills/injected-skills.js";

function snapshot() {
  return {
    name: "reader",
    description: "Read large files.",
    files: [
      {
        path: "SKILL.md",
        executable: false,
        contentBase64: Buffer.from(
          "---\nname: reader\ndescription: Read large files.\n---\n\nRead bounded excerpts.\n",
        ).toString("base64"),
      },
      {
        path: "scripts/read.mjs",
        executable: true,
        contentBase64: Buffer.from("process.stdout.write('ready');\n").toString(
          "base64",
        ),
      },
    ],
  };
}
describe("assigned skill runtime staging", () => {
  it("stages exact support bytes and executable modes using the existing tree transport", () => {
    const registry = new SkillTreeRegistry();
    const source = stageAssignedSkillSnapshots(registry, [snapshot()])[0];
    expect(source).toMatchObject({
      kind: "tree",
      name: "reader",
      entryPath: "SKILL.md",
    });
    if (source.kind !== "tree") throw new Error("Expected a tree source");
    const manifest = registry.readManifest(source.treeHash);
    expect(
      manifest?.entries.find((file) => file.path === "scripts/read.mjs"),
    ).toMatchObject({
      mode: 0o755,
      bytes: Buffer.from("process.stdout.write('ready');\n"),
    });
    expect(stageAssignedSkillSnapshots(registry, [snapshot()])).toEqual([
      source,
    ]);
  });
  it("fails dispatch on mismatched metadata, duplicate names and invalid directories", () => {
    const registry = new SkillTreeRegistry();
    expect(() =>
      stageAssignedSkillSnapshots(registry, [
        { ...snapshot(), description: "Other instructions" },
      ]),
    ).toThrow(/does not match/);
    expect(() =>
      stageAssignedSkillSnapshots(registry, [snapshot(), snapshot()]),
    ).toThrow(/unique/);
    expect(() =>
      stageAssignedSkillSnapshots(registry, [
        {
          ...snapshot(),
          files: [{ ...snapshot().files[0], path: "../../SKILL.md" }],
        },
      ]),
    ).toThrow();
  });
});

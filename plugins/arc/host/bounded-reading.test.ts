import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readBoundedWorkspaceFile } from "./bounded-reading.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "arc-bounded-read-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("limits file excerpts without breaking UTF-8 pagination", async () => {
  const content = "a".repeat(63) + "東京" + "z".repeat(150);
  await writeFile(path.join(root, "text.txt"), content);
  const first = await readBoundedWorkspaceFile(
    { root, path: "text.txt", maxBytes: 64 },
    new AbortController().signal,
  );
  expect(first.text).toBe("a".repeat(63) + "東");
  expect(first.nextOffset).toBe(66);
  const rest = await readBoundedWorkspaceFile(
    { root, path: "text.txt", offset: first.nextOffset!, maxBytes: 8192 },
    new AbortController().signal,
  );
  expect(first.text + rest.text).toBe(content);
  expect(rest.nextOffset).toBeNull();
});
it("rejects traversal, binary files, directories and oversized requests", async () => {
  const signal = new AbortController().signal;
  await writeFile(path.join(root, "binary"), Buffer.from([65, 0, 66]));
  await mkdir(path.join(root, "folder"));
  await expect(
    readBoundedWorkspaceFile({ root, path: "../outside" }, signal),
  ).rejects.toThrow();
  await expect(
    readBoundedWorkspaceFile({ root, path: "binary" }, signal),
  ).rejects.toThrow("read_binary");
  await expect(
    readBoundedWorkspaceFile({ root, path: "folder" }, signal),
  ).rejects.toThrow();
  await expect(
    readBoundedWorkspaceFile(
      { root, path: "binary", maxBytes: 100_000 },
      signal,
    ),
  ).rejects.toThrow();
});
it("rejects directory junctions that resolve outside the admitted workspace", async () => {
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(
    path.join(outside, "secret.txt"),
    "not part of this workspace",
  );
  await symlink(
    outside,
    path.join(workspace, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    readBoundedWorkspaceFile(
      { root: workspace, path: "linked/secret.txt" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("read_scope_denied");
});

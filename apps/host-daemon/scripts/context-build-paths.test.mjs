import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ensureOwnedContextDirectory,
  prepareContextBundleOutput,
} from "./stage-context-assets.mjs";

async function fixture(body) {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "arc-context-build-Δ-")),
  );
  const anchor = resolve(root, "host");
  const other = resolve(root, "outside");
  await mkdir(anchor);
  await mkdir(other);
  await writeFile(resolve(other, "preserve.txt"), "preserve outside payload");
  try {
    await body({ root, anchor, other });
  } finally {
    assert.equal(await realpath(root), root);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

test("creates a normal owned nested directory and refuses lexical escape", async () =>
  fixture(async ({ anchor, other }) => {
    const output = resolve(anchor, "dist/context/models/Unicode Δ");
    assert.equal(await ensureOwnedContextDirectory(anchor, output), output);
    assert.equal(await realpath(output), output);
    await assert.rejects(
      ensureOwnedContextDirectory(anchor, other),
      /owned root/,
    );
  }));

test("rejects a redirected output ancestor before any cleanup can reach outside files", async () =>
  fixture(async ({ anchor, other }) => {
    const link = resolve(anchor, "dist");
    await symlink(
      other,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await assert.rejects(
        ensureOwnedContextDirectory(anchor, resolve(anchor, "dist/context")),
        /link|physical scope/,
      );
      await assert.rejects(
        prepareContextBundleOutput(anchor),
        /link|physical scope/,
      );
      assert.equal(
        await readFile(resolve(other, "preserve.txt"), "utf8"),
        "preserve outside payload",
      );
      await assert.rejects(readFile(resolve(other, "context")), {
        code: "ENOENT",
      });
    } finally {
      await unlink(link);
    }
  }));

test("detaches existing bundle leaves before an output write can alter another file", async () =>
  fixture(async ({ anchor, other }) => {
    const output = resolve(anchor, "dist/context");
    await ensureOwnedContextDirectory(anchor, output);
    for (const name of ["client.mjs", "worker.mjs"])
      await link(resolve(other, "preserve.txt"), resolve(output, name));
    await prepareContextBundleOutput(anchor);
    for (const name of ["client.mjs", "worker.mjs"])
      await writeFile(resolve(output, name), "new owned bundle");
    assert.equal(
      await readFile(resolve(other, "preserve.txt"), "utf8"),
      "preserve outside payload",
    );
  }));

test("rejects a redirected cache subdirectory before opening a download", async () =>
  fixture(async ({ anchor, other }) => {
    await mkdir(resolve(anchor, ".context-assets"));
    const link = resolve(anchor, ".context-assets/models");
    await symlink(
      other,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await assert.rejects(
        ensureOwnedContextDirectory(
          anchor,
          resolve(anchor, ".context-assets/models/Xenova/model"),
        ),
        /link|physical scope/,
      );
      assert.equal(
        await readFile(resolve(other, "preserve.txt"), "utf8"),
        "preserve outside payload",
      );
      await assert.rejects(readFile(resolve(other, "Xenova")), {
        code: "ENOENT",
      });
    } finally {
      await unlink(link);
    }
  }));

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function replaceRuntimeEntry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error?.code) ||
        attempt >= 12
      ) {
        throw error;
      }
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
}

async function removeUnexpectedFiles(dir, expectedFiles, relativeDir = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeUnexpectedFiles(absolutePath, expectedFiles, relativePath);
      const remaining = await readdir(absolutePath);
      if (remaining.length === 0) {
        await rm(absolutePath, { recursive: true });
      }
      continue;
    }
    if (!expectedFiles.has(relativePath)) {
      await rm(absolutePath);
    }
  }
}

/**
 * Promote a complete staged runtime build without first deleting the live
 * package exports. Each rename replaces one file atomically, so concurrent
 * consumers see either the previous complete artifact or its replacement.
 */
export async function promoteRuntimeEntries({
  distDir,
  stagingDir,
  relativeOutputs,
}) {
  await mkdir(distDir, { recursive: true });
  for (const relativeOutput of relativeOutputs) {
    const destination = path.join(distDir, relativeOutput);
    await mkdir(path.dirname(destination), { recursive: true });
    await replaceRuntimeEntry(
      path.join(stagingDir, relativeOutput),
      destination,
    );
  }
  await removeUnexpectedFiles(
    distDir,
    new Set(relativeOutputs.map((output) => path.normalize(output))),
  );
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { isWithinDirectory } from "./path-containment.js";
import { isIgnoredPluginDevPath } from "./plugin-dev-loop.js";

interface SourceEntry {
  version: string;
  fingerprint: string;
  children: readonly string[] | null;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isInside(path: string, directory: string): boolean {
  return (
    directory === "." ||
    path === directory ||
    path.startsWith(`${directory}${sep}`)
  );
}

export async function createPluginSourceChangeFilter(
  rootDir: string,
): Promise<(paths: readonly string[]) => Promise<readonly string[]>> {
  const root = await realpath(rootDir);
  let snapshot = new Map<string, SourceEntry>();

  async function scan(
    path: string,
    next: Map<string, SourceEntry>,
  ): Promise<void> {
    if (isIgnoredPluginDevPath(path)) return;
    const absolute = resolve(root, path);
    try {
      const stats = await lstat(absolute, { bigint: true });
      const version = [
        stats.dev,
        stats.ino,
        stats.mode,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ].join(":");
      const previous = snapshot.get(path);
      if (stats.isDirectory()) {
        const children =
          previous?.version === version && previous.children !== null
            ? previous.children
            : (await readdir(absolute)).filter(
                (name) => !isIgnoredPluginDevPath(join(path, name)),
              );
        next.set(path, {
          version,
          fingerprint: `directory:${stats.mode}`,
          children,
        });
        for (const name of children) {
          await scan(path === "." ? name : join(path, name), next);
        }
        return;
      }
      if (previous?.version === version) {
        next.set(path, previous);
        return;
      }
      let fingerprint: string;
      if (stats.isFile()) {
        const hash = createHash("sha256");
        await pipeline(createReadStream(absolute), hash);
        fingerprint = `file:${stats.mode}:${hash.digest("hex")}`;
      } else if (stats.isSymbolicLink()) {
        fingerprint = `link:${stats.mode}:${await readlink(absolute)}`;
      } else {
        fingerprint = `other:${stats.mode}`;
      }
      next.set(path, { version, fingerprint, children: null });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  await scan(".", snapshot);

  return async (paths) => {
    const targets: string[] = [];
    for (const path of paths) {
      const absolute = resolve(root, path);
      if (!isWithinDirectory(root, absolute)) continue;
      const target = relative(root, absolute) || ".";
      if (
        isIgnoredPluginDevPath(target) ||
        targets.some((existing) => isInside(target, existing))
      ) {
        continue;
      }
      targets.push(target);
    }
    const next = new Map(snapshot);
    for (const path of next.keys()) {
      if (targets.some((target) => isInside(path, target))) next.delete(path);
    }
    for (const target of targets) await scan(target, next);
    const changed = [...new Set([...snapshot.keys(), ...next.keys()])].filter(
      (path) => snapshot.get(path)?.fingerprint !== next.get(path)?.fingerprint,
    );
    snapshot = next;
    return changed.sort();
  };
}

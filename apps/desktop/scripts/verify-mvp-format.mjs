import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fileEntry, pathWithin, readJson } from "./release-provenance.mjs";
import { runReleaseCommand } from "./run-release-command.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const paths = z
  .array(z.string().min(1))
  .min(1)
  .parse(
    await readJson(
      join(repository, "apps/desktop/scripts/mvp-format-paths.json"),
    ),
  );
for (const path of paths) await fileEntry(repository, path);
const parent = pathWithin(repository, ".arc-verification/mvp");
await mkdir(parent, { recursive: true });
const evidence = await mkdtemp(join(parent, "format-"));
await runReleaseCommand(
  repository,
  ["exec", "oxfmt", "--check", ...paths],
  join(evidence, "format.log"),
);

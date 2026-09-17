import { readFile } from "node:fs/promises";
import { experimentalAddressingSchema } from "@bb/domain";

export async function readAddressingFile(path: string | undefined) {
  if (path === undefined) return undefined;
  return experimentalAddressingSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
}

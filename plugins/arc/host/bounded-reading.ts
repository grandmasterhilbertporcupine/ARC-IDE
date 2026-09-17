import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { boundedReadingHostMethods } from "../host-reading-contract.js";

export async function readBoundedWorkspaceFile(
  input: z.input<
    typeof boundedReadingHostMethods.readBoundedWorkspaceFile.input
  >,
  signal: AbortSignal,
) {
  const value =
    boundedReadingHostMethods.readBoundedWorkspaceFile.input.parse(input);
  signal.throwIfAborted();
  const root = await realpath(value.root);
  const resolved = await realpath(path.resolve(root, value.path));
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      "read_scope_denied: The file resolves outside the assigned workspace",
    );
  const file = await open(resolved, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("read_not_file: Select a regular file");
    const buffer = Buffer.alloc(
      Math.min(value.maxBytes + 3, Math.max(0, stat.size - value.offset)),
    );
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.length,
      value.offset,
    );
    signal.throwIfAborted();
    let end = Math.min(value.maxBytes, bytesRead);
    while (end < bytesRead && (buffer[end] & 0xc0) === 0x80) end++;
    const selected = buffer.subarray(0, end);
    if (selected.includes(0))
      throw new Error(
        "read_binary: This bounded reader accepts UTF-8 text files",
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(selected);
    const nextOffset =
      value.offset + end < stat.size ? value.offset + end : null;
    return {
      path: value.path,
      offset: value.offset,
      nextOffset,
      size: stat.size,
      text,
      truncated: nextOffset !== null,
    };
  } finally {
    await file.close();
  }
}

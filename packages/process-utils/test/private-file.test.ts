import { execFile } from "node:child_process";
import { chmod, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  protectPrivateFile,
  readPrivateFileUtf8,
  verifyPrivateFilePermissions,
  writePrivateFileUtf8,
} from "../src/private-file.js";

it("protects a private file and rejects broader Windows access", async () => {
  const root = await mkdtemp(join(tmpdir(), "arc-private-Δ "));
  const file = join(root, "descriptor.json");
  try {
    await writeFile(file, "{}");
    await protectPrivateFile(file);
    await expect(verifyPrivateFilePermissions(file)).resolves.toBeUndefined();
    await expect(readPrivateFileUtf8(file)).resolves.toBe("{}");
    if (process.platform === "win32") {
      await promisify(execFile)("icacls.exe", [file, "/grant", "*S-1-1-0:R"], {
        windowsHide: true,
      });
      await expect(verifyPrivateFilePermissions(file)).rejects.toThrow();
      await expect(readPrivateFileUtf8(file)).rejects.toThrow();
      await protectPrivateFile(file);
      await expect(verifyPrivateFilePermissions(file)).resolves.toBeUndefined();
      await expect(readPrivateFileUtf8(file)).resolves.toBe("{}");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("reads strict UTF-8 up to the private-file byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "arc-private-read-Δ "));
  const file = join(root, "descriptor.json");
  try {
    const content = "Δ".repeat(8_192);
    await writeFile(file, content);
    await protectPrivateFile(file);
    await expect(readPrivateFileUtf8(file)).resolves.toBe(content);
    await writeFile(file, `${content}x`);
    await expect(readPrivateFileUtf8(file)).rejects.toThrow();
    await writeFile(file, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    await expect(readPrivateFileUtf8(file)).rejects.toThrow();
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x7b, 0, 0x7d, 0]));
    await expect(readPrivateFileUtf8(file)).rejects.toThrow();
    await expect(readPrivateFileUtf8(root)).rejects.toThrow("regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform !== "win32")(
  "refuses to read while another handle permits mutation, then recovers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-private-lock-"));
    const file = join(root, "descriptor.json");
    try {
      await writeFile(file, '{"generation":1}');
      await protectPrivateFile(file);
      const writer = await open(file, "r+");
      try {
        await expect(readPrivateFileUtf8(file)).rejects.toThrow();
        await writer.write('{"generation":2}', 0, "utf8");
      } finally {
        await writer.close();
      }
      const reader = await open(file, "r");
      try {
        await expect(readPrivateFileUtf8(file)).resolves.toBe(
          '{"generation":2}',
        );
      } finally {
        await reader.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("exclusively creates a bounded private file without overwriting contenders", async () => {
  const root = await mkdtemp(join(tmpdir(), "arc-private-create-Δ "));
  const file = join(root, "descriptor.json");
  try {
    if (process.platform === "win32") {
      await promisify(execFile)(
        "icacls.exe",
        [root, "/grant", "*S-1-1-0:(OI)(CI)F"],
        { windowsHide: true },
      );
    }
    const content = "Δ🧊".repeat(2_730) + "abcd";
    expect(Buffer.byteLength(content)).toBe(16_384);
    await writePrivateFileUtf8(file, content);
    await expect(verifyPrivateFilePermissions(file)).resolves.toBeUndefined();
    await expect(readPrivateFileUtf8(file)).resolves.toBe(content);
    await expect(writePrivateFileUtf8(file, "replacement")).rejects.toThrow();
    await expect(readPrivateFileUtf8(file)).resolves.toBe(content);
    await expect(
      writePrivateFileUtf8(join(root, "oversized"), `${content}x`),
    ).rejects.toThrow("size limit");
    await expect(
      writePrivateFileUtf8(join(root, "malformed"), "\uD800"),
    ).rejects.toThrow("valid Unicode");
    const racePath = join(root, "contended.json");
    const contenders = ["first", "second"];
    const results = await Promise.allSettled(
      contenders.map((value) => writePrivateFileUtf8(racePath, value)),
    );
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(readPrivateFileUtf8(racePath)).resolves.toBe(
      contenders[winner],
    );
    await expect(
      verifyPrivateFilePermissions(racePath),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform === "win32")(
  "rejects POSIX symlinks and group-readable descriptors",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-private-posix-"));
    const file = join(root, "descriptor.json");
    const linked = join(root, "linked.json");
    try {
      await writeFile(file, "{}", { mode: 0o600 });
      await symlink(file, linked);
      await expect(readPrivateFileUtf8(linked)).rejects.toThrow();
      await chmod(file, 0o640);
      await expect(readPrivateFileUtf8(file)).rejects.toThrow();
      await protectPrivateFile(file);
      await expect(readPrivateFileUtf8(file)).resolves.toBe("{}");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "does not depend on inherited PowerShell module paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-private-modules-"));
    const file = join(root, "descriptor.json");
    const previous = process.env.PSModulePath;
    try {
      process.env.PSModulePath = root;
      await writePrivateFileUtf8(file, '{"workspace":"Δ project"}');
      await protectPrivateFile(file);
      await expect(verifyPrivateFilePermissions(file)).resolves.toBeUndefined();
      await expect(readPrivateFileUtf8(file)).resolves.toBe(
        '{"workspace":"Δ project"}',
      );
    } finally {
      if (previous === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

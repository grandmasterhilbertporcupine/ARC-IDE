import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isFsErrorWithCode } from "../fs-errors.js";
import { readHostFile } from "./host-files.js";

const roots: string[] = [];
const pathPolicy = { denyDotfiles: true, deniedExtensions: [".key", ".pem"] };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arc-read-policy-"));
  roots.push(root);
  await fs.writeFile(path.join(root, ".env"), "owned secret");
  await fs.writeFile(path.join(root, "client.KEY"), "owned key");
  await fs.writeFile(path.join(root, "public.js"), "window.public=true");
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("filesystem read path policy", () => {
  it("denies direct private paths while preserving ordinary reads without a policy", async () => {
    const rootPath = await fixture();
    for (const name of [
      ".env",
      "client.KEY",
      "client.KEY ",
      "public.js:private",
    ])
      await expect(
        readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, name),
          rootPath,
          pathPolicy,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    const old = await readHostFile({
      type: "host.read_file",
      path: path.join(rootPath, ".env"),
    });
    expect(old.content).toBe("owned secret");
    const ordinary = await readHostFile({
      type: "host.read_file",
      path: path.join(rootPath, "public.js"),
      rootPath,
      pathPolicy,
    });
    expect(ordinary.content).toBe("window.public=true");
    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(rootPath, "public.js"),
        pathPolicy,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("checks both requested and canonical paths through directory aliases", async () => {
    const rootPath = await fixture();
    await fs.mkdir(path.join(rootPath, ".private"));
    await fs.writeFile(
      path.join(rootPath, ".private", "data.json"),
      "owned hidden data",
    );
    await fs.mkdir(path.join(rootPath, "public"));
    await fs.writeFile(
      path.join(rootPath, "public", "data.json"),
      "owned public data",
    );
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(
      path.join(rootPath, ".private"),
      path.join(rootPath, "assets"),
      linkType,
    );
    await fs.symlink(
      path.join(rootPath, "public"),
      path.join(rootPath, "public-assets"),
      linkType,
    );
    await fs.symlink(
      path.join(rootPath, "public"),
      path.join(rootPath, ".hidden-alias"),
      linkType,
    );
    for (const name of ["assets/data.json", ".hidden-alias/data.json"])
      await expect(
        readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, name),
          rootPath,
          pathPolicy,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, "public-assets", "data.json"),
          rootPath,
          pathPolicy,
        })
      ).content,
    ).toBe("owned public data");
    expect(
      (
        await readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, "assets", "data.json"),
          rootPath,
        })
      ).content,
    ).toBe("owned hidden data");
  });

  it("checks canonical hidden and key file targets through file symlinks", async ({
    skip,
  }) => {
    const rootPath = await fixture();
    try {
      await fs.symlink(
        path.join(rootPath, ".env"),
        path.join(rootPath, "env.txt"),
        "file",
      );
    } catch (error) {
      if (process.platform === "win32" && isFsErrorWithCode(error, "EPERM"))
        skip(
          "Windows denied file symlink creation (EPERM); enable Developer Mode or symlink privileges to run this case. Directory junction coverage runs separately.",
        );
      throw error;
    }
    await fs.symlink(
      path.join(rootPath, "client.KEY"),
      path.join(rootPath, "key.txt"),
      "file",
    );
    await fs.symlink(
      path.join(rootPath, "public.js"),
      path.join(rootPath, "alias.js"),
      "file",
    );
    for (const name of ["env.txt", "key.txt"])
      await expect(
        readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, name),
          rootPath,
          pathPolicy,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, "alias.js"),
          rootPath,
          pathPolicy,
        })
      ).content,
    ).toBe("window.public=true");
    expect(
      (
        await readHostFile({
          type: "host.read_file",
          path: path.join(rootPath, "env.txt"),
          rootPath,
        })
      ).content,
    ).toBe("owned secret");
  });

  it("denies an outside-root directory junction while retaining its selected root", async () => {
    const rootPath = await fixture();
    const outsideRoot = await fixture();
    await fs.symlink(
      outsideRoot,
      path.join(rootPath, "outside-assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(rootPath, "outside-assets", "public.js"),
        rootPath,
        pathPolicy,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(await fs.readFile(path.join(outsideRoot, "public.js"), "utf8")).toBe(
      "window.public=true",
    );
  });

  it("rejects constraints on historical reads instead of silently discarding them", async () => {
    const rootPath = await fixture();
    await expect(
      readHostFile({
        type: "host.read_file",
        path: path.join(rootPath, ".env"),
        rootPath,
        ref: "HEAD",
        pathPolicy,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});

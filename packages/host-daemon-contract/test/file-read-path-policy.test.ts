import { describe, expect, it } from "vitest";
import {
  hostDaemonOnlineRpcCommandSchema,
  isAllowedHostReadRelativePath,
} from "../src/index.js";

const pathPolicy = { denyDotfiles: true, deniedExtensions: [".key", ".pem"] };

describe("root-bound file read policy", () => {
  it("preserves existing reads and requires complete explicit constraints on filesystem reads", () => {
    const old = { type: "host.read_file", path: "C:\\Project\\.env" };
    expect(hostDaemonOnlineRpcCommandSchema.parse(old)).toEqual(old);
    const command = { ...old, rootPath: "C:\\Project", pathPolicy };
    expect(hostDaemonOnlineRpcCommandSchema.parse(command)).toEqual(command);
    for (const invalid of [
      { ...old, pathPolicy },
      { ...command, ref: "HEAD" },
      { ...command, pathPolicy: { denyDotfiles: true } },
      { ...command, pathPolicy: { deniedExtensions: [] } },
      { ...command, pathPolicy: { ...pathPolicy, deniedExtensions: ["pem"] } },
      {
        ...command,
        pathPolicy: { ...pathPolicy, deniedExtensions: ["../key"] },
      },
      { ...command, pathPolicy: { ...pathPolicy, ignored: true } },
    ])
      expect(hostDaemonOnlineRpcCommandSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it("rejects hidden, key and ambiguous Windows paths without blocking ordinary assets", () => {
    for (const name of [
      ".env",
      "assets/.env.local",
      "assets/client.KEY",
      "keys/client.PEM",
      "assets/client.key ",
      "assets/client.key.",
      "file.txt:private",
      "file.txt::$DATA",
      "../file.js",
      "/file.js",
      "C:\\file.js",
      "assets//file.js",
      "file\0.js",
      "assets/%2eenv",
      "%252eenv",
      "assets./file.js",
      "NUL",
      "con.txt",
    ])
      expect(isAllowedHostReadRelativePath(name, pathPolicy), name).toBe(false);
    for (const name of [
      "assets/main.mjs",
      "assets\\main.js",
      "data.json",
      "images/Δ logo.svg",
      "node_modules/pkg/main.js",
    ])
      expect(isAllowedHostReadRelativePath(name, pathPolicy), name).toBe(true);
    expect(
      isAllowedHostReadRelativePath(".env", {
        ...pathPolicy,
        denyDotfiles: false,
      }),
    ).toBe(true);
    expect(
      isAllowedHostReadRelativePath("client.key", {
        denyDotfiles: false,
        deniedExtensions: [],
      }),
    ).toBe(true);
  });
});

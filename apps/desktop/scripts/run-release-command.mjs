import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

export async function runReleaseCommand(
  repository,
  args,
  logPath,
  extraEnv = {},
  removeEnv = [],
) {
  const pnpm = process.env.npm_execpath;
  assert(
    pnpm && /(?:pnpm|corepack)[^/\\]*\.(?:c?js)$/iu.test(pnpm),
    "Run this command through pnpm so its exact Node entrypoint is available.",
  );
  const log = createWriteStream(logPath, { flags: "wx" });
  const env = {
    ...process.env,
    TURBO_CONCURRENCY: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
    UV_THREADPOOL_SIZE: "2",
    npm_config_jobs: "1",
    CMAKE_BUILD_PARALLEL_LEVEL: "1",
    MAX_JOBS: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    ...extraEnv,
  };
  const removedKeys = new Set(removeEnv.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env))
    if (removedKeys.has(key.toUpperCase())) delete env[key];
  const child = spawn(process.execPath, [pnpm, ...args], {
    cwd: repository,
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (bytes) => {
    log.write(bytes);
    process.stdout.write(bytes);
  });
  child.stderr.on("data", (bytes) => {
    log.write(bytes);
    process.stderr.write(bytes);
  });
  try {
    await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0
          ? done()
          : reject(
              new Error(
                `Verification command failed (${code ?? signal}): pnpm ${args.join(" ")}`,
              ),
            ),
      );
    });
  } finally {
    log.end();
    await finished(log);
  }
}

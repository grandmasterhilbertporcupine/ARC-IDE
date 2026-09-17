import { createHash } from "node:crypto";
import {
  experimental_spawnPortableProcess as spawnPortableProcess,
  experimental_killProcessGroup as killProcessGroup,
  experimental_supportsProcessGroups as supportsProcessGroups,
  sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { HostProcessReceipt } from "../host-contract.js";

export class NativeOutcomeUnknown extends Error {}

export const MAX_NATIVE_CAPTURE_BYTES = 4 * 1024 * 1024;

export function nativeEnvironment(): NodeJS.ProcessEnv {
  const env = sanitizeInheritedChildProcessEnv({ env: process.env });
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/iu.test(
        key,
      )
    )
      delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" };
}

export async function runNativeProcess(
  input: {
    executable: string;
    args: string[];
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
  captureLimitBytes = 65_536,
): Promise<HostProcessReceipt> {
  if (
    !Number.isSafeInteger(captureLimitBytes) ||
    captureLimitBytes < 1 ||
    captureLimitBytes > MAX_NATIVE_CAPTURE_BYTES
  )
    throw new Error(
      "Native output capture exceeds its bounded internal limit.",
    );
  input.signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  const child = spawnPortableProcess({
    command: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: nativeEnvironment(),
    detached: supportsProcessGroups(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr)
    throw new Error("Native process output was not attached.");
  const output = (): {
    chunks: Buffer[];
    bytes: number;
    retained: number;
    hash: ReturnType<typeof createHash>;
  } => ({
    chunks: [],
    bytes: 0,
    retained: 0,
    hash: createHash("sha256"),
  });
  const stdout = output();
  const stderr = output();
  const consume = (stream: ReturnType<typeof output>, chunk: Buffer) => {
    stream.bytes += chunk.length;
    stream.hash.update(chunk);
    const available = captureLimitBytes - stream.retained;
    if (available > 0) {
      const retained = chunk.subarray(0, available);
      stream.chunks.push(retained);
      stream.retained += retained.length;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
  return await new Promise((resolve, reject) => {
    let interrupted = false;
    let killDeadline: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timeout);
      if (killDeadline) clearTimeout(killDeadline);
      input.signal.removeEventListener("abort", interrupt);
    };
    const interrupt = () => {
      if (settled || interrupted) return;
      interrupted = true;
      let terminationError: unknown;
      try {
        killProcessGroup({ child, signal: "SIGKILL" });
      } catch (error) {
        terminationError = error;
      }
      killDeadline = setTimeout(() => {
        if (settled) return;
        finish();
        reject(
          new NativeOutcomeUnknown(
            `Native process termination was not confirmed: ${String(terminationError ?? "close event missing")}`,
          ),
        );
      }, 10_000);
    };
    const timeout = setTimeout(interrupt, input.timeoutMs);
    input.signal.addEventListener("abort", interrupt, { once: true });
    child.once("error", (error) => consume(stderr, Buffer.from(error.message)));
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      finish();
      resolve({
        executable: input.executable,
        args: input.args,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutDigest: stdout.hash.digest("hex"),
        stderrDigest: stderr.hash.digest("hex"),
        truncated:
          stdout.bytes > stdout.retained || stderr.bytes > stderr.retained,
        interrupted,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
    if (input.signal.aborted) interrupt();
  });
}

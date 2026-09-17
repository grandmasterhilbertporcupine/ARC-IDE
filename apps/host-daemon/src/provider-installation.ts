import { PassThrough, type Readable } from "node:stream";
import type { ProviderInstallationCommand } from "@bb/provider-bridge-protocol";
import {
  providerCliInstallEventSchema,
  type ProviderCliInstallEvent,
} from "@bb/host-daemon-contract";
import { spawn as spawnPty } from "node-pty";
import { killProcessGroup, resolveWindowsPowerShell } from "@bb/process-utils";
import type { HostDaemonLogger } from "./logger.js";
import { ensureNodePtySpawnHelperExecutable } from "./terminals/terminal-manager.js";

const nodePtyLogger: HostDaemonLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface ProviderInstallationProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  onError(listener: (error: Error) => void): void;
  onClose(
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export interface ProviderInstallationProcessSpawner {
  spawn(args: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  }): ProviderInstallationProcess;
}

let activeProviderId: string | null = null;

export class ProviderInstallationInProgressError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider installation already running for ${providerId}`);
    this.name = "ProviderInstallationInProgressError";
    this.providerId = providerId;
  }
}

function createPtyProviderInstallationProcessSpawner(): ProviderInstallationProcessSpawner {
  return {
    spawn(args) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      ensureNodePtySpawnHelperExecutable(nodePtyLogger);
      const windowsScript =
        process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(args.command);
      const command = windowsScript
        ? resolveWindowsPowerShell(args.env)
        : args.command;
      const commandArgs = windowsScript
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `& ${[args.command, ...args.args].map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}; exit $LASTEXITCODE`,
          ]
        : args.args;
      const pty = spawnPty(command, commandArgs, {
        cols: 120,
        cwd: process.cwd(),
        env: args.env ?? process.env,
        name: "xterm-256color",
        rows: 30,
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      });
      pty.onData((data) => stdout.write(data));
      pty.onExit(() => {
        stdout.end();
        stderr.end();
      });
      return {
        stdout,
        stderr,
        kill(signal) {
          killProcessGroup({
            child: {
              pid: pty.pid,
              kill: (requestedSignal) => pty.kill(requestedSignal),
            },
            signal,
          });
          return true;
        },
        onError(listener) {
          void listener;
        },
        onClose(listener) {
          pty.onExit((event) => listener(event.exitCode, null));
        },
      };
    },
  };
}

export function streamProviderInstallation(args: {
  providerId: string;
  plan: ProviderInstallationCommand;
  env?: NodeJS.ProcessEnv;
  processSpawner?: ProviderInstallationProcessSpawner;
}): ReadableStream<Uint8Array> {
  if (activeProviderId !== null) {
    throw new ProviderInstallationInProgressError(activeProviderId);
  }
  activeProviderId = args.providerId;
  let closed = false;
  let child: ProviderInstallationProcess | null = null;
  const release = () => {
    if (activeProviderId === args.providerId) activeProviderId = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (event: ProviderCliInstallEvent) => {
        if (closed) return;
        const parsed = providerCliInstallEventSchema.parse(event);
        controller.enqueue(encoder.encode(`${JSON.stringify(parsed)}\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        release();
        controller.close();
      };
      write({
        type: "started",
        provider: args.providerId,
        command: args.plan.displayCommand,
      });
      try {
        child = (
          args.processSpawner ?? createPtyProviderInstallationProcessSpawner()
        ).spawn({
          command: args.plan.command,
          args: [...args.plan.args],
          ...(args.env === undefined ? {} : { env: args.env }),
        });
      } catch (error) {
        write({
          type: "error",
          provider: args.providerId,
          message: error instanceof Error ? error.message : String(error),
        });
        close();
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stdout",
          text,
        }),
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) =>
        write({
          type: "output",
          provider: args.providerId,
          stream: "stderr",
          text,
        }),
      );
      child.onError((error) => {
        write({
          type: "error",
          provider: args.providerId,
          message: error.message,
        });
        close();
      });
      child.onClose((exitCode, signal) => {
        write({
          type: "completed",
          provider: args.providerId,
          exitCode,
          signal,
          success: exitCode === 0,
        });
        close();
      });
    },
    cancel() {
      closed = true;
      release();
      child?.kill("SIGTERM");
    },
  });
}

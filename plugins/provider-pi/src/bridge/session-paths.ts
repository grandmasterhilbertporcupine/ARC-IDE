import { isAbsolute, join, resolve } from "node:path";

export const PI_BRIDGE_SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";

interface ResolvePiBridgeSessionDirArgs {
  env: NodeJS.ProcessEnv;
  dataDir?: string;
}

interface ResolvePiSessionFilePathArgs extends ResolvePiBridgeSessionDirArgs {
  threadId: string;
}

export function resolvePiBridgeSessionDir(
  args: ResolvePiBridgeSessionDirArgs,
): string {
  const configuredSessionDir = args.env[PI_BRIDGE_SESSION_DIR_ENV]?.trim();
  if (configuredSessionDir) {
    return resolve(configuredSessionDir);
  }

  if (args.dataDir === undefined || !isAbsolute(args.dataDir)) {
    throw new Error(
      "Pi session storage requires a managed absolute data directory",
    );
  }
  return join(args.dataDir, "pi-bridge-sessions");
}

export function resolvePiSessionFilePath(
  args: ResolvePiSessionFilePathArgs,
): string {
  return join(
    resolvePiBridgeSessionDir(args),
    `${sanitizeSessionKey(args.threadId)}.jsonl`,
  );
}

function sanitizeSessionKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}

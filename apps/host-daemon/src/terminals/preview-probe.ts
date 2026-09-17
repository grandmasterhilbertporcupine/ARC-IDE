import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveWindowsPowerShell } from "@bb/process-utils";
import type { TerminalPreviewProbeResult } from "@bb/host-daemon-contract";
const execute = promisify(execFile);
const processSchema = z.object({
  pid: z.number().int(),
  parent: z.number().int(),
});
export function listenerBelongsToTerminal(
  listener: number,
  terminalPid: number,
  processes: { pid: number; parent: number }[],
): boolean {
  const parents = new Map(
    processes.map((process) => [process.pid, process.parent]),
  );
  const seen = new Set<number>();
  let current = listener;
  while (current > 0 && !seen.has(current) && seen.size < 128) {
    if (current === terminalPid) return true;
    seen.add(current);
    current = parents.get(current) ?? 0;
  }
  return false;
}
async function listeners(port: number, platform: NodeJS.Platform) {
  const options = {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    encoding: "utf8" as const,
  };
  if (platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $processes=@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId} }); @{listeners=$listeners;processes=$processes} | ConvertTo-Json -Compress -Depth 4`;
    const { stdout } = await execute(
      resolveWindowsPowerShell(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      options,
    );
    return z
      .object({
        listeners: z.array(z.number().int()),
        processes: z.array(processSchema),
      })
      .parse(JSON.parse(stdout));
  }
  const [ports, tree] = await Promise.all([
    execute(
      "lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      options,
    ).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      )
        return { stdout: "" };
      throw error;
    }),
    execute("ps", ["-eo", "pid=,ppid="], options),
  ]);
  return {
    listeners: ports.stdout.trim().split(/\s+/u).filter(Boolean).map(Number),
    processes: tree.stdout
      .trim()
      .split(/\n/u)
      .map((line) => {
        const [pid, parent] = line.trim().split(/\s+/u).map(Number);
        return processSchema.parse({ pid, parent });
      }),
  };
}
export async function probeTerminalPreview(
  terminalPid: number,
  address: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TerminalPreviewProbeResult> {
  const url = new URL(address);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(
      url.hostname,
    )
  )
    return {
      state: "unavailable",
      statusCode: null,
      reason: "Readiness requires the server’s local URL on its owning machine",
    };
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  let owners: Awaited<ReturnType<typeof listeners>>;
  try {
    owners = await listeners(port, platform);
  } catch {
    return {
      state: "unavailable",
      statusCode: null,
      reason: "TCP listener ownership could not be inspected on this host",
    };
  }
  try {
    if (!owners.listeners.length)
      return {
        state: "starting",
        statusCode: null,
        reason: "Waiting for the preview command to listen on its port",
      };
    if (
      !owners.listeners.every((pid) =>
        listenerBelongsToTerminal(pid, terminalPid, owners.processes),
      )
    )
      return {
        state: "failed",
        statusCode: null,
        reason: `Port ${port} is already owned by another process; this preview did not start it`,
      };
    if (["0.0.0.0", "[::]"].includes(url.hostname)) url.hostname = "127.0.0.1";
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    if (response.status >= 500)
      return {
        state: "failed",
        statusCode: response.status,
        reason: `Preview server responded with HTTP ${response.status}`,
      };
    return { state: "ready", statusCode: response.status, reason: null };
  } catch {
    return {
      state: "starting",
      statusCode: null,
      reason:
        "Waiting for an HTTP response and verifiable process ownership on the preview host",
    };
  }
}

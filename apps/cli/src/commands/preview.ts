import { Command } from "commander";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import type { ProjectPreview } from "@bb/sdk";

interface Options {
  project: string;
  json?: boolean;
}
function print(value: ProjectPreview, options: Options) {
  console.log(
    options.json
      ? JSON.stringify(value)
      : `${value.status}${value.url ? ` · ${value.url}` : ""}${value.terminal ? `\nTerminal: ${value.terminal.id}` : ""}${value.cleanup ? `\nUnconfirmed session: ${value.cleanup.terminalId} on ${value.cleanup.hostId}` : ""}${value.error ? `\n${value.error}` : ""}${value.status === "detached" ? "\nTracking released. This did not stop or confirm exit of the old processes. Use show --json for retained session history." : ""}`,
  );
}
export function registerPreviewCommands(
  program: Command,
  getUrl: () => string,
) {
  const preview = program
    .command("preview")
    .description("Configure and run a project's owned live preview");
  const api = () => createCliBbSdk(getUrl()).experimental_previews;
  preview
    .command("detach")
    .description(
      "Release lost session tracking without stopping or confirming its processes",
    )
    .requiredOption("--project <id>", "Project ID")
    .requiredOption(
      "--terminal <id>",
      "Exact lost terminal ID reviewed with preview show",
    )
    .requiredOption(
      "--acknowledge-unconfirmed-process",
      "Acknowledge that detaching does not stop or confirm exit of the old processes",
    )
    .option("--json", "Print JSON")
    .action(
      action(
        async (
          options: Options & {
            terminal: string;
            acknowledgeUnconfirmedProcess: boolean;
          },
        ) => {
          if (options.acknowledgeUnconfirmedProcess !== true)
            throw new Error("Explicit acknowledgment is required");
          const current = await api().get({ projectId: options.project });
          print(
            await api().detach({
              projectId: options.project,
              expectedRevision: current.revision,
              terminalId: options.terminal,
              acknowledgeUnconfirmedProcess: true,
            }),
            options,
          );
        },
      ),
    );
  for (const operation of [
    "show",
    "start",
    "stop",
    "restart",
    "logs",
  ] as const) {
    preview
      .command(operation)
      .requiredOption("--project <id>", "Project ID")
      .option("--json", "Print JSON")
      .action(
        action(async (options: Options) => {
          const input = { projectId: options.project };
          const value =
            operation === "show" || operation === "logs"
              ? await api().get(input)
              : await api()[operation](input);
          if (operation === "logs" && !options.json) console.log(value.logs);
          else print(value, options);
        }),
      );
  }
  preview
    .command("configure")
    .requiredOption("--project <id>", "Project ID")
    .requiredOption("--host <id>", "Workspace host ID")
    .requiredOption("--cwd <path>", "Absolute launch directory on that host")
    .requiredOption(
      "--command <command>",
      "Command run only when preview is started",
    )
    .option(
      "--url <url>",
      "Explicit HTTP(S) preview URL; otherwise detect loopback URL from output",
      "",
    )
    .option("--json", "Print JSON")
    .action(
      action(
        async (
          options: Options & {
            host: string;
            cwd: string;
            command: string;
            url: string;
          },
        ) => {
          const current = await api().get({ projectId: options.project });
          print(
            await api().configure({
              projectId: options.project,
              expectedRevision: current.revision,
              config: {
                hostId: options.host,
                cwd: options.cwd,
                command: options.command,
                url: options.url,
              },
            }),
            options,
          );
        },
      ),
    );
}

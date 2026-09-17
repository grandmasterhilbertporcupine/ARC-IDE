import { describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerPreviewCommands } from "../../commands/preview.js";

describe("preview commands", () => {
  setupCommandOutputTestEnvironment();
  it("requires explicit acknowledgment before detaching and sends the reviewed terminal identity", async () => {
    const detach = vi.fn(async () => ({
      status: "detached",
      terminal: null,
      cleanup: null,
    }));
    const show = vi.fn(async () => ({ revision: 6 }));
    stubServerApi({
      "v1.projects.:id.preview.$get": show,
      "v1.projects.:id.preview.detach.$post": detach,
    });
    const args = [
      "preview",
      "detach",
      "--project",
      "project",
      "--terminal",
      "lost-terminal",
    ];
    await expect(
      runCommand(args, (program) =>
        registerPreviewCommands(program, () => "http://server"),
      ),
    ).rejects.toThrow("process.exit:1");
    expect(detach).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    await runCommand(
      [...args, "--acknowledge-unconfirmed-process", "--json"],
      (program) => registerPreviewCommands(program, () => "http://server"),
    );
    expect(detach).toHaveBeenCalledExactlyOnceWith({
      param: { id: "project" },
      json: {
        expectedRevision: 6,
        terminalId: "lost-terminal",
        acknowledgeUnconfirmedProcess: true,
      },
    });
  });
  it("saves an explicit host and directory against the current revision without starting a process", async () => {
    const configure = vi.fn(async () => ({
      status: "stopped",
      config: {},
      terminal: null,
    }));
    const start = vi.fn();
    stubServerApi({
      "v1.projects.:id.preview.$get": vi.fn(async () => ({ revision: 4 })),
      "v1.projects.:id.preview.configure.$post": configure,
      "v1.projects.:id.preview.start.$post": start,
    });
    await runCommand(
      [
        "preview",
        "configure",
        "--project",
        "project",
        "--host",
        "host",
        "--cwd",
        "C:\\Project Δ",
        "--command",
        "npm run dev",
        "--json",
      ],
      (program) => registerPreviewCommands(program, () => "http://server"),
    );
    expect(configure).toHaveBeenCalledWith({
      param: { id: "project" },
      json: {
        expectedRevision: 4,
        config: {
          hostId: "host",
          cwd: "C:\\Project Δ",
          command: "npm run dev",
          url: "",
        },
      },
    });
    expect(start).not.toHaveBeenCalled();
  });
});

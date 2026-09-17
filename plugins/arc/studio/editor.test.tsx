// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentEditor } from "./editor.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import type { AgentDetail } from "../contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  panel: { openFixedTab: vi.fn() },
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  experimental_useAppPanel: () => harness.panel,
  useBbNavigate: () => ({ toThread: vi.fn() }),
  experimental_ProviderModelPicker: () => <span>Model picker</span>,
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
  ThreadChat: () => <div>Thread</div>,
}));

function fixture(): AgentDetail {
  const metadata = defaultAgentMetadata("Interface builder");
  const document = serializeAgentDocument(
    metadata,
    "Build an accessible interface.",
  );
  return {
    id: "agent_00000000-0000-4000-8000-000000000001",
    scope: { kind: "library" },
    name: metadata.name,
    description: "",
    specialty: "",
    role: "",
    currentRevision: 1,
    draftVersion: 2,
    hasUnpublishedChanges: false,
    sourceAgentId: null,
    sourceRevision: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    draft: {
      version: 2,
      baseRevision: 1,
      document,
      metadata,
      attachments: [],
      contentHash: "hash",
      updatedAt: 2,
    },
  };
}

function openEditor(agent: AgentDetail) {
  render(
    <AgentEditor
      agentId={agent.id}
      scope={agent.scope}
      projects={[]}
      onRefresh={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  return screen.findByRole("textbox", { name: "Agent instructions" });
}

beforeEach(() => {
  harness.rpc.call.mockReset();
  harness.panel.openFixedTab.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Agent Studio editing", () => {
  it("restores the current published definition over saved unpublished draft changes", async () => {
    const published = fixture();
    let agent = {
      ...published,
      hasUnpublishedChanges: true,
      draft: {
        ...published.draft,
        document: serializeAgentDocument(
          published.draft.metadata,
          "A saved draft change.",
        ),
      },
    };
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listAgentRevisions")
        return {
          total: 1,
          revisions: [
            {
              agentId: published.id,
              revision: 1,
              document: published.draft.document,
              metadata: published.draft.metadata,
              attachments: [],
              contentHash: "published",
              createdAt: 1,
            },
          ],
        };
      if (method === "restoreAgentRevision")
        agent = { ...published, draft: { ...published.draft, version: 3 } };
      return { agent };
    });
    await openEditor(agent);
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    const restore = await screen.findByRole("button", {
      name: "Discard saved draft changes",
    });
    expect((restore as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() =>
      expect(harness.rpc.call).toHaveBeenCalledWith(
        "restoreAgentRevision",
        expect.objectContaining({ revision: 1, expectedDraftVersion: 2 }),
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Guide" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Agent instructions",
        }) as HTMLTextAreaElement
      ).value.trim(),
    ).toBe("Build an accessible interface.");
  });

  it.each(["Agent role", "Agent specialty", "Agent description"])(
    "preserves word separators while typing %s",
    async (label) => {
      const agent = fixture();
      harness.rpc.call.mockResolvedValue({ agent });
      await openEditor(agent);
      const input = screen.getByRole("textbox", { name: label });
      fireEvent.change(input, { target: { value: "Frontend " } });
      expect((input as HTMLInputElement).value).toBe("Frontend ");
      fireEvent.change(input, {
        target: { value: `${(input as HTMLInputElement).value}builder` },
      });
      expect((input as HTMLInputElement).value).toBe("Frontend builder");
    },
  );

  it("retains selected references after the file input resets during an async save", async () => {
    const agent = fixture();
    harness.rpc.call.mockResolvedValue({ agent });
    await openEditor(agent);
    const files = [
      new File(["Keyboard operation must work."], "requirements.md", {
        type: "text/markdown",
      }),
    ];
    fireEvent.change(screen.getByLabelText("Add agent reference files"), {
      target: { files },
    });
    files.length = 0;
    await waitFor(() =>
      expect(harness.rpc.call).toHaveBeenCalledWith(
        "addAgentAttachment",
        expect.objectContaining({
          agentId: agent.id,
          name: "requirements.md",
          contentBase64: btoa("Keyboard operation must work."),
        }),
      ),
    );
  });

  it("preserves trailing newlines while typing and keeps Guide usable while renaming", async () => {
    const agent = fixture();
    harness.rpc.call.mockResolvedValue({ agent });
    const instructions = await openEditor(agent);
    fireEvent.change(instructions, {
      target: { value: "First instruction.\n\n" },
    });
    expect((instructions as HTMLTextAreaElement).value).toBe(
      "First instruction.\n\n",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), {
      target: { value: "" },
    });
    expect(
      (screen.getByRole("textbox", { name: "Agent name" }) as HTMLInputElement)
        .value,
    ).toBe("");
    expect(screen.getByRole("textbox", { name: "Agent instructions" })).toBe(
      instructions,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save version",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), {
      target: { value: "UI reviewer" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Save version",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("recovers a local draft without silently overwriting a newer server version", async () => {
    const agent = fixture();
    const recovered = serializeAgentDocument(
      defaultAgentMetadata("Recovered agent"),
      "Keep my unsaved instructions.",
    );
    localStorage.setItem(
      `arc.agentDraft.${agent.id}`,
      JSON.stringify({ version: 1, document: recovered }),
    );
    harness.rpc.call.mockResolvedValue({ agent });
    await openEditor(agent);
    expect(
      (screen.getByRole("textbox", { name: "Agent name" }) as HTMLInputElement)
        .value,
    ).toBe("Recovered agent");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Review your recovered draft before saving over the newer server draft.",
    );
    expect(
      harness.rpc.call.mock.calls.every(([method]) => method === "getAgent"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Load saved draft and discard these edits",
      }),
    );
    expect(
      (screen.getByRole("textbox", { name: "Agent name" }) as HTMLInputElement)
        .value,
    ).toBe(agent.name);
  });

  it("keeps an invalid Markdown draft on reload and refuses to publish it", async () => {
    const agent = fixture();
    harness.rpc.call.mockResolvedValue({ agent });
    await openEditor(agent);
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Agent Markdown document" }),
      { target: { value: "---\n{ unfinished metadata" } },
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save version",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await waitFor(() =>
      expect(localStorage.getItem(`arc.agentDraft.${agent.id}`)).toContain(
        "unfinished metadata",
      ),
    );
    cleanup();
    render(
      <AgentEditor
        agentId={agent.id}
        scope={agent.scope}
        projects={[]}
        onRefresh={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText(
      "The Markdown metadata needs attention. Open Markdown to correct it.",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Agent Markdown document",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("---\n{ unfinished metadata");
  });

  it("keeps edits after a server revision conflict and sends the expected draft version", async () => {
    const agent = fixture();
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "getAgent") return { agent };
      throw new Error("draft_conflict: A newer draft exists");
    });
    const instructions = await openEditor(agent);
    fireEvent.change(instructions, {
      target: { value: "Check the keyboard workflow." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("draft_conflict: A newer draft exists");
    expect((instructions as HTMLTextAreaElement).value).toBe(
      "Check the keyboard workflow.",
    );
    expect(harness.rpc.call).toHaveBeenCalledWith(
      "saveAgentDraft",
      expect.objectContaining({ expectedDraftVersion: 2, agentId: agent.id }),
    );
  });
});

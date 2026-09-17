// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadChatProps } from "@get-bb/plugin-sdk/app";
import type { AgentDetail, AgentSession } from "../contract.js";
import { defaultAgentMetadata, serializeAgentDocument } from "../document.js";
import { AgentAssistantPanel, AgentTestPanel } from "./chat.js";
import { studioPath } from "./data.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  getAgent: vi.fn(),
  projects: vi.fn(),
  sessions: vi.fn(),
  startAssistant: vi.fn(),
  startTest: vi.fn(),
  navigate: { toThread: vi.fn() },
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  useBbNavigate: () => harness.navigate,
  ThreadChat: ({ threadId, variant, permissionPolicy }: ThreadChatProps) => (
    <div
      role="region"
      aria-label="Agent conversation"
      data-thread-id={threadId}
      data-variant={variant}
      data-permission-policy={permissionPolicy}
    />
  ),
}));

function fixture(): AgentDetail {
  const metadata = defaultAgentMetadata("Interface builder");
  return {
    id: "agent_00000000-0000-4000-8000-000000000001",
    scope: { kind: "library" },
    name: metadata.name,
    description: "",
    specialty: "",
    role: "",
    currentRevision: 3,
    draftVersion: 7,
    hasUnpublishedChanges: true,
    sourceAgentId: null,
    sourceRevision: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    draft: {
      version: 7,
      baseRevision: 3,
      document: serializeAgentDocument(
        metadata,
        "Build accessible interfaces.",
      ),
      metadata,
      attachments: [],
      contentHash: "draft-hash",
      updatedAt: 2,
    },
  };
}

const started = {
  threadId: "assistant-thread",
  executionContextId: "execution-1",
};
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);

beforeEach(() => {
  vi.clearAllMocks();
  harness.getAgent.mockReset();
  harness.projects.mockReset().mockResolvedValue({
    personalProjectId: "personal-project",
    projects: [{ id: "project-web", name: "Website" }],
  });
  harness.sessions.mockReset().mockResolvedValue({ sessions: [], total: 0 });
  harness.startAssistant.mockReset().mockResolvedValue(started);
  harness.startTest.mockReset().mockResolvedValue({
    threadId: "test-thread",
    executionContextId: "execution-test",
  });
  harness.rpc.call
    .mockReset()
    .mockImplementation((method: string, input: unknown) => {
      switch (method) {
        case "getAgent":
          return harness.getAgent(input);
        case "listStudioProjects":
          return harness.projects(input);
        case "listAgentSessions":
          return harness.sessions(input);
        case "startAgentAssistant":
          return harness.startAssistant(input);
        case "startAgentTest":
          return harness.startTest(input);
        default:
          throw new Error(`Unexpected RPC: ${method}`);
      }
    });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  if (matchMediaDescriptor === undefined) {
    Reflect.deleteProperty(window, "matchMedia");
  } else {
    Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
  }
});

function mount(agent = fixture(), purpose: "assistant" | "test" = "assistant") {
  harness.getAgent.mockResolvedValue({ agent });
  const Panel = purpose === "assistant" ? AgentAssistantPanel : AgentTestPanel;
  return render(<Panel subPath={studioPath(agent.scope, agent.id)} />);
}

async function assistantPrompt() {
  const prompt = await screen.findByRole("textbox", {
    name: "Ask the agent assistant",
  });
  if (!(prompt instanceof HTMLTextAreaElement))
    throw new Error("Expected assistant prompt");
  return prompt;
}

function assistantForm() {
  return screen.getByRole("form", {
    name: "Build this agent with the assistant",
  });
}

describe("Agent Studio assistant composer", () => {
  it("fills and focuses a prompt starter without dispatching a conversation", async () => {
    mount();
    const prompt = await assistantPrompt();
    fireEvent.click(
      screen.getByRole("button", { name: "Help define its role" }),
    );

    expect(prompt.value).toContain("Help me define this agent’s role");
    expect(document.activeElement).toBe(prompt);
    expect(
      screen.queryByRole("button", { name: "Help define its role" }),
    ).toBeNull();
    expect(harness.startAssistant).not.toHaveBeenCalled();
    expect(harness.startTest).not.toHaveBeenCalled();
  });

  it("submits Enter with the selected project and the current draft version", async () => {
    const agent = fixture();
    mount(agent);
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "Website" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Agent conversation project" }),
      {
        target: { value: "project-web" },
      },
    );
    fireEvent.change(prompt, {
      target: { value: "Add accessibility checks." },
    });
    expect(fireEvent.keyDown(prompt, { key: "Enter" })).toBe(false);

    await waitFor(() =>
      expect(harness.startAssistant).toHaveBeenCalledWith({
        agentId: agent.id,
        scope: { kind: "library" },
        projectId: "project-web",
        expectedDraftVersion: 7,
        prompt: "Add accessibility checks.",
      }),
    );
    expect(harness.startAssistant).toHaveBeenCalledTimes(1);
    expect(harness.startTest).not.toHaveBeenCalled();
  });

  it("preserves Shift+Enter and IME composition without sending", async () => {
    mount();
    const prompt = await assistantPrompt();
    fireEvent.change(prompt, { target: { value: "Explain its job" } });

    expect(fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(prompt, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(harness.startAssistant).not.toHaveBeenCalled();
    expect(prompt.value).toBe("Explain its job");
  });

  it("leaves coarse-pointer Return available for newlines and sends only when tapped", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => false,
      }),
    });
    mount();
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, { target: { value: "Review its role" } });

    expect(screen.getByText("Tap send to ask the assistant")).toBeTruthy();
    expect(
      screen.queryByText("Enter to send · Shift+Enter for a new line"),
    ).toBeNull();
    expect(fireEvent.keyDown(prompt, { key: "Enter" })).toBe(true);
    fireEvent.change(prompt, {
      target: { value: "Review its role\nand its checks." },
    });
    expect(prompt.value).toBe("Review its role\nand its checks.");
    expect(harness.startAssistant).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Send to agent assistant" }),
    );
    await waitFor(() =>
      expect(harness.startAssistant).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Review its role\nand its checks.",
          projectId: "personal-project",
        }),
      ),
    );
    expect(harness.startAssistant).toHaveBeenCalledTimes(1);
  });

  it("does not send IME key code 229 when isComposing is false", async () => {
    mount();
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, { target: { value: "改善代理指令" } });

    expect(
      fireEvent.keyDown(prompt, {
        key: "Enter",
        keyCode: 229,
        isComposing: false,
      }),
    ).toBe(true);
    expect(prompt.value).toBe("改善代理指令");
    expect(harness.startAssistant).not.toHaveBeenCalled();
  });

  it("does not resubmit a failed request while Enter remains held", async () => {
    harness.startAssistant.mockRejectedValueOnce(
      new Error("Provider temporarily unavailable"),
    );
    mount();
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, {
      target: { value: "Improve its review checks." },
    });
    fireEvent.keyDown(prompt, { key: "Enter", repeat: false });
    await screen.findByText("Provider temporarily unavailable");

    expect(fireEvent.keyDown(prompt, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(prompt, { key: "Enter", repeat: true })).toBe(
      false,
    );
    expect(harness.startAssistant).toHaveBeenCalledTimes(1);
    expect(prompt.value).toBe("Improve its review checks.");

    fireEvent.keyUp(prompt, { key: "Enter" });
    fireEvent.keyDown(prompt, { key: "Enter", repeat: false });
    await screen.findByRole("region", { name: "Agent conversation" });
    expect(harness.startAssistant).toHaveBeenCalledTimes(2);
  });

  it("guards repeated form submissions while the first request is pending", async () => {
    let finish: ((value: typeof started) => void) | undefined;
    harness.startAssistant.mockReturnValue(
      new Promise<typeof started>((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, { target: { value: "Review this role." } });
    const form = assistantForm();
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(harness.startAssistant).toHaveBeenCalledTimes(1);
    expect(prompt.disabled).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Starting agent assistant" })
        .hasAttribute("disabled"),
    ).toBe(true);
    if (finish === undefined) throw new Error("Submission was not started");
    const resolveSubmission = finish;
    await act(async () => resolveSubmission(started));
    await screen.findByRole("region", { name: "Agent conversation" });
  });

  it("keeps a failed draft and error, then retries and clears only after success", async () => {
    const agent = fixture();
    harness.startAssistant.mockRejectedValueOnce(
      new Error("Provider temporarily unavailable"),
    );
    mount(agent);
    const prompt = await assistantPrompt();
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, {
      target: { value: "Make the expected output clearer." },
    });
    fireEvent.submit(assistantForm());

    await screen.findByText("Provider temporarily unavailable");
    expect(screen.getByRole("alert").textContent).toContain(
      "Provider temporarily unavailable",
    );
    expect(prompt.value).toBe("Make the expected output clearer.");
    expect(
      localStorage.getItem(`arc.agentChatDraft.${agent.id}.assistant`),
    ).toBe(prompt.value);
    expect(
      screen
        .getByRole("button", { name: "Send to agent assistant" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Send to agent assistant" }),
    );

    const chat = await screen.findByRole("region", {
      name: "Agent conversation",
    });
    expect(chat.getAttribute("data-thread-id")).toBe("assistant-thread");
    expect(chat.getAttribute("data-variant")).toBe("compact");
    expect(chat.getAttribute("data-permission-policy")).toBe("editable");
    expect(harness.startAssistant).toHaveBeenCalledTimes(2);
    expect(harness.startAssistant.mock.calls[1]).toEqual(
      harness.startAssistant.mock.calls[0],
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      localStorage.getItem(`arc.agentChatDraft.${agent.id}.assistant`),
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Open full chat" }));
    expect(harness.navigate.toThread).toHaveBeenCalledWith("assistant-thread");
  });

  it("restores the assistant's saved prompt after remount without sending", async () => {
    const agent = fixture();
    mount(agent);
    const prompt = await assistantPrompt();
    fireEvent.change(prompt, {
      target: { value: "Keep this unfinished idea." },
    });
    cleanup();
    mount(agent);

    expect((await assistantPrompt()).value).toBe("Keep this unfinished idea.");
    expect(harness.startAssistant).not.toHaveBeenCalled();
  });

  it.each(["archived", "blank", "missing project"])(
    "refuses %s submissions even when the form is submitted directly",
    async (condition) => {
      const agent = fixture();
      if (condition === "archived") agent.archivedAt = 10;
      if (condition === "missing project")
        harness.projects.mockResolvedValue({
          personalProjectId: null,
          projects: [],
        });
      localStorage.setItem(
        `arc.agentChatDraft.${agent.id}.assistant`,
        condition === "blank" ? " \n " : "Help improve this agent.",
      );
      mount(agent);
      await assistantPrompt();
      await waitFor(() => expect(harness.projects).toHaveBeenCalled());
      expect(
        screen
          .getByRole("button", { name: "Send to agent assistant" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.submit(assistantForm());

      expect(harness.startAssistant).not.toHaveBeenCalled();
      expect(harness.startTest).not.toHaveBeenCalled();
    },
  );

  it("keeps a project agent scoped to its project", async () => {
    const agent = fixture();
    agent.scope = { kind: "project", projectId: "fixed-project" };
    mount(agent);
    const prompt = await assistantPrompt();
    expect(
      screen.queryByRole("combobox", { name: "Agent conversation project" }),
    ).toBeNull();
    fireEvent.change(prompt, {
      target: { value: "Improve this project agent." },
    });
    fireEvent.submit(assistantForm());

    await waitFor(() =>
      expect(harness.startAssistant).toHaveBeenCalledWith({
        agentId: agent.id,
        scope: agent.scope,
        projectId: "fixed-project",
        prompt: "Improve this project agent.",
        expectedDraftVersion: 7,
      }),
    );
  });

  it("retries a failed project lookup without losing the composed request", async () => {
    harness.projects.mockRejectedValueOnce(
      new Error("Projects temporarily unavailable"),
    );
    mount();
    const prompt = await assistantPrompt();
    fireEvent.change(prompt, { target: { value: "Help me set boundaries." } });
    await screen.findByText("Projects temporarily unavailable");
    expect(
      screen
        .getByRole("button", { name: "Send to agent assistant" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "No project" });

    expect(prompt.value).toBe("Help me set boundaries.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Send to agent assistant" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(harness.startAssistant).not.toHaveBeenCalled();
  });

  it("selects past sessions and opens a new composer without dispatching", async () => {
    const sessions: AgentSession[] = [
      {
        executionContextId: "newest",
        threadId: "newest-thread",
        projectId: "personal-project",
        purpose: "assistant",
        revision: null,
        draftVersion: 7,
        createdAt: 20,
      },
      {
        executionContextId: "earlier",
        threadId: "earlier-thread",
        projectId: "personal-project",
        purpose: "assistant",
        revision: null,
        draftVersion: 5,
        createdAt: 10,
      },
    ];
    harness.sessions.mockResolvedValue({ sessions, total: 2 });
    mount();
    const chat = await screen.findByRole("region", {
      name: "Agent conversation",
    });
    expect(chat.getAttribute("data-thread-id")).toBe("newest-thread");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await assistantPrompt();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Assistant session history" }),
      { target: { value: "earlier-thread" } },
    );

    expect(
      screen
        .getByRole("region", { name: "Agent conversation" })
        .getAttribute("data-thread-id"),
    ).toBe("earlier-thread");
    expect(screen.getByText("Interface builder · draft 5")).toBeTruthy();
    expect(harness.startAssistant).not.toHaveBeenCalled();
  });
});

describe("Agent Studio saved-version test chat", () => {
  it("launches the published revision rather than the current draft", async () => {
    const agent = fixture();
    mount(agent, "test");
    const prompt = await screen.findByRole("textbox", {
      name: "Agent test prompt",
    });
    await screen.findByRole("option", { name: "No project" });
    fireEvent.change(prompt, {
      target: { value: "Build a keyboard-accessible menu." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test version 3" }));

    await waitFor(() =>
      expect(harness.startTest).toHaveBeenCalledWith({
        agentId: agent.id,
        scope: agent.scope,
        projectId: "personal-project",
        prompt: "Build a keyboard-accessible menu.",
        revision: 3,
      }),
    );
    expect(harness.startAssistant).not.toHaveBeenCalled();
    expect(
      (
        await screen.findByRole("region", { name: "Agent conversation" })
      ).getAttribute("data-thread-id"),
    ).toBe("test-thread");
  });

  it("refuses to test an agent that has no published revision", async () => {
    const agent = fixture();
    agent.currentRevision = null;
    mount(agent, "test");
    const prompt = await screen.findByRole("textbox", {
      name: "Agent test prompt",
    });
    fireEvent.change(prompt, { target: { value: "Try these instructions." } });
    const send = screen.getByRole("button", { name: "Test version —" });
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.click(send);
    expect(harness.startTest).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Save a version");
  });
});

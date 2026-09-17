// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueAssistantDraft, useAssistantDraft } from "./assistant-draft.js";

function Composer({ draftKey }: { draftKey: string }) {
  const [prompt, setPrompt] = useState("");
  const [compose, setCompose] = useState(false);
  useAssistantDraft(draftKey, setPrompt, setCompose);
  return (
    <div>
      <textarea aria-label="Request draft" value={prompt} readOnly />
      <span>{compose ? "Composing" : "Conversation"}</span>
    </div>
  );
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("authoring assistant draft handoff", () => {
  it("retains an existing draft and opens a queued request when the panel mounts", () => {
    localStorage.setItem("agent-assistant", "Existing instructions");
    queueAssistantDraft("agent-assistant", "Build my skill");
    render(<Composer draftKey="agent-assistant" />);
    expect(
      screen.getByRole("textbox", { name: "Request draft" }),
    ).toHaveProperty("value", "Existing instructions\n\nBuild my skill");
    expect(screen.getByText("Composing")).toBeTruthy();
    expect(localStorage.getItem("agent-assistant.queued")).toBeNull();
  });
  it("updates only the matching mounted assistant and never submits the request", () => {
    render(<Composer draftKey="team-assistant" />);
    act(() => queueAssistantDraft("other-assistant", "Other request"));
    expect(
      screen.getByRole("textbox", { name: "Request draft" }),
    ).toHaveProperty("value", "");
    act(() => queueAssistantDraft("team-assistant", "Team-specific skill"));
    expect(
      screen.getByRole("textbox", { name: "Request draft" }),
    ).toHaveProperty("value", "Team-specific skill");
    expect(localStorage.getItem("team-assistant")).toBe("Team-specific skill");
  });
});

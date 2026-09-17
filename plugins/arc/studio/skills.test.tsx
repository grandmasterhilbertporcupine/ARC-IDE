// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SkillAssignments } from "./skills.js";
import { parseSkillMarkdown, renderSkillMarkdown } from "../skill-authoring.js";
import { arcAgentsRpcContract } from "../contract.js";

const harness = vi.hoisted(() => ({ rpc: { call: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
}));
const skill = {
  id: "a".repeat(64),
  name: "reader",
  description: "Use for large files.",
  files: [
    {
      path: "SKILL.md",
      executable: false,
      contentBase64: Buffer.from(
        "---\nname: reader\ndescription: Use for large files.\n---\n\nRead relevant sections.",
      ).toString("base64"),
    },
    {
      path: "references/data.bin",
      executable: false,
      contentBase64: "AAECAw==",
    },
  ],
};
beforeEach(() => {
  harness.rpc.call.mockReset();
  harness.rpc.call.mockImplementation(
    async (method: string, input: unknown) => {
      if (method === "parseAgentSkillMarkdown")
        return {
          fields: parseSkillMarkdown(
            arcAgentsRpcContract.parseAgentSkillMarkdown.input.parse(input)
              .markdown,
          ),
        };
      if (method === "renderAgentSkillMarkdown") {
        const args =
          arcAgentsRpcContract.renderAgentSkillMarkdown.input.parse(input);
        return { markdown: renderSkillMarkdown(args.markdown, args.fields) };
      }
      return {
        skill:
          method === "readAgentSkillBundle"
            ? skill
            : { ...skill, id: "c".repeat(64) },
      };
    },
  );
});
afterEach(cleanup);
describe("role skill assignments", () => {
  it("keeps inherited assignments read-only and removes only the selected extra", () => {
    const onChange = vi.fn();
    render(
      <SkillAssignments
        projectId="project-a"
        value={[{ id: skill.id, name: skill.name }]}
        inherited={[{ id: "b".repeat(64), name: "shared" }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reader assignment" }),
    );
    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.getByText("shared")).toBeTruthy();
    expect(harness.rpc.call).not.toHaveBeenCalled();
  });
  it("edits SKILL.md while preserving binary support files and creates a new pin", async () => {
    const onChange = vi.fn();
    render(
      <SkillAssignments
        projectId="project-a"
        value={[{ id: skill.id, name: skill.name }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reader" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Skill name" }),
      ).toHaveProperty("value", "reader"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit raw Markdown" }));
    const editor = await screen.findByRole("textbox", {
      name: "Skill Markdown",
    });
    fireEvent.change(editor, {
      target: {
        value:
          "---\nname: reader\ndescription: Use for large files.\n---\n\nUpdated procedure.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save skill and assign" }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        { id: "c".repeat(64), name: "reader" },
      ]),
    );
    expect(harness.rpc.call).toHaveBeenCalledWith("saveAgentSkillBundle", {
      files: [expect.objectContaining({ path: "SKILL.md" }), skill.files[1]],
    });
  });
  it("authors guided fields and supporting files while retaining binary bytes", async () => {
    const onChange = vi.fn();
    render(
      <SkillAssignments
        projectId="project-a"
        value={[{ id: skill.id, name: skill.name }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reader" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Skill name" }),
      ).toHaveProperty("value", "reader"),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "When to use this skill" }),
      { target: { value: "Use when reviewing large logs." } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Skill instructions" }),
      {
        target: {
          value: "Follow references/check.md and cite matching lines.",
        },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New supporting file path" }),
      { target: { value: "references/check.md" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Contents of references/check.md" }),
      { target: { value: "Find errors, then inspect nearby context." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save skill and assign" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const call = harness.rpc.call.mock.calls.find(
      ([method]) => method === "saveAgentSkillBundle",
    );
    const saved = arcAgentsRpcContract.saveAgentSkillBundle.input.parse(
      call?.[1],
    );
    expect(
      parseSkillMarkdown(
        Buffer.from(saved.files[0].contentBase64, "base64").toString(),
      ),
    ).toMatchObject({
      name: "reader",
      description: "Use when reviewing large logs.",
      instructions: expect.stringContaining("references/check.md"),
    });
    expect(saved.files[1]).toEqual(skill.files[1]);
    expect(Buffer.from(saved.files[2].contentBase64, "base64").toString()).toBe(
      "Find errors, then inspect nearby context.",
    );
  });
  it("queues an assistant request with the pinned base without saving or assigning a generated skill", async () => {
    const onChange = vi.fn();
    const onAskAssistant = vi.fn();
    render(
      <SkillAssignments
        projectId="project-a"
        value={[{ id: skill.id, name: skill.name }]}
        onChange={onChange}
        onAskAssistant={onAskAssistant}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reader" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Skill name" }),
      ).toHaveProperty("value", "reader"),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Skill instructions" }),
      { target: { value: "Help me make this procedure precise." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Build with assistant" }),
    );
    await waitFor(() =>
      expect(onAskAssistant).toHaveBeenCalledWith(
        expect.stringContaining(`"baseSkillId": "${skill.id}"`),
      ),
    );
    expect(onAskAssistant).toHaveBeenCalledWith(
      expect.stringContaining("Do not apply or publish"),
    );
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "saveAgentSkillBundle",
      ),
    ).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows missing pinned contents without dropping the assignment", async () => {
    const onChange = vi.fn();
    harness.rpc.call.mockRejectedValue(
      new Error("assigned_skill_missing: Restore this skill"),
    );
    render(
      <SkillAssignments
        projectId="project-a"
        value={[{ id: skill.id, name: skill.name }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reader" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Restore this skill",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

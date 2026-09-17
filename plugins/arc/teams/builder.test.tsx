// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TeamBuilder } from "./builder.js";
import { TeamAssistantPanel } from "./chat.js";
import { createTeamTestStore } from "./testing.js";
import { createArcTeamService } from "./service.js";
import type { BuilderSelection } from "./ui-data.js";
import type { TeamDefinition } from "./contract.js";
import type { ExperimentalProviderModelPickerProps } from "@get-bb/plugin-sdk";
import { canonicalTeamDefinition } from "./validation.js";
import {
  visibleTeamConnections,
  type TeamConnectionFilter,
} from "./organization-connections.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  panel: { openFixedTab: vi.fn() },
  listeners: new Set<() => void>(),
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: (_event: string, handler: () => void) => {
    harness.listeners.add(handler);
  },
  useBbNavigate: () => ({ toPluginPanel: vi.fn() }),
  experimental_useAppPanel: () => harness.panel,
  experimental_useProviders: () => ({
    status: "ready",
    providers: [
      { id: "codex", displayName: "Codex", logoUrl: "/codex.svg" },
      { id: "claude-code", displayName: "Claude Code", logoUrl: "/claude.svg" },
    ],
  }),
  experimental_ProviderModelPicker: ({
    onChange,
  }: ExperimentalProviderModelPickerProps) => (
    <button
      onClick={() =>
        onChange({
          providerId: "claude-code",
          model: "claude-sonnet-4-6",
          reasoningLevel: "high",
        })
      }
    >
      Choose Claude model
    </button>
  ),
  ThreadChat: ({ threadId }: { threadId: string }) => (
    <div>Conversation {threadId}</div>
  ),
}));
vi.mock("./canvas.js", () => ({
  TeamCanvas: ({
    definition,
    onSelect,
  }: {
    definition: TeamDefinition;
    onSelect(value: BuilderSelection): void;
  }) => (
    <div data-testid="graph">
      {definition.graph.nodes.map((node) => (
        <button
          key={node.id}
          onClick={() => onSelect({ kind: "node", id: node.id })}
        >
          Select {node.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./organization-canvas.js", () => ({
  OrganizationCanvas: ({
    definition,
    onSelect,
    selection,
    connectionFilter,
  }: {
    definition: TeamDefinition;
    onSelect(value: BuilderSelection): void;
    selection: BuilderSelection;
    connectionFilter: TeamConnectionFilter;
  }) => (
    <div data-testid="organization">
      {definition.members.map((member) => (
        <button
          key={member.id}
          onClick={() => onSelect({ kind: "member", id: member.id })}
        >
          Select member {member.id}
        </button>
      ))}
      {visibleTeamConnections(
        definition,
        connectionFilter,
        selection?.kind === "grant"
          ? selection.id
          : selection?.kind === "hierarchy"
            ? `leader:${selection.id}`
            : null,
      ).map((connection) => (
        <button
          key={connection.id}
          onClick={() =>
            onSelect(
              connection.relationship === "reports-to"
                ? { kind: "hierarchy", id: connection.source }
                : { kind: "grant", id: connection.id },
            )
          }
        >
          Select relationship {connection.id}
        </button>
      ))}
    </div>
  ),
}));

let fixture: ReturnType<typeof createTeamTestStore>;
let teamId: string;
const scope = { kind: "library" } as const;
const target = () => ({ teamId, scope });
const current = () => fixture.store.getTeam(target());
const emit = async () => {
  await act(async () => {
    for (const listener of harness.listeners) listener();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  harness.panel.openFixedTab.mockReturnValue(true);
  fixture = createTeamTestStore();
  teamId = fixture.store.createTeam({
    scope,
    definition: fixture.definition,
  }).id;
  const service = createArcTeamService(fixture.store, {
    requireProject: async () => {},
    authoringTeam: async () => null,
    changed: () => {},
  });
  harness.rpc.call.mockImplementation(
    async (method: string, input: unknown) => {
      if (method === "listStudioProjects")
        return {
          projects: [{ id: "project-1", name: "Test project" }],
          personalProjectId: "project-1",
        };
      if (method === "listAgents") return { agents: [fixture.agent], total: 1 };
      if (method === "listAssignedSkillCatalog") return { skills: [] };
      if (method === "getAgentRevision")
        return {
          revision: fixture.agents.getRevision({
            agentId: fixture.agent.id,
            scope,
            revision: 1,
          }),
        };
      if (method === "listTeamSessions") return { sessions: [], total: 0 };
      if (method === "startTeamAssistant")
        return {
          threadId: "thread-assistant",
          executionContextId: "team-execution-test",
        };
      return service.call(method, input);
    },
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  fixture.db.close();
});

async function open() {
  render(<TeamBuilder subPath={`library/${teamId}`} />);
  await screen.findByRole("button", { name: "Select Build" });
  fireEvent.click(screen.getByRole("button", { name: "Definition" }));
  return screen.getByRole("textbox", { name: "Team name" });
}

describe("Team authoring integration", () => {
  it("keeps a legacy team's execution identity unchanged when only its color changes", async () => {
    const before = current().draft;
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Set color" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition.presentation.color).toBe("#3b82f6");
    expect(current().draft.definition.schemaVersion).toBe(
      before.definition.schemaVersion,
    );
    expect(current().draft.operationalHash).toBe(before.operationalHash);
  });

  it("edits team identity and member model on the builder, saves and restores without changing the agent revision", async () => {
    const originalAgent = fixture.agents.getRevision({
      agentId: fixture.agent.id,
      scope,
      revision: 1,
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Team name" }), {
      target: { value: "Design team" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set color" }));
    fireEvent.change(screen.getByLabelText("Team color"), {
      target: { value: "#8b5cf6" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select member builder" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Change model for/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose Claude model" }),
    );
    expect(
      JSON.parse(localStorage.getItem(`arc.teamDraft.${teamId}`)!).definition
        .members[0].modelOverride,
    ).toBeUndefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel model change" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Change model for/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose Claude model" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply model" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition).toMatchObject({
      name: "Design team",
      presentation: { color: "#8b5cf6" },
      members: [
        {
          modelOverride: {
            providerId: "claude-code",
            model: "claude-sonnet-4-6",
            reasoningLevel: "high",
            serviceTier: "default",
          },
        },
      ],
    });
    expect(
      fixture.agents.getRevision({
        agentId: fixture.agent.id,
        scope,
        revision: 1,
      }),
    ).toEqual(originalAgent);
    cleanup();
    localStorage.clear();
    render(<TeamBuilder subPath={`library/${teamId}`} />);
    expect(
      await screen.findByRole("textbox", { name: "Team name" }),
    ).toHaveProperty("value", "Design team");
    expect(screen.getByLabelText("Team color")).toHaveProperty(
      "value",
      "#8b5cf6",
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Select member builder" }),
    );
    expect(
      await screen.findByRole("img", { name: "Claude Code" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use agent default" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset team color" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition.presentation.color).toBeUndefined();
    expect(current().draft.definition.members[0].modelOverride).toBeUndefined();
  });

  it("edits member responsibility through the Team canvas, supports undo, and saves a versioned definition without changing work order", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select member builder" }),
    );
    const role = await screen.findByRole("textbox", {
      name: "Member team role",
    });
    fireEvent.change(role, { target: { value: "Frontend lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select member builder" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Member team role" }),
    ).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select member builder" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Member responsibility" }),
      { target: { value: "Own responsive UI and accessibility." } },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Team lead/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition).toMatchObject({
      schemaVersion: 2,
      leaderMemberId: "builder",
      members: [
        {
          id: "builder",
          role: "Frontend lead",
          responsibility: "Own responsive UI and accessibility.",
        },
      ],
    });
    expect(current().draft.definition.graph).toEqual(
      canonicalTeamDefinition(fixture.definition).graph,
    );
  });

  it("adds a subagent with explicit grants, persists it, and links the same member to a workflow task", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select member builder" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Add subagent" }),
    );
    const palette = await screen.findByRole("button", {
      name: /Pinned builder v1/,
    });
    expect(palette).toHaveProperty("draggable", true);
    fireEvent.click(palette);
    await screen.findByRole("textbox", { name: "Member team role" });
    fireEvent.click(screen.getByRole("button", { name: "Add a task" }));
    await screen.findByRole("button", { name: "Select Agent task" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const definition = current().draft.definition;
    const child = definition.members.find((member) => member.id !== "builder");
    expect(child?.leaderMemberId).toBe("builder");
    expect(definition.permissions).toHaveLength(3);
    expect(definition.graph.nodes).toContainEqual(
      expect.objectContaining({ kind: "agent", memberId: child?.id }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    const filter = screen.getByRole("combobox", {
      name: "Visible connections",
    });
    expect(filter).toHaveProperty("value", "reports-to");
    expect(
      screen.getAllByRole("button", { name: /^Select relationship/ }),
    ).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "all" } });
    expect(
      screen.getAllByRole("button", { name: /^Select relationship/ }),
    ).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Undo" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(current().draft.definition).toEqual(definition);
    fireEvent.change(filter, { target: { value: "reports-to" } });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Relationship type" }),
      { target: { value: "review" } },
    );
    fireEvent.click(screen.getByText("Connect agents with the keyboard"));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Relationship source" }),
      { target: { value: "builder" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Relationship target" }),
      { target: { value: child!.id } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect agents" }));
    expect(filter).toHaveProperty("value", "review");
    const connection = screen.getByRole("button", {
      name: /^Select relationship/,
    });
    fireEvent.click(connection);
    fireEvent.change(filter, { target: { value: "reports-to" } });
    expect(
      screen.getAllByRole("button", { name: /^Select relationship/ }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition.permissions).toHaveLength(4);
    expect(current().draft.definition.permissions).toEqual(
      expect.arrayContaining([
        ...definition.permissions,
        expect.objectContaining({
          fromMemberId: "builder",
          toMemberId: child!.id,
          action: "review",
        }),
      ]),
    );
    expect(current().draft.definition.graph).toEqual(definition.graph);
  });

  it("persists unfinished edits, restores them on remount, and saves without false conflict", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "Frontend " } });
    expect(input).toHaveProperty("value", "Frontend ");
    cleanup();
    const restored = await open();
    expect(restored).toHaveProperty("value", "Frontend ");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition.name).toBe("Frontend");
    expect(
      screen.queryByRole("button", {
        name: "Discard local edits and load latest",
      }),
    ).toBeNull();
    expect(screen.getByRole("textbox", { name: "Team name" })).toHaveProperty(
      "value",
      "Frontend",
    );
  });

  it("keeps dirty local work when another client saves and requires explicit conflict resolution", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "My local team" } });
    const before = current();
    fixture.store.saveDraft({
      ...target(),
      expectedDraftVersion: before.draft.version,
      definition: { ...before.draft.definition, name: "Remote edit" },
    });
    await emit();
    const discard = await screen.findByRole("button", {
      name: "Discard local edits and load latest",
    });
    expect(input).toHaveProperty("value", "My local team");
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(discard);
    expect(input).toHaveProperty("value", "Remote edit");
    expect(current().draft.definition.name).toBe("Remote edit");
  });

  it("updates a clean editor from external saves and preserves any/all required results through save", async () => {
    const input = await open();
    const before = current();
    fixture.store.saveDraft({
      ...target(),
      expectedDraftVersion: before.draft.version,
      definition: { ...before.draft.definition, name: "Updated team" },
    });
    await emit();
    await waitFor(() => expect(input).toHaveProperty("value", "Updated team"));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Requirement 1 needs" }),
      { target: { value: "any" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    expect(current().draft.definition.graph.requiredGates).toEqual([
      { id: "verification", mode: "any", nodeIds: ["check", "review"] },
    ]);
  });

  it("disables applying stale or locally conflicting proposals and displays their evidence", async () => {
    const before = current();
    fixture.store.propose({
      ...target(),
      expectedDraftVersion: before.draft.version,
      definition: { ...before.draft.definition, name: "Suggested name" },
      summary: "Clarify the team name",
      evidence: [
        {
          source: "User request",
          detail: "Keep the frontend responsibility visible.",
        },
      ],
      authorThreadId: null,
    });
    const input = await open();
    fireEvent.change(input, { target: { value: "Local edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    expect(
      await screen.findByRole("button", { name: "Apply to draft" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Keep the frontend responsibility visible."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Definition" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Discard local edits" }),
    );
    fixture.store.saveDraft({
      ...target(),
      expectedDraftVersion: before.draft.version,
      definition: { ...before.draft.definition, name: "New server version" },
    });
    await emit();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Team name" })).toHaveProperty(
        "value",
        "New server version",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    expect(
      await screen.findByRole("button", { name: "Apply to draft" }),
    ).toHaveProperty("disabled", true);
    expect(current().draft.definition.name).toBe("New server version");
  });

  it("starts no assistant on mount and sends only the saved selected draft after explicit submission", async () => {
    render(<TeamAssistantPanel subPath={`library/${teamId}`} />);
    const prompt = await screen.findByRole("textbox", {
      name: "Ask the team assistant",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Team assistant project" }),
      ).toHaveProperty("value", "project-1"),
    );
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "startTeamAssistant",
      ),
    ).toBe(false);
    fireEvent.change(prompt, { target: { value: "Help me add a reviewer." } });
    fireEvent.click(screen.getByRole("button", { name: "Start assistant" }));
    await screen.findByText("Conversation thread-assistant");
    expect(harness.rpc.call).toHaveBeenCalledWith("startTeamAssistant", {
      ...target(),
      expectedDraftVersion: current().draft.version,
      projectId: "project-1",
      prompt: "Help me add a reviewer.",
    });
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "startTeamAssistant",
      ),
    ).toHaveLength(1);
  });
});

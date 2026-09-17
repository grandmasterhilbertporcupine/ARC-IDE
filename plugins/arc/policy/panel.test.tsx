// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { OrchestrationPanel } from "./panel.js";
import { createTeamTestStore, teamTarget } from "../teams/testing.js";
import { createArcTeamService } from "../teams/service.js";
import { createPolicyService } from "./service.js";
import { createPolicyStore, policyMigrations } from "./data.js";
import { defaultRunPolicy, defaultSessionOverrides } from "./contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toPluginPanel: vi.fn() },
  listeners: new Map<string, Set<() => void>>(),
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useBbNavigate: () => harness.navigate,
  useRealtime: (event: string, handler: () => void) => {
    const listeners = harness.listeners.get(event) ?? new Set<() => void>();
    listeners.add(handler);
    harness.listeners.set(event, listeners);
  },
}));

const scope = { kind: "project", projectId: "project-a" } as const;
let fixture: ReturnType<typeof createTeamTestStore>;
let store: ReturnType<typeof createPolicyStore>;
let service: ReturnType<typeof createPolicyService>;
let teamId: string;
let failRead: boolean;
const sessions = Array.from({ length: 52 }, (_, index) => ({
  id: `thread-${index + 1}`,
  title: `Conversation ${index + 1}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  failRead = false;
  fixture = createTeamTestStore(scope);
  fixture.db.exec(policyMigrations.join(";\n"));
  store = createPolicyStore(fixture.db);
  let team = fixture.store.createTeam({
    scope,
    definition: fixture.definition,
  });
  team = fixture.store.publish(teamTarget(team));
  team = fixture.store.saveDraft({
    ...teamTarget(team),
    definition: {
      ...fixture.definition,
      description: "Second immutable version",
    },
  });
  team = fixture.store.publish(teamTarget(team));
  teamId = team.id;
  service = createPolicyService(store, fixture.store, {
    async listThreads({ limit, offset }) {
      return sessions.slice(offset, offset + limit);
    },
    async requireProject(projectId) {
      if (projectId !== "project-a") throw new Error("Project is unavailable");
    },
    async threadProject(threadId) {
      return sessions.some((thread) => thread.id === threadId)
        ? "project-a"
        : "project-b";
    },
    changed() {},
  });
  const teams = createArcTeamService(fixture.store, {
    requireProject: async () => {},
    authoringTeam: async () => null,
    changed() {},
  });
  harness.rpc.call.mockImplementation(
    async (method: string, input: unknown) => {
      if (method === "listStudioProjects")
        return {
          projects: [{ id: "project-a", name: "Project A" }],
          personalProjectId: null,
        };
      if (method === "getOrchestrationPolicy" && failRead)
        throw new Error("Settings connection unavailable");
      if (
        [
          "listTeams",
          "getTeam",
          "getTeamRevision",
          "listTeamRevisions",
        ].includes(method)
      )
        return teams.call(method, input);
      return service.call(method, input, { kind: "user" });
    },
  );
});
afterEach(() => {
  cleanup();
  fixture.db.close();
});

async function open(threadId: string | null = null) {
  render(
    <OrchestrationPanel
      subPath={`project/project-a${threadId === null ? "" : `/session/${threadId}`}`}
    />,
  );
  await screen.findByLabelText("Orchestrator freedom");
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Settings saved");
}
async function emit(event = "policy:changed") {
  await act(async () => {
    for (const listener of harness.listeners.get(event) ?? []) listener();
  });
}
async function pin(label: "Preferred" | "Allowed", revision: number) {
  fireEvent.click(
    screen.getByRole("button", { name: `Add ${label.toLowerCase()} team` }),
  );
  await screen.findByRole("option", { name: "Build and verify · latest v2" });
  change(`${label} team`, teamId);
  await screen.findByRole("option", {
    name: `v${revision} · Build and verify`,
  });
  change(`${label} published version`, String(revision));
  fireEvent.click(
    screen.getByRole("button", { name: `Pin ${label.toLowerCase()} version` }),
  );
}

describe("Orchestration settings with real versioned stores", () => {
  it("persists project limits and autonomy, retaining immutable readable history after a second edit", async () => {
    await open();
    change("Orchestrator freedom", "guided");
    change("Agents at once", "2");
    change("Active time (seconds)", "60.001");
    await save();
    expect(store.project("project-a")).toMatchObject({
      version: 1,
      policy: {
        autonomy: "guided",
        limits: { maxConcurrentAgents: 2, maxActiveMs: 60001 },
      },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Save settings" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    change("Orchestrator freedom", "autonomous");
    await save();
    expect(
      store
        .history({
          projectId: "project-a",
          threadId: null,
          offset: 0,
          limit: 10,
        })
        .revisions.map((revision) => revision.value.autonomy),
    ).toEqual(["autonomous", "guided"]);
    fireEvent.click(screen.getByRole("button", { name: "View saved history" }));
    const history = await screen.findByRole("region", {
      name: "Saved settings history",
    });
    await within(history).findByText(/^Version 1/);
    expect(within(history).getByText("guided")).toBeTruthy();
    expect(within(history).getAllByText(/60.001s active/)).toHaveLength(2);
    cleanup();
    await open();
    expect(
      (screen.getByLabelText("Orchestrator freedom") as HTMLSelectElement)
        .value,
    ).toBe("autonomous");
    expect(
      (screen.getByLabelText("Active time (seconds)") as HTMLInputElement)
        .value,
    ).toBe("60.001");
  });

  it("distinguishes no preference and no allowed teams from inheritance without changing project defaults", async () => {
    const project = store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: {
        ...defaultRunPolicy(),
        preferredTeams: [{ teamId, revision: 1 }],
      },
    });
    await open("thread-1");
    expect(
      (screen.getByLabelText("Preferred teams") as HTMLSelectElement).value,
    ).toBe("inherit");
    change("Preferred teams", "none");
    change("Allowed teams", "teams");
    await screen.findByText("No teams allowed. Add a version to allow it.");
    await save();
    expect(
      store.view({ projectId: "project-a", threadId: "thread-1" }).effective,
    ).toMatchObject({ preferredTeams: [], restrictedTeams: [] });
    expect(store.project("project-a")).toEqual(project);
    fireEvent.click(
      screen.getByRole("button", { name: "Use all project defaults" }),
    );
    await save();
    expect(store.session("project-a", "thread-1").overrides).toEqual(
      defaultSessionOverrides(),
    );
    expect(
      store.view({ projectId: "project-a", threadId: "thread-1" }).effective
        ?.preferredTeams,
    ).toEqual([{ teamId, revision: 1 }]);
  });

  it("retains a dirty draft after an actual CAS conflict and resets only by explicit action", async () => {
    store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: defaultRunPolicy(),
    });
    await open();
    change("Orchestrator freedom", "guided");
    store.saveProject({
      projectId: "project-a",
      expectedVersion: 1,
      policy: { ...defaultRunPolicy(), autonomy: "autonomous" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText(/These settings changed elsewhere/);
    expect(
      (screen.getByLabelText("Orchestrator freedom") as HTMLSelectElement)
        .value,
    ).toBe("guided");
    expect(store.project("project-a").version).toBe(2);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Save settings" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByLabelText("Project").hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to latest" }));
    expect(
      (screen.getByLabelText("Orchestrator freedom") as HTMLSelectElement)
        .value,
    ).toBe("autonomous");
    await waitFor(() =>
      expect(screen.getByLabelText("Project").hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });

  it("reconciles clean settings but preserves dirty changes when a realtime update arrives", async () => {
    await open();
    store.saveProject({
      projectId: "project-a",
      expectedVersion: 0,
      policy: { ...defaultRunPolicy(), autonomy: "autonomous" },
    });
    await emit();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Orchestrator freedom") as HTMLSelectElement)
          .value,
      ).toBe("autonomous"),
    );
    change("Agents at once", "2");
    store.saveProject({
      projectId: "project-a",
      expectedVersion: 1,
      policy: { ...defaultRunPolicy(), autonomy: "guided" },
    });
    await emit();
    await screen.findByText(
      /Settings changed elsewhere. Your edits are preserved/,
    );
    expect(
      (screen.getByLabelText("Agents at once") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "saveProjectPolicy",
      ),
    ).toHaveLength(0);
  });

  it("pins an older published version exactly, enforcing the same allowed version and keeping it after later publication", async () => {
    await open();
    change("Allowed teams", "teams");
    await pin("Allowed", 1);
    change("Preferred teams", "teams");
    await pin("Preferred", 2);
    expect(
      screen
        .getByRole("button", { name: "Save settings" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: `Remove preferred ${teamId} version 2`,
      }),
    );
    await pin("Preferred", 1);
    await save();
    expect(store.project("project-a").policy).toMatchObject({
      preferredTeams: [{ teamId, revision: 1 }],
      restrictedTeams: [{ teamId, revision: 1 }],
    });
    let current = fixture.store.getTeam({ scope, teamId });
    current = fixture.store.saveDraft({
      ...teamTarget(current),
      definition: {
        ...fixture.definition,
        name: "Renamed newer team",
        description: "Third version",
      },
    });
    fixture.store.publish(teamTarget(current));
    await emit("teams:changed");
    expect(store.project("project-a").policy.preferredTeams).toEqual([
      { teamId, revision: 1 },
    ]);
    await within(
      screen.getByRole("list", { name: "Preferred team versions" }),
    ).findByText("Build and verify · v1");
  });

  it("loads later session pages and retries a failed settings read without exposing a writable placeholder", async () => {
    failRead = true;
    render(<OrchestrationPanel subPath="project/project-a" />);
    await screen.findByText("Settings connection unavailable", {
      exact: false,
    });
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    failRead = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry settings" }));
    await screen.findByLabelText("Orchestrator freedom");
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more sessions" }),
    );
    await screen.findByRole("option", { name: "Session · Conversation 52" });
    change("Settings for", "thread-52");
    expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith(
      "orchestration",
      { subPath: "project/project-a/session/thread-52" },
    );
    expect(
      harness.rpc.call.mock.calls.some(
        ([method, input]) =>
          method === "listPolicySessions" && input.offset === 50,
      ),
    ).toBe(true);
    cleanup();
    render(
      <OrchestrationPanel subPath="project/project-a/session/foreign-thread" />,
    );
    await screen.findByText(/does not belong to the selected project/);
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });

  it("blocks invalid work limits while preserving zero repair rounds as an explicit supported bound", async () => {
    await open();
    change("Agents at once", "0");
    expect(
      screen
        .getByRole("button", { name: "Save settings" })
        .hasAttribute("disabled"),
    ).toBe(true);
    change("Agents at once", "2");
    change("Repair rounds", "0");
    await save();
    expect(store.project("project-a").policy.limits).toMatchObject({
      maxConcurrentAgents: 2,
      maxRepairRounds: 0,
    });
  });

  it("pages the actual project team inventory to select a published version beyond the first fifty records", async () => {
    for (let index = 0; index < 55; index += 1)
      fixture.store.createTeam({
        scope,
        definition: { ...fixture.definition, name: `Newer draft ${index}` },
      });
    await open();
    change("Allowed teams", "teams");
    fireEvent.click(screen.getByRole("button", { name: "Add allowed team" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Next teams" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      screen.queryByRole("option", { name: "Build and verify · latest v2" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next teams" }));
    await screen.findByRole("option", { name: "Build and verify · latest v2" });
    change("Allowed team", teamId);
    await screen.findByRole("option", { name: "v1 · Build and verify" });
    change("Allowed published version", "1");
    fireEvent.click(
      screen.getByRole("button", { name: "Pin allowed version" }),
    );
    await save();
    expect(store.project("project-a").policy.restrictedTeams).toEqual([
      { teamId, revision: 1 },
    ]);
    expect(
      harness.rpc.call.mock.calls.some(
        ([method, input]) =>
          method === "listTeams" &&
          input.offset === 50 &&
          input.scope.projectId === "project-a",
      ),
    ).toBe(true);
  });
});

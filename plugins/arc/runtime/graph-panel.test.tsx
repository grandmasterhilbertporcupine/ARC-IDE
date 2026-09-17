// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { z } from "zod";
import { GraphRunRoute, RunControls, graphRunPath } from "./graph-panel.js";
import { RuntimePanel } from "./panel.js";
import { graphRunDefinitionFixture } from "./graph-testing.js";
import { orchestratedDefinitionFixture } from "./orchestrated-testing.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { runtimeHash } from "./hash.js";
import {
  defaultSessionOverrides,
  policyViewSchema,
} from "../policy/contract.js";
import { arcRunsRpcContract, type ArcRunView } from "./contract.js";
import type { RunControl } from "./control-contract.js";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => harness.rpc,
  useRealtime: () => undefined,
  useBbNavigate: () => harness.navigate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(cleanup);

function fixture() {
  const definition = graphRunDefinitionFixture();
  const run: ArcRunView = {
    definition,
    summary: {
      runId: definition.runId,
      projectId: definition.request.projectId,
      goal: definition.request.goal,
      planHash: runtimeHash(definition),
      createdAt: 1,
      workflowRunId: "workflow-a",
      submission: "submitted",
      submissionError: null,
    },
    workflow: {
      workflowRunId: "workflow-a",
      ownerRunId: definition.runId,
      projectId: definition.request.projectId,
      originThreadId: definition.request.originThreadId,
      planHash: runtimeHash(definition),
      state: "running",
      desiredControl: "run",
      controlVersion: 1,
      dispatchGeneration: 1,
      limits: definition.policy.limits,
      agentCalls: 0,
      activeAgents: 0,
      chargedActiveMs: 0,
      repairRounds: [],
      result: { available: false },
      error: null,
    },
    verification: {
      state: "pending",
      reason: null,
      head: null,
      workspacePath: null,
    },
  };
  const policy: z.infer<typeof policyViewSchema> = {
    project: {
      projectId: definition.request.projectId,
      version: 4,
      policy: definition.policy,
      createdAt: 1,
    },
    session: {
      projectId: definition.request.projectId,
      threadId: definition.request.originThreadId,
      version: 2,
      overrides: defaultSessionOverrides(),
      createdAt: 1,
    },
    effective: definition.policy,
    errors: [],
  };
  const setup: z.infer<typeof arcRunsRpcContract.getRunSetup.output> = {
    sources: [
      { hostId: definition.request.hostId, path: definition.source.path },
    ],
    selected: {
      hostId: definition.request.hostId,
      path: definition.source.path,
      head: definition.source.head,
      clean: true,
    },
    threads: [{ id: "prepared-worker-must-not-be-listed", title: "Worker" }],
  };
  const route = graphRunPath(
    definition.request.projectId,
    definition.team.teamId,
    definition.team.revision,
  );
  function read(method: string) {
    if (method === "listStudioProjects")
      return {
        projects: [{ id: definition.request.projectId, name: "Project A" }],
        personalProjectId: null,
      };
    if (method === "listRuns") return { runs: [], total: 0 };
    if (method === "getTeamRevision") return { revision: definition.team };
    if (method === "getAgentRevision")
      return { revision: definition.members.builder.definition };
    if (method === "getRunSetup") return setup;
    if (method === "getProjectRunSetup")
      return { ...setup, selected: { kind: "git", ...setup.selected } };
    if (method === "listPolicySessions")
      return {
        threads: [
          {
            id: definition.request.originThreadId,
            title: "Main build conversation",
          },
        ],
        hasMore: false,
      };
    if (method === "getOrchestrationPolicy") return policy;
    if (method === "startTeamRun") return run;
    throw new Error(`Unexpected ${method}`);
  }
  return { definition, run, policy, setup, route, read };
}

async function enterGoal(parent = "thread-parent") {
  await screen.findByRole("option", { name: "Main build conversation" });
  fireEvent.change(screen.getByLabelText("Main conversation"), {
    target: { value: parent },
  });
  fireEvent.change(screen.getByLabelText("What should the team deliver?"), {
    target: { value: "Build the requested application" },
  });
}

function controlFixture(run: ArcRunView, delegation = false): RunControl {
  if (run.definition.schemaVersion === 1) throw new Error("Expected graph run");
  return {
    controlId: "control-one",
    runId: run.summary.runId,
    effectId: "effect-one",
    contextHash: "c".repeat(64),
    revision: 3,
    state: "pending",
    decision: null,
    operationId: null,
    createdAt: 1,
    updatedAt: 1,
    context: {
      schemaVersion: run.definition.schemaVersion === 4 ? 2 : 1,
      runId: run.summary.runId,
      effectId: "effect-one",
      planHash: run.summary.planHash,
      requestHash: "d".repeat(64),
      nodeId: "arcg_plan_approval",
      iteration: 0,
      operation: delegation
        ? {
            type: "delegation",
            requester: { nodeId: "requester", iteration: 0 },
            candidate: { nodeId: "source", iteration: 0 },
            candidateMemberIds: ["builder"],
            maxChildCalls: 2,
            task: "Review the proposed changes",
            access: "read",
          }
        : {
            type: "approval",
            message: "Approve this exact team plan and source revision.",
            candidate: null,
          },
      candidate: null,
      policyHash: runtimeHash(run.definition.policy),
      teamContentHash: run.definition.team.contentHash,
      dependencyReceipts: [],
      proposedAssignments: delegation
        ? [{ memberId: "builder" }, { memberId: "builder" }]
        : null,
    },
  };
}

describe("Published team run UI", () => {
  it("recovers a V3 native request by retained run ID and keeps its approval and counted main response visible", async () => {
    const f = fixture();
    f.run.definition = orchestratedDefinitionFixture();
    f.run.summary.workflowRunId = null;
    f.run.summary.submission = "needs-reconciliation";
    f.run.summary.submissionError = "Native admission response was lost";
    const resumed: ArcRunView = {
      ...f.run,
      summary: {
        ...f.run.summary,
        workflowRunId: "workflow-a",
        submission: "submitted",
        submissionError: null,
      },
    };
    f.run.workflow = null;
    const control = controlFixture(resumed);
    let reconciled = false;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "getRun") return reconciled ? resumed : f.run;
      if (method === "getRunReviewAuthority")
        return { state: "authorized", diagnostics: [] };
      if (method === "getRunUpdateState")
        return { incoming: null, outgoing: null };
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "listRunControls")
        return { controls: [control], total: 1 };
      if (method === "reconcileOrchestratedRun") {
        reconciled = true;
        return resumed;
      }
      throw new Error(`Unexpected ${method}`);
    });
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    const reconcile = await screen.findByRole("button", {
      name: "Reconcile saved request",
    });
    await waitFor(() => expect(reconcile.hasAttribute("disabled")).toBe(false));
    fireEvent.click(reconcile);
    await screen.findByText("agent calls", { exact: false });
    expect(harness.rpc.call).toHaveBeenCalledWith("reconcileOrchestratedRun", {
      runId: f.run.summary.runId,
    });
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "startTeamRun" || method === "requestTeamRun",
      ),
    ).toBe(false);
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeDefined();
    expect(
      within(
        screen.getByRole("article", { name: "Plan or task approval" }),
      ).getByText(
        resumed.definition.schemaVersion === 3
          ? resumed.definition.team.definition.name
          : "unreachable",
        { exact: false },
      ),
    ).toBeDefined();
  });
  it("reads the exact published revision and normal main conversations without starting agents", async () => {
    const f = fixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      f.read(method),
    );
    render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={vi.fn()} />,
    );
    await screen.findByRole("heading", { name: "Build and verify · v1" });
    expect(harness.rpc.call).toHaveBeenCalledWith("getTeamRevision", {
      scope: { kind: "project", projectId: f.definition.request.projectId },
      teamId: f.definition.team.teamId,
      revision: 1,
    });
    const options = within(
      screen.getByLabelText("Main conversation"),
    ).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Choose an existing conversation",
      "Main build conversation",
    ]);
    expect(screen.queryByText("Worker", { exact: true })).toBeNull();
    expect(
      harness.rpc.call.mock.calls.every(([method]) =>
        [
          "getTeamRevision",
          "getAgentRevision",
          "getProjectRunSetup",
          "listPolicySessions",
          "getOrchestrationPolicy",
        ].includes(method),
      ),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Start published team run" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("retries a lost start across reloads with the same pinned team, source, policy versions and operation", async () => {
    const f = fixture();
    let starts = 0;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "startTeamRun" && ++starts === 1)
        throw new Error("Start response lost");
      return f.read(method);
    });
    const started = vi.fn();
    const first = render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={started} />,
    );
    await enterGoal();
    const start = screen.getByRole("button", {
      name: "Start published team run",
    });
    await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
    fireEvent.click(start);
    await screen.findByText("Start response lost");
    const original = harness.rpc.call.mock.calls.find(
      ([method]) => method === "startTeamRun",
    )?.[1];
    expect(original).toMatchObject({
      expectedProjectPolicyVersion: 4,
      expectedSessionPolicyVersion: 2,
      expectedHead: f.definition.source.head,
      team: { teamId: f.definition.team.teamId, revision: 1 },
    });
    first.unmount();
    f.policy.project.version = 9;
    f.policy.session!.version = 10;
    f.setup.selected!.head = "b".repeat(40);
    f.definition.members.builder.definition.metadata.name =
      "Newer display name";
    render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={started} />,
    );
    await screen.findByText(
      "Project settings v4 · conversation settings v2 · retained for this request",
    );
    const fieldset = screen
      .getByLabelText("What should the team deliver?")
      .closest("fieldset");
    expect(fieldset?.disabled).toBe(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry saved team request" }),
    );
    await waitFor(() => expect(started).toHaveBeenCalledWith(f.run));
    const calls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "startTeamRun",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(original);
    expect(sessionStorage.length).toBe(0);
  });

  it.each(["dirty", "restricted", "policy-error"])(
    "does not start from %s readiness",
    async (reason) => {
      const f = fixture();
      if (reason === "dirty") f.setup.selected!.clean = false;
      if (reason === "restricted") f.policy.effective!.restrictedTeams = [];
      if (reason === "policy-error")
        f.policy.errors = [
          "Resolve an archived preferred team before starting",
        ];
      harness.rpc.call.mockImplementation(async (method: string) =>
        f.read(method),
      );
      render(
        <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={vi.fn()} />,
      );
      await enterGoal();
      await screen.findByRole("heading", { name: "Build and verify · v1" });
      expect(
        screen
          .getByRole("button", { name: "Start published team run" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        harness.rpc.call.mock.calls.some(
          ([method]) => method === "startTeamRun",
        ),
      ).toBe(false);
    },
  );

  it("offers published teams by default and navigates with the selected immutable revision", async () => {
    const f = fixture();
    harness.rpc.call.mockImplementation(async (method: string) =>
      method === "listTeams"
        ? {
            teams: [
              {
                id: f.definition.team.teamId,
                currentRevision: 1,
                name: "Published blue team",
              },
              {
                id: "draft-team",
                currentRevision: null,
                name: "Unpublished draft",
              },
            ],
            total: 2,
          }
        : f.read(method),
    );
    render(<RuntimePanel subPath="" />);
    await screen.findByRole("option", { name: "Project A" });
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: f.definition.request.projectId },
    });
    await screen.findByRole("option", { name: "Published blue team · v1" });
    expect(
      screen.queryByRole("option", { name: "Unpublished draft" }),
    ).toBeNull();
    fireEvent.change(
      screen.getByLabelText("Published team", { selector: "select" }),
      { target: { value: `${f.definition.team.teamId}:1` } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Review run" }));
    expect(harness.navigate.toPluginPanel).toHaveBeenCalledWith("runs", {
      subPath: f.route,
    });
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "startTeamRun" || method === "startRun",
      ),
    ).toBe(false);
  });

  it("rejects malformed deep links without reading a different team", () => {
    render(
      <GraphRunRoute
        subPath="new/project-a/team-bad/NaN"
        back={vi.fn()}
        onStarted={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("invalid");
    expect(harness.rpc.call).not.toHaveBeenCalled();
  });

  it("ignores malformed retained requests and shows an explicit empty team preference", async () => {
    const f = fixture();
    sessionStorage.setItem(
      `arc:graph-start:v1:${f.definition.request.projectId}:${f.definition.team.teamId}:1`,
      JSON.stringify({ request: { operationId: "malformed" } }),
    );
    harness.rpc.call.mockImplementation(async (method: string) =>
      f.read(method),
    );
    render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={vi.fn()} />,
    );
    await screen.findByText("No team preference", { exact: false });
    expect(
      screen.queryByRole("button", { name: "Retry saved team request" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Start published team run" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      harness.rpc.call.mock.calls.some(([method]) => method === "startTeamRun"),
    ).toBe(false);
  });

  it("keeps an uncertain setup review across reloads, then starts with current settings only after a durable discard", async () => {
    const f = fixture();
    let starts = 0;
    let discards = 0;
    harness.rpc.call.mockImplementation(
      async (method: string, input: unknown) => {
        if (method === "startTeamRun" && ++starts === 1)
          throw Object.assign(new Error("Settings changed before admission"), {
            code: "handler_error",
          });
        if (method === "discardTeamRunRequest") {
          const request =
            arcRunsRpcContract.discardTeamRunRequest.input.parse(input);
          if (++discards === 1) throw new Error("Setup review response lost");
          return {
            state: "discarded",
            operationId: request.operationId,
            requestHash: runtimeHash(request),
          };
        }
        return f.read(method);
      },
    );
    const started = vi.fn();
    const first = render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={started} />,
    );
    await enterGoal();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start published team run" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start published team run" }),
    );
    await screen.findByText("Settings changed before admission");
    const original = harness.rpc.call.mock.calls.find(
      ([method]) => method === "startTeamRun",
    )?.[1];
    fireEvent.click(
      screen.getByRole("button", { name: "Review current setup" }),
    );
    await screen.findByText("Setup review response lost");
    first.unmount();
    f.policy.project.version = 8;
    f.policy.session!.version = 9;
    f.setup.selected!.head = "b".repeat(40);
    render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={started} />,
    );
    expect(
      screen.queryByRole("button", { name: "Retry saved team request" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry setup review" }),
    );
    await screen.findByText("Project settings v8 · conversation settings v9");
    const discardsMade = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "discardTeamRunRequest",
    );
    expect(discardsMade.map(([, request]) => request)).toEqual([
      original,
      original,
    ]);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start published team run" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start published team run" }),
    );
    await waitFor(() => expect(started).toHaveBeenCalledWith(f.run));
    const startCalls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "startTeamRun",
    );
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1][1]).toMatchObject({
      expectedProjectPolicyVersion: 8,
      expectedSessionPolicyVersion: 9,
      expectedHead: "b".repeat(40),
    });
    expect(startCalls[1][1].operationId).not.toBe(startCalls[0][1].operationId);
  });

  it("opens an already reserved run when reviewing setup without starting or cancelling another run", async () => {
    const f = fixture();
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "startTeamRun")
        throw new Error("Start acknowledgement lost");
      if (method === "discardTeamRunRequest")
        return { state: "reserved", run: f.run };
      return f.read(method);
    });
    const started = vi.fn();
    render(
      <GraphRunRoute subPath={f.route} back={vi.fn()} onStarted={started} />,
    );
    await enterGoal();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start published team run" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start published team run" }),
    );
    await screen.findByText("Start acknowledgement lost");
    fireEvent.click(
      screen.getByRole("button", { name: "Review current setup" }),
    );
    await waitFor(() => expect(started).toHaveBeenCalledWith(f.run));
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "startTeamRun",
      ),
    ).toHaveLength(1);
    expect(
      harness.rpc.call.mock.calls.some(([method]) => method === "controlRun"),
    ).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("Recorded graph approval UI", () => {
  it("waits for a directory inspection and retries the same approval identity before showing it saved", async () => {
    const f = fixture();
    f.run.definition = directoryDefinitionFixture();
    const control = controlFixture(f.run);
    let attempts = 0;
    harness.rpc.call.mockImplementation(
      async (method: string, request: unknown) => {
        if (method === "listRunControls")
          return { controls: [control], total: 1 };
        if (method === "resolveDirectoryRunControl") {
          attempts += 1;
          if (attempts === 1) return { state: "checking", control };
          const input =
            arcRunsRpcContract.resolveDirectoryRunControl.input.parse(request);
          return {
            state: "resolved",
            control: {
              ...control,
              state: "resolved",
              decision: input.decision,
              operationId: input.operationId,
              revision: 4,
            },
          };
        }
        throw new Error(`Unexpected ${method}`);
      },
    );
    render(<RunControls run={f.run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(
      "Verifying folder contents before saving your decision…",
    );
    expect(screen.queryByText("Approved", { exact: true })).toBeNull();
    await screen.findByText("Approved", { exact: true }, { timeout: 3500 });
    const calls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "resolveDirectoryRunControl",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(sessionStorage.length).toBe(0);
  });

  it("stops directory approval polling on unmount and keeps the exact decision available for an explicit retry", async () => {
    const f = fixture();
    f.run.definition = directoryDefinitionFixture();
    const control = controlFixture(f.run);
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listRunControls")
        return { controls: [control], total: 1 };
      if (method === "resolveDirectoryRunControl")
        return { state: "checking", control };
      throw new Error(`Unexpected ${method}`);
    });
    const mounted = render(<RunControls run={f.run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(
      "Verifying folder contents before saving your decision…",
    );
    mounted.unmount();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "resolveDirectoryRunControl",
      ),
    ).toHaveLength(1);
    render(<RunControls run={f.run} />);
    await screen.findByRole("button", { name: "Retry approval" });
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "resolveDirectoryRunControl",
      ),
    ).toHaveLength(1);
    expect(sessionStorage.length).toBe(1);
  });

  it.each(["approved", "rejected"] as const)(
    "retains exact %s evidence and operation across a lost response and reload",
    async (decision) => {
      const f = fixture();
      const control = controlFixture(f.run, decision === "rejected");
      let resolutions = 0;
      harness.rpc.call.mockImplementation(
        async (method: string, input: unknown) => {
          if (method === "listRunControls")
            return { controls: [control], total: 1 };
          if (method === "resolveRunControl") {
            resolutions += 1;
            if (resolutions === 1) throw new Error("Decision response lost");
            const request =
              arcRunsRpcContract.resolveRunControl.input.parse(input);
            return {
              ...control,
              state: "resolved",
              revision: 4,
              decision: request.decision,
              operationId: request.operationId,
            };
          }
          throw new Error(`Unexpected ${method}`);
        },
      );
      const first = render(<RunControls run={f.run} />);
      await screen.findByText("Waiting for you");
      expect(
        harness.rpc.call.mock.calls.every(
          ([method]) => method === "listRunControls",
        ),
      ).toBe(true);
      expect(screen.getByText(control.contextHash).textContent).toBe(
        control.contextHash,
      );
      if (decision === "rejected")
        expect(screen.getAllByText(/Builder · agent v1/)).toHaveLength(2);
      fireEvent.click(
        screen.getByRole("button", {
          name: decision === "approved" ? "Approve" : "Reject",
        }),
      );
      await screen.findByText("Decision response lost");
      const original = harness.rpc.call.mock.calls.find(
        ([method]) => method === "resolveRunControl",
      )?.[1];
      expect(original).toMatchObject({
        controlId: control.controlId,
        runId: f.run.summary.runId,
        expectedRevision: 3,
        contextHash: control.contextHash,
        decision,
      });
      first.unmount();
      render(<RunControls run={f.run} />);
      const retry = await screen.findByRole("button", {
        name: decision === "approved" ? "Retry approval" : "Retry rejection",
      });
      expect(
        screen.queryByRole("button", {
          name: decision === "approved" ? "Reject" : "Approve",
        }),
      ).toBeNull();
      fireEvent.click(retry);
      await screen.findByText(
        decision === "approved" ? "Approved" : "Rejected",
        { exact: true },
      );
      const calls = harness.rpc.call.mock.calls.filter(
        ([method]) => method === "resolveRunControl",
      );
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toEqual(original);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it("keeps a stale decision error visible without reporting approval or creating an opposite decision", async () => {
    const f = fixture();
    const control = controlFixture(f.run);
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listRunControls")
        return { controls: [control], total: 1 };
      if (method === "resolveRunControl")
        throw new Error(
          "Candidate changed; reconcile the run before approving",
        );
      throw new Error(`Unexpected ${method}`);
    });
    render(<RunControls run={f.run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByText(
      "Candidate changed; reconcile the run before approving",
    );
    expect(screen.queryByText("Approved", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText("Waiting for you")).toBeDefined();
  });

  it("shows a decision closed by another operation and dismisses the saved retry without a mutation", async () => {
    const f = fixture();
    const control = controlFixture(f.run);
    sessionStorage.setItem(
      `arc:run-decision:v1:${f.run.summary.runId}:${control.controlId}`,
      JSON.stringify({
        runId: f.run.summary.runId,
        controlId: control.controlId,
        operationId: "old-request",
        expectedRevision: 3,
        contextHash: control.contextHash,
        decision: "rejected",
      }),
    );
    control.state = "resolved";
    control.decision = "approved";
    control.operationId = "different-request";
    control.revision = 4;
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listRunControls")
        return { controls: [control], total: 1 };
      throw new Error(`Unexpected mutation ${method}`);
    });
    render(<RunControls run={f.run} />);
    await screen.findByText("Approved", { exact: true });
    expect(
      screen.queryByRole("button", { name: "Retry rejection" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss saved retry" }),
    );
    expect(sessionStorage.length).toBe(0);
    expect(
      harness.rpc.call.mock.calls.every(
        ([method]) => method === "listRunControls",
      ),
    ).toBe(true);
  });

  it("disables decisions on a terminal run even while its last loaded control is pending", async () => {
    const f = fixture();
    if (!f.run.workflow) throw new Error("Missing workflow");
    f.run.workflow.state = "cancelled";
    f.run.workflow.desiredControl = "cancel";
    const control = controlFixture(f.run);
    harness.rpc.call.mockImplementation(async (method: string) => {
      if (method === "listRunControls")
        return { controls: [control], total: 1 };
      throw new Error(`Unexpected mutation ${method}`);
    });
    render(<RunControls run={f.run} />);
    await screen.findByText("Run ended");
    expect(
      screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      harness.rpc.call.mock.calls.every(
        ([method]) => method === "listRunControls",
      ),
    ).toBe(true);
  });
});

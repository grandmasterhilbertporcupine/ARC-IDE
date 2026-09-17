// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RuntimePanel } from "./panel.js";
import { RuleReviewDetails } from "./rule-review.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import type { ArcRunView } from "./contract.js";
import type {
  RuleUpdateApplication,
  RuleUpdatePreview,
  RuleUpdatePreviewResult,
} from "./rule-update-contract.js";

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
  const definition = directoryDefinitionFixture();
  const hash = "a".repeat(64);
  const run: ArcRunView = {
    definition,
    summary: {
      runId: definition.runId,
      projectId: definition.request.projectId,
      goal: definition.request.goal,
      planHash: hash,
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
      planHash: hash,
      state: "running",
      desiredControl: "run",
      controlVersion: 1,
      dispatchGeneration: 1,
      limits: definition.policy.limits,
      agentCalls: 2,
      activeAgents: 1,
      chargedActiveMs: 1000,
      repairRounds: [],
      result: { available: false },
      error: null,
    },
    verification: {
      kind: "directory",
      state: "current",
      reason: null,
      snapshotId: "snapshot-final",
      manifestDigest: hash,
      checkedAt: "2026-09-10T17:19:04.418Z",
      workspacePath: "C:/Retained candidate",
    },
  };
  const preview: RuleUpdatePreview = {
    kind: "rules",
    schemaVersion: 1,
    previewId: "rule-preview-a",
    previewHash: hash,
    runId: definition.runId,
    projectId: definition.request.projectId,
    planHash: hash,
    controlVersion: 1,
    oldTeam: { teamId: definition.team.teamId, revision: 1, name: "App team" },
    newTeam: { teamId: definition.team.teamId, revision: 1, name: "App team" },
    oldPolicy: {
      projectVersion: 0,
      sessionVersion: 0,
      effective: definition.policy,
    },
    newPolicy: {
      projectVersion: 1,
      sessionVersion: 0,
      effective: {
        ...definition.policy,
        autonomy: "guided",
        limits: { ...definition.policy.limits, maxAgentCalls: 6 },
      },
    },
    changes: [
      {
        kind: "autonomy",
        before: definition.policy.autonomy,
        after: "guided",
        impact: "reduces-authority",
      },
    ],
    affectedNodes: [
      { nodeId: "builder", label: "Build the app", kind: "agent" },
    ],
    repairStages: [],
    usage: {
      checkedAt: 1000,
      agentCalls: 2,
      chargedActiveMs: 1000,
      repairRounds: [],
    },
    source: {
      kind: "directory",
      path: "C:/Original source",
      identityHash: hash,
    },
    createdAt: 1000,
    rerun: "entire-team-from-original",
  };
  let result: RuleUpdatePreviewResult = { disposition: "restart", preview };
  let application: RuleUpdateApplication | null = null;
  let applyError: string | null = null;
  let previewError: string | null = null;
  let projectVersion = 1;
  let paginated = false;
  let invalidAuthority = false;
  let nextState: RuleUpdateApplication["state"] = "applied";
  let cancelState: RuleUpdateApplication["state"] = "cancelled";
  harness.rpc.call.mockImplementation(
    async (method: string, input: Record<string, string>) => {
      if (method === "listStudioProjects")
        return { projects: [], personalProjectId: null };
      if (method === "getRun") return run;
      if (method === "listRunEffects") return { effects: [], total: 0 };
      if (method === "listRunControls") return { controls: [], total: 0 };
      if (method === "getRunReviewAuthority")
        return invalidAuthority
          ? {
              state: "invalid",
              diagnostics: [
                {
                  code: "review_grant_required",
                  message: "Allow Reviewer to review work by Builder.",
                  severity: "error",
                  path: "graph",
                  nodeIds: ["review"],
                },
              ],
            }
          : { state: "authorized", diagnostics: [] };
      if (method === "getRunUpdateState")
        return {
          incoming: null,
          outgoing: application ? { kind: "rules", application } : null,
        };
      if (method === "getOrchestrationPolicy")
        return {
          project: {
            projectId: run.summary.projectId,
            version: projectVersion,
            policy: preview.newPolicy.effective,
            createdAt: 1,
          },
          session: {
            projectId: run.summary.projectId,
            threadId: definition.request.originThreadId,
            version: 0,
            overrides: {},
            createdAt: null,
          },
          effective: preview.newPolicy.effective,
          errors: [],
        };
      if (method === "listTeamRevisions")
        return {
          revisions:
            paginated && Number(input.offset) > 0
              ? [{ ...definition.team, revision: 3 }]
              : [
                  { ...definition.team, revision: 1 },
                  { ...definition.team, revision: 2 },
                ],
          total: paginated ? 21 : 2,
        };
      if (method === "previewRunRuleUpdate") {
        if (previewError) throw new Error(previewError);
        return result;
      }
      if (method === "applyRunRuleUpdate") {
        if (applyError) throw new Error(applyError);
        application = {
          operationId: input.operationId,
          runId: definition.runId,
          successorRunId: "run-successor",
          preview,
          state: nextState,
          reason: null,
          createdAt: 2,
          updatedAt: 3,
        };
        return application;
      }
      if (method === "cancelRunRuleUpdate") {
        application = {
          operationId: input.operationId,
          runId: definition.runId,
          successorRunId: "run-successor",
          preview,
          state: cancelState,
          reason: null,
          createdAt: 2,
          updatedAt: 3,
        };
        return application;
      }
      if (method === "pollRunRuleUpdate") return application;
      throw new Error(`Unexpected RPC ${method}`);
    },
  );
  return {
    run,
    preview,
    enablePages: () => {
      paginated = true;
    },
    setResult: (value: RuleUpdatePreviewResult) => {
      result = value;
    },
    failApply: (value: string | null) => {
      applyError = value;
    },
    failPreview: (value: string | null) => {
      previewError = value;
    },
    setProjectVersion: (value: number) => {
      projectVersion = value;
    },
    invalidAuthority: () => {
      invalidAuthority = true;
    },
    cancelState: (value: RuleUpdateApplication["state"]) => {
      cancelState = value;
    },
    setPending: () => {
      application = {
        operationId: "operation-a",
        runId: definition.runId,
        successorRunId: "run-successor",
        preview,
        state: "starting",
        reason: null,
        createdAt: 2,
        updatedAt: 3,
      };
      nextState = "starting";
    },
  };
}

async function review() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Update operational rules" }),
  );
  const button = await screen.findByRole("button", {
    name: "Review rule changes",
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
}

describe("reviewed operational rules", () => {
  it("distinguishes permission endpoints that use the same agent", () => {
    const f = fixture();
    if (f.run.definition.schemaVersion === 1)
      throw new Error("Expected graph run");
    const member = Object.values(f.run.definition.members)[0];
    f.run.definition.members.alice = member;
    f.run.definition.members.bob = member;
    f.preview.changes = [
      {
        kind: "collaboration-grant",
        grantId: "grant-a",
        impact: "mixed-authority",
        before: {
          id: "grant-a",
          fromMemberId: "reviewer",
          toMemberId: "alice",
          action: "review",
        },
        after: {
          id: "grant-a",
          fromMemberId: "reviewer",
          toMemberId: "bob",
          action: "review",
        },
      },
    ];
    render(<RuleReviewDetails run={f.run} review={f.preview} />);
    expect(screen.getByText(/may review work by .*\(alice\)/)).toBeTruthy();
    expect(screen.getByText(/may review work by .*\(bob\)/)).toBeTruthy();
  });
  it("keeps the reviewed revision visible when paging through other revisions", async () => {
    const f = fixture();
    f.enablePages();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update operational rules" }),
    );
    const select = await screen.findByRole("combobox", {
      name: "Team revision for rule review",
    });
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(
      screen.getByRole("button", { name: "More rule revisions" }),
    );
    await screen.findByRole("option", { name: "Selected team · v2" });
    await waitFor(() => expect(select.hasAttribute("disabled")).toBe(false));
    expect(
      screen.getByRole("option", {
        name: "Selected team · v2",
        selected: true,
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Review rule changes" }),
    );
    await screen.findByRole("button", { name: "Pause and apply rules" });
    expect(harness.rpc.call).toHaveBeenCalledWith("previewRunRuleUpdate", {
      runId: f.run.summary.runId,
      team: { teamId: f.preview.newTeam.teamId, revision: 2 },
      expectedProjectPolicyVersion: 1,
      expectedSessionPolicyVersion: 0,
    });
  });
  it("reviews same-team policy changes with observed versions and used budget before explicit apply", async () => {
    const f = fixture();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review();
    await screen.findByRole("button", { name: "Pause and apply rules" });
    expect(harness.rpc.call).toHaveBeenCalledWith("previewRunRuleUpdate", {
      runId: f.run.summary.runId,
      team: { teamId: f.preview.newTeam.teamId, revision: 1 },
      expectedProjectPolicyVersion: 1,
      expectedSessionPolicyVersion: 0,
    });
    expect(
      screen.getByText(/proposed total limits leave 4 calls/),
    ).toBeTruthy();
    expect(screen.getByText("Guided · approve each assignment")).toBeTruthy();
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "applyRunRuleUpdate",
      ),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Pause and apply rules" }),
    );
    await screen.findByRole("button", { name: "Open continuation" });
    expect(
      screen.getByText(/^Historical candidate · replaced by rule update/),
    ).toBeTruthy();
    expect(harness.rpc.call).toHaveBeenCalledWith(
      "applyRunRuleUpdate",
      expect.objectContaining({
        previewId: f.preview.previewId,
        previewHash: f.preview.previewHash,
      }),
    );
  });
  it.each(["no-running-change", "blocked"] as const)(
    "does not offer Apply for a %s review",
    async (disposition) => {
      const f = fixture();
      f.setResult(
        disposition === "no-running-change"
          ? {
              disposition,
              review: f.preview,
              reason: "The session still overrides these project settings.",
            }
          : {
              disposition,
              review: f.preview,
              blockers: [
                {
                  code: "budget-below-usage",
                  message:
                    "The proposed call limit is below the two calls already used.",
                  nodeIds: [],
                  memberIds: [],
                },
              ],
            },
      );
      render(<RuntimePanel subPath={f.run.summary.runId} />);
      await review();
      await screen.findByText(
        disposition === "no-running-change"
          ? /The session still overrides/
          : /below the two calls/,
      );
      expect(
        screen.queryByRole("button", { name: "Pause and apply rules" }),
      ).toBeNull();
      expect(
        harness.rpc.call.mock.calls.some(([method]) =>
          /^(apply|poll|cancel)Run/.test(method),
        ),
      ).toBe(false);
    },
  );
  it("retains exact rule Apply identity across a lost response without auto-applying on reload", async () => {
    const f = fixture();
    f.failApply("Lost rule response");
    const mounted = render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review();
    fireEvent.click(
      await screen.findByRole("button", { name: "Pause and apply rules" }),
    );
    await screen.findByText("Lost rule response");
    const first = harness.rpc.call.mock.calls.find(
      ([method]) => method === "applyRunRuleUpdate",
    )?.[1];
    mounted.unmount();
    f.failApply(null);
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    const retry = await screen.findByRole("button", {
      name: "Continue rule update",
    });
    expect(
      harness.rpc.call.mock.calls.filter(
        ([method]) => method === "applyRunRuleUpdate",
      ),
    ).toHaveLength(1);
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Open continuation" });
    const calls = harness.rpc.call.mock.calls.filter(
      ([method]) => method === "applyRunRuleUpdate",
    );
    expect(calls[1][1]).toEqual(first);
    expect(
      sessionStorage.getItem(`arc:rule-update:v1:${f.run.summary.runId}`),
    ).toBeNull();
  });
  it("blocks ordinary controls and instruction review while a rule update owns the run", async () => {
    const f = fixture();
    f.setPending();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await screen.findByText(/reviewed update is managing this run/);
    expect(
      screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Update instructions" }),
    );
    const select = await screen.findByRole("combobox", {
      name: "Published team revision",
    });
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Review instruction changes" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("refreshes stale observed settings explicitly and reviews the new version before apply", async () => {
    const f = fixture();
    f.failPreview("Project settings changed. Refresh saved settings.");
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await review();
    await screen.findByText(
      "Project settings changed. Refresh saved settings.",
    );
    f.failPreview(null);
    f.setProjectVersion(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh saved settings" }),
    );
    await screen.findByText(/Project settings v2; session/);
    fireEvent.click(
      screen.getByRole("button", { name: "Review rule changes" }),
    );
    await screen.findByRole("button", { name: "Pause and apply rules" });
    expect(harness.rpc.call).toHaveBeenLastCalledWith(
      "previewRunRuleUpdate",
      expect.objectContaining({ expectedProjectPolicyVersion: 2 }),
    );
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) => method === "applyRunRuleUpdate",
      ),
    ).toBe(false);
  });
  it("does not turn a refused cancellation into automatic continuation", async () => {
    const f = fixture();
    f.setPending();
    f.cancelState("starting");
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update operational rules" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel rule update" }),
    );
    await screen.findByText(/Successor admission was already sealed/);
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) =>
          method === "applyRunRuleUpdate" || method === "pollRunRuleUpdate",
      ),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Continue rule update" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it("separates invalid review permissions from retained physical verification", async () => {
    const f = fixture();
    f.invalidAuthority();
    render(<RuntimePanel subPath={f.run.summary.runId} />);
    await screen.findByText("Allow Reviewer to review work by Builder.");
    expect(screen.getByText(/Last verified candidate/)).toBeTruthy();
    expect(f.run.verification).toMatchObject({
      state: "current",
      checkedAt: "2026-09-10T17:19:04.418Z",
    });
    expect(
      harness.rpc.call.mock.calls.some(
        ([method]) =>
          method === "previewRunRuleUpdate" || method === "controlRun",
      ),
    ).toBe(false);
  });
});

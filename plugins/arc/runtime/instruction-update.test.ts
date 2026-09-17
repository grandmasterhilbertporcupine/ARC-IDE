import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  cancelOwnedContinuation,
  inspectOwnedContinuation,
  inspectOwnedRuleContext,
  reserveOwnedContinuation,
  startOwnedContinuation,
  startOwnedRuleContinuation,
} from "../../workflows/src/owned-continuation-data.js";
import {
  admitOwnedStep,
  claimOwnedRun,
  controlOwnedRun,
  createOwnedRun,
  recordOwnedObservation,
  reconcileOwnedRunState,
  requireOwnedRun,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { terminalReceipt } from "../../workflows/src/owned-test-fixtures.js";
import { createAgentStore, migrations } from "../data.js";
import { parseAgentDocument, serializeAgentDocument } from "../document.js";
import {
  directoryEffectRequestSchema,
  type DirectoryEffectRecord,
  type DirectoryEffectRequest,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import {
  teamDefinitionFixture,
  teamEdge,
  teamTarget,
} from "../teams/testing.js";
import type { TeamDefinition } from "../teams/contract.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { directoryValidationMigrations } from "./directory-validation.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { compileArcGraphRun } from "./graph-compiler.js";
import { compileArcOrchestratedRun } from "./orchestrated-compiler.js";
import { createArcRunService } from "./service.js";
import { createInstructionUpdateService } from "./instruction-update-service.js";
import { graphServicesFixture, runDefinitionFixture } from "./testing.js";
import { runtimeNodeKey } from "./compiler.js";
import { runtimeHash } from "./hash.js";
import type { RetainedCompiledRun } from "./compiled.js";
import type { RuleUpdatePreview } from "./rule-update-contract.js";
import type { ResolvedRunPolicy } from "../policy/contract.js";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function saveRulePolicy(
  f: ReturnType<typeof fixture>,
  update: (policy: ResolvedRunPolicy) => void,
) {
  const current = f.graph.policies.view({
    projectId: f.scope.projectId,
    threadId: f.compiled.definition.request.originThreadId,
  });
  const policy = structuredClone(current.project.policy);
  update(policy);
  return f.graph.policies.saveProject({
    projectId: f.scope.projectId,
    expectedVersion: current.project.version,
    policy,
  });
}

async function readyRulePreview(
  f: ReturnType<typeof fixture>,
  team?: { teamId: string; revision: number },
) {
  const result = await f.previewRules(team);
  if (result.disposition !== "restart") throw new Error(JSON.stringify(result));
  return result.preview;
}

const ruleRequest = (
  preview: RuleUpdatePreview,
  operationId = "apply-reviewed-rules",
) => ({
  operationId,
  previewId: preview.previewId,
  previewHash: preview.previewHash,
});

describe("reviewed operational rule continuation", () => {
  it.each([2, 3, 4] as const)(
    "seals reviewed policy and check bytes through the amendment path (V%i)",
    async (version) => {
      const f = fixture(version);
      const original = JSON.stringify(f.compiled);
      const team = f.publish((definition) => {
        const check = definition.graph.nodes.find(
          (node) => node.kind === "check",
        );
        if (check?.kind !== "check") throw new Error("Expected check");
        check.command = {
          ...check.command,
          args: ["--test", "reviewed-check.mjs"],
          timeoutMs: 45000,
        };
      }, "Original published instructions");
      saveRulePolicy(f, (policy) => {
        policy.autonomy = "guided";
        policy.limits.maxAgentCalls += 1;
      });
      const preview = await readyRulePreview(f, team);
      expect(preview.changes.map((change) => change.kind)).toEqual(
        expect.arrayContaining(["autonomy", "limits", "native-check"]),
      );
      expect(f.calls.scans).toBe(0);
      const application = await f.service
        .handlers()
        .applyRunRuleUpdate(ruleRequest(preview));
      expect(application.state).toBe("applied");
      const successor = f.store.get(application.successorRunId);
      if (successor.compiled.definition.schemaVersion === 1)
        throw new Error("Expected Team");
      expect(successor.compiled.definition.policy).toEqual(
        preview.newPolicy.effective,
      );
      expect(
        successor.compiled.definition.request.expectedProjectPolicyVersion,
      ).toBe(2);
      expect(
        successor.compiled.definition.team.definition.graph.nodes.find(
          (node) => node.kind === "check",
        ),
      ).toMatchObject({
        command: { args: ["--test", "reviewed-check.mjs"], timeoutMs: 45000 },
      });
      expect(JSON.stringify(f.store.get(preview.runId).compiled)).toBe(
        original,
      );
      expect(f.calls.ruleStarts).toBe(1);
      expect(f.calls.directStarts + f.calls.continuationStarts).toBe(0);
      expect(
        (
          await f.service
            .handlers()
            .getRunUpdateState({ runId: application.successorRunId })
        ).incoming,
      ).toMatchObject({
        kind: "rules",
        application: { operationId: application.operationId },
      });
      expect(
        (
          await f.service
            .handlers()
            .getRunInstructionUpdateState({ runId: preview.runId })
        ).outgoing,
      ).toBeNull();
      if (successor.compiled.definition.schemaVersion === 4)
        expect(
          f.store.directories.getSetupByInspection(
            successor.compiled.definition.request,
          )?.consumed?.runId,
        ).toBe(application.successorRunId);
    },
  );

  it("does not allocate work for unchanged, preference-only or masked policy reviews", async () => {
    const f = fixture();
    expect((await f.previewRules()).disposition).toBe("no-running-change");
    const pin = f.compiled.definition.request.team;
    saveRulePolicy(f, (policy) => {
      policy.preferredTeams = [pin];
    });
    expect((await f.previewRules()).disposition).toBe("no-running-change");
    f.graph.policies.saveSession({
      projectId: f.scope.projectId,
      threadId: f.compiled.definition.request.originThreadId,
      expectedVersion: 0,
      overrides: {
        autonomy: "autonomous",
        preferredTeams: { kind: "none" },
        restrictedTeams: { kind: "inherit" },
        limits: null,
      },
    });
    saveRulePolicy(f, (policy) => {
      policy.autonomy = "guided";
    });
    expect((await f.previewRules()).disposition).toBe("no-running-change");
    for (const table of [
      "arc_instruction_updates",
      "arc_instruction_update_previews",
      "workflow_owned_continuations",
    ])
      expect(
        f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    expect(f.calls.scans + f.calls.ruleStarts).toBe(0);
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "run",
    );
  });

  it("returns typed restriction and structural blockers without reservation or scan", async () => {
    const f = fixture(4, true);
    const team = f.publish();
    const result = await f.previewRules(team);
    expect(result).toMatchObject({
      disposition: "blocked",
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "team-restricted" }),
      ]),
    });
    const changed = fixture();
    const selection = changed.publish((team) => {
      const node = team.graph.nodes.find((node) => node.kind === "agent");
      if (node?.kind === "agent")
        node.task = "Unreviewed structural task substitution";
    });
    expect(await changed.previewRules(selection)).toMatchObject({
      disposition: "blocked",
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "unsupported-structure" }),
      ]),
    });
    expect(f.calls.scans + changed.calls.scans).toBe(0);
  });

  it("shows configured and resolved execution and rejects default movement before pausing", async () => {
    const f = fixture();
    const old = f.compiled.definition.members.builder.execution;
    f.setExecution({ ...old, model: "reviewed-model" });
    const preview = await readyRulePreview(f);
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "execution",
          before: { configured: f.metadata.execution, resolved: old },
          after: {
            configured: f.metadata.execution,
            resolved: { ...old, model: "reviewed-model" },
          },
        }),
      ]),
    );
    f.setExecution({ ...old, model: "unreviewed-model" });
    await expect(
      f.service.handlers().applyRunRuleUpdate(ruleRequest(preview)),
    ).rejects.toMatchObject({ code: "instruction_preview_conflict" });
    expect(
      f.store.instructionUpdates.find({
        runId: preview.runId,
        operationId: "apply-reviewed-rules",
      }),
    ).toBeNull();
    expect(f.calls.scans).toBe(0);
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "run",
    );
  });

  it("shares the pending lock across update kinds and prevents wrong-kind retries", async () => {
    const f = fixture();
    const team = f.publish();
    const instruction = await f.preview(team);
    const preview = await readyRulePreview(f, team);
    f.holdScans();
    const application = await f.service
      .handlers()
      .applyRunRuleUpdate(ruleRequest(preview));
    expect(application.state).toBe("checking");
    await expect(
      f.service.handlers().applyRunInstructionUpdate(apply(instruction)),
    ).rejects.toMatchObject({ code: "instruction_preview_stale" });
    await expect(async () =>
      f.service.handlers().pollRunInstructionUpdate(application),
    ).rejects.toMatchObject({ code: "run_update_kind_mismatch" });
    await expect(
      f.service.handlers().controlRun({
        runId: preview.runId,
        operationId: "resume-while-rules",
        expectedVersion: viewOwnedRun(f.db, f.workflow.workflowRunId)
          .controlVersion,
        action: "resume",
      }),
    ).rejects.toMatchObject({ code: "instruction_update_locked" });
    const cancelled = await f.service
      .handlers()
      .cancelRunRuleUpdate({ runId: preview.runId, ...ruleRequest(preview) });
    expect(cancelled.state).toBe("cancelled");
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "pause",
    );
  });

  it("reviews a member model override as execution without rewriting the pinned agent defaults", async () => {
    const f = fixture();
    const override = {
      providerId: "codex",
      model: "team-review-model",
      reasoningLevel: "high",
      serviceTier: "default",
    } as const;
    const selected = f.publish((team) => {
      team.members[0]!.modelOverride = override;
    });
    const preview = await readyRulePreview(f, selected);
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "execution",
          impact: "behavior",
          after: {
            configured: { ...f.metadata.execution, ...override },
            resolved: {
              ...f.compiled.definition.members.builder.execution,
              ...override,
            },
          },
        }),
      ]),
    );
    expect(f.metadata.execution.model).not.toBe(override.model);
    await expect(f.preview(selected)).rejects.toMatchObject({
      code: "instruction_only_required",
    });
    expect(f.calls.scans).toBe(0);
  });

  it("retains an absent-operation cancellation against a late rule Apply", async () => {
    const f = fixture();
    saveRulePolicy(f, (policy) => {
      policy.autonomy = "guided";
    });
    const preview = await readyRulePreview(f);
    const request = ruleRequest(preview);
    expect(
      (
        await f.service
          .handlers()
          .cancelRunRuleUpdate({ runId: preview.runId, ...request })
      ).state,
    ).toBe("cancelled");
    expect((await f.service.handlers().applyRunRuleUpdate(request)).state).toBe(
      "cancelled",
    );
    expect(f.calls.scans + f.calls.ruleStarts).toBe(0);
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "run",
    );
  });

  it("recovers a lost amended successor acknowledgement through the same operation", async () => {
    const f = fixture();
    saveRulePolicy(f, (policy) => {
      policy.limits.maxAgentCalls += 1;
    });
    const preview = await readyRulePreview(f);
    f.loseStart();
    await expect(
      f.service.handlers().applyRunRuleUpdate(ruleRequest(preview)),
    ).rejects.toThrow("lost successor acknowledgement");
    const reloaded = createInstructionUpdateService(
      f.host.bb,
      f.store,
      f.agents,
      f.graph,
    );
    const application = await reloaded.applyRules(ruleRequest(preview), {
      kind: "user",
    });
    expect(application.state).toBe("applied");
    expect(f.calls.ruleStarts).toBe(1);
    expect(f.calls.directStarts + f.calls.continuationStarts).toBe(0);
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS count FROM workflow_owned_continuations")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps pending source validation cancellable after policy changes and delayed native abort", async () => {
    const f = fixture();
    saveRulePolicy(f, (policy) => {
      policy.autonomy = "guided";
    });
    const preview = await readyRulePreview(f);
    f.holdScans();
    const application = await f.service
      .handlers()
      .applyRunRuleUpdate(ruleRequest(preview));
    saveRulePolicy(f, (policy) => {
      policy.autonomy = "collaborative";
    });
    await expect(
      f.service.handlers().pollRunRuleUpdate(application),
    ).rejects.toMatchObject({ code: "policy_conflict" });
    f.delayAbort();
    expect(
      (
        await f.service.handlers().cancelRunRuleUpdate({
          runId: preview.runId,
          ...ruleRequest(preview),
        })
      ).state,
    ).toBe("cancelling");
    f.allowAbort();
    expect(
      (await f.service.handlers().pollRunRuleUpdate(application)).state,
    ).toBe("cancelled");
    expect(f.calls.ruleStarts).toBe(0);
  });

  it("preserves legacy instruction JSON while exposing mixed lineage", async () => {
    const f = fixture();
    const preview = await f.preview();
    const row = f.db
      .prepare(
        "SELECT preview_json AS json FROM arc_instruction_update_previews WHERE preview_id=?",
      )
      .get(preview.previewId);
    expect(row).toEqual({ json: JSON.stringify(preview) });
    const application = await f.service
      .handlers()
      .applyRunInstructionUpdate(apply(preview));
    expect(
      (await f.service.handlers().getRunUpdateState({ runId: preview.runId }))
        .outgoing,
    ).toEqual({ kind: "instructions", application });
    expect(
      f.db
        .prepare(
          "SELECT preview_json AS json FROM arc_instruction_update_previews WHERE preview_id=?",
        )
        .get(preview.previewId),
    ).toEqual(row);
  });

  it("rejects a policy CAS change during the authoritative usage read", async () => {
    const f = fixture();
    f.beforeRuleContext(() => {
      saveRulePolicy(f, (policy) => {
        policy.limits.maxAgentCalls += 1;
      });
    });
    await expect(f.previewRules()).rejects.toMatchObject({
      code: "policy_conflict",
    });
    expect(f.calls.scans + f.calls.ruleStarts).toBe(0);
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "run",
    );
  });

  it("reports actual admitted calls as a typed reduced-budget blocker", async () => {
    const f = fixture(2);
    const claimed = claimOwnedRun(f.db, 4);
    if (!claimed) throw new Error("Expected active predecessor");
    let calls = 0;
    for (const step of f.compiled.workflow.steps) {
      const attempt = admitOwnedStep(
        f.db,
        f.workflow.workflowRunId,
        {
          nodeId: step.nodeId,
          iteration: step.iteration,
        },
        null,
        claimed.row.dispatch_generation,
      );
      if (!attempt) throw new Error("Expected charged agent admission");
      expect(
        recordOwnedObservation(
          f.db,
          attempt.request.effectId,
          claimed.row.dispatch_generation,
          terminalReceipt(
            attempt.request,
            "succeeded",
            { completed: step.nodeId },
            step.kind === "agent" ? "agent" : "host-effect",
          ),
        ),
      ).toBe(true);
      if (step.kind === "agent" && ++calls === 2) break;
    }
    expect(calls).toBe(2);
    saveRulePolicy(f, (policy) => {
      policy.limits.maxAgentCalls = 1;
    });
    expect(await f.previewRules()).toMatchObject({
      disposition: "blocked",
      review: { usage: { agentCalls: 2 } },
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "budget-below-usage" }),
      ]),
    });
    expect(f.calls.scans + f.calls.ruleStarts).toBe(0);
  });

  it("seals a disabled repair stage as an explicit zero catalog entry", async () => {
    const f = fixture(2, false, (team) => {
      const review = team.graph.nodes.find((node) => node.kind === "review");
      if (review?.kind !== "review") throw new Error("Expected review");
      review.candidate = { kind: "node", nodeId: "repair" };
      team.graph.nodes.push({
        id: "repair",
        label: "Repair failed check",
        kind: "repair",
        body: { memberId: "builder", task: "Repair the failing check" },
        checkNodeId: "check",
        maxRounds: 3,
      });
      team.graph.edges = [
        teamEdge("write", "check"),
        teamEdge("check", "repair", "failed"),
        teamEdge("repair", "review", "succeeded", "repaired"),
      ];
      team.graph.requiredGates = [
        { id: "verified", mode: "all", nodeIds: ["repair", "review"] },
      ];
    });
    saveRulePolicy(f, (policy) => {
      policy.limits.maxRepairRounds = 0;
    });
    const preview = await readyRulePreview(f);
    expect(preview.repairStages).toEqual([
      expect.objectContaining({
        stageId: "repair",
        beforeMaxRounds: Math.min(
          3,
          f.compiled.definition.policy.limits.maxRepairRounds,
        ),
        afterMaxRounds: 0,
      }),
    ]);
    const application = await f.service
      .handlers()
      .applyRunRuleUpdate(ruleRequest(preview));
    expect(application.state).toBe("applied");
    const successor = f.store.get(application.successorRunId);
    expect(
      inspectOwnedRuleContext(f.db, "arc", successor.summary.workflowRunId!)
        .repairCatalog,
    ).toEqual({
      source: "stored",
      stages: [{ stageId: "repair", maxRounds: 0 }],
    });
    const team = f.publish();
    const ordinary = await f.service
      .handlers()
      .previewRunInstructionUpdate({ runId: application.successorRunId, team });
    const continued = await f.service
      .handlers()
      .applyRunInstructionUpdate(apply(ordinary));
    expect(continued.state).toBe("applied");
    expect(
      inspectOwnedRuleContext(
        f.db,
        "arc",
        f.store.get(continued.successorRunId).summary.workflowRunId!,
      ).repairCatalog,
    ).toEqual({
      source: "stored",
      stages: [{ stageId: "repair", maxRounds: 0 }],
    });
  });
});

function fixture(
  version: 2 | 3 | 4 = 4,
  restricted = false,
  configureTeam?: (team: TeamDefinition) => void,
) {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(
    [
      ...migrations,
      ...runtimeMigrations,
      ...directoryValidationMigrations,
      ...workflowMigrations,
    ].join(";\n"),
  );
  const base = directoryDefinitionFixture();
  const git = runDefinitionFixture();
  const agents = createAgentStore(db);
  const scope = { kind: "project", projectId: base.request.projectId } as const;
  const metadata =
    base.members[Object.keys(base.members)[0]].definition.metadata;
  let agent = agents.createAgent({
    scope,
    document: serializeAgentDocument(
      metadata,
      "Original published instructions",
    ),
  });
  agent = agents.publish({
    scope,
    agentId: agent.id,
    expectedDraftVersion: agent.draft.version,
  });
  let holdScan = false;
  let delayAbort = false;
  let changedSource = false;
  let loseStartReply = false;
  let dropStartRequest = false;
  let beforeReserve: (() => void) | null = null;
  let inheritedExecution = {
    ...base.members[Object.keys(base.members)[0]].execution,
  };
  let beforeRuleContext: (() => void) | null = null;
  const jobs = new Map<
    string,
    { request: DirectoryEffectRequest; record: DirectoryEffectRecord }
  >();
  const calls = {
    scans: 0,
    directStarts: 0,
    continuationStarts: 0,
    ruleStarts: 0,
    interrupted: 0,
  };
  function complete(job: DirectoryEffectRequest): DirectoryEffectRecord {
    if (job.operation.type !== "scan-directory")
      throw new Error("Read-only source scan required");
    const state = {
      ...base.source,
      manifestDigest: changedSource
        ? "f".repeat(64)
        : base.source.manifestDigest,
    };
    return {
      kind: "directory",
      runId: job.runId,
      effectId: job.effectId,
      requestHash: directoryEffectRequestHash(job),
      state: "terminal",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      receipt: {
        kind: "directory",
        operationType: "scan-directory",
        outcome: "succeeded",
        errorCode: null,
        reason: null,
        before: state,
        after: state,
        source: null,
        processes: [],
        artifact: {
          kind: "inspection",
          validationId: job.operation.validationId,
          phase: job.operation.phase,
          consumer: job.operation.consumer,
          state,
          checkedAt: new Date().toISOString(),
        },
        finishedAt: new Date().toISOString(),
      },
    };
  }
  const host = createFakePluginHost({
    pluginId: "arc",
    sdk: {
      projects: {
        defaultExecutionOptions: () => inheritedExecution,
        get: () => ({
          id: base.request.projectId,
          kind: "standard",
          sources: [{ hostId: base.request.hostId, path: base.source.path }],
        }),
      },
      threads: {
        get: () => ({
          id: base.request.originThreadId,
          projectId: base.request.projectId,
          parentThreadId: null,
          experimental_executionContextId: null,
          archivedAt: null,
          providerId: base.completion.execution.providerId,
          environmentId: base.completion.environment.environmentId,
        }),
      },
      environments: {
        get: () => ({
          id: base.completion.environment.environmentId,
          projectId: base.request.projectId,
          hostId: base.request.hostId,
          status: "ready",
          path: base.completion.environment.path,
        }),
      },
    },
    async experimental_callHostRpc(call) {
      if (call.method === "inspectProjectSource")
        return {
          kind: version === 4 ? "directory" : "git",
          path: base.source.path,
        };
      if (call.method === "inspectWorkspace")
        return {
          path: git.source.path,
          topLevel: git.source.path,
          gitDir: `${git.source.path}/.git`,
          commonGitDir: git.source.commonGitDir,
          head: git.source.head,
          currentBranch: git.source.branch,
          clean: true,
          trackedDigest: git.source.stateHash,
          untrackedDigest: git.source.stateHash,
          contentDigest: git.source.stateHash,
          stateDigest: changedSource ? "f".repeat(64) : git.source.stateHash,
        };
      const identity = call.input as { effectId: string };
      if (call.method === "observeDirectoryEffect")
        return jobs.get(identity.effectId)?.record ?? null;
      if (call.method === "startDirectoryEffect") {
        const request = directoryEffectRequestSchema.parse(call.input);
        calls.scans++;
        const record = holdScan
          ? {
              kind: "directory" as const,
              runId: request.runId,
              effectId: request.effectId,
              requestHash: directoryEffectRequestHash(request),
              state: "running" as const,
              startedAt: new Date().toISOString(),
              finishedAt: null,
              receipt: null,
            }
          : complete(request);
        jobs.set(request.effectId, { request, record });
        return record;
      }
      if (call.method === "interruptDirectoryEffect") {
        calls.interrupted++;
        const item = jobs.get(identity.effectId);
        if (!item) return null;
        if (!delayAbort && item.record.state !== "terminal")
          item.record = {
            ...complete(item.request),
            receipt: {
              ...complete(item.request).receipt!,
              outcome: "interrupted",
              errorCode: "interrupted",
              reason: "Stopped by fixture native acknowledgement",
              artifact: null,
            },
          };
        return item.record;
      }
      throw new Error(`Unexpected native method ${call.method}`);
    },
    async experimental_internalRpc(call) {
      if (call.pluginId !== "workflows") throw new Error("Unexpected owner");
      const api = ownedWorkflowRpcContract;
      if (call.method === "inspectOwnedRun")
        return {
          run: viewOwnedRun(
            db,
            api.inspectOwnedRun.input.parse(call.input).workflowRunId,
          ),
        };
      if (call.method === "inspectOwnedRuleContext") {
        beforeRuleContext?.();
        beforeRuleContext = null;
        return inspectOwnedRuleContext(
          db,
          "arc",
          api.inspectOwnedRuleContext.input.parse(call.input).workflowRunId,
        );
      }
      if (call.method === "controlOwnedRun")
        return {
          run: controlOwnedRun(
            db,
            "arc",
            api.controlOwnedRun.input.parse(call.input),
          ),
        };
      if (call.method === "reserveOwnedContinuation") {
        beforeReserve?.();
        beforeReserve = null;
        return {
          continuation: reserveOwnedContinuation(
            db,
            "arc",
            api.reserveOwnedContinuation.input.parse(call.input),
          ),
        };
      }
      if (call.method === "inspectOwnedContinuation")
        return {
          continuation: inspectOwnedContinuation(
            db,
            "arc",
            api.inspectOwnedContinuation.input.parse(call.input),
          ),
        };
      if (call.method === "cancelOwnedContinuation")
        return {
          continuation: cancelOwnedContinuation(
            db,
            "arc",
            api.cancelOwnedContinuation.input.parse(call.input),
          ),
        };
      if (
        call.method === "startOwnedContinuation" ||
        call.method === "startOwnedRuleContinuation"
      ) {
        if (dropStartRequest) {
          dropStartRequest = false;
          throw new Error("lost before successor request");
        }
        if (call.method === "startOwnedContinuation")
          calls.continuationStarts++;
        else calls.ruleStarts++;
        const continuation =
          call.method === "startOwnedContinuation"
            ? startOwnedContinuation(
                db,
                "arc",
                api.startOwnedContinuation.input.parse(call.input),
              )
            : startOwnedRuleContinuation(
                db,
                "arc",
                api.startOwnedRuleContinuation.input.parse(call.input),
              );
        if (loseStartReply) {
          loseStartReply = false;
          throw new Error("lost successor acknowledgement");
        }
        return { continuation };
      }
      if (call.method === "startOwnedRun") {
        calls.directStarts++;
        throw new Error("Continuation cannot use ordinary admission");
      }
      throw new Error(`Unexpected workflow method ${call.method}`);
    },
  });
  hosts.push(host);
  const graph = graphServicesFixture(db, agents, host.bb);
  const initialTeam = teamDefinitionFixture(agent.id);
  configureTeam?.(initialTeam);
  let team = graph.teams.createTeam({
    scope,
    definition: initialTeam,
  });
  team = graph.teams.publish(teamTarget(team));
  const policy = {
    ...base.policy,
    autonomy: "autonomous" as const,
    restrictedTeams: restricted ? [{ teamId: team.id, revision: 1 }] : null,
  };
  graph.policies.saveProject({
    projectId: scope.projectId,
    expectedVersion: 0,
    policy,
  });
  const definition = {
    ...base,
    team: graph.teams.getRevision({ scope, teamId: team.id, revision: 1 }),
    members: {
      builder: {
        definition: agents.getRevision({
          scope,
          agentId: agent.id,
          revision: 1,
        }),
        execution: base.members[Object.keys(base.members)[0]].execution,
      },
    },
    policy,
    request: {
      ...base.request,
      team: { teamId: team.id, revision: 1 },
      expectedProjectPolicyVersion: 1,
    },
  };
  const {
    expectedSource: _source,
    sourceInspectionId: _inspection,
    ...request
  } = definition.request;
  const { completion: _completion, ...plainDefinition } = definition;
  const compiled =
    version === 4
      ? compileArcDirectoryRun(definition)
      : version === 3
        ? compileArcOrchestratedRun({
            ...definition,
            schemaVersion: 3,
            source: git.source,
            request: { ...request, expectedHead: git.source.head },
          })
        : compileArcGraphRun({
            ...plainDefinition,
            schemaVersion: 2,
            source: git.source,
            request: {
              operationId: request.operationId,
              projectId: request.projectId,
              originThreadId: request.originThreadId,
              hostId: request.hostId,
              path: request.path,
              expectedHead: git.source.head,
              goal: request.goal,
              team: request.team,
              expectedProjectPolicyVersion: 1,
              expectedSessionPolicyVersion: 0,
            },
          });
  const store = createArcRunStore(db);
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  store.submitted(definition.runId, workflow.workflowRunId);
  const service = createArcRunService(host.bb, store, agents, graph);
  function publish(
    update?: (definition: TeamDefinition) => void,
    document = "Reviewed successor instructions",
  ) {
    agent = agents.saveDraft({
      scope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
      document: serializeAgentDocument(metadata, document),
      attachmentIds: [],
    });
    agent = agents.publish({
      scope,
      agentId: agent.id,
      expectedDraftVersion: agent.draft.version,
    });
    const next = structuredClone(team.draft.definition);
    next.members[0].revision = agent.currentRevision!;
    update?.(next);
    team = graph.teams.saveDraft({ ...teamTarget(team), definition: next });
    team = graph.teams.publish(teamTarget(team));
    return { teamId: team.id, revision: team.currentRevision! };
  }
  return {
    db,
    host,
    agents,
    graph,
    store,
    service,
    compiled,
    workflow,
    scope,
    publish,
    calls,
    metadata,
    previewRules: (
      selection = { teamId: team.id, revision: team.currentRevision! },
    ) => {
      const view = graph.policies.view({
        projectId: scope.projectId,
        threadId: definition.request.originThreadId,
      });
      return service.handlers().previewRunRuleUpdate({
        runId: definition.runId,
        team: selection,
        expectedProjectPolicyVersion: view.project.version,
        expectedSessionPolicyVersion: view.session?.version ?? 0,
      });
    },
    setExecution(execution: typeof inheritedExecution) {
      inheritedExecution = execution;
    },
    beforeRuleContext(action: () => void) {
      beforeRuleContext = action;
    },
    preview: (team = publish()) =>
      service
        .handlers()
        .previewRunInstructionUpdate({ runId: definition.runId, team }),
    holdScans() {
      holdScan = true;
    },
    delayAbort() {
      delayAbort = true;
    },
    allowAbort() {
      delayAbort = false;
    },
    moveSource() {
      changedSource = true;
    },
    loseStart() {
      loseStartReply = true;
    },
    dropStart() {
      dropStartRequest = true;
    },
    beforeReserve(action: () => void) {
      beforeReserve = action;
    },
    completeScans() {
      holdScan = false;
      for (const job of jobs.values())
        if (job.record.state !== "terminal") job.record = complete(job.request);
    },
  };
}

const apply = (
  preview: Awaited<ReturnType<ReturnType<typeof fixture>["preview"]>>,
  operationId = "apply-reviewed-instructions",
) => ({
  previewId: preview.previewId,
  previewHash: preview.previewHash,
  operationId,
});

describe("reviewed instruction update continuation", () => {
  it.each([2, 3, 4] as const)(
    "seals project revisions and reruns only through cumulative continuation (V%i)",
    async (version) => {
      const f = fixture(version);
      const original = JSON.stringify(
        f.store.get(f.compiled.definition.runId).compiled,
      );
      const preview = await f.preview();
      expect(f.calls.scans).toBe(0);
      expect(
        JSON.stringify(f.store.get(f.compiled.definition.runId).compiled),
      ).toBe(original);
      expect(preview.changes).toMatchObject([
        {
          memberId: "builder",
          oldRevision: 1,
          newRevision: 2,
          before: "Original published instructions",
          after: "Reviewed successor instructions",
        },
      ]);
      expect(preview.affectedNodes.map((node) => node.nodeId)).toEqual(
        expect.arrayContaining(["write", "check", "review"]),
      );
      const result = await f.service
        .handlers()
        .applyRunInstructionUpdate(apply(preview));
      expect(result.state).toBe("applied");
      const successor = f.store.get(result.successorRunId);
      expect(successor.compiled.definition.schemaVersion).toBe(version);
      if (successor.compiled.definition.schemaVersion === 1)
        throw new Error("Unexpected fixed run");
      expect(
        successor.compiled.definition.members.builder.definition.revision,
      ).toBe(2);
      expect(
        parseAgentDocument(
          successor.compiled.definition.members.builder.definition.document,
        ).body,
      ).toBe(preview.changes[0].after);
      expect(successor.compiled.workflow.limits).toEqual(
        f.compiled.workflow.limits,
      );
      expect(f.calls.directStarts).toBe(0);
      expect(viewOwnedRun(f.db, f.workflow.workflowRunId).state).toBe(
        "cancelled",
      );
      expect(
        JSON.stringify(f.store.get(f.compiled.definition.runId).compiled),
      ).toBe(original);
      await expect(
        f.service.handlers().controlRun({
          runId: preview.runId,
          operationId: "resume-old",
          expectedVersion: viewOwnedRun(f.db, f.workflow.workflowRunId)
            .controlVersion,
          action: "resume",
        }),
      ).rejects.toMatchObject({ code: "instruction_update_locked" });
      expect(
        (
          await f.service
            .handlers()
            .getRunInstructionUpdateState({ runId: result.successorRunId })
        ).incoming?.operationId,
      ).toBe(result.operationId);
    },
  );

  it("recovers an admitted successor after a lost reply without ordinary start or duplicate work", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.loseStart();
    await expect(
      f.service.handlers().applyRunInstructionUpdate(apply(preview)),
    ).rejects.toThrow("lost successor acknowledgement");
    const result = await f.service
      .handlers()
      .applyRunInstructionUpdate(apply(preview));
    expect(result.state).toBe("applied");
    expect(
      f.db.prepare("SELECT count(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 2 });
    expect(
      f.db.prepare("SELECT count(*) AS count FROM workflow_owned_runs").get(),
    ).toEqual({ count: 2 });
    expect(f.calls.continuationStarts).toBe(1);
    expect(f.calls.directStarts).toBe(0);
  });

  it("freshly scans a pre-seal replay, retains one unfinished pass and refuses source movement", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.dropStart();
    await expect(
      f.service.handlers().applyRunInstructionUpdate(apply(preview)),
    ).rejects.toThrow("lost before successor request");
    expect(f.calls.scans).toBe(1);
    f.holdScans();
    const key = {
      runId: preview.runId,
      operationId: apply(preview).operationId,
    };
    expect(
      (await f.service.handlers().pollRunInstructionUpdate(key)).state,
    ).toBe("starting");
    expect(
      (await f.service.handlers().pollRunInstructionUpdate(key)).state,
    ).toBe("starting");
    expect(f.calls.scans).toBe(2);
    f.moveSource();
    f.completeScans();
    await expect(
      f.service.handlers().pollRunInstructionUpdate(key),
    ).rejects.toMatchObject({ code: "instruction_source_changed" });
    expect(f.calls.continuationStarts).toBe(0);
    expect(
      (
        await f.service.handlers().cancelRunInstructionUpdate({
          runId: preview.runId,
          ...apply(preview),
        })
      ).state,
    ).toBe("cancelled");
  });

  it("keeps changed-source evidence unavailable and cancels a pending scan only after native stop", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.holdScans();
    const application = await f.service
      .handlers()
      .applyRunInstructionUpdate(apply(preview));
    expect(application.state).toBe("checking");
    expect(
      f.db.prepare("SELECT count(*) AS count FROM arc_runs").get(),
    ).toEqual({ count: 1 });
    f.delayAbort();
    const cancelled = await f.service
      .handlers()
      .cancelRunInstructionUpdate({ runId: preview.runId, ...apply(preview) });
    expect(cancelled.state).toBe("cancelling");
    expect(
      f.store.instructionUpdates.lineage(preview.runId).outgoing?.state,
    ).toBe("cancelling");
    f.allowAbort();
    expect(
      (await f.service.handlers().pollRunInstructionUpdate(application)).state,
    ).toBe("cancelled");
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "pause",
    );
    expect(f.calls.continuationStarts).toBe(0);
  });

  it("rejects moved original contents and preserves the retained preview for cancellation", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.moveSource();
    await expect(
      f.service.handlers().applyRunInstructionUpdate(apply(preview)),
    ).rejects.toMatchObject({ code: "instruction_source_changed" });
    expect(f.calls.continuationStarts).toBe(0);
    expect(
      (
        await f.service.handlers().cancelRunInstructionUpdate({
          runId: preview.runId,
          ...apply(preview),
        })
      ).state,
    ).toBe("cancelled");
  });

  it("rejects topology and restricted-version changes without pausing or scanning", async () => {
    const f = fixture();
    await expect(
      f.preview(
        f.publish((team) => {
          team.graph.nodes[0].label = "Changed stage";
        }),
      ),
    ).rejects.toMatchObject({ code: "instruction_only_required" });
    const restricted = fixture(4, true);
    await expect(restricted.preview()).rejects.toMatchObject({
      code: "team_restricted",
    });
    expect(f.calls.scans + restricted.calls.scans).toBe(0);
    expect(
      viewOwnedRun(restricted.db, restricted.workflow.workflowRunId)
        .desiredControl,
    ).toBe("run");
  });

  it("fences a late Apply after cancellation of its still-absent operation", async () => {
    const f = fixture();
    const preview = await f.preview();
    const cancelled = await f.service
      .handlers()
      .cancelRunInstructionUpdate({ runId: preview.runId, ...apply(preview) });
    expect(cancelled.state).toBe("cancelled");
    expect(
      (await f.service.handlers().applyRunInstructionUpdate(apply(preview)))
        .state,
    ).toBe("cancelled");
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "run",
    );
    expect(f.calls.scans).toBe(0);
  });

  it("rejects competing resume and keeps a failed reservation cancellable", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.beforeReserve(() =>
      controlOwnedRun(f.db, "arc", {
        workflowRunId: f.workflow.workflowRunId,
        operationId: "racing-pause",
        expectedVersion: preview.controlVersion,
        action: "pause",
      }),
    );
    await expect(
      f.service.handlers().applyRunInstructionUpdate(apply(preview)),
    ).rejects.toThrow();
    expect(
      (
        await f.service.handlers().cancelRunInstructionUpdate({
          runId: preview.runId,
          ...apply(preview),
        })
      ).state,
    ).toBe("cancelled");
    expect(f.calls.continuationStarts).toBe(0);
  });

  it("cancels an ARC starting intent that Workflows never consumed", async () => {
    const f = fixture();
    const preview = await f.preview();
    const application = f.store.instructionUpdates.reserve(apply(preview));
    reserveOwnedContinuation(f.db, "arc", {
      predecessorWorkflowRunId: f.workflow.workflowRunId,
      operationId: application.operationId,
      expectedControlVersion: preview.controlVersion,
      successorOwnerRunId: application.successorRunId,
    });
    f.store.instructionUpdates.transition(application, ["pausing"], "starting");
    expect(
      (
        await f.service.handlers().cancelRunInstructionUpdate({
          runId: preview.runId,
          ...apply(preview),
        })
      ).state,
    ).toBe("cancelled");
    expect(viewOwnedRun(f.db, f.workflow.workflowRunId).desiredControl).toBe(
      "pause",
    );
    expect(f.calls.continuationStarts).toBe(0);
  });

  it("consumes its V4 inspection for exactly the reserved successor request", async () => {
    const f = fixture();
    const preview = await f.preview();
    const application = await f.service
      .handlers()
      .applyRunInstructionUpdate(apply(preview));
    const definition = f.store.get(application.successorRunId).compiled
      .definition;
    if (definition.schemaVersion !== 4)
      throw new Error("Expected directory continuation");
    const setup = f.store.directories.getSetupByInspection(definition.request);
    expect(setup?.consumed).toEqual({
      runId: application.successorRunId,
      requestHash: runtimeHash(definition.request),
    });
    expect(() =>
      f.store.directories.consumeSetup(
        { ...definition.request, operationId: "different-operation" },
        application.successorRunId,
        () => null,
      ),
    ).toThrow("another run request");
  });

  it.each(["instructions", "rules"] as const)(
    "waits for an actual admitted worker, inherits its call, and binds first %s successor configuration",
    async (kind) => {
      const f = fixture(2);
      const claimed = claimOwnedRun(f.db, 4);
      if (!claimed) throw new Error("Expected active predecessor");
      function firstWorker(
        compiled: RetainedCompiledRun,
        workflowRunId: string,
      ) {
        const run = requireOwnedRun(f.db, workflowRunId);
        for (const step of compiled.workflow.steps) {
          const attempt = admitOwnedStep(
            f.db,
            workflowRunId,
            { nodeId: step.nodeId, iteration: step.iteration },
            null,
            run.row.dispatch_generation,
          );
          if (!attempt)
            throw new Error("Expected admitted fixture prerequisite");
          const effect = f.store.reserveEffect(attempt.request);
          if (step.kind === "agent") return { attempt, effect };
          if (step.kind !== "host-effect")
            throw new Error("Autonomous fixture has an unexpected control");
          const observation = terminalReceipt(
            attempt.request,
            "succeeded",
            { source: step.nodeId },
            "host-effect",
          );
          f.store.recordObservation(effect.effectId, observation);
          recordOwnedObservation(
            f.db,
            effect.effectId,
            run.row.dispatch_generation,
            observation,
          );
        }
        throw new Error("No fixture writer");
      }
      const old = firstWorker(f.compiled, f.workflow.workflowRunId);
      const live = terminalReceipt(
        old.attempt.request,
        "interrupted",
        { completedBy: "native-interrupt" },
        "agent",
      );
      if (!("resource" in live) || live.resource === null)
        throw new Error("Expected native worker identity");
      recordOwnedObservation(
        f.db,
        old.effect.effectId,
        claimed.row.dispatch_generation,
        { state: "running", resource: live.resource },
      );
      if (kind === "rules")
        f.setExecution({
          ...f.compiled.definition.members.builder.execution,
          model: "reviewed-successor-model",
        });
      const preview =
        kind === "rules"
          ? await readyRulePreview(f, f.publish())
          : await f.preview();
      const pending =
        "kind" in preview
          ? await f.service.handlers().applyRunRuleUpdate(ruleRequest(preview))
          : await f.service
              .handlers()
              .applyRunInstructionUpdate(apply(preview));
      expect(pending.state).toBe("pausing");
      expect(f.calls.continuationStarts).toBe(0);
      const paused = requireOwnedRun(f.db, f.workflow.workflowRunId);
      expect(
        recordOwnedObservation(
          f.db,
          old.effect.effectId,
          paused.row.dispatch_generation,
          live,
        ),
      ).toBe(true);
      f.store.recordObservation(old.effect.effectId, live);
      reconcileOwnedRunState(f.db, f.workflow.workflowRunId, false);
      const bytes = f.db
        .prepare(
          "SELECT observation_json FROM arc_run_effects WHERE effect_id=?",
        )
        .get(old.effect.effectId);
      const application =
        kind === "rules"
          ? await f.service.handlers().pollRunRuleUpdate(pending)
          : await f.service.handlers().pollRunInstructionUpdate(pending);
      expect(application.state).toBe("applied");
      const successor = f.store.get(application.successorRunId);
      expect(
        viewOwnedRun(f.db, successor.summary.workflowRunId!).agentCalls,
      ).toBe(1);
      expect(claimOwnedRun(f.db, 4)?.row.id).toBe(
        successor.summary.workflowRunId,
      );
      const worker = firstWorker(
        successor.compiled,
        successor.summary.workflowRunId!,
      );
      const source = runDefinitionFixture().source;
      f.store.sealWorker(worker.effect.effectId, {
        workspace: {
          path: source.path,
          topLevel: source.path,
          gitDir: `${source.path}/.git`,
          commonGitDir: source.commonGitDir,
          head: source.head,
          currentBranch: source.branch,
          clean: true,
          trackedDigest: source.stateHash,
          untrackedDigest: source.stateHash,
          contentDigest: source.stateHash,
          stateDigest: source.stateHash,
        },
        prompt: "First prepared successor instructions",
      });
      f.store.bindThread(worker.effect.effectId, "first-successor-thread");
      const configuration = f.service.configuration(
        worker.effect.executionContextId,
        f.scope.projectId,
        "first-successor-thread",
      );
      expect(configuration.instructions).toContain("revision 2");
      expect(configuration.instructions).toContain(
        "Reviewed successor instructions",
      );
      expect(configuration.instructions).not.toContain(
        "Original published instructions",
      );
      if (kind === "rules") {
        expect(successor.compiled.definition.schemaVersion).toBe(2);
        if (successor.compiled.definition.schemaVersion === 1)
          throw new Error("Expected Team");
        expect(
          successor.compiled.definition.members.builder.execution.model,
        ).toBe("reviewed-successor-model");
        expect(f.calls.ruleStarts).toBe(1);
        expect(f.calls.continuationStarts + f.calls.directStarts).toBe(0);
      }
      expect(
        f.db
          .prepare(
            "SELECT observation_json FROM arc_run_effects WHERE effect_id=?",
          )
          .get(old.effect.effectId),
      ).toEqual(bytes);
      expect(
        f.store.instructionUpdates.lineage(preview.runId).outgoing?.state,
      ).toBe("applied");
    },
  );

  it("rejects operational agent changes, archived pins and stale previews before applying", async () => {
    const operational = fixture();
    operational.metadata.execution.permissionMode = "full";
    await expect(operational.preview()).rejects.toMatchObject({
      code: "instruction_only_required",
    });
    const archived = fixture();
    const preview = await archived.preview();
    archived.agents.setArchived({
      scope: archived.scope,
      agentId: preview.changes[0].agentId,
      expectedDraftVersion: archived.agents.getAgent({
        scope: archived.scope,
        agentId: preview.changes[0].agentId,
      }).draft.version,
      archived: true,
    });
    await expect(
      archived.service.handlers().applyRunInstructionUpdate(apply(preview)),
    ).rejects.toMatchObject({ code: "agent_archived" });
    const stale = fixture();
    const stalePreview = await stale.preview();
    controlOwnedRun(stale.db, "arc", {
      workflowRunId: stale.workflow.workflowRunId,
      operationId: "new-control",
      expectedVersion: stalePreview.controlVersion,
      action: "pause",
    });
    await expect(
      stale.service.handlers().applyRunInstructionUpdate(apply(stalePreview)),
    ).rejects.toMatchObject({ code: "instruction_preview_stale" });
    expect(
      stale.calls.scans + archived.calls.scans + operational.calls.scans,
    ).toBe(0);
  });
});

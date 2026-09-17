import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type {
  DirectoryEffectRecord,
  DirectoryState,
} from "../host-directory-contract.js";
import { directoryEffectRequestHash } from "../host/hash.js";
import { createAgentStore, migrations } from "../data.js";
import { createArcRunStore, runtimeMigrations } from "./data.js";
import { compileArcDirectoryRun } from "./directory-compiler.js";
import { directoryDefinitionFixture } from "./directory-testing.js";
import {
  directoryValidationMigrations,
  type DirectoryValidationPass,
} from "./directory-validation.js";
import { runtimeHash } from "./hash.js";
import { createArcRunService } from "./service.js";
import { graphServicesFixture } from "./testing.js";
import { directoryRuntimeReceiptSchema } from "./directory-receipt.js";
import { migrations as workflowMigrations } from "../../workflows/src/data.js";
import {
  createOwnedRun,
  viewOwnedRun,
} from "../../workflows/src/owned-data.js";
import { ownedWorkflowRpcContract } from "bb-plugin-workflows/owned-contract";

const databases: Database.Database[] = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
  for (const db of databases.splice(0)) db.close();
});

function fixture(finalView = false) {
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
  const store = createArcRunStore(db);
  const compiled = compileArcDirectoryRun(directoryDefinitionFixture());
  const final = compiled.references.finalGates[0].verify;
  const step = compiled.workflow.steps.find((value) =>
    finalView
      ? value.nodeId === final.nodeId && value.iteration === final.iteration
      : value.requirements.length === 0 && value.lane === null,
  );
  if (!step)
    throw new Error("The fixture requires an independently admitted step");
  if (finalView) {
    step.requirements = [];
    step.lane = null;
  }
  store.reserve(compiled);
  const workflow = createOwnedRun(db, "arc", compiled.workflow);
  const immutable = {
    schemaVersion: 2 as const,
    workflowRunId: workflow.workflowRunId,
    ownerRunId: compiled.definition.runId,
    nodeId: step.nodeId,
    iteration: step.iteration,
    attempt: 1,
    effectId: "effect-directory-validation",
    definitionHash: step.definitionHash,
    dependencyReceipts: [],
    lane: null,
    input: null,
  };
  store.reserveEffect({
    ...immutable,
    dispatchGeneration: 1,
    requestHash: runtimeHash({ owner: "arc", ...immutable }),
  });
  const candidate: DirectoryState = {
    ...compiled.definition.source,
    path: "C:/Retained folder 東京",
    rootIdentity: { deviceId: "7", fileId: "12" },
    manifestDigest: "c".repeat(64),
  };
  const states = [compiled.definition.source, candidate];
  const intent = {
    runId: compiled.definition.runId,
    effectId: immutable.effectId,
    generation: 1,
    purpose: "terminal",
    phase: "revalidate" as const,
    targets: states.map((state) => ({
      target: {
        kind: state.kind,
        path: state.path,
        rootIdentity: state.rootIdentity,
      },
      expected: {
        kind: state.kind,
        path: state.path,
        rootIdentity: state.rootIdentity,
        manifestDigest: state.manifestDigest,
      },
    })),
  };
  const pass = store.directories.reserveValidation(intent, false);
  const owner = {
    effectId: immutable.effectId,
    runId: compiled.definition.runId,
  };
  function record(
    index: number,
    selected = pass,
    state = states[index],
  ): DirectoryEffectRecord {
    const job = selected.jobs[index];
    if (job.operation.type !== "scan-directory")
      throw new Error("Expected an inspection");
    const checkedAt = `2026-09-10T13:00:0${index + 1}.000Z`;
    return {
      kind: "directory",
      runId: job.runId,
      effectId: job.effectId,
      requestHash: directoryEffectRequestHash(job),
      state: "terminal",
      startedAt: "2026-09-10T13:00:00.000Z",
      finishedAt: checkedAt,
      receipt: {
        kind: "directory",
        operationType: "scan-directory",
        outcome: "succeeded",
        errorCode: null,
        reason: null,
        before: null,
        after: state,
        source: null,
        processes: [],
        finishedAt: checkedAt,
        artifact: {
          kind: "inspection",
          validationId: selected.validationId,
          consumer: job.operation.consumer,
          phase: job.operation.phase,
          state,
          checkedAt,
        },
      },
    };
  }
  function complete(selected: DirectoryValidationPass = pass) {
    states.forEach((_, index) =>
      store.directories.recordValidation(
        selected.validationId,
        record(index, selected),
      ),
    );
  }
  return { db, store, compiled, pass, owner, states, intent, record, complete };
}

describe("retained directory validation evidence", () => {
  it("reads historical final proof without scanning and refuses same-effect proof that omits its candidate", async () => {
    const f = fixture(true);
    f.complete();
    const callHost = vi.fn(async () => {
      throw new Error(
        "Opening a retained run must not launch or observe native scans",
      );
    });
    const host = createFakePluginHost({
      pluginId: "arc",
      experimental_callHostRpc: callHost,
      experimental_internalRpc: async ({ pluginId, method, input }) => {
        if (pluginId !== "workflows" || method !== "inspectOwnedRun")
          throw new Error(`Unexpected internal request ${method}`);
        const request =
          ownedWorkflowRpcContract.inspectOwnedRun.input.parse(input);
        return { run: viewOwnedRun(f.db, request.workflowRunId) };
      },
    });
    hosts.push(host);
    const agents = createAgentStore(f.db);
    const service = createArcRunService(
      host.bb,
      f.store,
      agents,
      graphServicesFixture(f.db, agents, host.bb),
    );
    const state = f.states[1];
    const receipt = directoryRuntimeReceiptSchema.parse({
      kind: "directory-native",
      request: f.pass.jobs[1],
      receipt: f.record(1).receipt,
      candidate: {
        kind: "directory-snapshot",
        snapshotId: "snapshot-final",
        manifestDigest: state.manifestDigest,
        workspace: {
          kind: state.kind,
          path: state.path,
          rootIdentity: state.rootIdentity,
          workspaceId: "snapshot-final",
          originalPath: f.states[0].path,
          expectedManifestDigest: state.manifestDigest,
        },
      },
    });
    const observation = {
      state: "succeeded" as const,
      resource: {
        kind: "host-effect" as const,
        hostId: f.compiled.definition.request.hostId,
        effectId: f.owner.effectId,
      },
      receipt,
      receiptHash: runtimeHash(receipt),
      validity: {
        state: "current" as const,
        identityHash: runtimeHash(f.pass),
        validationId: f.pass.validationId,
      },
    };
    f.store.recordObservation(f.owner.effectId, observation);
    const first = await service.handlers().getRun({ runId: f.owner.runId });
    expect(first.verification).toMatchObject({
      kind: "directory",
      state: "current",
      checkedAt: "2026-09-10T13:00:02.000Z",
      snapshotId: "snapshot-final",
    });
    const originOnly = f.store.directories.reserveValidation(
      { ...f.intent, purpose: "origin-only", targets: [f.intent.targets[0]] },
      false,
    );
    f.store.directories.recordValidation(
      originOnly.validationId,
      f.record(0, originOnly),
    );
    f.store.recordObservation(f.owner.effectId, {
      ...observation,
      validity: {
        ...observation.validity,
        validationId: originOnly.validationId,
      },
    });
    const second = await service.handlers().getRun({ runId: f.owner.runId });
    expect(second.verification).toMatchObject({
      kind: "directory",
      state: "unavailable",
      checkedAt: null,
    });
    expect(callHost).not.toHaveBeenCalled();
  });

  it("requires every exact scan before exposing the final historical timestamp, including after store recreation", () => {
    const f = fixture();
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, f.owner),
    ).toBeNull();
    f.store.directories.recordValidation(f.pass.validationId, f.record(0));
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, f.owner),
    ).toBeNull();
    f.store.directories.recordValidation(f.pass.validationId, f.record(1));
    expect(
      createArcRunStore(f.db).directories.validationCheckedAt(
        f.pass.validationId,
        f.owner,
      ),
    ).toBe("2026-09-10T13:00:02.000Z");
  });

  it("never substitutes the latest proof for a missing, foreign or incomplete requested proof", () => {
    const f = fixture();
    f.complete();
    const next = f.store.directories.reserveValidation(f.intent, true);
    expect(
      f.store.directories.validationCheckedAt(next.validationId, f.owner),
    ).toBeNull();
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, {
        ...f.owner,
        effectId: "different-effect",
      }),
    ).toBeNull();
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, {
        ...f.owner,
        runId: "run_different",
      }),
    ).toBeNull();
    expect(
      f.store.directories.validationCheckedAt("missing-proof", f.owner),
    ).toBeNull();
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, f.owner),
    ).not.toBeNull();
  });

  it.each(["path", "root", "digest"] as const)(
    "withholds a successful host scan whose %s differs from the retained expectation",
    (field) => {
      const f = fixture();
      const changed = {
        ...f.states[1],
        ...(field === "path" ? { path: "C:/Another folder" } : {}),
        ...(field === "root"
          ? { rootIdentity: { deviceId: "7", fileId: "99" } }
          : {}),
        ...(field === "digest" ? { manifestDigest: "d".repeat(64) } : {}),
      };
      f.store.directories.recordValidation(f.pass.validationId, f.record(0));
      f.store.directories.recordValidation(
        f.pass.validationId,
        f.record(1, f.pass, changed),
      );
      expect(
        f.store.directories.validationCheckedAt(f.pass.validationId, f.owner),
      ).toBeNull();
    },
  );

  it("quiesces a proof without deleting receipts and requires a distinct complete proof afterward", () => {
    const f = fixture();
    f.complete();
    const receipts = f.store.directories.validation(
      f.pass.validationId,
    ).records;
    f.store.directories.quiesceValidation(f.pass.validationId);
    expect(
      f.store.directories.validationCheckedAt(f.pass.validationId, f.owner),
    ).toBeNull();
    expect(f.store.directories.validation(f.pass.validationId).records).toEqual(
      receipts,
    );
    const resumed = f.store.directories.reserveValidation(
      { ...f.intent, generation: 3 },
      false,
    );
    expect(resumed.validationId).not.toBe(f.pass.validationId);
    expect(
      f.store.directories.validationCheckedAt(resumed.validationId, f.owner),
    ).toBeNull();
    f.complete(resumed);
    expect(
      f.store.directories.validationCheckedAt(resumed.validationId, f.owner),
    ).toBe("2026-09-10T13:00:02.000Z");
  });

  it("rejects mismatched jobs and immutable receipt changes without overwriting the accepted proof", () => {
    const f = fixture();
    const original = f.record(0);
    expect(() =>
      f.store.directories.recordValidation(f.pass.validationId, {
        ...original,
        requestHash: "f".repeat(64),
      }),
    ).toThrow("another retained validation job");
    f.store.directories.recordValidation(f.pass.validationId, original);
    const changed = f.record(0, f.pass, {
      ...f.states[0],
      manifestDigest: "e".repeat(64),
    });
    expect(() =>
      f.store.directories.recordValidation(f.pass.validationId, changed),
    ).toThrow("terminal native validation result cannot change");
    expect(
      f.store.directories.validation(f.pass.validationId).records[
        original.effectId
      ],
    ).toEqual(original);
  });
});

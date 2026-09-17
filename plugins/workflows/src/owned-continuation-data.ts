import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./data.js";
import {
  canonicalOwnedJson,
  ownedContinuationKeySchema,
  ownedContinuationReserveSchema,
  ownedContinuationStartSchema,
  ownedContinuationViewSchema,
  ownedRunStartInputSchema,
  ownedRepairCatalogSchema,
  ownedRuleContextSchema,
  ownedRuleContinuationAuthorizationSchema,
  ownedRuleContinuationStartSchema,
  ownedAddressedContinuationAuthorizationSchema,
  ownedAddressedContinuationStartSchema,
  type OwnedContinuationKey,
  type OwnedContinuationReserve,
  type OwnedContinuationStart,
  type OwnedContinuationView,
  type OwnedRunStartInput,
  type OwnedRepairCatalog,
  type OwnedRuleContext,
  type OwnedRuleContinuationAuthorization,
  type OwnedRuleContinuationStart,
  type OwnedAddressedContinuationAuthorization,
  type OwnedAddressedContinuationStart,
} from "./owned-contract.js";
import {
  activeOwnedAttempts,
  controlOwnedRun,
  hashOwnedValue,
  hasRunningOwnedValidation,
  ownedRepairStageLimits,
  readOwnedRepairCatalog,
  validateOwnedRepairCatalog,
  requireOwnedOwner,
  requireOwnedRun,
  viewOwnedRun,
} from "./owned-data.js";

const rowSchema = z.object({
  predecessor_run_id: z.string(),
  operation_id: z.string(),
  owner_plugin_id: z.string(),
  successor_owner_run_id: z.string(),
  reservation_hash: z.string(),
  state: z.enum(["reserved", "retiring", "started", "cancelled"]),
  successor_request_hash: z.string().nullable(),
  successor_request_json: z.string().nullable(),
  successor_run_id: z.string().nullable(),
  rule_authorization_json: z.string().nullable(),
});
type ContinuationRow = z.infer<typeof rowSchema>;
const continuationAuthorizationSchema = z.union([
  ownedRuleContinuationAuthorizationSchema,
  ownedAddressedContinuationAuthorizationSchema,
]);
type ContinuationAuthorization =
  | OwnedRuleContinuationAuthorization
  | OwnedAddressedContinuationAuthorization;

function requireOwner(db: Db, owner: string, predecessor: string) {
  if (owner !== "arc") throw new Error("This workflow owner is not admitted");
  return requireOwnedOwner(db, predecessor, owner);
}

function find(db: Db, input: OwnedContinuationKey): ContinuationRow | null {
  const raw = db
    .prepare(
      "SELECT * FROM workflow_owned_continuations WHERE predecessor_run_id = ? AND operation_id = ?",
    )
    .get(input.predecessorWorkflowRunId, input.operationId);
  return raw === undefined ? null : rowSchema.parse(raw);
}

function requireReservation(
  db: Db,
  owner: string,
  input: OwnedContinuationKey,
) {
  requireOwner(db, owner, input.predecessorWorkflowRunId);
  const row = find(db, input);
  if (row === null)
    throw new Error("Unknown workflow continuation reservation");
  if (row.owner_plugin_id !== owner)
    throw new Error("This continuation belongs to another owner");
  return row;
}

function quiescent(db: Db, runId: string, allowWaitingControls: boolean) {
  return (
    !hasRunningOwnedValidation(db, runId) &&
    activeOwnedAttempts(db, runId).every(
      (attempt) =>
        allowWaitingControls &&
        attempt.row.kind === "owner-control" &&
        attempt.row.state === "waiting",
    ) &&
    db
      .prepare(
        "SELECT 1 FROM workflow_active_intervals WHERE run_id = ? AND closed_at IS NULL",
      )
      .get(runId) === undefined
  );
}

function view(db: Db, row: ContinuationRow): OwnedContinuationView {
  const predecessor = viewOwnedRun(db, row.predecessor_run_id);
  return ownedContinuationViewSchema.parse({
    predecessorWorkflowRunId: row.predecessor_run_id,
    operationId: row.operation_id,
    successorOwnerRunId: row.successor_owner_run_id,
    successorPlanHash:
      row.successor_request_json === null
        ? null
        : ownedRunStartInputSchema.parse(JSON.parse(row.successor_request_json))
            .planHash,
    state:
      row.state === "reserved"
        ? (predecessor.desiredControl === "pause" ||
            ["succeeded", "failed", "cancelled"].includes(predecessor.state)) &&
          quiescent(db, row.predecessor_run_id, true)
          ? "ready"
          : "pausing"
        : row.state,
    predecessor,
    successor:
      row.successor_run_id === null
        ? null
        : viewOwnedRun(db, row.successor_run_id),
  });
}

export function inspectOwnedContinuation(
  db: Db,
  owner: string,
  input: OwnedContinuationKey,
) {
  const key = ownedContinuationKeySchema.parse(input);
  requireOwner(db, owner, key.predecessorWorkflowRunId);
  const row = find(db, key);
  if (row !== null && row.owner_plugin_id !== owner)
    throw new Error("This continuation belongs to another owner");
  return row === null ? null : view(db, row);
}

export function inspectOwnedRuleContext(
  db: Db,
  owner: string,
  runId: string,
): OwnedRuleContext {
  return db.transaction(() => {
    const run = requireOwner(db, owner, runId);
    const catalog = readOwnedRepairCatalog(db, runId);
    if (catalog !== null) validateOwnedRepairCatalog(run.input, catalog);
    return ownedRuleContextSchema.parse({
      run: viewOwnedRun(db, runId),
      repairCatalog:
        catalog !== null
          ? { source: "stored", stages: catalog.stages }
          : run.input.limits.maxRepairRounds === 0
            ? { source: "legacy-zero" }
            : { source: "manifest", stages: ownedRepairStageLimits(run.input) },
    });
  })();
}

export function reserveOwnedContinuation(
  db: Db,
  owner: string,
  input: OwnedContinuationReserve,
  now = Date.now(),
) {
  return db.transaction(() => {
    const request = ownedContinuationReserveSchema.parse(input);
    const predecessor = requireOwner(
      db,
      owner,
      request.predecessorWorkflowRunId,
    );
    const reservationHash = hashOwnedValue({ owner, input: request });
    const retained = find(db, request);
    if (retained !== null) {
      if (retained.reservation_hash !== reservationHash)
        throw new Error(
          "Continuation operation identity was reused with different content",
        );
      return view(db, retained);
    }
    if (
      predecessor.row.owner_run_id === request.successorOwnerRunId ||
      db
        .prepare(
          "SELECT 1 FROM workflow_owned_runs WHERE owner_plugin_id = ? AND owner_run_id = ?",
        )
        .get(owner, request.successorOwnerRunId) !== undefined
    )
      throw new Error(
        "Continuation successor identity already belongs to a workflow run",
      );
    if (
      db
        .prepare(
          "SELECT 1 FROM workflow_owned_continuations WHERE owner_plugin_id = ? AND successor_owner_run_id = ?",
        )
        .get(owner, request.successorOwnerRunId) !== undefined
    )
      throw new Error("Continuation successor identity is already reserved");
    if (
      db
        .prepare(
          "SELECT 1 FROM workflow_owned_continuations WHERE predecessor_run_id = ? AND state <> 'cancelled'",
        )
        .get(request.predecessorWorkflowRunId) !== undefined
    )
      throw new Error(
        "Workflow predecessor already has a continuation reservation",
      );
    const terminal = ["succeeded", "failed", "cancelled"].includes(
      predecessor.row.state,
    );
    if (
      terminal &&
      predecessor.row.control_version !== request.expectedControlVersion
    )
      throw new Error("Workflow control version changed");
    if (terminal && !quiescent(db, predecessor.row.id, false))
      throw new Error(
        "The completed workflow still has native work to reconcile",
      );
    if (!terminal && predecessor.row.desired_control === "cancel")
      throw new Error("A retiring workflow cannot reserve a continuation");
    if (!terminal)
      controlOwnedRun(
        db,
        owner,
        {
          workflowRunId: request.predecessorWorkflowRunId,
          operationId: `continuation-pause:${randomUUID()}`,
          expectedVersion: request.expectedControlVersion,
          action: "pause",
        },
        now,
      );
    db.prepare(`INSERT INTO workflow_owned_continuations
      (predecessor_run_id, operation_id, owner_plugin_id, successor_owner_run_id,
       reservation_hash, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
      request.predecessorWorkflowRunId,
      request.operationId,
      owner,
      request.successorOwnerRunId,
      reservationHash,
      now,
      now,
    );
    return view(db, requireReservation(db, owner, request));
  })();
}

export function cancelOwnedContinuation(
  db: Db,
  owner: string,
  input: OwnedContinuationKey,
  now = Date.now(),
) {
  return db.transaction(() => {
    const request = ownedContinuationKeySchema.parse(input);
    const row = requireReservation(db, owner, request);
    if (row.state === "cancelled") return view(db, row);
    if (row.state !== "reserved")
      throw new Error("A consumed continuation cannot be cancelled");
    db.prepare(
      "UPDATE workflow_owned_continuations SET state = 'cancelled', updated_at = ? WHERE predecessor_run_id = ? AND operation_id = ?",
    ).run(now, request.predecessorWorkflowRunId, request.operationId);
    db.prepare(
      "UPDATE workflow_owned_runs SET control_version = control_version + 1, dispatch_generation = dispatch_generation + 1 WHERE id = ?",
    ).run(request.predecessorWorkflowRunId);
    return view(db, requireReservation(db, owner, request));
  })();
}

function validateSuccessor(
  db: Db,
  row: ContinuationRow,
  input: OwnedRunStartInput,
  authorization: ContinuationAuthorization | null,
): OwnedRepairCatalog | null {
  const predecessor = requireOwnedRun(db, row.predecessor_run_id);
  if (input.ownerRunId !== row.successor_owner_run_id)
    throw new Error(
      "Continuation successor identity does not match its reservation",
    );
  if (
    input.projectId !== predecessor.input.projectId ||
    input.originThreadId !== predecessor.input.originThreadId
  )
    throw new Error(
      "Continuation project and origin must match its predecessor",
    );
  const catalog = readOwnedRepairCatalog(db, row.predecessor_run_id);
  if (catalog !== null) validateOwnedRepairCatalog(predecessor.input, catalog);
  if (authorization !== null && "kind" in authorization) {
    if (
      authorization.predecessorPlanHash !== predecessor.input.planHash ||
      !["succeeded", "failed", "cancelled"].includes(predecessor.row.state)
    )
      throw new Error(
        "Addressed graph continuation requires its exact terminal predecessor",
      );
    if (
      canonicalOwnedJson(input.limits) !==
      canonicalOwnedJson(predecessor.input.limits)
    )
      throw new Error(
        "Addressed graph continuation cannot reset or increase shared limits",
      );
    const active = ownedRepairStageLimits(input);
    const inherited = viewOwnedRun(db, row.predecessor_run_id);
    const previousIds = new Set([
      ...(catalog?.stages ?? ownedRepairStageLimits(predecessor.input)).map(
        (stage) => stage.stageId,
      ),
      ...inherited.repairRounds.map((stage) => stage.stageId),
    ]);
    const mapping = new Map(
      authorization.repairStageMappings.map((entry) => [
        entry.fromStageId,
        entry.toStageId,
      ]),
    );
    if (
      [...mapping.keys()].some((stageId) => !previousIds.has(stageId)) ||
      new Set(
        [...previousIds].map((stageId) => mapping.get(stageId) ?? stageId),
      ).size !== previousIds.size
    )
      throw new Error(
        "Repair identities cannot be invented, merged or discarded",
      );
    for (const stage of inherited.repairRounds) {
      const next = active.find(
        (value) =>
          value.stageId === (mapping.get(stage.stageId) ?? stage.stageId),
      );
      if (next !== undefined && next.maxRounds < stage.rounds)
        throw new Error(
          "An active repair stage cannot discard consumed rounds",
        );
    }
    const historicalIds = new Set(
      [...previousIds].map((stageId) => mapping.get(stageId) ?? stageId),
    );
    const next = ownedRepairCatalogSchema.parse({
      schemaVersion: 1,
      stages: [
        ...active,
        ...[...historicalIds]
          .filter(
            (stageId) => !active.some((stage) => stage.stageId === stageId),
          )
          .map((stageId) => ({ stageId, maxRounds: 0 })),
      ],
    });
    validateOwnedRepairCatalog(input, next);
    return next;
  }
  if (authorization !== null) {
    if (!("schemaVersion" in predecessor.input) || !("schemaVersion" in input))
      throw new Error("Reviewed rules require V2 workflow manifests");
    const before = authorization.repairStages.map((stage) => ({
      stageId: stage.stageId,
      maxRounds: stage.beforeMaxRounds,
    }));
    if (catalog === null && predecessor.input.limits.maxRepairRounds === 0) {
      if (
        before.some((stage) => stage.maxRounds !== 0) ||
        ownedRepairStageLimits(predecessor.input).length !== 0
      )
        throw new Error(
          "Legacy disabled repair stages must have zero before limits",
        );
    } else if (
      canonicalOwnedJson(before) !==
      canonicalOwnedJson(
        catalog?.stages ??
          ownedRepairCatalogSchema.parse({
            schemaVersion: 1,
            stages: ownedRepairStageLimits(predecessor.input),
          }).stages,
      )
    ) {
      throw new Error(
        "Reviewed repair-stage identities and before limits must match the predecessor",
      );
    }
    const successorCatalog: OwnedRepairCatalog = {
      schemaVersion: 1,
      stages: authorization.repairStages.map((stage) => ({
        stageId: stage.stageId,
        maxRounds: stage.afterMaxRounds,
      })),
    };
    validateOwnedRepairCatalog(input, successorCatalog);
    const usage = viewOwnedRun(db, row.predecessor_run_id);
    if (
      input.limits.maxAgentCalls < usage.agentCalls ||
      input.limits.maxActiveMs < usage.chargedActiveMs
    )
      throw new Error(
        "Reviewed workflow limits are below cumulative consumption",
      );
    for (const stage of usage.repairRounds) {
      const prior = before.find((value) => value.stageId === stage.stageId);
      const next = successorCatalog.stages.find(
        (value) => value.stageId === stage.stageId,
      );
      if (
        prior === undefined ||
        next === undefined ||
        prior.maxRounds < stage.rounds ||
        next.maxRounds < stage.rounds
      )
        throw new Error(
          "Reviewed repair limits are below cumulative stage consumption",
        );
    }
    return successorCatalog;
  }
  if (
    canonicalOwnedJson(input.limits) !==
    canonicalOwnedJson(predecessor.input.limits)
  )
    throw new Error("Continuation limits must match its predecessor");
  if (
    canonicalOwnedJson(ownedRepairStageLimits(input)) !==
    canonicalOwnedJson(ownedRepairStageLimits(predecessor.input))
  )
    throw new Error(
      "Continuation repair-stage identities and limits must match its predecessor",
    );
  if (catalog !== null) validateOwnedRepairCatalog(input, catalog);
  return catalog;
}

function finalize(db: Db, row: ContinuationRow, now: number): boolean {
  if (row.state !== "retiring" || !quiescent(db, row.predecessor_run_id, false))
    return false;
  if (
    row.successor_request_json === null ||
    row.successor_request_hash === null
  )
    throw new Error("Retiring continuation has no sealed successor");
  const predecessor = requireOwnedRun(db, row.predecessor_run_id);
  const terminal = ["succeeded", "failed", "cancelled"].includes(
    predecessor.row.state,
  );
  if (!terminal && predecessor.row.desired_control !== "cancel")
    throw new Error("Continuation predecessor retirement was not requested");
  const input = ownedRunStartInputSchema.parse(
    JSON.parse(row.successor_request_json),
  );
  if (
    row.successor_request_hash !==
    hashOwnedValue({ owner: row.owner_plugin_id, input })
  )
    throw new Error("Retiring continuation request no longer matches its seal");
  const authorization =
    row.rule_authorization_json === null
      ? null
      : continuationAuthorizationSchema.parse(
          JSON.parse(row.rule_authorization_json),
        );
  const catalog = validateSuccessor(db, row, input, authorization);
  const inherited = viewOwnedRun(db, row.predecessor_run_id);
  const successorRunId = `wfo_${randomUUID()}`;
  db.prepare(`INSERT INTO workflow_owned_runs
    (id, owner_plugin_id, owner_run_id, request_hash, request_json, state,
     desired_control, agent_calls, charged_active_ms, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 'run', ?, ?, ?)`).run(
    successorRunId,
    row.owner_plugin_id,
    row.successor_owner_run_id,
    row.successor_request_hash,
    row.successor_request_json,
    inherited.agentCalls,
    inherited.chargedActiveMs,
    now,
  );
  for (const repair of inherited.repairRounds)
    db.prepare(
      "INSERT INTO workflow_owned_repair_baselines (run_id, stage_id, rounds) VALUES (?, ?, ?)",
    ).run(
      successorRunId,
      authorization !== null && "kind" in authorization
        ? (authorization.repairStageMappings.find(
            (entry) => entry.fromStageId === repair.stageId,
          )?.toStageId ?? repair.stageId)
        : repair.stageId,
      repair.rounds,
    );
  if (catalog !== null)
    db.prepare(
      "INSERT INTO workflow_owned_repair_catalogs (run_id, catalog_json) VALUES (?, ?)",
    ).run(successorRunId, canonicalOwnedJson(catalog));
  if (!terminal)
    db.prepare(
      "UPDATE workflow_owned_runs SET state = 'cancelled', finished_at = ?, control_version = control_version + 1, dispatch_generation = dispatch_generation + 1 WHERE id = ?",
    ).run(now, row.predecessor_run_id);
  db.prepare(
    "UPDATE workflow_lanes SET run_id = NULL, effect_id = NULL, released_at = ? WHERE run_id = ?",
  ).run(now, row.predecessor_run_id);
  db.prepare(
    "UPDATE workflow_owned_continuations SET state = 'started', successor_run_id = ?, updated_at = ? WHERE predecessor_run_id = ? AND operation_id = ?",
  ).run(successorRunId, now, row.predecessor_run_id, row.operation_id);
  return true;
}

export function startOwnedContinuation(
  db: Db,
  owner: string,
  input: OwnedContinuationStart,
  now = Date.now(),
) {
  return startContinuation(
    db,
    owner,
    ownedContinuationStartSchema.parse(input),
    null,
    now,
  );
}

export function startOwnedRuleContinuation(
  db: Db,
  owner: string,
  input: OwnedRuleContinuationStart,
  now = Date.now(),
) {
  const request = ownedRuleContinuationStartSchema.parse(input);
  return startContinuation(db, owner, request, request.authorization, now);
}

export function startOwnedAddressedContinuation(
  db: Db,
  owner: string,
  input: OwnedAddressedContinuationStart,
  now = Date.now(),
) {
  const request = ownedAddressedContinuationStartSchema.parse(input);
  return startContinuation(db, owner, request, request.authorization, now);
}

function startContinuation(
  db: Db,
  owner: string,
  request: OwnedContinuationStart,
  authorization: ContinuationAuthorization | null,
  now: number,
) {
  return db.transaction(() => {
    const row = requireReservation(db, owner, request);
    const requestHash = hashOwnedValue({ owner, input: request.successor });
    const authorizationJson =
      authorization === null ? null : canonicalOwnedJson(authorization);
    if (row.state === "cancelled")
      throw new Error("Continuation reservation was cancelled");
    if (row.successor_request_hash !== null) {
      if (row.rule_authorization_json !== authorizationJson)
        throw new Error(
          "Continuation method or reviewed authorization does not match its seal",
        );
      if (row.successor_request_hash !== requestHash)
        throw new Error(
          "Continuation successor was reused with different content",
        );
      finalize(db, row, now);
      return view(db, requireReservation(db, owner, request));
    }
    if (row.rule_authorization_json !== null)
      throw new Error("Continuation authorization has no sealed successor");
    validateSuccessor(db, row, request.successor, authorization);
    if (view(db, row).state !== "ready")
      throw new Error("Continuation predecessor is not yet quiescent");
    db.prepare(`UPDATE workflow_owned_continuations SET state = 'retiring',
      successor_request_hash = ?, successor_request_json = ?, rule_authorization_json = ?, updated_at = ?
      WHERE predecessor_run_id = ? AND operation_id = ?`).run(
      requestHash,
      canonicalOwnedJson(request.successor),
      authorizationJson,
      now,
      request.predecessorWorkflowRunId,
      request.operationId,
    );
    if (
      !["succeeded", "failed", "cancelled"].includes(
        requireOwnedRun(db, request.predecessorWorkflowRunId).row.state,
      )
    )
      controlOwnedRun(
        db,
        owner,
        {
          workflowRunId: request.predecessorWorkflowRunId,
          operationId: `continuation-retire:${randomUUID()}`,
          expectedVersion: requireOwnedRun(db, request.predecessorWorkflowRunId)
            .row.control_version,
          action: "cancel",
        },
        now,
        request.operationId,
      );
    finalize(db, requireReservation(db, owner, request), now);
    return view(db, requireReservation(db, owner, request));
  })();
}

export function finalizeOwnedContinuations(db: Db, now = Date.now()): string[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT * FROM workflow_owned_continuations WHERE state = 'retiring' ORDER BY created_at LIMIT 100",
      )
      .all()
      .map((raw) => rowSchema.parse(raw));
    return rows
      .filter((row) => finalize(db, row, now))
      .map((row) => row.predecessor_run_id);
  })();
}

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  directoryEffectReceiptSchema,
  type DirectoryBinding,
  type DirectoryEffectReceipt,
  type DirectoryEffectRequest,
  type DirectoryRoot,
  type DirectoryState,
} from "../host-directory-contract.js";
import { containedPath, samePath } from "./git.js";
import {
  DirectoryFailure,
  copyDirectory,
  inspectDirectoryRoot,
  inspectProjectSource,
  requireDirectorySource,
  sameDirectoryRoot,
  sameDirectoryState,
  scanDirectory,
  verifyDirectoryBinding,
  type DirectoryInventory,
} from "./directory.js";
import { HostJournal, NativeJournalStateError } from "./journal.js";
import { NativeOutcomeUnknown, runNativeProcess } from "./process.js";

export const directoryIoTimeoutMs = 600_000;
const segment = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
type Context = { journal: HostJournal; root: DirectoryRoot };

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!suffix.startsWith("..\\") &&
      !suffix.startsWith("../") &&
      suffix !== ".." &&
      !isAbsolute(suffix))
  );
}

function destination(root: string, request: DirectoryEffectRequest): string {
  if (!("workspaceId" in request.operation))
    throw new Error("Directory operation has no destination.");
  return containedPath(
    root,
    join(root, segment(request.runId), segment(request.operation.workspaceId)),
  );
}

function requireDisjoint(original: string, ownedRoot: string): void {
  if (within(original, ownedRoot) || within(ownedRoot, original))
    throw new DirectoryFailure(
      "ownership_mismatch",
      "Original source and native directory storage must be disjoint.",
    );
}

export function directoryAdmission(
  context: Context,
  request: DirectoryEffectRequest,
) {
  const operation = request.operation;
  if (operation.type === "scan-directory")
    return context.journal.admitDirectory(
      request,
      `directory-scan:${request.runId}:${request.effectId}`,
      null,
      process.pid,
    );
  if (operation.type === "check-directory")
    return context.journal.admitDirectory(
      request,
      process.platform === "win32"
        ? operation.workspace.path.toLowerCase()
        : operation.workspace.path,
      null,
    );
  const path = destination(context.root.path, request);
  const originalPath =
    operation.type === "capture-source"
      ? operation.source.path
      : operation.type === "capture-directory"
        ? operation.source.originalPath
        : operation.source.workspace.originalPath;
  requireDisjoint(originalPath, context.root.path);
  return context.journal.admitDirectory(
    request,
    process.platform === "win32" ? path.toLowerCase() : path,
    {
      path,
      workspaceId: operation.workspaceId,
      originalPath,
      role: operation.type === "materialize-directory" ? "working" : "snapshot",
      sourceSnapshotId:
        operation.type === "materialize-directory"
          ? operation.source.snapshotId
          : null,
    },
  );
}

async function requireOwned(
  context: Context,
  request: DirectoryEffectRequest,
  binding: DirectoryBinding,
  role?: "working" | "snapshot",
) {
  const root = await inspectDirectoryRoot(context.root.path);
  if (!sameDirectoryRoot(root, context.root))
    throw new DirectoryFailure(
      "directory_changed",
      "Native directory storage was redirected.",
    );
  requireDisjoint(binding.originalPath, context.root.path);
  containedPath(context.root.path, binding.path);
  const current = await inspectDirectoryRoot(binding.path);
  if (!sameDirectoryRoot(current, binding))
    throw new DirectoryFailure(
      "directory_changed",
      `Run-owned directory was replaced: ${binding.path}`,
    );
  return context.journal.requireDirectoryWorkspace(
    binding,
    request.runId,
    role,
  );
}

async function createRunParent(
  context: Context,
  request: DirectoryEffectRequest,
  path: string,
  signal: AbortSignal,
) {
  if (
    !sameDirectoryRoot(
      await inspectDirectoryRoot(context.root.path),
      context.root,
    )
  )
    throw new DirectoryFailure(
      "directory_changed",
      "Native directory storage was redirected.",
    );
  const parent = dirname(path);
  containedPath(context.root.path, parent);
  signal.throwIfAborted();
  context.journal.assertDirectoryFence(request);
  try {
    await mkdir(parent);
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
    )
      throw error;
  }
  const inspected = await inspectDirectoryRoot(parent);
  if (!samePath(inspected.path, parent))
    throw new DirectoryFailure(
      "unsupported_link",
      "Native run directory was redirected.",
    );
  const existing = await lstat(path).then(
    () => true,
    (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    },
  );
  if (existing)
    throw new DirectoryFailure(
      "destination_exists",
      `Run directory already exists: ${path}`,
    );
}

export async function executeDirectoryEffect(
  context: Context,
  request: DirectoryEffectRequest,
  ownerSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([
    ownerSignal,
    AbortSignal.timeout(
      request.operation.type === "check-directory"
        ? request.operation.timeoutMs + directoryIoTimeoutMs
        : directoryIoTimeoutMs,
    ),
  ]);
  let before: DirectoryState | null = null;
  let after: DirectoryState | null = null;
  let source: DirectoryState | null = null;
  let artifact: DirectoryEffectReceipt["artifact"] = null;
  const processes: DirectoryEffectReceipt["processes"] = [];
  let inventory: DirectoryInventory | null = null;
  let mutationStarted = false;
  let outcome: DirectoryEffectReceipt["outcome"] = "succeeded";
  let errorCode: DirectoryEffectReceipt["errorCode"] = null;
  let reason: string | null = null;
  const fence = () => {
    signal.throwIfAborted();
    context.journal.assertDirectoryFence(request);
    mutationStarted = true;
  };
  try {
    signal.throwIfAborted();
    context.journal.assertDirectoryFence(request);
    const operation = request.operation;
    if (operation.type === "scan-directory") {
      await requireDirectorySource(operation.target.path, signal);
      if (
        operation.target.kind === "directory" &&
        "workspaceId" in operation.target
      )
        await requireOwned(context, request, operation.target);
      inventory = await scanDirectory(operation.target.path, signal);
      after = inventory.state;
      await requireDirectorySource(after.path, signal);
      if (operation.target.kind === "directory")
        verifyDirectoryBinding(after, operation.target);
      artifact = {
        kind: "inspection",
        validationId: operation.validationId,
        consumer: operation.consumer,
        phase: operation.phase,
        state: after,
        checkedAt: new Date().toISOString(),
      };
    } else if (operation.type === "check-directory") {
      const owned = await requireOwned(
        context,
        request,
        operation.workspace,
        "working",
      );
      const snapshot = context.journal.directorySnapshot(
        operation.snapshotId,
        request.runId,
      );
      if (
        owned.source_snapshot_id !== operation.snapshotId ||
        snapshot.manifestDigest !== operation.workspace.expectedManifestDigest
      )
        throw new DirectoryFailure(
          "ownership_mismatch",
          "The check workspace does not identify its exact input snapshot.",
        );
      before = (await scanDirectory(operation.workspace.path, signal)).state;
      verifyDirectoryBinding(before, operation.workspace);
      fence();
      const process = await runNativeProcess({
        executable: operation.executable,
        args: operation.args,
        cwd: before.path,
        timeoutMs: operation.timeoutMs,
        signal,
      });
      processes.push(process);
      after = (
        await scanDirectory(
          before.path,
          AbortSignal.timeout(directoryIoTimeoutMs),
        )
      ).state;
      if (!sameDirectoryState(before, after))
        throw new DirectoryFailure(
          "directory_changed",
          `The check changed its candidate, including cache or output files: ${before.path}`,
        );
      if (process.interrupted)
        throw new DirectoryFailure(
          "interrupted",
          "The directory check was interrupted.",
        );
      if (process.exitCode !== 0)
        throw new DirectoryFailure(
          "process_failed",
          `Directory check exited with ${String(process.exitCode)}.`,
        );
    } else {
      let input: DirectoryInventory;
      if (operation.type === "capture-source") {
        const detected = await inspectProjectSource(
          operation.source.path,
          signal,
        );
        if (detected.kind !== "directory")
          throw new DirectoryFailure(
            "git_source",
            `Use Git execution for this source: ${detected.path}`,
          );
        requireDisjoint(operation.source.path, context.root.path);
        input = await scanDirectory(operation.source.path, signal);
        if (!sameDirectoryState(input.state, operation.source))
          throw new DirectoryFailure(
            "directory_changed",
            "The original directory changed after its admitted inspection.",
          );
      } else {
        const binding =
          operation.type === "materialize-directory"
            ? operation.source.workspace
            : operation.source;
        await requireOwned(
          context,
          request,
          binding,
          operation.type === "materialize-directory" ? "snapshot" : "working",
        );
        if (operation.type === "materialize-directory")
          context.journal.requireDirectorySnapshot(
            operation.source,
            request.runId,
          );
        input = await scanDirectory(binding.path, signal);
        verifyDirectoryBinding(input.state, binding);
      }
      before = input.state;
      source = input.state;
      const path = destination(context.root.path, request);
      await createRunParent(context, request, path, signal);
      inventory = await copyDirectory(input, path, signal, fence);
      after = inventory.state;
      if (
        operation.type === "capture-source" &&
        (await inspectProjectSource(input.state.path, signal)).kind !==
          "directory"
      )
        throw new DirectoryFailure(
          "git_source",
          `Source became a Git workspace during capture: ${input.state.path}`,
        );
      const originalPath =
        operation.type === "capture-source"
          ? operation.source.path
          : operation.type === "materialize-directory"
            ? operation.source.workspace.originalPath
            : operation.source.originalPath;
      const workspace: DirectoryBinding = {
        kind: "directory",
        path: after.path,
        rootIdentity: after.rootIdentity,
        workspaceId: operation.workspaceId,
        originalPath,
        expectedManifestDigest: after.manifestDigest,
      };
      artifact =
        operation.type === "materialize-directory"
          ? {
              kind: "working",
              workspace,
              sourceSnapshotId: operation.source.snapshotId,
            }
          : {
              kind: "snapshot",
              snapshot: {
                kind: "directory-snapshot",
                snapshotId: `snapshot_${segment(`${request.runId}:${request.effectId}`)}`,
                workspace,
                manifestDigest: after.manifestDigest,
              },
            };
    }
    signal.throwIfAborted();
    context.journal.assertDirectoryFence(request);
  } catch (error) {
    if (
      error instanceof NativeOutcomeUnknown ||
      error instanceof NativeJournalStateError
    ) {
      context.journal.uncertain(request.effectId);
      return;
    }
    artifact = null;
    errorCode =
      error instanceof DirectoryFailure
        ? error.code
        : signal.aborted
          ? "interrupted"
          : "io_error";
    outcome =
      errorCode === "directory_changed" ||
      (error instanceof DirectoryFailure &&
        !["interrupted", "process_failed", "io_error"].includes(errorCode))
        ? "invalid"
        : errorCode === "interrupted"
          ? "interrupted"
          : mutationStarted || errorCode === "process_failed"
            ? "failed"
            : "invalid";
    reason = error instanceof Error ? error.message : String(error);
  }
  const receipt = directoryEffectReceiptSchema.parse({
    kind: "directory",
    operationType: request.operation.type,
    outcome,
    errorCode,
    reason,
    before,
    after,
    source,
    processes,
    artifact,
    finishedAt: new Date().toISOString(),
  });
  if (
    outcome === "succeeded" &&
    inventory &&
    (artifact?.kind === "snapshot" || artifact?.kind === "working")
  )
    context.journal.finishDirectoryWorkspace(
      request.effectId,
      receipt,
      inventory,
    );
  else context.journal.finishDirectory(request.effectId, receipt);
}

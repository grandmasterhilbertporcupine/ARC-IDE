import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  hostEffectRequestSchema,
  type HostEffectIdentity,
  type HostEffectRecord,
  type HostEffectRequest,
  type HostEffectReceipt,
  type HostWorkspaceBinding,
  type HostWorkspaceState,
  type HostProcessReceipt,
} from "../host-contract.js";
import {
  canonicalPath,
  containedPath,
  git,
  inspectWorkspace,
  samePath,
  sameState,
  verifyBinding,
} from "./git.js";
import { HostJournal, NativeJournalStateError } from "./journal.js";
import { NativeOutcomeUnknown, runNativeProcess } from "./process.js";
import {
  directoryEffectRequestSchema,
  directoryEffectIdentitySchema,
  type DirectoryEffectRequest,
  type DirectoryEffectIdentity,
  type DirectoryEffectRecord,
  type DirectoryRoot,
} from "../host-directory-contract.js";
import { inspectDirectoryRoot, inspectProjectSource } from "./directory.js";
import {
  directoryAdmission,
  executeDirectoryEffect,
} from "./directory-effects.js";
import { directoryEffectRequestHash } from "./hash.js";

const segment = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);
const inspectionSignal = () => AbortSignal.timeout(30_000);

class NativeCandidateChanged extends Error {}

export class NativeEffects {
  private readonly active = new Map<
    string,
    { abort: AbortController; completion: Promise<void> }
  >();
  private closed = false;

  private constructor(
    private readonly journal: HostJournal,
    private readonly worktrees: string,
    private readonly directoryRoot: DirectoryRoot,
  ) {}

  static async open(dataDir: string): Promise<NativeEffects> {
    await mkdir(dataDir, { recursive: true });
    dataDir = await canonicalPath(dataDir);
    const worktrees = join(dataDir, "worktrees");
    await mkdir(worktrees, { recursive: true });
    const directories = join(dataDir, "directories");
    await mkdir(directories, { recursive: true });
    return new NativeEffects(
      new HostJournal(join(dataDir, "native-effects.sqlite")),
      await canonicalPath(worktrees),
      await inspectDirectoryRoot(directories),
    );
  }

  async inspectProjectSource(path: string, signal: AbortSignal) {
    if (this.closed) throw new Error("Native effects are disposed.");
    return inspectProjectSource(path, signal);
  }

  async startDirectory(
    request: DirectoryEffectRequest,
    retain: () => { dispose(): Promise<void> } = () => ({ async dispose() {} }),
    admissionSignal?: AbortSignal,
  ): Promise<DirectoryEffectRecord> {
    if (this.closed) throw new Error("Native effects are disposed.");
    request = directoryEffectRequestSchema.parse(request);
    admissionSignal?.throwIfAborted();
    const admitted = directoryAdmission(
      { journal: this.journal, root: this.directoryRoot },
      request,
    );
    if (!admitted.created) return admitted.record;
    const abort = new AbortController();
    let lease: ReturnType<typeof retain>;
    try {
      lease = retain();
    } catch (error) {
      this.journal.uncertain(request.effectId);
      if (request.operation.type === "scan-directory")
        this.journal.finishStoppedDirectoryScan(
          {
            runId: request.runId,
            effectId: request.effectId,
            requestHash: directoryEffectRequestHash(request),
          },
          process.pid,
        );
      throw error;
    }
    const completion = Promise.resolve().then(async () => {
      try {
        await executeDirectoryEffect(
          { journal: this.journal, root: this.directoryRoot },
          request,
          abort.signal,
        );
      } catch {
        this.journal.uncertain(request.effectId);
      } finally {
        this.active.delete(request.effectId);
        if (request.operation.type === "scan-directory")
          this.journal.finishStoppedDirectoryScan(
            {
              runId: request.runId,
              effectId: request.effectId,
              requestHash: directoryEffectRequestHash(request),
            },
            process.pid,
          );
        await lease.dispose();
      }
    });
    this.active.set(request.effectId, { abort, completion });
    return admitted.record;
  }

  async observeDirectory(
    identity: DirectoryEffectIdentity,
  ): Promise<DirectoryEffectRecord | null> {
    if (this.closed) throw new Error("Native effects are disposed.");
    return this.journal.identifyDirectory(
      directoryEffectIdentitySchema.parse(identity),
    );
  }

  async interruptDirectory(
    identity: DirectoryEffectIdentity,
  ): Promise<DirectoryEffectRecord | null> {
    const record = await this.observeDirectory(identity);
    if (!record || record.state === "terminal") return record;
    const active = this.active.get(identity.effectId);
    if (active) {
      active.abort.abort();
      return record;
    }
    const ownerPid = this.journal.directoryScanOwner(identity);
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ESRCH"
        )
          this.journal.finishStoppedDirectoryScan(identity, ownerPid);
      }
    }
    return this.journal.identifyDirectory(identity);
  }

  async inspect(
    path: string,
    expected: HostWorkspaceBinding | null,
    signal: AbortSignal,
  ): Promise<HostWorkspaceState> {
    const state = await inspectWorkspace(path, signal);
    if (expected !== null) await verifyBinding(state, expected, signal);
    return state;
  }

  private destination(request: HostEffectRequest): string {
    if (
      request.operation.type !== "prepare-worktree" &&
      request.operation.type !== "fork-worktree"
    )
      throw new Error("Expected a worktree creation effect.");
    return containedPath(
      this.worktrees,
      join(
        this.worktrees,
        segment(request.runId),
        segment(request.operation.workspaceId),
      ),
    );
  }

  async start(
    request: HostEffectRequest,
    retain: () => { dispose(): Promise<void> } = () => ({ async dispose() {} }),
    admissionSignal?: AbortSignal,
  ): Promise<HostEffectRecord> {
    if (this.closed) throw new Error("Native effects are disposed.");
    request = hostEffectRequestSchema.parse(request);
    const resource =
      request.operation.type === "prepare-worktree" ||
      request.operation.type === "fork-worktree"
        ? this.destination(request)
        : await canonicalPath(request.workspace.path);
    admissionSignal?.throwIfAborted();
    const admitted = this.journal.admit(
      request,
      process.platform === "win32" ? resource.toLowerCase() : resource,
    );
    if (!admitted.created)
      return (
        (await this.observe({
          runId: request.runId,
          effectId: request.effectId,
          requestHash: admitted.record.requestHash,
        })) ?? admitted.record
      );
    const abort = new AbortController();
    let lease: ReturnType<typeof retain>;
    try {
      lease = retain();
    } catch (error) {
      this.journal.uncertain(request.effectId);
      throw error;
    }
    const completion = Promise.resolve().then(async () => {
      try {
        await this.execute(request, abort.signal);
      } catch {
        this.journal.uncertain(request.effectId);
      } finally {
        this.active.delete(request.effectId);
        await lease.dispose();
      }
    });
    this.active.set(request.effectId, { abort, completion });
    return admitted.record;
  }

  async observe(
    identity: HostEffectIdentity,
  ): Promise<HostEffectRecord | null> {
    const record = this.journal.identify(identity);
    if (!record?.receipt) return record;
    const checkedAt = new Date().toISOString();
    const expected = record.receipt.after;
    if (!expected)
      return {
        ...record,
        receiptValidity: {
          status: "unavailable",
          reason:
            "The historical effect has no observed final workspace state.",
          checkedAt,
          currentState: null,
        },
      };
    try {
      const currentState = await inspectWorkspace(
        expected.path,
        inspectionSignal(),
      );
      let current = sameState(expected, currentState);
      const request = this.journal.request(identity.effectId);
      if (
        current &&
        (request.operation.type === "fork-worktree" ||
          request.operation.type === "merge-candidate")
      )
        current =
          currentState.clean &&
          currentState.currentBranch === null &&
          samePath(expected.topLevel, currentState.topLevel);
      if (
        current &&
        (request.operation.type === "integrate" ||
          request.operation.type === "merge-candidate" ||
          request.operation.type === "fork-worktree") &&
        record.receipt.source
      ) {
        const currentSource = await inspectWorkspace(
          record.receipt.source.path,
          inspectionSignal(),
        );
        current =
          sameState(record.receipt.source, currentSource) &&
          ((request.operation.type !== "fork-worktree" &&
            request.operation.type !== "merge-candidate") ||
            (currentSource.clean &&
              currentSource.currentBranch === null &&
              samePath(
                record.receipt.source.topLevel,
                currentSource.topLevel,
              )));
      }
      return {
        ...record,
        receiptValidity: {
          status: current ? "current" : "stale",
          reason: current
            ? null
            : "Workspace or source revision changed after the retained receipt.",
          checkedAt,
          currentState,
        },
      };
    } catch (error) {
      return {
        ...record,
        receiptValidity: {
          status: "unavailable",
          reason: String(error),
          checkedAt,
          currentState: null,
        },
      };
    }
  }

  async interrupt(
    identity: HostEffectIdentity,
  ): Promise<HostEffectRecord | null> {
    const record = this.journal.identify(identity);
    if (record?.state === "running")
      this.active.get(identity.effectId)?.abort.abort();
    return record;
  }

  private async requireOwned(
    state: HostWorkspaceState,
    binding: HostWorkspaceBinding,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await verifyBinding(state, binding, signal);
    const original = await canonicalPath(binding.originalPath);
    if (
      samePath(state.path, original) ||
      samePath(state.gitDir, state.commonGitDir)
    )
      throw new Error(
        "Native mutations require an isolated linked worktree, never the original checkout.",
      );
    if (state.currentBranch !== null)
      throw new Error("Run-owned worktrees must retain a detached HEAD.");
    containedPath(this.worktrees, state.path);
    this.journal.requireWorkspace(
      state.path,
      runId,
      state.commonGitDir,
      original,
    );
  }

  private async execute(
    request: HostEffectRequest,
    signal: AbortSignal,
  ): Promise<void> {
    let before: HostWorkspaceState | null = null;
    let after: HostWorkspaceState | null = null;
    let source: HostWorkspaceState | null = null;
    const processes: HostProcessReceipt[] = [];
    const artifact: HostEffectReceipt["artifact"] = {
      workspacePath: null,
      commitSha: null,
      treeSha: null,
    };
    let outcome: HostEffectReceipt["outcome"] = "succeeded";
    let reason: string | null = null;
    let effectPath =
      request.operation.type === "fork-worktree"
        ? this.destination(request)
        : request.workspace.path;
    let sideEffectStarted = false;
    const runGit = async (path: string, args: string[]) => {
      signal.throwIfAborted();
      this.journal.assertFence(request);
      sideEffectStarted = true;
      const receipt = await git(path, args, signal);
      processes.push(receipt);
      if (receipt.interrupted)
        throw new Error("Native operation was interrupted.");
      if (receipt.exitCode !== 0)
        throw new Error(
          `Git operation failed: ${receipt.stderr || receipt.stdout}`,
        );
      return receipt;
    };
    const commitCandidate = async (
      state: HostWorkspaceState,
      message: string,
      mergeSourceHead: string | null = null,
      expectedTree: string | null = null,
    ) => {
      const tree = await runGit(state.path, ["write-tree"]);
      const treeSha = tree.stdout.trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeSha))
        throw new Error("Git returned an invalid candidate tree identity.");
      if (expectedTree !== null && treeSha !== expectedTree)
        throw new NativeCandidateChanged(
          "The merged index changed before its commit was created.",
        );
      const commit = await runGit(state.path, [
        "commit-tree",
        treeSha,
        "-p",
        state.head,
        ...(mergeSourceHead !== null && mergeSourceHead !== state.head
          ? ["-p", mergeSourceHead]
          : []),
        "-m",
        message,
      ]);
      const commitSha = commit.stdout.trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commitSha))
        throw new Error("Git returned an invalid candidate commit identity.");
      artifact.commitSha = commitSha;
      artifact.treeSha = treeSha;
      await runGit(state.path, [
        "update-ref",
        ...(mergeSourceHead !== null ? ["--no-deref"] : []),
        "HEAD",
        commitSha,
        state.head,
      ]);
    };
    try {
      signal.throwIfAborted();
      this.journal.assertFence(request);
      before = await inspectWorkspace(request.workspace.path, signal);
      await verifyBinding(before, request.workspace, signal);
      if (request.operation.type === "prepare-worktree") {
        const original = await canonicalPath(request.workspace.originalPath);
        if (!samePath(before.path, original))
          throw new Error(
            "Worktree preparation must identify the original checkout as its read-only source.",
          );
        for (const [role, variable] of [
          ["author", "GIT_AUTHOR"],
          ["committer", "GIT_COMMITTER"],
        ]) {
          const identity = await git(
            before.path,
            ["var", `${variable}_IDENT`],
            signal,
          );
          processes.push(identity);
          if (identity.interrupted)
            throw new Error(
              `Git ${role} identity verification was interrupted before agent work started. Try starting the run again.`,
            );
          if (identity.exitCode !== 0 || identity.truncated)
            throw new Error(
              `Git ${role} identity could not be verified before agent work started. Configure user.name and user.email for this project, or correct ${variable}_NAME and ${variable}_EMAIL in the host environment, then start a new run. ${identity.stderr.trim().slice(0, 4096)}`,
            );
        }
        effectPath = this.destination(request);
        const parent = join(this.worktrees, segment(request.runId));
        await mkdir(parent, { recursive: true });
        if (!samePath(parent, await canonicalPath(parent)))
          throw new Error("Run workspace parent was redirected.");
        const exists = await lstat(effectPath).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists)
          throw new Error(
            "Worktree preparation will not reuse or overwrite an existing path.",
          );
        this.journal.reserveWorkspace(
          effectPath,
          request.runId,
          before.commonGitDir,
          original,
        );
        await runGit(before.path, [
          "worktree",
          "add",
          "--detach",
          effectPath,
          before.head,
        ]);
        after = await inspectWorkspace(effectPath, signal);
        if (
          !samePath(after.commonGitDir, before.commonGitDir) ||
          after.head !== before.head ||
          !after.clean ||
          after.currentBranch !== null
        )
          throw new Error(
            "Prepared worktree does not match the exact detached source revision.",
          );
        this.journal.readyWorkspace(after.path);
        artifact.workspacePath = after.path;
        artifact.commitSha = after.head;
      } else if (request.operation.type === "fork-worktree") {
        await this.requireOwned(
          before,
          request.workspace,
          request.runId,
          signal,
        );
        if (
          !before.clean ||
          !samePath(before.path, request.workspace.path) ||
          !samePath(before.commonGitDir, request.workspace.commonGitDir)
        )
          throw new Error(
            "Worktree fork requires a clean canonical source without redirection.",
          );
        containedPath(before.commonGitDir, before.gitDir);
        source = before;
        const original = await canonicalPath(request.workspace.originalPath);
        const parent = join(this.worktrees, segment(request.runId));
        await mkdir(parent, { recursive: true });
        if (!samePath(parent, await canonicalPath(parent)))
          throw new Error("Run workspace parent was redirected.");
        const exists = await lstat(effectPath).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists)
          throw new Error(
            "Worktree fork will not reuse or overwrite an existing path.",
          );
        this.journal.reserveWorkspace(
          effectPath,
          request.runId,
          source.commonGitDir,
          original,
        );
        const rechecked = await inspectWorkspace(source.path, signal);
        await this.requireOwned(
          rechecked,
          request.workspace,
          request.runId,
          signal,
        );
        if (!sameState(source, rechecked) || !rechecked.clean)
          throw new NativeCandidateChanged(
            "Worktree fork source changed before creation.",
          );
        await runGit(source.path, [
          "worktree",
          "add",
          "--detach",
          effectPath,
          source.head,
        ]);
        artifact.workspacePath = effectPath;
        artifact.commitSha = source.head;
        after = await inspectWorkspace(effectPath, inspectionSignal());
        if (
          !samePath(after.path, effectPath) ||
          !samePath(after.topLevel, effectPath) ||
          !samePath(after.commonGitDir, source.commonGitDir) ||
          samePath(after.gitDir, source.gitDir) ||
          samePath(after.gitDir, after.commonGitDir) ||
          after.head !== source.head ||
          after.stateDigest !== source.stateDigest ||
          !after.clean ||
          after.currentBranch !== null
        )
          throw new NativeCandidateChanged(
            "Forked worktree does not match the exact detached source candidate.",
          );
        containedPath(after.commonGitDir, after.gitDir);
        const retainedSource = await inspectWorkspace(
          source.path,
          inspectionSignal(),
        );
        if (
          !sameState(source, retainedSource) ||
          !samePath(source.topLevel, retainedSource.topLevel) ||
          retainedSource.currentBranch !== null ||
          !retainedSource.clean
        )
          throw new NativeCandidateChanged(
            "Worktree fork source changed during creation.",
          );
        await this.requireOwned(
          retainedSource,
          request.workspace,
          request.runId,
          inspectionSignal(),
        );
      } else if (request.operation.type === "snapshot") {
        after = before;
      } else {
        await this.requireOwned(
          before,
          request.workspace,
          request.runId,
          signal,
        );
        artifact.workspacePath = before.path;
        if (request.operation.type === "commit") {
          await runGit(before.path, ["add", "--all", "--", "."]);
          const staged = await inspectWorkspace(before.path, signal);
          if (
            staged.head !== before.head ||
            staged.contentDigest !== before.contentDigest
          )
            throw new Error("Workspace content or HEAD moved before commit.");
          await commitCandidate(before, request.operation.message);
        } else if (request.operation.type === "integrate") {
          if (!before.clean)
            throw new Error("Integration requires a clean candidate worktree.");
          source = await inspectWorkspace(
            request.operation.source.path,
            signal,
          );
          await this.requireOwned(
            source,
            request.operation.source,
            request.runId,
            signal,
          );
          if (
            !source.clean ||
            !samePath(source.commonGitDir, before.commonGitDir) ||
            samePath(source.path, before.path)
          )
            throw new Error(
              "Integration source must be a separate clean worktree in the same repository.",
            );
          await runGit(before.path, [
            "cherry-pick",
            "--no-commit",
            source.head,
          ]);
          await commitCandidate(before, `Integrate ARC work ${source.head}`);
        } else if (request.operation.type === "merge-candidate") {
          if (
            !before.clean ||
            !samePath(before.path, request.workspace.path) ||
            !samePath(before.commonGitDir, request.workspace.commonGitDir)
          )
            throw new Error(
              "Candidate merge requires a clean canonical target without redirection.",
            );
          source = await inspectWorkspace(
            request.operation.source.path,
            signal,
          );
          await this.requireOwned(
            source,
            request.operation.source,
            request.runId,
            signal,
          );
          if (
            !source.clean ||
            !samePath(source.path, request.operation.source.path) ||
            !samePath(
              source.commonGitDir,
              request.operation.source.commonGitDir,
            ) ||
            !samePath(source.commonGitDir, before.commonGitDir) ||
            samePath(source.path, before.path)
          )
            throw new Error(
              "Candidate merge source must be a separate clean canonical worktree in the same repository.",
            );
          containedPath(before.commonGitDir, before.gitDir);
          containedPath(source.commonGitDir, source.gitDir);
          const merged = await runGit(before.path, [
            "merge-tree",
            "--write-tree",
            before.head,
            source.head,
          ]);
          const mergedTree = merged.stdout.trim();
          if (
            merged.truncated ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(mergedTree)
          )
            throw new Error(
              "Git returned an invalid or truncated merged tree identity.",
            );
          const retainedTarget = await inspectWorkspace(before.path, signal);
          const retainedSource = await inspectWorkspace(source.path, signal);
          if (
            !sameState(before, retainedTarget) ||
            !sameState(source, retainedSource) ||
            !retainedTarget.clean ||
            !retainedSource.clean ||
            retainedTarget.currentBranch !== null ||
            retainedSource.currentBranch !== null
          )
            throw new NativeCandidateChanged(
              "The source or target changed while the merge was computed.",
            );
          await runGit(before.path, [
            "read-tree",
            "-m",
            "-u",
            before.head,
            mergedTree,
          ]);
          await commitCandidate(
            before,
            `Merge ARC candidate ${source.head}`,
            source.head,
            mergedTree,
          );
        } else {
          if (!before.clean)
            throw new Error("Checks require a clean committed candidate.");
          this.journal.assertFence(request);
          sideEffectStarted = true;
          const receipt = await runNativeProcess({
            executable: request.operation.executable,
            args: request.operation.args,
            timeoutMs: request.operation.timeoutMs,
            cwd: before.path,
            signal,
          });
          processes.push(receipt);
          if (receipt.interrupted) {
            outcome = "interrupted";
            reason = "Native check was interrupted or exceeded its time limit.";
          } else if (receipt.exitCode !== 0) {
            outcome = "failed";
            reason = "Native check exited unsuccessfully.";
          }
        }
        after = await inspectWorkspace(before.path, inspectionSignal());
        if (
          request.operation.type === "check" &&
          (!after.clean || !sameState(before, after))
        ) {
          outcome = "invalid";
          reason = "The candidate changed while the native check ran.";
        }
        if (
          (request.operation.type === "commit" ||
            request.operation.type === "integrate" ||
            request.operation.type === "merge-candidate") &&
          (!after.clean ||
            after.head !== artifact.commitSha ||
            !samePath(after.path, before.path) ||
            !samePath(after.topLevel, before.topLevel) ||
            !samePath(after.gitDir, before.gitDir) ||
            !samePath(after.commonGitDir, before.commonGitDir) ||
            after.currentBranch !== null)
        )
          throw new NativeCandidateChanged(
            "The committed candidate or its worktree identity changed before verification.",
          );
        if (
          request.operation.type === "commit" &&
          before.contentDigest !== after.contentDigest
        )
          throw new NativeCandidateChanged(
            "Workspace content changed while its commit was created.",
          );
        if (source) {
          const retainedSource = await inspectWorkspace(
            source.path,
            inspectionSignal(),
          );
          if (
            !sameState(source, retainedSource) ||
            (request.operation.type === "merge-candidate" &&
              (!retainedSource.clean ||
                retainedSource.currentBranch !== null ||
                !samePath(source.topLevel, retainedSource.topLevel)))
          )
            throw new NativeCandidateChanged(
              "Integration source moved while the effect ran.",
            );
        }
        if (artifact.commitSha === null) artifact.commitSha = after.head;
      }
      if (after) {
        const tree = await git(
          after.path,
          ["rev-parse", "HEAD", "HEAD^{tree}"],
          inspectionSignal(),
        );
        if (tree.exitCode !== 0 || tree.truncated)
          throw new Error("Unable to retain the resulting Git tree identity.");
        const [verifiedHead, verifiedTree] = tree.stdout.trim().split(/\r?\n/u);
        if (
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(verifiedTree ?? "") ||
          verifiedHead !== after.head ||
          (artifact.treeSha !== null && verifiedTree !== artifact.treeSha)
        )
          throw new NativeCandidateChanged(
            "The candidate HEAD or tree changed before its receipt was retained.",
          );
        if (artifact.treeSha === null) artifact.treeSha = verifiedTree;
      }
    } catch (error) {
      if (
        error instanceof NativeOutcomeUnknown ||
        error instanceof NativeJournalStateError
      ) {
        this.journal.uncertain(request.effectId);
        return;
      }
      outcome =
        error instanceof NativeCandidateChanged
          ? "invalid"
          : signal.aborted || processes.some((receipt) => receipt.interrupted)
            ? "interrupted"
            : sideEffectStarted
              ? "failed"
              : "invalid";
      reason = error instanceof Error ? error.message : String(error);
      try {
        after = await inspectWorkspace(effectPath, inspectionSignal());
      } catch {
        after = null;
      }
      if (sideEffectStarted && after === null) {
        this.journal.uncertain(request.effectId);
        return;
      }
    }
    const receipt: HostEffectReceipt = {
      outcome,
      reason,
      before,
      after,
      source,
      processes,
      artifact,
      finishedAt: new Date().toISOString(),
    };
    if (
      request.operation.type === "fork-worktree" &&
      outcome === "succeeded" &&
      after
    )
      this.journal.finishWorkspace(request.effectId, receipt, after.path);
    else this.journal.finish(request.effectId, receipt);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.active.values()];
    for (const effect of active) effect.abort.abort();
    await Promise.allSettled(active.map((effect) => effect.completion));
    this.journal.close();
  }
}

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  hostEffectRequestSchema,
  type HostEffectRequest,
  type HostEffectRecord,
  type HostWorkspaceState,
} from "../host-contract.js";
import { NativeEffects } from "./effects.js";
import {
  canonicalPath,
  containedPath,
  gitInventory,
  inspectWorkspace,
  sameState,
} from "./git.js";
import { hostEffectRequestHash } from "./hash.js";
import { HostJournal } from "./journal.js";

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = "native-run";
let fixture: string;
let original: string;
let dataDir: string;
let engine: NativeEffects;
let base: HostWorkspaceState;
let sequence: number;

async function command(path: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", path, ...args], {
    windowsHide: true,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function request(
  state: HostWorkspaceState,
  operation: HostEffectRequest["operation"],
  effectId = `effect-${++sequence}`,
): HostEffectRequest {
  return {
    runId,
    effectId,
    workspace: {
      path: state.path,
      commonGitDir: state.commonGitDir,
      originalPath: original,
      expectedHead: state.head,
      expectedStateDigest: state.stateDigest,
    },
    lane: null,
    operation,
  };
}

async function settled(input: HostEffectRequest): Promise<HostEffectRecord> {
  const started = await engine.start(input);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await engine.observe({
      runId: input.runId,
      effectId: input.effectId,
      requestHash: started.requestHash,
    });
    if (result?.state !== "running") {
      if (!result) throw new Error("Effect disappeared.");
      return result;
    }
    await delay(25);
  }
  throw new Error("Effect did not settle.");
}

async function workspace(workspaceId: string): Promise<HostWorkspaceState> {
  const result = await settled(
    request(base, { type: "prepare-worktree", workspaceId }),
  );
  expect(result.state).toBe("terminal");
  expect(
    result.receipt?.outcome,
    result.receipt?.reason ?? "missing receipt",
  ).toBe("succeeded");
  const path = result.receipt?.artifact.workspacePath;
  if (!path) throw new Error("Prepared worktree path missing.");
  return await engine.inspect(path, null, AbortSignal.timeout(30_000));
}

async function commit(
  state: HostWorkspaceState,
  file: string,
  content: string,
): Promise<HostWorkspaceState> {
  await writeFile(join(state.path, file), content);
  state = await engine.inspect(state.path, null, AbortSignal.timeout(30_000));
  const result = await settled(
    request(state, { type: "commit", message: `Add ${file}` }),
  );
  expect(
    result.receipt?.outcome,
    result.receipt?.reason ?? "missing receipt",
  ).toBe("succeeded");
  if (!result.receipt?.after) throw new Error("Committed state missing.");
  return result.receipt.after;
}

function mergeRequest(
  target: HostWorkspaceState,
  source: HostWorkspaceState,
  fence = 1,
): HostEffectRequest {
  return {
    ...request(target, {
      type: "merge-candidate",
      source: request(source, { type: "snapshot" }).workspace,
    }),
    lane: { key: "candidate-merge-lane", fence },
  };
}

async function fork(
  source: HostWorkspaceState,
  workspaceId: string,
): Promise<HostWorkspaceState> {
  const result = await settled(
    request(source, { type: "fork-worktree", workspaceId }),
  );
  expect(
    result.receipt?.outcome,
    result.receipt?.reason ?? "missing receipt",
  ).toBe("succeeded");
  if (!result.receipt?.after) throw new Error("Fork state missing.");
  return result.receipt.after;
}

beforeEach(async () => {
  sequence = 0;
  fixture = await mkdtemp(join(tmpdir(), "ARC native O'Reilly Δ & "));
  original = join(fixture, "Original 東京");
  dataDir = join(fixture, "host-data");
  await mkdir(original);
  await command(original, ["init", "--initial-branch=main"]);
  await command(original, ["config", "user.name", "ARC Native Test Fixture"]);
  await command(original, [
    "config",
    "user.email",
    "arc-native-fixture@example.invalid",
  ]);
  await command(original, ["config", "commit.gpgsign", "false"]);
  await command(original, ["config", "core.autocrlf", "false"]);
  await writeFile(join(original, "base.txt"), "original file\n");
  await command(original, ["add", "."]);
  await command(original, ["commit", "-m", "Fixture base"]);
  original = await canonicalPath(original);
  engine = await NativeEffects.open(dataDir);
  base = await engine.inspect(original, null, AbortSignal.timeout(30_000));
});

afterEach(async () => {
  await engine?.dispose();
  if (fixture)
    await rm(
      containedPath(
        await canonicalPath(tmpdir()),
        await canonicalPath(fixture),
      ),
      { recursive: true, force: true },
    );
});

describe("ARC native effect journal and disposable Git execution", () => {
  test("V2 candidate merge preserves sequential writer and repair ancestry in a fresh integration workspace", async () => {
    const first = await commit(
      await workspace("merge-first"),
      "first.txt",
      "first writer\n",
    );
    const second = await commit(
      await fork(first, "merge-second"),
      "second.txt",
      "second writer\n",
    );
    const repaired = await commit(
      await fork(second, "merge-repair"),
      "repair.txt",
      "repair round\n",
    );
    const target = await workspace("merge-integration");
    const input = mergeRequest(target, repaired);
    const result = await settled(input);
    expect(
      result.receipt?.outcome,
      result.receipt?.reason ?? "missing receipt",
    ).toBe("succeeded");
    const after = result.receipt?.after;
    if (!after) throw new Error("Merge state missing.");
    expect(result.receiptValidity?.status).toBe("current");
    expect(result.receipt?.source).toEqual(repaired);
    expect(result.receipt?.before).toEqual(target);
    expect(
      await command(after.path, ["show", "-s", "--format=%P", "HEAD"]),
    ).toBe(`${target.head} ${repaired.head}`);
    for (const source of [first, second, repaired]) {
      await command(after.path, [
        "merge-base",
        "--is-ancestor",
        source.head,
        after.head,
      ]);
      expect(
        sameState(
          source,
          await engine.inspect(source.path, null, AbortSignal.timeout(30_000)),
        ),
      ).toBe(true);
    }
    expect(await readFile(join(after.path, "first.txt"), "utf8")).toBe(
      "first writer\n",
    );
    expect(await readFile(join(after.path, "second.txt"), "utf8")).toBe(
      "second writer\n",
    );
    expect(await readFile(join(after.path, "repair.txt"), "utf8")).toBe(
      "repair round\n",
    );
    expect(
      await command(after.path, ["show", "-s", "--format=%an <%ae>", "HEAD"]),
    ).toBe("ARC Native Test Fixture <arc-native-fixture@example.invalid>");
    expect((await engine.start(input)).receipt).toEqual(result.receipt);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
  }, 120_000);

  test("V2 candidate merge combines divergent descendants once and retains both histories across serial integration", async () => {
    const shared = await commit(
      await workspace("merge-shared"),
      "shared.txt",
      "shared ancestry\n",
    );
    const left = await commit(
      await fork(shared, "merge-left"),
      "left.txt",
      "left branch\n",
    );
    const right = await commit(
      await fork(shared, "merge-right"),
      "right.txt",
      "right branch\n",
    );
    const target = await workspace("merge-serial");
    const firstInput = mergeRequest(target, left);
    const first = await settled(firstInput);
    expect(
      first.receipt?.outcome,
      first.receipt?.reason ?? "missing receipt",
    ).toBe("succeeded");
    if (!first.receipt?.after) throw new Error("First merge state missing.");
    const second = await settled(mergeRequest(first.receipt.after, right, 2));
    expect(
      second.receipt?.outcome,
      second.receipt?.reason ?? "missing receipt",
    ).toBe("succeeded");
    if (!second.receipt?.after) throw new Error("Second merge state missing.");
    const after = second.receipt.after;
    for (const source of [shared, left, right])
      await command(after.path, [
        "merge-base",
        "--is-ancestor",
        source.head,
        after.head,
      ]);
    expect(
      await command(after.path, ["show", "-s", "--format=%P", "HEAD"]),
    ).toBe(`${first.receipt.after.head} ${right.head}`);
    expect(await command(after.path, ["ls-tree", "--name-only", "HEAD"])).toBe(
      "base.txt\nleft.txt\nright.txt\nshared.txt",
    );
    expect(await readFile(join(after.path, "shared.txt"), "utf8")).toBe(
      "shared ancestry\n",
    );
    expect(second.receiptValidity?.status).toBe("current");
    expect(
      (
        await engine.observe({
          runId,
          effectId: firstInput.effectId,
          requestHash: first.requestHash,
        })
      )?.receiptValidity?.status,
    ).toBe("stale");
    const ancestor = await settled(mergeRequest(after, shared, 3));
    expect(
      ancestor.receipt?.outcome,
      ancestor.receipt?.reason ?? "missing receipt",
    ).toBe("succeeded");
    expect(ancestor.receipt?.artifact.treeSha).toBe(
      second.receipt.artifact.treeSha,
    );
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 120_000);

  test("V2 candidate merge refuses real conflicts without changing either candidate or crediting a commit", async () => {
    const source = await commit(
      await workspace("merge-conflict-source"),
      "base.txt",
      "source replacement\n",
    );
    const target = await commit(
      await workspace("merge-conflict-target"),
      "base.txt",
      "target replacement\n",
    );
    const result = await settled(mergeRequest(target, source));
    expect(result.receipt?.outcome).toBe("failed");
    expect(result.receipt?.reason).toMatch(/CONFLICT/u);
    expect(result.receipt?.artifact.commitSha).toBeNull();
    expect(result.receipt?.processes).toHaveLength(1);
    expect(result.receipt?.processes[0].exitCode).not.toBe(0);
    expect(
      sameState(
        source,
        await engine.inspect(source.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    expect(
      sameState(
        target,
        await engine.inspect(target.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    expect(await readFile(join(target.path, "base.txt"), "utf8")).toBe(
      "target replacement\n",
    );
    expect(await command(target.path, ["status", "--porcelain"])).toBe("");
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 90_000);

  test("V2 candidate merge requires exact clean owned source and target bindings plus a lane before applying work", async () => {
    const source = await workspace("merge-bound-source");
    const target = await workspace("merge-bound-target");
    const input = mergeRequest(target, source);
    expect(
      hostEffectRequestSchema.safeParse({ ...input, lane: null }).success,
    ).toBe(false);
    expect(
      hostEffectRequestSchema.safeParse({
        ...input,
        workspace: { ...input.workspace, expectedStateDigest: null },
      }).success,
    ).toBe(false);
    if (input.operation.type !== "merge-candidate")
      throw new Error("Merge input missing.");
    expect(
      hostEffectRequestSchema.safeParse({
        ...input,
        operation: {
          ...input.operation,
          source: { ...input.operation.source, expectedStateDigest: null },
        },
      }).success,
    ).toBe(false);
    const originalTarget = await settled(mergeRequest(base, source));
    expect(originalTarget.receipt?.outcome).toBe("invalid");
    expect(originalTarget.receipt?.processes).toEqual([]);
    const originalSource = await settled(mergeRequest(target, base, 2));
    expect(originalSource.receipt?.outcome).toBe("invalid");
    expect(originalSource.receipt?.processes).toEqual([]);
    await writeFile(
      join(source.path, "uncommitted.txt"),
      "not a committed candidate\n",
    );
    const stale = await settled(mergeRequest(target, source, 3));
    expect(stale.receipt?.outcome).toBe("invalid");
    expect(stale.receipt?.processes).toEqual([]);
    const dirtySource = await engine.inspect(
      source.path,
      null,
      AbortSignal.timeout(30_000),
    );
    const dirty = await settled(mergeRequest(target, dirtySource, 4));
    expect(dirty.receipt?.outcome).toBe("invalid");
    expect(dirty.receipt?.processes).toEqual([]);
    expect(
      sameState(
        target,
        await engine.inspect(target.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 90_000);

  test("forks a failed candidate at its exact SHA and preserves that evidence through a fresh repair commit", async () => {
    const candidate = await commit(
      await workspace("fork-source"),
      "repair.txt",
      "broken\n",
    );
    const failed = await settled(
      request(candidate, {
        type: "check",
        executable: process.execPath,
        args: [
          "-e",
          "process.stderr.write('REPAIR_REQUIRED');process.exitCode=7",
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(failed.receipt?.outcome).toBe("failed");
    const input = request(candidate, {
      type: "fork-worktree",
      workspaceId: "repair-round-1",
    });
    const forked = await settled(input);
    expect(forked.receipt?.outcome, JSON.stringify(forked.receipt)).toBe(
      "succeeded",
    );
    const fork = forked.receipt!.after!;
    expect(fork.path).not.toBe(candidate.path);
    expect(fork.gitDir).not.toBe(candidate.gitDir);
    expect(fork.head).toBe(candidate.head);
    expect(fork.stateDigest).toBe(candidate.stateDigest);
    expect(fork.currentBranch).toBeNull();
    expect(fork.clean).toBe(true);
    expect(forked.receipt?.before).toEqual(candidate);
    expect(forked.receipt?.source).toEqual(candidate);
    expect(forked.receipt?.artifact).toEqual({
      workspacePath: fork.path,
      commitSha: candidate.head,
      treeSha: await command(candidate.path, ["rev-parse", "HEAD^{tree}"]),
    });
    expect((await engine.start(input)).receipt).toEqual(forked.receipt);
    await expect(
      engine.start({
        ...input,
        operation: { type: "fork-worktree", workspaceId: "changed-round" },
      }),
    ).rejects.toThrow(/hash/u);
    const repaired = await commit(fork, "repair.txt", "fixed\n");
    expect(repaired.head).not.toBe(candidate.head);
    expect(
      sameState(
        candidate,
        await engine.inspect(candidate.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    const retainedFailure = await engine.observe({
      runId,
      effectId: failed.effectId,
      requestHash: failed.requestHash,
    });
    expect(retainedFailure?.receipt).toEqual(failed.receipt);
    expect(retainedFailure?.receiptValidity?.status).toBe("current");
    const retainedFork = await engine.observe({
      runId,
      effectId: forked.effectId,
      requestHash: forked.requestHash,
    });
    expect(retainedFork?.receipt).toEqual(forked.receipt);
    expect(retainedFork?.receiptValidity?.status).toBe("stale");
    const next = await settled(
      request(repaired, {
        type: "fork-worktree",
        workspaceId: "repair-round-2",
      }),
    );
    expect(next.receipt?.outcome, JSON.stringify(next.receipt)).toBe(
      "succeeded",
    );
    expect(next.receipt?.after?.head).toBe(repaired.head);
    await command(next.receipt!.after!.path, [
      "switch",
      "-c",
      "attached-candidate",
    ]);
    expect(
      (
        await engine.observe({
          runId,
          effectId: next.effectId,
          requestHash: next.requestHash,
        })
      )?.receiptValidity?.status,
    ).toBe("stale");
    const refusedReuse = await settled(
      request(candidate, {
        type: "fork-worktree",
        workspaceId: "repair-round-1",
      }),
    );
    expect(refusedReuse.receipt?.outcome).toBe("invalid");
    expect(refusedReuse.receipt?.processes).toEqual([]);
    await engine.dispose();
    engine = await NativeEffects.open(dataDir);
    expect((await engine.start(input)).receipt).toEqual(forked.receipt);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
    expect(await readFile(join(candidate.path, "repair.txt"), "utf8")).toBe(
      "broken\n",
    );
  }, 120_000);

  test("rejects fork sources that are original, stale, dirty, foreign-run, foreign-journal or foreign-repository", async () => {
    const candidate = await workspace("fork-boundaries");
    const withoutDigest = request(candidate, {
      type: "fork-worktree",
      workspaceId: "missing-digest",
    });
    withoutDigest.workspace.expectedStateDigest = null;
    expect(hostEffectRequestSchema.safeParse(withoutDigest).success).toBe(
      false,
    );
    await expect(engine.start(withoutDigest)).rejects.toThrow(
      /exact observed/u,
    );
    const originalFork = await settled(
      request(base, { type: "fork-worktree", workspaceId: "original-refused" }),
    );
    expect(originalFork.receipt?.outcome).toBe("invalid");
    const legacy = await settled(
      request(candidate, {
        type: "prepare-worktree",
        workspaceId: "legacy-refused",
      }),
    );
    expect(legacy.receipt?.outcome).toBe("invalid");
    expect(legacy.receipt?.reason).toMatch(/original checkout/u);
    const foreignRun = await settled({
      ...request(candidate, {
        type: "fork-worktree",
        workspaceId: "foreign-run",
      }),
      runId: "another-run",
    });
    expect(foreignRun.receipt?.outcome).toBe("invalid");
    expect(foreignRun.receipt?.processes).toEqual([]);
    const otherEngine = await NativeEffects.open(
      join(fixture, "other-host-data"),
    );
    try {
      const other = request(candidate, {
        type: "fork-worktree",
        workspaceId: "foreign-journal",
      });
      const started = await otherEngine.start(other);
      let observed = started;
      const deadline = Date.now() + 30_000;
      while (observed.state === "running" && Date.now() < deadline) {
        await delay(25);
        observed = (await otherEngine.observe({
          runId,
          effectId: other.effectId,
          requestHash: started.requestHash,
        }))!;
      }
      expect(observed.receipt?.outcome).toBe("invalid");
      expect(observed.receipt?.processes).toEqual([]);
    } finally {
      await otherEngine.dispose();
    }
    const foreignOriginal = join(fixture, "Foreign repo");
    await command(original, [
      "clone",
      "--no-hardlinks",
      original,
      foreignOriginal,
    ]);
    const foreignRepo = request(candidate, {
      type: "fork-worktree",
      workspaceId: "foreign-repository",
    });
    foreignRepo.workspace.originalPath = foreignOriginal;
    expect((await settled(foreignRepo)).receipt?.outcome).toBe("invalid");
    await writeFile(join(candidate.path, "dirty.txt"), "uncommitted\n");
    const dirty = await engine.inspect(
      candidate.path,
      null,
      AbortSignal.timeout(30_000),
    );
    const dirtyFork = await settled(
      request(dirty, { type: "fork-worktree", workspaceId: "dirty-refused" }),
    );
    expect(dirtyFork.receipt?.outcome).toBe("invalid");
    expect(dirtyFork.receipt?.reason).toMatch(/clean/u);
    expect(dirtyFork.receipt?.processes).toEqual([]);
    await commit(dirty, "dirty.txt", "committed\n");
    const stale = await settled(
      request(candidate, {
        type: "fork-worktree",
        workspaceId: "stale-refused",
      }),
    );
    expect(stale.receipt?.outcome).toBe("invalid");
    expect(stale.receipt?.reason).toMatch(/HEAD moved/u);
    await command(candidate.path, ["switch", "-c", "attached-source"]);
    const attached = await engine.inspect(
      candidate.path,
      null,
      AbortSignal.timeout(30_000),
    );
    const attachedFork = await settled(
      request(attached, {
        type: "fork-worktree",
        workspaceId: "attached-refused",
      }),
    );
    expect(attachedFork.receipt?.outcome).toBe("invalid");
    expect(attachedFork.receipt?.reason).toMatch(/detached HEAD/u);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 120_000);

  test("rejects source redirection and an already-existing deterministic fork destination", async () => {
    const candidate = await workspace("fork-paths");
    const alias = join(fixture, "Redirected candidate");
    await symlink(
      candidate.path,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const redirected = request(candidate, {
      type: "fork-worktree",
      workspaceId: "redirect-refused",
    });
    redirected.workspace.path = alias;
    const refusal = await settled(redirected);
    expect(refusal.receipt?.outcome).toBe("invalid");
    expect(refusal.receipt?.reason).toMatch(/redirection/u);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 32);
    const destination = join(
      dataDir,
      "worktrees",
      digest(runId),
      digest("occupied-fork"),
    );
    await mkdir(destination);
    await writeFile(join(destination, "retained.txt"), "do not overwrite\n");
    const occupied = await settled(
      request(candidate, {
        type: "fork-worktree",
        workspaceId: "occupied-fork",
      }),
    );
    expect(occupied.receipt?.outcome).toBe("invalid");
    expect(occupied.receipt?.processes).toEqual([]);
    expect(await readFile(join(destination, "retained.txt"), "utf8")).toBe(
      "do not overwrite\n",
    );
    expect(
      sameState(
        candidate,
        await engine.inspect(candidate.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
  }, 90_000);

  test.each(["source", "destination"] as const)(
    "invalidates a real %s HEAD move during fork creation",
    async (moved) => {
      const candidate = await workspace(`fork-race-${moved}`);
      const tree = await command(candidate.path, ["rev-parse", "HEAD^{tree}"]);
      const otherHead = await command(candidate.path, [
        "commit-tree",
        tree,
        "-p",
        candidate.head,
        "-m",
        "Concurrent fork revision",
      ]);
      const quote = (value: string) =>
        `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
      const hooks = join(fixture, "fork-race-hooks");
      await mkdir(hooks);
      await writeFile(
        join(hooks, "post-checkout"),
        [
          "#!/bin/sh",
          moved === "source"
            ? `git --git-dir=${quote(candidate.gitDir)} update-ref HEAD ${otherHead} ${candidate.head}`
            : `git update-ref HEAD ${otherHead} ${candidate.head}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      await command(original, ["config", "core.hooksPath", hooks]);
      const input = request(candidate, {
        type: "fork-worktree",
        workspaceId: `raced-${moved}`,
      });
      const result = await settled(input);
      expect(result.receipt?.outcome, JSON.stringify(result.receipt)).toBe(
        "invalid",
      );
      expect(result.receipt?.reason).toMatch(/source|candidate/u);
      expect(result.receipt?.artifact.commitSha).toBe(candidate.head);
      expect(result.receipt?.after?.head).toBe(
        moved === "destination" ? otherHead : candidate.head,
      );
      expect(await command(candidate.path, ["rev-parse", "HEAD"])).toBe(
        moved === "source" ? otherHead : candidate.head,
      );
      expect((await engine.start(input)).receipt).toEqual(result.receipt);
      const rejectedChild = await settled(
        request(result.receipt!.after!, {
          type: "fork-worktree",
          workspaceId: "invalid-parent",
        }),
      );
      expect(rejectedChild.receipt?.outcome).toBe("invalid");
      expect(rejectedChild.receipt?.processes).toEqual([]);
      expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    },
    90_000,
  );

  test("retains an actual created fork with a missing crash-gap receipt as uncertain without replay or readiness", async () => {
    const candidate = await workspace("fork-crash-source");
    const input = request(candidate, {
      type: "fork-worktree",
      workspaceId: "fork-crash-destination",
    });
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 32);
    const destination = join(
      await canonicalPath(join(dataDir, "worktrees", digest(runId))),
      digest("fork-crash-destination"),
    );
    await engine.dispose();
    const journal = new HostJournal(join(dataDir, "native-effects.sqlite"));
    journal.admit(
      input,
      process.platform === "win32" ? destination.toLowerCase() : destination,
    );
    journal.reserveWorkspace(
      destination,
      runId,
      candidate.commonGitDir,
      original,
    );
    await command(candidate.path, [
      "worktree",
      "add",
      "--detach",
      destination,
      candidate.head,
    ]);
    const after = await inspectWorkspace(
      destination,
      AbortSignal.timeout(30_000),
    );
    journal.uncertain(input.effectId);
    expect(() =>
      journal.finishWorkspace(
        input.effectId,
        {
          outcome: "succeeded",
          reason: null,
          before: candidate,
          after,
          source: candidate,
          processes: [],
          artifact: {
            workspacePath: destination,
            commitSha: after.head,
            treeSha: null,
          },
          finishedAt: new Date().toISOString(),
        },
        destination,
      ),
    ).toThrow(/write authority/u);
    expect(() =>
      journal.requireWorkspace(
        destination,
        runId,
        candidate.commonGitDir,
        original,
      ),
    ).toThrow(/not a ready/u);
    journal.close();
    engine = await NativeEffects.open(dataDir);
    const replay = await engine.start(input);
    expect(replay.state).toBe("needs-reconciliation");
    expect(replay.receipt).toBeNull();
    expect(replay.requestHash).toBe(hostEffectRequestHash(input));
    await expect(
      engine.start(request(candidate, input.operation)),
    ).rejects.toThrow(/unreconciled/u);
    expect(
      sameState(
        after,
        await engine.inspect(destination, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    expect(
      sameState(
        candidate,
        await engine.inspect(candidate.path, null, AbortSignal.timeout(30_000)),
      ),
    ).toBe(true);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 90_000);

  test("creates exact detached Unicode worktrees, retains receipts and rejects changed requests", async () => {
    const input = request(base, {
      type: "prepare-worktree",
      workspaceId: "writer-white",
    });
    const created = await settled(input);
    expect(created.receipt?.after?.head).toBe(base.head);
    expect(created.receipt?.after?.currentBranch).toBeNull();
    expect(created.receipt?.after?.path).not.toBe(original);
    const replay = await engine.start(input);
    expect(replay.receipt).toEqual(created.receipt);
    expect(replay.receiptValidity?.status).toBe("current");
    const prepared = created.receipt?.after;
    if (!prepared) throw new Error("Prepared state missing.");
    await expect(
      engine.inspect(
        prepared.path,
        {
          ...request(prepared, { type: "snapshot" }).workspace,
          originalPath: dataDir,
        },
        AbortSignal.timeout(30_000),
      ),
    ).rejects.toThrow(/Git inspection failed/u);
    await expect(
      engine.start({
        ...input,
        operation: { type: "prepare-worktree", workspaceId: "changed" },
      }),
    ).rejects.toThrow(/hash/u);
    await engine.dispose();
    engine = await NativeEffects.open(dataDir);
    expect((await engine.start(input)).receipt).toEqual(created.receipt);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
    expect(await readFile(join(original, "base.txt"), "utf8")).toBe(
      "original file\n",
    );
  }, 60_000);

  test("commits two writers and serially integrates SHA-bound candidates without changing the original", async () => {
    const white = await commit(
      await workspace("white"),
      "frontend.txt",
      "frontend\n",
    );
    const blue = await commit(
      await workspace("blue"),
      "backend.txt",
      "backend\n",
    );
    let candidate = await workspace("integration");
    for (const [index, source] of [white, blue].entries()) {
      const input = request(candidate, {
        type: "integrate",
        source: request(source, { type: "snapshot" }).workspace,
      });
      input.lane = { key: "integration-lane", fence: index + 1 };
      const result = await settled(input);
      expect(
        result.receipt?.outcome,
        result.receipt?.reason ?? "missing receipt",
      ).toBe("succeeded");
      expect(await command(candidate.path, ["rev-parse", "HEAD^"])).toBe(
        candidate.head,
      );
      candidate = result.receipt!.after!;
    }
    const check = await settled(
      request(candidate, {
        type: "check",
        executable: process.execPath,
        args: [
          "-e",
          "const fs=require('node:fs');const files=[fs.readFileSync('frontend.txt','utf8'),fs.readFileSync('backend.txt','utf8')];if(files[0]!=='frontend\\n'||files[1]!=='backend\\n'){process.stderr.write(JSON.stringify(files));process.exit(9);}process.stdout.write('NATIVE_JOIN_OK')",
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(check.receipt?.outcome, JSON.stringify(check.receipt)).toBe(
      "succeeded",
    );
    expect(check.receipt?.processes[0]?.stdout).toBe("NATIVE_JOIN_OK");
    expect(check.receiptValidity?.status).toBe("current");
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
    await expect(access(join(original, "frontend.txt"))).rejects.toThrow();
  }, 120_000);

  test("rejects stale file state and original checkout mutation before dispatch", async () => {
    const writer = await workspace("writer");
    const cancelled = request(writer, { type: "snapshot" });
    await expect(
      engine.start(cancelled, undefined, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(
      await engine.observe({
        runId,
        effectId: cancelled.effectId,
        requestHash: hostEffectRequestHash(cancelled),
      }),
    ).toBeNull();
    await writeFile(join(writer.path, "new.txt"), "changed after snapshot");
    const stale = await settled(
      request(writer, { type: "commit", message: "Must not commit" }),
    );
    expect(stale.receipt?.outcome).toBe("invalid");
    expect(stale.receipt?.processes).toEqual([]);
    const refused = await settled(
      request(base, { type: "commit", message: "Must not change original" }),
    );
    expect(refused.receipt?.outcome).toBe("invalid");
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
  }, 60_000);

  test("retains its own commit identity and invalidates an actual same-tree HEAD move after CAS", async () => {
    const writer = await workspace("post-cas-race");
    const tree = await command(writer.path, ["rev-parse", "HEAD^{tree}"]);
    const foreignCommit = await command(writer.path, [
      "commit-tree",
      tree,
      "-p",
      writer.head,
      "-m",
      "Concurrent external revision",
    ]);
    const hooks = join(fixture, "race-hooks");
    await mkdir(hooks);
    await writeFile(
      join(hooks, "reference-transaction"),
      [
        "#!/bin/sh",
        'if test "$1" != "committed" || test "$ARC_RACE_SKIP" = "1"; then exit 0; fi',
        "while read old new ref; do",
        '  if test "$ref" = "HEAD"; then',
        `    ARC_RACE_SKIP=1 git update-ref HEAD ${foreignCommit} "$new" || exit 1`,
        "  fi",
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await command(original, ["config", "core.hooksPath", hooks]);
    const result = await settled(
      request(writer, { type: "commit", message: "ARC no-op writer" }),
    );
    const created = result.receipt?.processes
      .find((value) => value.args.includes("commit-tree"))
      ?.stdout.trim();
    expect(result.receipt?.outcome, JSON.stringify(result.receipt)).toBe(
      "invalid",
    );
    expect(result.receipt?.reason).toMatch(/candidate|identity/u);
    expect(created).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
    expect(created).not.toBe(foreignCommit);
    expect(result.receipt?.artifact.commitSha).toBe(created);
    expect(result.receipt?.artifact.treeSha).toBe(tree);
    expect(result.receipt?.after?.head).toBe(foreignCommit);
    expect(result.receipt?.after?.clean).toBe(true);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  test("retains failed native output, validates bounded digests and detects candidate mutation", async () => {
    const candidate = await workspace("checks");
    const failure = await settled(
      request(candidate, {
        type: "check",
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('x'.repeat(100000));process.stderr.write('ACTUAL_FAILURE');process.exitCode=7",
        ],
        timeoutMs: 10_000,
      }),
    );
    const processReceipt = failure.receipt?.processes[0];
    expect(failure.receipt?.outcome).toBe("failed");
    expect(processReceipt?.exitCode).toBe(7);
    expect(processReceipt?.stdout).toHaveLength(65_536);
    expect(processReceipt?.stdoutBytes).toBe(100_000);
    expect(processReceipt?.stdoutDigest).toBe(
      createHash("sha256").update("x".repeat(100_000)).digest("hex"),
    );
    expect(processReceipt?.truncated).toBe(true);
    const mutate = await settled(
      request(candidate, {
        type: "check",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('base.txt','check changed source')",
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(mutate.receipt?.outcome).toBe("invalid");
    const observed = await engine.observe({
      runId,
      effectId: failure.effectId,
      requestHash: failure.requestHash,
    });
    expect(observed?.receipt).toEqual(failure.receipt);
    expect(observed?.receiptValidity?.status).toBe("stale");
  }, 60_000);

  test("inspects six thousand real paths beyond the public output cap and refuses truncated inventories", async () => {
    const writer = await workspace("large-inventory");
    const files = Array.from(
      { length: 6000 },
      (_, index) =>
        `inventory-${String(index).padStart(4, "0")}-東京-${"x".repeat(32)}.txt`,
    );
    for (let index = 0; index < files.length; index += 64)
      await Promise.all(
        files
          .slice(index, index + 64)
          .map((file) => writeFile(join(writer.path, file), "inventory\n")),
      );
    await command(writer.path, ["add", "--all"]);
    await expect(
      gitInventory(
        writer.path,
        ["ls-files", "-z"],
        AbortSignal.timeout(30_000),
        65_536,
      ),
    ).rejects.toThrow("65536-byte inspection limit");
    const inventory = await gitInventory(
      writer.path,
      ["ls-files", "-z"],
      AbortSignal.timeout(30_000),
    );
    expect(inventory.stdoutBytes).toBeGreaterThan(65_536);
    expect(inventory.truncated).toBe(false);
    expect(inventory.stdout.split("\0").filter(Boolean)).toHaveLength(6001);
    const initial = await engine.inspect(
      writer.path,
      null,
      AbortSignal.timeout(90_000),
    );
    expect(initial.clean).toBe(false);
    await writeFile(
      join(writer.path, files[files.length - 1]),
      "changed tail\n",
    );
    const changed = await engine.inspect(
      writer.path,
      null,
      AbortSignal.timeout(90_000),
    );
    expect(changed.head).toBe(initial.head);
    expect(changed.contentDigest).not.toBe(initial.contentDigest);
    expect(changed.stateDigest).not.toBe(initial.stateDigest);
    expect(await command(original, ["rev-parse", "HEAD"])).toBe(base.head);
    expect(await command(original, ["status", "--porcelain"])).toBe("");
  }, 180_000);

  test("does not execute a check against a moved HEAD", async () => {
    const initial = await workspace("moved");
    await commit(initial, "later.txt", "new revision");
    const marker = join(fixture, "should-not-exist");
    const result = await settled(
      request(initial, {
        type: "check",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1],'started')",
          marker,
        ],
        timeoutMs: 10_000,
      }),
    );
    expect(result.receipt?.outcome).toBe("invalid");
    expect(result.receipt?.reason).toMatch(/HEAD moved/u);
    expect(result.receipt?.processes).toEqual([]);
    await expect(access(marker)).rejects.toThrow();
  }, 60_000);

  test("fences active work and interrupts its actual process tree before terminal status", async () => {
    const candidate = await workspace("interrupt");
    const other = await workspace("other");
    const marker = join(fixture, "native-processes.json");
    const code =
      "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000)";
    const input = request(candidate, {
      type: "check",
      executable: process.execPath,
      args: ["-e", code, marker],
      timeoutMs: 60_000,
    });
    input.lane = { key: "shared-lane", fence: 10 };
    const started = await engine.start(input);
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      !(await access(marker).then(
        () => true,
        () => false,
      ))
    )
      await delay(50);
    const ids = z
      .object({ pid: z.number(), child: z.number() })
      .parse(JSON.parse(await readFile(marker, "utf8")));
    const conflict = request(other, { type: "snapshot" });
    conflict.lane = { key: "shared-lane", fence: 11 };
    await expect(engine.start(conflict)).rejects.toThrow(/occupied/u);
    expect((await engine.start(input)).state).toBe("running");
    await engine.interrupt({
      runId,
      effectId: input.effectId,
      requestHash: started.requestHash,
    });
    const stopped = await settled(input);
    expect(stopped.receipt?.outcome).toBe("interrupted");
    expect(stopped.receipt?.processes[0]?.interrupted).toBe(true);
    expect(() => process.kill(ids.pid, 0)).toThrow();
    expect(() => process.kill(ids.child, 0)).toThrow();
    const staleFence = request(other, { type: "snapshot" });
    staleFence.lane = { key: "shared-lane", fence: 10 };
    await expect(engine.start(staleFence)).rejects.toThrow(/stale/u);
  }, 90_000);

  test("retains crash-gap intents as uncertain and never blindly replays them", async () => {
    const candidate = await workspace("crash");
    const marker = join(fixture, "must-not-replay");
    const input = request(candidate, {
      type: "check",
      executable: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');const path=process.argv[1];fs.writeFileSync(path,String((fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0)+1))",
        marker,
      ],
      timeoutMs: 10_000,
    });
    await engine.dispose();
    const journal = new HostJournal(join(dataDir, "native-effects.sqlite"));
    journal.admit(
      input,
      process.platform === "win32"
        ? candidate.path.toLowerCase()
        : candidate.path,
    );
    if (input.operation.type !== "check")
      throw new Error("Expected native crash probe.");
    await execFileAsync(input.operation.executable, input.operation.args, {
      cwd: candidate.path,
      windowsHide: true,
    });
    expect(await readFile(marker, "utf8")).toBe("1");
    journal.close();
    engine = await NativeEffects.open(dataDir);
    const replay = await engine.start(input);
    expect(replay.state).toBe("needs-reconciliation");
    expect(replay.receipt).toBeNull();
    expect(replay.requestHash).toBe(hostEffectRequestHash(input));
    await expect(
      engine.start(request(candidate, { type: "snapshot" })),
    ).rejects.toThrow(/unreconciled/u);
    expect(await readFile(marker, "utf8")).toBe("1");
  }, 60_000);

  test("canonicalizes object keys and validates exact Git OID lengths", () => {
    const input = request(base, { type: "snapshot" });
    const reordered = {
      operation: input.operation,
      lane: input.lane,
      workspace: input.workspace,
      effectId: input.effectId,
      runId: input.runId,
    };
    expect(hostEffectRequestHash(reordered)).toBe(hostEffectRequestHash(input));
    expect(
      hostEffectRequestSchema.safeParse({
        ...input,
        workspace: { ...input.workspace, expectedHead: "a".repeat(41) },
      }).success,
    ).toBe(false);
    expect(
      hostEffectRequestSchema.safeParse({
        ...input,
        workspace: { ...input.workspace, expectedHead: "a".repeat(64) },
      }).success,
    ).toBe(true);
  });
});

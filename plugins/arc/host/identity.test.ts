import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  HostEffectRequest,
  HostWorkspaceState,
} from "../host-contract.js";
import { NativeEffects } from "./effects.js";
import { canonicalPath, containedPath, git } from "./git.js";
import { hostEffectRequestHash } from "./hash.js";

let fixture: string;
let source: string;
let globalConfig: string;
let engine: NativeEffects;
let initial: HostWorkspaceState;

async function command(path: string, args: string[]) {
  const result = await git(path, args, AbortSignal.timeout(30_000));
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function request(
  workspace: HostWorkspaceState,
  effectId = "identity-prepare",
  operation: HostEffectRequest["operation"] = {
    type: "prepare-worktree",
    workspaceId: "identity-worker",
  },
): HostEffectRequest {
  return {
    runId: "identity-run",
    effectId,
    workspace: {
      path: workspace.path,
      commonGitDir: workspace.commonGitDir,
      originalPath: source,
      expectedHead: workspace.head,
      expectedStateDigest: workspace.stateDigest,
    },
    lane: null,
    operation,
  };
}

async function settled(input: HostEffectRequest) {
  await engine.start(input);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await engine.observe({
      runId: input.runId,
      effectId: input.effectId,
      requestHash: hostEffectRequestHash(input),
    });
    if (result?.state === "terminal") return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Identity preflight did not settle");
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "ARC Git identity Δ "));
  source = join(fixture, "source");
  const isolatedHome = join(fixture, "home");
  await mkdir(source);
  await mkdir(isolatedHome);
  globalConfig = join(isolatedHome, "gitconfig");
  await writeFile(globalConfig, "");
  for (const key of Object.keys(process.env))
    if (/^GIT_|^EMAIL$/iu.test(key)) vi.stubEnv(key, undefined);
  vi.stubEnv("HOME", isolatedHome);
  vi.stubEnv("USERPROFILE", isolatedHome);
  vi.stubEnv("XDG_CONFIG_HOME", isolatedHome);
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await command(source, ["init", "--initial-branch=main"]);
  await command(source, ["config", "user.useConfigOnly", "true"]);
  await command(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "base.txt"), "original\n");
  await command(source, ["add", "."]);
  await command(source, [
    "-c",
    "user.name=Fixture Base",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  source = await canonicalPath(source);
  engine = await NativeEffects.open(join(fixture, "data"));
  initial = await engine.inspect(source, null, AbortSignal.timeout(30_000));
});

afterEach(async () => {
  try {
    await engine?.dispose();
    if (fixture)
      await rm(
        containedPath(
          await canonicalPath(tmpdir()),
          await canonicalPath(fixture),
        ),
        { recursive: true, force: true },
      );
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["author", "committer"] as const)(
  "refuses missing %s identity before creating an agent workspace",
  async (missing) => {
    const present = missing === "author" ? "COMMITTER" : "AUTHOR";
    vi.stubEnv(`GIT_${present}_NAME`, "Present Identity");
    vi.stubEnv(`GIT_${present}_EMAIL`, "present@example.invalid");
    const worktrees = await command(source, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const result = await settled(request(initial));

    expect(result.receipt?.outcome).toBe("invalid");
    expect(result.receipt?.reason).toContain(`Git ${missing} identity`);
    expect(result.receipt?.reason).toContain("user.name");
    expect(result.receipt?.reason).toContain("user.email");
    expect(result.receipt?.processes.at(-1)?.args.slice(-2)).toEqual([
      "var",
      `GIT_${missing.toUpperCase()}_IDENT`,
    ]);
    expect(result.receipt?.processes.at(-1)?.exitCode).not.toBe(0);
    expect(await readdir(join(fixture, "data", "worktrees"))).toEqual([]);
    expect(await command(source, ["worktree", "list", "--porcelain"])).toBe(
      worktrees,
    );
    expect(await command(source, ["rev-parse", "HEAD"])).toBe(initial.head);
    expect(await command(source, ["status", "--porcelain"])).toBe("");
  },
  30_000,
);

it.each(["repository", "global", "environment"] as const)(
  "preserves %s identity through preparation and native commit",
  async (mode) => {
    const author = "Configured Author";
    const authorEmail = "author@example.invalid";
    const committer = mode === "environment" ? "Environment Committer" : author;
    const committerEmail =
      mode === "environment" ? "committer@example.invalid" : authorEmail;
    if (mode === "repository") {
      await command(source, ["config", "user.name", author]);
      await command(source, ["config", "user.email", authorEmail]);
    } else if (mode === "global") {
      await writeFile(
        globalConfig,
        `[user]\n\tname = ${author}\n\temail = ${authorEmail}\n`,
      );
    } else {
      vi.stubEnv("GIT_AUTHOR_NAME", author);
      vi.stubEnv("GIT_AUTHOR_EMAIL", authorEmail);
      vi.stubEnv("GIT_COMMITTER_NAME", committer);
      vi.stubEnv("GIT_COMMITTER_EMAIL", committerEmail);
    }

    const prepared = await settled(request(initial));
    expect(prepared.receipt).toMatchObject({ outcome: "succeeded" });
    const workspace = prepared.receipt?.after;
    if (!workspace) throw new Error("Prepared workspace is missing");
    await writeFile(join(workspace.path, "worker.txt"), "worker output\n");
    const current = await engine.inspect(
      workspace.path,
      null,
      AbortSignal.timeout(30_000),
    );
    const committed = await settled(
      request(current, "identity-commit", {
        type: "commit",
        message: "Preserve configured identity",
      }),
    );
    expect(committed.receipt).toMatchObject({ outcome: "succeeded" });
    expect(
      await command(workspace.path, [
        "show",
        "-s",
        "--format=%an|%ae|%cn|%ce",
        "HEAD",
      ]),
    ).toBe(`${author}|${authorEmail}|${committer}|${committerEmail}`);
    expect(await command(source, ["rev-parse", "HEAD"])).toBe(initial.head);
    expect(await command(source, ["status", "--porcelain"])).toBe("");
  },
  30_000,
);

# Configuration and skill management

Windows runtime shells use the bundled `bb.cmd` identified by `BB_CLI` and the
Node-compatible runtime in `BB_CLI_RUNTIME`. ARC supplies these to child
processes; do not install global aliases or change the user's shell to run its
CLI. In PowerShell, an absolute CLI path can be invoked with `& $env:BB_CLI`.

## ARC desktop updates

Stable Windows builds use public GitHub Releases at grandmasterhilbertporcupine/ARC-IDE by default. ARC checks on launch, periodically and through Settings > Updates, downloads new stable releases in the background, and installs on restart or quit. No GitHub token is bundled or needed. At build time, an explicitly empty `ARC_UPDATE_BASE_URL` disables updating; a nonempty HTTPS override preserves the custom `/desktop-latest/` or `/desktop-nightly/` feed path. Default nightly, macOS and Linux builds have no published feed. Builds through 0.42.8 need a one-time manual install to enable GitHub updates.

## Environment Setup And Teardown Scripts

- To make a repo work with bb worktrees, run `bb guide environments`. It
  documents the repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks,
  and the `.worktreeinclude` file.
- A new worktree checks out tracked files only. Commit a `.worktreeinclude`
  file at the repo root to list untracked files, such as `.env`, that bb must
  copy from the source checkout. It uses gitignore pattern syntax. bb copies
  the matches before it runs `.bb-env-setup.sh`.

## App settings

- Read `references/app-settings.md` for every general key, experiment, default,
  and effect.
- Use `bb settings show` and `bb settings ai-services` for current values.
- Use `bb settings general <key> <value>` or
  `bb settings experiment <key> <value>` for updates.
- Use `bb settings keyboard list`, `set`, and `reset` for shortcut overrides.
- Use `bb settings usage [--machine <id-or-name>]` for provider limits.
  `--host` is an alias for `--machine`.
- Use `bb settings version [--force]` for release information.
- Use `bb settings reload` to reload ARC-managed configuration.
- These commands support `--json`.

## Agent Instructions

- Add `AGENTS.md` to the bb data dir (usually `~/.bb/AGENTS.md`) to inject
  user-level default instructions for every provider-backed thread across all
  projects.
- Add `.bb/AGENTS.md` at a workspace root to inject repo-specific instructions
  into every thread that runs there. Track the workspace file with git so fresh
  managed worktrees include it.
- bb appends data-dir instructions first, then workspace instructions, to the
  thread system prompt for all providers when a provider session starts.
- Only the plural `AGENTS.md` is read, only from those exact locations (no
  parent-directory walk); an empty file is ignored. Run
  `bb guide agent-configuration` for details (it also covers project
  `.bb/skills/`).

## Skills

- Use `bb skill list` to inspect installed and discovered skills. It defaults to
  `BB_PROJECT_ID`, then the personal project; pass `--project` or
  `--environment` to select another workspace.
- Copy the opaque ID from `bb skill list`, then use `bb skill show <skill-id>`
  or `bb skill files <skill-id>` to read that exact skill.
- `bb skill show <skill-id> --json` returns the revision. Pass that revision,
  plus `--file`, to `bb skill update <skill-id>`. Use update or delete only when
  the list says editable.
- Use `bb skill search [query]` for live skills.sh results. With no query it
  lists what is trending. The page defaults to zero, and the page size defaults
  to 24. The `ranking` field names the selected leaderboard.
- In JSON, `installs` is the ranking-window count. `lifetimeInstalls` is the
  resolved lifetime count or `null`. Resolution covers at most 48 rows and can
  fail at any page size. Human output prints `—` for an unresolved lifetime
  count.
- Inspect metadata and the bounded file preview with
  `bb skill registry detail <registry-skill-id>`.
  Install with `bb skill install <registry-skill-id>`; never infer an install
  source from a display name.
- `bb skill install-cli-skills` copies bb's built-in CLI skills into a machine's
  global agent skill roots (`~/.agents/skills` and `~/.claude/skills`) so agents
  outside bb can drive bb. It targets every connected machine unless you pass
  the repeatable `--machine <id-or-name>`, and reports each machine's outcome.
  Settings → Skills has the same action; it confirms first, and asks which
  machines only when more than one is enrolled.
- `bb skill cli-skills-status` reports per machine whether the installed copy is
  `installed`, `outdated`, `missing`, or `unknown` (disconnected or unreachable).
# Native Windows worktree hooks

Use tracked `.bb-env-setup.ps1` and `.bb-env-teardown.ps1` files for native Windows.
They run through PowerShell `-NoProfile -NonInteractive -File`, with Windows
execution policy applied. Cross-platform repositories should keep the POSIX
`.sh` variants too. A POSIX-only setup hook fails native provisioning clearly.

### WNDR provider authentication and API helpers

Provider setup is available in Settings > Providers. Authentication runs in the selected host's owned terminal; provider runtimes keep their credentials. Codex uses documented app-server account APIs, Claude uses `claude auth login` and `claude auth status`, and Cursor uses `agent login` and `agent status`. The existing SDK `system.providerStates`, `system.usageLimits`, `hosts.providerCliStatus`, `hosts.installProviderCli`, and `terminals.create` expose the same host objects. CLI users can inspect provider status and run provider-owned login commands in the terminal.

Codex subscription authentication is used for agent sessions. Auxiliary inference and voice require an explicit `OPENAI_API_KEY` in the host environment and use the public OpenAI API. Provider subscriptions do not fund these API helper calls. WNDR does not extract tokens from provider credential files for helpers or quota checks.

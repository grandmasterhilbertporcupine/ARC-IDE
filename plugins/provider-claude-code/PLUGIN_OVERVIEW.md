Start a thread, pick Claude Code, and let it work in your repository from ARC. The plugin drives the Claude Code CLI on the host machine. It streams the agent's work into the ARC timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus a plan action in the composer.
- Reasoning levels from Low to Max, plus Ultracode, which turns on multi-agent workflow orchestration.
- Checkpoint forks, manual compaction, and native questions from the agent.
- Claude Code skills and CLAUDE.md files from your home directory and project.
- Health and install status for Claude Code on each host, with an install or update action.

## Settings

- `Claude Code memory`: let Claude Code read and write its auto-memory.
- `Disable provider subagents`: hide the native Task tool so the agent delegates through ARC.
- `Disable Workflow tool`: hide the native Workflow tool.
- `Release idle Claude processes`: close a quiet process after 30 seconds and resume it on the next turn.
- `Claude in Chrome`: start Claude Code with the browser tools.

## Requirements

- Install the Claude Code CLI (`claude`) on the host machine. The plugin can run the installer for you.
- Use **Settings > Providers > Sign in to Claude Code**, which launches `claude auth login` on that machine. WNDR validates the public JSON from `claude auth status` to show readiness, account, and plan when exposed. It does not read OAuth credential files or query private usage endpoints. Subscription usage is unavailable until a documented provider API exposes it.
- `Claude in Chrome` needs the Chrome extension and a claude.ai login on the host.

On Windows, installation uses Anthropic's official PowerShell installer. The SDK identifies this integration as `wndr/0.1.0`; WNDR does not impersonate the Claude CLI entrypoint or collect provider session tokens.

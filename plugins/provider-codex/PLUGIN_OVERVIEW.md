Start a thread, pick Codex, and let it write and review code in your repository from ARC. The plugin drives the Codex CLI on the host machine. It streams the agent's work into the ARC timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus plan and goal actions in the composer.
- Reasoning levels from Low to Ultra. Ultra adds automatic task delegation.
- A service tier picker with two tiers.
- Checkpoint forks, manual compaction, thread rename, and thread archive.
- Codex skills from your home directory and project, listed next to ARC skills.
- Health, usage, and install status on each host, with an install or update action.
- An optional OpenAI API service for inference and voice, requiring an explicit `OPENAI_API_KEY`. These helpers use the public OpenAI API and do not consume Codex subscription credentials.

## Settings

- `Codex memory`: let Codex recall and create memories from ARC threads.
- `Disable provider subagents`: stop native subagents so the agent delegates through ARC.

## Requirements

- Install the Codex CLI (`codex`) on the host machine, version 0.136.0 or newer. The plugin can run the npm install for you.
- Use **Settings > Providers > Sign in to Codex**. WNDR starts the documented Codex app-server `account/login/start` flow, opens the OpenAI authorization page, waits for completion, and verifies `account/read`. Codex owns token storage and refresh. Provider-owned API-key authentication remains available through the Codex CLI.
- Usage limits show only when the documented `account/rateLimits/read` API exposes them. Missing windows remain unavailable.

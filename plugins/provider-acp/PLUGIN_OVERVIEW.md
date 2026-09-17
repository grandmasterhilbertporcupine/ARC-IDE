Use one ARC workspace with the coding agents you already run on your machine. This plugin connects ARC to agents that speak the Agent Client Protocol (ACP). Each agent appears as a provider in the thread composer.

## What you get

- Ready-made providers for Cursor, opencode, omp, Grok Build, and Hermes Agent.
- A `Custom agents` setting. Add any other ACP agent as a JSON array with an `id`, a `displayName`, and a `command`.
- Permission modes `accept-edits` and `full` for every ACP provider.
- Reasoning levels and a model picker where the agent reports them.
- Skills from the agent's own skill directories, listed next to ARC skills.

## How it works

The plugin launches the agent command on the host machine and talks to it over ACP. All five shipped ACP providers are visible for onboarding, including when their runtime is missing. A background probe checks what each installed agent supports and updates the provider.

## Requirements

- Install the agent CLI on the host: `agent`, `opencode`, `omp`, `grok`, or `hermes`.
- Sign in with the agent's own command, for example `agent login` or `opencode auth login`.
- A custom agent needs a command that starts an ACP server on stdio.

Cursor readiness uses `agent status`; WNDR does not read Cursor credential files, desktop databases, or private dashboard APIs. Other ACP runtimes remain labeled unverified until their readiness can be established, while retaining their own authentication commands and capabilities. Windows Cursor installation uses the official PowerShell installer. Custom ACP registration remains available.

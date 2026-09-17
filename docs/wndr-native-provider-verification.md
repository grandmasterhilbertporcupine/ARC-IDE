# WNDR native provider verification

Run these commands in the fork on native Windows 11 x64, using Node 22.19 or newer. They target a local WNDR instance; set `BB_SERVER_URL` to its printed loopback address.

Before rebuilding the bundled runtime, stop the instance that uses that build's payload. Windows keeps the managed Python sidecar's runtime directory open; copying a new payload over a running sidecar can fail with `EBUSY`. Target its actual data directory through the owned launcher, for example:

```powershell
node packages/bb-app/dist/bb-app.js stop --data-dir .wndr-data
```

Then rebuild and restart that instance. Do not stop unrelated WNDR instances or globally kill Node or Python processes.

```powershell
node scripts/wndr-provider-readiness-smoke.cjs
$env:BB_SERVER_URL = 'http://127.0.0.1:5290'
node --conditions=source --import tsx scripts/wndr-provider-workflow-smoke.mjs codex
node --conditions=source --import tsx scripts/wndr-provider-workflow-smoke.mjs claude-code
```

The readiness probe uses provider-owned status commands and Codex app-server account methods. It prints version and readiness booleans, never account identifiers or credentials. It does not send a model turn.

The workflow probe sends real turns through WNDR's BB runtime and the selected provider account. Run it only with authorization to use that account. Each run creates a separate project in a directory containing spaces and Unicode. It checks streamed text events, actual bundled WNDR project-inspection tools, a missing-run tool error followed by successful recovery, cancellation of a native PowerShell sleep, disappearance of that command's PID, and a resumed WNDR tool call in the same task. It leaves the project and task available for inspection and writes a filtered report to `.wndr-verification/provider-<id>/result.json`. It neither logs raw provider traffic nor reads provider credential files.

The Codex workflow also asks the agent to write a standard-library Python model, import a generated linear CSV, register the source, create an evaluation plan, and run selection backtests through the bundled forecasting tools. The harness independently checks persisted source hashes, model identity, metrics, AppContainer execution records, and that holdout results remain unexposed. It does not finalize the evaluation.

On September 7, 2026, the native Codex workflow passed streaming, tool-error recovery, cancellation, and same-session resume. The agent-written model completed three AppContainer selection windows with MAE 0 on the generated linear data; its holdout remained sealed. The retained report and model source are under `.wndr-verification/provider-codex/`. These are development-machine results, not clean-install certification.

The Claude Code workflow also passed on September 7, 2026: six streamed text deltas arrived before completion, the missing-run tool error was followed by a successful project inspection, cancellation terminated the native PowerShell command within 4.3 seconds, and the same provider session resumed with another successful WNDR tool call. Its retained report is `.wndr-verification/provider-claude-code/result.json`. Codex cancellation completed within 0.6 seconds on this machine. Timing measurements are local observations, not guaranteed limits.

A passing workflow does not verify interactive login on a clean machine or all provider features. The all-provider gate also requires Cursor, Pi, OpenCode, omp, Grok Build, and Hermes on their supported native runtimes, with authentication, streaming, forecast tools, cancellation, recovery, and resume where exposed. Missing runtimes, credentials, or unsupported native provider functionality leave that gate incomplete. Account readiness alone is insufficient.

Native process tests separately exercise PowerShell through ConPTY, Unicode project paths, filesystem watching, verified PID identity, command shims, and owned child and grandchild termination. Ordinary IDE cancellation uses Windows process-tree termination; it does not establish the AppContainer and Job Object security boundary required for untrusted forecast workers.

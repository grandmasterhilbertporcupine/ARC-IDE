# WNDR Windows development and packaging

WNDR starts from the BB commit recorded in `WNDR-UPSTREAM.json`. The upstream MIT license is retained. Windows foundation changes extend native paths, PowerShell, ConPTY, process cleanup, provider command shims, file watching, and plugin path validation. Forecasting code is bundled in `plugins/wndr-forecast` and communicates through the existing typed plugin SDK.

## Build

Use Windows 11 x64, Node 24.14, pnpm 9.15, and Python 3.10 x64. Python is only a build prerequisite: the installer carries its own interpreter, numerical libraries, Electron, and Node runtime. This release supports CPU models.

```powershell
pnpm install --frozen-lockfile
$env:WNDR_BUILD_PYTHON = (Get-Command python).Source
pnpm --filter @bb/desktop dist:windows
```

`scripts/prepare-wndr-python.mjs` copies the base interpreter and standard library, installs pinned binary wheels, verifies portable imports, and records hashes. A changed runtime input requires a fresh runtime directory; it is not overwritten in place. For repository development alongside the legacy WNDR application, its `.venv/Scripts/python.exe` is detected automatically.

The installer output is in `apps/desktop/release`. `package:windows` builds an unpacked desktop for inspection. `start:windows` builds and launches that desktop. Application storage uses WNDR's Electron profile and `.wndr` runtime directory, separate from upstream BB. Uninstall is configured to retain application data and never deletes user project folders.

## Updates and providers

No upstream BB release feed is used. Updates remain disabled unless the build explicitly supplies an HTTPS `WNDR_UPDATE_BASE_URL`. Configure a WNDR-owned release feed and signing credentials before publishing updates.

WNDR also leaves the default telemetry project key empty. It does not report usage to upstream BB's analytics project; an explicit deployment configuration is required to enable a telemetry destination.

Codex, Claude Code, Cursor, Pi, OpenCode, omp, Grok Build, Hermes Agent, and custom ACP registration retain their provider-specific behavior. Provider installation and sign-in run on the host. Credentials are not sent to the forecast sidecar or model workers. Account and usage displays depend on provider-owned status interfaces. Live authentication, tool use, streaming, cancellation, recovery, and resume require independent provider verification.

## Release verification

`.github/workflows/wndr-windows.yml` builds Windows artifacts on Windows Server 2022. It runs native ConPTY, Unicode file watching, process ownership, provider onboarding contract fixtures, forecast integrity, wheel resolution and AppContainer isolation checks. It then starts the actual packaged executable twice with an isolated profile to verify bundled Python, selection runs, replay, dashboard bindings, project preservation and graceful service cleanup. The workflow retains machine-readable results and logs even when a check fails. See `apps/desktop/scripts/smoke-wndr-windows.md` for local execution and `plugins/wndr-forecast/python/VERIFICATION.md` for custom execution checks.

The Windows Server CI run does not certify Windows 11. A complete release additionally requires a clean Windows 11 install/upgrade/uninstall exercise and authenticated checks for all eight providers. Build success and provider fixtures alone do not satisfy those gates.

The [local verification record](wndr-verification.md) identifies the exact preview installer and the checks completed on the development host. Upgrades preserve historical results and dashboard bindings. Replaying a recorded run additionally requires its exact WNDR framework and package versions; changed evaluator code produces an explicit replay rejection instead of replacing the recorded result.

The original workspace's `backend`, `frontend`, and `.wonder` remain available for comparison and copy-based import. They are not another interactive agent runtime inside WNDR.

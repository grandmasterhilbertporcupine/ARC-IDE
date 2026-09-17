# ARC on Windows

ARC targets Windows 11 x64. The current implementation has not passed the public-release acceptance gates. See [ARC-PROGRESS.md](ARC-PROGRESS.md) for observed results.

## Install and connect a provider

Public download is pending. For the locally delivered personal build, compare the supplied checksum and run `ARC-0.42.10-x64.exe`, choose the installation folder, then choose whether to create a desktop shortcut and add ARC to the Start menu. Both shortcut options start selected and are remembered for that installation. The Finish screen separately offers **Launch ARC**, which works even if you declined both shortcuts. A local unsigned installer has no verified publisher; continue only when you trust its source and checksum. Uninstalling through Windows Installed apps preserves ARC data and project files.

ARC bundles Electron, its Node runtime, the local server, host daemon, `bb` CLI and Context model assets. Starting ARC does not require Node on PATH. The complete installed directory is required; copying only `ARC IDE.exe` will not work.

Setup has a dark ARC panel with a quiet animated mark alongside native installation controls and actual file progress. It works offline. Windows animation preferences and high contrast use a still image; silent installation (`/S`) remains available. The installer artwork supports 100%, 125%, 150% and 200% display scaling.

Open **Settings → Providers**, select the local machine and provider, then follow the available install and sign-in actions. Existing supported provider installations and their own credentials can be reused. Provider executables and accounts are separate from ARC: npm-based provider installation needs Node.js/npm on that machine, and repository/worktree operations need Git. ARC's private Node runtime does not install npm globally. If a provider needs manual setup, follow the command shown by ARC for that provider.

After signing in, start a thread and choose a provider and model. In ARC's terminal, `bb provider list` and `bb provider models codex` inspect provider discovery and the Codex model catalog. A populated catalog does not verify a coding session; run a small request and confirm its response and tool behavior.

## Development and packaging

Use Node 24.14 and pnpm 9.15.0 (`corepack pnpm`). Native module builds may need Visual Studio Build Tools with C++ support and the Windows SDK. An installed provider and its own authentication are required for real coding sessions. Native dependency build tooling is distinct from the removed forecasting Python product runtime.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
corepack pnpm exec turbo run package:windows --filter=@bb/desktop
```

For an unsigned stable installer with GitHub updates enabled, run in a fresh PowerShell session from the repository root:

```powershell
$env:BB_DESKTOP_RELEASE_CHANNEL = 'latest'
Remove-Item Env:ARC_UPDATE_BASE_URL -ErrorAction SilentlyContinue
$env:CSC_LINK = $null
$env:CSC_KEY_PASSWORD = $null
$env:WIN_CSC_LINK = $null
$env:WIN_CSC_KEY_PASSWORD = $null
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
corepack pnpm exec turbo run verify:mvp --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:build --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run verify:mvp:packaged --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:verify-installer --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:assets --filter=@bb/desktop --concurrency=1
```

The shared release gate requires clean committed source, then builds the complete `bb-app` payload and desktop shell into fresh output. Output is `apps/desktop/release/ARC-0.42.10-x64.exe`, alongside `win-unpacked/ARC IDE.exe` and its resources. Source and payload manifests bind the exact installer to its verification. Checksum and installation instructions finalize only after installed-payload verification passes. Windows packaging uses `--publish never`. With signing credentials absent, local artifacts remain unsigned. Windows certificate configuration is separate from macOS signing and notarization.

Read development URLs and data paths from launcher output. Packaged ARC uses application ID `dev.arc.desktop`, profile `ARC`, data `~/.arc`, server port 38986 and host daemon port 38987. Development uses a checkout-specific directory below `~/.arc-dev` and deterministic development ports. Existing BB internal environment variables and workspace files remain compatible. Do not point `BB_DATA_DIR` at a WNDR data directory when verifying coexistence.

Stable Windows builds use public GitHub Releases at grandmasterhilbertporcupine/ARC-IDE by default. ARC checks on launch, periodically and through Settings > Updates, downloads new stable releases in the background, and installs on restart or quit. No GitHub token is bundled or needed. At build time, an explicitly empty `ARC_UPDATE_BASE_URL` disables updating; a nonempty HTTPS override preserves the custom `/desktop-latest/` or `/desktop-nightly/` feed path. Default nightly, macOS and Linux builds have no published feed. Builds through 0.42.8 need a one-time manual install to enable GitHub updates.

Build verification does not publish files. Follow [release verification](arc-releases.md) to generate and verify the installer and feeds together. Source pushes, tags and public releases remain paused until renewed owner authorization.

## Acceptance

Run targeted config, desktop, host watcher, process, worktree and provider lifecycle tests through Turbo. Package the actual application and run the ARC package/installer smoke scripts against disposable ARC projects and profiles. Verify terminal output, project persistence, provider catalog, absence of forecasting payload, restart and process cleanup. Exercise real provider sessions and cancellation/resume separately.

```powershell
corepack pnpm exec turbo run typecheck test --filter=@bb/desktop
corepack pnpm exec turbo run smoke:windows --filter=@bb/desktop
corepack pnpm exec turbo run smoke:installer --filter=@bb/desktop
```

The installer smoke performs a real per-user install, same-version reinstall and uninstall in an owned verification directory. It refuses an existing ARC installation, registration, shortcut or running ARC process and preserves profile/project data. Use a disposable Windows environment when those guards block the host; do not remove a user's installation to make the test pass. See [installer verification](../apps/desktop/scripts/smoke-arc-installer.md) for testing two distinct versions and requiring valid signatures. Smoke tasks use the existing artifacts and never trigger a package rebuild.

Public release additionally requires standard-user clean Windows 11 install, Unicode/spaced paths, offline Context, sleep/reopen, upgrade/reinstall/uninstall, signature/update verification, coexistence with WNDR and all advertised providers. Local package smoke is not clean-machine certification. Historical `wndr-*.md` documents concern WNDR only.

# ARC release verification

Source publication is authorized separately from binary releases. The current binary is a local unsigned Windows x64 candidate, `ARC-0.42.10-x64.exe`; public installer downloads remain pending. Its source and packaged checks passed, but installed-payload lifecycle verification is incomplete. See [MVP verification status](arc-mvp-status.md). A successful source push or build does not satisfy the binary release gates or authorize a tag or GitHub release.

## Build and verify locally

Use an isolated healthy checkout with Node 24.14 and pnpm 9.15.0. Keep `apps/desktop/package.json` and `packages/bb-app/package.json` versions together. Review intended additions and deletions, exclude build output and credentials, and commit the complete source before starting the release gate. A dirty checkout is rejected.

Run these tasks serially from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
Remove-Item Env:ARC_UPDATE_BASE_URL -ErrorAction SilentlyContinue
$env:BB_DESKTOP_RELEASE_CHANNEL = 'latest'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
corepack pnpm exec turbo run verify:mvp --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:build --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run verify:mvp:packaged --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:verify-installer --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:assets --filter=@bb/desktop --concurrency=1
```

The shared source gate runs full ARC and Workflows suites, relevant typechecks, Preview origin/file/renderer checks, desktop updater/installer tests and native lifecycle regressions. Each test task has one worker and each Turbo invocation has concurrency one. Logs and source receipts are stored below `.arc-verification/mvp/`. Windows CI uses this same plan. Authenticated provider comparisons remain separate.

The gate sets `MAX_JOBS=1`, including the SDK declaration builder, and limits Node heaps to 4 GiB. `MAX_JOBS` must be a positive integer; without it, ordinary SDK builds keep the available-core default. The declaration builder waits for each worker to exit before scheduling replacement work.

`release:build` requires the source receipt for the exact clean commit, tree and source-file digest. It moves any existing release directory into its owned evidence directory, creates fresh output and records `source-manifest.json`, `payload-manifest.json` and `release-build.json`. The build record binds the installer, blockmap, update feed and runtime payload to the verified source. Source or version changes invalidate the receipt and require verification and rebuilding.

`verify:mvp:packaged` exercises the actual frozen unpacked application using owned profiles and credential-free team/Preview fixtures. `release:verify-installer` then performs a real guarded install, installed-app launch, same-version reinstall, shortcut-choice checks and uninstall. It compares installed and reinstalled runtime files, including updater configuration, against the frozen payload manifest. The uninstaller is the only installation-created executable excluded from that runtime comparison. ARC data and project files remain preserved.

The installer harness refuses existing installations, registrations, shortcuts or running ARC processes. Never remove a user's installation or bypass the guard to satisfy verification. If it refuses, use a disposable Windows environment and leave this gate incomplete until it passes there. See [installer verification](../apps/desktop/scripts/smoke-arc-installer.md).

Only `release:assets`, after successful source, packaged and installed-payload receipts, finalizes SHA-256, installation instructions and release evidence. Stale installer/payload pairs, feed/version mismatches and receipts for another source or build are rejected even if versions agree. Inspect Authenticode status separately; unsigned builds must be labeled unsigned. Windows signing validation does not require macOS credentials.

## Evidence and publishing boundary

Retain the installer and blockmap, `latest.yml`, `desktop-version-windows.json`, checksum and install instructions, source/payload/build manifests, verification receipts, logs, screenshots and readiness report. The installer must remain associated with its exact evidence. Local lifecycle success does not certify clean-machine operation, cross-version upgrades, signed delivery, all-provider behavior or rollback.

The intended future release destination is [grandmasterhilbertporcupine/ARC-IDE](https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases). Publishing requires renewed owner authorization and the correct GitHub account. Never replace assets on an already published stable version. A publishing token belongs only in the authorized CLI/Actions environment; it must not enter source, manifests, installers or update configuration.

## Update behavior

Stable Windows builds use electron-updater's public GitHub provider. ARC checks on launch, periodically and through Settings → Updates. After a newer stable release is published with matching metadata, it can download in the background and install on restart or quit. Receiving updates requires no GitHub account. This local build publishes no assets and claims no available public update.

An explicitly empty build-time `ARC_UPDATE_BASE_URL` disables updating. A nonempty HTTPS override retains the custom `/desktop-latest/` or `/desktop-nightly/` feed path. An unset value selects the default GitHub Windows feed; default nightly/macOS/Linux feeds remain disabled. In PowerShell, remove the environment variable to select the default. Earlier local builds with disabled updates need a one-time manual installation of a GitHub-enabled build. Network failures preserve the current app and can be retried.

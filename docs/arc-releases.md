# ARC GitHub releases

Stable Windows installers and update feeds belong to [grandmasterhilbertporcupine/ARC-IDE](https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases). Tags use `v<version>`. Never replace assets on a published stable version: bump the version and publish a new release.

## Build locally

Use an isolated checkout containing the integrated source, Node 24.14, and pnpm 9.15.0. Keep the desktop and bundled app versions together:

```powershell
node scripts/bump-version.mjs --patch
corepack pnpm install --frozen-lockfile
Remove-Item Env:ARC_UPDATE_BASE_URL -ErrorAction SilentlyContinue
$env:BB_DESKTOP_RELEASE_CHANNEL = 'latest'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
corepack pnpm exec turbo run typecheck test --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run dist:windows --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:assets --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run smoke:windows --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run smoke:installer --filter=@bb/desktop --concurrency=1
```

Update `ARC-CHANGELOG.md`, `changelog-metadata.ts`, and README version links before committing. Build from committed release source so the packaged commit identifies its source. `release:assets` uses the existing installer without rebuilding. It checks the embedded GitHub configuration, installer SHA-512 and size, and agreement between native and JSON update feeds before generating SHA-256 and installation instructions.

The installer harness refuses an existing installation. Use a disposable Windows environment when it refuses; never remove a user's installation to satisfy the test. Local packaged smoke and feed checks do not certify clean-machine or cross-version installation. Unsigned releases must say so explicitly. Windows signing configuration does not require Apple credentials.

## Publish

Push source to `main`, then run **ARC Stable Release** from GitHub Actions on that commit, or push its `v<version>` tag. The workflow builds on Windows, verifies the package and guarded installation lifecycle, creates a draft, uploads the complete asset set, and only then publishes it as latest. Upstream service, npm, and mobile workflows are restricted to the upstream repository.

For a locally verified build, use `gh` to create a draft targeting the exact source commit, upload these files from `apps/desktop/release/`, then publish the draft as latest. Never expose metadata before its installer exists:

- `ARC-<version>-x64.exe`
- `ARC-<version>-x64.exe.blockmap`
- `latest.yml`
- `desktop-version-windows.json`
- `ARC-<version>-x64.exe.sha256`
- `ARC-<version>-x64.install.txt`

Include release-specific verification results and limitations in release notes. Publishing requires repository write access. A publishing token is used only by GitHub CLI or Actions; it must never enter ARC's code, installer, or update configuration. The release workflow grants `contents: write` only to the publishing job.

## Update behavior

Default stable Windows builds use electron-updater's public GitHub provider. It selects a published stable release and pins the download to that release's tag. GitHub serves `latest.yml` and the installer/blockmap; ARC also reads `desktop-version-windows.json` through the latest-release asset URL. SHA-512 metadata validates installer downloads. Receiving updates requires no GitHub account.

An explicitly empty build-time `ARC_UPDATE_BASE_URL` disables updating. A nonempty HTTPS value retains the custom feed path, appending `/desktop-latest/` or `/desktop-nightly/`. An unset value enables the default GitHub Windows feed; default nightly/macOS/Linux feeds remain disabled. In PowerShell, use `Remove-Item Env:ARC_UPDATE_BASE_URL` for the default, and ensure your shell preserves an explicit empty environment value for disabled builds.

ARC checks on launch, periodically, and through Settings → Updates. A valid newer release downloads in the background and installs on restart or quit. Network failures preserve the current app and can be retried. ARC 0.42.8 and earlier local installers had updates disabled, so users must manually install the first GitHub-enabled release once.

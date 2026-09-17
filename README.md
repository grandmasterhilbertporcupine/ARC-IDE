<p align="center"><img src="assets/arc-icon.png" alt="ARC" width="96"></p>

# ARC IDE

ARC is a Windows coding workspace for building software with agent teams. Conversations, code, terminals, shared Context, and visual agent orchestration live together in one application.

## Download for Windows

**Public download pending.** ARC 0.42.10 is being prepared as a local Windows x64 personal installer. Source pushes, tags and releases remain paused; there is no published installer link for this build.

[Release notes](ARC-CHANGELOG.md) · [Verification progress](docs/ARC-PROGRESS.md)

1. Obtain the locally delivered `ARC-0.42.10-x64.exe` and its verification report. Compare its SHA-256 with the accompanying checksum, then run it on Windows 11 x64.
2. Choose the installation folder and whether to add Desktop and Start menu shortcuts. Setup recognizes an existing ARC installation; reinstalling retains ARC data and shortcut preferences.
3. Open **Settings → Providers** to install or connect your coding provider and sign in. Start a thread, choose a provider/model, and describe what you want to build.

Electron, Node, the frontend, local server, host daemon, CLI, plugins, and Context assets are bundled. Install **Git** separately for repository operations. Provider executables, accounts, and authentication are external prerequisites; npm-based provider installation also needs external Node/npm. ARC's private Node runtime does not install npm globally.

This is an **unsigned personal build**. Windows may show an unknown-publisher warning. Only continue with an installer whose source and checksum you trust. Checksums identify the delivered bytes; they do not establish a verified publisher. Clean-machine installation, signing, and cross-version update certification remain separate acceptance work. Uninstalling preserves project files and ARC data.

## Updates

Packaged ARC is configured to check this repository's **stable GitHub Releases** on startup, periodically, and through **Settings → Updates**. Once a newer verified stable release is published, available updates can download in the background and install when you restart or quit ARC. GitHub sign-in is not required to receive updates. This local build does not publish any update assets.

An earlier local build with updates disabled needs a one-time manual installation of a GitHub-enabled build. Prereleases are excluded from the stable channel. No public update availability or cross-version upgrade certification is claimed while publishing is paused.

## Inside ARC

- **Threads:** a centered new-thread composer, provider/model selection, persistent drafts, code tools, and terminals.
- **Agents:** build reusable agents with instructions, model choices, permissions, references, versions, and an assistant for improving the definition.
- **Teams and Context:** configure collaboration and inspect runs with shared project context and source provenance.
- **Appearance:** a custom ARC title bar, light/dark palettes, Liquid Glass, and restrained panel animations.

The [implementation plan](docs/ARC-PLAN.md) and [progress record](docs/ARC-PROGRESS.md) distinguish implemented behavior from verified acceptance. [Agent Studio's guide](plugins/arc/PLUGIN_OVERVIEW.md) describes agent authoring and matching CLI operations.

## Develop on Windows

Use Node 24.14 and pnpm 9.15.0. Native dependencies may require the Windows C++ build tools.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Read actual frontend, server, daemon URLs, and data paths from launcher output. Development data is isolated per checkout under `~/.arc-dev/`; packaged ARC uses `~/.arc/` and ports 38986/38987. WNDR data is not imported automatically.

```powershell
corepack pnpm exec turbo run verify:mvp --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:build --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run verify:mvp:packaged --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:verify-installer --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:assets --filter=@bb/desktop --concurrency=1
```

[Windows setup and verification](docs/arc-windows.md) · [Build and publish a release](docs/arc-releases.md)

## Upstream and license

ARC includes the WNDR Windows foundation on top of BB commit `06aeaa994942ae7527dc49d2268c1f801e8542a0`. [ARC provenance](ARC-UPSTREAM.json) and [WNDR provenance](WNDR-UPSTREAM.json) record the extraction. Required upstream MIT notices and third-party credits are retained. Internal BB package names, SDK contracts, storage keys, and the `bb` CLI keep their compatibility names.

[Original upstream README](docs/UPSTREAM-README.md) · [MIT license](LICENSE) · [BB source](https://github.com/get-bb/bb)

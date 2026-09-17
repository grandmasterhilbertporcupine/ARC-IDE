<p align="center"><img src="assets/arc-icon.png" alt="ARC" width="96"></p>

# ARC IDE

ARC is a Windows coding workspace for building software with agent teams. Conversations, code, terminals, shared Context, and visual agent orchestration live together in one application.

## Download for Windows

**[Download ARC 0.42.9 — Windows x64 installer](https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases/download/v0.42.9/ARC-0.42.9-x64.exe)**

[Latest release](https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases/latest) · [SHA-256 checksum](https://github.com/grandmasterhilbertporcupine/ARC-IDE/releases/download/v0.42.9/ARC-0.42.9-x64.exe.sha256) · [Release notes](ARC-CHANGELOG.md)

1. Download and run the installer on Windows 11 x64.
2. Choose the installation folder and whether to add Desktop and Start menu shortcuts. Setup recognizes an existing ARC installation; reinstalling retains ARC data and shortcut preferences.
3. Open **Settings → Providers** to install or connect your coding provider and sign in. Start a thread, choose a provider/model, and describe what you want to build.

Electron, Node, the frontend, local server, host daemon, CLI, plugins, and Context assets are bundled. Install **Git** separately for repository operations. Provider executables, accounts, and authentication are external prerequisites; npm-based provider installation also needs external Node/npm. ARC's private Node runtime does not install npm globally.

This is an **unsigned personal build**. Windows may show an unknown-publisher warning. The release includes checksums and verification notes; clean-machine installation, signing, and cross-version update certification remain separate acceptance work. Uninstalling preserves project files and ARC data.

## Updates

Starting with 0.42.9, packaged ARC checks this repository's **stable GitHub Releases** on startup, periodically, and through **Settings → Updates**. Available updates download in the background and install when you restart or quit ARC. GitHub sign-in is not required to receive updates.

If you have an earlier local build with updates disabled, install 0.42.9 once using the link above. That enables GitHub updates for future releases. Prereleases are excluded from the stable channel.

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
corepack pnpm exec turbo run typecheck test --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run dist:windows --filter=@bb/desktop --concurrency=1
corepack pnpm exec turbo run release:assets --filter=@bb/desktop --concurrency=1
```

[Windows setup and verification](docs/arc-windows.md) · [Build and publish a release](docs/arc-releases.md)

## Upstream and license

ARC includes the WNDR Windows foundation on top of BB commit `06aeaa994942ae7527dc49d2268c1f801e8542a0`. [ARC provenance](ARC-UPSTREAM.json) and [WNDR provenance](WNDR-UPSTREAM.json) record the extraction. Required upstream MIT notices and third-party credits are retained. Internal BB package names, SDK contracts, storage keys, and the `bb` CLI keep their compatibility names.

[Original upstream README](docs/UPSTREAM-README.md) · [MIT license](LICENSE) · [BB source](https://github.com/get-bb/bb)

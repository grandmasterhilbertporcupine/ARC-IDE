# Packaged ARC Context smoke

Run through the coordinated Turbo test window against an already built Windows x64 package:

```powershell
pnpm exec turbo run smoke:context --filter=@bb/desktop -- --executable "C:\absolute\package\ARC IDE.exe"
```

The executable is required. The smoke resolves only its fixed adjacent `resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/context/client.mjs`; it never substitutes development Node, a download, or a module from the project or model cache. The selected executable runs as Node using `ELECTRON_RUN_AS_NODE=1`, and the real private client starts its fixed sibling worker through that same executable. No application UI, server, daemon or provider is started.

Electron Builder copies the complete Context directory through `extraResources` into that fixed unpacked path. The file set starts at `host-daemon/dist` and includes only `context/**/*`, keeping private packages below the resource copier's root `node_modules` exclusion. The normal app-file pass excludes Context so it does not duplicate the model files. The manifest inventory check runs before inference and fails if any packaged runtime, model, or notice file is missing or changed.

The smoke verifies the shipped manifest inventory and executable hashes, model/runtime identity, real 384-dimensional finite normalized embeddings for prose/code/Unicode, repeat tolerance, exact tokenizer counts matching the embedding counts, over-limit counts without truncation, token limits, manifest mismatch, actual Electron Node SQLite FTS5, and cancellation/disposal with no remaining owned child. Token counts and embeddings bind to the exact ready helper generation as well as the asset manifest. Wrong-generation requests must leave the current helper unchanged, and requests for the stopped generation after cancellation must not start a replacement. It records cold/warm timings rather than asserting retrieval performance targets.

A second real inference case loads the complete disposable Context copy from a Unicode path containing spaces. Missing and corrupt model configuration cases then operate on that copy. The installed package and original model files are never changed. The copied files are restored after each negative case; evidence and temporary data are retained. There is no automatic download, install, package rebuild, native retry, service lifecycle change, or cleanup outside the disposable boundary.

`result.json`, an immutable final report and checksum, per-case inputs/results/logs, runtime versions and process observations are retained in the printed temporary artifact directory. An unresolved private child causes failure and preserves its actual PID/parent/executable observations; it is not reported as stopped merely because an IPC call returned.

The report distinguishes local-only library configuration and rejected fetches from **actual OS network denial**, which this script does not apply or test. It does not establish clean-machine loading, installer lifecycle, signing, network isolation, retrieval quality, full indexing coverage, or completion of Phase 5.

# ARC Windows packaged smoke

Run from the repository on native Windows x64 after `pnpm exec turbo run package:windows --filter=@bb/desktop`:

```powershell
pnpm exec turbo run smoke:windows --filter=@bb/desktop -- --executable 'C:\path with spaces\ARC IDE.exe'
```

The harness starts the selected executable twice with newly allocated loopback ports, an isolated Electron profile, an isolated runtime data directory and a workspace containing spaces and Unicode. It strips provider secrets and inherited development runtime paths. It verifies its own application PID and profile through Electron's main-process inspector before making application writes.

Before making any project writes, it inspects the actual packaged renderer for the ARC title, default dark theme and navigation, opens the welcome screen's Start a new conversation action, and verifies the composer. It retains a screenshot from each pass. A healthy server with a blank or failed renderer does not pass. Retained offscreen secondary panel content is not treated as visible UI.

The native helper window stays hidden. Its owned renderer debugger uses the desktop browser adapter's focus emulation and temporarily disables background throttling, so Electron reports an active document and the app processes its normal visibility lifecycle before readiness checks. The harness requires actual document visibility and focus, then restores the previous throttling setting and detaches before shutdown. It never overrides document properties, reloads before the first-load gate or changes query caches to satisfy that gate. Bounded per-pass logs retain renderer console calls, exceptions, failed requests and WebSocket events from debugger attachment onward; they do not claim coverage before attachment.

Each pass checks the native server/host daemon, eight-provider catalog and bundled provider plugins. The forecasting plugin and Python payload must be absent. It creates a real IDE project through the core API, verifies that its source is bound to the expected host and local directory, and checks project identity and original file bytes after restart. It also uses the packaged Context capability and real local model to index that workspace and a saved reference, retrieve hybrid results with exact source hashes, read a current excerpt and stop watching. The second pass retries the same import operation and verifies one unchanged reference original after application restart. These small fixtures do not certify retrieval quality, scale or OS network isolation. A PowerShell/ConPTY roundtrip invokes the packaged `bb.cmd` with Electron while Node is absent from PATH, reads the persisted project through the CLI, and verifies the working directory, streamed output, Unicode file write and termination of the owned terminal process. Normal application quit must remove the owned runtime marker, close service ports and terminate its runtime supervisor.

Before normal quit or forced cleanup, native Windows inspection must match the exact selected executable path, child PID and recorded process creation time. Cleanup never targets a process by name. Reports, logs, profiles and test workspaces remain in the printed artifact directory. Exit code zero means all implemented checks passed.

The second pass also opens Agents through the packaged navigation, creates a disposable agent, edits its name using native text input, saves the canonical draft, verifies the server's stored definition and reloads the styled Guide editor. Its screenshot is retained separately. This check runs after the first-load assertion and never runs a provider turn.

This does not certify clean Windows 11, authenticated provider behavior, installer lifecycle, signing, updates or rollback. Provider catalog presence is not proof of authentication, streaming, tools, cancellation or session recovery.

For diagnosis of an established first-load failure, programmatic `runSmoke` callers may set `diagnosticReload: true` to reload only after backend plugins have finished starting. These runs always report `mode: diagnostic-reload` and can end only as `diagnostic-only` or `failed`, never `passed`. They do not replace the normal CLI acceptance run.

Regression checks run with `pnpm exec turbo run test --filter=@bb/desktop`.

# Built-in browser automation

`bb browser` is the experimental core API for automation integrations controlling ARC desktop tabs. The Browser Automation plugin adds its own script/session commands; another plugin can use the same core connection independently.

Start with `bb browser instances --host <host-id> --json`. For every tab/control operation provide `--host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id>`. The browser host can differ from the agent host. Never infer an active desktop window.

- `tabs`: list native tabs and their control state.
- `create [--url <http(s)-url>] [--reveal]`: create a tab with a separate automation profile. Defaults: hidden, about:blank.
- `acquire <tab-ids...> --controller <label> [--ttl-ms <ms>] [--allow-personal]`: acquire exclusive tab control and open/focus the first selected tab. New tabs created through its CDP connection are also revealed. Default expiry is five minutes, maximum thirty minutes. Personal tabs require the explicit handoff flag and carry their profile's authenticated authority.
- `connection <lease-id> --output <new-file>`: write private connection JSON with mode 0600 on the CLI host. The loopback WebSocket endpoint is usable only on the browser host. Pass it privately to an integration worker; never expose it through a shared port or chat output.
- `release <lease-id>`: revoke automation while keeping tabs open.
- `reveal <tab-id>`: show the actual existing native tab.
- `capture <tab-id> --output <new-file>`: save a bounded JPEG to the CLI host without focusing the tab.
- `close <tab-id>`: explicitly close that native tab.
- `watch`: print changed tab snapshots every two seconds until interrupted. Disconnects report errors; this is not a lossless event log.

All commands support JSON output. In plugin code use `bb.sdk.experimental_desktopBrowsers`; the Plugin Guide documents the typed surface. Stop/Take over revokes native control; stopping the owning thread also releases its server control leases. Old connection generations cannot control replacement windows.

Cloud browsers are not supported. Headless Chrome on an enrolled host belongs to the Browser Automation plugin.


## Native inspection on Windows

The core Electron browser works without the optional DevBrowser plugin. After creating or explicitly acquiring a tab, use `bb browser targets <lease-id>` with the same `--host`, `--instance`, `--generation`, and `--thread`. Run these commands on the browser host; its private connection is loopback-only.

`bb browser evaluate <lease-id> --expression 'document.body.innerText.slice(0, 8000)'` evaluates bounded page JavaScript. Use `--target <target-id>` when the lease has multiple pages. The timeout defaults to 10 seconds and cannot exceed 30 seconds. Expressions are limited to 20000 characters and JSON output to 64000 characters. Use narrow DOM reads/assertions and the existing `capture` command for visual evidence. Scope and user Take over/Stop controls remain in force. Release the lease when done. Never print or share connection credentials.

## Managed project previews

Use `bb preview configure --project <id> --host <id> --cwd <absolute-path> --command "pnpm dev"` to save a launch command. Add `--url <http(s)-url>` if its output does not announce a loopback URL. Saving never runs it. `bb preview start|stop|restart|show|logs --project <id>` uses the same project preview as the right-side Preview controls. Add `--json` for structured status, config, terminal ID, logs and URL. Restart only closes the recorded preview terminal. A disconnected host blocks replacement until cleanup can be confirmed. Never stop unrelated terminals to free a port.

The Node/browser SDK exposes `sdk.experimental_previews.get/configure/start/stop/restart`. Configure requires `expectedRevision` from `get`, plus `{hostId,cwd,command,url}`. Use existing `sdk.terminals.output` with the returned terminal ID for incremental logs. A detected URL does not certify readiness. A remote workspace's localhost is not the desktop's localhost; use an explicitly reachable URL or existing authenticated port sharing.

Stop waits for a native process exit acknowledgment. Failed or unavailable cleanup blocks Start, Restart and configuration. Retry Stop after reconnecting. If its native session has been lost, inspect or stop the old processes on their host, then use **Detach lost session** and confirm the exact session. CLI: `bb preview detach --project <id> --terminal <exact-id> --acknowledge-unconfirmed-process`. SDK: `sdk.experimental_previews.detach({projectId,expectedRevision,terminalId,acknowledgeUnconfirmedProcess:true})`. Detach only releases tracking: it does not stop processes, confirm exit or start a replacement. Status becomes `detached`; up to 20 recent sessions retain host/config, last URL, bounded logs and `processExit:"unconfirmed"` in `show --json`/`get`. A fresh launch must prove its own listener ownership, so it cannot adopt an old process's port.

Opening .html or .htm files uses sandboxed previews with live updates across requested relative assets, scanned in rotating batches of 32 (2,048-file ceiling with a visible warning). Active previews renew their scoped leases. HTML cannot read ARC storage or navigate its application shell. Native Preview offers element selection and screenshot feedback with bounded console/network metadata, appended to the composer as a real attachment for review; it does not send a message.

Running means the host verified an HTTP response and that the listening process belongs to the owned terminal. Conflicting ports and startup failures are reported; a URL printed in logs alone does not establish readiness.

Use **Inspect in Preview** on an HTML file to open its native browser tab with element selection and screenshot feedback. The tab retains `{hostId,rootPath,filePath}` and creates its own scoped lease, so closing the file tab does not stop live reload. Reopening renews its URL before navigation. Navigating outside that preview clears the file association.

The same source descriptor is optional `htmlSource` on a persisted browser tab. Read `sdk.threads.tabs.get({threadId})`, preserve existing descriptors, append `{kind:"browser",id:"browser:html-preview:none",environmentId:null,title:null,url:"",htmlSource:{hostId,rootPath,filePath}}`, and update with the returned `expectedRevision`. `rootPath` is absolute on the selected host and `filePath` is relative without traversal. The CLI equivalent is `bb thread tabs show <thread-id> --json` followed by `bb thread tabs set <thread-id> --expected-revision <revision> --tabs-json <full-array>`. The desktop opens a fresh lease when that tab is selected; never store a file URL or an expiring lease URL as the source identity. Direct integrations can use `sdk.files.createPreview` and `sdk.files.experimental_refreshPreview` with an optional abort signal.

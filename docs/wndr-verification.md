# WNDR native preview verification

Evidence collected on the development Windows 11 x64 host, build 22631, on 2026-09-07. This is a local preview, not a certified all-provider release. The fork base is recorded in `WNDR-UPSTREAM.json`; WNDR retains BB's 0.42.1 source lineage. The latest motion preview is desktop 0.42.3; the installed lifecycle evidence for 0.42.2 remains recorded separately below.

## Motion preview 0.42.3

Navigation uses a 160 ms opacity transition on the existing content element. Menus and dialogs enter in 160 ms and exit in 100 ms, with a small scale change. Controls use 70–110 ms color feedback and compact drawers settle in 180 ms. The analysis views use Carbon's installed productive motion tokens: 70 ms controls, 110 ms notifications and 150 ms tab/editor reveals. No animation dependency was added. Reduced-motion changes cancel route effects, settle drawers immediately and suppress CSS transitions; chart geometry does not animate during polling.

Seventy focused shell/navigation tests and 24 forecast tests passed, including retained unsaved drafts and live reduced-motion changes. Relevant TypeScript checks and focused lint passed. All 13 coordinated Turbo build tasks passed. In-app browser checks on `http://127.0.0.1:5290` at 1280×720 and 640×800 verified rendered motion timing, menu/dialog and compact-drawer dismissal, settings/back navigation, model draft retention across tabs, dashboard configuration and retained run bindings. No browser warnings/errors or framework overlay were observed. Temporary viewport overrides were reset. OS-wide reduced-motion switching and iOS Safari were not visually exercised; reduced-motion behavior was covered by the automated checks and scoped media rules.

The 0.42.3 installer is `apps/desktop/release/WNDR-0.42.3-x64.exe` (235,354,717 bytes), SHA-256 `b962fca8c5de4871d47a1d59639a281b1aa77a1382efa4c610ae761017ecd77f`, and is unsigned. The earlier install/upgrade/uninstall acceptance applies to the preserved 0.42.2 artifact, not this new hash.

The actual packaged 0.42.3 executable passed ten checks across two launches: win32/protocol 184, eight-provider catalog, all 8,489 runtime hashes, baseline selection, AppContainer custom execution and matching replay with sealed holdout, PowerShell/ConPTY input and output, restart preservation and owned-process cleanup. Evidence is retained in `.wndr-verification/packaged-smoke/WNDR packaged smoke Δ cQPMbf/result.json` and `.wndr-verification/packaged-smoke/0.42.3-artifact.json`. Installer lifecycle and clean-machine certification were not repeated for this UI update.

## Verified behavior

| Area | Evidence |
| --- | --- |
| Native IDE foundation | Real PowerShell/ConPTY execution, Unicode and space-containing paths, filesystem watching, owned-process identity checks and descendant cleanup. The final installer acceptance exercised four launches and terminal roundtrips across 0.42.1 and 0.42.2, including Unicode workspace writes and complete service shutdown. The final host identifies as win32 with protocol 184. |
| Custom forecasting | Thirteen native Python tests exercised chronological isolation, zero-safe scoring, frozen finalization, independent future horizons, future-input validation, replay, immutable environments, actual pinned NumPy wheels and native AppContainer/Job Object failures. The long-path regression verifies input/output paths beyond 300 characters, relative writes and child cleanup. The installed 0.42.2 app also executed and replayed a real custom model across two launches with no network capabilities and the holdout still sealed. |
| Installer lifecycle | The actual NSIS installers passed per-user installation, a distinct 0.42.1 to 0.42.2 upgrade, restart and silent uninstall on this development Windows 11 host. Original project, result, source, dashboard and profile bytes survived. Uninstall removed the owned installation, registry entries and shortcuts while retaining project/profile data. All 8,489 bundled runtime files matched their recorded hashes. |
| Agent-written models | A real Codex task imported generated linear data, authored and registered a Python model, and completed three AppContainer selection windows with MAE 0. The holdout remained sealed. |
| Providers | Codex and Claude Code passed real authenticated streaming, WNDR tool invocation, recoverable tool errors, cancellation with child cleanup and same-session resume. All eight providers appear in the packaged catalog. |
| Carbon analysis | Live dark/light charts show uncertainty bands. Dashboard save and reload, explicit run bindings, keyboard reordering, series filtering and a narrower 960-pixel window were checked. The browser reported no warning/error messages during the final analysis checks. |
| Legacy preservation | The original Energy demand project imported by checksum-verified copy. Completed results and dashboard bindings remain visible; already-exposed holdouts are labelled throughout the evaluation view. Original source files remain intact. |
| Identity | Original cut-prism SVG, transparent PNG, monochrome variants, Windows ICO and favicons. Actual ICO frames were visually checked at 16, 24 and 32 pixels. Desktop titles, local-machine labels and analysis branding use WNDR; support links identify upstream BB explicitly. |

The focused test scopes include 301 desktop tests (three platform skips), 211 renderer tests, 23 forecast plugin tests, 104 Claude integration tests, 108 host-platform/contract/onboarding checks, and eight final installer-harness tests. These are separate scopes with some overlap, not an aggregate test count. Relevant TypeScript checks passed. The pinned pnpm lockfile also passed offline frozen validation after the desktop version change.

## Local evidence

- `.wndr-verification/provider-codex/result.json` and `agent-model.py`
- `.wndr-verification/provider-claude-code/result.json`
- `.wndr-verification/NSIS install Δ xMCWaj/installer-result.json`: passed native install, cross-version upgrade and uninstall
- `.wndr-verification/NSIS install Δ xMCWaj/next-application-result.json`: actual installed 0.42.2, ten checks across two launches, including AppContainer custom execution and replay
- `.wndr-verification/NSIS install Δ xMCWaj/baseline-application-result.json`: immutable 0.42.1 baseline, eight checks across two launches; custom execution intentionally unverified because this fixture predates the long-path correction
- `.wndr-verification/packaged-smoke/WNDR packaged smoke Δ CHLrpS/result.json`: actual 0.42.1 EXE, eight checks across two launches
- `.wndr-verification/upgrade-baseline/WNDR-0.42.1-x64.exe`: preserved baseline, SHA-256 `e83fb52e22290137494c0a80e454889b45806b47b5b18ebd390bd2c013bb21b0`
- [Native Python verification](../plugins/wndr-forecast/python/VERIFICATION.md)
- [Provider verification commands](wndr-native-provider-verification.md)
- [Packaged executable harness](../apps/desktop/scripts/smoke-wndr-windows.md)
- [Installer lifecycle harness](../apps/desktop/scripts/smoke-wndr-installer.md)

Generated reports, isolated application data, logs and installers are retained locally and ignored by Git.

The 0.42.2 installer is `apps/desktop/release/WNDR-0.42.2-x64.exe` (235,350,215 bytes). Its SHA-256 is `200d87e4300d61156de285cb8bfc2665142888e00c6fbec6015e74e9454be345`; Windows reports `NotSigned`. The reviewed isolation source and the copied application payload match, and all 13 final Turbo build tasks passed.

## Remaining release gates

- Cursor, Pi, OpenCode, omp, Grok Build and Hermes Agent have no installed/authenticated runtime on this host. Their authentication, streaming, tools, cancellation, recovery and supported resume paths remain unverified.
- Existing Codex and Claude accounts were used. Fresh interactive account enrollment on a clean machine remains separate from the verified authenticated workflows and onboarding contract tests.
- Clean Windows 11 without development tools still requires certification. The packaged smoke strips development runtime paths and provider credentials, but this does not substitute for a clean installation. The Windows Server 2022 CI workflow has been added; a remote CI run has not been executed from this local checkout.
- The preview is unsigned. Release signing credentials and a WNDR-owned update feed are not configured; upstream update and default telemetry destinations remain disabled.
- macOS and Linux code paths are retained but have not been release-certified for WNDR.

Custom runtime executable paths must be shorter than 260 UTF-16 code units because of the native Python loader. WNDR checks this before starting custom code and requests a shorter data directory when necessary. This limit is separate from the verified longer model input/output paths.

Replay requires the exact recorded WNDR framework and package versions. An application upgrade preserves historical results, source snapshots and dashboard bindings, but cannot replay an old run when its framework identity differs. The 0.42.1 to 0.42.2 transition exercises this rejection; it must not silently recompute historical evidence with newer evaluator code.

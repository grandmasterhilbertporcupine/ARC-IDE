# ARC native NSIS lifecycle verification

The interactive installer asks for installation scope and folder, followed by an
**Additional options** page with independent **Create a desktop shortcut** and
**Add ARC to the Start menu** checkboxes. Both default to selected on a fresh
installation. The Finish screen has a separate **Launch ARC** checkbox.

Shortcut choices are saved with the selected installation's registry record and
loaded before a reinstall replaces that record. Going Back retains edits; changing
installation scope loads that scope's choices. A normal interactive reinstall
replaces the previous registered installation's shortcuts with the selected ones.
Declining a shortcut skips its creation entirely.

Silent setup uses saved choices, or the fresh-install defaults when none exist.
The existing `--no-desktop-shortcut` flag forces the desktop choice off. Update mode
keeps the upstream behavior of retaining existing shortcuts, including ones added
manually, and leaving deleted desktop shortcuts absent. Neither mode launches ARC
silently unless the existing `--force-run` flag is supplied. Launching from Finish
works even when both shortcut choices are off. Public update assets remain
unpublished until the owner renews publishing authorization; stable builds retain their GitHub updater configuration.

Native shortcut regression tests compile the production NSIS include against the
bundled installer helpers and operate only on temporary links and an owned test
registry key. They verify shortcut behavior and saved preferences; they do not
replace visual/keyboard checks or the installer lifecycle below.

Run from the repository on native Windows x64 after building the installer with
`pnpm exec turbo run dist:windows --filter=@bb/desktop`. The smoke task does not
build or replace its input artifacts:

```powershell
pnpm exec turbo run smoke:installer --filter=@bb/desktop
pnpm exec turbo run smoke:installer --filter=@bb/desktop -- --installer 'C:\releases\ARC-baseline-x64.exe' --upgrade-installer 'C:\releases\ARC-next-x64.exe' --require-signature
```

The default input is `apps/desktop/release/ARC-<version>-x64.exe`, using the desktop package version. Upgrade mode requires distinct installer versions and SHA-256 hashes. Public release verification must use `--require-signature`, which rejects invalid or missing Authenticode signatures on both installers and installed application executables before those apps are started. Signature status and signer thumbprints are recorded. This check does not establish signed update delivery or rollback.

Before installing, the harness checks both registry views, ARC shortcuts and ARC processes. Any existing installation, stale registration, shortcut or running ARC process blocks the test. Existing ARC, WNDR and BB profile files are hashed before changes; linked or excessively large profiles cause a bounded refusal. WNDR and BB identifiers are not installation targets.

NSIS runs hidden in per-user mode and only in a new owned directory under `.arc-verification`. Installation and workspace paths contain spaces and Unicode. The installed app must pass the packaged smoke and match its installer's version. Reinstall or upgrade must preserve the exact QA data before launch and reopen the same project and workspace afterward. The owned uninstaller must remove only its installation, registry entries and shortcuts, retaining project/profile bytes.

The harness never requests app-data deletion or removes verification artifacts. Cleanup on failure requires registration that proves the exact owned installation. Reports and logs remain under the printed directory.

The default same-version reinstall does not prove cross-version upgrade. Neither mode certifies clean Windows 11, standard-user behavior on a machine without development tools, interactive provider enrollment, all-provider workflows, public update delivery or rollback. Those remain release gates.

For MVP delivery, use `pnpm exec turbo run release:verify-installer --filter=@bb/desktop --concurrency=1` after the shared source/build/packaged gates in [release verification](../../../docs/arc-releases.md). This mode requires the frozen release manifest and packaged receipt. It compares installed and reinstalled runtime files, including `resources/app-update.yml`, against the payload manifest and writes an installer receipt only after the owned lifecycle passes. `release:assets` rejects mismatched installer, payload, source, feed or receipt identities even when version numbers agree. Legacy `smoke:installer` remains available for explicit investigations; its result alone cannot finalize MVP release assets.

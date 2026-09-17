# ARC 0.42.10 MVP verification status

The application source and required packaged checks passed locally on Windows. The unsigned installer candidate is built, but its installed-payload lifecycle gate is incomplete. Source publication and documentation do not turn that candidate into a verified installer release.

## Exact candidate

| Item                    | Identity                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| Frozen source commit    | `32ded9637edca58315157a3496a72c02767980ee`                         |
| Source tree             | `717799a8b14758bd3801072f32522f7502b5f9d5`                         |
| Source manifest digest  | `6766f46792e31b8ab33c3f6cd312a6cc3ff521499d4eaf489250d05b65eb02a6` |
| Installer               | `ARC-0.42.10-x64.exe`                                              |
| Installer size          | 203,734,680 bytes                                                  |
| Candidate SHA-256       | `09aa42378061404dffcf312a4961b4d58494cbf9f48f62697cee24c880c6ab91` |
| Authenticode status     | `NotSigned` for both installer and application                     |
| Build ID                | `32a44bc4-4c6b-409c-aca8-bef9a1caf287`                             |
| Payload                 | 8,735 runtime files                                                |
| Payload manifest digest | `5f67551f1403f87d70c3ad9f3c798ab88e6697ee78a9d2c275347022fe8d90ca` |

The candidate remains local. Its checksum identifies the existing bytes; release asset finalization has not run. Later README, gallery and documentation commits do not change this frozen application identity. A change to the packaged source requires renewed verification and rebuilding.

## Passed locally

Heavy verification ran serially with one test worker, `MAX_JOBS=1` and a 4 GiB Node heap limit. Counts below describe suites rather than adding repeated executions together. The final source gate reused valid Turbo results where inputs were unchanged; underlying executions and failed attempts were retained.

| Source check                                                | Result                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Relevant formatting, typechecks and browser contract bundle | Passed                                                               |
| Full ARC                                                    | 765 passed across 79 files                                           |
| Full Workflows                                              | 357 passed across 23 files                                           |
| Desktop                                                     | 435 passed; 3 platform skips                                         |
| Desktop / daemon contracts                                  | 36 / 64 passed                                                       |
| Server Preview, origin, raw-file and lifecycle checks       | 86 passed                                                            |
| Native host files, broker, Preview probe and ConPTY         | 35 passed; 1 file-symlink privilege skip                             |
| Renderer Preview, drafts, Updates and changelog             | 77 passed                                                            |
| Domain                                                      | 211 passed                                                           |
| Process utilities                                           | 19 passed; 9 platform skips                                          |
| Windows watcher / process stop                              | 1 passed each                                                        |
| Provider setup and capability checks                        | Claude 3, Pi 3, ACP 19, Codex 8 passed; no authenticated model turns |

The bounded-delegation regression passed repeatedly at approximately 8.2–8.4 seconds with completion and cleanup assertions. Its test timeout is 60 seconds; production execution budgets and suite defaults were not increased.

All five required packaged stages passed against the same build and payload: native installer-option checks, Windows startup/restart, Team/Workflow UI, managed Preview and Preview security. Observed behavior includes:

- Bundled CLI startup without external Node on PATH, native terminals, Context assets and owned-process cleanup.
- Editable team templates, pinned skill contents, native drag/drop, keyboard placement and relationships, undo, linked workflow assignments and persistent recipients.
- Localhost hot reload, owned Start/Stop/Restart, conflicting-port preservation, Windows browser inspection, user takeover and screenshot/selection into an unsent composer draft.
- Opaque-origin isolation for HTML-to-SVG navigation and direct SVG/XHTML/XML in lease Preview, plus SVG through project/thread raw files and uploaded attachments. Owned outside-root sentinel reads and mutations were denied in those native cases.
- Static modules, relative JSON, CSS, images, fonts, reload and renewal; rejection of private/hidden/encoded paths, junction escapes, credentialed cross-origin reads and unauthorized API requests.
- Rejection of a deliberately mismatched same-version expected updater payload against actual unpacked files.

Supplemental native checks passed for the centered new-thread composer, sidebar/title-bar separation, exact draft persistence, unsent agent-building assistant, panel animation geometry and embedded browser alignment. The real Codex catalog supplied `gpt-6-astra`; selection, provider logo, team name/color/model save, publish and restart persistence passed without a provider turn or copied credentials.

## What remains incomplete

The official installer lifecycle harness refused to proceed because existing Desktop and Start-menu ARC shortcuts were present on the test PC. They were preserved. Full installation, installed-payload comparison, same-version reinstall with retained data, shortcut choices through the installed lifecycle and uninstall cleanup require a disposable Windows environment. Never remove or hide a user's installation artifacts or bypass the guard to obtain a passing result.

The local candidate therefore has no matching installed-payload receipt. `release:assets` must remain blocked until that receipt exists. A successful source push, unit test or unpacked-app run does not satisfy this gate.

Additional boundaries:

- Clean-machine certification, cross-version upgrades and signed distribution are not complete.
- These native UI checks used the tested local DPI. A full multi-DPI, high-contrast/transparency, Snap Layouts and manual caption-interaction matrix was not performed in this hardening run.
- Team color was exercised through real input/change events; the Windows color-picker dialog itself was not exercised.
- The fresh independent security reviewer returned a content-risk flag before producing findings. A parent read-only review and native security reproductions completed; no independent passing review is claimed.
- Credential-free hardening checks do not certify authenticated provider execution or efficiency. Earlier diagnostic comparisons are recorded in the progress log and support no general token-savings claim.

## Evidence and next gate

The locally delivered candidate is accompanied by source, payload and build manifests, source/packaged receipts, a readiness report, an indexed set of logs and native screenshots. The public [progress record](ARC-PROGRESS.md) describes implementation history; the [README gallery](assets/readme/provenance.md) identifies its separate demonstration captures.

Use the matching frozen source and release folder in a disposable Windows environment with no existing ARC installation. Run the guarded `corepack pnpm run release:verify-installer`, then `corepack pnpm run release:assets` only after it passes. Follow the [release guide](arc-releases.md). Public installer downloads remain pending; stable release assets must not be substituted or replaced silently.

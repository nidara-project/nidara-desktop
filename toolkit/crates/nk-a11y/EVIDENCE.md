# Test 3 — measured evidence (#830)

2026-10-15. Release `nk-phase0`, CPU/wl_shm, on Hyalo built from the branch base
`b12a87d9` (#828 and #833 included), nested under headless cage. Private runtime,
config, session D-Bus, accessibility bus and registry. No live Orca run was made.

- rustc 1.99.0 (b940084d7 2026-09-28) (Arch Linux rust 1:1.99.0-1)
- libatspi 2.62.1; AccessKit 0.25.1 / accesskit_unix 0.24.0 / accesskit_atspi_common 0.21.0; zbus 5.19.0.
- Exact binary/Cargo.lock hashes: [environment.json](evidence/environment.json).
- Raw outcomes, controls and costs: [report.json](evidence/report.json).
- Baseline events: [AccessKit](evidence/accesskit-events.json), [direct](evidence/atspi-events.json).
- Initial queried trees: [AccessKit](evidence/accesskit-tree.json), [direct](evidence/atspi-tree.json).

## Same walk, both backends

| Check | AccessKit | Direct AT-SPI |
| --- | --- | --- |
| Reachable retained tree | PASS | PASS |
| Name of each control | PASS | PASS |
| Roles of all five controls | PASS | PASS |
| Window model bounds through Component | PASS | PASS |
| Tab through all controls | PASS | PASS |
| Japanese + emoji insert event and character length | PASS | PASS |
| Delete/caret events at character offset 7 | PASS | PASS |
| Select word, selection event and word boundary | PASS | PASS |
| No password content, length or text/caret event | PASS | PASS |
| Dropdown expanded state | FAIL | PASS |
| Choose Chinese, selected state | PASS | PASS |
| Close dropdown and remove options | PASS | PASS |
| Checkbox checked state | PASS | PASS |
| Open a real native error dialog | PASS | PASS |
| Invalid-entry state and focus in the error field | FAIL | PASS |
| Correct/close, focus restored, reopen/Escape | PASS | PASS |
| AT action callback, plus editable-text request | PASS | PASS |

The full driver **exited 1**, for `accesskit expanded` and `accesskit error`.
It continues the remaining walk to report each observation, but returns failure
if any backend fails. Neither failure is exempted or marked expected.

The app supplies `expanded=true` and `invalid=true`; the AccessKit adapter sets
`Node::set_expanded` and `Node::set_invalid`. In the pinned upstream
`accesskit_atspi_common` state projection, those flags do not become AT-SPI
Expanded/InvalidEntry states. The direct provider emits and answers both.
AccessKit does expose the selected option, closes the list, edits the error,
closes the native dialog and restores the opener; those separate checks pass.

Libatspi also reports rejected AccessKit Cache AddAccessible/RemoveAccessible
signatures (including `(so)(so)(so)iiassusau` without its outer struct). These
warnings were observed, not suppressed. The driver uses uncached current
queries for both backends and asserts events separately; it does not establish
Orca cache behavior. The owner must still run real Orca with its normal cache.

## Controls that were actually broken

Every check was preceded by its named `--control-a11y=...` fault. The direct
provider detected all 17 at their own assertions. AccessKit detected the 15
whose baseline passes. Its expanded/invalid-state controls also fail, but their
baseline already fails, so **discrimination is unproved**, not counted as a
passing control. The raw report labels both accordingly.

The separate unit mutation removes the shared password redaction. Both backend
privacy tests and the common redaction test fail; after source restoration all
four nk-a11y unit tests pass. Each feature also builds/tests independently and
the pure model tests without either feature.

## Cost (one idle window, one observation)

| Measure | AccessKit | Direct AT-SPI |
| --- | --- | --- |
| Mapped RSS (KiB) | 59704 | 58688 |
| RSS added over identical no-backend form (KiB) | 3096 | 2080 |
| AT-SPI events for one Backspace | 2 | 3 |
| App semantic-tree build (µs) | 9 | 7 |
| Synchronous backend constructor (µs) | 118 | 5384 |

The identical no-backend window used 56608 KiB.
RSS was sampled after mapping/activation, before editing. Startup constructors
have different work boundaries: AccessKit activates asynchronously, while the
direct constructor performs its registry embedding. Constructor times alone
cannot compare activation speed. These are nested one-window observations, not
hardware/GPU measurements or statistical benchmarks.

## Other verification

- Workspace format, locked release build, clippy `-D warnings`, unit tests, text and CPU render corpus: PASS.
- Pure/no-feature and individual-feature tests: PASS.
- Password leak mutation: both backend tests fail, then restored-source tests pass ([log](evidence/password-control.txt)).
- Existing `nk-phase0-check.py` on the rebuilt Hyalo ([log](evidence/window-regression.txt)): PASS, including mapping/material/keyboard/preedit negative controls, clipboard, undo/redo and scale 1.25.
- Python/shell syntax, diff whitespace and skill-docs consistency: PASS.
- GitHub-hosted vkms CI: not run locally; the hook is installed and any backend failure stays red.
- Live Orca: **PENDING for both**, exact steps in [README.md](README.md#owners-live-orca-walk-both-backends).

No backend is chosen. Phase 0 test 3 is **not declared passed**. The owner
decides after the live walk; Claude owns the contract/skill follow-up per #830.

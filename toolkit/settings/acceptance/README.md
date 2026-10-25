# Appearance acceptance — PHASE1 gates 1 and 2

Run by the existing Hyalo smoke, inside its disposable vkms session with the real
installed shell, Config1, portal and legacy Settings. Never run this script on a
user session. `NK_SETTINGS_TEST=vkms` and `/run/hyalo-smoke` are mandatory; the
script refuses an existing native instance, uses a new evidence directory, and
restores all changed settings even on a failed assertion.

`ci-scope.sh` emits `settings=true` only for non-Markdown changes under
`toolkit/settings/`. It is independent of `gates` (the phase-0 IME/Orca matrices).
Unknown/empty scope and the nightly run retain the existing run-everything rule.
There is no new Actions job or step. The existing build/boot step forwards this
flag and builds/runs these checks only when it is true. `NK_REAL_FULL=false`
runs the baseline at scale 1 only; controls and scale 1.25 run only in full. Changes to acceptance code
and gate_controls.rs request full. Unrelated PRs pay no new native walk.

## Oracles

`matrix.py` expands D1 by actual operation: 21 entries, including wallpaper
preview/gallery/file chooser separately, four time fields and both font dialogs.
Every interactive operation is performed by physical keys through the existing
Hyalo test FIFO, including Tab focus traversal and the real portal file chooser.
AT-SPI queries are read-only: no GrabFocus/DoAction/SetValue/SetText shortcut.

Gate 1 reads the canonical result through `nidara-ipc getConfig`, independently
reads its GSettings key / Hyalo background config / awww output and persisted
wallpaper, then observes what legacy Settings renders through its read-only
queryUI (including active widget state, visible text and row bounds). It does
not compare the new toolkit's AT-SPI roles with GTK's painted controls. An
unobservable or truncated legacy result fails; registry values never stand in
for the legacy display. A write through another process/path must emit a real
Config1 Updated and change the native AT-SPI value. Wallpaper operations also
check the dependent preview. Pure image decoration is inspected, not treated as
a keyboard-actionable button.

Gate 2 starts real Orca with speech-dispatcher's dummy backend and libao null in
the disposable container. Only fresh `SPEECH OUTPUT` counts for speech role,
name and value. Keyboard changes must also satisfy gate 1's effect assertions.
Font dialogs traverse search, family/style lists, point size and Select/Cancel;
font and real file chooser dismissal must restore the launching button. Provider
queries and application logs establish setup/causal barriers, never speech.

`prepare.py` installs small real GTK/icon/cursor theme alternatives in the test
home before the shell enumerates choices. Bundled wallpaper choices come from
the real catalogue. Missing choices or dependencies fail rather than skip rows.

## Full controls

The ordinary binary does not compile the fault hooks. The acceptance build uses
`--features nk-settings/appearance-gates`, which forwards only the value-event
hook to nk-a11y. An atomically published private control file arms one fault after its prerequisites
(except the builder omission, which is armed before page construction):

| Fault | Required failing baseline assertion |
| --- | --- |
| drop a real Updated for nightlight.enabled | external:night-enabled |
| swallow that control's Apply | apply:night-enabled |
| omit wallpaperPreview's builder | structure:wallpaper-preview |
| swallow a physical Space action | apply:night-enabled |
| suppress an actual provider Value event | speech:night-temperature |
| restore the wrong focus after the font dialog | focus:interface-font |

Every branch logs SETTINGS_GATE_CONTROL_APPLIED where it actually runs. A
control counts only if that marker is present, the exact named assertion fails,
and all processes remain alive. Setup/publication deadlines, earlier failures,
missing markers, crashes and escaped controls fail the gate. Baseline failure
prevents controls from running. No synthesized AT-SPI events or speech.

## Evidence and current validation

Artifacts are fresh subdirectories of `toolkit/target/sg` (outside /tmp), copied
by the existing smoke cleanup to hyalo-out/settings-gates even on failure.
They include hashes/revision/PIDs, real schema, legacy observations, client and
Orca logs, per-row results, failed/uncaught controls and explicit NOT RUN controls.

The Python matrix/visible-row tests, ci-scope self-test, syntax, Rust workspace
check, settings/a11y tests and Clippy with/without the acceptance feature are
local checks only. The complete native parity and keyboard/Orca checker has not
yet run locally: Orca/speech-dispatcher and a disposable vkms runner are unavailable
here. **Checker no ejecutado**; native acceptance, control catches and takeover
readiness remain unproven until the real smoke produces evidence. No live
settings, services, audio configuration or compositor were changed for these
local checks. Gate 3 is not added; gate 4 remains separately owned.

Application discovery uses the launched process PID, never the frame title or
the AT-SPI application name (GTK may decorate its application ID with a version).
On the legacy discovery deadline the log includes every observed PID/name plus
the expected process PID. Metadata-selector tests cover the original mismatch;
they are not a native accessibility run.

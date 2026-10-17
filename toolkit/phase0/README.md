# The first native toolkit window (#826)

`nk-phase0` is a Rust Wayland client, without GTK or GJS. It needs **Hyalo**:
`nidara-material-v1` paints the transparent pane's glass. It refuses to run on a
compositor without that protocol. This implements #818's tests 1, 2 and 4;
the live fcitx5 matrix below is an owner gate, not something the scripted IME proves.

## Build and run

Install the same required fonts as `crates/nk-text/README.md` (Noto core, CJK,
Color Emoji and the Inter variable font), plus Wayland and libxkbcommon development
libraries. Then, from the repository root:

```sh
cargo build --manifest-path toolkit/Cargo.toml --release --locked -p nk-phase0
# In a Hyalo session:
toolkit/target/release/nk-phase0
```

The corpus keeps each case at its first test width (constrained by the window),
using the retained `nk-text::Layout` for measurement, hit testing and glyph paint.
Scroll the window to see all cases, or start at one with `--case japanese`,
`--case arabic-bidi` or `--case zwj-rainbow`. The field is initially focused.
Click to place the caret, drag to select, Shift+arrows to extend, Ctrl+arrows for
words, Home/End for lines, Ctrl+A/C/X/V and Ctrl+Z/Y (also Ctrl+Shift+Z) to edit.
Tab moves focus out of the field and back. The field wraps and scrolls its caret
into view; scrolling the whole document moves its surface-local IME rectangle too.

## Automated evidence

```sh
cargo fmt --manifest-path toolkit/Cargo.toml --all --check
cargo clippy --manifest-path toolkit/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path toolkit/Cargo.toml --workspace --locked
```

The `toolkit` CI job builds/lints/tests all members on Ubuntu. The `hyalo` job
builds `nk-phase0` in Arch and runs `scripts/ci/nk-phase0-check.py` inside the
existing vkms/tty smoke. Its screenshot oracle verifies a mapped window and text,
Hyalo's **committed** pane state (`msg windows` → `glass`), virtual-keyboard text,
input-method-v2 preedit, replacement, cancellation and commit, plus selection,
clipboard and undo/redo. It first establishes a complete baseline, then disables
mapping, material requests, keyboard editing and preedit independently: every
broken path must fail at its own assertion. Controls are explicit `--control-*`
arguments to this test binary, not environment switches affecting installed apps.

The scripted input method is the existing `hyalo-ime-probe.c` with `--script`;
it acknowledges `preedit TEXT`, `cancel`, `commit TEXT` after Wayland roundtrips.
It uses Hyalo's real text-input bridge. It does not stand in for a candidate UI or
claim that mozc/pinyin/hangul passed.

The same check can run locally without touching the live shell:

```sh
# Build Hyalo and the IME probe as scripts/ci/hyalo-smoke.sh phase_build does.
# Put hyalo-ime-probe in PATH; install cage. Both binaries default to target/release.
NK_PHASE0_LOG=/tmp/nk-phase0-evidence toolkit/phase0/check-headless.sh
```

This follows `hyalo/scripts/headless-shot.sh`: cage's headless backend contains
nested Hyalo. It gives the test its own runtime directory, D-Bus, config and
control FIFO. It waits for completion and propagates failures. `HYALO_BIN` and
`NK_PHASE0_BIN` override binaries. On a running **test** Hyalo, the Python check
instead needs `HYALO_CONTROL`, `hyalo-ime-probe` in PATH, and optional
`NK_PHASE0_LOG`; it restores the workspace it found.

PNG/PPM captures, IPC state and logs are retained under `NK_PHASE0_LOG`, and the
vkms run's PNGs are uploaded with `hyalo-artifacts`. `FIRST_FRAME_MS` in the
client log measures entry to main through presentation feedback; `VmRSS` on that
line is RSS after the first frame. `FIRST_FRAME_CALLBACK_MS` separately reports
the frame callback (including font discovery/layout/rasterization). Nested Hyalo
has no presentation feedback today: use the callback number there and label it
as such. These are one-window observations, not GPU benchmarks.

## Real fcitx5 and Orca gates (#832, #835)

The `hyalo` job installs fcitx5, Mozc, Pinyin, Hangul, Orca and
speech-dispatcher, then runs `scripts/ci/nk-fcitx5-check.py` and
`scripts/ci/nk-orca-check.py` on its **vkms/tty Hyalo**. Both run even if one fails.
Artifacts are `toolkit-fcitx5/` and `toolkit-orca/`; the assertion tables also
appear in the job summary. The drivers require every baseline and its fault controls to pass; vkms CI is the final evidence.
[EVIDENCE-832-835.md](EVIDENCE-832-835.md) records the new findings after #839,
the acceptance decisions, controls and verification results. No expected failures
or blanket success for an incomplete matrix are permitted.

Run the same drivers locally in the private cage → Hyalo harness:

```sh
# Arch: bwrap, cage, python-gobject, at-spi2-core, wl-clipboard, nidara-input,
# fcitx5, fcitx5-mozc, fcitx5-chinese-addons, fcitx5-hangul,
# orca, speech-dispatcher, libao. Build the two Rust binaries first.
NK_PHASE0_LOG=/tmp/ni toolkit/phase0/check-prerequisites.sh ime
NK_PHASE0_LOG=/tmp/no toolkit/phase0/check-prerequisites.sh orca
```

The launcher isolates network/IPC/PID namespaces (including Mozc's abstract
socket), Wayland, D-Bus, preferences and audio. It selects libao's null driver
and speech-dispatcher's real `sd_dummy` inside the sandbox. The headless
compositor enables its accessibility manager with `HYALO_A11Y_MANAGER=1`.
`NK_PREFLIGHT_SYSROOT` can name an extracted package root; an optional
`NK_PREFLIGHT_PACKAGE_MANIFEST` records its package versions. No packages or
preferences are written to the host. Keep `NK_PHASE0_LOG` **short**: Unix socket
paths must fit in 108 bytes. Use a new evidence directory for each invocation.

The fcitx5 baseline covers all three engines at scales **1 and 1.25**: underlined
and changing preedit, confirmation, Backspace, Escape/undo, interior UTF-8
surrounding context, selection replacement, second-window focus, daemon restart,
Compose/dead acute, repeat delay/rate/release/focus loss, and candidate position
under scrolling. Normal Hangul has no candidate list. `--ime-evidence` logs the
actual Editor state and logical geometry in `IME_STATE` JSON (a separate file
selected by `NK_IME_STATE_LOG`, so wire debug cannot interleave with records); screenshots
independently measure underline ink and the candidate panel. The panel's flood
fill excludes the caret, which can touch it on the next pixel row after #839.
Every assertion has a targeted control: the test window reads a private fault
file armed immediately before the action, and records that it applied the
mutation. An unrelated setup failure or a crash cannot satisfy a control.
Candidate controls also require vertical proximity, so a panel far below the
caret cannot pass merely because it does not overlap it. Hangul follows the
engine's policy: Escape commits `하`, clears preedit, and Ctrl+Z removes exactly
that commit; its control deliberately drops the real commit and must fail.
Mozc/Pinyin Escape cancel without inserting text.

Compose/dead-key checks stop fcitx5 temporarily so its keyboard grab cannot
implement composition instead of `nk-wayland`. The engine is restarted before
the candidate/scroll checks. Output scale is written into the private settings
layer: changing the keyboard reapplies output configuration, so a transient
`msg output ... scale=...` would silently revert on the next keymap change.
The script restores the keyboard, scale and workspace on exit.

Orca's oracle is its final **`SPEECH OUTPUT`** debug records, adjacent to sending
speech to the server. Each keyboard action has its own complete debug interval
and screenshot. Paste must announce “Pasted contents from clipboard.”; moving to Password and back to Name separately reads `日本🙂 word` from the
accessible field on focus.
A separate real KP_Up flat-review command must now speak the complete `日本🙂 word`
(#846). `GetRangeExtents` and `GetCharacterExtents` use actual painted-layout geometry.
The `text-extents` control publishes wrong rectangles, logs application after provider
update, and requires Orca's wrong-response diagnostic plus failure of that same speech
assertion. KP_Subtract leaves review before the existing editing walk. The complete
matrix has 26 baseline assertions and 24 fault runs. Ordinary keyboard listeners must be
refused with `AccessDenied`; actual delivery is demonstrated by Orca's key and
editing echo. Password silence has a speaking baseline and a leak control.
On the focused combo, Space must speak Japanese, Down must speak Chinese,
and Enter must speak Chinese. Orca does not use the literal words expanded and
collapsed for this focused role. The `expanded`/`collapse` faults leave only the
key echo, and must fail these value assertions. Dialog error, correction,
save/Escape and return to Review are checked in speech. Controls cover the whole
Tab order, edit/caret/selection, Unicode reading, password silence, dropdown,
checkbox, rejected Save, correction and both close paths. The field's fault file
is private to each run; installed applications do not use it.

When the automated gates are green, the useful owner's check is one look at the
candidate panel on real hardware and one listen to Orca's chosen voice. No
manual reconfiguration matrix is needed to repeat the automated coverage.

## Boundaries still ahead

The toolkit does not own its tokens yet. Its own token source and appearance
model belong to phase 1; the build-time shell token import is a phase-0 bridge.

The no-flag corpus/IME mode has one normal editable field. The test-3 form and
its two accessibility adapters are available with `--a11y` (below). Menus, a
layer-animation client and the GPU/dmabuf path remain in later issues. `nk-wayland::TextInput` already enforces the password wire rule:
no surrounding text for password purpose, including resetting prior context on a
purpose change. The test-3 form applies that password rule; its real-Orca CI gate runs separately from the libatspi check.

The app retains stable node IDs and distinct layout/paint/semantics invalidation;
measure precedes place, one node owns focus, and the pressed node captures the
pointer until release (focus loss releases capture). There is no widget library.
The CPU renderer takes font bytes, face index, normalized variations and glyph
positions directly from `nk-text`, including Noto bitmap emoji. Buffers are native
ARGB8888, premultiplied sRGB; only a released shm slot is written. Fractional scale
changes buffer dimensions and viewport destination together. The app supplies
`Material` (glass, tone, shadow and shapes) with its frame; `nk-wayland` only
transmits it, without panel look defaults. Phase 0's measured panel values live
in `src/material.rs`, referencing `glass-material.ts`. Material shapes,
input and IME rectangles remain in logical pixels and land with the same commit.

Keymap descriptors can share their file offset with the compositor and later
clients: `nk-wayland` uses positioned reads, never `read_to_end`, so opening a
second window cannot consume the compositor's keymap. The independent negative
controls open several clients in sequence and also catch that regression.

Phase 0's palette resolves the existing dark startup `--nidara-*` tokens from
`ui/shell/styles/_base.scss` at build time. It is not a second colour table or a
live appearance implementation; the portal and appearance model are phase 1.

Context updates caused by `done` use text-input-v3's `input_method` change cause;
keyboard/pointer changes use `other`. Marking the IME's own echo as external can
make a real input method cancel the composition it just sent. The scripted
probe reports that cause and the integration check requires the IME echo.

The initial `--case` scroll target stays anchored through provisional layouts
and the post-map viewport constraint, until user input takes over. Consuming it
on the first paint clips the last case when Hyalo constrains the floating window
only after seeing its first buffer. The CI gallery requires red and blue bitmap
pixels of the final rainbow flag inside the visible pane, rather than just taking
a screenshot of an empty scroll target.

## The accessible form (test 3, #830)

`--a11y atspi` opens the concrete retained form (`--a11y none` is the no-provider baseline for measurements),
with the corpus below it (scroll that area). Name is the text-input-v3 field;
Password uses a masked editor with no surrounding text or accessible content.
Tab/Shift+Tab cycle Name → Password → Language → Remember me → Review. Space
and Enter activate controls; arrows choose an open dropdown, Enter commits and
Escape closes it. Review opens a second **xdg toplevel on the same
connection**, with `set_parent` naming the form's toplevel. It asks for `correct`
to replace the initial invalid `wrong`; Save refuses the invalid value. Closing
or Escape returns focus to Review. The modal tree disables the parent's controls.

The test form has the same layout → placement and paint/semantics invalidation
boundaries as the corpus window. Pointer capture belongs to the pressed control
until release. Accessibility actions queue to the application's connection
thread and use the same editing/focus/activation paths as input. Its prototype
idle hook polls the request channel every 16 ms; that is not a phase-1 event-loop
API or an idle-power target. The native host destroys a closed dialog's role
and surface explicitly (dropping a Wayland Rust proxy does not do that).

A modal event queue must discard the parent's copies of the dialog's keyboard
stream: every `wl_keyboard` on the connection receives it. `run_dialog` records
the ending serial so the parent's queue cannot replay the correction and Tab
keys into the form after closing. This is tested by closing, restoring focus,
opening a second dialog and closing it by Escape.

The existing no-flag invocation keeps tests 1/2/4's pixel-probe layout stable.
`--a11y none` paints the identical test-3 form without a platform adapter, solely
for the comparison's RSS baseline. The two accessibility features remain enabled
by default; selecting a runtime backend does not change that build coverage.

The AT-SPI walk, fault controls, comparison and exact live Orca steps are in
`crates/nk-a11y/README.md`. Run the private harness with
`NK_PHASE0_CHECK=nk-a11y-check.py`; it reports and exits nonzero for **any**
backend failure. The separate real-Orca driver above must also pass; libatspi alone cannot pass test 3.

## Test 5: Hyalo executes the animation (#831)

```sh
cargo build --manifest-path toolkit/Cargo.toml --release --locked -p nk-phase0
toolkit/target/release/nk-phase0 --test5
```

This mode uses the same native `Window`, CPU renderer, buffer ownership and
input dispatch as the corpus/form. It presents A (a button) and B (a plain pane)
as synchronized subsurfaces, and paints the start button in the parent. Red and
blue are diagnostic colours shared with `hyalo-layer-motion-probe.c` so the same
pixel oracle can locate them. Click **Start test 5**: both get a 2-second linear
transition from x=20 to x=300, one parent commit, then the client blocks for
1.5 seconds without reading, painting or committing. Its log records `MOVED`,
`AWAKE`, layer-local `PRESS`, and `DONE serial seconds nanoseconds` from Hyalo.

For the separate spring retarget test, press **r**, then **t** mid-flight.
The responsive client replaces the target while the layer is moving right.
Hyalo preserves the presented position and velocity, reports `CANCELLED` for
serials 1/2, then `DONE` for 3/4 when it settles back at x=20. The check asserts
the position (no jump), the serials and the end; the velocity is proven by Hyalo's
unit test `a_retargeted_spring_keeps_where_it_is_and_its_velocity`, because a
screenshot cannot tell when Hyalo applied the retarget. Restart the window
between tests. Layers repaint only at creation or output scale/size changes.

```sh
NK_PHASE0_CHECK=nk-layer-motion-check.py \
  NK_PHASE0_LOG=/tmp/nk-layer-evidence toolkit/phase0/check-headless.sh
```

The isolated check and Hyalo's tty smoke run at scales **1 and 1.25**. They reuse
`hyalo-layer-motion-check.py`'s screenshot spans and pointer driving: captures
at about +250/+550 ms show both layers moving while the client sleeps; a click
at A's final position misses it, and a click at its visible position reaches it
inside its own coordinates. Both completion events must have presentation
timestamps. The original C server probe and its model-position hit-test oracle
remain in the smoke.

After each baseline, `--control-no-parent-commit` commits just the synchronized
children: the movement assertion must fail. `--control-client-motion` paints the
movement in the parent from its frame loop: it cannot advance while blocked,
so that same assertion must fail. A startup crash or an unrelated failure cannot
satisfy either control. The retarget sequence checks bounded displacement across
the new commit and continued forward motion against the new leftward target,
then cancellation and final position for both layers. Creation also exercises
64 live layers, rejection of the 65th, slot reclamation and stale-ID rejection.

`report.json`, per-run client logs, PPM screenshot sequences and `cost.json`
remain under the evidence directory (CI: `toolkit-layer-motion` in the Hyalo
artifact). Client CPU is measured with `/proc/PID/stat` during the blocked
interval, not inferred from frame callbacks; it must be near zero. Raw Hyalo
`stats` retain CPU build/render timings, frame counts and renderer context.
These isolated harness observations are not a hardware-session benchmark.

Local evidence recorded 2026-10-16 (Arch, isolated cage → nested Hyalo):

| Scale | Client CPU / blocked sample | Hyalo CPU build avg | Hyalo CPU render avg |
| --- | --- | --- | --- |
| 1 | 0.000 s / 0.573 s | 0.037 ms | 0.155 ms |
| 1.25 | 0.000 s / 0.573 s | 0.035 ms | 0.143 ms |

The Hyalo timings are its rolling one-second `stats` window sampled during
motion (37 drawn frames in each sample), including the harness context. The
native check passes both scales, both negative controls, retargeting, anchored
scale, invisible-layer input, inverse coordinates and resize/buffer reuse.
Repeated paints before the parent commit reuse the pending slot, which becomes
busy only at the child's commit; an attachment replaced before its first commit
will never receive a `wl_buffer.release`.

The existing corpus/keyboard/IME pixel regression also passes both scales with
all four fault controls. The old C probe locally passes placement/movement/input
but still receives no `done` in this cage setup (the limitation recorded in the
Hyalo skill); its complete tty run remains CI's evidence. The native window's
completion events do pass locally. These observations do not claim a CI run.

The cursor association is also checked with a real input-method-v2 popup:
`hyalo-ime-probe --cursor` draws a diagnostic green candidate pane and records
its rectangle events. In `--test5`, **o** selects a standard root-local cursor;
**i** associates the cursor with A. Starting test 5 in this diagnostic mode also
scales A about its centre. Captures prove the IME pane and its rectangle events
follow A's presented transform while the client sleeps. **o** afterwards must
restore the standard root-local rectangle. The control
`--control-no-cursor-association` leaves the cursor at its old root position and
must fail specifically at the cursor-following assertion. This is a protocol and
position test; it does not replace the owner's live fcitx5 language matrix.

The check needs the rebuilt `hyalo-ime-probe` in PATH (the Hyalo smoke builds it).
`IME_PROBE_BIN` can name a local build. `NK_LAYER_CURSOR_ONLY=1` selects only the
cursor checks for local iteration; CI runs the complete sequence.

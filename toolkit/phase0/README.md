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

## Owner's live fcitx5 matrix

Use a Hyalo session with fcitx5 running through Hyalo's input-method-v2 bridge;
configure **Mozc**, **Pinyin** and **Hangul** in fcitx5's configuration UI. No GTK
or Qt input-method plugin is needed by this client. Keep `nk-phase0`'s terminal
log and screenshots with the result. Run these steps for each engine, first at
output scale 1, then at 1.25 (Settings → Displays, or on a test compositor
`nidara-hyalo msg output OUTPUT scale=1.25`). Restore your output scale afterwards.

| Action | Expected result |
| --- | --- |
| Japanese/Mozc: type `nihongo`, cycle candidates, confirm `日本語`. | Underlined preedit changes as conversion changes; confirmation inserts it once, clears the underline and puts the caret at the end. |
| Chinese/Pinyin: type `zhongwen`, cycle candidates, confirm `中文`. | Same behaviour, with the chosen Chinese text. |
| Korean/Hangul: type the configured keyboard sequence for `한글`, then finish composition. | Jamo combine into syllables in the underlined preedit; only committed syllables enter the editable text. |
| While composing, Backspace, type a replacement, then Escape. | Preedit shrinks/replaces; Escape removes it and restores the committed text exactly. Ctrl+Z must not resurrect cancelled preedit. |
| Put committed text before and after the caret; move with arrows and replace a selection through the IME. | Surrounding context follows the caret/selection; the requested replacement affects the intended UTF-8 range and preserves neighbouring characters. |
| Compose, Tab out of the field, Tab back; repeat while clicking outside the field. | Composition is cancelled on focus loss; no late commit enters a field that no longer has focus. Returning permits a fresh composition. |
| Start a second `nk-phase0`; switch windows mid-composition and return. | Only the focused window receives IME text; there is no stale composition in the old one. The second-field version of this row waits for test 3's form. |
| Restart fcitx5 using its normal restart action while the field is focused, then compose again. | The bridge reconnects and new preedit/commit reaches the same field without restarting the client. |
| Compose near the right edge and after several lines; scroll the field/document while it remains visible. | The candidate window stays next to the visible caret, including wrapped lines and both scroll offsets. |
| Repeat candidate placement at scale 1.25. | It follows logical surface coordinates, with no 1.25× displacement. |
| Disable the engine; with a keyboard configured for a Compose key, type Compose, apostrophe, `e`. With a dead-key layout, type acute then `e`. | Each produces `é` once. Compose/dead-key prefixes insert no partial text; an invalid sequence can be cancelled. |
| Hold a letter, then Backspace; release. | The configured delay/rate repeat; releasing, losing focus or removing the keyboard stops repetition immediately. |

Record pass/fail per engine, action and scale; include compositor/client revisions,
fcitx5/engine versions, layout and screenshots showing candidates at the caret.
Do not mark test 2 passed from the scripted CI probe alone. IBus is not promised.

## Boundaries still ahead

There is one normal editable field, no form, password UI, accessibility adapter,
menus, dialogs, dropdowns, layer-animation client or GPU/dmabuf path. Those belong
to later issues. `nk-wayland::TextInput` already enforces the password wire rule:
no surrounding text for password purpose, including resetting prior context on a
purpose change. The UI's password/Orca evidence waits for test 3.

The app retains stable node IDs and distinct layout/paint/semantics invalidation;
measure precedes place, one node owns focus, and the pressed node captures the
pointer until release (focus loss releases capture). There is no widget library.
The CPU renderer takes font bytes, face index, normalized variations and glyph
positions directly from `nk-text`, including Noto bitmap emoji. Buffers are native
ARGB8888, premultiplied sRGB; only a released shm slot is written. Fractional scale
changes buffer dimensions and viewport destination together; material shapes,
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

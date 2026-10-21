<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# #873 local acceptance — 2026-10-19

Code revision: `307068b2db501c65e5e97b672bdcc3698dc9fce1`.
Rebased onto main `4cb2b2bde8b859423fcb1ab7b4fb13d12df4de5f` after #872 merged;
this includes the amended D7 decision (#877). Claude's #876 review is addressed.
No implementation changes to Hyalo, Config1, Settings or phase0.

## Toolkit checks

- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`: PASS.
- `cargo test --workspace --locked --offline`: **47 passed**, none failed/ignored.
  nk-widgets: 14 integration tests and 6 unit tests. The four new unit tests cover
  independent sidebar scroll/reveal/clamping, vertical/horizontal title-layer scroll,
  collapse/expand midpoint reflow on the same curve in D7 and D5, window-owned
  breakpoint, overlay geometry and dismissal by page choice, outside click and Escape.
  Existing coverage includes retained Layouts, invalidation, focus/capture, ids,
  generations, hidden/offscreen, fonts, full-root geometry and missing capabilities.
- Cargo.lock includes the two new packages; fmt, skill-docs, ci-scope self-test,
  shell/Python syntax and git diff whitespace checks: PASS.

Commands use `--manifest-path toolkit/Cargo.toml` from the repository root.
Builds use `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0`. Rust 1.99.0, libatspi 2.62.1, Arch Linux,
kernel 7.2.9-zen1-1-zen, AMD RX 5700 XT / Mesa 26.2.4.

## Full widget acceptance through libatspi

**22 oracles PASS at scales 1 and 1.25; all 44 applied controls CAUGHT.**
No subset or skipped scale. Each control fails its own assertion after an independent
semantic-publication barrier; timeouts/crashes are infrastructure errors, never catches.

The original 19 cover roles/names, selected state, label relations, hidden removal,
visibility at rest, Tab/Shift+Tab, checked state, offscreen retention, reveal, pane
occlusion and two committed material layers at the widget bounds. New walks prove:

- The last of 20 sidebar pages is revealed within a short window by focus. Its
  control restores the actual old sidebar offset after focus and fails this oracle.
- Collapse releases the leading inset and reflows normal rows symmetrically. Its
  control restores the sidebar-width inset and actually remeasures/repositions rows.
- Narrow-window auto-collapse opens an overlay using the title button; rows keep
  their zero-inset geometry. Its control gives the overlay a leading inset and reflows it.

New baseline walks and controls save before/after geometry in `observations.json`.
Every fault is logged where applied, and each `caught.json` identifies its own assertion.
The checker supplies `--content-width` from exported WINDOW_LAYOUT.contentFloor
(560 here), a fixed property of the demo window. Thus the docked fixture fits the
private output at both scales; the ordinary demo still defaults to content=800.
Narrow mode opens one logical pixel below sidebar+content, independent of the page.

Hyalo: unmodified #875 source `f54fe6d456168ba3950d091e45600ebeb678d9cd`, built
separately into `toolkit/target/hyalo875`; no Hyalo code is included here. The docked
IPC lists sidebar `(0,0,250,480)` and title `(250,0,560,48)`, with a declared glass
shape each; root content spans `810×480`. The root-painted-sidebar control removes
the layer entries and is caught.

```sh
HYALO_BIN="$PWD/toolkit/target/hyalo875/release/nidara-hyalo" \
NK_SETTINGS_DATA=/path/to/exported/settings-data \
NK_WIDGETS_LOG="$PWD/toolkit/target/widgets-review-307068b2" \
    toolkit/widgets-demo/check-headless.sh
```

Evidence: `toolkit/target/widgets-review-307068b2/`: environment/result JSON,
per-scale baseline trees/windows/geometry and per-control caught/applied logs.
Demo SHA-256: `e65b1e9d3daed7e7358fc5df3804bdc738b4932bf1e12864211612db0c188364`.
Hyalo SHA-256: `7afec05e9e056aab1b9b6b9a149f0bf1de90209fbd24a65844796c664d63372e`.
An earlier run caught the new auto-collapse on the smaller 1.25 output: its sidebar
was correctly closed, so it was not a valid docked fixture. That failed run is not
counted; the compact window property above makes the fixture explicit.

## Phase-0 compatibility

The existing `scripts/ci/nk-a11y-check.py` ran unchanged against revision 05bb2865's
phase0/provider (unchanged by the subsequent widget-only title-padding fix) on the same compositor: **18/18 checks PASS, 18/18 controls caught**.
This includes text/selection, password, active/focus, dropdown, dialog/error/restore
and remote actions. Evidence: `toolkit/target/phase0-a11y-05bb2865/a11y/report.json`
and per-stage logs. The existing hyalo-ime-probe helper is built in target/.

## Evidence limits and remaining integration

This proves structure/input/AT-SPI on private nested Hyalo, not visible glass or
presentation. Local EGL still reports BAD_ALLOC/BAD_SURFACE. Real fcitx5/Orca and
visible-frame checks remain vkms CI gates; no speech/engine success is inferred
from libatspi. D5 is unit-tested per the contract; no foreign-compositor run added.

CI runs the complete checker after the original phase0 and real fcitx5/Orca matrices;
ci-scope keeps nk-widgets and its demo in those gates. #875 must merge before this
head can pass its strict layers oracle in main-based CI. The main rebase after #872
is complete; a further rebase/integration after #875 remains, followed by the full
Hyalo job. This remains a draft for Claude's review, not ready to merge.

The demo still reads the permitted panel stub by name. Claude owns its sized tone
ramp/export (the fixed dark ceiling is right for the sidebar, not a 48px title pane),
Hyalo's layer glass and the graded-title A/B decision; none is claimed fixed here.
Builds/evidence/logs stay in target/; private runtime sockets live under
~/Nidara/ChatGPT/ and are removed on exit. Nothing new is built or logged in /tmp.


## Glass export schema correction (2026-10-20)

CI run 39368240534 reached the widget checker but the demo exited before readiness:
`missing panel material field`. The installed #881 export uses `variants` and
`pieces.panel` size steps, not the retired stub's TONES/SHADOWS/DEFAULTS keys.
The reader now requires the installed export, selects dark/reduce-transparency
from the portal, and resolves the rounded short-side step independently for each
pane on resize. The switch measurement stub remains; no visual constants were added.

Validation of the local correction on top of 3520011a:
- `cargo test --locked --manifest-path toolkit/Cargo.toml -p nk-widgets-demo -p nk-widgets`:
  23 passed, none failed or ignored. The real exported panel fixture covers all four
  variants, title/sidebar sizes, ramp boundaries and malformed/stub rejection.
- The same packages' clippy (`--all-targets -- -D warnings`), workspace fmt,
  skill-docs and whitespace checks pass.
- Private bwrap + Cage + installed `/usr/bin/nidara-hyalo`, software GL,
  `NK_SETTINGS_DATA=/usr/share/nidara/settings-data NK_WIDGETS_STAGES=frame`:
  frame baseline PASS and applied frame control CAUGHT at both 1 and 1.25.
  All four clients published CONTENT_READY and A11Y_READY.
  Evidence: `toolkit/target/glass-export-evidence` (environment, hashes and logs).

This is a targeted local startup/AT-SPI check, not a rerun of the full vkms,
widgets, real-Orca or fcitx5 matrices. CI has not been relaunched for this change.
The demo's existing compositor-painted panes still do not request adaptive ink
or client-painted blur; this correction does not implement #889.


## D7 live-review corrections (#898, 2026-10-21)

Local work builds on main `6b252faa`, including #897 and the #896 contract.
These changes do not implement #889 or change a protocol XML.

- Structural container names remain semantic but are not painted as labels. The
  pixel regression compares buffers with changed container names in D7 and D5,
  while changing an actual Page label must change pixels. Restoring the previous
  implementation failed its own assertion (`container name painted as text`).
- Floating sidebar bounds use exported padding/group-radius provisionally.
  Pixel tests at scales 1 and 1.25 preserve layer-local content through sampled
  transitions in both directions and check transparent rounded corners. This
  does **not** establish window-bound clipping during compositor animation.
- Header blur has contiguous C bands and a monotone background fade with no
  divider; opaque/reduced-transparency paint is covered. The owner's provisional
  recipe is JSON data, not a final visual calibration.
- Server controls reserve their actual left/right layout. Retained fallback
  buttons preserve keyboard/AT-SPI activation and return when no server layout
  is present. Unit tests do not prove live minimize/maximize/close interaction.

32 focused Rust tests pass (nk-wayland, nk-widgets and the demo), with no ignored
tests. Clippy for those packages plus nk-render with all targets and warnings
denied passes. Workspace formatting, skill-docs, ci-scope self-test, Python syntax
and whitespace checks pass. The full workspace, real Orca/fcitx5 and vkms have
not been rerun locally.

Private Cage/Hyalo with bwrap and software GL completed 23 libatspi oracles at
scales 1 and 1.25; all 46 applied controls failed their own assertions. This first
full run (`target/d7-full`) overlapped a rebuild for the app-supplied fallback
labels, so it is not evidence of a single immutable final executable. A separate
`target/d7-final` run used a fixed executable copy and also completed all 23
oracles at both scales with all 46 applied controls caught (result.json).
This certifies be80702c; the subsequent physical-band snapping correction is
covered separately below, not by that executable.

Fixed demo SHA-256: `a27b3f08fe45e3bdd4ff7b06f87141ad4b10ecbf30f010c9478b801f5e4a44d6`.
Installed Hyalo SHA-256: `d8109f29f5fd15873a0b3709059f436fbb64652aaf33398d54c7e56ed60a1fdd`.
The compositor is the installed binary, not a fresh build of the current main;
this run cannot certify #897's final source or Claude's pending buffer clipping.
Preview images are in `target/d7-preview/scale{1,1.25}/baseline-window-controls/`.

At scale 1 the IPC shows sidebar `(12,12,226,456)`, header `(250,0,560,72)`
with three blur bands, and server controls `(710,8,88,32)` root-local. The initial
occlusion fixture failed because its old row width no longer fitted inside the
floating pane; narrowing the fixture to its new inner width fixed the setup
without weakening the assertion. Earlier failed runs are not counted as passes.

Claude clarified the reported slide: text and glass move together, but content
escapes the window edge while glass is clipped. Composition sends the layer's
Position transition to Hyalo. Claude owns the compositor correction; pane-local
pixel stability is not presented as a fix for that bug. Final appearance, margin/
radius choices and real-session acceptance remain with the owner live.

Review follow-up: Claude found no blocking composition/reservation issues. Interior
blur-band edges are now snapped to shared physical-pixel boundaries; the previous
unrounded edges could split one pixel between antialiased shapes at other heights/
scales. A regression covers heights 71/72/101 at scales 1/1.25/1.5/1.75/2, including
contiguity and grade continuity. This is a geometry oracle, not a new rendered
compositor seam measurement. The 72px recipe at scales 1 and 1.25 is unchanged.

The unrounded formula was restored as an applied control and was caught by that
new assertion (`blur boundary inside a physical pixel`). The corrected formula
passes; the focused Rust total is now 33 tests, and clippy remains clean.
Control evidence: `target/blur-band-control.log`.

## D8 focus modality (after #901 integration, 2026-10-21)

Pointer/root and presented-layer focus now preserve semantics/selection without
a ring; keyboard navigation paints a rounded ring. A pixel test covers both D5
and D7 at scales 1 and 1.25, including clicking outside a target and rounded
corners. Forcing unconditional ring painting is CAUGHT by its pixel assertion
(`target/focus-visible-control.log`). Focus width is explicit provisional data
in `toolkit/tokens/list.json`, from the current kit's focus-ring measurement;
final visual values remain for the owner live. This is not a new live/AT-SPI
matrix result. Hover/separators and the named-width component from D8 are still
pending; this commit does not claim all of D8.

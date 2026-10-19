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

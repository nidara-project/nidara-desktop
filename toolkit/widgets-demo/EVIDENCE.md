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

## D8 list highlight/separators follow-up

Claude's review of the first focus change required one shared inset silhouette.
Selection, hover and ring now use that function; buttons/switches use their
capsule/track radius. Provisional list-token data supplies inset/opacity and
separator thickness, while separator colour comes from exported --nidara-border.
A new test checks actual hover-fill and separator pixels at 1 and 1.25, pointer
leave, hidden hovered nodes, selected/hidden neighbors, no last separator,
control-only row labels without hover, and capsule/track geometry. Removing only
the hover fill is CAUGHT at its own pixel assertion (target/list-hover-control.log).
The focused total is now 35 tests. Named content widths remain pending. This
change has not had live owner validation or a new full private libatspi matrix.

## D8 named form width

The demo chooses `PageWidth::Form`; the appearance seam supplies existing
WINDOW_LAYOUT preferred/floor tokens (800/560). Unit geometry covers both D5/D7,
wide/contracted/floor overflow, horizontal reachability, changing the named kind
without stale measurement, and five collapse timeline samples. Centring against
the whole window instead of the space beside the sidebar is CAUGHT at its own
assertion (`target/content-width-control.log`). `Reading` has an explicit missing
tokens error rather than an invented width. The focused total is now 36 tests.
List-token export and combined live/private acceptance remain separate pending
work; these unit results do not certify those paths.

## Combined D8 private acceptance — 216ed5e4

The complete existing libatspi matrix passes with the combined focus, shared
highlights/separators and form-width changes: **23 oracles at scales 1 and 1.25,
all 46 applied controls CAUGHT**, no subset. `target/d8-combined/result.json`
records the result; each scale/stage retains its tree, observations and control
logs. The fixed executable in target/d8-bin/nk-widgets-demo has SHA-256
`c8a89711b34aa502012d792cda3fd5918cec390b61a993054812461e644255ad`.
The new D8 visual/geometry claims remain covered by the focused unit pixel and
geometry oracles above; they are not new claims in the libatspi matrix.

This used the installed Hyalo and software GL inside the private bwrap/Cage
harness with an isolated portal fixture. It does not establish current-source
#899 clipping, #900 integration, real Orca/fcitx5, vkms, frame timing or the
owner's live visual acceptance. The list-token export/installed-data reader
remains pending #900 integration; no new CI run or publication was performed.

## Installed list export after #900 integration

Main #900 is integrated before editing its exporter. `list.json` now uses the
shared default/variants mechanism and is exported as `list` in every panel step.
The demo reads the exact installed portal variant; absent/invalid fields fail.
No list visual values are compiled into the application.

- Real export with local Sass and settings-tokens-check: PASS (108 colour sets,
  four glass variants, every panel step complete). A temporary light-only
  highlight override affects every light panel step and no dark step; defaults
  remain intact. The source is restored after that check.
- Dropping highlight from one exported panel step: CAUGHT at the list completeness
  assertion (`target/list-export-control.log`); CI has the same discriminating
  control in the existing export step, with no extra job.
- 37 focused Rust tests and clippy pass. The new reader test covers four portal
  combinations and missing/out-of-range/inconsistent data.
- Private startup against `target/list-export`, installed Hyalo/software GL:
  frame baseline PASS and applied frame control CAUGHT at scales 1 and 1.25
  (`target/list-export-startup`). This targeted repeat checks the new reader,
  not another full matrix or current-source Hyalo acceptance.

Formatting, skill-docs, ci-scope self-test, Python checker syntax and whitespace
checks pass. No live visual acceptance or new vkms/Orca/fcitx5 run is claimed.

## Final export boundary — owner decision through Claude #46

This supersedes the earlier per-panel/per-glass-variant placement of list data.
`tokens/glass.json` is material-only. `tokens/components.json` has four mode
variants containing `list`, common padding/gap/radii and named widths. These
common/form values alias the existing kit measurements; no new visual numbers
were chosen. Reading width stays unmeasured. Group + rows applies D8 once.

Real export and completeness checker pass; the export contains no list objects
in glass.json. Removing components.variants[0].list.highlight is CAUGHT by its
own completeness assertion (`target/components-control.log`). A temporary
light-only list override changes light variants and preserves dark defaults.
The four demo tests and demo all-target clippy pass after changing the reader.
Private startup with `target/components-export` passes frame baseline/control
at 1 and 1.25 (`target/components-startup`). This checks the final file boundary;
it does not repeat or extend the full matrix/live evidence above.

### #904 button silhouette review correction

Ordinary buttons retain Metrics.radius. ButtonShape::Capsule is explicit; base,
hover and focus use the same resolved silhouette. Switch tracks remain capsules.
The shared-shape regression checks ordinary/explicit-capsule/restored-rounded
buttons and rejects shape assignment to a label. Reinstating the original
half-height radius for ordinary buttons fails its own assertion
(`target/button-shape-control.log`: CAUGHT). All 28 nk-widgets tests, clippy,
formatting, skill-docs and diff checks pass. This does not add a live visual
acceptance claim or repeat the historical compositor matrices.

### #904 form card overflow reported in live review

The demo's deliberately wide probe row makes Group.measured.width include
its overflow. Placement previously used that width for the card, although the
ordinary rows were measured within the form column. The card now uses the
group's constraint; measured overflow remains available to horizontal scroll.
The regression checks D5/D7 at widths1262/900/650, normal row alignment, scroll
extent and pixels at scales1/1.25. A deliberately oversized painted card is
CAUGHT by its own pixel assertion (toolkit/target/group-card-control.log).
All29 nk-widgets tests pass. This is source-level geometry/CPU-pixel evidence;
the owner's live screenshot reported the problem, not acceptance of this fix.

### #904 interactive title dragging and double click

Root and layer button events retain their own wl_pointer serial/time. Blank-title
presses request xdg_toplevel.move using that serial; double click uses the same
ToggleMaximize as the existing button. The explicit demo interval400ms is sourced
from Hyalo's existing GTK policy. Unit tests cover exact serials, interval boundary
and wrap, controls including disabled ones, server reservations, hidden titles,
content below the title and overlay dismissal priority. Removing the exclusion
of controls is CAUGHT by its own assertion (toolkit/target/title-drag-control.log).
39 focused tests pass; workspace check/clippy, fmt, skill-docs and diff pass.

The final private bwrap/Cage/software-GL run is toolkit/target/title-drag-accept
with driver toolkit/target/title-drag-accept.py. It compares the move request's
serial to the initiating button event's trace, checks the released window's
changed position, then maximizes/restores using double click with compositor
state/geometry assertions. Setup waits for commit and a compositor capture before
clicking changed geometry. This is not a wp_presentation timing oracle: this winit
backend did not supply presented feedback. Early driver attempts had an event
log-parser mismatch, inspected model position during a grab, or clicked before
the new geometry committed; none is counted as a discriminating control.

All four final combinations D5/D7×1/1.25 PASS, including restore.
Demo SHA256 bc7c455bd4ca5d7af763f36197cbed979b302a5b7233f115e5c91d12c9d0ceff.
Hyalo SHA256 3e264d3d0aba3a731f44e707fa0713361f09e0c57c71cf2c53057f9ef1dad3fa
(the preserved cc39b569/#899/#900 build supplied by Claude). No live session
acceptance or compositor timing claim is made.

## #889 retained foundation (historical source evidence)

This section records the original private source branch, not acceptance of the
rebuilt split commit. Its later original controls/logs are not rerun or attributed
to the split.

The original branch adds typed ControlMaterial validation/staging and a retained capsule
Panel with existing Buttons. The focused Rust total is 41 tests (three new
transport tests, one new retained-capsule test); clippy passes. The capsule test
covers 32/60/88 widths at the current geometry, accessible names independent of
glyphs, ordering, actions/focus, root/layer-local capture cancellation, disabled/
removed controls, metric changes preserving IDs and off-window visibility, in
D5/D7 layouts. It is not a compositor/material or visual acceptance result.

Capsule geometry is explicit provisional component data: height32/button24/edge4
from current server controls, pitch derived. Export/checker pass. Dropping edge
from one component variant is CAUGHT by its own geometry assertion
(target/capsule-geometry-control.log), with the same lightweight CI control.
The server-side mirror check/uniform cleanup belongs to Claude and is pending.
Layer material/coverage, demo wiring and visual/idle/performance oracles are not
implemented by this retained foundation. No #889 implementation is published.

The extended live-metric assertion initially caught stale child widths (60 instead
of76 after raising button_min). The setter now invalidates child measurements,
not only the panel. The full focused suite is rerun after that correction.

## Retained capsule split on current main (2026-10-23)

This local cut is reconstructed from the retained foundation and its metric-change
fix on the separately checked control-material transport. Existing main choices,
range widgets, title interaction, shaped buttons and D8 behavior are preserved.
The old button-silhouette correction is already on main and is not replayed.
Original worktrees and fixed native artifacts are untouched.

`target/retained-capsule-split-restored-tests.log` passes 53 nk-widgets lib and
integration tests (16 + 7 + 15 + 8 + 5 + 2), with required settings exports. The
capsule regression uses synthetic dimensions unrelated to the old window-control
geometry: it checks stable IDs/names, actions, root/layer capture, disabling,
removal, relocation, metric changes and clipping. Its first smaller synthetic
height failed because the shaped text naturally required more height; that fixture
failure is retained in `retained-capsule-split-final-tests.log`, not acceptance.

`target/retained-capsule-split-clippy.log` passes nk-widgets/nk-wayland all targets
with warnings denied. Format, skill-docs and diff checks pass. The token exporter
runs from this worktree into `target/capsule-split-data`; all four component mode
variants pass the checker. Dropping edge in the first variant is caught by the
checker's own capsule completeness assertion, recorded in
`target/retained-capsule-split-token-control.log`.

This cut exports the existing provisional capsule token without applying a new
window-control design. Issue #921 remains separate. There is no demo runtime token
consumer, capsule material/coverage composition, D5 fade or native UI walk in this
cut. No rendered glass, AT-SPI/Orca, idle/performance or owner-live result is claimed.


### PR923 geometry schema repair (2026-10-23)

Independent capsule gap=4 joins height32/button24/edge4. Current exported values,
widths, centers and hit boundaries remain unchanged; gap no longer derives from
outer edge. CONTRACT precedes schema, canonical skill/README match. Hyalo width,
hit boundaries and shader slot formula now express independent gap; its default
mirror test reads the actual capsule source.53 widgets tests PASS,3 filtered
window_controls Hyalo tests PASS (includes retained32/60/88/currentboundaries and
mirror test), Hyalo alltargetClippy-Dwarnings PASS.108sets/4variants exporter and
checker PASS; deleting edge or gap fails own capsule-geometry assertion. Logs
in repair worktree toolkit/target/gap-repair-*.log. No new live/pixel acceptance
or change to #921 visual values. Original published branch remains untouched;
correction is prepared on codex/889-retained-capsule-repair for review.

### #889 installed control reader (historical source evidence)

The following results belong to the original private source, not this rebuilt cut.

The real export fixture retains every control step and portal variant. Three new
tests cover exact dark/transparency variants, rounded integer-side step selection,
state washes/inks, reduced-motion durations, null inkTone meaning the base tone,
and refusal of missing/ambiguous/invalid data without defaults. Geometry comes
from components.json separately. Removing side rounding is CAUGHT by the size
assertion (`toolkit/target/control-reader-size-control.log`). The focused suite
now passes 44 tests (8 wayland, 14 widget unit, 15 foundations, 7 demo), plus clippy,
fmt, skill-docs and diff checks. An initial test exposed the explicit null inkTone
in light mode; its interpretation now matches Hyalo's Shape.

The reader is not yet connected to Appearance or a capsule layer. There is no
new compositor, D5 feedback, idle/performance or live visual acceptance claim.
Shared target artifacts from #898 initially hid #889's exported transport types;
cleaning only nk-wayland artifacts and rebuilding resolved that cache mismatch.

## Capsule recipe reader split on current main (2026-10-23)

This cut restores the existing ControlRecipe and capsule_metrics reader above the
retained and transport cuts, preserving main's demo choices module. It exposes a
callable reader; Appearance and the layer manager are still not connected. The
capsule constructor explicitly selects the existing Capsule button shape.
The later known fix for an optional state ink of JSON null is retained here:
null/absent override means shared material ink. A malformed colour remains an error.

`target/capsule-recipes-split-restored-tests.log` passes 59 tests: 53 nk-widgets
lib/integration tests and 6 demo tests. The generated-export test reads this
worktree's `target/recipes-split-data`, generated by the real exporter, and requires
NK_SETTINGS_DATA/NK_REQUIRE_EXPORT. All four portal combinations and every size
step parse and validate as wire payloads. Separate retained source-fixture tests
check exact state values, rounding, malformed data and null overrides. Test pane
and component fixtures use synthetic geometry rather than pinning old 88x32
window controls; #921 remains outside this cut.

The no-rounding production fault compiled and failed its own exact size-step
assertion in `target/capsule-recipes-split-size-control.log`. Source was restored
before the full 59-test pass. Demo/widgets all-target Clippy with warnings denied,
formatting, skill-docs and diff checks pass. The first command mistakenly asked
for a demo library target (there is none); its log is retained separately and is
not acceptance. No artifact cleanup was used.

There is no native UI, rendered material/coverage, D5 fade, AT-SPI/Orca, idle,
performance or owner-live acceptance for this rebuilt cut. Original native fixed
binaries and historical evidence remain untouched; those results are not assigned
to this split commit.


### PR924 gap reader and mandatory export CI repair (2026-10-23)

The reader now requires independent gap, rejecting missing/negative values;
synthetic variant edge5/gap8 retains8 instead of deriving5. Compiled oldmapping
fault fails OWN gap8 assertion observing5 after valid height/padding parsing;
recipes-repair-edge-gap-control.log. CI's unit-test step now sets absolute
NK_SETTINGS_DATA to the exports generated earlier in the same job. Removing the
environment reproduces its OWN exports-required failure; ci-env-control.log.
Full restored workspace: 141 tests PASS, required exports, plus demo alltarget
Clippy-Dwarnings/fmt/skilldocs/diff. Actual current manifest/i18n in own target,
unchanged exporter tokens symlinked from gap-repair export. Initial local full
suite lacked the legacy build/settings-data path (2Settings failures); adding
that path to the same complete data matches CI, without skipping/relaxing tests.
Published heads untouched; local repair branch awaits owner review/publication.

### #889 capsule composition integration (local)

### #889 capsule composition integration (historical source evidence)

The following results describe the original source, not the rebuilt split.

CapsuleComposition stages one layer per panel, coverage-only buffers and explicit
state/ink payloads together with placement. Stable idle state IDs preserve
compositor fade-out; frame signatures suppress unchanged capsule repaints.
Appearance now loads control and opaque fallback variants plus capsule geometry.
The opt-in --capsules demo provides window controls and an action toolbar.
D5 draws the exported opaque base and immediate state feedback. Timed D5 state
fading, backdrop fixtures, compositor visual oracles and idle/performance remain
pending; no completion or live acceptance is claimed.

The new unit oracle covers monochrome coverage/no background, unchanged coverage
pixels on hover, normal/destructive state payloads, idle IDs, reduced-motion
duration0, disabled/hidden handling, layer input capture/cancel/activation and
opaque D5 base at scales1/1.25. A client-painted coverage background is CAUGHT by
its own assertion (toolkit/target/capsule-coverage-control.log). Total46 focused
tests and clippy pass. This is CPU/payload/input evidence, not GPU presentation.

## Capsule composition split on current main (2026-10-23)

This cut restores CapsuleComposition and the --capsules demo connection above the
reader cut. The one existing host stages coverage buffers, state regions,
placement and material on a synchronized layer for each capsule. The demo loads
its control/opaque recipes from Exports using the shared portal/Styles path.
Shared CapsuleStyle replaces demo-local state/style types. Main's choices and
range controls are preserved, and non-capsule input still reaches
Composition::event_with_window for exact-serial title dragging.

The later known opt-in correction is included: --capsules does not request server
window controls. No #921 geometry or material redesign is implemented. Test
capsule dimensions are synthetic rather than a pin of the old control design.
D5 uses its exported opaque base with immediate state feedback; timed fade is a
separate next cut. This is a compiled native application path, not a native run.

`target/capsule-composition-split-restored-tests.log` passes 60 widget/demo tests
(17 + 7 + 15 + 8 + 5 + 2 + 6), with required generated exports from the unchanged
reader cut. The new CPU/payload test covers transparent monochrome coverage,
unchanged coverage on hover, state and destructive-ink payloads, zero-alpha exit
IDs, disabled/hidden actions, layer capture/activation/cancellation and an opaque
D5 base at scales 1/1.25. Test LayerEvents carry synthetic serial/time fields;
they are not physical input or native Wayland event evidence.

A production coverage-fill fault compiles and fails the test's own background
assertion in `target/capsule-composition-split-coverage-control.log`. Source was
restored before the full 60-test pass. All-target Clippy for widgets/demo with
warnings denied, formatting, skill-docs and diff checks pass. The first rebuilt
demo failed compilation because the old reader used pre-shared-Styles variables;
it was adapted to current Exports/portal values, and the failure log is preserved.

No native compositor walk, new AT-SPI/Orca, presentation, idle/performance or
owner-live acceptance is claimed. Historical fixed native evidence belongs to
its original binaries and is not acceptance of this rebuilt split. Those binaries
and original source worktrees are untouched.

### PR926 component/server integration repair (2026-10-23)

Prepared #921 on top of the independent-gap schema (PR923 repair). Its component
export changes together with the existing owner-approved server design to
height24/button16/edge4/gap8. The actual mirror test first failed its own height
assertion (export32 vsserver24), then passed after synchronization; no tolerance
or predicate relaxed.3window_controls+31wm tests PASS, Hyalo alltargetClippy-
Dwarnings, actual108sets/4variants exportchecker, kitSCSS and3listingdiagnostic
regressions PASS. Corrected924reader consumes these actual exports in all four
modes (1focusedtestPASS). Logs target/921-*.log. No Rust header implementation
or live kit visual approval added; that existing #926 limitation remains.

Proposed PR926 base: codex/889-retained-capsule, landing the gap schema before
its visual-value change. Original published branch untouched, no push or merge.
Common startup diagnostic comes from that base; private-fixture run passing is
not proof of the real CI shell startup failure's underlying cause fixed.

### #889 opaque state fade (historical source evidence)

These results describe the original source, not this rebuilt split.

CapsuleComposition samples D5 wash transitions on the shared exported fadeMs,
using Hyalo's linear RGBA law and retargeting from the current sample. The retained
painter consumes the sample, including hover-out after hover is gone. First
appearance is immediate; reduced motion snaps an active fade. Hidden/removed
buttons retire their samples, D7 clears the client timeline, and settled samples
stop invalidating paint. The lab's poll interval is short only while animating.
Ink overrides remain selected with button state, as in the D7 protocol; this
change does not add an independent ink interpolation or alter hit testing.

The existing retained capsule test now checks actual D5 pixels at start/mid/end,
hover-out, interruption/reversal, reduced-motion snap, hidden cleanup and settled
no-op updates using explicit test times. Bypassing the stored sample in the
painter is CAUGHT by its own midpoint pixel assertion, with log
`toolkit/target/capsule-d5-fade-control.log`. It is not a timeout or crash catch.
This is CPU/payload acceptance, not a new native compositor/D5 capture run.
Earlier native capture results retain their exact fixed-binary identities.

### #889 idle wash hue parity (historical source evidence)

Source audit found idle client washes used transparent black, while Hyalo server
controls preserve hover RGB and zero only alpha. Straight RGBA interpolation
therefore produced different visible fading. D5 samples and D7 state payloads now
share the matching normal/destructive hover hue with alpha zero. Tests assert
both idle payloads and actual D5 midpoint pixels follow the linear alpha fade.
Restoring transparent black is CAUGHT by the own normal-idle-hue assertion in
`target/capsule-idle-hue-control.log`; source is restored after the mutation.
Earlier native fixed binaries do not certify this correction, and native D5 fade
acceptance remains pending.


## Opaque capsule fallback split on current main (2026-10-23)

This cut restores the existing finite D5 wash timeline and its later idle-hue and
midpoint corrections above the composition cut. It samples the exported duration,
starts immediately on first appearance, retargets from the current sample and
snaps with reduced motion. Hidden/removed entries retire; disabling opaque fallback
clears its samples. Idle retains normal/destructive hover RGB with alpha zero,
matching the same target sent to D7. No client wash timeline runs for D7.

The lab source and its documentation are excluded from this cut. The incidental
client paint-count API from historical lab context is also excluded; this cut
publishes no rendering or presentation counter. The existing demo already supplies
poll/sync opportunities; application callers stop requesting fade frames when
is_animating() becomes false. No permanent animation is added.

`target/capsule-fallback-split-restored-tests.log` passes 60 widget/demo tests
with required generated exports from the unchanged reader cut. The deterministic
CPU oracle uses explicit times and actual painted pixels: start/mid/end, constant
hue during fade, hover-out, interruption, reduced-motion snap, hidden cleanup and
settled no-op updates. It does not infer idle CPU usage or native frame counts.
A compiled production fault that bypasses the stored wash fails the test's own
painted-midpoint assertion (`target/capsule-fallback-split-snap-control.log`).
Source was restored before the full suite passed. Widgets/demo all-target Clippy
with warnings denied, formatting, skill-docs and diff checks pass.

There is no new native D5/fractional run, compositor glass/ink-curve result,
AT-SPI/Orca, timing/performance or owner-live acceptance for this rebuilt cut.
Original source worktrees, fixed binaries and their exact historical evidence
remain untouched. #921 and backend/bar changes are outside this extraction.

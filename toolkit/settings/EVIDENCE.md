<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Rebuilt local shared material-reader cut — 2026-10-23

Parent: corrected external harness cabf26e8. This extracts the independently
compiling reader-ownership portion of existing015a6dc4, using the current readers
rather than overwriting them with older copies. PanelMaterial, ControlRecipe and
capsule_metrics and their six tests/fixtures move once into nk_settings::material;
the demo modules become re-exports. Current strict variant/size rules, shared
CapsuleStyle, optional-state-ink semantics, generated-export tests and synthetic
geometry remain intact. No Shell, routing change, host/provider or native main
loop is included in this cut.

Contract updated before public module exposure; skill documentation in the same
change. Three existing Settings test helpers now honor absolute NK_SETTINGS_DATA,
matching the existing environment contract rather than requiring build/ output.

- target/material-readers-split-complete-tests.log: 50 Settings/demo tests PASS
  (33+2+10+3+2), NK_REQUIRE_EXPORT=1 and absolute target/material-readers-data.
  Six reader tests run in Settings, not duplicated in the demo. Token exports are
  reused through a target/ symlink from unchanged cut3 data; this cut's actual
  export-settings-data.mjs generates current manifest and i18n under its own
  target/material-readers-data. Source exporters/tokens are unchanged.
- target/material-readers-split-clippy.log: Settings/demo all targets -D warnings
  PASS. fmt/skill-docs/diff pass. Builds use incremental0/jobs1/shared target.
- Initial target/material-readers-split-tests.log records two honest failures:
  the earlier token-only export lacks i18n/en.json required by Exports/Styles.
  No assertion relaxed or skip introduced; generated current manifest/i18n then
  completed all50 tests. These initial missing-data failures are not acceptance.

This is a relocation of already-tested readers, not a new decoder. Prior cut3
compiled rounding control remains historical to that head, not rerun or newly
attributed here. No native Settings/window/dialog, AT-SPI/Orca, glass/presentation,
startup/performance or owner-live acceptance is claimed. Originals/fixed binaries
and later main features remain preserved; no publication.


## Rebuilt local retained Settings shell cut — 2026-10-23

Parent:shared readers ce959766. Extracts window.rs and its two tests from existing
015a6dc4, without replaying its reader move or overwriting later main features.
Shell assembles the existing retained sidebar/title/content Scroll and one capsule
of existing Buttons, with caller labels/metrics. Composition/CapsuleComposition
remain the host integration; no duplicate provider, parser or transport.

- target/window-shell-split-restored-tests.log:52 Settings/demo tests PASS
  (33+2+10+3+2+2), required complete exports from cut9 target/material-readers-data.
  Two shell tests use actual Exports/Styles/Tree and corpus Parley text layout:
  semantic capsule/button structure and action mapping, tentative sidebar selection
  restored until explicit mount acceptance, unknown page refusal, and both control
  sides within docked/narrow geometry with layer-layout toggled. Layer-layout is a
  CPU flag, not a native surface/allocation. Navigation uses direct Effect/selection
  calls at the assembly seam, not a real Router/native-input decision test.
- target/window-shell-split-selection-control.log: compiled production fault
  omits restoring the previous selected page. After complete shell setup and the
  action call, the target remains Page{selected:true} and the test fails its own
  assert_ne for the tentative target. No timeout or setup failure. Restored before
  full52PASS.
- target/window-shell-split-clippy.log: Settings/demo all targets -D warnings PASS.
  fmt/skill-docs/diff PASS, incremental0/jobs1/shared target.

Contract before Shell API; mechanism/skill/evidence in the same local change.
No native main executable/window walk, actual routing/mount lifecycle, portal or
Config1 notice integration, AT-SPI/Orca, D7 glass/fractional D5, startup/presentation,
performance or owner-live acceptance. The caller must supply titlebar/transition
policy before sync; this seam invents no new geometry/material numbers. Adaptive
foundations/Settings scheduling remains named debt. Original branches/fixed bins
preserved; nothing published.


## Rebuilt local pre-takeover native routing cut — 2026-10-23

Parent:Shell1089f3c2. Extracts existing7302dcb8 production correction: export the
Request object in Native as well as EntryPoint mode, while only EntryPoint owns
the legacy entry-point name. A second native instance can hand its request to the
first before takeover; transport errors are propagated rather than swallowed.
No bus name or installed application identity is changed by this local cut.

- target/native-routing-ready-restored-tests.log:50 Settings tests PASS with
  required complete exports from cut9. Three routing tests run actual private
  dbus-daemon connections; the second-instance test covers both modes, receives
  AlreadyRunning and confirms actual Navigate(appearance) delivery. Legacy entry
  ownership/forwarding behavior remains tested. Socket paths are explicit under
  this cut's toolkit/target/rb-<pid>-<counter>, no session-bus environment mutation.
- target/native-routing-ready-control.log: compiled old export guard omits Request
  in Native mode. A test-only RoutingReady Ping first confirms that the real
  object server responds; it supplies no Request/UI/provider. The second native
  handoff then returns actual UnknownInterface and fails its OWN is_ok assertion,
  before any answer-wait loop. Restored before full50PASS.
- target/native-routing-ready-clippy.log: Settings all targets -D warnings PASS;
  fmt/skill-docs/diff pass. Incremental0/jobs1/shared target.
- Initial native-routing-split-tests.log records a test diagnostic E0277 (Router
  lacks Debug), fixed by printing only the error. Initial old-guard control in
  native-routing-split-control.log timed out because no object server interface
  existed at that path. That timeout is NOT an accepted catch. RoutingReady is an
  explicit private-bus readiness fixture so the accepted control fails its own
  missing-interface result assertion instead. No timeout relaxed or swallowed.

These are real bus tests, not native Wayland/main-loop/window/Orca acceptance.
Actual application mount/visibility/available/portal/config lifecycle remains
pending, as do presentation/performance and owner-live gates. Contract/skill and
evidence in the same change; originals/fixed binaries preserved, no publication.


### Review188 — forward to the name that exists in each mode

The initial Native Request export fix still forwarded non-native pages/apps to
LEGACY, a name the installed entry point does not own before takeover. Service now
retains Mode: Native forwards directly to ENTRY, without launcher or LEGACY_START;
EntryPoint retains the previous LEGACY launcher policy. Activation/call errors
from ENTRY propagate. Production D-Bus may activate ENTRY; the private test bus
has no service directories and therefore cannot launch installed applications.
Each Bus Drop now stops its daemon and removes only its own runtime directory.

Two new real-private-bus cases exercise second native instances requesting page
network and app example.desktop with a test ENTRY owner and launcher count zero,
and missing ENTRY yielding ServiceUnknown with launcher count zero. The latter
uses the immediate D-Bus error contract, not a wall-clock threshold. Existing
post-takeover legacy launch/forward tests still pass. No session-bus environment
is mutated and no live connection/window is used.

Compiled production fault bypasses Native's direct-entry branch and takes the
post-takeover launcher path. After ENTRY/NATIVE ownership setup it fails its OWN
native-forwarded-request assertion with the fixture's forbidden-launcher error,
not timeout: target/native-routing-mode-forward-control.log. Source restored;
52 Settings tests PASS (33+2+10+5+2) in native-routing-mode-restored-tests.log,
Settings all-target Clippy -D warnings PASS in native-routing-mode-clippy.log;
fmt/skill-docs/diff pass. Earlier timeout control remains explicitly unaccepted.

Review188 on Shell cut10: current control captions use text glyphs; integration
with nk-icons remains pending. Its current y=metrics.gap placement is provisional,
not #921's accepted centered small capsule geometry. #921 and its Hyalo hover
work are outside these cuts. These limits are also named in the prepared Shell
PR body; no final visual acceptance follows from the CPU layout tests.

### Block A publication rebase, 2026-10-25

Based on capsule endpoint 575a4748 above main 8b3f9ecc, without replaying
squashed #923-#925. The shared material reader preserves the independent gap
validation from main. Its moved control fixture uses the Settings tests path.

A new capsule.windowInset token selects both corner axes independently of
common row spacing. Actual generated exports require x=12 or width-12-72, y=12
and 72x24 in both sides, narrow/docked and D5/D7 CPU layouts. The first
geometry run discriminated the body-line-height leak (27.066666 vs 24); capsule
captions now retain a layout measured at the exported button size and unit
line height. The same layout is painted. No tolerance relaxed.

Fresh 25 October: 52 Settings + 54 widgets + 2 demo tests passed with mandatory
complete exports; all-target Clippy -D warnings for all three passed. Real
token checker: 108 sets / 4 variants. Logs: target/publication-20261025/.
Initial attempts failed for a stale shared-cache artifact / moved fixture path,
and then the height assertion above; only tests-final.log is final acceptance.
No new native/Orca/presentation/performance or owner visual acceptance.

### PR934 review corrections, 2026-10-25

The shared reader commit itself now uses ../../tests/fixtures/control-glass.json;
its isolated Settings/demo suite passed (50 tests), without depending on later
window/typography changes. The geometry commit explicitly explains the caption
change: body typography measured 27.066666px for a 24px capsule, so glyph layouts
use the exported button box and unit line height. No visual vector-glyph parity
acceptance is claimed.

layout_controls reads current CapsuleMetrics from the retained tree, positions
its three buttons' capsule before layout, then invokes layout once. This avoids
the preliminary layout just to read bounds, including after staged metric updates.
Unused generic row metrics and Router::start's redundant scope are removed.
Fresh 52 Settings +54 widget +2 demo tests and all-target Clippy -D warnings
passed with mandatory complete exports (target/review-20261025/{tests,clippy}.log).
Formatting, skill docs and diff checks pass. Native D7 retry on #935 remains
pending because the active/installed Hyalo is not the #935 binary.


## Rebuilt local standard-popup transport cut — 2026-10-23

Parent:corrected routing c0ad7550 (comment-wrap follow-up to5ad1ba34). Extracts only production transport and required
consumer-constructor adaptation from existing0f42c903. The patch applies to the
current lib without replacing later main code: exact pointer serial/time title
dragging, group/choice/range behavior remain preserved. Public PopupPlacement,
run_popup, PopupDone/Repositioned and Key::serial live in the one nk-wayland host.
Child shares the parent connection, uses xdg_popup/positioner/grab/reposition and
explicit role cleanup, with Drop cleanup on errors. Ordinary close sets parent
input floor/reset; no stronger error-path parent-input claim is made here.
Probe, native checker/wrapper and historical native result sections are excluded.

- target/popup-transport-split-restored-tests.log:63 wayland/widgets lib/integration
  tests PASS (9+17+7+15+8+5+2), exports required from full cut9 data. Popup unit
  validation covers nonempty anchor/size and integer overflow; retained consumers
  and later main tests still pass. These unit tests do not create a fake Window
  or prove native role/input/cleanup behavior.
- target/popup-transport-split-anchor-control.log: compiled production validation
  fault accepts zero anchor width. The positioner validation test fails its OWN
  invalid-anchor is_err assertion. Restored before full63PASS. This is a validation
  control, not the historical native role-substitution control.
- target/popup-transport-split-clippy.log: wayland/widgets all targets -D warnings
  PASS. target/popup-transport-split-workspace.log: workspace all-target check PASS,
  covering the new public Key field/Event consumers. fmt/skill-docs/diff PASS.
  The invalid initial cargo command repeated --lib and ran no test; its error is
  preserved in popup-transport-split-tests.log and is not acceptance evidence.

Contract before APIs and skill/README/evidence in the same change. Builds use
incremental0/jobs1/shared target. No new native popup/grab/reposition/focus/cleanup,
Dropdown/AT-SPI/Orca, output-edge/fractional, glass, presentation/performance or
owner-live acceptance. Exact original fixed binaries and their evidence remain
untouched and are not attributed to this rebuilt head. No new Wayland host.

## Local popup diagnostic extraction (#915, cut 13)

Source extracted from 0f42c903: popup-probe, nk-popup-check.py and the wrapper
using the existing private headless host. No new transport/provider or CI job.
Review #193's nested-loop limit is now explicit in CONTRACT/README/skill:
parent painting/configure/scale/appearance servicing is suspended while open.

Validation PASS: actual `cargo build -p nk-wayland --example popup-probe`,
Clippy all targets with `-D warnings`, Python AST, shell syntax, workspace fmt,
skill-docs-check and diff whitespace. Validation is compilation/static only (logs under
`toolkit/target/popup-probe-split-*.log`). No native/EGL run was attempted, and no
rebuilt-head role/grab/reposition/dismissal/cleanup/control catch, accessibility,
Orca, fractional/output-edge, glass, presentation, performance or owner-live
acceptance is claimed. Historical binary evidence remains at the original source;
this commit does not copy those PASS claims. The existing bounded driver and
fault are prepared for later native validation, not reported as having passed.

## Local Dropdown retained-model extraction (#915, cut 14)

Existing4679a10e production delta and its three tests extracted onto current main
features/capsule stack; module registration adapted to current ordering. Stable
ComboBox/Option selection, guarded activation, independent expanded state and
model-only zero-area options. Closed Button geometry/paint remain provisional;
trigger tokens, popup MenuList, controller and builder are later cuts.

Only CPU retained-model/layout/semantic tests are intended here; no native
Selection signal, popup input, AT-SPI/Orca speech, Config1 write or owner-live
acceptance is claimed. Prior popup diagnostic checker remains UNEXECUTED on
rebuilt heads; compilation/static checks do not prove baseline/control passage.

Validation PASS: `dropdown-model-split-restored-tests.log` contains 57 widget
unit/integration tests (17+7+3+15+8+5+2), with absolute full cut9 data and
NK_REQUIRE_EXPORT=1. The three Dropdown tests exercise actual Tree/Parley layout,
selection semantics/diff and dispatch; no native Window/provider surrogate.
`dropdown-model-split-repeat-control.log`: production same-selected return
temporarily changed false to true, compiled, then failed its OWN repeated-action
assertion Changed(6) vs None after initial selection/diff setup. Source restored
byte-identical to original4679a10e before the full 57 PASS suite. All-target
widgets Clippy -D warnings, workspace all-target check, fmt/skilldocs/diff PASS.
Original delta did not apply at old module/doc context; only module registration
order and append location were adapted, without replacing current lib wholesale.

## Local Dropdown trigger extraction (#915, cut 15)

Existingc238075d trigger style/paint/measure, Settings reader, token recipe and
exporter/completeness checks reused. Current capsule exports and main choices,
ranges, Styles and window input are preserved. Contract precedes the API; skill
and README describe missing-style error, token geometry and shared themed arrow.
Review198: collapsed ComboBox Selection activation is intentional and now explicit
in CONTRACT, with a real Tree dispatch assertion while expanded=false. No popup
opens for that selection path; availability/generation guards still apply.

Fresh actual exports at `toolkit/target/dropdown-trigger-data` include all tokens,
manifest and 12 i18n locales; old cut9 data lacks the new trigger and is not used.
CPU pixel tests use explicit synthetic style colours/geometry, actual Parley and
reference vector icon; Settings tests independently read all four exported modes
and apply Styles, then require missing arrow rejection. These are component
proofs, not native popup, AT-SPI signals, Orca speech or owner visual acceptance.
No native/EGL run. Cut13 checker remains not executed on rebuilt heads.

Compiled arrow-ink fault replaced arrow ink with background ink and failed its
OWN opaque glyph pixel assertion after layout, geometry and idle background setup
(`dropdown-trigger-split-arrow-control.log`). Restored production source before
full suite verification; no assertion/timing relaxation. Initial patch-context
failures were extraction mismatches, not acceptance; adapted insertion points
preserve current capsule export/layout additions rather than copying old files.

Validation PASS: 111 widgets/Settings tests (59+52) in
`dropdown-trigger-split-restored-tests.log`, required fresh generated full data.
`dropdown-trigger-split-clippy.log`: both packages all targets, -D warnings PASS;
settings-tokens-check:108 colour sets/4 variants complete; fmt/skilldocs/diff PASS.
Collapsed Selection assertion is CPU model proof only. Text/icon rendering tests
use a synthetic32px fixture, not #921 window-controls sizing or owner acceptance.

## Local MenuList extraction (#915, cut 16)

Existing3cf5527c production MenuList/MenuOption/MenuStyle, choice-key routing,
semantic selected state, CPU tests and Settings menu token reader/checks extracted.
Native dropdown-probe265/checker77/wrapper19 and historical native evidence are
excluded for a separate independently compiling diagnostic cut. No new provider
or Wayland host. Current main/capsule/trigger functions and review198 collapsed
Selection assertion are preserved. Contract precedes API; skill/README describe
CPU-only scope and keep native/AT-SPI/Orca/material/live acceptance pending.

Fresh full actual exports at `toolkit/target/menu-list-data`, including the changed
menu recipe, are required; cut15 data is stale for this reader. CPU fixture
geometry and palette are explicitly synthetic, using actual Parley/Tree/Canvas.

Validation PASS:114 Settings/widgets tests(52+62) with NK_REQUIRE_EXPORT=1 and
absolute fresh cut16 data, `menu-list-split-restored-tests.log`. Three new menu
CPU tests verify independent hover/focus/selected check, navigation/reveal with
unavailable rows, and retained style updates. Production fault allowed hovered
unchosen rows to paint a check, compiled, then failed OWN
`!bright_in_check(&hover, other)` after both row-background and chosen-check setup
(`menu-list-split-hover-check-control.log`). Restored menu.rs byte-identical to
original3cf5527c before114PASS. All-target Clippy bothpackages-Dwarnings, workspace
alltarget check, actual generated-token completeness, fmt/skilldocs/diff PASS.
No historical native PASS is imported or attributed to this rebuilt head.

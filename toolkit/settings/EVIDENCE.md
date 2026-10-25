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

## Review201 correction to cut16

Claude found pointer→keyboard leaves stale hover alongside keyboard focus. New
actual Tree/Canvas stationary-pointer test compiled against old production and
failed OWN old-row background assertion [0,100,255] vs[30,30,30] AFTER initial
hover/background/chosen-check setup (`menu-list-review201-old-control.log`).
menu_key now clears hover before focus/reveal. Reverse keyboard→pointer coverage
is retained. This fixes CPU behavior, not native input acceptance.

Named debts from trigger review: 0.15s hover/active transition not ported; closed
trigger currently jumps. arrowColor text-dim needs live queryUI against the arrow
node; image CSS is not proof and no live query has been performed. Current token
is provisional, not owner/live ink acceptance. No speculative token change here.
CONTRACT now names standalone menu_style Tree mode boundary for later builder
extraction; future general layout/measure/viewport/paint changes must account for it.

Review201 final:114Settings/widgetsPASS requiredunchangedcut16exports, bothalltarget
Clippy-Dwarnings/fmt/skilldocs/diffPASS. Logs menu-list-review201-{restored-tests,clippy}.log.

## Local MenuList diagnostic source extraction (#915, cut17)

Existing3cf5527c dropdown-probe265, checker77 and wrapper19 extracted separately
on corrected menu-list5afe8340. Reuses existing private widgets headless host;
no new provider/backend or production controller. Diagnostic reads actual
Exports/Portal/Styles and hosts retained model/menu with standard popup, forced
opaque D5. No shared AT-SPI bridge or real Config1 builder is claimed.

Checker NO EJECUTADO on rebuilt head. Compilation/static validation alone cannot
prove its baseline or fault controls pass their own assertions. No native input,
popup/grab/focus/cleanup/material/fractional, AT-SPI/Orca, timing/performance or
owner-live acceptance. Historical fixed-binary results are not copied here.
Fresh full cut16 menu-list-data is reusable because exporters/recipes unchanged.

Validation PASS: actual `cargo build -p nk-settings --example dropdown-probe`,
Settings alltargetClippy-Dwarnings, Python AST/bashsyntax, fmt/skilldocs/diff.
Logs menu-probe-split-{build,clippy}.log. Rustfmt only adapts the original probe's
formatting; no new production API. No native baseline/control catch is claimed.


## Local cut 18 — DropdownPopup semantics and revisions (2026-10-23)

Extracted existing 5bd82b32 adapter (166 lines) and its two CPU tests
(130 lines) above cut17. Only module registration order adapted to current lib;
main choices/ranges/window/Styles retained. Contract precedes public API, with
README and canonical architecture skill updated in this commit.

The actual Tree/MenuList/Parley tests preserve parent Root/ComboBox/Option IDs,
Selection and LabelledBy while projecting menu focus/actions and bounds. The
origin (300,90) and layout are explicitly synthetic CPU inputs, not configured
Wayland geometry. Reopening/publication/menu-generation guards, unavailable/hidden
options, cancellation, removal/error and guarded selection are exercised.

Current mandatory full cut16 menu-list-data reused: exporters/tokens unchanged.
116 Settings/widgets tests PASS in target/dropdown-popup-split-restored-tests.log
(52 Settings +64 widgets). Both packages all-target Clippy -D warnings and
workspace all-target check PASS in corresponding split-clippy/workspace logs.
Compiled production control bypassing the publication guard failed its own
stale Activate rejection assertion AFTER initial snapshot, permitted Focus and
second publication; target/dropdown-popup-split-stale-control.log. Literal source
restored before the full116 PASS. No timeout/setup failure used as a catch.

No host/controller/provider integration, native popup geometry, AT-SPI, Orca,
Config1 builder, material, performance or live acceptance established here.
Historical fixed-binary evidence stays attached to its original source only.
Adaptive foundations/Settings polling still needs a real caller and causal test.


### Cut18 review206 — unavailable chosen option (2026-10-23)

The original adapter refused opening when its chosen option was unavailable.
Initial focus now uses that item only if available, otherwise the first available
item, or none if all are unavailable. Selection/check remains on the parent's
chosen option; cancellation preserves its value. New CPU regression first ran
against the compiled old source and failed its own opening-success assertion
AFTER confirming chosen index1 and disabled state (not timeout/unwrap):
target/dropdown-popup-review206-old-control.log. Corrected source passes all117
Settings/widgets tests (52+65), including all-unavailable no-focus dismissal,
with mandatory fullcut16 exports: review206-restored-tests.log. Both-package
all-target Clippy -D warnings PASS: review206-clippy.log. Clean rebuild followed
Claude207's owner-authorized cache removal; no evidence/fixed binaries removed
by this work. No native proof added.

CONTRACT/README/skill explicitly retain the exclusive parent borrow as this
short-menu adapter's ownership boundary. Parent paint/configure/scale/appearance
cannot be serviced concurrently; a controller requiring that must revise the
contract first. This remains a documented limitation, not resolved concurrency.


## Local cut19 — acknowledged popup geometry (2026-10-23)

Existing962de449 production delta and its CPU test extracted above corrected
cut18(9dd47d89). Contract before public Window::popup_geometry API, README and
canonical architecture skill together. Current main transport features retained.
The signed parent-relative rectangle stages on xdg_popup.configure and commits
with size at xdg_surface.configure acknowledgement; toplevel/unconfigured state
stays None. Reposition requests/tokens do not predict an actual origin.

75 wayland/widgets tests PASS (10+65), mandatory fullcut16 menu-list-data:
target/popup-geometry-split-restored-tests.log. Compiled eager-publication fault
failed its own current=None assertion after stage(-40,-180,200,120), observing
Some([-40,-180,200,120]) before commit; split-eager-control.log. Literal source
restored before75PASS. All-target nk-wayland Clippy -D warnings and workspace
all-target check PASS: split-clippy/workspace.log. fmt/skilldocs/diff PASS.

CPU Geometry staging/commit proof only: no native wire/configure/bounds or role,
grab/reposition/focus/cleanup/AT-SPI/Orca/performance/live acceptance. Existing
962 diagnostic probe/checker changes are excluded for a separate compilable cut.
Historical fixed binaries/evidence remain unchanged and are not this head's proof.
The short-menu exclusive parent borrow and adaptive polling caller/causal test
remain explicit debt; this geometry API does not resolve either.


## Local cut20 — popup geometry diagnostic source (2026-10-23)

Separately extracted the existing962de449 popup-probe/checker delta above19:
logs Window::popup_geometry on Configure; compares observed acknowledged popup
rectangles with incoming wire messages and requires toplevel None. No new host,
provider/backend or CI job. Existing private wrapper remains unchanged.

Actual example BUILD and all-target nk-wayland Clippy -D warnings PASS in
target/popup-geometry-probe-split-build.log and split-clippy.log. Python AST,
bash syntax, fmt, skill-docs and diff checks PASS. Checker NOT EXECUTED: this
cut separates/compiles diagnostic source; native baseline/control execution
remains pending outside this local validation. No current native geometry,
wire/role/grab/reposition/focus/cleanup, AT-SPI/Orca or performance/live proof.
Historical fixed-binary evidence is not evidence of this rebuilt head.


## Local cut21 — snapshot-bound AT-SPI publication (2026-10-23)

Existing5e26bd02 delta extracted literally above cut20: shared bridge::Bridge
worker, versioned Backend callback/update, Selection option authorization under
the same semantic Tree lock, demo reexport only. Contract before API, canonical
skill/README in the same change. Main/other toolkit features preserved.

131 a11y/Settings/widgets/demo tests PASS (12+52+65+2) with mandatory fullcut16
menu-list-data: target/a11y-publication-split-restored-tests.log. Two deterministic
Barriers exercise a callback authorized on revision7, delayed across revision8
with target disabled, retaining7; the next request is rejected. Bus-free Object/
Selection fixtures verify modal option selection without the combo open action,
option/container availability and invalid indices. These are actual production
methods with synthetic semantic snapshots, not a live provider/bus/Orca test.

Compiled control restored the old SelectChild implementation requiring combo
Activate: its own selection.select_child(0) assertion failed AFTER constructing
an enabled modal option/container with combo opening suspended; split-modal-control.log.
Literal source restored before131PASS. All-target a11y/demo Clippy -D warnings,
workspace all-target check and nk-a11y no-default-features check PASS in split-
clippy/workspace/no-atspi logs; fmt/skilldocs/diff PASS.

Worker publication acknowledgements/fatal failure propagation are compiled here;
no new live worker/provider publication proof or runtime fault injection. No
native popup, Config1 builder, AT-SPI action delivery or Orca speech acceptance,
performance/live claim. Historical fixed evidence remains source-specific.
Adaptive foundations/Settings real polling caller and causal test remain debt.


## Local cut22 — controlled Dropdown popup host (2026-10-23)

Extracted existing78ae2598 production controller237 lines, dependency/lib/lock,
PopupSnapshot common namespace and DropdownPopup invalidation delta with its
CPU test above21. Controller source matches that commit literally; test append
context adapted to retain cut18 review206 disabled-chosen focus correction.
Contract before API, skill/README/EVIDENCE in this commit. Main features retained.
Provider probe/checker/wrapper are excluded for a separate compilable cut.

130 a11y/Settings/widgets tests PASS (12+52+66), mandatory fullcut16 exports:
target/dropdown-controller-split-restored-tests.log. Compiled invalidated-focus
restoration fault removed Drop's live guard; its own parent.focused()==None
assertion observed Some(6) AFTER invalidation, rejected snapshot/request/choice
and preserved canonical selection: split-restore-control.log. Literal source
restored before130PASS, including cut18 chosen-disabled/all-disabled regression.
Both Settings/widgets all-target Clippy -D warnings, workspace all-target check,
fmt/skilldocs/diff PASS in corresponding logs. Initial patch-context failures
were extraction failures, not test acceptance; test appended without overwrites.

Controller/keep_open staging, configured-origin publication, existing Bridge and
restored revision, opaque fallback/optional panel path are compiled/source-reviewed.
CPU invalidation test does not execute show(), a real Window/provider, Config1
notices or input-to-controller lifecycle. No current native popup/action/focus/
material, AT-SPI/Orca, performance/live acceptance. Historical fixed binaries'
evidence is not evidence of this reconstructed head. Exclusive parent borrow
short-menu limit and adaptive real polling caller/causal-test debt remain.


## Local cut23 — Dropdown controller/provider diagnostic (2026-10-23)

Extracted the existing78ae2598 provider probe199, checker134 and wrapper19 above
cut22 (1bc63b8f). Probe and wrapper match original source literally. The only
checker adaptation adds git -c safe.directory=* for container ownership, as #882
requires. No production/controller/token/export changes or new provider/backend.
Contract and canonical skill/README updated in the same commit.

Actual cargo BUILD of dropdown-provider-probe PASS:
target/dropdown-provider-probe-split-build.log. Settings all-target Clippy
-D warnings PASS: target/dropdown-provider-probe-split-clippy.log, with required
fullcut16 menu-list-data. Python AST, bash syntax, source comparisons, cargo fmt,
skill-docs and git diff --check PASS. No redundant production unit-test rerun:
this cut adds diagnostic source only and compiles it with its real dependencies.

CHECKER NOT EXECUTED: this cut only separates and compiles the diagnostic;
native baseline/control execution remains pending. There is no current native
controller/provider, selection/focus/grab/geometry/cleanup, AT-SPI action-delivery,
Config1 builder, real Orca speech or performance/live acceptance. Historical
fixed-binary evidence remains tied to its original source/hash. The checker
requires completed input, parent commit and publication before its assertions;
three fault cases must fail their own selected-value assertion, not timeout.
Exclusive parent borrow short-menu limit and adaptive foundations/Settings real
polling caller plus causal-test debt remain explicit and unresolved.


## Local cut24 — manifest Dropdown builder (2026-10-23)

Existing498b90ad production/tests extracted above23, preserving earlier main and
review corrections. Contract applied before API; skill/README in same change.
123 Settings/widgets tests PASS [33, 3, 13, 5, 2, 17, 7, 13, 15, 8, 5, 2], mandatory complete cut16 exports.
Settings/widgets all-target Clippy -D warnings PASS. Logs: target/
dropdown-builder-split-{tests,clippy}.log. Private Config1 bus tests exercise
actual Client/service/canonical refusal; no live session bus mutation.
Native modal opening remains a headless decision seam in these tests, not a
real Window/controller/provider integration acceptance. No new fault injection
run: historical controls remain original-source evidence. No native/EGL/Orca,
performance or live claim. Short-menu parent ownership and adaptive polling
caller/causal-test debt remain. No push or merge.


## Local cut25 — 915-dropdown-builder-probe (2026-10-23)

Extracted existing 13d1bc6d above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

Actual example BUILD PASS; all-target Clippy -D warnings PASS
for nk-settings. Logs: target/cut25-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-menu-list/toolkit/target/menu-list-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.

### Block C latest pending accessibility snapshot (2026-10-25)

Bridge replaces its unbounded pending-tree queue with one overwriteable slot and
a bounded nonblocking wake notification. While the backend is busy, superseded
trees are released; it diffs the last published snapshot against the newest one
it takes next. Only actually published revisions are acknowledged. Metadata
requests remain version-bound; in-flight publication is not interrupted.

14 nk-a11y tests and all-target Clippy-Dwarnings pass. The slow-reader control
uses an actual mailbox and retained payload lifetime: old Arc drops before the
reader runs, only final revision3 is received, then4 and disconnect are handled.
No native Orca result is claimed for this unit-level concurrency fix.

## Local cut26 — 915-font-catalog (2026-10-23)

Extracted existing c2ebf2e1 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

62 tests [39, 3, 13, 5, 2] PASS; all-target Clippy -D warnings PASS
for nk-settings. Logs: target/cut26-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-menu-list/toolkit/target/menu-list-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut27 — 915-search-input (2026-10-23)

Extracted existing fb0da104 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

139 tests [39, 3, 13, 5, 2, 0, 1, 1, 17, 7, 13, 15, 8, 5, 8, 2] PASS; all-target Clippy -D warnings PASS
for nk-text, nk-widgets, nk-settings. Logs: target/cut27-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut28 — 915-system-fonts (2026-10-23)

Extracted existing 5408f547 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

3 tests [0, 1, 1, 1] PASS; all-target Clippy -D warnings PASS
for nk-text. Logs: target/cut28-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut29 — 915-embedded-list (2026-10-23)

Extracted existing 4d63de5d above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

141 tests [39, 3, 13, 5, 2, 17, 7, 17, 15, 8, 5, 8, 2] PASS; all-target Clippy -D warnings PASS
for nk-widgets, nk-settings. Logs: target/cut29-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut30 — 915-font-dialog (2026-10-23)

Extracted existing fb3c07b8 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

169 tests [12, 40, 3, 13, 5, 2, 0, 1, 1, 1, 10, 17, 7, 19, 15, 8, 5, 8, 2] PASS; all-target Clippy -D warnings PASS
for nk-wayland, nk-widgets, nk-settings, nk-text, nk-a11y. Logs: target/cut30-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut31 — 915-font-preview (2026-10-23)

Extracted existing 9fc49bb1 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

153 tests [2, 1, 2, 40, 3, 13, 5, 2, 0, 1, 1, 2, 17, 7, 19, 15, 8, 5, 8, 2] PASS; all-target Clippy -D warnings PASS
for nk-text, nk-render, nk-widgets, nk-settings. Logs: target/cut31-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut32 — 915-font-styles (2026-10-23)

Extracted existing 602ea614 above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

151 tests [41, 3, 1, 13, 5, 2, 0, 1, 1, 3, 17, 7, 19, 15, 8, 5, 8, 2] PASS; all-target Clippy -D warnings PASS
for nk-text, nk-widgets, nk-settings. Logs: target/cut32-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


## Local cut33 — 915-font-builders (2026-10-23)

Extracted existing 6dd728bd above the previous local cut, retaining main
features and earlier review fixes. Contract applied before implementation;
canonical skill and relevant README documentation accompany the mechanism.

182 tests [13, 2, 1, 2, 41, 4, 1, 13, 5, 2, 0, 1, 1, 3, 10, 17, 7, 19, 15, 8, 5, 8, 2, 2] PASS; all-target Clippy -D warnings PASS
for nk-text, nk-render, nk-a11y, nk-widgets, nk-settings, nk-widgets-demo, nk-wayland. Logs: target/cut33-split-*.log. Mandatory complete
exports: /home/angel/Nidara/ChatGPT/915-search-input/toolkit/target/search-input-data. fmt/skill-docs/diff checks PASS; changed Python/Bash
static syntax checked where present. No historical controls were reclassified
as current fault acceptance; no native/EGL checker was executed.

Native Window/provider, complete Config1/modal lifecycle, real IME/clipboard,
AT-SPI/Orca speech, performance and owner live acceptance remain separate gates.
Historical fixed binary evidence remains bound to original hashes. Exclusive
parent borrow short-menu limit and adaptive foundations/Settings real polling
caller plus causal-test debt remain. No push/merge or heartbeat reactivation.


Final extraction audit: all original Settings modules are present. 19 source files
match6dd728bd exactly; material/control production matches before cfg(test), routing
retains the reviewed Native forwarding correction. Text/a11y/Wayland/render sources
match the original endpoint exactly. Widget residuals are documented review fixes,
per-capsule paint filtering, comments/registration and disjoint measurement order.
Workspace all-target check PASS, including phase0/settings-slice; no-atspi check
PASS with2existing dead-code warnings, not-D. Logs: target/split-final-{workspace,
no-atspi}-check.log. All182 tests and7package Clippy results above remain current;
this final addition is documentation only. Original branches remain clean.

### Review D: malformed catalogue records and renderer agreement (2026-10-25)

The parser now omits and counts individual invalid records (including invalid UTF-8),
retaining usable families. Enumeration logs total time, usable families and skipped records.
Before Apply, a family must resolve and load a valid face from the same Fontique collection
used by Parley; fc-list remains discovery metadata, not a second rendering authority.
42 Settings library tests and two nk-text geometry/resolution tests pass; all-target
Clippy for nk-settings/nk-text passes. These checks do not establish live IME/Orca acceptance.

## Application integration — transactional page lifecycle (2026-10-23)

New page::Mounted ownership and Rendered build rollback precede app assembly.
Failed replacements preserve existing content, unmount the failing builder and
all successful partial builders, then remove new roots. Unmount failures do not
skip remaining callbacks or root retirement. Contract before API; canonical
skill and README in the same change.

149 Settings/widgets tests PASS [41, 4, 1, 2, 13, 5, 2, 17, 7, 19, 15, 8, 5, 8, 2]; both all-target Clippy -D warnings
PASS. Logs target/page-lifecycle-full-{tests,clippy}.log. Two lifecycle tests use
the real renderer/Tree and exported styles with synthetic builder error callbacks;
no fake Window/provider/Config1 integration. A compiled rollback fault skipped
new-root removal; after callback completion, the own `failed replacement leaked
roots` assertion caught it. Source restored before the full passing suite.
Initial fixture used an invalid Group/Button nesting and failed before setup;
that failure is preserved in page-lifecycle-tests.log, not acceptance.

This closes one app-lifecycle prerequisite. Full app host, wallpaper builders,
native main/Config1/portal/Orca/performance/live gates remain unimplemented or
unvalidated here; no native/EGL run, publication, merge or activation of legacy
replacement. Full actual cut27 exports reused unchanged.


## Application integration — retained Image primitive (2026-10-23)

Tree::image and nk-render::Raster/Canvas::image add the reusable preview primitive,
with explicit caller style/box, Contain/Cover, alpha, clipping, stable semantic
IMAGE identity and scoped Arc ownership. It performs no decoding or file IO.
Role::Image maps to the existing AT-SPI Image role; only mapping/unit proof here.

169 affected Settings/widgets/render/a11y tests PASS [13, 2, 1, 2, 1, 41, 4, 1, 2, 13, 1, 5, 2, 17, 7, 19, 15, 8, 5, 8, 2]. CPU raster test
uses synthetic RGBA, checks destination/letterbox/cover/alpha/clipping at1 and1.25.
Widget test uses actual exported Styles and real layout/CPU paint, checking pixels,
rounded clipping, named IMAGE with no actions, offscreen retention/hidden exclusion,
atomic invalid size refusal, same-raster no-paint and final pixel ownership release.
Compiled Cover-to-Contain fault failed its OWN cover/alpha pixel assertion; source
restored before full tests. Clippy requested clamp idiom; final image test and
four-package all-target Clippy -Dwarnings PASS after that finite-input equivalent
change. Workspace all-target check PASS. Logs: target/retained-image-*.log.
fmt/skilldocs/diff PASS. No native/EGL/Orca claim, no decoder/gallery/main or full
wallpaper parity yet. Actual cut27 exports unchanged and reused.


## Application integration — bounded lazy image loader (2026-10-23)

One lazy worker/four queued slots, mount/request retirement, regular-file and
input/output byte budgets, actual five-format decode and Exif-before-resize.
Target pixels alone survive completion; worker internals are not a hard process
memory guarantee (AVIF native setup may allocate before DynamicImage output).
GIF uses first frame; ICC/HDR colour validation remains pending, not full parity.

Three tests pass actual PNG/JPEG/GIF/WebP/AVIF file decoding to own target/pixel
assertions, rotated JPEG target geometry, malformed/missing/over-budget refusal,
and deterministic barrier queue4/BUSY/canceled-job/stale-completed-result behavior.
Fixture generation/provenance is checked in; ffmpeg is not required by these tests.
A compiled stale-token guard bypass failed its OWN completed-result mount assertion
AFTER the next decoder call proved the first reply had been queued. Restored before
72 Settings tests PASS [44, 4, 1, 2, 13, 1, 5, 2]. All-target Settings Clippy -Dwarnings and workspace
all-target check PASS, logs target/image-loader-*.log. Existing Ubuntu toolkit
job declares libdav1d-dev; no new job/native check or CI execution claim. Existing
Arch Hyalo CI already installs ffmpeg (dav1d dependency); no compositor edits.
Contract, canonical skill/README and evidence accompany the mechanism. No native
Window/provider/Orca/startup/PSS or complete wallpaper/app acceptance.

## Application integration — retained thumbnail viewport (2026-10-24)

ThumbnailStyle/thumbnail_strip reuse Choice radios and retained Image painting.
Unknown canonical selection is None; keyboard focus reveals in the independent
horizontal viewport, wheel routing leaves page scroll unchanged, and paint/hit/
SHOWING agree on ancestor clipping. Reflow/style/reorder preserve surviving IDs,
pixels and selection. Reorder rejects non-permutations atomically and retires
old action targets. No decoding or Apply in this shared layout primitive.

155 Settings/widgets tests PASS, both all-target Clippy -Dwarnings PASS, workspace
all-target check PASS (before the final reorder addition, covered by final tests
and Clippy). fmt/skilldocs/diff PASS. Two tests use actual exports/layout/CPU paint
with synthetic file names and rasters; selected-border pixels survive pointer
hover, offscreen pointer input refuses, keyboard/wheel viewport routing and
semantic retention are asserted. A compiled no-scroll fault failed its OWN
keyboard-focus viewport assertion after selection setup. Source restored before
the full suites. The first reorder test expected stale dispatch to return None;
the existing API correctly returns Err, and the test now asserts that rejection.
Logs target/thumbnail-strip-*.log. No native/Orca/live or full wallpaper parity.


## Application integration — wallpaper preview/gallery builders (2026-10-24)

Real wallpaperPreview/wallpaperGallery consume Config1 wallpaper.current/catalogue
via the existing Session/renderer. Exact paths define selection; surviving IDs and
catalogue order persist. Same activation does not Apply; changed guarded activation
uses Cx.apply, preview follows optimistic Session::shown from idle, and refusal
restores canonical selection/pixels with visible error. Empty gallery/error rows
are hidden through renderer-combined row_visible. Only showing images start decode;
offscreen/hidden/unavailable/replaced/unmounted work cancels. No UI file scan.

158 Settings/widgets tests PASS [44, 4, 1, 2, 13, 1, 5, 2, 3, 2, 17, 7, 19, 15, 8, 5, 8, 2]; both alltarget Clippy-Dwarnings and
workspace alltargets check PASS. Three new tests use actual exported Styles,
renderer/Tree, real tiny-file decoding and CPU pixels; Editor/Config1 session is
an explicitly synthetic headless seam, not actual Config1 bus/native acceptance.
Assertions cover preview pixel change, same/change/refusal, persistent canonical
error, unknown-current None, catalogue reorder IDs, empty->populated visibility,
offscreen missing-file refusal only after scrolling, all four required export
variants, and owner/unavailable stale activation refusal. A compiled fallback-to-
first-option fault failed its OWN unknown-selection assertion after decode/write/
refusal setup. Source restored before suites; later optimistic-preview sync was
covered by final green-pixel tests, with the selection guard unchanged.

Fresh full actual exporters generated target/wallpaper-data (old exports without
wallpaper are now obsolete). Required token checker, fmt/skilldocs/diff and Python
AST PASS. Initial test API/structural-label failures and initial shown-callback
assumption caused failures before valid setup; none are acceptance. First full
suite failed because old test dbus-daemon generated a socket name beyond Unix's
limit in this longer worktree. Fixture now uses short explicit target/cb-*/bus;
all four existing real private-bus tests pass, no predicates dropped or relaxed.
Logs target/wallpaper-builders-*.log, exporter logs alongside.

wallpaperPicker remains genuinely missing, not a stub. Main Window composition,
parented portal picker, long-modal parent servicing, adaptive polling caller/causal
proof, ICC/HDR and native/Orca/performance/live gates remain pending. The existing
CSS border transition150ms is exported but not ported. No publication/merge or
legacy takeover; no native/EGL checker run. Original branches/fixed evidence intact.

## Application integration — portal parent transport (2026-10-24)

Window::portal_parent adds optional standard zxdg_exporter_v2 binding/lazy actual
toplevel export, same existing connection/queue, Pending vs Unsupported vs Ready,
opaque wayland: identifier and destruction before role/surface. Empty handles
fail rather than allowing empty-parent fallback; popups are refused. Format read
against primary portal window-identifiers documentation and installed protocol XML.
Capability/handle state tests are pure CPU, not fabricated Window/protocol proof.
Native export/wire ordering/portal parenting and file chooser remain unexecuted.

13 nk-wayland unit tests PASS; alltarget Clippy-Dwarnings/workspacealltargets/fmt/
skilldocs/diff PASS. Compiled pure Handle-state fault mapped Pending to Unsupported;
its OWN equality assertion caught it, then source was restored before13PASS. This
control has no Window, Wayland server or exported-wire setup and proves only that
production handle-state classification. Tests also check exact v2 capability,
nonempty opaque handle prefix/retention and persistent empty-handle error. Logs:
target/foreign-parent-{tests,state-control,restored-tests,clippy,workspace-check}.log.


## Application integration — FileChooser portal transport (2026-10-24)

Chooser uses the existing caller connection, one cancelable process worker,
nonzero mount/request tokens, bounded initial operations and no user-duration
limit. Subscribes before OpenFile, pins owner and actual returned path, validates
one local file URI and returns it without Apply. Cancel/retirement request Close;
Close failure remains best effort, no native closed-dialog guarantee.

80 Settings tests PASS [46, 4, 1, 1, 2, 13, 1, 5, 2, 3, 2]; alltarget Settings Clippy-Dwarnings and
workspacealltargets/fmt/skilldocs/diff PASS. Actual private dbus-daemon has its
own target/fc-*/bus and config with no service dirs. Synthetic portal implements
real OpenFile/Response/Close objects. Before the method reply it emits unrelated
and matching Response signals on a nonpredicted request path. Own returned-path
assertion checks the selected local path, options/modal/single/filter signature
and random token. Cases cover success, cancel, response2 error, multiple URIs,
remote URI refusal, cancel->actual Close and actual bus owner release->error/Close.
Parent string is explicitly synthetic, not a Window or native parenting claim.
Two pure units cover escaped Unicode/path syntax and completed stale reply.

Compiled production path-filter bypass failed its OWN selected-path assertion
AFTER actual OpenFile returned/setup complete; mount-guard bypass failed its OWN
buffered-result assertion (pure channel seam). Source restored before full suite.
No timeout counted as a control catch. Initial test signature API and signed u32
fixture errors are preserved, not acceptance. Logs target/file-chooser-*.log.
Canonical skill/README/contract accompany API; two already-transitive async deps
are now explicit. Required full cut38 wallpaper-data reused, exporters unchanged.

This transport still needs the real wallpaperPicker builder and main caller.
No native file-dialog/Wayland export/provider/Orca/focus/performance/live proof,
no publication/merge, no heartbeat restart or legacy takeover. Modal parent
servicing/adaptive polling/ICC-HDR and existing visual debts remain pending.


## Application integration — mounted wallpaper picker (2026-10-24)

wallpaper_picker::register connects the actual custom item to Window::portal_parent,
Editor connection and the real cancelable Chooser. Nonzero mount/process-wide
per-open IDs plus epoch/value and live/shown/writable guards retire stale results.
Repeated activation is ignored while pending. Cancel/same/invalidation0 Apply;
accepted changed selection1 Cx.apply. Canonical failure/error survives cancel.
Hidden/unmounted/unavailable notices cancel without restoring focus; ordinary
completion restores the eligible widget. No Window -> explicit row error.

Rendered::idle now processes Editor.poll before async builder completion and
returns the Vec<Notice> for host dependencies; no growing staging queue. Its
external_modal_active flag exposes pending portal operations. Actual app/provider
caller still must consume these notices, reject parent AT-SPI actions and publish
parent inactivity. The API alone is not that caller/modality/idle CPU proof.

86 Settings +81 widgets = 167 final tests PASS; both alltarget
Clippy-Dwarnings/workspacealltargets/current tokenchecker/fmt/skilldocs/diff PASS.
Five picker tests: production activation/completion with an explicitly injected
post-dialog decision seam (no Window/chooser/provider fabricated), canonical
same/cancel/changed/error/focus/stale/hidden/unmount checks; queued raw Config1
notice before result and returned to host; actual Client on a private dbus-daemon,
Snapshot/Apply with the service checking the real sender owns SettingsNative,
same/cancel0, changed1, refusal2 plus pending=false/canonical reply/error, owner
release -> production idle poll -> retire decision/no further write. The chooser
decision in this private Config1 test remains injected, not native end-to-end.

The full actual exported Appearance page mounts/layouts with the five real builder
registration modules, no Stubs, no writes; actual Browse caption and row label
relation plus IMAGE checked. Wallpaper loading/dialog decisions/native Window
are not accepted by that CPU assembly check. Initial caption assertion incorrectly
expected semantic name Browse; existing row LabelledBy correctly gives Image.
The test now checks actual painted node caption and semantic row relation separately.
Initial Clippy let-and-return fixture warning fixed. Atomic token allocation uses
existing compare-exchange loop compatible with declared1.90 rather than a new API.

Two compiled production faults caught OWN assertions AFTER activation/decision
setup: cancel branch wrote a changed value (own cancel0write assertion), and idle
skipped Editor.poll (own queued-notice0write assertion). Source restored before
full suites. These are headless decision-seam controls, not native dialog controls.
Later optional folder/UTF8 handling changes covered by final suite, guards unchanged.

Open.current_folder now carries validated absolute filesystem bytes + trailing NUL;
picker suggests HOME when absolute. Actual private portal fixture checks ay payload;
unit checks non-UTF8 filesystem bytes, rejects relative/NUL paths. Portal may ignore
this hint, no native initial-directory claim. Existing unchanged complete cut38
wallpaper-data reused; no exporter change. Logs target/wallpaper-picker-*.log.

Contract before API; canonical architecture/tech-debt, README, EVIDENCE same commit.
Pending: actual main/provider/portal/routing/visibility integration, adaptive polling
caller/causal test, long-modal parent servicing, ICC/HDR, exact secondary/pill look,
native Window/dialog/AT-SPI/Orca/performance/live gates. No push/publication/merge,
legacy activation or native/EGL rerun. Original branches/fixed artifacts preserved.

### Review E: reduced JPEG decoding (2026-10-25)

JPEG thumbnails now decode with IDCT reduction before final resizing; the normal
path retains orientation and source/encoded budgets. Other codecs retain their
bounded existing path. Four image-loader tests pass, including decoded
intermediate dimensions, a rotated Cover target, five real codec files, malformed
inputs, budget rejection and cancellation. All-target nk-settings Clippy passes.

Release timing, this machine, defaults/wallpaper/wallpaper.jpg, target 320x200:
full decode + fit 62.153 / 61.729 / 60.901 ms; reduced decode + fit
32.472 / 30.893 / 30.656 ms. Reproduce with `NK_THUMB_BENCH=<absolute JPEG>` and
`cargo test --release -p nk-settings --lib real_wallpaper_decode_timing -- --ignored --nocapture`.
No wall-clock assertion is added to CI. PNG/GIF/WebP/AVIF have no reduced-decode claim.
## Local integration42 — first native application entry point (2026-10-24)

Worktree 915-native-app over41 42cd75c3. Adds src/main.rs and the private
application composition; no installed launcher or ENTRY takeover. Router Native,
Client and portal use the same connection. Shell and all five real builder
registrations mount the actual exported Appearance page after a real Snapshot;
no production fixture or fallback schema. Loading/status rows are retained widgets.
The one Bridge is created only after Configure; Native shares it for dialogs.
CONTENT_READY is emitted from a successful root commit with a mounted available
Snapshot, not from the loading state and not as presentation/performance proof.

Actual code stages portal/native queued routing, consumes Native notices and
Renderer::idle returned notices, follows canonical interfaceIconTheme, retires
pending external selection on invalidation and masks parent actions/focus/input.
Fresh snapshots reconcile roots, ordinary changes retain controls. Material
readers are shared and cached until appearance changes. Provider acknowledgements
are drained. None of those Window/provider callbacks has been executed natively
in this cut; this is compiled integration plus the bounded evidence below.

Final settings lib/tests suite:93 PASS (86 existing +7 application tests),
required complete actual native-app-data. Actual executable BUILD, Settings
alltarget Clippy -Dwarnings, workspace alltargets check, tokenchecker, i18n-check,
fmt, canonical skilldocs and git diff check PASS. New19 strings in all12 locales;
translation-state --sync retains the existing117 untranslated-key debt elsewhere,
no old stale list cleared. BOTH actual exporters regenerated. Older wallpaper-data
lacks the new application labels and is not this cut's current complete data.

CPU tests use the SAME private View composition and actual exports/Styles/Tree/
Parley layout, with explicit synthetic Snapshot sessions where stated. They cover
loading→full mount, fresh root/operation retirement, formerly unavailable generic
row becoming present, real Picker pending state→semantic action/focus mask,
Unavailable cancellation0writes, publication+generation rejection after valid
focus, portal restyle preserving focus/IDs0writes, and staged external retirement
before idle acceptance0writes. No Window/Bridge/provider is fabricated in tests.

One actual private Config1 bus uses Client::start plus Router::start on the SAME
connection. Full Appearance mounts from that service's synthetic schema; a real
retained toggle activation makes exactlyone real Apply, returns canonicalfalse
and pendingfalse. The service's async GetNameOwner check confirms Apply's sender
owns SettingsNative. Bus config has no service dirs, explicit target/ap-PID/bus;
no live bus connection/environment changes. No native Window/portal/Orca proof.

Two COMPILED production faults caught their OWN assertions AFTER setup: leaving
parent actions in project() failed the own mask assertion after real Picker
activation/pending; suppressing fresh-snapshot remount failed own newlyavailable
row assertion after initial unavailable mount and second Snapshot. Both source
faults restored before final suite. Logs native-app-parent-actions-control.log and
native-app-snapshot-reconcile-control.log. These are CPU caller controls, not
native portal controls. Initial direct Label-under-Scroll structure failed and
was corrected to Group/Row/Label. Initial private service used blocking DBusProxy
inside its executor and timed out; corrected to actual async GetNameOwner. That
setup failure is NOT control acceptance. Initial type/borrow/Clippy failures are
preserved in native-app-{check,clippy,clippy-fixed}.log, not acceptance.

Final logs: target/native-app-final-tests.log, native-app-build-current.log,
native-app-verified-clippy.log, native-app-workspace.log, native-app-token-check.log,
native-app-i18n-check.log, native-app-{skill-docs,fmt}.log and export-final.log.
Contract preceded code; canonical architecture/tech-debt/README/EVIDENCE same commit.

Remaining explicitly: raise/queryUI unsupported; no sidebar search/results;
direct forwarded Router routes do not yet stage nested-modal cancellation;
exclusive-parent long-modal servicing, adaptive poll caller (currently16ms),
provisional controls/panel titlebar/window/font geometry/point-step policy,
secondary/pill look, ICC/HDR and hard codec allocation limits. No native window,
EGL/checker, AT-SPI/Orca, installed startup/PSS/frame, owner live or replacement
acceptance. Original915/889/fixed artifacts preserved, no publication/merge,
no Hyalo/backend/bar/shader/#921 changes, heartbeat remains paused.

## Local integration43 — standard activation transport (2026-10-24)

Standalone nk-wayland consumer of xdg_activation_v1; existing connection/queue,
root surface, optional global, cleanup. Contract before API; no new provider/host.
Activation::Requested is only a sent request, no compositor/focus confirmation.
17Wayland CPU tests PASS; alltargetWayland Clippy-Dwarnings, workspacealltargets,
fmt/skilldocs/diff PASS. Pure dispatch tests record sends, preserve opaque token,
refuse empty/NUL/non-toplevel/unpainted, explicitly unsupported without global.
Capability requires exact global. Compiled unpainted-guard bypass caught OWN
unpainted assertion AFTER valid-send setup; restored before17PASS. No fake Window,
server, native protocol trace or focus proof. Local installed wayland-protocols
0.32.13 XML is the protocol source; upstream web fetch unavailable. No rerun EGL.
Settings caller/token environment/handoff remains separate. No export/token/data
change: complete cut42 native-app-data reusable. Logs target/activation-transport-*
(restored-tests, unpainted-control, clippy, workspace, skill-docs, fmt).

## Local integration44 — native activation handoff/caller (2026-10-24)

Over43 36e1ff34. Existing Request(as) optional trailing metadata and Incoming
activation, main-entry launch token read/removal before worker initialization,
second-instance handoff and first-buffer Window::activate caller. No new action
transport, provider, token minting, fabricated serial or success-by-repaint.
Replies mean request submitted, never confirmed compositor focus. Missing token
and unsupported protocol remain explicit; legacy forwarding strips metadata and
retains old argument shape, without tokenized legacy activation claimed.

96Settings tests PASS (93prior+2metadata+1actual private-bus second-instance test).
Full actual cut42 native-app-data reused; no exporter/token/string changes.
Actual private Router owner receives Navigate(appearance) and exact opaque token
through the second Router::start handoff, responds and worker returns AlreadyRunning.
Only then the own exact token assertion runs. No Window/Wayland/compositor is
simulated. Compiled production metadata-drop fault caught OWN lost-token assertion
AFTER actual method response/join; restored before96PASS. Token parser refuses
malformed/duplicate/NUL without exposing token; positional page IDs stay positional.
Main env retirement and Window timing remain compiled/source proof only: neither
main nor a native window was run. No thread-parallel environment mutation in tests.
Initial Clippy collapsible-if corrected cosmetically before final verification.

SettingsalltargetClippy-Dwarnings/workspacealltargets/build/fmt/skilldocs/diff PASS.
Logs target/activation-routing-{restored-tests,final-tests,handoff-control,
verified-clippy,workspace,build,skill-docs,fmt}.log. Contract preceded API; canonical
architecture/tech-debt/README/EVIDENCE same commit. QueryUI/search, forwarded-modal
queue edge, long-modal parent servicing, adaptive poll16ms, provisional visuals and
native/Orca/installed performance/live remain open. Original/fixed preserved;
no push/install/merge, no Hyalo/backend/bar/shader/#921 edits, heartbeat paused.

## Local opaque diagnostic preview45 (2026-10-24)

Adds explicit NK_SETTINGS_OPAQUE_PREVIEW=1 using existing Options.material=false
capability mask, existing opaque fallback and no window-background declaration.
Default launch unchanged. Contract before mechanism, canonical skill/README and
this evidence in same change. Build/alltargetSettingsClippy-Dwarnings/fmt/
skilldocs/diff PASS. No redundant tests of the private environment switch added.

Actual direct native view on the current compositor, real Config1/portal and
shared provider: CONTENT_READY commit2, frame callback AND presentation observed.
PID1261804/window69, copied binarySHA256
a8f1789e7b78d0c7cc90655ee20992817f7c829b785b9e8b0e2acbc11a32696c.
Verified executable identity before setting this own window floating, resizing
351x646→928x760 and centering. Same PID/window remained visible/focused after resize,
no SETTINGS_ERROR at verification. No automated Apply or control/dialog test.
Opening/resize is a bounded visual preview only, not parity/Orca/performance gate.
Logs and metadata target/opaque-view-20261024T165527Z; fixed originals untouched.

Prior normal-mode attempts remain failed diagnostics in cut44 target preview-
20261024T164120Z: nested connection reset/EGL errors and direct broken pipe. The
normal-mode cause remains unresolved; opaque success does not prove a D7 fix.
Prior nested HYALO_A11Y_MANAGER/live-bus ownership incident remains pending next
session restart: no service/compositor restarted and no name claimed by this view.
No installation, push, merge or heartbeat resume.


## Pointer-entry failure and activation invalidation46 (2026-10-24)

Cut45's bounded opening/resize observation was superseded by the owner's report:
window69 closed on pointer entry. Its preserved log ends in Wayland Broken pipe;
opaque mode is NOT a fix for the normal-mode disconnections.
One instrumented reproduction used the EXACT same copied binary and only added
WAYLAND_DEBUG=client. Trace is in cut45 target/pointer-diagnostic-20261024T170807Z:
890 A11Y_PUBLISHED records, batches of pointer samples/configures processed with
long gaps before socket service, then Broken pipe. No server disconnect reason
was logged; do not label socket buffer exhaustion/ping timeout as proven.

Source defect: App stages Tree::set_active on every event; that method dirtied
root semantics even when activation was unchanged. It now returns without adding
invalidation in that case. Actual transitions retain root semantics/search paint;
existing pending invalidations and retained focus are preserved. Contract before
code; canonical skill/README updated. New retained-Tree CPU test uses 1000 pointer
samples and real activation transitions; old compiled production fails its own
unchanged-activation semantics assertion AFTER layout/focus/ack setup, log
 target/focus-invalidation-old-control.log. This control is not a native closure
oracle. Verification and native status are recorded below after execution.


Corrected Tree suites: 178 tests PASS (96 Settings,82 widgets), both packages
alltarget Clippy -Dwarnings, actual debug executable build, fmt, skill-docs and
diff checks PASS. Corrected debug native diagnostic PID1268147/window71,
SHA256 0f343e6630d60310b4c0095b4656564476567e6abf68ebb4eda97e665d8db165,
cut46 target/pointer-corrected-20261024T171243Z: 402 motion records with only4
semantic publications, but it STILL ends in Broken pipe. Idempotency reduces
publication work; this is explicitly NOT a native closure fix. Approx12.8s gap
between the last batch's read and next root commit remains. A bounded perf sample
contains Tree lookups, rendering and image-worker samples; it does not establish
that image decoding repeats on every motion. All prior window binaries are debug
(unoptimized); an optimized release build is being prepared separately.

Source inspection of the remaining BTree-lookup cost found a second no-op defect:
set_unavailable collected full focus order BEFORE checking whether the hidden/
disabled value changed. Renderer refresh stages these setters for all page rows
before/after input. The unchanged check now precedes that traversal; actual
transitions still capture old order before mutation, preserving focus repair.
This cost optimization uses the existing availability/focus tests rather than
inventing a wall-clock threshold. Suites/Clippy must be rerun after this addition.


Final code verification after BOTH no-op fixes: 178 Settings/widgets tests PASS,
both alltarget Clippy -Dwarnings, optimized release build, fmt/skill-docs/diff PASS.
Logs: target/focus-invalidation-final-{tests,clippy,release-build}.log.
Release diagnostic launched PID1273771/window73 with exact copied SHA256
fa7e0135206f9d074f411a0a27bcae79dbffe2359d6bc73b9c07ba51095bb590,
target/pointer-release-20261024T171940Z. Real Config1/portal, CONTENT_READY2 and
presentation observed; verified executable identity before own-window floating/
resize/center to928x760. Pointer test and owner result are pending at this entry;
opening/resize alone do not establish closure resolved. No automatic Apply,
native a11y/Orca acceptance, protocol/material gate or performance gate claimed.
No Hyalo/backend modifications, service restart, installation, publication or
heartbeat resumption. Original/fixed binaries and failed traces preserved.


Bounded release input verification: the same PID1273771/window73 trace subsequently
records pointer enter and2245 real wl_pointer motion events, only3 semantic
publications, and root frame callbacks/presentation AFTER those inputs, without
SETTINGS_ERROR. This exceeds the failed debug reproduction's402 motions. Owner
visual result remains pending; this is one D5 optimized run, not proof of normal
D7, long-running responsiveness, every control/dialog, Orca or performance gates.
Both no-op fixes and optimization differ from the failed partial debug run; do
not attribute the symptom's disappearance exclusively to one change.

### Review F: idle CPU on the owner's session (2026-10-25)

Measured the release binary at 79014d9892cd676b2a5c92f042a3459dafffcbc5,
SHA256 2783e95a48ae9114332e0a4a85d71fb0bdbbf1e3baa313cc4c58beae3bd998e9,
with data exported from that branch. Native Appearance was open and quiet, with
CONTENT_READY and A11Y_READY, five seconds of settling followed by ten seconds
of measurement. /proc/PID/stat increased by two CPU ticks (CLK_TCK=100):
0.20% of one CPU. The process stayed alive throughout and was terminated by the
measurement harness afterwards. This is near zero; no event-loop change is made.
The installed Hyalo was not yet the running session binary, so this is CPU
measurement only, not D7 acceptance after #935/restart. The earlier smoke failure
was the unrelated intermittent Settings slice deadline, not a block-F regression.

### Live cursor-entry regression after #935 + #938 and session restart (2026-10-25)

The owner authenticated installation and the session was restarted. The running
Hyalo was verified from /proc/194913/exe: commit 61e5343b92c9c0531657221dbd349567bf6ebd2d,
SHA256 c8103a30f400da15566bfd8aef45eb3f291ddcdb0591d67ffd761d3fb54ebcf0. This is the real desktop session, not nested.

Client: F implementation 79014d9892cd676b2a5c92f042a3459dafffcbc5,
SHA256 2783e95a48ae9114332e0a4a85d71fb0bdbbf1e3baa313cc4c58beae3bd998e9,
using data exported from F. Exact launch:

```
WAYLAND_DEBUG=1 NK_SETTINGS_DATA=/home/angel/Nidara/ChatGPT/915-block-f/build/settings-data /home/angel/Nidara/ChatGPT/915-block-f/toolkit/target/review-20261025/nk-settings-f open appearance
```

CONTENT_READY and actual material/get_material/set_glass requests were observed.
The gated nidara-click wrapper hovered the exact-PID focused window's titlebar,
sidebar, content and controls without pressing buttons. All four actions succeeded;
the wire records three wl_pointer.enter events. Both processes survived the final
five-second observation, with no Broken pipe, SETTINGS_ERROR or protocol error.
The probe then terminated only its own client; the compositor remains running.

Result: PASS for the cursor-entry crash regression. This does not establish the
complete D7 visual/interaction acceptance gate. No compositor error is worked
around in the client. The one-shot user service exited successfully and is inactive.

Evidence: toolkit/target/review-20261025/d7-live/ (result.json, full client
WAYLAND_DEBUG=1 log, compositor journal, exact window and hover commands/results).
Client wire-log SHA256: c1ae07c0accde72bfa708cae26f76b7b448d78151f255259a3b6386326862fcc.

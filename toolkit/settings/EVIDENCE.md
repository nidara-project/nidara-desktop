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

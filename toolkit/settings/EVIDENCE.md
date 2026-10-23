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

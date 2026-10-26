<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Native Settings: D5 and the entry point

## D5 coverage

All native windows keep `require_material: None`. The transport's capability tests
cover every optional protocol missing; phase 1 does not run another compositor in CI.

| Piece | Fallback and evidence |
|---|---|
| Window, header, search field | Without material/layers the retained root uses opaque exported colours and ordinary client controls; `application::tests::d5_window_and_header_force_opaque_base_without_changing_portal_preferences` paints the real assembly with a deliberately translucent base and checks opacity without changing preferences. |
| Dropdown and suggestions | Shared MenuList paints its own opaque base without material; `tests/d5.rs` exercises exported light/dark styles with a deliberately translucent menu token. Transparent rounded corners remain intentional. |
| Font chooser | The same retained dialog paints with `Frame.material = false`; existing `font_chooser` tests paint its real family list and exercise filtering/selection. Missing text-input-v3 keeps ordinary typing but provides no IME. |
| Gallery, thumbnails, preview | `tests/retained_image.rs` and `tests/thumbnail_strip.rs` paint decoded pixels on the D5 root and verify clipping, scrolling and selection. |
| Wallpaper file chooser | Missing xdg-foreign produces an empty portal parent. The private-bus `missing_foreign_exporter_uses_empty_portal_parent_without_changing_selection` verifies actual OpenFile selection and cancellation. |

These are component/protocol tests, not foreign-compositor, Orca or live visual
acceptance. Server-side effects and page parity remain governed by the other gates.

## Entry point (activated 2026-10-26, owner's decision)

`/usr/bin/nidara-settings` runs `/usr/lib/nidara/nidara-settings-native --entry-point`:
the native Settings owns `org.nidara.Settings` and draws Appearance; every other page goes
to `org.nidara.SettingsLegacy`, which it starts on demand (`nidara-settings-legacy`). The
owner chose to switch before the remaining gates so the layout work happens on the real
app; the gates below still run, they no longer hold the switch. How the two hand pages to
each other: the skill, architecture.md → "Settings entry point".

## Gate 4: measured development build, still incomplete

On 2026-10-25, the owner's running Hyalo session, six native launches, first excluded:

- CONTENT_READY median **270.84 ms**, range 260.38–271.76 ms.
- PSS five seconds after readiness: median **79.27 MiB**.
- Binary SHA256: `5be73019e9a19de405b204ca20c1d2478c633d25dbfed733c7ebe305951d679a`.
- Local samples: `build/startup-native-diagnostic.json` in this worktree.

An earlier series stopped on its second launch without the required milestone;
its first sample was about 269 ms / 79.3 MiB. The original log is preserved as
`build/startup-native.log`. The diagnostic series followed an improvement to retain
stderr and partial samples on timeout. A later successful series does not explain
that earlier failure.

The probe now waits the contract's **5 seconds**, preserves fractional MiB, supports
`--json`, records the executable hash and refuses fewer than two runs. It reports
`gate4_complete: false`: this executable was built from the checkout, not verified
as an installed package. The comparison must be repeated with the installed build,
and native scroll/slider measurements must still be compared to the recorded
legacy references (13.9 ms / 21.1 ms). No new CI step is introduced.

## Still open

The parity/Orca and new-header IME gates (#944) and the installed performance checks.
Native `queryUI` serialization is not integrated: the entry point forwards `queryUI` to
the legacy window when it runs (the pages it draws), and answers `unsupported: …` otherwise.

## Validation of this preparation

100 Rust tests pass (one existing test ignored): application assembly, library,
D5 menus, private routing and file-chooser buses, retained images, thumbnails, and
nk-wayland capabilities. All-target Settings Clippy passes with warnings denied.
The GJS bundle builds and Settings passes the repo-pinned TypeScript 5.7.3 check.
PKGBUILD parses through `makepkg --printsrcinfo`; shell/Python syntax, skill docs,
and whitespace checks pass.

Adding the second private-portal test exposed a shared PID-only socket directory;
it now includes an atomic per-test sequence so parallel tests cannot connect to
each other's bus. No assertion or CI gate was removed.


## Raising

GJS raising is scoped to its own PID: HyaloState._rebuild fills CompositorWindow.pid from
IPC window.pid (zero only when absent), so a native window with the same title cannot
receive the legacy one's raise.

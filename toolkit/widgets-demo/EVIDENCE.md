<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# #873 local acceptance — 2026-10-19

Code revision: `727ba6be7558a37d707529c6e539a9bc65f93aa3`.
Base: #872's `claude/slice-on-nk-wayland` plus merged D7 (#874).
No implementation changes to Hyalo, Config1, Settings or phase0.

## Toolkit checks

- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`: PASS.
- `cargo test --workspace --locked --offline`: **43 passed**, none failed/ignored.
  `nk-widgets`: 14 integration tests + 2 timeline/placement unit tests. These cover
  retained measured Layouts, per-kind invalidation, focus order, capture and local
  layer input, ids/generations, hidden/offscreen, live font/scale, D5 opaque/clipped
  layout, D7 full-root geometry, both missing-capability cases, Bezier/spring
  fallback sampling and retarget velocity.
- `cargo update -w --offline`: lock updated for the two workspace packages.
- `cargo fmt --all --check`, skill-docs, ci-scope self-test, shell/Python syntax,
  new README links and SPDX validation: PASS.

Commands use `--manifest-path toolkit/Cargo.toml` from the repository root.
Local builds used `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0` to keep disk use down. Rust: 1.99.0; libatspi: 2.62.1;
Arch Linux, kernel 7.2.9-zen1-1-zen, AMD RX 5700 XT / Mesa 26.2.4.

## Full widget acceptance through libatspi

**19 oracles PASS at scale 1 and 1.25; all 38 applied controls CAUGHT.**
No stage subset or skipped scale. Each control fails precisely its own assertion,
after an independent semantic-publication barrier; a timeout, crash or missing
application marker is an infrastructure failure, never a caught control.

The oracles cover frame/list/scroll/group/switch/button roles and names, selected
page, group/header and control/label relations, hidden removal, normal controls
visible at rest beside one wide row, Tab/Shift+Tab, checked state after Space,
offscreen retention, focus scroll, sidebar/title occlusion and two actual material
layers at the widget pane bounds.

Hyalo: #875, source `f54fe6d456168ba3950d091e45600ebeb678d9cd`, compiled from its
unchanged worktree into this worktree's `toolkit/target/hyalo875` (reflinked release
cache). No Hyalo code is included in #873. Its IPC reported sidebar `(0,0,250,480)`
and title `(250,0,800,48)`, each with one declared glass shape. The root spans
`1050×480`. The sidebar-into-root control removes those entries and is caught.

Reproduction (private cage → Hyalo, private D-Bus/runtime/config, local portal fixture):

```sh
HYALO_BIN="$PWD/toolkit/target/hyalo875/release/nidara-hyalo" \
NK_SETTINGS_DATA=/path/to/exported/settings-data \
NK_WIDGETS_LOG="$PWD/toolkit/target/widgets-full-727ba6be" \
    toolkit/widgets-demo/check-headless.sh
```

Evidence: `toolkit/target/widgets-full-727ba6be/` (`environment.json`, `result.json`,
per-scale baseline trees/windows, per-control `caught.json` and applied-fault logs).
Demo SHA-256: `247a0446f989b16064573eaea861a0af928923f78dbc9bf5639a18f4a4b8acff`.
Hyalo SHA-256: `7afec05e9e056aab1b9b6b9a149f0bf1de90209fbd24a65844796c664d63372e`.

## Phase-0 compatibility

The existing `scripts/ci/nk-a11y-check.py` was run unchanged against the final
phase-0 binary/provider on the same #875 build: **18/18 checks PASS, 18/18 controls
caught**, including text/selection, password redaction, active/focus, dropdown,
dialog/error/restore and remote actions. Evidence:
`toolkit/target/phase0-a11y-727ba6be/a11y/report.json` and per-stage logs.
The existing `hyalo-ime-probe` helper was compiled into target/ from its CI source.
An initial attempt without that prerequisite failed setup and did not count.

## Evidence limits and remaining integration

This is structural/input/AT-SPI evidence on nested Hyalo, not a glass/presentation
pixel result. The local EGL log still contains BAD_ALLOC/BAD_SURFACE. Real
fcitx5/Orca and visible-frame checks remain the unchanged vkms CI gates; no speech
or real-engine success is inferred from libatspi. No foreign-compositor run was
added (D5 is unit-tested, per the accepted contract).

CI builds the demo and runs the full checker after the existing phase-0 and real
engine/Orca checks. `ci-scope.sh` explicitly keeps nk-widgets and its demo in those
matrices. The IPC assertion requires #875; rebase onto main after #872 lands.

The demo logs its explicit, owner-permitted `panel-stub.json` until the glass
material is exported by Claude. This is named source data, not Rust colour/glass
constants; the crate receives all appearance inputs. Hyalo's layer-glass rendering
and the graded-title A/B decision remain separate owner/Claude work.

Builds, logs and evidence are in target/; private runtime sockets are created under
`~/Nidara/ChatGPT/` and removed on exit. Nothing new is built or logged in /tmp.

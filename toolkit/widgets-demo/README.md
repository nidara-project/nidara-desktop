<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Structural widgets demo (#873)

`nk-widgets-demo` uses only `nk-wayland::Application`. Its fixed data exercises the
window, sidebar, title bar, scroll region, groups, rows, switches and buttons. It
is not Settings and never calls Config1. The small button actions change only its
own demo data (scroll, hide, font size, sidebar transition).

```sh
cargo build --manifest-path toolkit/Cargo.toml -p nk-widgets-demo
NK_SETTINGS_DATA=build/settings-data toolkit/target/debug/nk-widgets-demo
```

Export the settings data first with the repository's exporters. The shared data
version must be `1`. The demo subscribes to the Settings portal before ReadAll and
selects the exact exported accent/mode/reduce-transparency/window-background set;
an unknown or missing set is an error. Interface font and text scale come from
`org.gnome.desktop.interface`. Neither Config1 nor a guessed palette is a fallback.

`panel-stub.json` is the explicitly permitted D7 stub: named `TONES.panel`,
`SHADOWS.panel`, `DEFAULTS` from `platform/glass-material.ts` and the switch's
measurements from `_components.scss`, with source/date recorded. It is used only
while `tokens/glass.json` is absent and logs `PANEL_MATERIAL_STUB`. Claude owns that
export; its eventual schema should replace the stub reader together with the
export. No glass numbers are copied into Rust. Hyalo's layer-glass rendering is
separate work; the demo declares materials without claiming to validate the blur.

Local checks run in a private headless cage/Hyalo and portal fixture:

```sh
HYALO_BIN=/path/to/nidara-hyalo NK_SETTINGS_DATA=build/settings-data \
    toolkit/widgets-demo/check-headless.sh
```

The harness stores evidence under `toolkit/target/widgets-evidence` and creates a
short private runtime under `~/Nidara/ChatGPT/`, removed on exit. No live bus or
compositor is used. `NK_WIDGETS_LOG` changes the evidence directory;
`NK_WIDGETS_BIN` overrides the demo. Neither may point at `/tmp`. CI instead uses
its installed real portal and the vkms session, with `NK_WIDGETS_TEST=vkms`.

`scripts/ci/nk-widgets-check.py` drives the real AT-SPI provider through libatspi.
The full baseline must pass before controls run. Each `--fault=STAGE` is demo-only,
logs `CONTROL_APPLIED STAGE` where it mutates behavior, and must fail precisely
STAGE's assertion. Publication/setup deadlines and process exits are infrastructure
errors, never successful controls. `caught.json` records the assertion and applied
fault. The tree and Hyalo's windows listing are saved alongside client logs. The entire
baseline and every control run at scales 1 and 1.25, on their own private floating
workspace; the original output scale and workspace are restored.

D7's final IPC assertion uses #875's `windows[].layers`: two committed material
panes at the widget sidebar/title bounds (`x`, `y`, `width`, `height`, `glass_shapes`).
It requires that Hyalo revision; the earlier IPC listed only layer-shell. `NK_WIDGETS_STAGES='frame … under-title'` allows
local subsets during that work; the CI invocation has no subset and stays strict.

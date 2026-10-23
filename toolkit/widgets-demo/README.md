<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Structural widgets demo (#873)

`nk-widgets-demo` uses only `nk-wayland::Application`. Its fixed data exercises the
window, sidebar, title bar, scroll region, groups, rows, switches and buttons. It
is not Settings and never calls Config1. The small button actions change only its
own demo data (scroll, hide, font size, sidebar transition). The title bar has its
sidebar button; twenty fixed pages exercise independent scrolling and reveal.
`--content-width=N` configures the window law, and `--narrow` opens just below
its breakpoint. The checker uses the exported WINDOW_LAYOUT.contentFloor for
this compact fixture so both scales fit the isolated output; the default remains
WINDOW_LAYOUT.content. Neither depends on the current page.

```sh
cargo build --manifest-path toolkit/Cargo.toml -p nk-widgets-demo
NK_SETTINGS_DATA=build/settings-data toolkit/target/debug/nk-widgets-demo
```

Export the settings data first with the repository's exporters. The shared data
version must be `1`. The demo subscribes to the Settings portal before ReadAll and
selects the exact exported accent/mode/reduce-transparency/window-background set;
an unknown or missing set is an error. Interface font and text scale come from
`org.gnome.desktop.interface`. Neither Config1 nor a guessed palette is a fallback.

`tokens/glass.json` is required. The portal's dark mode and reduce-transparency
select one `variants[]` entry. The sidebar selects the last
`pieces.panel[]` step whose `fromSide` is at most its rounded shorter side, every
time its size changes. Glass, tone (including the object-shaped wash) and shadow
come from that entry; reduce transparency uses the exported variant directly.
The switch's size and look come from `components.json` `switch` (`toolkit/tokens/switch.json`), through `nk_settings::styles` like every other token.
The demo does not yet enable backdrop-driven `ink`/`inkTone`. The header reads
`blur.panel` for its blur-only material.
`fixtures/glass.json` is the real #881 export with unrelated pieces removed;
tests cover all four variants, the size ramp and malformed/stub input.

The header uses the owner's provisional curve C in `titlebar-provisional.json`:
a 72px zone, curve 1/1/0.5/0 and background fade 85%→0, without glass tone/rim.
It grows if the accessible title needs more height. Reduce transparency uses an
opaque header without blur/extension. The floating sidebar currently uses exported
padding/group radius as provisional margin/radius, pending the owner's live tuning.
The server controls use the real layout from `nidara-window-controls-v1`; without
that protocol the title has retained Minimize/Maximize/Close buttons.

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
The full baseline (including separate sidebar-reveal/collapse/overlay walks) must
pass before controls run. Each `--fault=STAGE` is demo-only,
logs `CONTROL_APPLIED STAGE` where it mutates behavior, and must fail precisely
STAGE's assertion. Publication/setup deadlines and process exits are infrastructure
errors, never successful controls. `caught.json` records the assertion and applied
fault. The new walks record before/after geometry in observations.json. The tree and Hyalo's windows listing are saved alongside client logs. The entire
baseline and every control run at scales 1 and 1.25, on their own private floating
workspace; the original output scale and workspace are restored.

D7's final IPC assertion uses #875's `windows[].layers`: two committed blur/material
panes at the floating sidebar bounds and title zone (`x`, `y`, `width`, `height`, `glass_shapes`).
It requires that Hyalo revision; the earlier IPC listed only layer-shell. `NK_WIDGETS_STAGES='frame … under-title'` allows
local subsets during that work; the CI invocation has no subset and stays strict.

D8 list tokens originate in provisional shared `toolkit/tokens/list.json`.
The exporter resolves default/variants into `components.json` at `variants[i].list`; the demo
reads the portal-selected installed variant, without compiled fallback values.
Pointer focus has no ring, keyboard focus uses the element's own shape, and
selection stays independent. These numbers still require live owner review.

`tokens/components.json` is independent of glass material. Its mode variant
contains list appearance, common padding/gap/radii and named content widths.
The geometry/width values alias the current kit exports; `reading` and `none`
have no invented width. Group + rows applies the shared list behavior once.
`tokens/glass.json` carries only material, including the control response/washes.

`--choices` adds a "Choices" group above the foundations' content: two segmented radio groups
(window controls, dock size) and the accent swatches, coloured from colors.json's `accents`,
and a "Night light" group: the temperature slider (1000–6500 K by 100, at 4500) and the "From"
time fields (#882). It answers AT-SPI `SetValue` through `Tree::request_value`. `scripts/ci/nk-choices-check.py` drives it, run with
`NK_WIDGETS_CHECK=nk-choices-check.py toolkit/widgets-demo/check-headless.sh`; its faults
(`two-checked`, `swatch-name`, `radio-role`, `arrows`, `slider-value`, `value-stale`,
`spin-name`; `set-value` in `main.rs`, where requests are handled) live in `src/choices.rs`. The radio
groups' look comes from `toolkit/tokens/choices.json` through `components.json`'s `choices`.

Opaque capsule fallback supports a finite exported wash fade. In this cut the
foundations demo still polls every 16 ms, even after the fade settles.
CapsuleComposition::is_animating() is available but not yet consumed here;
no idle scheduling acceptance is claimed.
The bounded capsule laboratory remains a separate cut.

Idle capsule washes preserve hover RGB at zero alpha, matching server controls
for normal and destructive buttons. D5 and D7 share this target; interpolating
from transparent black would change the visible fade. Native fade acceptance
remains pending; earlier fixed capture binaries predate this correction.

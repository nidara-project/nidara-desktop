# Hyalo

Nidara's own Wayland compositor, on [Smithay](https://github.com/Smithay/smithay) — the plan
and the decisions are in issue #680, the measurements that led there in #679. Until it reaches
parity with what the desktop does on Hyprland it is a **preview session**: Hyprland stays the
default, and nothing switches until the whole desktop works here (#685).

Smithay does the plumbing (DRM/KMS, libinput, the Wayland protocols); Hyalo does the rest —
what is drawn and how, the glass, the layers, the rules.

## Layout

| Path | What |
|---|---|
| `compositor/` | the compositor; its binary `nidara-hyalo` is also the CLI (`nidara-hyalo msg …`) |
| `../protocols/` | our Wayland protocols (XML), shared with the client side in `lib/nidara-wl` |
| `scripts/` | development harnesses (below) |

## Build

    cd hyalo && cargo build --release

Needs `rust`, `seatd` (libseat), `libinput`, `libdisplay-info`, `mesa`, `libxkbcommon`.
`cargo test` runs the unit tests; CI also runs `cargo clippy --all-targets -- -D warnings`.

## Run

    nidara-hyalo --winit -c gtk4-widget-factory    # in a window of your current session
    nidara-hyalo                                   # on a VT, as a real session (DRM/KMS)
    nidara-hyalo msg outputs                       # ask the running one
    nidara-hyalo msg windows                       # every window, its workspace and state
    nidara-hyalo msg do workspace 3                # a window-manager command, as in a binding

The session entry the greeter lists is "Nidara — Hyalo preview" (`config/wayland-sessions/`).
`Ctrl+Alt+Backspace` ends a Hyalo session — the way out while nothing else is.

Configuration: `/usr/share/nidara/hyalo/hyalo.toml` (shipped), then
`~/.config/nidara/hyalo.toml` on top, key by key; the file is watched. Runtime changes go
through IPC, never by rewriting the file. The shipped file has the layout (gaps, the tiling
layout), the per-workspace floating/tiling default, and the key bindings — the same set as the
Hyprland session; `[binds]` syntax in `compositor/src/binds.rs`, the commands in
`compositor/src/wm/actions.rs`.

A crash leaves a report in `~/.local/state/nidara/hyalo/`, which `nidara-doctor` lists.

## Development harnesses

Never against the live session: these run Hyalo in a window of a **headless** `cage`, on the
real GPU, and screenshot it.

    scripts/headless-shot.sh out.png 5 gtk4-widget-factory
    scripts/headless-shell.sh out.png 25          # the real shell, sealed off (sandboxed-shell.sh)

`HYALO_CONTROL` (a FIFO) feeds pointer and key events straight to the seat — synthetic motion
through a headless host never reaches a nested window. Verbs in `compositor/src/control.rs`.

## On your own machine (a dev install)

    hyalo/scripts/install-preview.sh              # build, then install the session (sudo)
    hyalo/scripts/install-preview.sh --uninstall

The `nidara-hyalo` package needs the `nidara-desktop` package, which a dev install removes, so
this script puts the same files where the package would and touches nothing else. The greeter
lists "Nidara — Hyalo preview" from its next start.

    hyalo/scripts/measure-session.sh [seconds]    # run once on Hyprland, once on Hyalo

The same scene in either session — the shell with the Control Center open, blur off, your
wallpaper still and then an animated one — with mean `gpu_busy_percent` and the compositor's
CPU; everything it touches is restored. Results land in `~/.local/state/nidara/hyalo/`.

## Bumping Smithay

Smithay is pinned by revision in `Cargo.toml` (`[workspace.dependencies]`) and **never
patched** — its `AI.md` discourages LLM-written contributions, so something we would need
changed there is a no-go, not a PR (#679). To move the pin:

1. Change `rev` in both `smithay` and `smithay-drm-extras` (same revision).
2. `cargo update -p smithay -p smithay-drm-extras` and build; fix what its API changed.
3. Read Smithay's `CHANGELOG.md` between the two revisions for behaviour changes, especially
   around `OutputDamageTracker`, `DrmCompositor` and framebuffer effects (the glass,
   `compositor/src/render/glass.rs`, rides on that mechanism).
4. Run the harnesses above and the CI job; on hardware, a session in the VM.

## Licence

GPL-3.0-or-later. Parts started from Smithay's `smallvil` and `anvil` (MIT, see
`LICENSE-smithay-MIT.txt`); `protocols/hyprland-focus-grab-v1.xml` is Hyprland's (BSD-3-Clause,
in the file).

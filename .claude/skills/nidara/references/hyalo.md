# Hyalo — the compositor of our own

Hyalo (`hyalo/`) is Nidara's Wayland compositor, on Smithay (Rust). The decision and the plan
are issue #680 (five blocks, #681–#685); the measurements that led there, #679. **Until the
switch (#685) Hyprland is the session everybody gets**; Hyalo ships as a second session,
"Nidara — Hyalo preview", in its own package (`nidara-hyalo`), which nothing depends on and
`install.sh` does not install. Build and run instructions are in `hyalo/README.md` — this file
is the WHY and the traps.

## Where Hyalo's pieces are

| Path | What |
|---|---|
| `hyalo/compositor/src/backend/tty.rs` | the session: DRM/KMS + GBM, libinput, libseat, udev hotplug, frames paced by vblank |
| `hyalo/compositor/src/backend/winit.rs` | a window in another compositor — development only |
| `hyalo/compositor/src/render/` | the scene as render elements, front to back; the glass (`glass.rs`, `glass_gl.rs`) |
| `hyalo/compositor/src/outputs.rs` | outputs as configured: arrange, apply, power, the windows' way home (#594) |
| `hyalo/compositor/src/config.rs` | the TOML layers and the watcher |
| `hyalo/compositor/src/wm/` | the window manager: workspaces, focus, floating/tiling, fullscreen (`mod.rs`), the commands (`actions.rs`), pointer move/resize (`grabs.rs`), tiling layouts (`layout/`) |
| `hyalo/compositor/src/binds.rs` | key and pointer bindings from the config's `[binds]` |
| `hyalo/compositor/src/ipc/` | the JSON socket and `nidara-hyalo msg` |
| `protocols/` | OUR protocols' XML, for both ends: Hyalo builds the server half, `lib/nidara-wl` the client half |
| `config/hyalo/hyalo.toml` | the shipped defaults, autostart included |
| `bin/nidara-hyalo-session`, `config/wayland-sessions/nidara-hyalo.desktop` | the preview session |
| `ui/shell/core/hyalo-ipc.ts`, `ui/shell/core/Displays.ts` | the shell's side (below) |

## Smithay is a library we never patch

Pinned by revision in `hyalo/Cargo.toml`, never forked or patched — Smithay's `AI.md`
discourages LLM-written contributions, so "we need a change in Smithay" is a dead end, not a
PR (#679's hard criterion). Everything Hyalo does goes through Smithay's public API. The way to
move the pin is in `hyalo/README.md`.

## The glass is a framebuffer effect, not an offscreen frame

`render/glass.rs` makes each surface's glass (`nidara-material-v1`) a render element of its
own, placed right below its surface, that declares `is_framebuffer_effect()`. Smithay's damage
tracker then calls `capture_framebuffer` when — and only when — something BEHIND the glass
changed, after redrawing everything behind it, and `draw` when the glass's own area is damaged.
So a bar over a still wallpaper re-blurs nothing per frame, and the rest of the frame keeps
damage tracking and direct scanout. The prototype drew every frame whole into a texture; do not
go back to that.

- **The shader works in OUTPUT pixels and borrows Smithay's projection** (`GlesFrame::projection()`),
  so every rotation or flip of an output is handled once, there. The captured copy is in
  framebuffer orientation; the blur is isotropic, so the pyramid does not care.
- **8-bit swapchains only** (`COLOR_FORMATS` in tty.rs): `glCopyTexSubImage2D` copies into an RGB
  texture, which any 8-bit framebuffer can feed and a 10-bit one cannot.
- GL objects that belong to a context live in the EGL context's user data; a glass's own pyramid
  lives in the damage tracker's per-element cache, and is deleted through a trash list on the next
  capture, because a cache is dropped where no context is current.

## The window manager

Hyalo is **dual** (owner, 2026-10-01): each workspace is floating or tiling, floating by
default, exactly as `WorkspaceModes` (#513) made it on Hyprland. **No tab groups, and dwindle is
the only tiling layout** — groups and `master` existed because Hyprland had them; the owner
dropped groups and kept the door open for more layouts. That door is `wm/layout/`: a `Layout`
trait that only knows window ids and rectangles, so a new layout is a file plus a line in
`layout::new`, tested on its own. A new layout never touches the window manager.

- **The model is `Wm`; Smithay's `Space` holds only what is VISIBLE**, rebuilt from the model by
  `sync_space()` after every change, in stacking order: per output, the active workspace's tiled
  windows, then its floating ones, then a special workspace over it. A window on a hidden
  workspace is not in the space at all (no frames, no input, no `wl_surface.enter`). A
  fullscreen window hides the rest of its workspace and is drawn ABOVE the top layers (it covers
  the bar); `render::windows_front_to_back` is the one place that decides that order, and both
  drawing and hit-testing (`surface_under`) use it.
- **#594 is now per workspace, not per window.** A workspace remembers its home output; when
  that output goes, the workspace is shown elsewhere (not active), and when it returns under the
  same connector name the workspace goes back and is shown again. A floating window's box is
  stored relative to its output (`float_rect`), so it returns to where it was. Verified in the
  VM with two outputs, switching one off and on (2026-10-01).
- **Floating placement** is the Hyprland session's, ported from `hyprland.lua`: centred (a
  dialog over its parent), clamped inside the usable area with the top edge winning (#11,
  `clamp_floating`), and stepped off a window it would cover entirely (`cascade`, KWin's
  `cascadeIfCovering`). A dialog, or a window whose min size equals its max, floats even on a
  tiling workspace (`wants_floating`).
- **Client maximize requests are refused** (the Hyprland session's `suppress_event = "maximize"`):
  Super+M maximizes. Fullscreen requests are granted.
- **One command language** for bindings and IPC (`wm/actions.rs`): `workspace 3`,
  `move-to-workspace-silent 2 ID`, `toggle-floating`, `set-workspace-mode 3 tiling`,
  `focus-output DP-2`… A command without a window id acts on the focused window. The shell
  reaches it with `nidara-hyalo msg do <command>` (or the `do` request); `windows` and
  `workspaces` list the state, and the event stream sends `windows_changed`,
  `workspaces_changed`, `focus_changed` (once per event-loop round, however many changes) and
  `window_title_changed` on its own — the same split as HyprlandState's "changed" vs
  "title-changed", for the same reason (a terminal spinner renames its window constantly).
- **Bindings** (`binds.rs`) match the key's unshifted symbol in the first Latin layout, so
  `Super+1` works with Shift held and on any layout. `release = true` fires only if nothing else
  was pressed while the key was held (Super alone opens the app grid; Super+T does not).
  Ctrl+Alt+F1…F12 and Ctrl+Alt+Backspace are built in and cannot be bound over.
- **Border and rounding are not drawn yet**: the geometry reserves `layout.border` (1 px) so
  windows line up with the bar exactly as on Hyprland; the border is drawn with the rounding and
  shadows in #684.

## Three config layers, and runtime changes over IPC

Read in order, merged table by table, last wins: `/usr/share/nidara/hyalo/hyalo.toml` (shipped),
`~/.config/nidara/hyalo-settings.toml` (written by Settings, never by hand),
`~/.config/nidara/hyalo.toml` (the user's own) — the order of `nidara-*.lua` then
`hyprland-user.lua`. The files are watched (an mtime poll, immune to editors that replace the
file); a broken file is refused and the running settings stay. An unknown key is an error, not
silently ignored (`deny_unknown_fields`).

Runtime changes go through the IPC socket, never by rewriting a file — the 09-12 freeze came
from Hyprland's config being rewritten twice in a second (`project_freeze_after_533_checkout`).
A setting changed over IPC is runtime only; persisting it is the shell's job (MonitorConfig
writes `hyalo-settings.toml`).

## The shell on Hyalo

The shell finds Hyalo by `$HYALO_SOCKET`, which `uwsm finalize HYALO_SOCKET` (Hyalo's first
autostart line) exports to the session's services. `core/hyalo-ipc.ts` speaks the socket the way
`core/hypr-ipc.ts` speaks Hyprland's: sync requests, one held event stream that reconnects and
says so. `core/Displays.ts` hands out the monitors in one shape from either compositor; the
Display page and `core/MonitorConfig.ts` read only that. **This is the pattern #682 extends to
the rest of the shell** (workspaces, windows, rules): a facade per concern, Hyprland behind one
side, Hyalo's IPC behind the other — not `if (hyalo)` sprinkled through surfaces.

**Since #682's second part the whole shell talks to ONE interface**, `core/CompositorState.ts`,
whose backend is `HyprlandState` on Hyprland and `HyaloState` on Hyalo (architecture.md has
both rows). The bar's title, the window menu, the dock, the island and its overview, the app
grid, the agent pointer and the IPC verbs (`listWindows`, `focusWorkspace`, `screenshot`…)
work on Hyalo; the CRITICAL flood the shell logged there is gone. What only one compositor has
is in `caps` (Hyalo: no tab groups, dwindle only, no glow yet), and the shell hides it rather
than failing. Still Hyprland-only — their config options and the Lua the shell writes for
them — are the files in `scripts/ci/compositor-boundary-allowlist.txt` (Input, Display, gaming,
reduce motion, blur…): they do nothing on Hyalo until they become requests both compositors
answer.

Two things Hyalo had to learn for the shell, both Hyprland behaviour the shell relies on:
- **A layer surface that changes level goes to the TOP of its new level** (`layer_commit`).
  Layer-shell has no "raise", so the island gets above the bar by leaving OVERLAY and coming
  back (`IslandWindow.raise`), and asks the compositor whether it worked (`isLayerAbove`,
  answered from the `layers` request). Smithay keeps surfaces in the order they were mapped,
  so Hyalo re-maps a surface whose level changed.
- **When the bar or the dock takes room, floating windows under it move out** (`reclamp_floating`):
  a window opened before the shell started would otherwise sit under the bar.

## Traps found running Hyalo for real

- **Autostart runs only with `--session`.** `uwsm finalize` from a development window would
  export the window's socket into the LIVE session's services. The session entry passes the flag;
  nothing else should.
- **An output that goes away: surfaces leave FIRST, the global goes after.** A client that sees
  the global removed destroys its `wl_output`; a `leave` naming it afterwards arrives as
  `leave(nil)`, which killed kitty outright. Layer surfaces on that output get `closed`, as
  wlr-layer-shell asks.
- **A mode list that changes is not a hotplug.** EDID arriving late, or a VM window resized,
  sends udev `Changed`: keep the output, update the list, re-set a mode only if the current one is
  gone. Rebuilding the output closed every surface on it — and the shell's bar came back with its
  clock stopped (a GLib source removed twice), a shell bug that rebuild exposed.
- **Software rendering is accepted for the primary GPU** (CI's vkms, a VM without 3D); after
  adding it, re-read the primary node, which may now be the card node. `HYALO_DRM_DEVICE` names the
  ONE GPU to use and then only it.
- **A refusal is said.** `vrr=on` on a monitor without VRR is an error, not a silent no-op.
- **The scan-out feedback is sticky** (`pick_feedback` in `backend/mod.rs`). Smithay's
  `select_dmabuf_feedback` follows the frame, and each switch is a new modifier set. Mesa's
  Wayland WSI answers that with `VK_SUBOPTIMAL_KHR`, and GTK rebuilds its swapchain on it, so the
  shell logs a `Gdk-WARNING … VK_SUBOPTIMAL_KHR` for each rebuild. It counted 55 in its first
  25 s on an amdgpu (2026-10-01), while the one free overlay plane passed between its
  monitor-sized layers. Once offered, the scan-out feedback stays. This is safe only while the
  scan-out tranche lists nothing we cannot render from (`surface_feedback` in tty.rs intersects
  it with the render formats). Drop that intersection and the sticky rule becomes a bug. Hyprland
  never shows this, because it uses no overlay planes. Its only direct scan-out is a fullscreen
  window.
- **A space element's location is its GEOMETRY's origin**, not its surface's. Smithay subtracts
  the client's decoration offset (`window.geometry().loc`) itself when it draws and hit-tests, so
  `map_element(window, rect.loc)` is right and `rect.loc - geometry().loc` puts a kitty 25 px
  too low and a GTK window 22 px up-left (both measured, 2026-10-01). When YOU hit-test a
  window's surfaces, it is the other way round: `location - geometry().loc`.
- **Never ask the pointer for anything inside a `PointerGrab` callback.** `unset` runs with the
  pointer's lock held, and `seat.get_pointer().current_location()` there deadlocked the whole
  compositor on the first Super+drag. The grab keeps the last location itself, and settling the
  window runs from an idle callback.
- **Never run a bare `nidara-hyalo` from a shell in the live session**, not even for its help
  (`--help` is the flag): with `WAYLAND_DISPLAY` set it starts a compositor in a window of the
  live desktop. The harnesses below are the way to run it.
- `xcursor`'s `pixels_rgba` is the file's byte order, i.e. DRM `Argb8888`, whatever its name says.
- A screenshot's read-back (`ExportMem::copy_framebuffer`): a mapping that is NOT `flipped()`
  holds the bottom row first.

## Testing Hyalo

- Never against the live session. `hyalo/scripts/headless-shot.sh` and `headless-shell.sh` run
  Hyalo in a window of a HEADLESS `cage` on the real GPU (the real shell sealed off by
  `sandboxed-shell.sh`), with `HYALO_CONTROL` for input and `nidara-hyalo msg screenshot` for
  pictures. `HYALO_CONTROL` keys go through the same path as a keyboard's, bindings included
  (`key`, `keydown`, `keyup` take evdev codes; `press`/`release` for buttons), so a binding can
  be tested headless. A test config must not bind anything that reaches the live session
  (`nidara-ipc`, `uwsm app`, `systemctl --user`): the nested Hyalo's children share its D-Bus
  and systemd.
- The tty backend — the one that matters — is tested in the VM (maintainer harness), as a session
  from the greeter or from a VT; QEMU's `virtio-gpu,max_outputs=2` gives two outputs.
- On real hardware: `hyalo/scripts/install-preview.sh` installs the session on a dev install
  (the package cannot go there), and `measure-session.sh`, run once per session, gives the
  like-for-like numbers #681 asks for. Running Hyalo on the maintainer's own GPU is the owner's
  step: it needs sudo, and the first boot on new hardware is the one most likely to fail.
- CI's `hyalo` job (`scripts/ci/hyalo-smoke.sh`) builds with the lock file, clippy `-D warnings`,
  unit tests, then boots the tty backend on vkms with the real shell on it. NOT a required check
  while Hyalo is a preview: it must never hold the merge queue for the desktop that ships.

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
| `hyalo/compositor/src/wm/` | the window manager: workspaces, focus, floating/tiling, fullscreen (`mod.rs`), the commands (`actions.rs`), pointer move/resize (`grabs.rs`), tiling layouts (`layout/`), window rules (`rules.rs`), which windows are games (`games.rs`) |
| `hyalo/compositor/src/binds.rs` | key and pointer bindings from the config's `[binds]` |
| `hyalo/compositor/src/ipc/` | the JSON socket and `nidara-hyalo msg` |
| `hyalo/compositor/src/capture.rs` | window capture for the shell's thumbnails (ext-foreign-toplevel-list + ext-image-copy-capture) |
| `hyalo/compositor/src/sandbox.rs` | what a sandboxed (Flatpak) client is not offered |
| `hyalo/compositor/src/activation.rs` | an app bringing its window to the front (xdg-activation) |
| `protocols/` | OUR protocols' XML, for both ends: Hyalo builds the server half, `lib/nidara-wl` the client half |
| `config/hyalo/hyalo.toml` | the shipped defaults, autostart included |
| `bin/nidara-hyalo-session`, `config/wayland-sessions/nidara-hyalo.desktop` | the preview session |
| `ui/shell/core/hyalo-ipc.ts`, `ui/shell/core/Displays.ts` | the shell's side (below) |
| `ui/lib/nidara-kit/platform/material.ts`, `ui/shell/core/CompositorGlass.ts` | the glass's client half: the shapes, and the numbers (below) |

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

## The shell's glass is declared, and on Hyalo the compositor paints it (#684)

Every pane of the shell's glass tells the compositor exactly where it is:
`ui/lib/nidara-kit/platform/material.ts` (`trackGlass`) collects the shapes of each surface and
sends them in the frame clock's LAYOUT phase — after GTK allocated, before it paints and
commits, so they land with the buffer they describe. A paint-only frame (an animation that only
queues draws) skips that phase, so every before-paint asks for it. The source of the glass's
numbers is the bundle's (`ui/shell/core/CompositorGlass.ts`, registered from AppearanceSync);
on Hyprland nothing offers the protocol and all of it is a no-op.

**A painter asks `compositorPaintsGlass(itsWidget)`** and, when true, paints only content and
state — the accent fill, the hover/open veil, the shadow — never the body or the rim. The
painters that do: `SquircleContainer` (every pane with `useShellOpacity` and no explicit
`alpha`), the dock's pill on both axes (`DockAxis.ts`), the island's morph clone
(`MorphRevealer.glassShape`), the Notification Center's stacked-card bands, and tooltips and kit
menus (`trackBubbleGlass`, owner 2026-10-01: refractive too, and blurred MORE than panels). A
bubble's pointer is part of its shape (protocol v3, `add_shape_pointed`: base, tip, width, tip
radius, base radius — one geometry, `bubbleGeometry`, for the painter and the protocol); Hyalo
unions an inset triangle grown back by the tip radius with the body through a round union of
the base radius (`shape_sdf`), so body and pointer are one glass with one rim. A popover's blur
is `popoverBlur` (default: one pass more than the panels'). On a compositor that cannot draw a
pointer the bubble is `clientPaints` (asked every frame: `compositorDrawsPointers`), and a
surface holding any such shape is blurred only, never given the compositor's glass under a
client's. A new glass painter goes through the same two calls, or it is a pane Hyalo knows
nothing about.

🔴 Every shape and box of an entry needs its OWN clip object: `move` shifts each one, so a
clip shared between two moved twice. `intersect` always returns a new rectangle — when it
returned its argument, a notification's clip ended 4× off-screen once its three ink boxes
shared it; Hyalo got no shape, the painter believed Hyalo painted it, and its white text sat on
the bare white backdrop.

What is sent is what the toolkit SHOWS (protocol v2, `add_shape_clipped`):
- **snapshot-time transforms** of the ancestors — `ScaleRevealer.glassPaintTransform()`; GTK's own
  geometry never sees a scale applied in `vfunc_snapshot`;
- **the opacity** of the widget and every ancestor, per shape: a panel fading in or out fades its
  blur, glass and rim with it;
- **the clip** of every ancestor whose overflow is hidden, per shape: a card scrolled half out of
  its list is cut straight, not rounded. The clip is pushed BEFORE that ancestor's own snapshot
  transform, so it is its unscaled box.
- Glass inside glass is not declared (`nested`): a control painted on a panel keeps painting
  itself, or Hyalo would draw a rim inside the panel. Shapes are drawn in tree order.

`NIDARA_MATERIAL=0` turns the client half off (every painter back to its own glass);
`NIDARA_MATERIAL_DEBUG=1` logs every surface's shapes as they change. On a dev install,
`~/.config/nidara/glass-tuning.conf` (`key = value`: `alphaMin alphaMax target refraction lensing
rim saturation inkDarkAbove inkLightBelow`, `blur`/`popoverBlur = SIZE:PASSES`, `glass = off` /
`ink = off` for the A/B; the full list is `CompositorGlass.ts`'s header) is re-read as it is saved
— it is how the numbers are tuned with the owner on screen.
A blur's `SIZE:PASSES` means the SAME blur on Hyalo as on Hyprland — the numbers are shared
(`GLASS_BLUR`, the material selector). Hyalo's dual kawase is Hyprland's: the down-sample's taps
at `size` source texels, the up-sample's at ¼ and ½ of that. Until 2026-10-02 the up-sample's sat
four times as far, and 2:2 blurred a step edge over 28 px against Hyprland's 12 (owner-caught:
"1:2 here blurs more than Hyprland's 2:2"). Measured since on the real GPU, nested, glass off,
over a black/white wallpaper (`HYALO_WALLPAPER`): 1:2 → 8 px, 2:2 → 12 px, 10–90 % of the edge.
The refraction is PER SHAPE (protocol v4, `set_lensing`): `refraction` is every shape's least,
and `lensing` × the shape's shorter side wins where it is more, so a large pane lenses more than
a capsule without a number per surface. The capture region grows by each group's largest
refraction, since the edge reads the backdrop from that far outside.
⚠️ `target` is a WCAG relative luminance — LINEAR light, the adaptive glass's own number (primary
text at 4.5:1 → 0.183), and `alphaMax` is its ceiling (`GLASS_ADAPT_CEILING`). The shader mixes
the tint into the ENCODED colour, so it searches for the least alpha that meets it (8 bisection
steps) rather than solving in encoded luma: compared against encoded luma, a white backdrop came
out at 10:1 under a near-black glass where 4.5:1 was asked (owner-caught 2026-10-01). `nidara-hyalo msg layers` shows what each
layer declared (`glass.shapes`, `glass.compositor_paints`), and the smoke requires the bar, the
dock and the island to declare theirs.

🔴 **The material rides on a commit GTK may never make.** It is double-buffered surface state,
and GTK commits only a frame that DREW something (it diffs render nodes; no damage, no commit).
A change that moves none of the client's pixels — every `glass-tuning.conf` value, the glass's
parameters — therefore waited for the next unrelated redraw: the bar picked it up within a second
(its clock), the dock, which repaints only when touched, never did (2026-10-02, seen in
`WAYLAND_DEBUG=client`: no `wl_surface.commit` after the `set_glass`). `nidara_wl_material_commit`
now marks the surface and commits it once more from the frame clock's `after-paint` — AFTER
GTK's present, so where GTK drew that extra commit is empty, and never BEFORE it, which would show
the new shapes over the old buffer for a frame.

🔴 **Cargo does not see the protocol XML.** The scanner macros read `protocols/*.xml` at compile
time without telling cargo, so an edited protocol left Hyalo built from the OLD file while
`lib/nidara-wl` was built from the new one; the two ends numbered the requests differently, a
message was read with the wrong arguments, and the shell hung on its first frame (2026-10-01).
`protocols/mod.rs` now `include_bytes!`s every XML it generates from — a new protocol there
needs its line too. And a new request goes at the END of its interface, with `since`: inserting
one renumbers every request after it, and an older client then speaks a different protocol.

### The ink: white text, dark only where the whole backdrop under it is white (#684)

Owner's decision, 2026-10-01, Hyalo only (on Hyprland the shell's skin stays dark, 2026-09-30).
There is no skin on Hyalo's glass: the text is white, and a pane's content turns dark only when
even the DARKEST point of the backdrop under it — as the glass treats it: blurred, saturated,
before its tint — is brighter than `inkDarkAbove`, and back only below `inkLightBelow`
(hysteresis). Never by an area's average: a mostly-light wallpaper with one dark stroke under the
text keeps it white.

- **Groups and boxes (client).** Each `trackGlass` entry is an ink group (`inkId`); its boxes are
  every LEAF widget its scope draws — labels with text, icons, Cairo areas, CSS-painted boxes like
  the workspace dots — except the glass's own painter, through the same transforms and clips as
  the shapes. More than 8 → their union (stricter, never looser). A type list (labels, images)
  missed the CSS-painted dots: the island's capsule stayed dark while everything else turned.
- **Measured by Hyalo (protocol v3: `add_ink_box`, `set_ink`, event `ink`).** In the glass's
  draw, when the capture or the boxes changed: one small pass samples a 12×12 grid of the blurred
  copy per box into a 64×1 target (one texel per box, the minimum as two bytes), read into a
  pixel-pack buffer behind a fence. `backend::poll_ink` collects it from a 4 ms timer that
  exists only while a readback is in flight — no frame waits, nothing ticks at rest. The
  hysteresis (`material::next_ink`, unit-tested with a control) runs there; a change sends `ink`
  and redraws.
- **The glass follows.** A shape holding a dark group is not darkened for white content: it gets
  the light veil (`set_ink`'s tint at `alpha_min`).
- **The client follows.** `libnidara-wl` puts the material object on GDK's own event queue, so
  GDK dispatches `ink` on the main loop as it arrives (no pump). The pane gets `INK_DARK_CLASS`,
  which `generateSkinFlipScope` gives the light skin's tokens; `chromeIsDarkFor` answers
  `darkInkFor` first, so Cairo painters follow; the subtree is redrawn.
- A group no longer declared keeps its decision on both ends (a panel reopens as it closed);
  `clear_ink` makes every group light on both ends.
- Thresholds: `CompositorGlass.ts` (0.80 / 0.65 to start), live in `glass-tuning.conf`
  (`inkDarkAbove`, `inkLightBelow`, `ink = off`) — calibrated with the owner, not final.
  `NIDARA_MATERIAL_DEBUG=1` logs every ink decision.
- To see it nested, `awww-daemon` crashes inside the headless cage (broken pipe), so give the
  backdrop with a gtk4-layer-shell BACKGROUND surface of your own through `HYALO_EXTRA`.

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
- **A modal dialog keeps the focus from its parent** (xdg-dialog-v1; GTK marks a `modal` transient
  window with it). `focus_window` is the one door to the focus — a click, the keyboard, the IPC,
  the overview — and it hands the focus meant for a window to its open modal dialog
  (`modal_target`, down a chain of modals). CI: `scripts/ci/hyalo-dialog-check.sh` (modal: the
  parent gives way; a plain dialog: it does not — the control). Without the redirect the first
  half fails (checked, 2026-10-01).
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
- **An app may hold the keyboard's shortcuts** (keyboard-shortcuts-inhibit-v1, `shortcuts.rs`): a
  virtual machine, a remote desktop, Chrome's keyboard lock in fullscreen. Granted at once while
  it has the keyboard (sway/KDE/niri; GNOME asks). Then only `dont_inhibit = true` bindings run —
  Hyprland's option of the same name: **Super+Escape → `toggle-shortcuts-inhibit`** (gives them
  back, GNOME's and niri's key) and the computer-control kill switch Super+Shift+Escape, which the
  Hyprland session marks the same way. The built-ins above are not bindings and always work;
  pointer bindings are not shortcuts and are not held. CI: `scripts/ci/hyalo-inhibit-check.sh`
  presses keys through `HYALO_CONTROL` (held → given back → control: Super+2 switches); a Hyalo
  that ignored inhibitors fails the first step (checked, 2026-10-01). ⚠️ Write each chord to the
  control FIFO in ONE write: Hyalo reads to EOF and reopens, and separate writes race the reopen
  (the shell dies of SIGPIPE, exit 141).
- **Window rules** (`wm/rules.rs`, `[rules.NAME]` in hyalo.toml): regexes searched in
  `app_id` / `title` / `initial_app_id` / `initial_title`, effects `float`, `center`,
  `workspace` (`"3"`, `"special:NAME"`) and `silent`. 🔑 **A rule applies to a window ONCE, the
  first time it matches** — at the first configure (so a floated window's first frame is
  already its own size), when it is shown, or later when its app id or title changes. That is
  #679 item 13 solved rather than worked around: on Hyprland a static effect is matched once
  against the BIRTH class, so a rule naming a stamped app id never fired and About had to be
  matched by title. Here it is matched by `nidara-about` — measured, the stamp already lands
  before the first buffer, so it applies at map with no jump. A rule that stops matching
  undoes nothing, and one that applied never applies again (a window the user re-tiles stays
  tiled through any number of renames). Rules are a table by name, not a list, so the user's
  hyalo.toml adds, replaces or switches one off (`enabled = false`) instead of replacing them
  all — the layers merge tables and replace arrays. Name order decides conflicts (later
  wins). `hypr-rule-check.mjs` reads them too: every app id or title they name must be one a
  window in ui/ declares (with a CI control that misspells one).
- **Named workspaces** (`name:gamespace`): a whole workspace like a numbered one, shown in its
  output's place, but outside the numbered row (`e+1` skips it) and made only by a rule. Ids from
  -1337 down, as Hyprland numbers them, so the shell reads one the same way from both: negative,
  NOT special. ⚠️ Special now means the NAME (`special:…`), not a negative id — `Workspace::is_special`
  and the shell's `HyaloState` both test the name, as HyprlandState always did; `is_numbered` (id >
  0) is the row. `workspace name:X` and `workspace <negative id>` show one that exists and are
  REFUSED (said, not ignored) for one that does not.
- **Games** (`games.rs`): a rule's `match = { game = true }` matches a window whose app id is
  `steam_app_<id>`, whose process or a parent carries a Steam app id in its environment, or whose
  surface says its content is a game (wp-content-type-v1, Smithay's `ContentTypeState`). The
  environment is read ONCE, when the window is created (`Managed::steam_app`): rules are asked again
  on every rename. The shipped `[rules.games]` sends games to `name:gamespace`, and the user goes
  with them; everything else about game mode is the shell's (architecture.md → "Game mode").
  Immediate presentation and tearing need async page flips, which Smithay's DRM backend does not
  have — that, VRR for a fullscreen game and idle inhibition are #683, not a rule.
- **Border and rounding are not drawn yet**: the geometry reserves `layout.border` (1 px) so
  windows line up with the bar exactly as on Hyprland; the border is drawn with the rounding and
  shadows in #684.

## Touchpad gestures (pointer-gestures-v1)

`input.rs` hands libinput's swipe, pinch and hold to the seat; the `PointerGesturesState` global
(state.rs) is what lets an app receive them — without it the seat has them and every app hears
nothing, silently (pinch-to-zoom in a browser, an image viewer). Hyalo binds no gesture to an
action of its own yet. CI: `scripts/ci/hyalo-gesture-check.sh` pinches to 2× over a GTK window
through `HYALO_CONTROL` (`pinch X Y SCALE`) and requires its `GtkGestureZoom` to report 2×; a Hyalo
without the global fails it (checked, 2026-10-01).

## Computer use (the Assistant's synthetic input)

`protocols/virtual_pointer.rs` (zwlr_virtual_pointer_v1, what `bin/nidara-input` speaks) and
Smithay's virtual keyboard (zwp_virtual_keyboard_v1, what `wtype` speaks). Every virtual event
goes through the same calls as a real device (`pointer_moved_to`, `pointer_button`, the seat's
axis), so focus, hit-testing and grabs treat it as one. Absolute motion without a bound output
spans every output together (wlroots' rule). Gating is the helpers' (Settings → AI), as on
Hyprland, which also lets any local client create one — except a sandboxed one here (below). The helpers read the compositor
through `bin/nidara-wm` (state-and-ipc.md → the computer-use layer). Verified nested
(2026-10-01): nidara-click clicks a button and an entry, nidara-type types into it, a
not-focused app is refused.

## Sandboxed clients (wp-security-context-v1)

`sandbox.rs`. Flatpak's bwrap asks the compositor for a socket of its own and gives the app only
that one; every client that comes in through it carries the context (`ClientState::
security_context`), and the privileged globals are NOT ADVERTISED to it — a filter on each global
(`sandbox::unrestricted`: Smithay's `new_with_filter` for its own, `can_view` in our
`protocols/`), so the app cannot bind what it never sees. Hidden: the virtual pointer and keyboard,
the window list and window capture, layer-shell, the focus grab, the glass material, and the
security-context manager itself (a sandboxed client must not mint a looser context). Kept:
everything an application needs.

- 🔑 **A NEW privileged global gets the filter in the same change.** Nothing fails if it does not:
  the global is simply offered to every Flatpak app. Add its interface name to `hidden[]` in
  `scripts/ci/hyalo-sandbox-probe.c` too.
- CI: the Hyalo smoke runs the probe, which creates a context the way Flatpak does, connects
  through it, and compares the two registries. Its control is built in — every hidden global must
  be offered OUTSIDE — and taking the filter away makes all nine fail (checked, 2026-10-01).
- Not covered here: Hyalo's JSON IPC socket (`HYALO_SOCKET`) is a file in the runtime dir. A
  Flatpak app gets a runtime dir of its own with the Wayland socket in it, not this one — unless it
  is granted the host's (`--filesystem=xdg-run/…`), and then nothing here stops it.

## Bringing a window to the front (xdg-activation-v1)

`activation.rs`. An app asks for one of its windows to come forward with a token. The rule is
GNOME's, KDE's and niri's: honoured only if the token came from what the user just did — the
client that asked for it has the keyboard OR the pointer (the dock and the notifications never
take the keyboard; their click is under the pointer), its serial is no older than that focus's
`last_enter` (niri's test: an old click says nothing about now), and it is used within 10 s.
Anything else changes nothing. A NEW window needs none of this — Hyalo focuses it when it maps.

The Hyprland session honours none (`misc:focus_on_activate` is off by default), so there a
link clicked in a terminal leaves the browser behind; on Hyalo it comes forward.

CI: `scripts/ci/hyalo-activation-check.sh` (with `hyalo-activation-probe.js`) clicks with the
virtual pointer: the app the user clicked raises its other window (honoured); an app on another
workspace asks to come forward (refused — the user stays where they are). A Hyalo that honoured
every token fails the second half (checked, 2026-10-01). ⚠️ The check CLICKS: run it only inside a
nested Hyalo or the smoke, and with the freshly built `nidara-hyalo` first in `PATH` —
`bin/nidara-wm` asks `nidara-hyalo msg`, and an older installed one does not know `workspaces`.

## Window capture (thumbnails)

`capture.rs`: the standard protocols, all three from Smithay — `ext-foreign-toplevel-list-v1`
(every shown window, kept up to date on title/app-id changes), toplevel
`ext-image-capture-source-v1` and `ext-image-copy-capture-v1`. The window is drawn ALONE from
its surface tree (`import_surface_tree` first: a window on a hidden workspace has not been
drawn since its last commits) into a texture and copied into the client's shm buffer — so a
window on a hidden workspace captures, as on Hyprland. One draw per request, never continuous.

- **Identity without a Hyprland protocol.** Each window is listed with `identifier` = its id in
  hex, which IS the shell's address for it (`HyaloState.ts`). lib/nidara-wl asks
  `hyprland-toplevel-mapping` when the compositor offers it and falls back to the identifier
  when it does not — Hyalo carries no Hyprland protocol for this.
- ⚠️ **Smithay's `Session` stops the client's session when it is DROPPED.** `new_session` must
  keep it (`capture_sessions`) until `session_destroyed`; dropping it answered every capture
  "stopped" before a frame was asked for (measured, 2026-10-01).
- The shell does NOT capture the screen on Hyalo (`caps.backdropCapture` false): the adaptive
  glass's backdrop is the compositor's to measure while drawing the glass (#684).
- CI: the Hyalo smoke parks a window of a known colour on a hidden workspace and requires the
  capture's centre to come back as that colour (`scripts/ci/hyalo-capture-probe.js`).

## Three config layers, and runtime changes over IPC

Read in order, merged table by table, last wins: `/usr/share/nidara/hyalo/hyalo.toml` (shipped),
`~/.config/nidara/hyalo-settings.toml` (Settings' choices, written by Hyalo, never by hand),
`~/.config/nidara/hyalo.toml` (the user's own) — the order of `nidara-*.lua` then
`hyprland-user.lua`. The files are watched (an mtime poll, immune to editors that replace the
file); a broken file is refused and the running settings stay. An unknown key is an error, not
silently ignored (`deny_unknown_fields`).

Runtime changes go through the IPC socket, never by rewriting a file — the 09-12 freeze came
from Hyprland's config being rewritten twice in a second (`project_freeze_after_533_checkout`).
Two kinds of request:

- **`set_output`, `do …` are runtime only.** A display mode the user has not confirmed yet is
  applied this way, so a mode the monitor cannot show is reverted before it reaches any file.
- **`settings` persists.** The shell sends a JSON merge patch in the config's own shape
  (`{"input":{"keyboard":{"numlock":true}}}`, `null` removes a key so the layer below shows
  through); Hyalo merges it into `hyalo-settings.toml`, checks the WHOLE stack, writes the file
  (fsync + rename) and reloads once (`config::apply_settings`). **Hyalo is that file's one
  writer** — the shell never renders TOML. Before #682's third part MonitorConfig wrote the file
  whole from its own state, which works for one module and drops the other's tables the moment
  a second one writes. A patch that changes nothing writes nothing and reloads nothing: the shell
  re-states settings on `config_reloaded`, and an unconditional reload there would loop.
  `config` answers with the configuration in force (the keyboard with the system layout filled
  in), which is what Settings shows.
- A reload Hyalo did itself updates `config_stamps`, so the file watcher does not reload the same
  write a second time a second later.
- **`HYALO_CONFIG` replaces the layers** (tests, CI), and then there is a settings layer only if
  `HYALO_SETTINGS` names one; `settings` is refused without it. The harnesses set both, so a
  nested test never writes the preview session's real `hyalo-settings.toml`.

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
than failing.

**Since #682's third part, settings too.** What Settings chooses for the compositor — input,
displays, workspace modes, reduce motion, the glass's blur, the groupbar accent —
goes through `settings` (`CompositorSettings`, exported by CompositorState.ts), and the modules
that own those settings (InputConfig, MonitorConfig, WorkspaceModes, ReduceMotion,
GlassBlur, AdaptiveGlass, AppearanceSync) name no compositor. Each backend applies live AND
persists in its own layer: `core/hyprland-settings.ts` (the `nidara-*.lua` files, `hl.config`
evals, the baselines below) and `core/hyalo-settings.ts` (`settings` patches). Hyprland's
sensitivity and acceleration profile reach every pointing device; Hyalo has them per kind, so
both kinds get them. What Hyalo does not have yet is a no-op there and false in
`settings.caps`: its own animations and per-surface blur (#684), VRR "fullscreen only". `scripts/ci/compositor-boundary-check.mjs` has no allowlist any more: no
file outside the compositor modules may import a backend or spawn `hyprctl`.

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

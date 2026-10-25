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
| `hyalo/compositor/src/render/` | the scene as render elements, front to back; the glass (`glass.rs`, `glass_gl.rs`); how a window is drawn — corners and the blur behind it (`window.rs`); a window drawn alone into a picture of it (`snapshot.rs`); the moment a frame shows, that Hyalo's animations are drawn at (`timing.rs`) |
| `hyalo/compositor/src/outputs.rs` | outputs as configured: arrange, apply, power, the windows' way home (#594) |
| `hyalo/compositor/src/config.rs` | the TOML layers and the watcher |
| `hyalo/compositor/src/wm/` | the window manager: workspaces, focus, floating/tiling, fullscreen (`mod.rs`), the commands (`actions.rs`), pointer move/resize (`grabs.rs`), tiling layouts (`layout/`), window rules (`rules.rs`), which windows are games (`games.rs`), minimizing (`minimize.rs`), opening and closing (`motion.rs`) |
| `hyalo/compositor/src/binds.rs` | key and pointer bindings from the config's `[binds]` |
| `hyalo/compositor/src/ipc/` | the JSON socket and `nidara-hyalo msg` |
| `hyalo/compositor/src/capture.rs` | capture of a window or an output (ext-foreign-toplevel-list + ext-image-copy-capture): the shell's thumbnails, grim, and a screen or window shared in a call |
| `hyalo/compositor/src/sandbox.rs` | what a sandboxed (Flatpak) client is not offered |
| `hyalo/compositor/src/shell/` | windows and popups (xdg-shell, `mod.rs`), layer surfaces (`layer.rs`), who draws a title bar (`decoration.rs`) |
| `hyalo/compositor/src/protocols/window_controls.rs`, `render/controls.rs` | a window's controls, Hyalo's: the protocol, and the capsule drawn over the app's header |
| `hyalo/compositor/src/protocols/layers.rs` | layers an app hands Hyalo to animate (nidara-layers-v1, #818): their transitions, and the walks that draw and hit-test them where they are shown |
| `hyalo/compositor/src/render/title_bar.rs` | Hyalo's title bar, for apps that leave their decorations to the compositor (kitty, Qt, Chrome's "system title bar") |
| `hyalo/compositor/src/activation.rs` | an app bringing its window to the front (xdg-activation) |
| `hyalo/compositor/src/xwayland.rs`, `hyalo/compositor/src/focus.rs` | X11 apps: Hyalo starts Xwayland and is its window manager (Smithay's `X11Wm`); what the keyboard can be given (a surface, or an X11 window) |
| `hyalo/compositor/src/lock.rs` | the lock screen (ext-session-lock-v1): what is drawn and reachable while locked |
| `hyalo/compositor/src/idle.rs`, `hyalo/compositor/src/logind.rs` | idle (screens off, lock, suspend; inhibitors) and the session's D-Bus side (lock before sleep, `org.freedesktop.ScreenSaver`) |
| `protocols/` | OUR protocols' XML, for both ends: Hyalo builds the server half, `lib/nidara-wl` the client half |
| `config/hyalo/hyalo.toml` | the shipped defaults, autostart included |
| `bin/nidara-hyalo-session`, `config/wayland-sessions/nidara-hyalo.desktop` | the preview session |
| `ui/shell/core/hyalo-ipc.ts`, `ui/shell/core/Displays.ts` | the shell's side (below) |
| `ui/lib/nidara-kit/platform/material.ts`, `ui/lib/nidara-kit/platform/glass-material.ts` | the glass's client half: the shapes, and THE material's numbers — one for every bundle; the shell's `core/CompositorGlass.ts` and the lock's `app.ts` only say Reduce transparency and the panels' blur (below) |

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

🔴 **`nidara-material-v1` stays at VERSION 1 until it is published** (owner, 2026-10-02: "stop
raising the protocol's version, we'll be at 89 before publishing anything"). It is ours and
nobody else speaks it, so a new request goes INTO version 1 — appended, no `since=` — never into
a version 2. It went to v5 on the #684 branch and was collapsed back. The cost: the C library
(`lib/nidara-wl`) and Hyalo have to be installed TOGETHER: a new library on an old Hyalo sends
requests that compositor's v1 does not have, a protocol error that kills the shell. Only the KIT
tolerates skew (an older library lacks a function → `shim.material_…?.()` falls back).

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
numbers is the material's (`ui/lib/nidara-kit/platform/glass-material.ts`, registered by each bundle — the shell from AppearanceSync through `core/CompositorGlass.ts`, the lock from its `app.ts`);
on Hyprland nothing offers the protocol and all of it is a no-op.

**A painter asks `compositorPaintsGlass(itsWidget)`** and, when true, paints only content and
state — the accent fill, the hover/open veil — never the body, the rim, nor the 2 px drop shadow
the same painters draw on Hyprland (`GLASS_SHADOW`: against the rim's band it read as a frame,
owner 2026-10-06; design-system.md → "One recipe"). The
painters that do: `SquircleContainer` (every pane with `useShellOpacity` and no explicit
`alpha`), the dock's pill on both axes (`DockAxis.ts`), the island's morph clone
(`MorphRevealer.glassShape`), the Notification Center's stacked-card bands, and tooltips and kit
menus (`trackBubbleGlass`, owner 2026-10-01: refractive too, and blurred MORE than panels). A
bubble's pointer is part of its shape (`add_shape_pointed`: base, tip, width, tip
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

What is sent is what the toolkit SHOWS (`add_shape_clipped`):
- **snapshot-time transforms** of the ancestors — `ScaleRevealer.glassPaintTransform()`; GTK's own
  geometry never sees a scale applied in `vfunc_snapshot`;
- **how formed the glass is**, per shape (the protocol's `opacity`, #764): the opacity of the widget
  and every ancestor — or what an ancestor that animates its glass apart from its content says
  (`GlassFormation`, `ScaleRevealer.glassFormation()`). See "Glass materializes" below;
- **the clip** of every ancestor whose overflow is hidden, per shape: a card scrolled half out of
  its list is cut straight, not rounded. The clip is pushed BEFORE that ancestor's own snapshot
  transform, so it is its unscaled box.
- Glass inside glass is not declared (`nested`): a control painted on a panel keeps painting
  itself, or Hyalo would draw a rim inside the panel. Shapes are drawn in tree order.

(`NIDARA_MATERIAL=0`, the switch that turned the client half off, went with #762: the shell
no longer paints its panes' glass itself, so nothing would be left to show.)
`NIDARA_MATERIAL_DEBUG=1` logs every surface's shapes as they change. On a dev install,
`~/.config/nidara/glass-tuning.conf` (`key = value`: `refraction lensing rim inkDarkAbove
inkLightBelow veilStrength veilFalloff veilExponent`, one stage of one tone as `PIECE.FACE.STAGE`
(`dock.light.gain = 0.9`), `blur`/`popoverBlur = SIZE:PASSES` (glass the client paints), `glass = off` / `ink = off` /
`tone = off` for the A/B; the full list is `glass-material.ts`'s header) is re-read as it is saved
— it is how the numbers are tuned with the owner on screen.
A blur's `SIZE:PASSES` means the SAME blur on Hyalo as on Hyprland — the numbers are shared
(`GLASS_BLUR`). Hyalo's dual kawase is Hyprland's: the down-sample's taps
at `size` source texels, the up-sample's at ¼ and ½ of that. Until 2026-10-02 the up-sample's sat
four times as far, and 2:2 blurred a step edge over 28 px against Hyprland's 12 (owner-caught:
"1:2 here blurs more than Hyprland's 2:2"). Measured since on the real GPU, nested, glass off,
over a black/white wallpaper (`HYALO_WALLPAPER`): 1:2 → 8 px, 2:2 → 12 px, 10–90 % of the edge.
The refraction is PER SHAPE (`set_lensing`): `refraction` is every shape's least,
and `lensing` × the shape's shorter side wins where it is more, so a large pane lenses more than
a capsule without a number per surface. The edge is a **convex bevel lying on the backdrop**
(`glass_gl.rs`): a quarter circle W wide and W thick, refraction by Snell at glass's 1.5, so the
backdrop is read from INSIDE the shape — bent hard against the edge, a little magnified further
in, never anything from beyond the outline. Its contours are the OUTLINE moved inward, each
corner rounder by the depth (radius r + t: `inset_sdf`, `lens_depth` — a bisection near the
corners), so what bends follows the corner's curve at the edge and turns smoothly round it further
in. Three shortcuts did not: the outline's own distance field creases along the diagonal once the
bevel is wider than the corner is round; that field with corners max(r, W) round bent along an
arc W round inside a tighter corner and left the corner flat (the app grid: a 108 px arc in a
32 px corner, owner-caught 2026-10-02); and every contour keeping the corner's own radius still
turned its normal at once along the diagonal — a fold from each corner, "like a flap" on a wide
bevel (owner, 2026-10-05). The price is a bevel up to √2 W deep along a corner's diagonal.
W ≈ 4.3 × `refraction` (Snell's most displacement is 0.231 W), up to half the shorter side and
never past `BEVEL_MAX` (30 px): beyond it a pane is flat glass inside, frosted, and only its
edge bends — as in the reference material, where a large pane frosts more, not bends across.
The cap is MEASURED (glass-probe `refraction-sizes`, run 38201914917, 2026-10-12): the
reference's edge is the same on panes 80 to 240 tall (+20 px at 4 px in, +10 at 6, +5 at 10,
nothing past 12–14), so the bend does NOT grow with the pane; until that day the cap was 80 and
a large pane still bent 19 px at 20 px in. Strength from the glass lab (2026-10-05, preset
"OK 2", #705), profile from the fit to the reference below: the quarter circle's height to the
4th power (the bend gathers at the edge; "OK 2" had the 5th) and three times Snell's
displacement, no colour dispersion; the capture region is the blur's reach alone. ⚠️ Two things that look like knobs and are not: thicker than 1.5 W the far side of
the peak displaces faster than 1 px per px and the backdrop folds back mirrored, and 1.5 W
already magnified the dock's icons under the app grid's edge four times their height (measured
nested, 2026-10-02 — W thick is the one kept). Until that day the edge read from OUTSIDE,
(1 − t)² × refraction over a band the corner radius wide: once `lensing` grew to 0.15 the app
grid read 125 px out within 32, and a window under it showed whole, shrunk, wallpaper round it
(owner-caught: "an inverted magnifier"). Compare numbers on the bevel in the harness, never on
the live session: `HYALO_GLASS_TUNING=<file>` gives the sandboxed shell its own
`glass-tuning.conf` (`hyalo/scripts/sandboxed-shell.sh`), over a grid as `HYALO_WALLPAPER`.
`nidara-hyalo msg layers` shows what each layer declared (`glass.shapes`, `glass.compositor_paints`,
`glass.toned` — how many of its shapes carry a tone — and its veils), and the smoke requires the
bar, the dock and the island to declare theirs, every pane of the bar and the dock with a tone.

### Glass materializes, it never fades (#764, owner 2026-10-07)

Glass has no opacity. The per-shape number the protocol calls `opacity` is, in Hyalo, **how formed
the glass is** (0..1), and it scales the MATERIAL, not the coverage: the blur's reach, the bevel's
bend, every stage of the tone, the rim and the veil under it (`scrim.rs` takes its shapes' most). Coverage is the silhouette's antialiasing and the clip
only. So every glass fade in the shell — a panel opening, a covered bar group, a banner, a fusion
member withdrawing — is a pane forming or dissolving, never the finished glass cross-faded over
the sharp backdrop (two images at once, which is what it was until #764).

- **The blur grows in the capture** (`glass_gl::formed_blur`): full glass is `passes` passes at
  `offset`; formed `f`, it runs the fractional level L = f·passes as ceil(L) passes (≥ 1) at
  offset·2^(L − ceil(L)), so the reach (≈ offset·2^L) is continuous where the number of passes
  changes (a unit test holds it — and fails when the offset stops following L). Under one pass the
  draw mixes in the sharp copy (level 0, already in the cache: `sharp`, `sharp_mix`). Same cost as
  before: a forming shape's commit changes every frame, so Smithay re-captured it every frame anyway.
- **A forming pane has a blur of its own** (`glass.rs` `groups()`): shapes formed differently
  (`FORMED_ALIKE`) share no pyramid — the Control Center forming beside the bar's capsules at rest —
  except within a fusion group, which is blurred for its most formed member and blends the rest per
  pixel (`blur_formed`). Forming groups are drawn first, below the surface's other glass.
- **The ink and the shadow are measured on the glass as it will be**: while it forms, the capture
  runs the full blur first and keeps its level 1 aside (`Cache::measure`). A partial blur has darker
  darks and brighter lights; measured on it, the ink would turn at the end of the animation, with the
  content already showing.
- **The client separates the glass from its content** (`ScaleRevealer`, on Hyalo only — Hyprland
  paints the glass inside the content): on OPEN the glass forms over the whole reveal (its eased
  progress) and the content fades in over the second half, so text never floats on glass not yet
  formed; on CLOSE the content goes over the first half and the glass dissolves over the whole
  (owner's order). A swipe or a collapse fades both together.
- **Instrument**: `formationHold = f` in `glass-tuning.conf` holds every pane at `f` (0 = off); the
  glass lab has it as «Formación (congelar)». Measured nested over a checkerboard (detail under the
  dock, std of grey levels): bare backdrop 24.7, f 0.01 → 24.6, 0.25 → 18.9, 0.5 → 13.5, 0.75 → 7.2,
  0.99 → 5.05, formed → 4.95.

### Fusion: a group of panes drawn as one silhouette (#705 step 2, 2026-10-06)

Panes of one **fusion group** are drawn as ONE pane of glass: the smooth union of their
outlines (Inigo Quilez's polynomial `smin`, width k = twice the group's spacing), so two of them
closer than the spacing are joined by a bridge that grows as they approach and breaks as they
part, and one bevel, one refraction and one rim follow the whole silhouette. The shell declares
it with **`trackFusionGroup(container, group?)`** (`material.ts`, the same container pattern as
`trackInkGroup`): every pane inside the container fuses with the others of `group`; the spacing
is the material's `fusion` (`glass-material.ts`, live in `glass-tuning.conf`, 0 = off). On the
wire it is `set_fusion(group, spacing)`, inside v1: it holds for the shapes added AFTER it, until
the next one — not "the last shape", because the library drops a shape whose opacity is 0 and the
request would then land on the shape before it.

The island is the first group (owner, 2026-10-06): its capsule, its chips and its modes —
so the chips join the capsule while the island swaps (the pulse below), and the capsule growing into a mode takes the
fading chips into its shape. A member fading out also WITHDRAWS from the union (by up to k), so a
bridge to a disappearing chip recedes instead of pointing at nothing.

How Hyalo draws it: `glass.rs` keeps a group in one `GlassElement` whatever lies between its
members; `glass_gl::draw_plan` paints a group as ONE draw where its first member was (up to
`FUSE_MAX` = 8 members, the shader's arrays; past it the rest are drawn shape by shape); the
shader's `fused_sdf(px, s)` is the members' bevel contours at depth `s` (a fraction of each one's
own bevel width), joined by the same union, and the bevel depth is a bisection on it — so the
bevel bends round a bridge as it does round a corner. Width of bevel, opacity and ink at a pixel
are blended from the members by how near each is (`fused_blend`). A shape with a pointer fuses
with nothing (its join is its own union). ⚠️ GLSL ES 1.00 lets a fragment shader index a uniform
array only with a LOOP index: the member loops read `f_rect[i]` inline, never through a helper
taking `int i` (Mesa accepts the helper, a stricter driver does not).

**Merging into one shape** (`set_fusion_merge`, inside v1, 2026-10-07). A group can be drawn
`merge` (0..1) of the way from its smooth union towards its **envelope**: one shape spanning its
members — the bounds of those at least half opaque, each cut by its clip, with the smallest of
their corner radii (`glass_gl::fused_envelope`). The shader blends the two distance fields
(`mix(union, envelope, merge)` inside `fused_sdf`, at every bevel depth), so the silhouette always
lies BETWEEN the union and the envelope: the space between the members fills from their middle
outwards, nothing ever bulges past the envelope or dents a member, and at 1 the group IS the
envelope, with one lens and one rim. Why not a wider smooth union: the owner asked for the
island's pieces to become "one single capsule" for an instant, and a polynomial `smin` cannot —
held on screen at spacing 18 the join kept a waist, at 20 to 24 it raised a mound where the
capsule's straight edge meets the bridge (owner: "like a mound between the capsule's straight
edge and the bridge"). Its width only moves the defect.

**The pulse** (`pulseFusion(group, widget, ms)`): the island calls it on a front change and on a
chip born, gone or changed; the group's merge goes up over 30 % of `ms`, HOLDS at 1 for 40 %,
and comes down over 30 % (`pulseCurve`; a sine touched 1 for an instant and was seen as "half
fused"). At rest the spacing is the material's `fusion` = 2, each piece its own pane — at 8 the
pieces were joined by a thin neck whose rims nearly met ("as if they tend to touch"). ⚠️ The
island's numbers are the GLASS's, not the widgets': `SquircleContainer` insets the glass 2 px a
side, so the pieces are 32 px tall and 8 px apart (their boxes, 36 and 4). To judge the shape a
pulse passes through, hold it: `fusionHold = 0.5` in `glass-tuning.conf` (an instrument, 0 in the
product). Nested, with media in the island: a fake MPRIS player on the sandbox's bus as
`HYALO_DRIVER` (any `org.mpris.MediaPlayer2.*` name that says `Playing`).

`nidara-hyalo msg layers` reports each surface's groups (`glass.fusion`: the shapes each one
joins); the smoke requires the bar to declare one.

### The glass lab (`scripts/dev/glass-lab/`)

🔑 **Since 2026-10-11 the lab opens on the desktop MOCK-UP (`maqueta.ts`)** — the owner's request after
a day of a bench "that punishes its user": a model of the desktop (the bar's real capsules, a menu held
open, the Control Center's real tiles, the dock's pill) over a wallpaper, each piece a layer surface of
its own so each wears its own glass. The model it is built on: ONE glass with two variants (Regular,
Clear: frost, rim), and per piece its variant, its TONE (dark and light face; Regular starts from the
tone its kind ships with, Clear from the reference's Clear — "The tone", below), its aspect (follows
the mode / always dark, as the reference's Control Center / follows the backdrop: the dark face with
the light one as its ink tone) and a shadow AROUND it (CSS outset box-shadow). It is the MATERIAL
SOURCE itself (`setMaterialSource` after `registerGlassMaterial`): per-surface `GlassParams` and
tones from its state, no glass-tuning.conf; what is global in Hyalo (bevel width, profile, strength: lab[12], lab[4], lab[5]) is
one section, "Refracción (común)". A fixed header (preset shown by name, Guardar / Guardar como, mode,
scene, backdrop) over a scrolling column; presets in `glass-lab/maqueta/`, whole state.
The bar's section also has a DIMMING LAYER behind the bar (`barDim`: opacity, a flat reach from
the screen's top edge, then a fade), painted on the backdrop so the glass sees it as what is
behind — for the owner's 2026-10-21 trial of white text on Clear glass. Provisional and lab-only:
nothing in the shell has it.
`install-desktop.sh` puts it in the app grid. `--classic` opens the older bench (lab.ts, below — the
promo exports, the readings, `--batch`); `GLASS_LAB_WITH_CONTROLS=1` keeps the column in a headless
capture.

Where the material is tuned with the owner, and where it EVOLVES (owner, 2026-10-05: "it has to
be kept, to go on evolving it"). The factory glass of #745 came out of it: the owner set it there,
and it went to the code the same day, measured equal. It is the shell's own pieces — bar groups,
`BaseIsland` tiles with the widget kit's content, `makeGroupStack` cards, kit round buttons, the
kit tooltip and menu, a pane the app grid's size; the island and the dock are shape-only
stand-ins, labelled on screen — over chosen backdrops (flat, split, grid, a page of text, the
factory wallpapers; dragged with the mouse or drifting on their own), on a nested Hyalo, with
every `glass-tuning.conf` key and every LAB hook on a slider, presets, an A/B against the factory,
and a contrast reading taken in PIXELS (two captures: as drawn, and with the content lifted off).
`glass-lab.sh` opens it as a window; `--headless OUT.png` gives one capture and the readings
without showing anything (`--bin`, `--preset`, `--bg`, `--show`; `GLASS_LAB_SHOT_DELAY` to wait
longer; `--video` for a video instead). Presets live in `~/.local/share/nidara/glass-lab/`.
**Images and videos** (owner, 2026-10-05/06): EVERY export — whatever is on the bench — is cut to
a FRAME of the chosen format (16:9, 1:1, 4:5, 9:16 — everything outside it dark on screen), and is
never the window's size (until 2026-10-06 only «promo: logo» was; a scene exported from «todas»
came out at the window's 2110×1250). The frame is a PREVIEW at whatever scale the screen allows (a
9:16 frame is 1390 px tall on a 1440 px screen): the backdrop is drawn inside it as the file draws
it over its whole output, and the pieces are laid out in a box the frame's size (`fitToFrame`).
The export's Hyalo runs at the OUTPUT SCALE format ÷ frame (`--scale`, set with `msg output winit
scale=…` before the lab connects, in 120ths as fractional-scale-v1 carries it): its output in
logical px IS the preview's frame, so the file is the preview's scene — same layout, same glass —
drawn at the format's px. Measured (2026-10-06, a 378 px frame → 1080×1920 at ×2.858): the
file shrunk to the frame vs the preview, RMSE 0.9 % (promo) / 2.6 % (todas); at scale 1, as
before, 3.0 % — the owner: "what I see in the lab is not what gets recorded, the size is
different, so the effect looks different". For that the shader's own px widths (bevel cap 80,
rim band 3.2) are LOGICAL: `px_scale` (the output's scale) multiplies them, as the client's
radius and refraction already were; at scale 1, 0 px change. At a fractional scale the output's
logical size rounds up and a capture comes out a few px larger (1083×1923): `cut` crops to
`GLASS_LAB_SIZE` from the top-left. «promo: logo» leaves one round pane with the Nidara mark
alone; its size is px of the FILE, shown scaled. «Exportar» makes the file in a second lab, headless, whose output IS the format (`glass-lab.sh --headless … --export
image|video --size 1080x1920`) — drawn natively, never enlarged — while the window goes on
working; it reads the export's progress from a file beside it. The headless cage's output is
1280×720 with no way to ask for another, so `--size` builds `output-mode.c` (a
wlr-output-management client, in the sandbox) and sets it; `cage -d`, or a client-side frame
round Hyalo's window takes 8×32 px off it. A video is made FRAME BY FRAME — the drift is a
function of time (`driftTo`), set to each frame's, captured through `msg screenshot` and piped to
ffmpeg (H.264, 60 fps) — so it is smooth however slowly the frames come. Each frame is asked as
a raw `.ppm` (`msg screenshot` writes a binary PPM for that extension) once the backdrop's frame
clock has painted it: a PNG cost 541 ms a frame at 1080×1920, almost all compression, and a
fixed 60 ms wait more. Measured on a 3 s 9:16 video: 106 s → 14 s, ≈ 171 → 34 core-seconds. The lab's nested Hyalo has no idle: with the defaults it went dark at five minutes
and would have started the lock screen inside itself at ten. It never reaches the session it runs
in: Hyalo nested with `HYALO_CONFIG=/dev/null`, a HOME of its own (the material reads
`~/.config/nidara/glass-tuning.conf`, so a lab with the real HOME shows the owner's tuning, not
the factory's), GSettings in memory (ThemeManager writes keys), its own greeter-mirror dir.

- **ONE shader, hooks compiled out.** `glass_final.glsl` is the shader Hyalo ships
  (`include_str!`), and it carries the lab's hooks: `LAB_ADD(i, x)` / `LAB_MUL(i, x)` around a
  number, `#ifdef GLASS_LAB` around a whole layer. Hyalo prepends `LAB_OFF` (each hook is its
  value, every block gone: the shader's arithmetic alone); with `HYALO_SHADER_DIR` set it reads the
  file from there instead, recompiled when it changes (the last program that compiled is kept on
  an error), with `LAB_ON` — 16 values from `lab_params.conf` (`lab[i] = v`), 0 = the factory. The
  lab LINKS the repo's file there, so an edit to the glass shows in the lab as it is saved.
  Measured 2026-10-05: at the lab's neutral values and with `--no-dev-shader`, the same pixels.
  Until that day the lab ran a COPY of the shader with its layers, which had to be kept in step by
  hand and whose values were relative to the factory it was copied from.
- **A recipe goes to the factory** by changing the number a hook wraps (and the lab's neutral in
  `lab.ts`) and the client's defaults in `glass-material.ts`; then the parity check: the preset
  in the lab before, the factory after, the same scenes, ≤ 2/255 apart — and a control that
  shows the comparison can fail (the shader before the change differs).
- ⚠️ **Presets are relative to the factory they were saved against.** `lab[]` holds offsets from
  the factory's numbers and the tuning only the keys off its defaults, so a factory change moves
  every preset. When the factory changes, convert them (the 2026-10-05 conversion, to these hooks,
  rendered the same pixels).
- **The frost is on the bench too** (2026-10-08): «Escarcha: tamaño / pasadas» write the
  material's `blur = SIZE:PASSES` (held in a preset's tuning as `blurSize`/`blurPasses`; until then
  the lab's panels had the `regular` blur only). And `lab[15]`, a dark 1 px line along the outline.
  Both came from measuring the reference material's captures (the private glass-probe repo,
  `tools/blur_sigma.py`, self-tested against this kawase simulated): its regular glass blurs at
  σ ≈ 13–14 px — our `3:3` (σ 13.2); `regular` 2:2 is σ 4.6 — its refracting band is 20 px at
  every size (our bevel cap is 80), and at rest it shows no rim of light, no shadow (⚠️ WRONG on the
  shadow, those windows were inactive: see "Each pane's shadow"), and a dark
  contour line at ≈ 0.63 of the glass inside it. Starting point to judge, not a factory: frost 3:3,
  `lab[15]` 0.37. ⚠️ Not rim 0 either: the capture shows no rim of light, but it is one static frame
  from a 1× SDR VM over flat grey, and the reference's videos DO show a thin rim (2026-10-05) — keep
  the rim and judge the line as an addition. ⚠️ Not the bevel cap 20: how far the reference's band DISPLACES was never
  measured, and here the bevel's width sets its strength too (0.231·W·3) — at 20 the edge moves the
  backdrop 14 px at most, over its outer 7 px (55 px over 42 at 80), and under a 3:3 frost that
  reads as no refraction at all (owner, 2026-10-08: "there is no refraction, or it doesn't show").
  A narrower band with the same strength needs the two decoupled first.
- What it has shown so far (2026-10-05): with the per-pixel adaptive tint, any treatment of the
  backdrop's whites (compression, a dark veil) ends at the same `target` — it changes how much of
  the backdrop shows, not the contrast; the ink at 0.80 never turns over a page of text; with
  `lensing` 0.15 and no cap, the app grid's pane became one roof of four faces.
- ⚠️ Hyalo ignores the right margin of a layer anchored to both sides (and a 0 exclusive zone):
  the lab sizes its scene explicitly beside the controls instead. A photo backdrop is a GPU
  texture: through Cairo, drifting cost ~2.8 cores and grew to ~8 GB in seconds.

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

### Fluid Crystal: evidence before assigning roles (2026-10-10)

`ui/lib/nidara-kit/platform/fluid-crystal.ts` defines Nidara's semantic vocabulary. Its four
axes are distinct: `variant` (Regular or Clear), `profile` (a Nidara UI role), `ink` (foreground
policy), and `elevation` (spatial separation). Light and dark are appearances of both variants,
not two more variants. A profile must not silently choose a new variant or a measured density.
Backdrop dimming is still missing from the semantic contract, so the four-axis presets must not
be treated as complete production recipes.

The private `glass-probe` reference runs `37729946989` and `38056119736` passed their validity
checks. The latter captured all 27 scenarios on macOS 27.0.1 (26A434): Regular and Clear in both
appearances, each with a `.primary` text label over white, black and a four-colour backdrop.
Across the three backdrops, a given variant and appearance had identical filter inputs; the
rendered pixels changed with the backdrop. Regular and Clear had distinct filter recipes in
both appearances. The `glassBackground` values are inputs to Apple's filter, **not** total
opacity or a recipe that can be copied numerically into Hyalo. In particular, Regular light's
face fill alpha 0.2 does not prove our `alphaMin = 0.2`.

The new captures show why ink must remain a separate axis. The probe's `.primary` label follows
the light/dark appearance; it does not automatically switch to the better foreground over each
backdrop. On a white backdrop in dark appearance, an approximate central text-to-glass contrast
is 4.0:1 for Regular and 1.5:1 for Clear; on black in light appearance it is 5.0:1 for Regular
and 2.1:1 for Clear (8-bit SDR window captures, single text sample; see `glass-probe` findings
for the sampling method). These are evidence of a failure mode, not accessibility certification
for a whole panel. A fixed light ink on Clear over bright media needs its own dimming or another
legibility treatment. Regular also needs contrast checks; selecting it alone is no guarantee.

Still unmeasured: how much dimming Clear needs on real media, motion and interaction across
backdrops, and the claimed density/elevation of Nidara's launcher, popover, CC and NC. `compact`,
`panel`, `launcher`, `popover`, `tile` and `media` are Nidara design roles, not macOS filter variants.
Apple's public materials guidance describes Regular as the general adaptive choice, especially
for text-heavy panels, and Clear as a highly translucent choice over rich media that needs
dimming for legibility. Apple also says larger elements such as menus and sidebars become thicker,
with softer scattering and deeper shadows; this is a size/context behavior, not a new variant.
The macOS probe measured different blur inputs for Regular and Clear at different backdrop
sampling scales, so it does not establish equal physical frost or a direct Hyalo blur mapping.
Regular's shadow responds to backdrop complexity: Apple's example strengthens it over text and
reduces it over a solid light background. Therefore assigning CC/NC to Clear and removing their
backing shadow is an unverified proposal, not a result of this probe.

Next gate: use the Lab to compare Nidara's appearances under the same backdrops and sizes,
including text contrast, while keeping its preview/export equivalence. Only after that
comparison should a role mapping or numerical recipe be promoted to the shell and Hyalo. The
current `trackFluidCrystal` registry picks one
spec per `Gtk.Native`, while the bar now holds several different panel roles in one surface;
per-pane selection needs a defined protocol path before that mapping can work in the shell.
The existing Lab already runs headless with its one scene surface. Its factory Control Center
on pure white measured 2.93:1 for the Brightness label and 3.51:1 for Wi-Fi/Bluetooth (2026-10-10,
`--show 'centro de control' --bg blanco`); on black the same Wi-Fi/Bluetooth labels measured
13.08:1. The white capture also showed a broad grey scrim around the controls. This is a baseline
failure to tune, not a Clear or Regular validation. Compare candidate variants one at a time on
that scene and preserve the existing backdrop and controls surfaces; do not create a native
window for every glass specimen.

The Lab now does that comparison on its EXISTING scene surface (`lab.ts`): a Regular/Clear
selector, the system appearance toggle, and separate tuning maps for the two candidates in
presets. Both start at the Lab's 3:3 frost to hold that variable constant for an initial A/B;
this is a test condition, not a measured equivalence with Apple's blur. Regular keeps the
factory's adaptive dark tint; Clear now has no dark tint, saturation 1, and a separate 0.05
light-mode white veil as an unmeasured candidate. These Clear numbers are trials, not
Apple's filter parameters. The first Clear dim trial darkened each pixel INSIDE its glass
silhouette: on white it improved contrast but made the glass look like a dark piece on a white
field. That was the wrong visual relationship. Apple's public guidance asks developers to
CONSIDER adding a dark layer BEHIND Clear components (35% over bright content); the layer is
not an automatic part of `.clear`. Its design video allows localizing the layer.

The Lab separates **variant, system appearance, ink policy and what lies behind the CC/NC**. A
single isolated specimen uses `inkPolicy`: the role default is system-mode ink on the bar,
island/dock and large panel; fixed white in CC/NC; backdrop measurement for controls/media.
The dock on this bench is only a shape/icon substitute (marked a `dock` piece, so it wears the
Dock's tone). `backdropPolicy` is «según rol» (the shell's fixed veil under CC/NC, none
elsewhere), «velo» or «ninguna». The «Tono» section shows the stages of ONE piece's tone — the
face the mode gives it — as `PIECE.FACE.STAGE` keys of glass-tuning.conf: Regular starts from the
shipped tones, Clear from the reference's Clear on every piece. Since the tone (2026-10-11) the
bench's shadow treatments («sombra shell», «dim experimental» and its area dim), the in-glass tint
sliders and the tint-fade trial are gone with the machine they drove, and so are the LAB hooks
lab[0..3] and lab[7]; a preset that holds them loads without them. The measurements below
(contrast at given luminances, the white-backdrop trials) were taken on that older machine.
"todas" remains a shape/layout comparison.

The Lab's trial ink crossover is 0.18 to dark / 0.14 back to white, with Regular's dark-tint
fade beginning at 0.14. On a uniform grey bar with no backdrop layer, headless captures at
L=0.17 and 0.19 measured 4.81:1 white ink and 4.82:1 dark ink. The older 0.35 threshold plus
a tint fade left only 2.68:1 at L=0.34, despite the material looking smoother. These numbers
are one static specimen, not a guarantee on a patterned wallpaper or during an ink transition.
At the same static settings, the Lab reported 21.00:1 with dark ink on pure white, 14.29:1
on its synthetic page of text, 5.39:1 on `wallpaper.jpg` and 10.34:1 on
`wallpaper-chroma.jpg`. Clear with no area dim and fixed white ink on pure white left the
backdrop at L=1.000 and the ink at 1.00:1, which is the explicit role-policy failure to solve
outside that material.
At the present protocol's boolean ink event, Gtk text and Cairo icons still switch at once;
continuous text color would cross through low-contrast middle greys without an additional
legibility treatment. The optical trial should not be mistaken for that completed ink behavior.

The Lab's **promo circle over `mitad blanco/negro`** has a separate ink experiment (2026-10-10).
The existing `punto más oscuro` choice asks Hyalo to sample the icon's ink box; one black
sample changes the WHOLE symbolic mark to white, even while its strokes still lie on white.
At the split centred in a 320 px promo capture, that left a sampled logo pixel white on white
(1:1). `tinta por zona` is now the Lab default for this backdrop: two copies of the same
symbolic mark inherit the light and dark token skins and a custom Gtk widget clips them at
the exact vertical backdrop boundary. As the boundary crosses the circle, black strokes stay
on its white side and white strokes on its black side; the mark changes spatially, without
a whole-glyph threshold or a middle-grey blend. `trackNoInk` keeps Hyalo's binary event from
recolouring both copies. This uses the synthetic split's known geometry and remains a Lab
comparison; arbitrary photographs require a compositor-side luminance map or a different
content treatment. The ordinary `Medir` path assumes a single ink and is disabled for this
two-colour trial. The shell's ink protocol and product behaviour are unchanged.

### Calibrated against the reference (2026-10-11)

The filter's numbers that the private `glass-probe` dumps are INPUTS to the reference's own
pipeline (sampling at ¼ or ½, curves of its own) and do not transfer. Its calibration set measures
the OUTPUT instead: known backdrops under a 240 pt square — nine greys, six colours, a black|white
and a 0.4|0.6 edge, linear ramps in x and y — each also captured with no glass, from which the
input is read. Its `tools/calibrate.py` turns a run into a tone curve, a 3×4 colour map, the blur's
σ and the refraction's displacement by depth; `tools/compare.py` sets two runs side by side.

The lab draws the SAME set, so a lab run and a reference run compare capture by capture:
`--show calibración` (the same square, radius 30, empty, no shadow; `calibración: sin cristal`
for the reference capture), `--bg "cal <kind>"` (`level:V`, `rgb:RRGGBB`, `edge`, `edge:LO:HI`,
`ramp-x`, `ramp-y`), and `scripts/dev/glass-lab/calibrate.sh OUTDIR [--preset F] [--combos …]`,
which writes the reference's directory names. `glass-lab.sh --batch FILE` takes every capture of
one recipe in ONE session (95 captures in ≈ 90 s; starting Hyalo was most of a capture's cost).

⚠️ **The reference is an ACTIVE window.** The first two calibration runs had an inactive one,
and an inactive window's glass is a different, frosted material (Clear σ 20.7 instead of 1.5;
still glass, not a solid fill). Owner-caught 2026-10-11 ("almost readable text under the glass"
against a grey block); the probe now checks it (`window.json`).

What the fit found against the active reference (CI 38095860773; error = RMS of output luminance
over the greys, |Δσ| on the 0.4|0.6 edge, RMS displacement over depths 4…30 after removing the
method's constant offset):

| recipe | #780 lab candidates | fitted | error before → after (tone · σ · refraction) |
|---|---|---|---|
| Regular dark | target 0.183 hard clamp, `3:3` | `2.9:3`, tone knee 0.06 → ceiling 0.24 (lab[0..1]) | 0.024→0.025 · 6.5→1.0 |
| Regular light | light veil 0.2 | veil 0.6 | 0.222→0.035 · 1.0→1.0 |
| Clear (both modes) | no tint, `3:3` | `1.5:1` (the owner's pick by eye: σ 1.76 against 1.51), no tint, saturation 1.3, light veil 0.1 | dark 0.103 · 12.6→0.25 · 28.3→5.3; light 0.092→0.079 · 12.6→0.4 · 28.9→3.5 |
| refraction (all) | bevel up to 80 px, exponent 5 | bevel 30 px, exponent 4, strength ×3 — the factory since 2026-10-12 | |

The refraction was confirmed against the active Clear, which is nearly sharp and so the most
reliable reading: from 0 to 12 px of the edge the reference displaces 47/26/17/11/6/1/−3, the lab
58/21/13/9/4/−1/−3. Corrections to what the filter's inputs suggested: Clear is the SAME in both
appearances, barely blurred and brighter than its backdrop (≈ ×1.2, saturating at white), not
darkened; the reference's light Regular is far milkier than its fill's 0.2 but keeps its whites;
its bevel is a third as wide as ours. Its Regular dark is adaptive with a ceiling (L 0.22; over
pure white 0.195, white text ≈ 4.2:1) reached by a SOFT knee: our hard clamp at `target` leaves a
dark valley and a bright band at a backdrop's edge, and is what made its σ read 6 instead of 13.
Regular's blur (σ 12–13) is the same active or not and agrees with an independent measure
(`blur_sigma.py`); it is smaller on small shapes (80 pt → 8, 120 → 10, from 160 → 12).
The fitted recipes are the owner's presets «calibrado — Regular oscuro / claro, Clear oscuro /
claro» (not in the repo); nothing of it is in the shipped material yet.
Over a page of text (the probe's `page` set, CI 38099090759) the reference's Regular dark came out a
solid grey block and only Clear let the text be read. ⚠️ That capture does NOT show how the glass
looks on a real screen: the VM is 1×, and since the reference's blur is in DEVICE pixels its σ ≈ 13
there wipes out lines 26 px apart (< 1 % of their contrast left; ≈ 30 % at 2×, > 50 % at 3×).
🔑 **Owner, 2026-10-11: Regular and Clear are REAL glass** — Regular frosted, Clear clearer, always —
and a pane never turns into a painted grey block: over a newspaper, glass shows the newspaper.
So a dark tint is a SMOKE, linear (`alphaMin = alphaMax`, `target` 1), never a per-pixel ceiling
that flattens everything bright to one grey; and the blur aims at the Retina look in logical px.
The «cristal real — …» presets carry it (Regular dark smoke 0.6, white text ≈ 6:1 over a white
page; Regular `1.2:3`; Clear `1.0:1`), awaiting the owner's eye.

🔑 **The better reference is the reference's own Figma kit, not the VM** (2026-10-11). The macOS 26
community kit (`LKYsrYxCaH9NWaLMGGn3ZB`, page «Materials») lays glass of three sizes over columns of
known colour, and Figma draws it with a real GPU at 1 px = 1 pt. Measured (glass-probe FINDINGS):
dark = a PROPORTIONAL smoke that keeps the colour under it (medium ≈ 0.9·backdrop − 0.095 in sRGB,
large ≈ ×0.48; black stays black), light = a white veil (medium ≈ 0.6, large ≈ 0.75), blur σ ≈ 5–7
pt — the VM's σ corrected for its 1× screen. No ceiling, no grey block, and larger means thicker.
The «kit — Regular claro/oscuro (mediano/grande)» presets carry it (`1.1:3`, smoke 0.3 / 0.52,
veil 0.6 / 0.75). It is Figma's renderer, not the reference's: geometry (corner, refraction) and
Clear still come from the VM's active captures.

⚠️ **Superseded the same day by "The tone" (below).** Everything above fitted OUR machine (a smoke,
a veil, a soft knee) to the reference's output; the tone copies the reference's machine itself,
measured input by input, and the owner chose its values as they are — the large dark panels'
ceiling included, the very "grey block" over white this section argued against. Clear's gain is
the tone's levels (gain 1.08 > 1). Still open: Regular's outer shadow in an active window; its
smaller blur on small shapes; the reference's rounder corner at the same nominal radius; its 1 px
dark contour (lab[15], uncalibrated); and the display scale — the reference VM is 1× and has no 2×
mode, so whether the blur in POINTS changes on a Retina screen is unmeasured.

### The ink: white text, dark only where the whole backdrop under it is white (#684)

Owner's decision, 2026-10-01, Hyalo only (on Hyprland the shell's skin stays dark, 2026-09-30).
There is no skin on Hyalo's glass: the text is white, and a pane's content turns dark only when
even the DARKEST point of the backdrop under it — as the glass treats it: blurred, saturated,
before its tint — is brighter than `inkDarkAbove`, and back only below `inkLightBelow`
(hysteresis). Never by an area's average: a mostly-light wallpaper with one dark stroke under the
text keeps it white.

- 🔑 **WHO takes the ink (owner, 2026-10-08), measured against the reference first.** The
  reference changes nothing's content with the backdrop: its menu bar, menus, Spotlight and dock
  dots follow the system MODE, and its Control Center keeps WHITE text in both modes over every
  wallpaper (glass-probe's `macos` set — the private repo's `results/FINDINGS.md`). So:
  - **Glass buttons** take the ink: the kit's glass buttons, over a window's content, are the one
    thing that changes with the backdrop (none sits over content yet).
  - **Control Center, Notification Center, notification banners: never.** `trackNoInk(widget)`
    (kit `material.ts`) gives the compositor none of their content to measure, so they stay white;
    their legibility is their tone's (the CC's, the reference's own). Declared in `Bar.tsx`.
  - **The dock: the system mode.** `trackNoInk` + `trackModeGlass` on its layout, and
    `skinFromMode` on its glass surface (`ShellGlass.ts` → `skinOf`): its dots and
    marks are light in dark mode and dark in light mode, and its glass on Hyalo turns to the light
    one in light mode — `glassFollowsMode(native)` makes the material send its piece's LIGHT tone.
    Off Hyalo, the light skin's tint does it.
  - **The bar's surface — capsules, island, its menus and Prism: the system MODE** (owner,
    2026-10-09: by the backdrop each capsule turned on its own, and over a wallpaper bright on
    one side only that end had dark text). `trackModeInk(barBox)` (kit `material.ts`): the
    material sends that surface ink thresholds no backdrop can miss — light mode −1/−2 (dark at
    once, never back), dark mode 2/1.5 — and its panes their LIGHT tone in light mode (dark
    content), the dark one in dark mode (light content). CC, NC and the
    banners keep `trackNoInk` and are untouched (they take no ink at all). ⚠️ Hyalo applies a NEW
    set_ink rule to the LAST measurement at commit (`ink_darkest`, `apply_ink`): a still backdrop
    is not measured again (the measurement is keyed on the capture), so without it a mode switch
    turned the bar only when something moved behind it. By the backdrop again — the whole bar at
    once, by majority, gradually — is for later.
- **Groups and boxes (client).** Each `trackGlass` entry is an ink group (`inkId`) — unless a
  container round it called `trackInkGroup(widget)`: then every pane inside turns TOGETHER, one
  group measured over all their boxes (read when the surface sends its glass, so nothing in the
  components changes). One surface only: Hyalo measures each surface on its own. Its boxes are
  every LEAF widget its scope draws — labels with text, icons, Cairo areas, CSS-painted boxes like
  the workspace dots — except the glass's own painter, through the same transforms and clips as
  the shapes. More than 8 → their union (stricter, never looser). A type list (labels, images)
  missed the CSS-painted dots: the island's capsule stayed dark while everything else turned.
- 🔴 **The `ink` event is v1, like the whole protocol.** Until 2026-10-05 Hyalo sent it only to a
  client bound at version ≥ 3 — a leftover from before the protocol was folded back into v1 — so it
  reached NOBODY, while the glass still wore the light veil: with the factory ink on, white text on
  a white veil, invisible over a white backdrop (hidden on the dev machine by `ink = off`). A version
  test on a v1 global is dead code that still decides.
- **Measured by Hyalo (`add_ink_box`, `set_ink`, event `ink`).** In the glass's
  draw, when the capture or the boxes changed: one small pass samples a 12×12 grid of the blurred
  copy per box into a 64×1 target (one texel per box, the minimum as two bytes), read into a
  pixel-pack buffer behind a fence. `backend::poll_ink` collects it from a 4 ms timer that
  exists only while a readback is in flight — no frame waits, nothing ticks at rest. The
  hysteresis (`material::next_ink`, unit-tested with a control) runs there; a change sends `ink`
  and redraws.
- **The glass follows.** A shape holding a dark group takes its ink tone (`set_ink_tone`: the
  material sends its piece's light face), chosen in Hyalo's `GlassElement::for_surface`.
- **The client follows.** `libnidara-wl` puts the material object on GDK's own event queue, so
  GDK dispatches `ink` on the main loop as it arrives (no pump). The pane gets `INK_DARK_CLASS`,
  which `generateSkinFlipScope` gives the light skin's tokens; `chromeIsDarkFor` answers
  `darkInkFor` first, so Cairo painters follow; the subtree is redrawn.
- A group no longer declared keeps its decision on both ends (a panel reopens as it closed);
  `clear_ink` makes every group light on both ends.
- Thresholds: `glass-material.ts` (0.35 / 0.25, the owner's in the glass lab, 2026-10-05 — 0.80
  never turned a page of text: its black letters are always the darkest point under the text),
  live in `glass-tuning.conf` (`inkDarkAbove`, `inkLightBelow`, `ink = off`).
  `NIDARA_MATERIAL_DEBUG=1` logs every ink decision.
- To see it nested, `awww-daemon` crashes inside the headless cage (broken pipe), so give the
  backdrop with a gtk4-layer-shell BACKGROUND surface of your own through `HYALO_EXTRA`.

### The tone: the reference's own filter, stage by stage (owner, 2026-10-11)

What the glass does to the blurred backdrop under a pane. Until 2026-10-11 our glass imitated the
reference's OUTPUT with a machine of its own — a tint that thickened per pixel to keep white text
legible (a bisection against a WCAG `target`), and a soft shadow under the glass making up what
that tint, held to a limit, lacked — and every difference was patched with a new knob (owner: "a
botched replica by eye … it doesn't add up"). The owner's call: copy the MACHINE, not the result.

- **How it was measured.** The private glass-probe's `tweak` set (rama `claude/tweak`): one large
  `glassEffect` panel over a grey ramp and nine colour bands, the bare backdrop above and below it
  in the same capture, and the panel's own `glassBackground` filter changed IN OUR PROCESS, one
  input at a time. 🔴 Mutating the CAFilter in the layer's array reads back changed and never
  reaches the screen (180 changes, Δ 0, run 38135614744); a COPY of the filter in a new array, or
  the key path `filters.glassBackground.KEY`, does (run 38136023059, with controls — the layer's
  opacity, hidden — that must and did change the pixels). With every stage off the panel is the
  backdrop exactly; five stages act at rest, in this order, on the sRGB-ENCODED colour (runs
  38136170522, 38136810278, 38137620939):
  1. **saturation** about the Rec.709 luma (exact: 0 gives that luma's grey);
  2. **ceiling** (the filter's max luma, its SDR one): the luma l goes to l·(1 − (1 − m)·l) — white
     lands on m, and the mids bend towards it, rising and then falling a little past
     l = 1/(2(1 − m)). Exact on greys for m from 0.1 to 0.9 (≤ 0.003); the colour around the luma
     scales by s^0.75 of the luma's factor s (measured, not exact). This is the curve that BENDS
     the reference's dark menus and bar, which no mix with a colour can draw;
  3. **levels** lift + (gain − lift)·v (the face colour matrix's black and white; exact);
  4. **wash**: a colour laid over at its opacity (the fill colour; exact);
  5. **ambient** (its bleed): the surroundings blurred 0.35 of the shape's shorter side, through
     levels of their own, lightening what is darker than them — at an opacity that grows with the
     shape, none up to 64 px of shorter side and all of it from 160 (exact on five panes of five
     sizes). Dark: within ≈ 0.02 on plain greys, 0.205 against 0.22 for black among neighbours. The
     LIGHT one brightens the mid-highs a little (≤ 0.03 at the reference's own setting) and fits no
     blend that was tried: not modelled, a light tone carries no ambient.
  The rest acts only at edges, in detail or outside the pane: the blur-fill (a darken/lighten
  with a wider copy: nothing on a smooth backdrop), the shadows, the refraction's opacity.
- **The protocol** (`set_tone`, `set_ink_tone`, within v1): pens that hold for the shapes added
  after them, reset by `clear_shapes`; `set_tone` resets the ink tone. `set_glass`'s tint, alpha
  and target, `set_ink`'s tint, `set_scrim` and `add_scrim_region` are inert.
- **Hyalo** (`material::Tone`, `glass_gl::ToneGl`, `glass_final.glsl` `tone_of`): per shape; the
  ambient's opacity and reach are sized there (`ToneGl::new`, unit-tested on the five panes). Its
  wide blur is 17 taps over the blurred capture, which reaches only as far as the glass's own
  blur (past it, the capture's edge repeats). A shape whose ink group turned dark takes its ink
  tone. A fusion group is one pane: its first member's tone.
- **The values** (`TONES` in `glass-material.ts`, each number with its source). Each kind of pane
  (`GlassPiece`, `trackGlassPiece`: `control`, `panel`, `controlCenter`, `dock`; a popover's
  panes are panels) has a dark and a light face. Owner: the reference's values AS THEY ARE.
  `control` and `panel` were READ from the reference's filter (catalogue run 38116434211: every
  glass layer's inputs) — small controls and large floating glass are ONE material: they share
  everything but the dark ceiling, and that one follows the pane's SIZE, not its kind
  (`darkCeilingFor` in `glass-material.ts`: 0.6 up to 64 px of shorter side, 0.35 from 104,
  linearly between — read back at every 8 pt from 64 to 112, exact, glass-probe `tweak-tone`,
  run 38180489443; a shorter ramp than the blur's). A dark menu over white lands at ≈ 0.48, the
  reference's own grey;
  checked against the same catalogue's PIXELS with this machine (the toolbar's groups within
  0.03, the real menu within 0.006). The Dock and the Control Center are other processes', not
  readable: their values were FITTED with this machine to the real ones over the calibration
  wallpapers (Dock within 0.002 dark and 0.001 light; the CC's tiles exact on black, grey and
  white, with the veil behind them). Which face: the dark one, unless the surface follows the
  system mode (`trackModeGlass`, or `trackModeInk` for a pane that takes an ink) and the mode is
  light; the light face is also the ink tone. The CC keeps its one face (`trackNoInk`).
- **Measured on the real shell** (`scripts/dev/glass-lab/shell-calib.sh` with `--lib` and a Hyalo
  built from the tree, black / grey / white): bar dark 0.12 / 0.53 / 0.72 (reference 0.12 / 0.53 /
  0.72), light 0.52 / 0.77 / 1.00 (0.51 / 0.75 / 0.98); Dock dark 0.05 / 0.42 / 0.69 and light
  0.15 / 0.53 / 0.90 (the reference's, both); the CC's tiles 0.12 / 0.43 / 0.73 (0.125 / 0.43 /
  0.73). Before: bar 0.00 / 0.47 / 0.78 dark and invisible in light, tiles 0.00 / 0.47 / 0.47.
- Tuned live: `PIECE.FACE.STAGE` in glass-tuning.conf (`panel.dark.ceiling = 0.5`), `tone = off`
  for the A/B (every pane the blurred backdrop as it is). Reduce transparency: a wash of the
  skin's own colour at `SOLID_GLASS`.
- What went with the old machine: the per-pixel tint and its bisection, the measured shadow
  (`scrim_target`, its easing, its probes that divided the floor out), `trackScrimRegion`,
  `trackNoScrim`, the material's `alphaMin alphaMax target saturation tintLimit scrim*
  modeLightVeil`. Their history — the CC's camera tile going grey on the owner's wallpaper, the
  strip, the halo per capsule, the dock's band switched on by the CC — is in git, `hyalo.md`
  before this change.

### The blur: the reference's, mixed by the pane's size (2026-10-11)

The glass Hyalo paints blurs as the reference's does, MEASURED: one material whose inputs come
from each pane's shorter side, not a blur per kind of pane. Owner, 2026-10-11: "what is the
point of defining a material if it is then applied differently to each piece?" — and the
reference answers it: its filter is one, and the system sizes its inputs.

- **How it was measured** (private glass-probe, branch `claude/sigma`, `tools/sigma.py`). A
  sinusoid grating along x (periods 8, 16, 32, 64, 128 pt), constant along y — so the refraction
  of a pane's top and bottom edges cannot touch it — under panes 24 to 340 pt tall, the bare
  grating above and below in the same capture. What each period keeps IS the blur once the tone
  is divided out. The tool is self-tested (gaussians of known σ come back within 3 %; no blur, a
  25 px box and a plain tone scale are rejected); `--hyalo` runs our kawase through it.
- **What the reference does** (runs 38173179067, 38175196633, read back from its own filter):
  its blur opacities SCALE the blur radius (op 0.5 at radius 5 ≡ op 1 at 2.5), 0/0 up to 64 pt
  of shorter side and 0.8/0.4 from 160 — the same ramp as the ambient (`ToneGl::grown`), which
  is also its shadow's and its bleed's. With its tone neutral, what a pane keeps:
  small 0.19 0.25 0.30 0.49 0.79 · large 0.05 0.05 0.15 0.45 0.79. Neither is ONE gaussian:
  a small pane keeps a fifth of the finest detail and blurs the coarse far more than a kawase
  of the same reach. The σ the catalogue fitted to band edges (4.75 vs 7.5 "small vs large") and
  the old calibration ("2:3 → 7.75") were another method's, and are not to be used.
- **Hyalo** (`render/glass_gl.rs` `BlurMix`, `glass_final.glsl` `blurred`): one capture, three
  of its blurs — the backdrop barely softened (one pass at 0.5), the kawase at 4.0 after two
  passes and after three; the last two share their down-samples (`capture`: the middle copy is
  up-sampled from level 2 before the full chain's up-samples overwrite it). Each shape mixes
  them by its size: `SMALL` 0.27/0.11/0.62 up to 64, `LARGE` 0.06/0.37/0.57 from 160, linearly
  between. Fitted through this very kawase to the reference's curves within 0.011; measured on
  the real shell (`glass-probe/scripts/nidara-grating-calib.sh`, `tone = off`, content masked):
  bar 0.19 0.25 0.28 0.45 0.76, app grid 0.04 0.05 0.14 0.43 0.78. While a pane forms (#764) the
  middle copy runs one pass fewer than the full chain at the same reduced offset, so the two
  grow together. Its cost over one blur: the soft down-sample, one up-sample and two in `draw`.
- **Logical px** (`× px_scale`). Whether the reference blurs in points or pixels is NOT known:
  its runner has no 2× mode.
- **The protocol.** `set_blur` and `set_shape_blur` (v1, kept) blur only a surface whose glass
  its CLIENT paints; where the compositor paints it (`set_glass`) the blur is `GLASS_BLUR` mixed
  as above, and every shape of the surface shares one capture. `msg layers` lists each shape's
  weights (`blurs`: "mix soft/middle/full"). The kit sends no per-pane blur any more.
- **The tone acts pixel by pixel** (run 38180489443: each colour stage alone over the grating,
  blurs off, keeps the same share of every period). 🔴 A trap that looked like a gap: the
  reference's VM shows the grating's sRGB 0.5 as **0.407** (its display's colour management),
  and the ceiling's slope depends on where it is read — 1 − 2(1 − m)·x gives 0.471 and 0.674
  at 0.407 for m 0.35 and 0.6 (measured 0.47 and 0.67), 0.35 and 0.6 at our harness's 0.5. So
  "the reference keeps 1.15–1.4× more contrast" was the two means, not the tone: compare slopes
  at the SAME backdrop level.

### Each pane's shadow (2026-10-12)

The reference's glass DOES cast a shadow at rest (glass-probe `refraction-sizes`, run 38201914917:
Regular at 80…400 pt over a 0.9 grey, read outside the pane as a black layer on the sRGB value;
`tools/shadow_fit.py`). A blurred rounded rectangle moved **8 down**, its opacity and gaussian
deviation growing with the pane on the ramp of the blur and the ambient (`ToneGl::grown`, 64 → 160)
and holding after: opacity 0.013 → **0.175** dark / 0.115 light, deviation 2 → **17** (within
0.0012 of the captures at every size). The 2026-10-08 "no shadow at rest" came from inactive
windows. Not the shadow UNDER the glass the owner took out on 2026-10-09 (that made up for a tint):
this one is outside the glass only.
- **Declared** per pane, like its tone (`nidara_material_v1.set_shadow`, inside v1 — lib + Hyalo
  together): the kit's `SHADOWS` in `glass-material.ts`, by piece and face (the face the tone
  takes). Only `control` and `panel` cast one: the Dock and the Control Center were not measured.
  `shadow = off` in `glass-tuning.conf` takes them all away.
- **Drawn** by `render/scrim.rs`, in the veils' pass (same floor, maximum, dither): Φ of the
  rounded box's distance over the deviation, and **cut out of every shape that casts one** — the
  tone was fitted to the reference's glass as it looks, so nothing may darken under a pane twice.
- `msg layers` → `glass.shadows`: each shape's `[opacity, deviation]` at its size. Seen on the real
  shell (`shell-calib.sh`, level 0.9): under a bar capsule 230 → 227–228 for 8 rows, gone by 10;
  above it and inside it untouched. The large end is held to the captures by a unit test.

### A control answers its backdrop (#889, toolkit/CONTRACT.md "Floating control capsule")

How a control BEHAVES — the base every control follows and the owner's exceptions — is
design-system.md, "The glass material"; this section is how Hyalo paints it.

Four requests inside material v1 (lib + Hyalo together; appended, no `since`), the toolkit's
controls and Hyalo's own window controls on the same paths:
- **`set_response`** (`material::Response`): the shapes after it measure their backdrop — the
  mean WCAG luminance on the blur the ink uses, the deviation on the SOFT blur — in the same
  readback as the ink boxes (`FS_INK` `mode` 1; `glass_gl::AnswerBox`, after the ink boxes in
  the target, at most 16). r and c are smoothsteps of them; a shape's tone is its `set_tone`
  mixed towards its `set_ink_tone` by r, every stage (`Tone::mix`), its shadow's opacity times
  `1 + shadow_white·r + shadow_text·c` (`scrim::scrims_of`), and an answering shape ignores the
  binary ink. Nothing waits: the measurement is the ink's fence/PBO.
- **`add_state_region`**: a wash over the toned glass, in a rounded rectangle and only where there
  is glass (`glass_gl::StatePx`, the shader's `s_*`, at most 8 per draw), under the rim.
- **Easing** (`material::Presenting`, in `Current`): each answer by shape index, each wash by id.
  A first answer and a new id show at once; a change eases linearly over `settle_ms` / `fade_ms`
  from what was SHOWN; an id gone is gone. `presented(surface, when)` fills the state as it
  shows at the frame's time and moves the commit when that changed; while anything eases it
  marks `take_easing`, and `post_repaint` asks for one more frame — at rest nothing ticks.
- **`set_ink_colors` + `add_ink_coverage`**: inside each rectangle the surface's own buffer is
  coverage, redrawn as `ink.rgb · ink.a · buffer.a` by the window's texture shader
  (`FS_ROUNDED`'s `ink`, two rectangles per mat4, at most 16: smithay's custom uniforms take no
  vec4 arrays). The ink is the inks mixed by the r of the answering shape under the rectangle's
  centre (`MaterialState::ink_of`), or its override. A surface with coverage is drawn through
  that program even unrounded (`window::inked_element`, every path: window, tree, popups, a
  layer-shell surface — not a surface's drawn region). The element's commit is OURS
  (`InkMemo`): it moves with the ink, and its damage is the surface's own while the ink is the
  same, all of it when it changed. Overlapping, empty or non-finite coverage is the protocol
  error `invalid_region`.
- ⚠️ **`inked_surfaces` reads each surface from the walk's own `states`**
  (`material::has_coverage(states)`): `with_states` again inside `with_surface_tree_downward`
  locks the surface twice and Hyalo hangs at its first frame (seen headless, 2026-10-21).
- **What shows is reported** (`msg windows`): each layer's `answers` and the window's
  `controls_answers` — per answering shape `measured`, `r`, `c`, `settled`, `shadow_gain`, per
  wash its colour now and `settled` (`Presenting::info`). A check waits for `measured && settled`
  instead of sleeping before its capture; the checks below do. Each report has a `revision`:
  it moves with every material state Hyalo takes in, changed or not — a client commit applied
  (a layer's with its parent's), or for the window controls a hover, a press or a material drawn
  differently. Read it, act, wait for it to move, THEN wait for `settled`: settled alone can
  still describe the state before the input (#889).
- ⚠️ **A picture never measures** (`render::picture_elements`: `msg screenshot`, screencopy, a
  shared screen). Each picture draws the scene again offscreen and captures the backdrop with
  its region rounded its own way; until 2026-10-21 its readback fed the same answers and ink as
  the screen, so a check that took pictures while it waited flipped a still capsule's answer
  with each one and it never settled — and a screen being shared would have done it live.
- 🔴 **A glass never sees its own shadows** (`glass_gl::Unshadow`, 2026-10-21). They are drawn
  right below it, cut out of its shapes, but its blur reads ~64 px past its edge and took them in.
  Its capture's first pass divides out what that surface's shadows darkened —
  `(1 − veil) / (1 − max(veil, shadow))`, the scrim pass's own combination — and keeps its
  veils (the Control Center's is behind it on purpose). Measured over a fixed gray (sRGB 143):
  a capsule's r 0.148 with its shadow, 0.156 without, 0.156 with this (= the lab's `no-shadow`).
  Nothing visible moves: the CC casts none, the bar's are 1.2 %, a menu changes ≤ 2/255; what it
  fixes is a pane ANSWERING its backdrop, whose shadow grew with what it measured. A window's
  shadow solved the same thing by being drawn in front of its backdrop (below).
- A **layer's panes cast their shadow** (`LayeredTree`'s `LayerPaint::Shadow`, right below its
  glass, cut to the root's box): before #889 a layer's `set_shadow` drew nothing.
- Values: `toolkit/tokens/control.json`, merged into every control step of `tokens/glass.json`
  by `scripts/export-tokens.mjs` (per variant: `default`, then matching `variants`; null response
  with reduce transparency); `settings-tokens-check.py` fails a step without them.
- CI: `scripts/ci/hyalo-control-material-check.py` + `hyalo-control-material-probe.c` in the
  smoke: a capsule layer over a white or black page — its coverage inked (B outside it as
  painted), its ink and tone and shadow answering, its red wash translucent, overlapping coverage
  the protocol error; each with the probe dropping that part (`--no-ink`, `--no-response`,
  `--no-ink-tone`, `--no-shadow-gain`, `--no-state`). The five controls run where they can fail
  differently (ci-scope `full`) and nightly. Easing is unit-tested (`Presenting`), not timed.

### The veil under the Control Center (2026-10-11)

The Control Center and the Notification Center lie on a FIXED veil (`trackVeilRegion(widget)` in
Bar.tsx → `nidara_material_v1.add_veil_region`). Owner, 2026-10-09: "the shadow under it cannot
define how the glass looks" — the measured shadow out. The veil is the reference's own, MEASURED
on its real Control Center over known wallpapers (glass-probe `tools/cc_calib.py`, runs
38119286883/38119289287), read ACROSS its edge, from deep in a gap between tiles to 140 px out:
0.10 black between the tiles, falling in a straight line from 34 px INSIDE the box of the tiles over
155 px — 0.082 at its edge, 0.055 at 40 px, 0.024 at 80, 0.008 at 117 — the same in both modes
(2026-10-12; within 0.006 everywhere). It is always there: it takes ~10 % of the light behind, which
shows on a light backdrop and hardly on a dark one. No shadow of each tile: the gaps are flat.
⚠️ Until 2026-10-12 it was 0.078 (the median of the whole region) flat to 40 px OUTSIDE the box
(its refraction margin), with the fall measured from the wrong edge: 0.016 rms off. The tiles'
tone was fitted with the veil behind them, so it moved with it (controlCenter gain 0.794 → 0.809:
0.125 / 0.431 / 0.729 on the real shell, the reference 0.125 / 0.430 / 0.729–0.733).
Fixed: no measurement. A region holds the shapes whose centre lies in it (`veil_units`); its core
is the box of its panes, `veilInset` inside it (`placeVeilRegions`); the material's `veilStrength
veilFalloff veilExponent veilInset` tune it, `veilStrength = 0` takes it away. `msg layers` lists it as
`kind: "veil"`; the smoke requires the CC's panes on one.
- **Drawn** by `render/scrim.rs`: one pass, veils combined by their MAXIMUM, half-level dither.
  🔴 The shell's chrome (top and overlay layers) casts its veils onto ONE FLOOR under all of it,
  right above the windows (`render/mod.rs`, `chrome_scrims`): one element for the whole floor
  (its memo on the output), so two that overlap never darken a corner twice.
- Measured on the real shell (`shell-calib.sh`, 2026-10-12): 0.098 in the gaps, 0.078 / 0.067 /
  0.051 / 0.039 / 0.027 / 0.012 at 0 / 20 / 40 / 60 / 80 / 100 px out (the reference 0.082 / 0.067 /
  0.055 / 0.039 / 0.024 / 0.016).
- To see it nested, the backdrop must be a REAL full-screen layer: `gjs bg.js` without
  `LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so` comes up as a window with a dark title bar and the
  clear colour around it, and the bar and dock then sit on a mixed backdrop whatever you painted.

## Windows: rounded corners and the blur behind them (#708 point 1)

`render/window.rs`. Our own windows are square, transparent GTK toplevels that leave the corners,
the border and the shadow to the compositor (`window.nidara-app-window` in the kit's
`_components.scss`) — Hyprland drew them. On Hyalo, until 2026-10-03, nothing did: Settings was a
square box, and kitty at `background_opacity 0.5` showed the desktop SHARP behind it ("kitty
looks pale", 02-10). Now, with Hyprland's numbers (`[windows]` in `config/hyalo/hyalo.toml`):
- **Corners**: `rounding` 24, `rounding_power` 3.2 — the glass's superellipse. Drawn by a texture
  shader of ours on the window's surfaces (`RoundedElement`, through Smithay's
  `override_default_tex_program` — public API, no patch), only inside the box's corner squares;
  its opaque regions drop those squares, so what is behind a corner is still drawn, and it is
  never a scan-out candidate. The shader gets output pixels from `gl_FragCoord` through the
  inverse of Smithay's projection (`fb_to_out`), so every output transform is handled there. Not
  rounded: a fullscreen window, popups, and a rule's `rounding = false` (games; a window with no
  app id, Hyprland's `general-popups`). A window whose surface reaches past its geometry (a
  client-side decoration with a shadow margin) is cut to its box first (below).
- **The backdrop** — "A, automatic", the owner's decision: the WINDOW material, independent of the
  layers' refractive glass (#705), each with its own settings. A `GlassElement::backdrop` (the same
  framebuffer effect, one shape: the window's box with its corners, never the CSD shadow margin)
  under every window that is translucent — its opaque region leaves part of the box uncovered
  beyond the corner squares (`translucent`; a buffer without alpha is opaque whole). Blur only,
  finished as Hyprland's `decoration:blur`, ITS formulas: contrast and brightness on what is
  read from the frame (first down-sample), vibrancy on each down-sample, noise and brightness
  after (`glass_gl::Finish`; `NEUTRAL` for the shell's glass, which has its own saturation and
  tint). No tint of its own: a window's translucent background is its tint. How far it blurs is
  the window background's LEVEL (`[windows.background]`, below); another app's translucent window
  gets the `translucent` level's blur — except one a rule gives `follow_level = true`: the
  shipped `nidara-apps` rule (each of our GTK windows by its app id — `hypr-rule-check.mjs` wants literals that exist) does it for our GTK apps, which
  paint their opacity at the user's level but cannot declare it, so in Tinted they used to get
  the light translucent blur (owner saw it live 2026-10-19). `BackgroundConfig::undeclared`. No switch in Settings any more (owner, 2026-10-18: a
  window that lets anything through is blurred); `[windows.backdrop] enabled = false` still turns
  it off everywhere, and a rule's `backdrop = false` for one app.
- **A window's declared background** (toolkit/PHASE1.md D6, owner 2026-10-18): a toolkit window
  says only its colour, opaque (`nidara_material_v1.set_window_background`); Hyalo draws it inside
  the box, under the content, in the DECOR pass (`decor.rs` `fill`, so it is in the opening and
  closing pictures). It shows at a LEVEL — `opaque`, `tinted` (heavily blurred, subtle) or
  `translucent` (less opaque, less blurred) — the user's (`[windows.background] level`, from
  Settings → Appearance → Windows "Window style") or the app's own
  (`set_window_background_level`); `reduce_transparency` makes every one opaque. Each level is
  one opacity + one blur (`tinted`/`translucent` tables). The shell's `AppearanceSync` writes all
  of it from the kit's `WINDOW_BACKGROUNDS` (PROVISIONAL numbers, the same that GTK windows paint
  their opacity with). Such a window is translucent by its level, not by its opaque region
  (`look`, `blur_of`). It is NOT glass: no tone, no shell blur. GTK windows keep painting
  `--nidara-bg` themselves (frozen kit).
- What the IPC says: `nidara-hyalo msg windows` → each window's `look` (`rounded`, `backdrop`,
  `follow_level`) and
  its `background` (`color`, `level`, `own_level`, `opacity`) when it declared one; and its
  `layers` (`nidara-layers-v1`, when it has any): each one's box as shown now relative to the
  window's root surface (`x`, `y`, `width`, `height`, logical, its `scale` applied), `opacity`,
  and `glass_shapes` of its own material (what D7's checks read; `nk-layer-motion-check.py`
  asserts A and B there, and none with client-side motion).
- **Who draws the title bar** (`shell/decoration.rs`, 2026-10-03): Hyalo, as Hyprland did —
  `xdg-decoration` and KDE's `server-decoration` both answer server-side, by default, on request
  and on unset, whatever the client asked (Hyprland's `XDGDecoration.cpp`/`ServerDecorationKDE.cpp`),
  and Hyalo draws none. Until then Hyalo spoke neither: kitty, Chrome and Qt apps drew a bar of
  their own, and its shadow margin left them SQUARE (`look.rounded` false, "kitty has a title bar
  on Hyalo"). Smithay sends `zxdg_toplevel_decoration_v1.configure` only when the mode CHANGES —
  a `set_mode` that changes nothing gets the `xdg_surface.configure` alone, as the protocol asks.
  GTK apps speak neither and keep their own decorations. What the client ASKED is kept on its
  surface (`decoration::asked`): it decides who gets Hyalo's title bar — below ("Hyalo's title
  bar"), with the window controls before it ("The window controls are Hyalo's").
- **Who frames a window — the policy** (owner, 2026-10-03: "no window keeps square corners by
  default"): our own apps → Hyalo's controls over their header (below); an app that takes
  server-side decorations → Hyalo's title bar; an app that insists on its own frame (Chrome's web
  apps, Chrome without "Use system title bar", Telegram, GTK dialogs, Firefox) → CUT to its box
  and rounded. Hyalo's bar
  never goes over a forced client-side frame: its title bar and buttons are pixels in the
  client's buffer — a bar above it would be a second bar, one over it would cover its tabs.
- **A client-side frame is cut to its box** (`render/window.rs` `push`, owner 2026-10-04). A web
  app of Chrome's draws its own frame with a shadow margin and square corners — tiled, and at the
  BOTTOM even floating. Such a window (it does not `fits`) is drawn inside its own box only (the
  rounded shader's `clip`: its margin — its own shadow too; Hyalo's stands in for it, below — is
  never drawn), with the window's corners cut into it, as every desktop rounds a web page. What
  lies in a corner's outer 4.7 px along the diagonal (`rounding` 24, power 3.2) is not shown.
  ⛔ **Not a ring around it.** #727 laid such a window out inside a 4 px ring of Hyalo's that
  continued the client's edges, row by row, so nothing was hidden; seen live (2026-10-04) every
  image touching an edge streaked across it — "YouTube looks like glass on its left" — and the
  owner chose the cut. A ring of one colour per side was the other option, and turned down: it
  shows as a 4 px band wherever the app's edge is not that colour.
- **Sampling a client** (the title bar, `title_bar::ClientBox`): always through the
  surface's VIEW — the viewport's crop and scaling — and only across the client's box; and from
  the TOPMOST surface of its tree over the box's top row (`title_bar::sampled_surfaces`), not the
  toplevel: Firefox draws everything into a subsurface over an empty, transparent toplevel, and
  the bar sampled from the toplevel came out clear, the desktop through it (owner, 2026-10-04).
- 🔴 **A window's popups are placed against its WINDOW GEOMETRY** (xdg-shell), so drawing one
  is `geometry().loc + offset − popup.geometry().loc` from the surface's origin — what Smithay's
  own `Window::render_elements` does. Until 2026-10-04 `window::push` left `geometry().loc` out:
  a window whose geometry starts inside its surface (Firefox drawing its own frame, 26,23) had
  its menus drawn that much up and left while the pointer met them where they really are —
  "the hover lights with the pointer below the item". Layer and lock surfaces have no geometry
  offset; the shell's menus were never affected. Measured
  2026-10-03: Chrome tiled beside kitty keeps its 1262 px buffer and crops it to 628 with
  wp_viewport, and the bar, which averaged the whole buffer row, came out half its colour.
- **The line and the shadow** (`render/decor.rs`, `DecorElement`, 2026-10-04): one pass of a
  shader of ours, behind everything of the window but IN FRONT of its backdrop, drawing only
  OUTSIDE the box (the corner shader's distance field, so it follows the superellipse). The line:
  `[windows.border]`, Hyprland's for Nidara — 1 px, `#ffffff4d`→`#ffffff1a` at 45° on the focused
  window, `#59595933` on the others; its room is `[layout] border`. The shadow: `[windows.shadow]`,
  `(1 − t)^power` over `range` (Hyprland's `render_power`), `offset` down; deeper on the focused
  window (20 px, 4 down, `#00000059`) than the others (12, 2, `#00000033`) — not Hyprland's 4 px:
  it also stands in for the shadow an app that draws its own frame lost when it was CUT (above).
  Not on a fullscreen window, nor where a rule took the corners (games). Colours are `#rrggbb[aa]`
  (`config::parse_color`, premultiplied). All live through the settings layer.
  🔴 **In front of the backdrop, not behind it**: drawn behind, a translucent window's blur read
  its own shadow at its edges and darkened its inside (measured 103 → 96 at its bottom edge).
  The quad never covers the box's inside (`subtract_rect`): a video playing in the window
  damages it every frame and every pixel there would be discarded.
- CI: `scripts/ci/hyalo-window-look-check.sh` in the smoke — an opaque window of red/green
  stripes and a translucent one over it: `look`; the corner's pixel shows what is behind and
  30,30 the window; the stripes' spread under the glass (2.7 nested, beside it 127.5); and the
  switch off → sharp again (89.5), then back on; the line and the shadow against both switched
  off — the pixel right of the window is the line's, below it darker, and inside the translucent
  window at its bottom edge unchanged (controls seen failing: a Hyalo without them; one drawing
  them behind the backdrop). `scripts/ci/hyalo-decoration-check.sh` (C probe
  `hyalo-decoration-probe.c`, drawing itself as kitty does with the answer): both protocols say
  server-side to a client that asks for client-side, and both probe windows are rounded — the
  control, the same probe on a Hyalo without the protocols, fails at once.

## The window controls are Hyalo's (#708 point 5, 2026-10-03)

The owner's design, chosen on a mockup: Hyalo draws a window's close, minimize and maximize
OVER the app's own header, in the same row — no bar of its own for our apps — as **one capsule**
(ours, never three coloured circles). **One button size in every window** (owner, 2026-10-03):
the controls are the system's, so they do not take their size from each app's header
(`window_controls::BUTTON_H`). **They are the classic loose window buttons held in a capsule,
as small as it can be** (owner, 2026-10-23, #921) — not header buttons, so Hyalo's title bar
stays thin: **24 high, each button's hover a 16 px circle, 4 from the capsule's ends and 8 from
the next** (`HOVER_D`, `EDGE`, `GAP`): a button takes 24 (`PITCH = HOVER_D + GAP`) and the
capsule `24 × n − 8 + 8` — **24, 48, 72**. From 2026-10-04 to #921 it was a header button's
size, 32 high with 24 px circles 4 apart (32, 60, 88: the bar's rule for a capsule of icon
buttons, design-system.md); that made the SSD bar 48 and, in a sidebar, put the controls out of
line with the header unless the header grew. Before 2026-10-06 a button was a 30 px slot whose
hover FILLED it, cut by the capsule. The shader takes `HOVER_D`/`EDGE`/`PITCH`/`GAP` from
`set_geometry`. **The hover is the glass itself** (owner, 2026-10-23): over the shell's glass
(D7) each button's hover and press are a wash INSIDE the glass shader (`state_regions`,
`glass_final.glsl`), never a disc painted over it; close's red the destructive wash. Without a
token export (no glass) the capsule paints its own fill and a flat circle, `HOVER_A`/`PRESS_A`. A press between two circles goes to the
nearer one (the boundary is halfway, `button_at`). Close turns red on hover — a red circle. Right by default (close last), left as a setting (close first).

**Which buttons** (owner, 2026-10-04, `window_controls::shown`). A button that does nothing for
a window is NOT drawn — hidden, not disabled, as GNOME and Windows do and as an app's own title
bar must (it cannot disable one) — and the capsule shrinks by 28 px. A window shows a button
when ALL of these say yes, close always:
- **the user chose it** — `[windows.controls] buttons`, which the shell keeps equal to
  `org.gnome.desktop.wm.preferences button-layout` (below);
- **the window asked for it** — `set_buttons` (the kit's `attachWindowControls(…, buttons)`;
  About asks for `["close"]`); every button until it asks;
- **no rule took it away** — a rule's `controls = ["close"]` (`Managed::controls`, the bits);
- **it can do it** — maximize only while the window can change size (minimum ≠ maximum);
  minimize never on a dialog (a window with a parent: it goes with that one — "Minimizing").
So by default a resizable window has minimize, maximize and close (72×24), a fixed-size window
minimize and close (48×24), a dialog maximize and close or close alone, About close alone (24×24).

- **The protocol is ours**, `protocols/nidara-window-controls-v1.xml`, both ends in this repo
  (server `protocols/window_controls.rs`, client `lib/nidara-wl`): `get_window_controls(wl_surface)`
  on a toplevel's surface; the compositor sends `layout(side, width, height)` — the box to reserve
  (24 px a button shown, less 8, and 8 more: 24, 48, 72; 24 high) and the side — at once and again whenever it CHANGES
  (`tell`, which keeps what each app was last told: after a settings reload, a rule applied,
  and every commit of that surface — its `set_buttons` or its size limits may have changed it);
  the app sends `set_position(x, y)`/`unset_position` and `set_buttons(bits)` (close 1, minimize
  2, maximize 4), surface-local, **double-buffered on wl_surface.commit** so the controls move
  with the frame that left room for them. `set_buttons` was added INSIDE v1 (2026-10-04): the
  library and Hyalo are installed together — a new library on an older Hyalo is a protocol error
  that takes the shell down. Not offered to sandboxed clients (like the glass).
  `set_ink(light|dark)` likewise (2026-10-08): the INK the controls are drawn with, since the app
  knows what its header is. Light (white glyphs) until it is sent; the kit sends dark whenever
  the window's own appearance is light (`kitAppearance().surfaceIsDark(win)`, re-sent on every
  appearance change). White glyphs on Settings' light header were invisible (owner, live). Hyalo's
  own title bar ignores it: it decides its ink from the bar's colour, as before.
- **Drawn** by `render/controls.rs`: one shader pass in output pixels (the capsule, its inset
  edge, the hovered button's fill, one glyph a button (`count`, 1 to 3) as distance fields, all anti-aliased at the
  output's scale), pushed over the window's own surfaces and under its popups; never on a
  fullscreen window. Hover and press live in `wm.controls_hover`.
- **On the shell's glass** (toolkit/PHASE1.md D7, owner 2026-10-19: "the button's look is the
  glass's properties, as on the top bar; light or dark backdrop is the glass's, not the app's").
  Under the capsule over an app's header Hyalo draws the bar capsules' glass, the same in every
  respect: a `control` pane — refraction, rim, lensing, tone, ink tone and the ink's thresholds
  read from the token export (`render/glass_tokens.rs`: `tokens/glass.json`, installed under
  `/usr/share/nidara/settings-data/`, looked at again every 2 s; `HYALO_GLASS_TOKENS` points
  elsewhere), never a copy of the numbers in Rust — on the shell's face (dark, whatever the
  mode, as the bar). A material Hyalo makes itself (`controls::glass`), drawn by the same
  `GlassElement` as a client's (`for_material`, `Whose::Hyalo`: its ids apart from the app's
  own material on that surface), right below the capsule, reading only inside the window
  (`within`: the desktop above a capsule 12 px from the top darkened what it measured to 0.32,
  under the 0.35 that turns the ink). Its SHADOW is the piece's law too, but a shadow is not
  the glass's to draw: it is the scrim pass's (`scrim::scrims_of`, the same as a client's
  `scrims_for`), one `ScrimElement` right below the glass with a memo of its own (`ShadowMemo`,
  apart from the window's own material's). A `shadow` on the shape alone draws nothing — that
  was #884, seen identical with and without it (2026-10-20). **The ink is the glass's answer to
  the backdrop, never the app's** (#889, toolkit/CONTRACT.md "Floating control capsule"): the
  control piece's `response`, `states` and `ink` from the export (`glass_tokens::ControlLook`;
  an export without them is no export here — the plain capsule, never a default), the capsule
  one answering shape whose measurement comes back with `Whose::Hyalo` to
  `controls::response_measured`, eased in a `Presenting` kept on the window's surface
  (`PresentMemo`). Its tone mixes towards the ink tone, its shadow grows, and the glyphs' ink
  (`Controls::ink`, the shader's `ink_rgba`) is the export's light ink mixed towards its dark one
  by the same r — the destructive state's own ink over a hovered close. The hover and the press
  are WASHES in the glass, one state region per button (its circle, `HOVER_R`), the hovered
  one's at the export's hover/press (destructive for close), the others at alpha 0 so they fade
  out over `states.fadeMs` (0 with reduce motion, `Scene::reduce_motion`): the opaque disc is
  the plain capsule's alone. The app's `set_ink` only says the ink of the PLAIN capsule:
  `[windows.controls] glass = false` (the A/B, and the check's control), or no export. The
  shader draws only the glyphs over the glass (`glass_under`). **The same in Hyalo's own title bar** (owner: "it has to be the same as in
  our apps"): with glass, its capsule is drawn apart — the `ControlsElement` and the glass in
  front of the bar, whose own pass leaves the capsule out (`TitleBar::controls_apart`) but still
  keeps its room for the title — so the glass's backdrop is the bar and its ink is measured on
  it, never the bar pass's own colour guess. CI: `scripts/ci/hyalo-controls-glass-check.py` (the probe with `HYALO_PROBE_STRIPES`: header
  blurred inside the capsule, sharp beside it; `HYALO_PROBE_HEADER`: dark glyphs over f0f0f0,
  white over 303030, the app asking nothing; `hyalo-title-bar-probe`: over its light bar the
  light glass, brighter than the bar, and dark glyphs; the pointer over close (`move` on
  HYALO_CONTROL): a red wash that differs over the light and the dark header; `glass = false`
  must fail all four — its hover is the opaque disc, the same over both).
  `hyalo-window-controls-check.sh` checks the app's ink on the plain capsule.
- **A capture says where moving windows were in it** (with `HYALO_CONTROL`): `<shot>.capture.json`
  carries `drawn` — each window drawn at a place (into the dock, out of it), `{id: [x, y, w, h]}`
  at the capture's own moment — and `opening`, each window opening as its picture is drawn in
  it, `{id: {box, scale, alpha}}` (`hyalo-motion-check.sh` picks its "near the edge" point from
  it, clear of the picture and its 20 px shadow). A check that needs a moving window's position in a picture reads
  it there, never from `msg windows` polls before and after the capture: on CI's software GL a
  capture is slow enough that the two polls lie 63 px apart (`hyalo-minimize-check.sh`
  `over_dock`). And it reads a picture's pixels (a gjs process each) AFTER watching anything
  move, not while the animation runs.
  🔴 **A check that captures while something moves writes `.ppm`, not `.png`**: on CI a PNG
  took 4.2 s to write (nightly of 2026-10-20, #891 — the 6 s minimize was over before the
  check began watching it cross the dock), a PPM 0.02 s. `hyalo-window-look-probe.js` reads
  both (`pixel FILE X Y`).
- **In flight the ink is kept** (`Controls::moving`, the window drawn at a `place`: into the
  dock, out of it, to another workspace): the glass is drawn with the ink it had and measures
  nothing (`GlassElement::measuring_nothing`) — what passes under a capsule on its way is not its
  header, and its ink must not flicker; and a measurement every frame of a moving capsule is a
  readback and a redraw each (on the CI's software GL it slowed the minimize check's captures
  until it missed the window crossing the dock).
- **A capture collects the ink it measured** (`capture_output` arms the poll as a frame does): a
  screenshot draws the glass too. Where no frame is drawn — the headless cage harness — only
  captures measure, so a check takes one capture before the one it reads.
- **Input**: `Hyalo::controls_under(pos)` walks the windows in drawing order (a layer or a window
  over the controls covers them); `surface_under` returns NONE there, so the app gets a leave and
  never the pointer over its controls; `update_controls_hover` runs after every pointer motion and
  sets the arrow. A left press over a button holds it and focuses the window; the release over the
  same button carries it out (`Action::CloseWindow`, `Action::Maximize`). The app sees neither.
- **One source for side and buttons: `button-layout`** (`ui/shell/core/WindowButtons.ts`, owner
  2026-10-04). GTK's client-side decorations, Chrome's web apps and Telegram place their own
  buttons by `org.gnome.desktop.wm.preferences button-layout` (directly or through the Settings
  portal). Settings → Appearance → Windows → "Window buttons" (`appearance.windowControls`,
  available where `caps.windowControls`: Hyalo) WRITES that key — the same buttons, moved — and
  the shell carries every change of it, from Settings or from anywhere else (GNOME Tweaks), to
  Hyalo's `[windows.controls] side` and `buttons` in the settings layer: close alone there
  shrinks Hyalo's capsule too, as mutter follows the key on GNOME. The side is the half close is
  in; the ORDER within it is Hyalo's (close outermost), not the key's. Nidara's default is a
  system dconf default, `appmenu:maximize,close` (`scripts/gen-dconf-defaults.sh`; GNOME's own is
  `appmenu:close`, close alone), and `migrations/2026-10-04-button-layout-from-gnome-default.sh`
  resets an account that holds GNOME's factory string as its own (measured on the owner's
  machine). Since #724 the default is `appmenu:minimize,maximize,close`, and there is NO switch
  for minimize (owner, 2026-10-04: no use case — the dock gives a minimized window its place,
  and tiled, minimizing takes a window out of the layout for a while); Settings offers the
  side alone. The key can still be changed by hand, and everything follows it. No migration
  gives minimize to an account that already holds a value of its own (Settings' side switch
  writes one): nothing of Hyalo has been published yet (owner) — `gsettings reset
  org.gnome.desktop.wm.preferences button-layout` brings the default back. Nothing is carried
  on Hyprland (no controls; it refuses a client's maximize too). The key is system-wide, so on
  the Hyprland session an app's own minimize button does nothing — accepted by the owner
  (2026-10-04): the next release is meant to be Hyalo only.
- **The kit's half** (`ui/lib/nidara-kit/platform/window-controls.ts`): a window has SLOTS — empty
  boxes that can hold the room, each with a `when(side)` — and the caller's own close button is
  the FALLBACK. With a layout, the fallbacks hide, the first slot that applies gets the box's size,
  and its position (`compute_point` to the window + the surface transform) is sent in the frame
  clock's LAYOUT phase whenever it moved; the library commits once more after a frame that drew
  nothing (as the glass does). Where the compositor draws none (Hyprland), nothing changes: slots
  hidden, the close button shown. The slot takes the box's WIDTH from each layout, so a capsule
  that shrinks (fewer buttons) gives the header its room back. `NidaraWindow` sets the slots up itself — right: the header's
  end, where the close button was; left: the header's start, or, with a sidebar shown DOCKED, the
  sidebar's top (`onSidebarPresented` re-picks the slot), in a row of the header's height
  (`.nidara-sidebar-controls`) so the capsule shares a centre with the toggle and the navigation
  beside it (measured 2026-10-04: with a 4 px margin it sat 8 px higher). **The geometry, on the
  owner's #921** (2026-10-23): header row 32, 8 below the window's top — its 32 px buttons 8 from
  the edge, as the sidebar's floating card — so its centre line is 24 from the top; the 24 px
  capsule is centred on it, **12 from both edges of its corner, on either side** (4 inside the
  card's 8, concentric with its radius 16) — header `padding-right: 12`, the sidebar row's left
  margin, `leftSlot.margin_start` (with the tools row's 4) when the sidebar is not docked, About's
  controls row; the divider 48 from the top. Until #921: row 48, capsule 32, 16/16, divider 64. ⚠️ A slot's margin is a WIDGET margin: a CSS margin is taken
  out of the size the slot requests, and the capsule drawn in it overlapped the toggle — so a window built on it gets the
  controls by passing its close button as `header.end`, as before. About, which has no header,
  places its own two slots beside its close button. `NIDARA_WINDOW_CONTROLS=0` turns it off.
- `nidara-hyalo msg windows` → each window's `controls`: `[x, y, w, h]`, global logical, or null.
- CI: `scripts/ci/hyalo-window-controls-check.sh` (C probe `hyalo-window-controls-probe.c`,
  leaving room as the kit does): the layout told (72×24), the controls where the app placed them,
  the pointer the app's over its body and not over its controls, maximize and restore, the side
  switched live and followed; close alone from the user's buttons and from the app's
  `set_buttons` (SIGUSR1), minimize and close while it cannot change size even asking for all
  (SIGUSR2; SIGHUP undoes it); a rule's `controls = ["close"]` on a new window of the app; close
  asks the window to close; the ink (SIGWINCH → `set_ink`): over the probe's 0x404040 window the
  brightest pixel of the controls is above 150 with light ink and at most 70 with dark, read
  from a raw PPM with od. Controls, each seen failing nested: a Hyalo without the protocol
  prints NO_CONTROLS; the one before #724 (no minimize) tells 48 at once; one that ignores
  `set_buttons` still tells 72. Minimizing itself: "Minimizing" above.

## Minimizing (#724, 2026-10-04)

The owner's decisions (issue #724): a minimized window stays on its workspace, HIDDEN — a state
of the window (`Managed::minimized`, the order it was minimized in), not a special workspace;
it comes back through the dock — its app's icon (the most recently minimized window of an app
with none shown) and a picture of each minimized window at the end of the dock; it shrinks into
that picture and grows back out of it. `wm/minimize.rs`.

- **Hidden** = itself or a window it is a dialog of minimized (`Wm::is_hidden`, `minimized_root`).
  `on_workspace` skips hidden windows, so the space, the focus order, cycling, cascading and
  tiling all do; `arrange_workspace` does not reconfigure them (a window is told its size again
  when it comes back). A tiled window leaves its layout and goes back in on restore; a workspace
  switched floating/tiling meanwhile only flips its `floating` (`set_all_floating`). A window
  out of the space is told it is not active (`sync_space`), minimized or on a hidden workspace.
  The IPC's workspace `windows` still counts it; `last_window` does not.
- **What asks for it**: the capsule's minimize (`Action::Minimize`), an app's own button
  (`xdg_toplevel.set_minimized`, `minimize_request`), `do minimize [ID]`. A dialog by itself is
  refused. **What brings it back**: `focus_window` — the one door to the focus (the dock's
  clicks, `focus-window`, xdg-activation, the overview) restores a hidden window first; `do
  unminimize ID` restores without the focus. Commands that move, tile or size a window refuse a
  minimized one (`target` vs `any_target` in actions.rs): it is in no layout.
- **Where it shrinks to is the dock's to say** (`minimize_targets` over IPC: per output, the
  layer surface's namespace and a rectangle per window id, in that surface's coordinates;
  `CompositorState.setMinimizeTargets`). The dock's thumbnail is not laid out until the dock
  hears of the minimized window, so a window going in WAITS, drawn where it was, at most `WAIT`
  (250 ms) — nested, with the real shell, its place came about 45 ms after the click — and goes
  without an animation if nothing comes (no dock). The dock PREDICTS the place from its layout
  (`publishMinimizeTargets` in DockCore: the item's `staticCenter`, plus the cross axis, size
  and centre offset of the trash's icon measured when the dock comes to rest with every item at
  rest size — the dock also comes to rest magnified, under a still pointer; measured 0.5 px from
  the item's real place) and sends exact bounds at rest; a click on a thumbnail sends where that
  thumbnail is NOW, magnified (`aimFrom`). IPC `windows`: `minimized`, `minimized_order`,
  `minimize_target` (global) and `drawn` (where its whole box is drawn while it moves).
- **The animation** (`Anim`, `Placement`): the whole box fitted into the place, moved and
  scaled by `ease` — the Hyprland session's `default` curve — over `[animations] minimize` ms
  (400 = its `windowsOut`); `[animations] enabled = false` is reduce motion (the shell's
  `setReduceMotion` writes it, and REMOVES it when not reducing). Everything of the window is
  drawn from one origin and one scale (`render/mod.rs`): its surfaces, corners, line, shadow,
  controls, title bar and popups shrink together; its dialogs move with it
  (`Wm::placement`). Both ways it is drawn out of the stack (`moving`), right in front of the
  dock's layer — Top, or Overlay when the dock is there (over a fullscreen window, with the app
  grid) — so it lands ON its thumbnail, over the dock's glass, as the thumbnail sits on it. 🔑 The
  owner's call (2026-10-04): #736 drew it going in under the shell's chrome, sinking into the
  glass, and the glass blurring a window that is supposed to become the thumbnail on top of it
  read wrong. Its dialogs are drawn in front of it (`Wm::within`), not by `wm.windows`' order. `post_repaint` keeps frames coming while one moves (`step_animations`).
- 🔴 **A window drawn at a scale that is not the output's needs `window::AtScale`.** Smithay's
  surface elements size themselves from the scale the DAMAGE TRACKER passes — the output's — not
  the one they were made with: a shrinking window's surfaces kept their full size from the
  scaled origin, and the box around the small window came out stale, black or white (seen
  nested, 2026-10-04; the custom shaders were right, they carry their own geometry). `AtScale`
  pins the scale for every window surface (`RoundedElement`'s inner, `push_tree`'s `Scaled`);
  at the output's scale it changes nothing, and it passes `underlying_storage` on, so a
  fullscreen window still scans out.
- 🔴 **A tagged IPC request cannot have integer map keys**: `#[serde(tag = "request")]` reads
  through serde's buffered content, which will not turn `"12"` into a `u64` ("invalid type:
  string"). `minimize_targets` takes string keys and parses them.
- **The shell**: `caps.minimize` (CompositorCaps); `minimizeWindow`.
  The dock (`DockCore`): a `minimized:<address>` item per window with `minimizedOrder > 0`,
  oldest first, between the trash's separator and the trash — a `DockItem` with `window`: a
  picture captured once when it is created (`captureWindow`; a minimized window draws nothing,
  its last frame is what it looks like) with the app's icon at its corner (`DockIcon.
  setThumbnail`, `BADGE`), a click or "Open" restores it, "Close window" closes it, no pin or
  drag. An app's icon cycles its SHOWN windows; with none shown it restores the highest
  `minimizedOrder`. Alt+Tab and the overview are #669.
- CI: `scripts/ci/hyalo-minimize-check.sh` in the smoke (the window-controls probe, now with
  `HYALO_PROBE_DIALOG=1` and SIGURG = `set_minimized`), ten steps with the REAL dock giving the
  place — the drawing checked by pixels of ONE capture of a 12 s animation, the one that catches
  it crossing the dock's glass (the probe's grey where its `capture.json` says it is drawn, not
  where it was, and beside the small window, above the dock, what is there once it has gone).
  Nothing is captured before it: on the nightlies of 2026-10-22/23 a capture "a second in" came
  back with the window already into the dock, and no poll after it could see it cross.
  Controls seen failing nested: the installed Hyalo before #724; one without `AtScale` ("its
  full-size box is drawn too"); one whose focus does not restore.

## Opening, closing and going to another workspace (#684, 2026-10-04)

`wm/motion.rs`, `render/snapshot.rs`. What the Hyprland session did, so nothing changes for the
user at the switch (config/hypr/hyprland.lua, "Animations"; the owner chose to go on with it,
2026-10-04): opening, the window grows out of its middle on `myBezier` over `[animations] open`
(700 = `windows`) — Hyprland's `popin` from nothing; closing, it shrinks to 80 % on `default`
over `close` (400 = `windowsOut`, `popin 80%`); both fade over `fade` (400, `easeOut`). The
curves are `motion::curve`, one Bézier solver for them and minimize's. `myBezier`'s control
point is at 1.05, but the CURVE peaks at 1.0085: the overshoot is under 1 % (a test that
expected 1.01 was wrong, not the curve).

- **One picture, scaled and faded** (`SnapshotElement`): the window drawn ALONE into a texture of
  ours by the GL renderer underneath (`HyaloRenderer::gles`, `import_surface_tree` first, as a
  capture), with room around its box for its line and shadow — the same elements the screen gets
  (`render::push_window`, the per-window body of `output_elements`), minus the `Glass`/`Scrim`
  ones, which sample what is behind them and offscreen nothing is. So none of the custom shaders
  needed an alpha. Opening, the picture is taken again EVERY frame, so the window is live;
  closing, it is taken once — the blur behind a translucent window is not in it (it comes in
  when the window has opened).
- 🔴 **A window opening must still get frame callbacks.** Its surfaces are in no frame (the
  picture is), so `surface_primary_scanout_output` has nothing to say, and a client that waits
  for a callback to draw its next frame stayed at its first one. `post_repaint` sends an opening
  window this output's frames regardless. Checked nested with a GTK frame counter: 23 → 61 → 99
  during a 3 s opening.
- 🔴 **The closing picture is taken while the surface still holds its last frame — and that is
  not always `toplevel_destroyed`.** A toolkit destroys toplevel, xdg_surface, surface, in that
  order; an app that exits without that, or is killed, has its objects destroyed in the order it
  made them: the SURFACE FIRST. `CompositorHandler::destroyed` (handlers.rs) takes it then;
  `Wm::closing_taken` keeps the second hook from taking another. Without the hook a killed app
  closed with no animation (control below).
- Drawn: an opening window in its place in the stack; a closing one over the windows still
  there (a fullscreen one over the chrome, where it was). None with reduce motion, for a window a
  rule takes them from (`animate = false`, shipped for `games` and `no-app-id` — Hyprland's
  `no_anim` on gamespace and `general-popups`), for one that opens on a workspace nobody sees, or
  one that closes hidden (minimized, another workspace).
- **Going to another workspace** (`Slide`, `show_workspace`): the one shown slides out sideways
  and the other in, on `default` over `[animations] workspace` (600 = `workspaces`, `slide`) — to
  a higher number from the right. No picture needed: the windows left behind are hidden, not
  gone, and are drawn from the model where they are (`Wm::on_workspace(from)`, behind the ones
  coming in), moved by a share of the output's width (`Slide::shift`) through the same
  `Placement` minimize uses. Pinned windows, the shell's layers and the wallpaper stay put. A
  special workspace shown or hidden does not slide.
- Not here: windows moving when the layout changes (Hyprland's `windowsMove`), layer surfaces
  appearing, a window opening from the dock icon that launched it (#6): each its own change.
- CI: `scripts/ci/hyalo-motion-check.sh` in the smoke, pixels against a screenshot from before
  the window (`was`): a second into a 30 s opening its middle is neither its grey nor what was
  there and near its edge nothing yet; closing (`HYALO_PROBE_TIDY=1`, the probe destroys its
  window as a toolkit does) still drawn, shrunk, then gone; killed (`kill -9`) the same; reduce
  motion and `animate = false` at once; going to workspace 2 (120 s long), just left of where the
  window was is its grey. Controls seen failing nested: a Hyalo that never opens animated (step
  1, "'64 64 64': it opened at once"), one that never closes animated (step 2, "no picture of
  it"), one without the `destroyed` hook (step 3, killed: "no picture of it"), one that never
  slides (step 5, "workspace 1 did not slide out to the left").
- 🔴 **An opening window's presentation feedback is taken with the picture** (`backend/mod.rs`
  `take_presentation_feedback`): it is drawn as a snapshot of its surfaces, so they are not among
  the frame's elements and their primary output was never set — every new window was told its
  first frame was presented only when the 700 ms opening ended (main, CI: callback 133 ms,
  presented 1056 ms; found 2026-10-18 by a `WAYLAND_DEBUG` timeline for #852). Any element
  drawn by proxy (picture, texture of surfaces) must take its surfaces' feedback itself.
  `nk-phase0-check.py` requires the gap under the opening animation in force (`msg config`,
  `animations.open`) on the vkms run: held feedback is at least that long by construction. A
  fixed 350 ms (half of it) failed a correct Hyalo at 355 ms on CI's software GL (2026-10-21).
- 🔴 **A surface is told its scale before its first configure** (`backend::tell_initial_scale`,
  from `initial_configure` and the layer's first configure): the preferred scale otherwise
  follows the primary scanout output, which an opening window (drawn by proxy, above) has only
  once it has opened — its content was drawn at a guessed scale and again ~700 ms later
  (nk-settings-slice live: commit 4 at 775 ms, 2026-10-18). Smithay re-sends a scale only when
  it changes. `toolkit/settings-slice/check.py` asserts `PREFERRED_SCALE` arrives before the
  first content commit; failed against the Hyalo without it, passed nested with it.
- 🔴 **An opening window's glass forms under its picture** (`render/mod.rs`, the opening
  branch): the picture has no glass, blur or veils (`snapshot::take` drops them: they sample the
  screen). They are drawn live under it, at its scale, through `GlassElement::forming` /
  `ScrimElement::forming` with the fade's alpha — the #764 formation, not a cross-fade — each
  under an id of its own while it forms. Without that a window opened transparent and its glass
  appeared at once when the opening ended (owner, 2026-10-18; nested A/B, frames at 120/200/300 ms).
- 🔴 **An animation that ends asks for one more frame** (`step_motions`, `step_animations`,
  `layers::step`): the frame just drawn sampled it short of its end. Without that frame an
  opened window stayed the opening's picture at ~99 % and was in no frame as itself — no
  preferred scale, no new content — until something else repainted; in CI the scale configure
  arrived with the next click (`nk-layer-motion-check.py`, intermittent, 2026-10-18).
- 🔴 A check that compares against "what was there" waits for the windows the check before it
  closed to finish fading: CI's first run of this one compared against the minimize check's
  killed probe, still closing.

### Every animation of Hyalo's is drawn at the moment the frame SHOWS (#766 B, 2026-10-07)

`render/timing.rs`. Opening and closing, minimize, the workspace slide and the shadow under the
glass are sampled at `Scene::when` — the moment the frame being built will be on screen — never
at `Instant::now()` inside the render. Sampled at the build, a frame shows the animation as it
was up to a refresh before it appears, and by a different amount each frame (a frame that begins
later or takes longer lands a step off). GTK's animations already follow the display, through
the `wp_presentation` feedback we send; this is the same rule for ours.

- **tty**: the next vblank after the frame begins, on the beat of the last flip the KERNEL timed
  (`Surface::last_vblank`, from the page-flip event's CLOCK_MONOTONIC timestamp, set only when
  the event carries one). The beat holds across an idle desktop: the CRTC keeps scanning at the
  mode's rate whether we flip or not. **With VRR on, or in a window (winit), there is no beat
  to predict**: those sample at the build, as before. Screenshots, screencopy and the closing
  picture draw "now".
- One `when` per frame, threaded explicitly (`Scene` → `push_surface`/`push_tree`/
  `push_material`/`window::push`). 🔴 Never sample the clock again inside the render: before
  this the render read the clock once per surface and twice more in `output_elements`; any read
  of it now puts that piece back at the build, a refresh behind the rest of the frame.
- Starting an animation still stamps the event's own time (`Instant::now()` in `start_*`): it
  began then, and the first frame shows how far it has gone by the time that frame is on screen.
  Ending stays at `Instant::now()` too (`step_motions`/`step_animations`, after a frame): an
  animation over by then was over at the `when` of the frame just built (`when` ≥ now), so that
  frame already drew its end; one not over yet asks for another frame.
- A frame begun too close to the next vblank to make it shows a refresh later than predicted —
  the error sampling at the build always had. `msg stats` counts those (below).

## Layers an app hands Hyalo to animate (nidara-layers-v1, #818)

`protocols/layers.rs`, protocol `protocols/nidara-layers-v1.xml`. Test 5 of the toolkit's phase 0
(`toolkit/CONTRACT.md`): the app sets where a layer ENDS and how it gets there; Hyalo moves it
every frame, also while the app is blocked. A layer is a `wl_subsurface`; position, scale (about
an anchor) and opacity animate, on a spring (closed form: the same value at a given moment
however the frames fall) or a cubic Bézier. A new value starts from where the layer is SHOWN,
and a spring keeps its velocity. `done` goes out after the frame that showed the end, with that
time on the monotonic clock; `cancelled` when a new value replaced a running transition.

- **Smithay cannot move a subsurface between commits.** Where it draws and hit-tests a
  subsurface is `SurfaceView::offset`, set at commit and private to it. So a tree holding a
  layer is walked by Hyalo: `render_tree` (each surface at its presented transform, wrapped in
  `AtScale` for its own scale) and `under_tree` (input). Every other tree goes through Smithay's
  own walks: `tree_has_layer` is the switch, and with no layer alive (`LIVE`) it costs nothing.
  The three render paths call it (`push_surface`, `push_tree`, the rounded window in
  `render/window.rs`), and the hit-tests of windows (`window_under`, from `surface_under`) and of
  layer-shell surfaces (`layer_surface_under`, from `layer_under`).
- **Input goes where a layer is seen.** `under_tree` returns the origin the pointer must be
  told so that `pointer − origin` is the point in the surface's OWN coordinates even while it is
  scaled — Smithay computes the local point that way, fresh on every motion. A layer faded to
  0 takes no input. The sampled `Look` is retained per displayed output frame
  (`layers/presentation.rs`), including across a retarget: interpolating again at input
  dispatch can be a whole slow frame ahead of what the person sees. A successful DRM
  queue only stages a snapshot; `frame_submitted` at vblank publishes it. Failed frames
  keep the previous one. Winit publishes on successful submit, its available boundary
  (the host compositor's presentation time remains unknown). Weak frame stamps reclaim
  replaced snapshots while preserving different outputs' current frames.
- **The state is double-buffered through Smithay's cached state** (`Pending`): `commit` TAKES
  what was pending and `merge_into` overrides field by field, so a sync subsurface's several
  commits land together with its parent's. `on_commit` walks the committed surface's whole
  tree, because a sync child's state is applied by its PARENT's commit.
- **The IME cursor names its layer explicitly** (#831, owner's authorization to amend
  the draft): `nidara_layers_manager_v1.set_text_input_cursor_rectangle(root, layer,
  x, y, width, height)` stages a layer-local rectangle with the ROOT's commit.
  Keyboard/text-input-v3 focus stays on the root. `layers/cursor.rs` walks the same
  presented transforms as the renderer, then updates the IME popup's location and
  rectangle event before the popup walk, sampled at that frame's `when`. It keeps
  the latest standard root-local rectangle separately: a null association or a
  destroyed/replaced layer restores it; never map an already mapped rectangle again.
  `nk-wayland::Window::set_layer_text_input` sends local coordinates only through
  this association; `set_text_input` clears it and sends root-local coordinates.
  A focused layer destroyed by the client disables its field. The new-popup handler
  sends the initial rectangle through the public popup API: Smithay initializes it
  internally but otherwise sends no initial event if the IME creates its popup after
  the field's commit. No Smithay patch.
- **The native client and evidence** (#831): `nk-wayland` generates the XML, owns
  up to 64 synchronized subsurfaces and their released-slot shm buffers, and stages
  children just before the parent commit. A pending, never-committed buffer stays
  reusable (it will get no release); it becomes busy at the child's commit. Pointer
  events carry a stable layer ID and already-inverted local coordinates. The crate
  supplies no motion defaults. `nk-phase0 --test5` blocks for 1.5 s after submitting
  two 2 s transitions; `scripts/ci/nk-layer-motion-check.py` checks movement, input,
  completion, retargeting, buffers and a real IME popup at scales 1/1.25. Controls
  omit the parent commit, animate in the client, or omit the cursor association,
  and must fail at their own assertion. The original C server probe stays too.
  Cursor geometry rounds both endpoints outward in logical space. The screenshot
  oracle carries the solid-colour span's physical-pixel sampling uncertainty into
  those endpoint bounds; comparing integer height directly with `12 * scale`
  spuriously fails around scale 7/6. Each capture records its measured spans,
  rectangle and bounds in JSON, and the missing-association control still fails.
  Real IME probes must wait for the client's new clipboard offer before seeding
  text, and its received `keyup` before comparing release snapshots. On vkms a
  fixed pause can read the previous offer or sample before key release delivery.
  Startup, restart and focus return wait for the input-method activation/done
  and the grab's keymap: activation and grab are separate protocol operations.
  Missing activation fails the focus-return row, including its re-enable fault.
  Read Editor after its diagnostic IME event counter
  covers the done/leave events already received on the wire; a fixed sleep can
  sample before a real Hangul flush or preedit update. These barriers observe
  delivery/processing, never the desired text, so dropped-edit controls still fail.
  `NK_IME_BARRIER_FILE` is an evidence-only snapshot nonce acknowledged at idle
  after dispatch, including native Key callbacks; it never injects an event or
  mutates Editor. Seed setup checks a fresh Paste callback, and copy checks the
  new selection offer. Anchor repeat timing on the delivered key counter, not
  the most recent unrelated snapshot's timestamp.
  Reset each case's Editor timeline on rerun: its counters and timestamps start
  from zero in each new process and cannot be mixed with an earlier run.
  Chord barriers must cover modifier releases too: stopping fcitx after V-up
  but before it forwards Ctrl-up leaves the client under Ctrl and breaks Compose
  if the next settings request keeps the same keymap. Wait for each actual
  release, then dispatch; do not force a rekey or synthesize another release.
- **A destroyed layer object leaves its entry** in the surface's data map (a data map cannot
  drop one): `alive` turns false and the surface is a plain subsurface again. A new
  `get_layer` on it renews the entry.
- **A layer's own glass** (`toolkit/PHASE1.md` D7: the native window's sidebar and title bar).
  `render_tree` returns a `LayeredTree`: the surfaces, and each layer's `GlassElement`s with the
  index of the layer they lie right below; `interleave` puts them in the frame front to back. So
  a layer's glass is a framebuffer effect like any other, and its backdrop is everything drawn
  behind that layer — the window's own content, its background, the desktop — re-captured only
  when that changes (scrolling the content re-blurs; the layers are not repainted). Two rules:
  its glass reads only inside the root surface's box (`GlassElement::within`: the window's edge
  repeats past it, measured necessary — without it the sidebar's and the title bar's outer edges
  darkened with the desktop beside the window), and a layer fading in or out FORMS its glass
  (`forming`, #764). Made after the walk: the walk holds each surface's states locked, and
  `for_surface` takes them again.
  And it is cut to the window's ROUNDED corners like the layer's own surface
  (`GlassElement::rounded_to`, the shader's `outer`): before 2026-10-20 only the surfaces went
  through the rounded program, and a title bar or sidebar reaching the window's corners drew its
  glass square past them (owner, live on nk-widgets-demo).
  Its CONTENT is cut at the window's box too: a window whose tree holds a layer is always drawn
  through the rounded program with the clip set to its box (`push` in render/window.rs,
  `tree_has_layer`) — a sidebar sliding out of the window (collapsing, D7) showed its text past
  the window's edge while its glass stopped there (owner, live on nk-widgets-demo, 2026-10-21).
- **A graded blur** (`set_shape_grade(top, bottom)`, inside material v1 — lib + Hyalo together):
  a shape's blur strength from its top edge to its bottom edge, 0..1. One blur cannot be graded,
  so the shader (`graded` in `glass_final.glsl`) walks the capture's four as a ladder — sharp
  (level 0), soft, middle, full (`BlurMix`'s copies) — and mixes the two rungs either side of
  each pixel's strength. A graded shape makes its glass capture those copies even where the
  client paints the glass (`soft` in `for_surface`); a window's backdrop is never graded. The
  rungs are equally spaced in strength; the curve and the numbers are the owner's to decide
  live (D7: "the owner decides live (A/B)").
- CI: `scripts/ci/hyalo-layer-glass-check.py` + `hyalo-layer-glass-probe.c` in the Hyalo smoke —
  4 px columns in a window under a transparent sidebar layer with a blur and a title-bar layer
  with a graded blur, contrast measured along rows (≈ 127 sharp, under 40 blurred); controls
  `--no-material` (the sidebar's columns stay sharp) and `--uniform` (the title bar as blurred
  at its bottom as at its top) must each fail their claim; and the pixel one px in from each top
  corner must be what lies beside the window (control: a `rounding = false` rule for the probe);
  of an opaque red layer half outside the window's left edge nothing may show beside the window
  (control: the same test on its half inside, which must be red).
- Not drawn yet: the drawn region (#761) of a layer-shell surface while it holds a layer (it is
  drawn whole); capture shows layers at their presented place like the screen. Not offered to
  sandboxed clients, like the material.
- ⚠️ Locally, the headless `cage` harness draws NO frames with this Mesa (`msg stats` →
  `frames_drawn: 0`; the winit surface fails with `BAD_ALLOC` at start), so `done` — sent after a
  frame — never comes there, while screenshots (drawn on demand) and clicks work. The tty smoke
  in CI draws frames and checks all four steps.
- CI: `scripts/ci/hyalo-layer-motion-check.py` + `hyalo-layer-motion-probe.c` in the Hyalo
  smoke. Its control is inside it: a click where A will END must not be A's. Seen failing
  against a Hyalo that hit-tests at the model position (`under_tree` sampled 60 s ahead).

## Hyalo's title bar (#708 point 5, its second half, 2026-10-03)

For an app that leaves its decorations to the compositor — kitty, Qt apps, Chrome with "Use
system title bar and borders" — Hyalo draws a thin bar, the owner's choice on the mockup: **one
piece with the window** (no line, no colour of its own), **the same capsule** as over our apps'
headers, the title centred. `render/title_bar.rs`.

- **Who gets it** (`wm/mod.rs` `wants_title_bar`): the client ASKED for server-side (or unset —
  the compositor's choice; `shell/decoration.rs` keeps what it asked), it is not one of our apps
  (those carry the controls in their own header), and — once it has drawn — its surface IS its
  box (`render/window.rs` `fits`). Both halves are needed: a GTK 3 app asks for client-side and,
  TILED, drops its shadow margin, so `fits` alone would put a second bar over its header bar;
  Chrome without the setting asks for client-side, is told server-side, ignores it and keeps its
  margin. Before the first buffer it is predicted from what was asked, so a tiled window's
  first frame is already its size under the bar. Recomputed at every commit
  (`update_title_bar`): an app that switches its frame while it runs gains or loses the bar,
  with the layout following. A rule's `title_bar = false` takes it from one app.
- **Its place**: on top of the client's box, INSIDE the window's — `Managed::bar()` (32, 0 in
  fullscreen), `frame()` = the box with the bar. 32 = the capsule's 24 and the same 4 px above,
  below and beside it (`window_controls::BAR_MARGIN`; owner 2026-10-03: equal gaps; #921, owner
  2026-10-23: in Hyalo's bar the capsule sits 4 from the window's edges, which keeps the bar
  thin — it was 48 with the 32 px capsule 8 from them). Not the same total: a kit window's header starts 8 below the window's edge (its
  floating sidebar card's margin), Hyalo's bar at the edge, so the capsule is 12/12 from the
  corner in ours (inside the sidebar card) and 4/4 in the bar — centred on its row's line in
  both, as macOS centres its window buttons in whatever bar they are in. A tiled or maximized window's tile is the frame
  and the client gets the rest; a floating window keeps the size it asked for and the bar sits
  above it, clamped by the frame (`clamp_floating_with_bar`: the bar, not the client, may never
  leave by the top). Placement, cascading, centring, dropping after a drag all use the frame.
  `m.rect` stays the CLIENT's box (what the IPC's x/y/width/height say); `title_bar` in
  `msg windows` is the bar's height above it.
- **Drawn** in ONE element, three steps inside its `draw`: (1) the client's top row (one buffer
  pixel under the edge, across its box through its viewport: "Sampling a client" above) drawn through **Smithay's own texture path** (`render_texture_from_to`,
  which knows the format, the transform, an external image) into a 16×16 target bound in place
  of the frame's — 16×16 so that whatever the output's rotation, 16 samples lie along the row;
  (2) those averaged into one texel; (3) the bar in one pass over the frame: that colour, alpha
  included (a translucent kitty gets a translucent bar with the window's blur under it — the
  backdrop's shape is the frame), the title, the capsule (`controls_glsl!`, the SAME GLSL as
  `render/controls.rs`), and the window's top corners (the client's own top corners are inside
  the frame, not cut — `RoundedElement` gets the frame). The client's GL texture comes from
  `HyaloRenderer::surface_texture` (on the tty backend, the MultiTexture's copy for the GPU that
  renders).
- **Ink**: white on a dark bar, black on a light one, decided on the GPU from the same texel —
  black where it has the better contrast (linear luminance above 0.179, the WCAG crossover), and
  only when the bar is mostly opaque. Over close's red the glyph is white either way.
- **The title**: Pango + Cairo (`pangocairo`, the libraries GTK draws the shell's text with) into
  an A8 raster at the output's scale, medium weight, the chrome's fixed 13 px, ellipsized to what
  the capsule leaves on BOTH sides (so centred it never reaches it); kept on the surface while
  nothing it depends on changes, uploaded once per raster (`GL_ALPHA`, at most 32 kept). The
  family is `[windows.title_bar] font`, which the shell keeps equal to the interface font's
  (`core/AppearanceSync.ts`, effect `titleFont`, `settings.setWindowTitleFont`). A title change
  redraws (`title_changed`): it can come without a buffer.
- **Input** (`state.rs` `chrome_under`, which `controls_under` is now a view of): the capsule is
  `window_controls::managed_rect` — in the bar when there is one, above the surface (negative y),
  so hover, clicks, the IPC's `controls` and the drawing all come from one place; the rest of the
  bar is `Chrome::Bar`. Over either, no client gets the pointer (`surface_under`) and the arrow is
  shown. A left press on the bar focuses and starts a move grab; two within 400 ms (GTK's
  double-click time) maximize or restore (`input.rs` `title_bar_press`); other buttons focus only.
  `window_under` counts the bar as the window's.
- **Chrome switching its frame while it runs** (measured, 2026-10-03): turning "Use system title
  bar and borders" ON makes Chrome paint its whole surface opaque at once and keep its old window
  geometry — the 10 px shadow margin it no longer draws — until a configure comes, and it asks
  nothing over xdg-decoration (it asked for client-side when it started). It overflowed its tile
  by 10 px on every side. `poke_stale_geometry`: an opaque region outside the geometry means the
  geometry is stale — one configure (once per geometry) makes Chrome restate it, and the client
  counts from then on as having asked for server-side (`decoration::note_dropped_frame`), so it
  gets the bar. Turning it OFF, Chrome does ask for client-side, and the bar goes.
- 🔴 **A frame committed before the client acks its last configure is NOT its choice**
  (`awaits_configure`, measured nested 2026-10-04 with WAYLAND_DEBUG on a real Chrome web app
  and Telegram). Told maximized, Chrome commits its maximized frame — opaque to the edges, no
  margin — over its OLD geometry, then acks; that is the very picture of the setting above, so
  `poke_stale_geometry` marked it server-side and the maximized web app got Hyalo's bar over its
  own. Asking to be restored, Telegram (and Chrome) commit the maximized size again before any
  configure reaches them, and `window_committed` took it as the floating window's own size: the
  "restored" window stayed screen-sized. Both now wait while the toplevel has pending configures
  (Smithay's `pending_configures()`); the setting turned on while Chrome runs answers no
  configure at all, so it is still caught.
- CI: `scripts/ci/hyalo-title-bar-check.sh` in the smoke (C probe `hyalo-title-bar-probe.c`,
  light top rows on a dark body, server-side in a buffer twice its width cropped by a viewport,
  the extra half black): the bar and the capsule's place; the bar's pixel on screen is the app's
  top colour and its darkest title pixel dark; the pointer Hyalo's over it; dragged by it the
  window moves, a double click maximizes and restores; the probe switching to its own frame
  (SIGUSR1, a translucent red shadow margin, its own corners cut round at 8 px) loses the bar and
  is cut to its box — its edge pixels are its own, beside them is what was there before it, and
  3 px in along the diagonal (inside its own corner, outside the window's) is not its colour; its
  own maximize request (SIGHUP) maximizes it with no bar and restores it to its box although,
  with its own frame, it commits a frame for the other state before each ack (Chrome's and
  Telegram's order, above) — and back (SIGUSR2) gets the bar;
  close in the capsule. Controls, all seen failing: the installed Hyalo without the bar
  (`title_bar` null at step 1); a bar of a fixed colour, and one that averages the whole buffer
  row (step 2: "the bar is 115 115 115… not one piece"); no clip ("the shadow margin shows left
  of the window (105 9 11…)"); a client-side frame left square ("not rounded"); client maximize
  requests refused ("did not maximize: none"); the subsurface probe (`HYALO_PROBE_SUBSURFACE=1`,
  blue top rows in a subsurface over a transparent toplevel) under a bar sampled from the
  toplevel ("the bar is 237 237 237, not the content's blue"); a 24 px menu (SIGURG) clicked 4 px
  inside its DRAWN corner, under popups placed against the surface ("the menu got nothing" — its
  centre would not tell: the 12 px margin is half the menu); a frame read before the ack, each guard removed
  in turn ("maximized with its own frame, it got Hyalo's bar too"; "restored at [5,5,1262,678],
  it was [536,303,400,250]").

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
- **Tiling keeps dividing, even below a client's minimum** (owner, 2026-10-14).
  Do not float overflow windows or impose client minima on the layout. GTK can allocate its
  minimum anyway: the committed geometry and buffer may then be LARGER than the cell.
  `Managed::visible_size()` is the layout's client box for tiles, the committed geometry for
  floating windows. Drawing, backdrop, corners, title bar, snapshots and hit-testing must use
  that SAME visible box. `render/window.rs` clips the root surface tree to it even with
  rounding disabled; popups keep their separate placement and input. Never use the oversized
  root's input region to block the next tile (`surface_under`, `chrome_under`, `window_under`).
  The controls capsule is clamped into the visible header (`managed_rect`), preserving its
  side margin where it fits; a cell too small for the capsule shows none rather than painting
  over its neighbour. CI: `hyalo-resize-check.py` opens ten GTK windows, compares their actual
  pixels and clicks each cell in both stacking orders.
- **Resize borders belong to Hyalo, for every resizable app** (2026-10-14).
  An undecorated GTK window (Settings) has no GTK resize grips; relying only on the client's
  xdg resize request made it impossible to grab its border while Chrome worked. `Chrome::Resize`
  uses `border_edges`: 3 logical px inside (5 for an X11 window, `X11_INSIDE_STRIP`: Chromium and
  Electron keep a 5 px band of their own there with their own one-way cursors — measured on
  ChatGPT with an XFixes probe, 2026-10-20 — so Hyalo takes all of it), 6 outside, corner reach 16. It shares the ordinary
  window grab path with client requests and Super+drag. Fullscreen/maximized windows have no
  resize border; fixed dimensions have no matching edge. A tile offers only edges that move
  a split (`Layout::can_resize_edge`), never its outer output boundary. Layers and popups keep
  precedence. The cursor follows the edge and stays there during the grab. Tiled drag deltas
  round the accumulated displacement, so subpixel pointer events are not lost.
- **The cursor over chrome is Hyalo's, not the client's** (owner, 2026-10-20). The client under a
  resize edge still has the pointer (the 3 px inside are its surface) and sets its own cursor,
  which used to win: kitty showed its text cursor on its edge. `cursor_image` now keeps the
  client's request in `client_cursor` and shows it only while `wm.chrome_cursor` is false;
  `update_controls_hover` puts it back when the pointer leaves the chrome or a resize ends. The
  SHAPE says what the drag does: a floating window's edge shows the arrows (`ew`/`ns`/diagonals),
  a tile's edge the separator (`col-resize`/`row-resize`) — it moves the line shared with a
  neighbour (`ResizeEdge::cursor(tiled, room)`). The third shape, the arrow against a bar
  (`e-resize`, `se-resize`…), means "this edge can only go one way": a floating window at its
  client's smallest or largest size on that axis (`Room`, from `size_limits`) shows it pointing
  the way the edge can still go; a corner only when both its axes are one-way (owner, 2026-10-20).
- **A resized tile is held by the side that did not move** (owner, 2026-10-20: "windows expand
  to the opposite side and snap together on release"). A client draws its new size frames after
  Hyalo lays the tile out; the grabbed tile was not placed at all until release, so one taken by
  its LEFT edge grew to the right, over its neighbour, and snapped back when let go.
  `resize_from` keeps each tile's box at grab start; after every layout step `resize_anchors`
  records which side moved, and `anchored_loc` draws the window against the OTHER side,
  wherever its committed size reaches (`sync_space`, and each commit via
  `resize_anchor_commit`) — only while the client has NOT yet acked its last configure: once it
  answers, what it drew is its answer (a cell below GTK's minimum draws larger and is clipped from
  the origin; held by its far side it slid over its neighbour and stole its clicks —
  `hyalo-resize-check.py` caught it). Checked
  nested with the client SIGSTOPped mid-drag and resumed before release, against main.
- **A window born tiled has no Wayland floating box yet** (#809). Its initial configure is
  the predicted tile, so `window_mapped` must not save that size as `float_rect`. On its first
  `float`, `toggle-floating`, or move to a floating workspace, `arrange_workspace` sends
  xdg-toplevel size `0×0` (the client chooses within the existing bounds). After the client
  acks and commits, `window_committed` centres the size it actually drew and saves that box;
  later tile → float cycles restore it (#742). X11 has no `0×0` request: before placing its
  first tile, `x11_initial_configure` saves the pre-placement client request as its own box.
  `pseudo` on a still-tiled Wayland window with no own box uses the tile size until it has
  floated; its fallback is the tile, not a remembered preference. CI:
  `scripts/ci/hyalo-float-size-check.sh` covers both kinds of client, workspace moves and
  the saved-box regression. 🔴 Its Wayland probe needs `HYALO_PROBE_CHOOSE_SIZE=1`: the
  ordinary `hyalo-window-controls-probe` draws a fixed buffer whatever configure says and
  would let a size test pass for the wrong reason. Controls seen failing nested: unchanged
  main `cb405718` (Wayland first float stayed at its 2550×1430 tile, with no `0×0` configure).
- **A modal dialog keeps the focus from its parent** (xdg-dialog-v1; GTK marks a `modal` transient
  window with it). `focus_window` is the one door to the focus — a click, the keyboard, the IPC,
  the overview — and it hands the focus meant for a window to its open modal dialog
  (`modal_target`, down a chain of modals). CI: `scripts/ci/hyalo-dialog-check.sh` (modal: the
  parent gives way; a plain dialog: it does not — the control). Without the redirect the first
  half fails (checked, 2026-10-01).
- **Client maximize requests are granted** (`shell/mod.rs`, owner 2026-10-04) — the maximize
  button an app draws itself, or a double click on its own header (Chrome's web apps, Telegram),
  does what Hyalo's title bar and capsule do; unmaximize restores. Until then they were refused,
  as on the Hyprland session (`suppress_event = "maximize"`): the client laid itself out
  maximized, got its old size back and jumped. Not before the window is mapped (an app restoring
  its last state opens at the size it is given) nor from fullscreen. Fullscreen requests are
  granted.
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
  `workspace` (`"3"`, `"special:NAME"`), `silent`, and the look's `rounding`, `backdrop`,
  `title_bar` and `controls` (the only buttons its controls may show). 🔑 **A rule applies to a window ONCE, the
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
  have — that is #683, not a rule.
- **VRR for games** (`[outputs.X] vrr = "games"`, Settings → Display → "Fullscreen games"): VRR
  on while a game (`games::is_game`) is fullscreen on the output's active workspace with no
  special workspace over it (`Wm::game_fullscreen_on`), off otherwise. `vrr` is still a bool
  for always/never, so the layers already written keep their meaning (`config::Vrr`). The tty
  backend asks before EVERY frame (`vrr_for_games`), so entering and leaving fullscreen, a
  workspace switch and the game closing need no hook each. Only where the monitor switches
  without a modeset (`VrrSupport::Supported`): one that needs a modeset would go black each time
  a game comes and goes, so there it stays off. `msg outputs` gives `vrr` (asked) apart from
  `vrr_enabled` (on now), and Settings reads the first.
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

## X11 apps: Xwayland, with Hyalo as its window manager (#683)

`xwayland.rs`. Hyalo starts Xwayland itself at startup (`[xwayland] enabled`, read once) and is
its window manager through Smithay's `X11Wm`. `DISPLAY` is set for every child, the autostart's
`uwsm finalize` included, as soon as the sockets are bound. An X11 window is a `Managed` like any
other — same layout, rules, title bar, controls, animations, minimize — and `msg windows` marks
it `xwayland: true`. `msg xwayland` says the display, whether the WM is up, the scale, and how
many X11 menus are shown.

🔑 **Why not xwayland-satellite (owner, 2026-10-07: "full compatibility — no game that does not
run or runs badly").** Both were measured on the owner's machine against Steam, Thumper (Proton),
LIMBO (native) and Portal (#683). Satellite failed on three counts: an output's size change
never reached Xwayland, so a running game fell out of fullscreen and off the screen; every X11
window carried satellite's pid, so a native X11 game was not detected; and it gave Xwayland twice
the DPI on a 1.5 screen. All three pass here, and frame rate and GPU cost were the same (satellite
costs ~1 % more CPU).

What X11 needs that xdg-shell does not:
- **A position.** An X client knows where its window is and opens its menus from there.
  `configure_x11` sends place and size together whenever either changes: in `arrange_workspace`,
  `sync_space`, and during a resize grab. The rect Hyalo lays out is the visible box; the X window
  is larger by the shadow a client-side frame declares (`_GTK_FRAME_EXTENTS`), which is added there.
- **Focus.** The X server routes keys to its own input focus, which the window manager sets. The
  seat's `KeyboardFocus` is therefore `focus::KeyboardFocus` (a surface, or a boxed `X11Surface`
  whose `enter` sets the X focus or sends `WM_TAKE_FOCUS`). Everything in Hyalo still names a
  focus by its surface; `set_keyboard_focus` looks the X11 window up (`keyboard_target`). Read the
  focus as a surface with `current_focus().and_then(|f| f.surface())`.
- **The pid.** Xwayland is Hyalo's child, so the socket's credentials are Hyalo's own.
  `wm::window_pid` asks the X server instead (XRes, else `_NET_WM_PID`). That is how a game Steam
  runs is found (`games.rs`), and what IPC reports.
- **An app id when there is no class.** The app id of an X11 window is its `WM_CLASS` class, and
  some games set none: Distance (Unity 5, native) has only Steam's `STEAM_GAME`. With an empty app
  id the dock skipped the window, so a game on `gamespace` could not be reached from it. A window
  with no class whose process carries a Steam app id is `steam_app_<id>`, the class Proton games
  have (`wm::remember_steam_class`, read once at map, kept in the surface's user data).
- **Override-redirect windows** (menus, tooltips, drop-downs, splash screens) are never managed:
  `Wm::x11_overrides`, drawn over the windows and the bar (below the overlay layers), hit-tested
  first in `surface_under`, and they cover a title bar in `chrome_under`. 🔴 **They get frame
  callbacks in `backend/mod.rs`, like a window.** Without them Xwayland never commits a second
  frame, and Steam's menus stayed black.
- **Scale.** Xwayland gets the largest output scale as its client scale (Smithay converts every
  coordinate), so X clients draw at the real pixels: sharp at 1.5, with the X screen at the
  output's full resolution. 🔴 Smithay describes an output to a client in that client's pixels,
  and only when something changes. After `set_client_scale` every output is described again
  (`resend_outputs`). Without it Xwayland kept the screen size it had before the scale changed:
  853×533 for 1280×800 at 1.5, then 1920×1200 back at 1.
- **DPI and cursor.** `update_x11_resources` sets XSETTINGS (`Xft/DPI`, `Gtk/CursorTheme*`) and
  the root window's resource database (`Xft.dpi`, `Xcursor.theme`, `Xcursor.size`; what `xrdb`
  writes, read by Qt, Wine, Xft and Xcursor). It does this on its own X connection, on a thread,
  because Xwayland may be inside a Wayland roundtrip with Hyalo. The property change is
  `.check()`ed: only flushed, it was lost when the connection closed.
- **The clipboard** both ways goes through Smithay (`XwmHandler` selection methods; the Wayland
  side forwards in `SelectionHandler::new_selection`). 🔴 Smithay queues the X selection claim
  without flushing it, so it went out with the next X event, and an X app pasting right after a
  Wayland copy got its own last copy. A request that waits for a reply flushes what was queued
  (`get_randr_primary_output`, changing nothing). The CI check caught this one run in two.
- An X11 window that unmaps is gone. Mapped again, it is a new window, as on every X window
  manager.

Tests: `scripts/ci/hyalo-x11-check.sh` (with `hyalo-x11-probe.js`, GTK 3 on X11) in the smoke.
It checks that a window has its own pid, that keys reach it, the clipboard both ways (each against
what was there before), and an X11 menu at its place whose SECOND frame shows. Its control: with
the menus' frame callbacks removed, the last check fails "stuck on its first frame" (checked,
2026-10-07). Measured by hand (nested, the owner's Steam library): Steam (login, store, its menus,
its own maximize/minimize, dragging by its header), Thumper fullscreen through size and scale
changes, LIMBO detected as a game by its pid. A real session still has to show games at the
monitor's rate (tty).

- Nested: `msg output winit scale=…` used to replace the winit output's `Flipped180` with the
  config's transform, turning the whole nested desktop upside down. `outputs::apply` keeps the
  window's own transform now. A winit resize also re-arranges like a mode change
  (`outputs::arrange`), so a fullscreen window fills the window again.

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

## The lock screen (ext-session-lock-v1)

`lock.rs`. **While the session is locked nothing of it is drawn or reachable**: an output shows
its lock surface over the BACKGROUND layers (the wallpaper) and nothing else — windows and the
shell's layers are not drawn at all, not covered by an opaque sheet. That is the difference
from Hyprland, which draws the lock surface over black, so `nidara-lock` painted its own copy of
the wallpaper and imitated the glass on it (`glass-capsule.ts`'s header). On Hyalo the lock's
window is transparent (`Lock.ts`, on `HYALO_SOCKET`), the lock registers THE glass material
(`registerGlassMaterial` in its `app.ts`) and every `GlassCapsule` declares its pill through
`trackGlass`, so the card's glass is Hyalo's, refracting the real wallpaper.

What holds while locked, and where:
- **Keyboard focus only to a lock surface** (or a popup of one). Every focus change in Hyalo goes
  through `Hyalo::set_keyboard_focus`, which refuses anything else while locked — a click, a new
  window, xdg-activation, a focus grab, a popup grab. ⚠️ Do not call `keyboard.set_focus`
  directly anywhere else: that is the hole. `restore_keyboard_focus` (run after every dispatch)
  focuses the lock surface instead of the window, or the instant before the lock surface exists
  would hand the keyboard back to the window behind it.
- **Pointer**: `surface_under` returns lock surfaces only; a press focuses the lock surface it
  lands on and runs no binding (no Super+drag, no wheel binding).
- **Bindings**: only those marked `locked = true` in `[binds]` (volume, brightness), plus the two
  built in (VT switch, Ctrl+Alt+Backspace).
- **No capture**: window capture frames fail; the virtual pointer does nothing; the virtual
  keyboard global is HIDDEN from new clients (`LockState::locked_flag` in its global filter) —
  Smithay's virtual keyboard sends keys straight to the keyboard focus, which is the password
  field, and `wtype` connects anew for every run.
- **A new lock comes in over the desktop** (`LockState::draws_locked`). From the request on
  nothing of the session is reachable, but an output keeps SHOWING it until its lock surface has
  a buffer — at most `HOLD_SESSION` (1 s), then the wallpaper alone — and cuts straight to the
  lock screen. Cutting at the request showed the bare wallpaper for the frames `nidara-lock`
  needed to draw: a flash lighter than both the desktop and the lock screen's veil (owner,
  2026-10-02: "kitty lights up for an instant"). A RELOCK (a new client taking over a dead one's
  lock) holds nothing: the session was hidden and stays so. So the shell no longer hides the bar,
  the dock and the island before a lock on Hyalo (`lockScreen` in `ui/shell/app.ts`; it still does
  on Hyprland, which draws the session until the lock surface commits).
- **"Locked" only when true**: the client hears `locked` once every output that shows frames
  (`Backend::output_shows_frames`: powered, on the active VT) has SHOWN a locked frame — the tty
  backend's vblank, winit's submit. A frame counts only if rendered for THIS lock (a generation in
  the output's user data).
- **A lock client that dies leaves the session locked.** Once a second the lock checks its
  client; a dead one is started again (`nidara-lock`, or `HYALO_LOCK_RELAUNCH`) at most 3 times
  in 30 s, then a key press tries once more. A new client may take over a dead client's lock; a
  second locker while a live one holds it is refused.
- **A lock client that never asks still gets the session locked — the GUARD** (2026-10-12; an
  outside review found the hole). When Hyalo itself wants the lock — sleep, idle, `loginctl
  lock-session`, all through `lock_session` — it starts the client and waits for its REQUEST.
  Until then the session was open: a client that failed to start (or hung before asking — a
  frozen shell holds `nidara-lock` in `nidara-ipc hideForLock` for its 15 s timeout) let sleep go
  after the grace, and the machine came back UNLOCKED. Now, `GUARD_AFTER` (5 s) after the ask —
  before sleep, at `SLEEP_GRACE` (3 s) — Hyalo locks the session itself (`Mode::Guard`):
  wallpaper alone, input to nobody, the client started again as for a dead one, `msg lock` says
  `guard: true`. A client that asks later takes it over as an ordinary RELOCK (no hold: the
  session is hidden already), and only a client can unlock. Before sleep the delay inhibitor goes
  once the guard is on screen (or `GUARD_SHOWN`, 1 s, later: 4 s total, under logind's 5), and on
  the way back an output is powered only over a locked session — guarded if it somehow is not.
  ⚠️ A `nidara-lock` that HANGS keeps every relaunch out (its `pgrep -x` single-instance check):
  the guard then holds until it moves — safe, not friendly; Ctrl+Alt+Backspace is the way out.
- **The lock surface needs its frame callbacks** (`post_repaint`). Without them GTK's frame clock
  never ticks there and everything the lock fades in (the clock, the card) stays at its first
  frame: invisible. Found nested, 2026-10-02.
- IPC: `nidara-hyalo msg lock` (`locked`, `guard`, the outputs with a lock surface); event `lock_changed`.

Tested by `scripts/ci/hyalo-lock-check.sh` in the Hyalo smoke (seven steps, the control last: after
the unlock the window behind gets the keys), and the guard by `scripts/ci/hyalo-lock-guard-check.sh`
(a client that does not start, one that connects and hangs, each taken over by a working one; the
control after). The smoke's `HYALO_LOCK_RELAUNCH` is `hyalo-lock-client.sh`, which starts the probe
named in `$LOCK_LOG/client-mode` (`lock`, `none`, `hang`). Sleep itself cannot be had in a
container, so the guard is reached through the idle lock — the same `lock_session`; the sleep
side (`logind.rs`) is checked only on a real machine. Seen failing: with the guard's call removed
the check stops at step 1. Step 0 times the hold from the probe's own clock: a
client that draws 3 s late (`lock-slow`) hears `locked` at ~1000 ms, one that draws at once well
under 800 ms; before the hold, the late one heard it at 11 ms. Hyalo must be started with `HYALO_LOCK_RELAUNCH`
pointing at the check's probe, or its relaunch step fails.

## Idle: Hyalo does it, there is no hypridle (owner, 2026-10-02)

`idle.rs` + `[idle]` in the config (`screen_off`, `lock`, `suspend`: seconds without input, 0 =
never; Settings → Power writes them through `settings` — `CompositorSettings.readIdle/setIdle`,
whose Hyprland side is still hypridle's file). Nothing else has to be alive for the session to
lock.
- **Activity** = any input (`note_activity` from input.rs: devices, the control FIFO, the virtual
  pointer). It only moves a timestamp; ONE timer wakes at the next step's deadline, checks the
  time that really passed and is armed again. Don't re-arm a timer per motion.
- **Inhibitors** hold all steps off while they count: an `idle-inhibit` surface while it is
  SHOWN (a window in the `Space` or a mapped layer), and apps holding
  `org.freedesktop.ScreenSaver.Inhibit`. While the session is locked none counts.
- Steps are independent and fire once per idle stretch; the first input powers the screens back
  on, the lock stays. `ext-idle-notify-v1` is offered to other programs from the same state.
- **`logind.rs` runs only with `--session`**: a sleep *delay* inhibitor (`PrepareForSleep(true)`
  → lock, the inhibitor released once the lock is CONFIRMED; past 3 s without a request, the
  GUARD and then sleep — see "The lock screen" above), the session's
  `Lock` signal (`loginctl lock-session`) and the ScreenSaver service on the session bus — a
  development Hyalo must not take the live session's. Suspend from idle also only with
  `--session`: a nested Hyalo must never put the machine to sleep.
- ⚠️ Testing the ScreenSaver path: a client that EXITS drops its inhibition (its bus name goes),
  so `dbus-send`/`gdbus call` look like "inhibit does nothing". Hold the connection (a gjs script
  that sleeps). Do it nested with `dbus-run-session -- nidara-hyalo --winit --session` and
  `HYALO_CONFIG=/dev/null` (no autostart), never against the live session bus.
- IPC: `nidara-hyalo msg idle` (`idle_secs`, `inhibited`, the config). Tested by
  `scripts/ci/hyalo-idle-check.sh` in the smoke (`hyalo-idle-inhibit-probe.c` is the inhibitor).

## Input methods (text-input-v3 + input-method-v2)

`handlers.rs` (`InputMethodHandler`) + both managers in `state.rs`. fcitx5 is an
input-method-v2 client; GTK4 speaks text-input-v3 natively (still no `GTK_IM_MODULE`). Smithay
moves the text-input focus WITH the keyboard focus (`wayland/seat/keyboard.rs`), and in Hyalo every
keyboard focus change goes through `set_keyboard_focus` — so a layer surface that took the keyboard
through a focus grab (the shell's search) gets the input method too. On Hyprland it never did (its
grab path skipped the focus event the IME relay listens to: #679 #10, #503). The candidate window is
a popup of the surface being typed into (`parent_geometry`: a window's geometry, or a layer
surface's whole area), drawn with that surface's popups, **just below the caret**
(`place_input_popup`, after every rectangle change). ⚠️ Smithay's `set_text_input_rectangle` also
moves the popup to the rectangle's top-left — ONTO the caret, the one area input-method-v2 says not
to cover; until #832's real-fcitx5 probe measured it, Mozc's and Pinyin's candidate panes hid the
caret at every scale. Anything that sets the rectangle must call `place_input_popup` after it.
input-method-v2 reads every key: hidden from sandboxed clients.
- Verified nested with the real fcitx5 (private bus, throwaway config, `LANG=zh_CN.UTF-8`):
  Ctrl+Space, `nihao`, space → 你好 in a GTK window AND in the shell's search.
- CI: `scripts/ci/hyalo-ime-check.sh` with `hyalo-ime-probe.c`, a stand-in input method that
  commits a fixed string when a field activates (fcitx5's Chinese engine would be ~540 MiB in the
  container). Its XML is not in wayland-protocols: it comes from the wayland-protocols-misc crate.

### The screen reader's keyboard (`org.freedesktop.a11y.KeyboardMonitor`)

`a11y.rs`. On Wayland a screen reader cannot see keys, so Orca hears a text change "with no cause"
and stays silent (#835's real-Orca probe: zero key events, no speech while typing). libatspi
asks the compositor, over the interface Mutter defined: `WatchKeyboard` / `GrabKeyboard` /
`SetKeyGrabs`, and a `KeyEvent(released, state, keysym, unichar, keycode)` signal sent to that
caller alone. Hyalo owns `org.freedesktop.a11y.Manager` in a session (`--session`), or with
`HYALO_A11Y_MANAGER=1` for the headless checks; a development Hyalo never takes the live name.
- **Who may call** is the security boundary (a watcher sees every password): only the current
  owner of an allowed well-known name, `ALLOWED` = `org.gnome.Orca.KeyboardMonitor` — Mutter's
  exact rule. A refusal is logged. A caller that leaves the bus loses its watch and grabs at once
  (`NameOwnerChanged`), so a crashed reader cannot keep keys swallowed.
- **What is consumed** is Mutter's `notify_clients`, ported: keys run through `Monitor::key`
  BEFORE the bindings; a grabbed press and its release are consumed as a pair (by keycode — Shift
  may be released in between); the reader's modifier pressed twice within the repeat delay goes
  through as itself (Caps Lock still toggles); a consumed first press of it does not reach the
  keymap state either (`skip_xkb`: `keyboard.input` is not called at all).
- `KeyEvent` is written on the manager's D-Bus connection before the key is delivered to
  the Wayland client. Never put that write on a worker queue: the app's AT-SPI caret event
  can overtake it, and Orca then attributes Left to the previous printable key and stays
  silent (run 39281384872, #878's `collapse` control). The write waits for neither Orca's
  reply nor speech. `nk-orca-check.py` retains Orca's caret-cause diagnostics alongside
  each unchanged fresh-speech assertion; delays/retries cannot repair inverted causality.
  The checker sends each action once and awaits the fresh speech predicate (up to 8 seconds,
  with the existing 1-second absence interval), instead of clipping an utterance while Orca
  is still generating it on software GL. Before testing Escape it observes Orca announce the
  reopened dialog, so the opening focus event cannot arrive after the escape's restoration.
- Libatspi's capability bits do NOT prove this works — its legacy fallback reports monitoring with
  no key ever arriving. Count `KeyEvent`s.

### Menus: their grab, and where the keyboard goes when they close

`shell/mod.rs` `grab` and `popup_destroyed` (`popup_gave_keyboard_back`). A menu that closes on a
click outside (a GTK popover with autohide: the dock's, the tray's, an app's) asks for an
xdg_popup grab: the keyboard and the pointer until it is dismissed. Smithay's popup pointer grab
dismisses it on a press over ANOTHER client (or over nothing); a press on the same client is
passed through and GTK closes the popover itself.
- **An input method's grab gives way to a menu's.** fcitx5 holds the keyboard
  (`InputMethodKeyboardGrab`) for as long as a text field has the focus. `grab` refused a menu's
  grab whenever the keyboard was grabbed, so a dock menu opened while kitty had the focus stayed
  open with NO grab, and a click in another app no longer closed it (owner-caught 2026-10-02).
  Now that one grab is taken over; any other (a window being dragged) still refuses the menu.
- ⚠️ **Smithay unsets the keyboard's grab, WHATEVER it is, when an input method lets go of its
  own** (`InputMethodKeyboardUserData::destroyed`). Taking the keyboard from the field makes
  fcitx5 let go, which unsets the menu's grab and left the keyboard on the menu once it closed.
- **Closed, the last menu of a chain gives the keyboard back** to what it was opened from if
  that takes the keyboard (a window; a layer surface only with keyboard interactivity), else to
  the focused window. Smithay's grab hands it to the menu's ROOT, and the dock and the bar have
  no keyboard: what was typed after closing a dock menu went nowhere until the window was
  clicked (found while fixing the above, on Hyalo before and after the input method change).
  ⚠️ The menu's `PopupKeyboardGrab` IGNORES every focus change until it sees, on its own next
  event, that its menus are gone — so `popup_gave_keyboard_back` unsets it first. A submenu
  closing under a menu still open changes nothing: the grab moves the keyboard itself.
- `surface missing from known popups` (smithay, ERROR) on every menu close is noise: GTK commits
  the menu's surface once more after destroying its role. Nothing is wrong when it appears.
- CI: `scripts/ci/hyalo-popup-check.sh` (+ `hyalo-popup-probe.js`, a dock-shaped layer with a
  right-click menu, and `hyalo-ime-probe --hold`, a stand-in input method that grabs the
  keyboard like fcitx5). Each step was seen to fail on its own: the keyboard's return against the
  Hyalo before, the click in another app against a build with only the return fixed.
- **An application's menu, as the toolkit's dropdown opens it** (#882): an xdg_popup of a
  toplevel, NOT a layer — a layer is cut at the window's box (#899) and exists only on Hyalo,
  while a popup may leave the window and works on any compositor (D5). Hyalo already does all of
  it: `unconstrain_popup` honours the positioner's flip/slide on the output, `grab` takes the
  keyboard and dismisses on a click outside, and the popup's own material is drawn by the
  window's `push` (its popups go through `push_tree` → `push_material`: glass, shadow, the #889
  answer and ink coverage), not cut to the window. CI: `scripts/ci/hyalo-popup-glass-check.py` +
  `hyalo-popup-glass-probe.c` — a popup with no room under its window flips above its anchor and
  stays on the output, its white-washed glass shows past the window's edge and blurs the window
  under it, the keyboard enters it and a click outside sends `popup_done`; controls `--no-flip`,
  `--no-material`, `--no-grab`. It passed against the Hyalo installed when it was written
  (2026-10-21): it guards what the dropdown relies on, it fixed nothing.

## Night light: Hyalo's gamma ramps

`night_light.rs`. On Hyprland it was hyprsunset (a Hyprland protocol); on Hyalo the shell's
`NightLightSync.ts` (the schedule, the switch) asks `settings.setNightLight(kelvin | null)`, which is
the `night_light` IPC request (`nidara-hyalo msg night-light 3400` / `off`). Hyalo warms every
CRTC's legacy gamma ramps — on an atomic driver the kernel makes that the GAMMA_LUT property,
which Smithay's commits never touch, so it holds across frames — and READS THEM BACK: the request
answers an error unless the hardware holds them. A modeset, a VT switch or DPMS can reset them, so
they are applied again when an output comes on, when the session resumes and when an output wakes.
White point: Tanner Helland's blackbody fit (6500 K neutral; blue goes first, then green). A
screenshot never shows it: the ramps act after composition, in the display pipeline. Not
persisted: the shell sends it again when it starts.

**Switching on or off FADES; a temperature while on does not** (owner-caught 2026-10-03: the
switch was instant, where Hyprland's was gradual, and the slider changed nothing until the thumb
rested). The fade is Hyprland's own — `__internal_fadeCTM`, speed 5 = 500 ms, linear over the
RGB multipliers (`FADE`); a temperature arriving mid-fade keeps the fade's pace. The ramps are
moved by a tick (`TICK`, 16 ms) that exists only while they are changing, and every request
after the first of a burst only leaves its target: a gamma set is a BLOCKING commit (measured
2–8 ms on the RX 5700 XT at 144 Hz), so a slider's flood is coalesced, never queued. The first
request is still applied at once, so a refusal is still answered. Re-application after a modeset
uses what is SHOWN (`Fade::shown`), not the target. Shell side, both night-light sliders commit
live (`debounce: 0`; a trailing debounce fires only once the thumb rests) and `NightLightSync`
sends every temperature — the 300 ms wait is hyprsunset's, inside `hyprland-settings.ts`.

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
- The shell does not capture the screen (the adaptive glass that did, on Hyprland, went with #762):
  the backdrop is the compositor's to measure while drawing the glass (#684).
- CI: the Hyalo smoke parks a window of a known colour on a hidden workspace and requires the
  capture's centre to come back as that colour (`scripts/ci/hyalo-capture-probe.js`).

### The screen, the recorder and the clipboard (2026-10-02)

Until this date Hyalo captured windows only, and `grim` answered "compositor doesn't support
the screen capture protocol": the screenshot tile and Print put nothing on the clipboard
(owner-caught). Now:
- **Whole outputs** through the same `ext-image-copy-capture` with an OUTPUT source
  (`OutputCaptureSourceState`): drawn again offscreen like `msg screenshot`
  (`backend::capture_output`, shared), glass included, no cursor. grim uses it; `slurp` worked
  already (layer shell + pointer).
- **`zwlr_screencopy_v1`** (`protocols/screencopy.rs`, ours: Smithay has none) for `wf-recorder`,
  which speaks nothing else. `copy_with_damage` waits for the output's NEXT frame
  (`complete_screencopy` from post_repaint), so a still screen records nothing — never queue a
  redraw for it, or it records at full refresh. Two kinds of buffer: **shm** (a CPU read-back
  per frame) and **dmabuf** (`linux_dmabuf`, v3: the scene drawn straight into the client's
  buffer, `screenshot::draw_into`). 🔴 The dmabuf offer is NOT optional: wf-recorder with a
  GPU encoder (VA-API — the shell's default, Settings → "Hardware encoding") waits for it and,
  without it, never gets a frame — no file, and SIGINT ignored, so the Stop button did nothing
  (owner-caught 2026-10-03). The shell's second Stop now kills a recorder that did not answer
  the first (`stopRecording`), and a recording that left no file says so instead of "saved".
  ⚠️ ffmpeg's `vflip` does nothing to a VA-API frame (measured), so wf-recorder cannot turn a
  GPU recording upright on a flipped output: nested (`flipped-180`) it comes out upside down —
  wf-recorder's, not ours; the buffer is in the output's orientation like the shm one.
  The buffer is in the OUTPUT's orientation (`to_buffer`: flip, then rotate counter-clockwise),
  top row first, no `Y_INVERT` — the client turns it upright with the output's transform
  (wf-recorder: a `vflip`/`transpose` filter). ⚠️ Nested, the winit output is `flipped-180`: an
  upright buffer WITH `Y_INVERT` looked right there (two flips cancelling) and recorded upside
  down on a real output. Never settle an orientation on the nested output alone; CI's vkms is a
  Normal one (wf-recorder's source, `frame-writer.cpp`, is what settled it).
  🔴 **A REGION on the GPU is the whole output drawn, then the region blitted** (`draw_into`:
  an offscreen texture of the output, `Blit` into the client's dmabuf). Never draw the scene
  shifted (`RelocateRenderElement`): the windows' corner shader and the glass place
  themselves in OUTPUT pixels (`geo`, `clip`, `fb_to_out`), so a shifted scene cut every
  window away and a region recorded on the GPU was BLACK from #722 to 2026-10-04 — CI never
  saw it (vkms has no VA-API); a nested bisection did (#718's build recorded it, #722's did
  not). The shm path never had it: it draws the whole output and crops on the CPU.
  **The pointer** goes into a frame when the client asks (`overlay_cursor`; wf-recorder always
  does) and `[cursor] recorded` lets it (default on; the recording widget's "Show the pointer",
  `recording.showPointer`, `caps.recordedPointer` — Hyprland has no such switch). Its image is
  the backend's themed one (`backend::pointer_for`; winit keeps a `Cursors` too, only so a
  recording nested has one), and only on the output the pointer is on. `msg screenshot` never
  carries it; ext-image-copy-capture carries it when the session asks (`paint_cursors`, below).
- **data-control**, both (`ext-` and `zwlr-`): `wl-paste --watch` → cliphist, the clipboard
  history, autostarted in `config/hyalo/hyalo.toml` (two watchers, one per type — why is there).
- All four are privileged: hidden from sandboxed clients (the sandbox probe lists them), and
  every capture fails while the session is locked.
- CI: `scripts/ci/hyalo-screen-capture-check.sh` — whole output, a region UPRIGHT (a red-over-
  blue window), grim | wl-copy and back, `wl-paste --watch`, a recording with frames,
  upright, and the frame's dmabuf offer on the wire; where VA-API exists (locally, not CI's
  vkms) also a GPU recording that gets frames and stops on SIGINT; and the pointer in a
  recording, over the probe's red, gone with `[cursor] recorded = false` (HYALO_CONTROL moves
  it). Controls seen failing nested: #718's Hyalo (no pointer), one ignoring the setting (107
  pixels still under it), #722's and the installed one (the GPU region black). Pixels are read by GTK's PNG loader (`Gdk.Texture`), never GdkPixbuf: GdkPixbuf hands
  PNGs to glycin, whose sandbox does not start in CI's container.

### Sharing the screen (ext-image-copy-capture, #683, 2026-10-13)

A screen or a window shared in a call goes through the portal's ScreenCast →
`xdg-desktop-portal-wlr` (xdpw) → `ext-image-copy-capture` on Hyalo (xdpw prefers it over
screencopy). Same `capture.rs` as the thumbnails and grim, with three things those never needed:

- **A session's first frame is drawn at once; every later one WAITS** for something new — the
  output's next frame (`complete_capture_output`, post_repaint, beside `complete_screencopy`)
  or the window's next commit (`complete_capture_window`, `handlers.rs` commit). A thumbnail or
  a screenshot asks for one frame and closes, so they are unchanged. Until this date every frame
  was drawn on request: xdpw asks again as soon as it has a buffer, so a shared screen was drawn
  offscreen and read back on the CPU as fast as it could, still or not — ≈ 25–30 frames/s at
  1440p on the owner's machine, all of it on Hyalo's main loop. Measured nested since: a still
  screen sends 0 frames in 4 s.
- **dmabuf**: the session's constraints offer the primary GPU's render node and the
  XRGB/ARGB8888 modifiers our renderer draws into (`backend::capture_dmabuf`); a dmabuf frame is
  drawn straight into the client's buffer, upright (`screenshot::draw_upright_into`, a tracker
  with `Transform::Normal` — the same picture `capture` reads back; a window,
  `capture::draw_window_into`). shm stays for a client that does not take dmabuf. One size for
  both (the protocol has one `buffer_size` per session), so the dmabuf is UPRIGHT like the shm
  buffer, not in the output's orientation as screencopy's is.
- **A session follows its source**: a source that changed size (a resized window, a new mode
  or scale) gets the new constraints and its frame fails `buffer_constraints`, the protocol's
  way of saying "ask again with this size"; a window that closes or an output that goes stops
  its sessions (`stop_capture_window` from `window_destroyed`, `stop_capture_output` where tty
  unmaps an output), so the call ends the share instead of waiting forever. The SESSIONS are
  dropped first (that sends `stopped` and fails their frame "stopped"), their queued frames after.
- **The pointer** is drawn when the session asks (`paint_cursors` — the portal's "embedded"
  cursor mode), and only on the output it is on. Windows never carry it.

Testing it, nested and without installing anything (2026-10-13): download xdpw's package and
run its binary from a scratch directory (`-c <config>` with `chooser_type=simple`,
`chooser_cmd=echo Monitor: winit`, or `chooser_type=dmenu` and a command that picks a
`Window:` line), drive its `org.freedesktop.impl.portal.ScreenCast` directly
(CreateSession → SelectSources `types` 1 screen / 2 window → Start → the PipeWire node), and
pull frames with a PipeWire consumer. ⚠️ **gst-launch is the wrong consumer**: `pipewiresrc`
could not negotiate xdpw's dmabuf offer (with or without `DMA_DRM` caps, "No supported formats
found"), took shm sometimes and nothing at other times. A 150-line `pw_stream` consumer that
asks for BGRx as shm or as a LINEAR dmabuf (mmap-able) settled it; count `frame.ready()` in
xdpw's `WAYLAND_DEBUG` log for what Hyalo answered, not what the consumer kept (reading a
LINEAR dmabuf from VRAM with mmap is slow: 4 buffers kept of 170 answered). ⚠️ `pipewiresrc
target-object=` takes the node's `object.serial`, not its id (`path=` is the deprecated id).
Not in CI: CI's container has no PipeWire session.

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
- ⚠️ **A runtime action must not write `state.config` directly.** The next reload replaces
  `state.config` with the files' merge, so anything set only in memory is put back the moment
  Settings changes anything else. `set-cursor` did exactly that until 2026-10-02 (the shell's
  cursor theme reverted to `default` on a keyboard-layout change); it now goes through
  `apply_settings`. Runtime-only state lives outside `config` (`mode_overrides`, `cursor_hidden`).
- A reload Hyalo did itself updates `config_stamps`, so the file watcher does not reload the same
  write a second time a second later.
- **`HYALO_CONFIG` replaces the layers** (tests, CI), and then there is a settings layer only if
  `HYALO_SETTINGS` names one; `settings` is refused without it. The harnesses set both, so a
  nested test never writes the preview session's real `hyalo-settings.toml`.

## The shell on Hyalo

🔑 **No limit that exists for Hyprland constrains the desktop on Hyalo** (owner, 2026-10-07), and
since #762 (2026-10-13) the shell carries none of Hyprland's glass any more: the panels' glass
materializes from nothing ("Glass materializes" above), the dock's icons cast a shadow
(`DockIcon`), and the adaptive glass (`BackdropProbe`, the backdrop capture), the dock's painted
capsule (`SlicedCairoArea`), the vertical dock's layer round-trip (`forceReflow`), the fade floor
and the `NIDARA_MATERIAL=0` switch are gone, with the `backdropCapture` and `layerAlphaThreshold`
caps. What still paints glass in the client is glass Hyalo does not draw: a control on a pane
(`nested`) — and the GREETER, which still runs on Hyprland until #685 moves it, so the kit's
painters (`glass-capsule`, `glass-bubble`, `glass-paint`) keep their client glass for it (owner,
2026-10-13). `VisibleRegion` stays: on Hyalo it is where a surface draws (next section).

### Where a surface draws (`set_drawn_region`, #761)

The bar and the dock are layers the size of the monitor (every panel hangs from the bar; the dock
leaves room for a magnified icon) that paint a strip and whatever is open. Hyalo blended every
damage under them through their empty pixels: with a video under them, **9 % of Hyalo's GPU time
per frame** for the two (measured in the session, 2026-10-07: 1.436 → 1.305 ms a frame; the
numbers are in #761). The shell already knew what each paints — the `VisibleRegion` bookkeeping
written for Hyprland's blur (`tech-debt.md` §46) — so Hyalo takes that, not a new mechanism:

- `nidara-material-v1` → `set_drawn_region(wl_region | null)`, inside v1. Surface-local LOGICAL
  pixels like the rest of the protocol; double-buffered on commit; not cleared by `clear_shapes`.
  `libnidara-wl`'s `visible_region_*` sends it when the compositor offers the material protocol,
  converting the buffer pixels its callers pass back to logical ones, outward.
- Hyalo (`render/drawn.rs`) wraps each element of the surface's tree in `Clipped`: it draws, and
  reports damage, only inside the region — damage under the empty part repaints none of it. A
  second element, `DrawnChange`, draws nothing and damages where the region itself changed (what
  appeared or went), since a region lands on a commit that need not carry new pixels there. The
  glass is not affected (it is Hyalo's own), nor are popovers (their own surfaces). The glass's
  counter does not move with the region: a dock re-declaring it every frame of a hover does not
  redraw its glass for it.
- ⚠️ Same failure mode as on Hyprland: content outside the region is NOT DRAWN. The bar's producer
  walks every child of its overlay (`paintedRects`), so a panel added later is covered by
  construction; `NIDARA_VISIBLE_REGION=0` is still the escape hatch.
- Seen with `nidara-hyalo msg layers` → each layer's `drawn` (`[x, y, w, h]`, surface-local, the
  overlaps removed — a panel's rect minus the strip above it is what is listed). The smoke requires
  the bar and the dock to declare one, under half their surface at rest, and the bar's to grow with
  the Control Center open.

- **Over a fullscreen window, Super+B brings the bar AND the dock** (`toggleBarOverlay` in app.ts →
  the bar's `setBarOverlayMode` and the dock's `setOverFullscreen`: both join the OVERLAY layer,
  the dock revealed; the dock follows the bar's state, and leaving fullscreen ends it for both).
  On Hyprland only the bar came up: pointer input between two OVERLAY surfaces was unreliable
  there (#679 #15). Verified nested: a click on the dock's app-grid button over a fullscreen
  window opens the grid.

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
AppearanceSync) name no compositor. Each backend applies live AND
persists in its own layer: `core/hyprland-settings.ts` (the `nidara-*.lua` files, `hl.config`
evals, the baselines below) and `core/hyalo-settings.ts` (`settings` patches). Hyprland's
sensitivity and acceleration profile reach every pointing device; Hyalo has them per kind, so
both kinds get them. What Hyalo does not have yet is a no-op there and false in
`settings.caps`: its own animations and per-surface blur (#684), VRR "fullscreen only". `scripts/ci/compositor-boundary-check.mjs` has no allowlist any more: no
file outside the compositor modules may import a backend or spawn `hyprctl`.

Two things Hyalo had to learn for the shell, both Hyprland behaviour the shell relies on:
- **A layer surface that changes level goes to the TOP of its new level** (`layer_commit`).
  Layer-shell has no "raise", so leaving a level and coming back is how a surface gets above a
  sibling — the bar and the dock joining OVERLAY over a fullscreen window (Super+B), the bar
  lifted for the app grid. (The island used it to get above the bar until #708 point 3 made it
  a panel of the bar.) Smithay keeps surfaces in the order they were mapped, so Hyalo re-maps a
  surface whose level changed.
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
- **A client that stops reading is dropped without a word, so the buffer is a MiB** (#915). The
  server never blocks on a client: what its socket does not take waits in wayland-backend's
  buffer, 4 KiB by default, and past that the client is killed with `ConnectionClosed` — no
  `wl_display.error`, the client only sees Broken pipe on its next write. Each flush is one
  `sendmsg`, which the kernel charges far above its bytes, so ~420 pointer motions to a window
  busy for a few seconds were enough (the native Settings, 6 s on its own work). `CLIENT_BUFFER`
  (`state.rs`, 1 MiB through `set_default_max_buffer_size`, the `libwayland_1_23` feature, which
  on the Rust backend links nothing) holds ~37 000; a client that never reads is still dropped at
  that bound. Every disconnection is logged with the client's "pid (command)", read at connect
  time (`ClientState::identify`): a protocol error as WARN with its message, the rest as INFO —
  the backend gives its own exit and a full buffer the same reason. Gate:
  `scripts/ci/hyalo-stalled-client-check.sh` (1500 motions to a stalled probe; before the fix,
  DISCONNECTED at 426).
- **Every process Hyalo starts is waited for** (`spawn` in `main.rs`, a thread per child). Unwaited,
  each one stayed a zombie once it exited, and `nidara-lock` — which will not start while a process
  of its name exists (`pgrep -x`) — saw the first lock's zombie and refused every lock after it
  (owner-caught 2026-10-02). CI: the smoke spawns five and requires no zombie left.
- **Layer surfaces are placed by Hyprland's rule, not Smithay's** (`arrange_output` in
  `shell/layer.rs`): a surface that reserves room is placed against the WHOLE output and its room
  comes off the usable area; zone 0 goes in what is left; -1 ignores it all. Smithay's
  `LayerMap::arrange` places each reserving surface inside what the ones mapped BEFORE it left,
  and the bar and the dock both cover the monitor: mapped bar-first — as after an unlock, which
  shows them again in that order — the dock sat under the bar's 36 px and hung off the bottom of
  the screen (owner-caught 2026-10-02). Smithay keeps the location private, so Hyalo keeps its own:
  draw, hit-test and place popups with `layer::layer_geometry` and read the usable area with
  `layer::usable_zone`, never `LayerMap::layer_geometry`/`non_exclusive_zone`. ⚠️ Never call
  `LayerMap::arrange` besides it: Smithay still runs it inside `map_layer`/`unmap_layer` (a
  single configure each time, corrected right after), but called on every commit the two rules
  would answer each other's configures forever. The same rule keeps a SIDE dock from pushing
  the bar in or cutting it short by its 80 px, which Smithay's rule did when the dock was mapped
  first (the owner asked, 2026-10-02; Hyprland never did it). CI: the smoke has the shell hide and
  show its bar and dock as a lock does, and requires both back at the top of the output; and
  `scripts/ci/hyalo-layers-check.sh` (+ `hyalo-layers-probe.js`) maps a bar and a dock at the
  bottom, left and right, in both orders, and requires both over the whole output.
- **No overlay planes, on any driver** (`backend/tty.rs`, output setup): only the PRIMARY plane,
  for a fullscreen window's direct scan-out, and the cursor plane. The display hardware blends
  planes its own way — amdgpu in linear light — and a driver's TEST_ONLY commit only says whether
  it CAN show a plane, never whether it will look like our composition. Measured on the owner's
  amdgpu (2026-10-02): kitty at 50 % went visibly PALE on an overlay plane, and only while the bar
  and the dock were gone — their surfaces cover the whole output, so with them mapped kitty lay
  under our composition and could not have a plane — so the same window changed look under the
  user's eyes on every UI reload. NVIDIA's overlay planes also break scan-out (anvil), and planes
  passing between surfaces switched the scan-out feedback (below). Hyprland and Mutter use none
  for windows either. If they ever come back: opaque surfaces only and no underlays — an opaque
  pixel looks the same wherever it is blended, a translucent one does not.
  `[render] direct_scanout` (default on, read every frame) lets an opaque window covering the
  output go on the primary plane uncomposed — less latency for a game, and it looks the same;
  off is the switch for hardware that shows such a window wrong (Hyprland's
  `render:direct_scanout`, which Nidara never turned on there). 🔴 **A screenshot cannot see any
  of this**: `msg screenshot` and screencopy draw the scene again with GL, so they show what we
  would have drawn, not what the planes put on screen (both measured identical while the owner
  saw kitty change). Read the planes instead: `modetest -M amdgpu -p` lists each plane with its
  framebuffer — an `Overlay` plane must never hold one. CI cannot: vkms has no overlay planes.
- **The scan-out feedback is sticky** (`pick_feedback` in `backend/mod.rs`). Smithay's
  `select_dmabuf_feedback` follows the frame, and each switch is a new modifier set. Mesa's
  Wayland WSI answers that with `VK_SUBOPTIMAL_KHR`, and GTK rebuilds its swapchain on it, so the
  shell logs a `Gdk-WARNING … VK_SUBOPTIMAL_KHR` for each rebuild. It counted 55 in its first
  25 s on an amdgpu (2026-10-01), while the one free overlay plane passed between its
  monitor-sized layers (overlay planes are gone since 2026-10-02, above; the primary plane's
  scan-out still switches it). Once offered, the scan-out feedback stays. This is safe only while the
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

## Measuring the render (#766 A, B)

**An app's smoothness, not the compositor's** (toolkit/PHASE1.md gate 4): `msg frames ID` lists
when window ID's tree last brought new content — a commit with a new buffer on any surface of
it, subsurfaces and layers too — in CLOCK_MONOTONIC ms (Python's `time.monotonic() * 1000`),
the last 10 s (`Managed::frames`, `handlers.rs` `record_frame`, read before the buffer handler
takes the assignment). `scripts/dev/smoothness-probe.py` drives a scroll or a drag with
`nidara-input … [ms [legs]]` (the duration spreads the notches or the glide; legs repeat it,
each the way back of the one before, in ONE process, and print `LEG start end` in the
monotonic clock) and compares the **time-weighted** p95 of the gaps: the per-gap p95 does not
see a single freeze. ⚠️ Time-weighted means idle time scores as a freeze, so the input must
never leave the window without something to draw: a scroll straight down that hits the bottom
measured the page's length (703 ms in every run), 16 notches a second measured the pause
between notches (~55 ms), and one process per leg measured the process start (~42 ms seams).
Hence a notch every 16 ms going 8 down and 8 up for 2 s, and a guard that refuses a run where
3/4 of the legs one way stop drawing early (out of page or track) while a freeze, a few legs in
a row both ways, is scored. Accessibility extents of the legacy Settings are offset from the
window box `msg windows` gives (~+52, +43 px on 2026-10-25): take slider coordinates from a
screenshot, and check the value moved (a drag beside the slider still drew every 8 ms).

`render/stats.rs` instruments every frame, per output:

- **`nidara-hyalo msg stats`** — over the last second, per output: frames drawn, unchanged and
  repainted WHOLE (≥ 99 % of the output), the area repainted per frame, CPU time to build the
  elements and to render them, and what the glass did (`captures`, blur `passes`, `capture_px`,
  `draws`, `measures`); plus the GPU memory the glass's caches hold (`glass_texture_bytes`) and,
  for the whole process, **`gpu_time`**. Counts are taken where the work happens
  (`glass_gl::capture`, `draw`, `measure_ink`, every texture alloc/delete), so they are what ran,
  not an estimate.
- ⚠️ **The area repainted is NOT the new damage**: Smithay returns the frame's damage united with
  that of the last `age − 1` frames (the buffer it draws into last held an older frame). That is
  the cost, so it is what is counted — and why a video covering 89 % of the screen shows as
  frames repainted whole with triple buffering.
- **`gpu_time` = the kernel's per-client accounting**, `drm-engine-<name>: <ns>` in
  `/proc/self/fdinfo` of Hyalo's DRM files (amdgpu, i915, xe, msm… report it; llvmpipe does not:
  null): `ms_per_s`, `ms_per_frame` (every output's frames together), `engines`. It is the time
  the jobs RAN. 🔴 Until 2026-10-07 it was two GL timestamps around the render — a span on the GL
  timeline that holds the waits on clients' buffers and other contexts' work: it read ~10 ms a
  frame where the kernel said 1.4 (#761). Never put a span back as "GPU time". For an A/B outside
  Hyalo, `cat /proc/<pid>/fdinfo/*` gives the same number (one value per `drm-client-id`);
  `gpu_busy_percent` counts every client, Chrome's video included — useless for that.
- ⚠️ The nested Hyalo in the headless cage draws most frames whole (the host gives no buffer age:
  `frames_whole` says so) — **cost numbers are the session's, never the harness's**.
- **`presentation`** (per output, tty only; null in a window or at rest): for each frame the
  kernel timed on screen, `build_to_shown` (from the frame beginning to be built to its flip —
  what sampling the animations at the build would be behind by), `error` (the flip minus the
  predicted `when`, `avg_ms` signed, `max_ms` the largest either way) and `late` (frames shown a
  refresh or more after the predicted vblank). The prediction is right when `error` stays near 0
  while `build_to_shown` is most of a refresh.
- **`nidara-hyalo msg debug-overlay on|off`** (or `HYALO_DEBUG_OVERLAY=1`): each glass element's
  capture region outlined (cyan), a flash where one re-captured, the frame's damage outlined
  (magenta), fading over 400 ms. It is drawn with damage tracking like anything else, so it
  leaves out of what it shows (1) damage inside its own elements of this frame and the last and
  (2) frames drawn whole (and their re-captures) — or it would show its own redraws and never
  settle. One entry per rectangle (a region re-captured every frame flashes once). It shows in
  `msg screenshot` too. The smoke (`hyalo-smoke.sh`) requires a desktop at rest to draw no more
  frames with the overlay on than without it.

## Testing Hyalo

Test 5's control FIFO is read on a thread and dispatched later on calloop.
A completed write is not seat delivery; independent screenshot IPC can overtake
it. Send `barrier PATH` on the same FIFO and wait for its atomic acknowledgment
before sampling an action's effects. This observes delivery, never the expected
hit-test result. Keep capture/input timestamps and `delivery.jsonl` in artifacts;
do not replace this barrier with a pause or poll for the desired pixels. Each
layer-motion fault logs `LAYER_FAULT ... applied` at the omitted/altered operation,
and the driver requires that record as well as the original failing assertion.
The capture's `.capture.json` records the actual IME rectangle event source; wait
for that event in the IME's received log, then compare it with the pixels. A wrong
rectangle also opens this delivery barrier. The last record at an arbitrary read
may belong to an earlier or later frame. Encode PNG previews after the client
stops, keeping evidence preparation outside capture-to-input timing.

The toolkit's real fcitx5/Orca drivers run in the vkms smoke, or locally through
`scripts/dev/real-gates.sh orca|ime|choices-orca|phase0|<check>.py`: a rootless podman
container (`scripts/dev/real-gates/Containerfile`: Orca, speech-dispatcher, fcitx5 with Mozc,
Pinyin and Hangul, cage, `libao` null) runs the same cage harness on the repo's binaries —
nothing installed on the host, no vkms loaded (it would show up in the live session as a
monitor). The demo's checks (`nk-choices-*`) take the demo's harness, which serves the Settings
portal the demo reads its look from; the others phase 0's. `HYALO_BIN=` reuses a Hyalo built in
another worktree. Measured 2026-10-25: `choices-orca` with its six controls, 94 s, the same
speech and verdicts as CI's hyalo job. The image is ~3.4 GB (CJK fonts): extend it with
`podman build --from <the current tag>`, never after `podman image prune`, which drops the layer
cache and pulls everything again (it filled the disk once). The older path,
`toolkit/phase0/check-prerequisites.sh ime|orca` (private bwrap namespaces over packages
extracted to `NK_PREFLIGHT_SYSROOT`), still works. Their acceptance decisions, fault controls and evidence are recorded in
`toolkit/phase0/EVIDENCE-832-835.md`. Headless runs enable the keyboard manager
with `HYALO_A11Y_MANAGER=1`; ordinary Atspi.Device listeners are denied on
purpose, while Orca's key echo proves delivery. Never infer actual monitoring
from capability bits. Keep log paths short (speech Unix sockets), exclude the
caret from the adjacent candidate panel's pixel flood, and persist test output
scale in the private settings layer when also changing the keyboard: applying
keyboard settings reapplies configured outputs and resets a transient scale.

Orca's form walk also includes authentic flat review (#846): KP_Up (evdev 72) must
speak the complete `日本🙂 word`, separately from the earlier focus announcement;
KP_Subtract (74) leaves review before editing continues.

**KEY LATE** (nightly of 2026-10-24): Orca names a caret move's cause after the last key it has
seen, and the key (Hyalo → session bus) and the move (app → accessibility bus) are not ordered
with each other — Hyalo writes the key first (`a11y.rs`), yet Left once reached Orca 24 ms after
the move it caused, which Orca put down to the `d` typed before, and kept silent. A FAILED step
whose delta shows a caret move attributed `TextEventReason.TYPING` before the step's first
`KEYBOARD_EVENT` is `KEY LATE`: neither pass nor failure, never repeated; a control setup step
goes on past it, a control whose TARGET is late reports `KEY LATE` (exit 2) and leaves
`complete_matrix` false. Only that cause: a move left by the previous step (the dialog
reopened) is `UNKNOWN` to Orca and stays a failure — checked against all 24 failed rows of that
night's matrix, which marks exactly the one. Whether Hyalo should hold a key back for a
listening reader is #927. The shared vkms settings
check enables Num Lock: the Orca probe observes its real modifier with a harmless
Shift release before mapping the app, toggles Num_Lock only if needed, verifies it
is off, and restores the original state afterward. Keep `numlock-setup.log`; a
KP_8 event inserts text and is not flat review. The `text-extents` control
waits for wrong geometry to be **published**, not merely armed: require
`A11Y_FAULT_APPLIED text-extents` and Orca's `AXText: Range ... has rect` diagnostic
for the wrong response, then failure of the same speech assertion. Do not count
an unapplied mutation, infrastructure failure or previous utterance as evidence.

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
  (the package cannot go there) — with the glass token export, which Hyalo's own glass needs
  and only the package otherwise ships; it builds the checkout it is run from, so it warns
  when that checkout is behind main (2026-10-20: one from before #884 installed controls
  without their glass, and nothing said so) — and `measure-session.sh`, run once per session, gives the
  like-for-like numbers #681 asks for. Running Hyalo on the maintainer's own GPU is the owner's
  step: it needs sudo, and the first boot on new hardware is the one most likely to fail.
- CI's `hyalo` job (`scripts/ci/hyalo-smoke.sh`) runs clippy `-D warnings` and the unit tests,
  builds and installs THE PACKAGE (`phase_package`: makepkg -e in the checkout, pacman -U), then
  boots the tty backend on vkms with the installed shell on it. 🔴 Never add a hand-copied
  product file to the smoke: put it in the PKGBUILD, and the smoke gets it (a hand list here
  lacked the wallpapers, then the Settings portal — 2026-10-18). NOT a required check
  while Hyalo is a preview: it must never hold the merge queue for the desktop that ships.

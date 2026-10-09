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
| `hyalo/compositor/src/capture.rs` | window capture for the shell's thumbnails (ext-foreign-toplevel-list + ext-image-copy-capture) |
| `hyalo/compositor/src/sandbox.rs` | what a sandboxed (Flatpak) client is not offered |
| `hyalo/compositor/src/shell/` | windows and popups (xdg-shell, `mod.rs`), layer surfaces (`layer.rs`), who draws a title bar (`decoration.rs`) |
| `hyalo/compositor/src/protocols/window_controls.rs`, `render/controls.rs` | a window's controls, Hyalo's: the protocol, and the capsule drawn over the app's header |
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

`NIDARA_MATERIAL=0` turns the client half off (every painter back to its own glass);
`NIDARA_MATERIAL_DEBUG=1` logs every surface's shapes as they change. On a dev install,
`~/.config/nidara/glass-tuning.conf` (`key = value`: `alphaMin alphaMax target refraction lensing
rim saturation inkDarkAbove inkLightBelow tintLimit scrimMax scrimSize scrimFalloff`,
`blur`/`popoverBlur = SIZE:PASSES`, `glass = off` / `ink = off` / `scrim = off` for the A/B; the full list is `glass-material.ts`'s header) is re-read as it is saved
— it is how the numbers are tuned with the owner on screen.
A blur's `SIZE:PASSES` means the SAME blur on Hyalo as on Hyprland — the numbers are shared
(`GLASS_BLUR`, the material selector). Hyalo's dual kawase is Hyprland's: the down-sample's taps
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
never past `BEVEL_MAX` (80 px): beyond it a pane is flat glass inside, frosted, and only its
edge bends — as in the reference material, where a large pane frosts more, not bends across.
The profile and strength are the owner's from the glass lab (2026-10-05, preset "OK 2", #705):
the quarter circle's height to the 5th power (the bend gathers at the edge) and three times
Snell's displacement, no colour dispersion; the capture region is the blur's reach alone. ⚠️ Two things that look like knobs and are not: thicker than 1.5 W the far side of
the peak displaces faster than 1 px per px and the backdrop folds back mirrored, and 1.5 W
already magnified the dock's icons under the app grid's edge four times their height (measured
nested, 2026-10-02 — W thick is the one kept). Until that day the edge read from OUTSIDE,
(1 − t)² × refraction over a band the corner radius wide: once `lensing` grew to 0.15 the app
grid read 125 px out within 32, and a window under it showed whole, shrunk, wallpaper round it
(owner-caught: "an inverted magnifier"). Compare numbers on the bevel in the harness, never on
the live session: `HYALO_GLASS_TUNING=<file>` gives the sandboxed shell its own
`glass-tuning.conf` (`hyalo/scripts/sandboxed-shell.sh`), over a grid as `HYALO_WALLPAPER`.
⚠️ `target` is a WCAG relative luminance — LINEAR light, the adaptive glass's own number (primary
text at 4.5:1 → 0.183), and `alphaMax` is its ceiling (`GLASS_ADAPT_CEILING`). The shader mixes
the tint into the ENCODED colour, so it searches for the least alpha that meets it (8 bisection
steps) rather than solving in encoded luma: compared against encoded luma, a white backdrop came
out at 10:1 under a near-black glass where 4.5:1 was asked (owner-caught 2026-10-01). `nidara-hyalo msg layers` shows what each
layer declared (`glass.shapes`, `glass.compositor_paints`), and the smoke requires the bar, the
dock and the island to declare theirs.

### Glass materializes, it never fades (#764, owner 2026-10-07)

Glass has no opacity. The per-shape number the protocol calls `opacity` is, in Hyalo, **how formed
the glass is** (0..1), and it scales the MATERIAL, not the coverage: the blur's reach, the bevel's
bend, the saturation, the tint (after the legibility bisection), the rim and the shadow under it
(`scrim.rs` already took its shapes' most). Coverage is the silhouette's antialiasing and the clip
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
  every size (our bevel cap is 80), and at rest it shows no rim of light, no shadow, and a dark
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
    their legibility is the tint and the shadow under the glass. Declared in `Bar.tsx`.
  - **The dock: the system mode.** `trackNoInk` + `trackModeGlass` on its layout, and
    `skinFromMode` on its adaptive-glass surface (`AdaptiveGlass.ts` → `skinOf`): its dots and
    marks are light in dark mode and dark in light mode, and its glass on Hyalo turns to the light
    one in light mode — `glassFollowsMode(native)` makes the material send a white veil, even
    (`modeLightVeil`, 0.2: the reference's regular light glass is filled with white at 0.2) and
    never thickened for white text (`target` 1). Off Hyalo, the light skin's tint does it.
  - **The bar's surface — capsules, island, its menus and Prism: the system MODE** (owner,
    2026-10-09: by the backdrop each capsule turned on its own, and over a wallpaper bright on
    one side only that end had dark text). `trackModeInk(barBox)` (kit `material.ts`): the
    material sends that surface ink thresholds no backdrop can miss — light mode −1/−2 (dark at
    once, never back), dark mode 2/1.5 — so its panes lie on the ink's light veil with dark
    content in light mode, and on the dark glass with light content in dark mode. CC, NC and the
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
- **The glass follows.** A shape holding a dark group is not darkened for white content: it gets
  the light veil (`set_ink`'s tint at `alpha_min`).
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

### The shadow under the glass: what the glass is missing, within its limit (#684)

Owner, 2026-10-02: "parts almost entirely grey and parts right, on the same element". The tint
thickens PER PIXEL, so a pane over a backdrop bright in one place and dark in another came out
grey in one part and clear in the other — on the owner's own wallpaper (light blue over dark
purple) the CC's camera and volume tiles went grey while Focus stayed clear. The fix is the
owner's idea: a soft black shadow UNDER the glass, even across the pane, only when needed.

- **The protocol** (`set_scrim(max_strength, size_fraction, tint_limit, region_edge)`,
  `add_scrim_region(x, y, w, h, falloff)`). A region is shared by every shape whose centre lies
  in it; a shape in none gets its own (its outline as core, fading over `size_fraction` of its
  shorter side, even across it). A region's shadow is whole at its CENTRE and sweeps out to
  `region_edge` of that at its rim — a superellipse norm (exponent 4) of the offset from the
  centre over the half-size, so the sweep follows the container's shape, sides and ends alike —
  then fades over its falloff (`render/scrim.rs`, unit-tested). `region_edge` 1: even.
- **The rule** (`material::scrim_target`, unit-tested with a control). Owner, 2026-10-02: "the
  limit has to be in the glass". The glass takes no more tint than `tint_limit` (0.25) — past it
  a pane reads as painted grey — and the shadow is EXACTLY what the glass is missing for the
  brightest point under the unit's light-ink shapes to reach `target`: ≈0.41 over white, 0.15
  over a light backdrop (0.45), none where the glass reaches it alone. It grows and shrinks
  with the backdrop: no threshold, no hysteresis. While there is a shadow the shell sends the
  limit AS the glass's `alpha_max` (`glass-material.ts`): nothing tints past it, not even for
  legibility — a ceiling above it "makes the grey plastic again" (owner). Past `max_strength`
  the text is less legible, not the glass greyer. The bar and the dock, which cast none for
  now, are held to the same ceiling. A shape whose content has turned
  dark (an ink box of a dark group inside it) asks for none: it lies on the ink's light veil.
  Two rules came before and went the same day: "bring the brightest point to `target`" (the
  tint idle, the shadow doing everything), then "the least that evens the pane out", gated by
  a spread between the darkest and brightest point's tints (`min_spread`) — a threshold nobody
  could explain, and a glass still allowed to turn grey up to `alpha_max`.
- **Measured with the ink**, in the same pass: one probe per shadowed shape (its body, inset by
  0.29 of its radius), darkest and brightest in one texel. 🔴 The probe DIVIDES OUT the shadow
  drawn this frame (`unscale` = 1 / (1 − its opacity there)), or the shadow would measure itself
  and chase its own tail. 🔴 On the chrome it divides out the WHOLE floor, every chrome
  surface's shadows — not only its own. Dividing out only its own, the Control Center's strip
  (which reaches the bottom of the screen) darkened the right of the dock's backdrop, split it,
  and switched the dock's band on; its hysteresis then held it on after the CC closed — and
  the CC's strip did the same to the bar's right-hand capsule (owner, 2026-10-02: "the dock's
  shadow only comes on when the CC opens"; measured: dock 0.462, bar 0.344, both 0 after a
  reload). The ink boxes are NOT unscaled: their question is what the text sits on.
- **Drawn** by `render/scrim.rs`: one pass, shadows combined by their MAXIMUM (two panes side
  by side never make a darker band between them), smootherstep fade, half-level dither against
  banding. 🔴 The shell's chrome (top and overlay layers) casts its shadows onto ONE FLOOR under
  all of it, right above the windows (`render/mod.rs`, `chrome_scrims`): the bar and the dock
  are both TOP, and a shadow placed right under the bar darkened the dock's icons. One element
  for the whole floor (its memo on the output), so two surfaces' shadows that overlap — the
  CC's strip and the dock's band — combine by their maximum too, never darkening the corner
  twice. A window's glass keeps one element per surface.
- **Eases** in 220 ms, out 600 ms (a video under a pane must not pump it); while one eases the
  backend queues the next frame (`scrim::take_easing`), and at rest nothing is redrawn.
- **Who casts what.** A pane in no region gets a halo, its outline fading outward over
  `scrimSize` of its shorter side — the app grid, the overview (the owner likes the overview's:
  "a shadow downward separating the top from the bottom").
  - **The Control Center and the Notification Center share ONE region** (`trackScrimRegion(widget)`
    in Bar.tsx): their CONTAINER, EVEN across it (`scrimEdge` 1 — the shadow is what the glass
    lacks at the brightest point, so a sweep leaves the edge tiles short of it; 0.7 did not read
    on screen either, owner 2026-10-02: settled, no more tuning rounds), then fading to nothing over `scrimFalloff` (160) px — 48 read as a step ("there must be no jump between the shadow and the backdrop", owner). Tuned live. How it got
    there, all on 2026-10-02: first the screen's whole right-hand strip, down to the bottom,
    shading wallpaper far below a short panel — the owner, from a reference video: "the shadow
    occupies only the CC's area"; then the panel's block, even: "it looks like a translucent
    dark panel with a gradient at its border"; an ELLIPSE darkest at the centre was written and
    thrown away unseen — "I did not say an ellipse … very subtle, very slightly darker at the
    centre, sweeping from the centre, over the container's area"; the sweep then went back to
    even, above. The region
    no longer reaches past the screen's edges: its centre has to be the panel's. Its core ends
    at its GLASS's edges plus what
    that glass refracts (`placeScrimRegions`), not at the widget's box, which holds margins:
    "the fade should start right where the CC ends" (owner; it was 32 px of margin and 380 of
    fade — 800 px of shadow for a 368 px panel). Measured nested without it: each tile got its own
    strength (0, 0.31, 0.37, 0.43…) — blotches, exactly what the owner predicted.
  - **The bar and the dock cast NONE** (`trackNoScrim`: a region with a negative falloff,
    which claims its panes and casts nothing). Tried and dropped on 2026-10-02: a halo per
    capsule, then a band hugging each (`fade: "strip"`). Measured on screen: the bar's band
    covered 0–48 px and fell to nothing in ~10 px, the dock's 16 px above it and ~35 px of
    fade — over the title bar and the bottom of a window that starts 4 px under the bar's
    exclusive zone. A shadow ABOVE the windows cannot fade gently there without darkening
    them, and two surfaces' bands made a crease where they met (the CC's and the bar's).
    ▶️ The owner's direction: an EDGE shadow drawn by Hyalo itself — it already knows which
    edge each layer sits on and what it reserves — UNDER the windows (only the wallpaper gets
    it, so it can fade long), each edge at its own strength, no stacking where two meet.
  - 🔴 A shape joins the FIRST region its centre lies in, in declaration order: the bar's
    no-shadow region is declared before the CC's strip, which reaches past the top and would
    otherwise take the bar's right-hand capsules.
- Tuned live in `glass-tuning.conf`: `tintLimit scrimMax scrimSize scrimFalloff`,
  `scrim = off` for the A/B. `nidara-hyalo msg layers` shows each surface's `glass.scrims` (kind, shapes,
  strength); the smoke requires the CC's panes to share one region and no bar or dock pane to
  cast a shadow of its own.
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
  tint). No tint of its own: a window's translucent background is its tint. Settings →
  Appearance → Windows switches it (`appearance.windowBlur` → `[windows.backdrop] enabled` in the
  settings layer); a rule's `backdrop = false` takes it from one app. The entry is `available`
  only where `caps.windowBackdrop` (Hyalo): Hyprland's blur is one for windows and layers, and a
  switch there would do nothing — `available: false` hides the row, `describeConfig` and
  `setConfig` (ConfigRegistry).
- What the IPC says: `nidara-hyalo msg windows` → each window's `look` (`rounded`, `backdrop`).
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
(`window_controls::BUTTON_W/H`). **That size is a header button's** (owner, 2026-10-04): the
capsule is a group of header buttons, as a toolbar group is on macOS 26, so it is as tall as
its neighbours — 32 high. It was 24, to keep Hyalo's title bar thin; next to 32 px header
buttons it read as a different part. Hyalo's title bar grew with it (below). **Each button's
hover is a 24 px circle, 4 from the capsule's edge and 4 from the next** (owner, 2026-10-06 —
the bar's rule, design-system.md → "Capsules of icon buttons"): a button takes 28
(`window_controls::PITCH`) and the capsule `28 × n + 4` — 32, 60, 88 — so the two-button capsule
IS the kit's back/forward pair, 60×32, which follows the same rule. Until then a button was a
30 px slot whose hover FILLED it, cut by the capsule: straight on one side, or on both for the
middle one. The shader repeats `HOVER_D`/`EDGE`/`PITCH`, and the hover and press alphas are the
kit's `GLASS_STATE_MIX` (one hover across the desktop). A press between two circles goes to the
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
So by default a resizable window has minimize, maximize and close (88×32), a fixed-size window
minimize and close (60×32), a dialog maximize and close or close alone, About close alone (32×32).

- **The protocol is ours**, `protocols/nidara-window-controls-v1.xml`, both ends in this repo
  (server `protocols/window_controls.rs`, client `lib/nidara-wl`): `get_window_controls(wl_surface)`
  on a toplevel's surface; the compositor sends `layout(side, width, height)` — the box to reserve
  (28 px a button shown and 4 more, 32 high) and the side — at once and again whenever it CHANGES
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
  4 px scale** (owner, 2026-10-04; the header was 50, from a layout long gone): header row 48, 8
  below the window's top; its buttons 32, 8 from the row's edges, and the capsule with them, so
  **16 from both edges of its corner, on either side** — header `padding-right: 16`, the sidebar
  row's left margin, `leftSlot.margin_start` when the sidebar is not docked, About's controls
  row; the divider 64 from the top. ⚠️ A slot's margin is a WIDGET margin: a CSS margin is taken
  out of the size the slot requests, and the capsule drawn in it overlapped the toggle — so a window built on it gets the
  controls by passing its close button as `header.end`, as before. About, which has no header,
  places its own two slots beside its close button. `NIDARA_WINDOW_CONTROLS=0` turns it off.
- `nidara-hyalo msg windows` → each window's `controls`: `[x, y, w, h]`, global logical, or null.
- CI: `scripts/ci/hyalo-window-controls-check.sh` (C probe `hyalo-window-controls-probe.c`,
  leaving room as the kit does): the layout told (88×32), the controls where the app placed them,
  the pointer the app's over its body and not over its controls, maximize and restore, the side
  switched live and followed; close alone from the user's buttons and from the app's
  `set_buttons` (SIGUSR1), minimize and close while it cannot change size even asking for all
  (SIGUSR2; SIGHUP undoes it); a rule's `controls = ["close"]` on a new window of the app; close
  asks the window to close; the ink (SIGWINCH → `set_ink`): over the probe's 0x404040 window the
  brightest pixel of the controls is above 150 with light ink and at most 70 with dark, read
  from a raw PPM with od. Controls, each seen failing nested: a Hyalo without the protocol
  prints NO_CONTROLS; the one before #724 (no minimize) tells 60 at once; one that ignores
  `set_buttons` still tells 88. Minimizing itself: "Minimizing" above.

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
  place — the drawing checked by pixels a second into a 6 s animation (the probe's grey where
  `drawn` says, not where it was, and beside the small window what is there once it has gone).
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
- **Its place**: on top of the client's box, INSIDE the window's — `Managed::bar()` (48, 0 in
  fullscreen), `frame()` = the box with the bar. 48 = the capsule's 32 and the same 8 px above,
  below and beside it (`window_controls::BAR_MARGIN`; owner 2026-10-03: equal gaps). Owner,
  2026-10-04: the kit's header row, 48 with its 32 px buttons 8 from its edges — the same row in
  every window. Not the same total: a kit window's header starts 8 below the window's edge (its
  floating sidebar card's margin), Hyalo's bar at the edge, so the capsule is 16/16 from the
  corner in ours and 8/8 in the bar — centred in its row in both, as macOS centres its window
  buttons in whatever bar they are in. It was 32 with a 24 px capsule. A tiled or maximized window's tile is the frame
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
- **The lock surface needs its frame callbacks** (`post_repaint`). Without them GTK's frame clock
  never ticks there and everything the lock fades in (the clock, the card) stays at its first
  frame: invisible. Found nested, 2026-10-02.
- IPC: `nidara-hyalo msg lock` (`locked`, the outputs with a lock surface); event `lock_changed`.

Tested by `scripts/ci/hyalo-lock-check.sh` in the Hyalo smoke (seven steps, the control last: after
the unlock the window behind gets the keys). Step 0 times the hold from the probe's own clock: a
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
  → lock, the inhibitor released once the lock is CONFIRMED, or after 3 s), the session's
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
surface's whole area), drawn with that surface's popups. input-method-v2 reads every key: hidden
from sandboxed clients.
- Verified nested with the real fcitx5 (private bus, throwaway config, `LANG=zh_CN.UTF-8`):
  Ctrl+Space, `nihao`, space → 你好 in a GTK window AND in the shell's search.
- CI: `scripts/ci/hyalo-ime-check.sh` with `hyalo-ime-probe.c`, a stand-in input method that
  commits a fixed string when a field activates (fcitx5's Chinese engine would be ~540 MiB in the
  container). Its XML is not in wayland-protocols: it comes from the wayland-protocols-misc crate.

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
- The shell does NOT capture the screen on Hyalo (`caps.backdropCapture` false): the adaptive
  glass's backdrop is the compositor's to measure while drawing the glass (#684).
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
  recording nested has one), and only on the output the pointer is on. Screenshots
  (ext-image-copy-capture, `msg screenshot`) still never carry it.
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

🔑 **No limit that exists for Hyprland constrains the desktop on Hyalo** (owner, 2026-10-07). Where
the shell still holds one back for Hyprland's sake, it asks a `caps` flag and Hyalo answers false
— `layerAlphaThreshold` (Hyprland's `ignore_alpha`): the panels' glass materializes from nothing
instead of fading from a floor ("Glass materializes" above) and the dock's icons cast a shadow
(`DockIcon`). What is left of Hyprland's glass in the client — the painted body, rim and shadow,
`BackdropProbe`, `SlicedCairoArea` — goes with the switch (#685, listed in #762, which also holds
the sweep of what still runs on Hyalo). `VisibleRegion` stays: on Hyalo it is where a surface draws
(next section).

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
GlassBlur, AdaptiveGlass, AppearanceSync) name no compositor. Each backend applies live AND
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

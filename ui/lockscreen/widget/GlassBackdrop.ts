import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"

// Backdrop blur for the lockscreen's glass elements (password field, power bar).
//
// WHY WE BLUR IT OURSELVES — do NOT "fix" this by reaching for a layer_rule
// (verified against Hyprland 0.56 sources and measured in a VM, 2026-08-09):
// under ext-session-lock-v1 the compositor draws NOTHING behind the lock
// surface, so compositor blur has no content to work on and cannot reach us.
//   - `renderAllClientsForWorkspace` returns before drawing ANY layer once the
//     lock client confirms, and `renderSessionLockPrimer` then paints opaque
//     black over everything already drawn — wallpaper layer included.
//   - `misc:session_lock_blur` does exist, but the renderer gates it:
//     `renderdata.blur = PSESSIONLOCKBLUR && PSESSIONLOCKXRAY`. And xray brings
//     the entire desktop back with it (your windows, not just the wallpaper)
//     and disables the black primer.
//   - Moving the UI onto an `above_lock = 2` layer renders fine and takes the
//     pointer, but `CFocusState::rawSurfaceFocus` refuses keyboard focus to any
//     surface that is not the lock surface. Measured, not deduced: the layer
//     logged zero keys while locked while hyprlock received every one of them.
//     A password field up there is dead.
// hyprlock, swaylock and gtklock all blur their own copy for exactly this
// reason; the lock surface is the one place a compositor cannot help.
//
// The pipeline mirrors the compositor's so the glass MATCHES the rest of the
// desktop rather than merely resembling it: gaussian (`blur { size, passes }`)
// followed by the colour trim (`contrast`, `brightness`, `vibrancy`) as a
// colour matrix. Hyprland's `noise 0.01` is dropped — invisible at that
// amplitude and it would cost a tiled texture.
//
// The blurred image is rendered ONCE into a texture and reused. Blurring inside
// the snapshot would re-blur the whole wallpaper on every clock tick, for a
// backdrop that never changes.

// Kept in lockstep with `blur { … }` in config/hypr/hyprland.lua.
const BLUR_SIZE = 2
const BLUR_PASSES = 2
const CONTRAST = 1.2
const BRIGHTNESS = 0.8
const VIBRANCY = 0.4

// GSK takes a single gaussian radius; Hyprland runs dual-Kawase, where every
// pass HALVES the resolution — so its reach grows with 2^passes, not √passes.
// Kawase sigma ≈ size · 2^passes, and GSK's radius is ≈ 2σ, giving 16 px for
// our `size 2, passes 2`.
//
// This is an approximation between two different algorithms, not an identity:
// if the lock's glass ever reads heavier or lighter than the bar's, THIS is the
// single number to trim, by eye, side by side.
const BLUR_RADIUS = BLUR_SIZE * Math.pow(2, BLUR_PASSES) * 2

// The capsule is painted here, not by CSS. A CSS `border-radius` of half the
// height makes GTK's border seam at the middle of each cap (see
// design-system.md), and dodging it with a smaller radius leaves a visible
// straight segment. Drawing fill and rim on ONE rounded path removes the whole
// class of problem — the same reason the shell paints its glass in Cairo
// (common/GlassBubble.ts) instead of using CSS boxes.
//
// LOCKSTEP: these mirror --nidara-glass / --nidara-glass-border(-sm) in
// ui/greeter/style.scss. The lock has no theme engine (fixed dark palette,
// accent only reaches the focus ring, which stays in CSS), so they are literals
// here. If the tokens change, change these.
const GLASS_FILL = { r: 18 / 255, g: 18 / 255, b: 28 / 255, a: 0.55 }
const RIM_STRONG = { r: 1, g: 1, b: 1, a: 0.22 }
const RIM_SUBTLE = { r: 1, g: 1, b: 1, a: 0.14 }

// Focus. The CSS used to draw TWO things on focus: a soft outer ring
// (box-shadow, still CSS — it lives outside the capsule) and a solid accent
// EDGE (border-color). The edge is what made focus read as bright; now that we
// own the rim, we own that half of the state too, or the ring looks dim and
// sunken with nothing crisp to sit against.
let accentRim = { r: 0, g: 136 / 255, b: 1, a: 1 } // --nidara-accent default (blue)

/** Follow the user's accent, resolved the same way app.ts resolves it. */
export function setAccentRim(hex: string | null | undefined) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return
  accentRim = {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
    a: 1,
  }
}

export type RimWeight = "strong" | "subtle"

const RIM_W = 1

const rgba = (c: { r: number; g: number; b: number; a: number }) =>
  new Gdk.RGBA({ red: c.r, green: c.g, blue: c.b, alpha: c.a })

let sourcePath: string | null = null
let cache: { texture: Gdk.Texture; w: number; h: number } | null = null

/** The image the glass shows through. Set before any glass widget is drawn. */
export function setBackdropSource(path: string | null) {
  sourcePath = path
  cache = null
}

// Both of these are plain structs with init-style constructors — the shape that
// has broken across GJS releases before (see common/WindowThumbnail.ts). Built
// ONCE here, outside any snapshot: degrading to a plain blur, or to square
// corners, beats throwing mid-frame with an unbalanced push/pop.

// Luminance-preserving saturation, with brightness and contrast folded into the
// same matrix: out = (in - 0.5) · contrast · brightness + 0.5 · brightness.
const COLOUR_TRIM = (() => {
  try {
    const s = 1 + VIBRANCY
    const lr = 0.2126, lg = 0.7152, lb = 0.0722
    const k = CONTRAST * BRIGHTNESS

    // Column-major, as Graphene expects.
    const m = [
      (lr + (1 - lr) * s) * k, lr * (1 - s) * k, lr * (1 - s) * k, 0,
      lg * (1 - s) * k, (lg + (1 - lg) * s) * k, lg * (1 - s) * k, 0,
      lb * (1 - s) * k, lb * (1 - s) * k, (lb + (1 - lb) * s) * k, 0,
      0, 0, 0, 1,
    ]
    const off = 0.5 * BRIGHTNESS - 0.5 * CONTRAST * BRIGHTNESS

    const matrix = Graphene.Matrix.alloc()
    matrix.init_from_float(m)
    const offset = Graphene.Vec4.alloc()
    offset.init(off, off, off, 0)
    return { matrix, offset }
  } catch (e) {
    console.warn(`[GlassBackdrop] no colour matrix, blur only: ${e}`)
    return null
  }
})()

const ROUNDED_CLIP_OK = (() => {
  try {
    const probe = new Gsk.RoundedRect()
    const rect = new Graphene.Rect()
    rect.init(0, 0, 1, 1)
    probe.init_from_rect(rect, 1)
    return true
  } catch (e) {
    console.warn(`[GlassBackdrop] no rounded clip available: ${e}`)
    return false
  }
})()

/** Render the wallpaper blurred + trimmed into a texture, once per window size. */
function backdropTexture(widget: Gtk.Widget, w: number, h: number): Gdk.Texture | null {
  if (!sourcePath || w < 1 || h < 1) return null
  if (cache && cache.w === w && cache.h === h) return cache.texture

  const renderer = widget.get_native()?.get_renderer()
  if (!renderer) return null

  let src: Gdk.Texture
  try {
    src = Gdk.Texture.new_from_filename(sourcePath)
  } catch (e) {
    console.error("[GlassBackdrop] cannot load wallpaper:", e)
    return null
  }

  // COVER fit (same as the Gtk.Picture behind us), then overscan by the blur
  // radius: without it the gaussian samples past the image and fades the screen
  // edges into transparency.
  const scale = Math.max(w / src.get_width(), h / src.get_height())
  const dw = src.get_width() * scale
  const dh = src.get_height() * scale
  const pad = BLUR_RADIUS * 2

  const rect = new Graphene.Rect()
  rect.init((w - dw) / 2 - pad, (h - dh) / 2 - pad, dw + pad * 2, dh + pad * 2)

  const viewport = new Graphene.Rect()
  viewport.init(0, 0, w, h)

  try {
    const snapshot = new Gtk.Snapshot()
    if (COLOUR_TRIM) snapshot.push_color_matrix(COLOUR_TRIM.matrix, COLOUR_TRIM.offset)
    snapshot.push_blur(BLUR_RADIUS)
    snapshot.append_texture(src, rect)
    snapshot.pop()
    if (COLOUR_TRIM) snapshot.pop()

    const node = snapshot.to_node()
    if (!node) return null

    const texture = renderer.render_texture(node, viewport)
    cache = { texture, w, h }
    return texture
  } catch (e) {
    console.error("[GlassBackdrop] backdrop render failed:", e)
    return null
  }
}

// Declaration merging: the ambient `ags/gtk4` typing exposes Gtk as `any` in
// value position but as the real @girs namespace in type position, so tsc can't
// see that this class extends Gtk.Widget (same trick as common/ScaleRevealer).
export interface GlassBackdrop extends Gtk.Widget {}

/**
 * Single-child container that paints the blurred wallpaper behind its child,
 * clipped to the child's pill shape and sampled in WINDOW coordinates — what
 * shows through is the piece of wallpaper actually behind it, registered with
 * the sharp copy around it, not a floating crop.
 */
export class GlassBackdrop extends Gtk.Widget {
  static {
    GObject.registerClass({ GTypeName: "NidaraGlassBackdrop" }, this)
  }

  child: Gtk.Widget
  rim: RimWeight
  followFocus: boolean

  constructor(child: Gtk.Widget, rim: RimWeight = "subtle", followFocus = false) {
    super()
    this.child = child
    this.rim = rim
    // Only for capsules that ARE the focusable control. A CONTAINER (the power
    // bar) reports FOCUS_WITHIN whenever any of its buttons has focus, so
    // following it there paints the whole bar accent — which reads as "the bar
    // is focused" when what is focused is one button inside it.
    this.followFocus = followFocus
    child.set_parent(this)

    if (followFocus) child.connect("state-flags-changed", () => this.queue_draw())
  }

  hasFocus(): boolean {
    if (!this.followFocus) return false
    // FOCUS_WITHIN as well as FOCUSED: in a GTK4 composite entry the focus
    // lands on the inner `text` node, so the outer widget is never :focus.
    const flags = this.child.get_state_flags()
    return (flags & Gtk.StateFlags.FOCUS_WITHIN) !== 0 || (flags & Gtk.StateFlags.FOCUSED) !== 0
  }

  vfunc_measure(orientation: Gtk.Orientation, for_size: number): [number, number, number, number] {
    const [min, nat] = this.child.measure(orientation, for_size)
    return [min, nat, -1, -1]
  }

  vfunc_size_allocate(width: number, height: number, baseline: number) {
    this.child.allocate(width, height, baseline, null)
  }

  vfunc_snapshot(snapshot: Gtk.Snapshot) {
    const w = this.get_width()
    const h = this.get_height()
    const root = this.get_root() as unknown as Gtk.Widget | null

    if (ROUNDED_CLIP_OK && root && w > 0 && h > 0) {
      const [ok, bounds] = this.compute_bounds(root)
      // Everything that can throw happens BEFORE the first push, so a failure
      // costs the capsule, never a half-pushed snapshot.
      const texture = ok ? backdropTexture(this, root.get_width(), root.get_height()) : null

      if (ok) {
        // A TRUE pill: our own path, so the radius can be exactly half the
        // height. GSK's rounded clip is clean at that radius — it is GTK's CSS
        // border, not the clip, that seams (both verified offscreen).
        const radius = Math.min(w, h) / 2

        // 1) The rim: the outer pill filled with the border colour. Drawn as a
        //    FILL, never as a border primitive, which is what seams.
        const outerBox = new Graphene.Rect()
        outerBox.init(0, 0, w, h)
        const outer = new Gsk.RoundedRect()
        outer.init_from_rect(outerBox, radius)

        const rimColour = this.hasFocus()
          ? accentRim
          : this.rim === "strong" ? RIM_STRONG : RIM_SUBTLE

        snapshot.push_rounded_clip(outer)
        snapshot.append_color(rgba(rimColour), outerBox)
        snapshot.pop()

        // 2) The body: the same pill inset by the 1px rim. Blurred wallpaper
        //    first, then the glass tint over it — the order the CSS had.
        const innerBox = new Graphene.Rect()
        innerBox.init(RIM_W, RIM_W, Math.max(0, w - RIM_W * 2), Math.max(0, h - RIM_W * 2))
        const inner = new Gsk.RoundedRect()
        inner.init_from_rect(innerBox, Math.max(0, radius - RIM_W))

        snapshot.push_rounded_clip(inner)
        if (texture) {
          // Sampled in WINDOW coordinates: the child sits at `bounds`, so the
          // texture is offset by -bounds and the piece showing through is the
          // one actually behind it.
          const src = new Graphene.Rect()
          src.init(-bounds.get_x(), -bounds.get_y(), texture.get_width(), texture.get_height())
          snapshot.append_texture(texture, src)
        }
        snapshot.append_color(rgba(GLASS_FILL), innerBox)
        snapshot.pop()
      }
    }

    this.snapshot_child(this.child, snapshot)
  }

  // Not a vfunc_dispose override: GJS blocks JS vfuncs during disposal.
  destroyBackdrop() {
    this.child?.unparent()
  }
}

/**
 * Wrap a translucent widget so we blur the wallpaper behind it. Layout
 * properties move to the wrapper and the child fills it, so the pill the CSS
 * draws and the pill we clip to are the same rectangle.
 */
export function withGlassBackdrop(
  child: Gtk.Widget,
  rim: RimWeight = "subtle",
  followFocus = false,
): Gtk.Widget {
  const wrapper = new GlassBackdrop(child, rim, followFocus)

  wrapper.halign = child.halign
  wrapper.valign = child.valign
  wrapper.margin_top = child.margin_top
  wrapper.margin_bottom = child.margin_bottom
  wrapper.margin_start = child.margin_start
  wrapper.margin_end = child.margin_end

  child.margin_top = 0
  child.margin_bottom = 0
  child.margin_start = 0
  child.margin_end = 0
  child.halign = Gtk.Align.FILL
  child.valign = Gtk.Align.FILL

  return wrapper
}

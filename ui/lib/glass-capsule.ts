import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"
import Gsk from "gi://Gsk"
import cairo from "gi://cairo"
import { LOCK_GLASS } from "./tokens"

// The glass capsule of the greeter and the lockscreen — painted, not CSS-drawn.
//
// WHY PAINTED AT ALL. A CSS pill has two failure modes and nothing in between.
// At a radius of exactly half the height GTK's border rendering leaves one
// brighter pixel in the middle of each cap; one pixel under half, the two arcs
// are joined by a straight segment you can see at 1:1 (both reproduced offscreen,
// 2026-08-09, after the second was shipped believing it was invisible). Drawing
// the rim as a FILL between two rounded paths has neither: there is no border
// primitive to seam, and the radius can be exactly half.
//
// WHY THE BACKDROP IS OPTIONAL, AND WHY THAT IS THE WHOLE DIFFERENCE BETWEEN THE
// TWO SURFACES:
//
//   - The GREETER is a transparent layer over awww's wallpaper, with
//     `blur = true, ignore_alpha = 0.3` (config/greetd/hyprland-greeter.lua). Its
//     capsule is translucent (the fill is alpha 0.55, well above the threshold),
//     so the COMPOSITOR blurs the wallpaper behind it. Nothing to paint: call
//     this with no backdrop source and the body is fill-only.
//   - The LOCKSCREEN cannot be helped. Under ext-session-lock-v1 the compositor
//     draws NOTHING behind the lock surface, so it paints its own wallpaper and
//     must blur its own copy — verified against Hyprland 0.56 sources and measured
//     in a VM, so it stops being re-litigated:
//       * `renderAllClientsForWorkspace` returns before drawing ANY layer once the
//         lock client confirms, and `renderSessionLockPrimer` then paints opaque
//         black over everything already drawn — wallpaper layer included.
//       * `misc:session_lock_blur` exists but the renderer gates it:
//         `renderdata.blur = PSESSIONLOCKBLUR && PSESSIONLOCKXRAY`. And xray brings
//         the entire desktop back with it, not just the wallpaper.
//       * An `above_lock = 2` layer renders and takes the pointer, but
//         `CFocusState::rawSurfaceFocus` refuses keyboard focus to any surface that
//         is not the lock surface. Measured: zero keys. A password field there is
//         dead.
//     hyprlock, swaylock and gtklock all blur their own copy for this reason.
//
// So: ONE painter, one shape, and the only thing that differs is where the pixels
// behind the glass come from. That asymmetry is a property of the compositor, not
// a design difference, and it must not become one.
//
// The blur pipeline mirrors the compositor's so the glass MATCHES the rest of the
// desktop rather than merely resembling it: gaussian (`blur { size, passes }`)
// followed by the colour trim (`contrast`, `brightness`, `vibrancy`) as a colour
// matrix. Hyprland's `noise 0.01` is dropped — invisible at that amplitude and it
// would cost a tiled texture.
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
// The glass palette comes from ui/lib/tokens.ts, which is the numeric half of
// the mirror whose CSS half is --nidara-glass / --nidara-glass-border(-sm) in
// ui/greeter/style.scss. These used to be three literals typed out right here,
// tied to the stylesheet by nothing but a comment. The lock has no theme engine
// (fixed dark palette; the accent only reaches the rim on focus), so they stay
// constants — but shared ones.
const { fill: GLASS_FILL, rimStrong: RIM_STRONG, rimSubtle: RIM_SUBTLE } = LOCK_GLASS

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

/** A stadium/rounded-rect path — four arcs, no straight-segment fudge. */
function pillPath(cr: any, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  cr.newSubPath()
  cr.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0)
  cr.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2)
  cr.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI)
  cr.arc(x + rr, y + rr, rr, Math.PI, 1.5 * Math.PI)
  cr.closePath()
}

const rgba = (c: { r: number; g: number; b: number; a: number }) =>
  new Gdk.RGBA({ red: c.r, green: c.g, blue: c.b, alpha: c.a })

let sourcePath: string | null = null
let cache: { texture: Gdk.Texture; w: number; h: number } | null = null

/**
 * The image the glass shows through, blurred here. Set it before any capsule is
 * drawn — or DON'T: leaving it null is the greeter's case, where the compositor
 * supplies the blur and the body is fill-only. Only the lockscreen sets it.
 */
export function setCapsuleBackdrop(path: string | null) {
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
    console.warn(`[GlassCapsule] no colour matrix, blur only: ${e}`)
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
    console.warn(`[GlassCapsule] no rounded clip available: ${e}`)
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
    console.error("[GlassCapsule] cannot load wallpaper:", e)
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
    console.error("[GlassCapsule] backdrop render failed:", e)
    return null
  }
}

// Declaration merging: the ambient `ags/gtk4` typing exposes Gtk as `any` in
// value position but as the real @girs namespace in type position, so tsc can't
// see that this class extends Gtk.Widget (same trick as common/ScaleRevealer).
export interface GlassCapsule extends Gtk.Widget {}

/**
 * Single-child container painting the glass capsule around its child: the rim as
 * a fill between two rounded paths, then the body — blurred backdrop first (when
 * one is set) and the glass tint over it.
 *
 * The backdrop is sampled in WINDOW coordinates, so what shows through is the
 * piece of wallpaper actually behind the capsule, registered with the sharp copy
 * around it rather than a floating crop.
 */
export class GlassCapsule extends Gtk.Widget {
  static {
    GObject.registerClass({ GTypeName: "NidaraGlassCapsule" }, this)
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

        const outerBox = new Graphene.Rect()
        outerBox.init(0, 0, w, h)
        const outer = new Gsk.RoundedRect()
        outer.init_from_rect(outerBox, radius)

        // 1) The BODY, filling the whole pill: blurred wallpaper first when
        //    there is one, then the glass tint over it — the order the CSS had.
        snapshot.push_rounded_clip(outer)
        if (texture) {
          // Sampled in WINDOW coordinates: the child sits at `bounds`, so the
          // texture is offset by -bounds and the piece showing through is the
          // one actually behind it.
          const src = new Graphene.Rect()
          src.init(-bounds.get_x(), -bounds.get_y(), texture.get_width(), texture.get_height())
          snapshot.append_texture(texture, src)
        }
        snapshot.append_color(rgba(GLASS_FILL), outerBox)
        snapshot.pop()

        // 2) The RIM, on top: a 1px ring, filled through an even-odd Cairo path
        //    (outer pill minus inner pill) rather than stroked or drawn as a
        //    border primitive — a border is what seams at the caps, which is the
        //    whole reason this painter exists.
        //
        // ⚠️ IT HAS TO BE A RING, not the outer pill filled with the rim colour
        // and the body painted over it. That is what this did until 2026-08-09
        // and it was invisible for as long as there was a texture: the LOCK
        // paints an opaque blurred wallpaper over the rim, so the bleed-through
        // never showed. The GREETER paints no texture — its body is a 55 %
        // tint — so the rim colour came straight through and the whole capsule
        // rendered ACCENT BLUE the moment it took focus. Caught on the first
        // offscreen render of the textureless case, and it could not have been
        // caught any other way.
        const rimColour = this.hasFocus()
          ? accentRim
          : this.rim === "strong" ? RIM_STRONG : RIM_SUBTLE

        const cr = snapshot.append_cairo(outerBox)
        cr.setFillRule(cairo.FillRule.EVEN_ODD)
        pillPath(cr, 0, 0, w, h, radius)
        pillPath(cr, RIM_W, RIM_W, Math.max(0, w - RIM_W * 2), Math.max(0, h - RIM_W * 2),
                 Math.max(0, radius - RIM_W))
        cr.setSourceRGBA(rimColour.r, rimColour.g, rimColour.b, rimColour.a)
        cr.fill()
        cr.$dispose()
      }
    }

    this.snapshot_child(this.child, snapshot)
  }

  // Not a vfunc_dispose override: GJS blocks JS vfuncs during disposal.
  destroyCapsule() {
    this.child?.unparent()
  }
}

/**
 * Wrap a translucent widget in the painted capsule. Layout properties move to the
 * wrapper and the child fills it, so the box the child occupies and the pill we
 * paint are the same rectangle — which is also why the child's CSS must stop
 * drawing its own background and border (see `ui/greeter/style.scss`).
 */
export function withGlassCapsule(
  child: Gtk.Widget,
  rim: RimWeight = "subtle",
  followFocus = false,
): Gtk.Widget {
  const wrapper = new GlassCapsule(child, rim, followFocus)

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

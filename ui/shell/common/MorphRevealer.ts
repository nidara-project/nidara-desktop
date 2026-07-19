import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Graphene from "gi://Graphene"
import { drawSquircle } from "./DrawingUtils"

// MorphRevealer: Dynamic-Island-style show/hide — ONE shape that TRANSFORMS.
// The bar's workspace capsule doesn't fade out while an island fades in over
// it; the capsule pill itself inflates into the island container and deflates
// back. First consumer: the workspace overview; source widget, glass recipes
// and dot wiring are all parameters, so any future island mode (agent surface)
// reuses this as-is with a different source/content pair.
//
// How the illusion is built (v2 — real interpolated geometry, not a scaled
// render):
//
//   1. THE SHAPE. Mid-morph this widget paints a Cairo squircle EVERY FRAME
//      with truly interpolated geometry — rect (x/y/w/h), corner radius,
//      superellipse exponent n, glass alpha and border color all lerp from the
//      capsule's pill (perfect pill ≡ n=2, r=h/2) to the island container
//      (r=64, n=3.2). Painting via the same `drawSquircle` + params
//      (inset 2, borderWidth 1, gloss) as SquircleContainer means the clone is
//      pixel-identical to both real widgets at the endpoints: the capsule is
//      HARD-SWAPPED for the clone on frame 0 (opacity, so it stays clickable
//      geometry) and the island's real glass (`glassArea`) takes over at rest.
//      Border stays 1px-crisp and corners stay true the whole trip — the v1
//      defect (scaling the rendered container stretched them) is gone. The
//      compositor blur keys off the painted pixels, so it follows the morph
//      for free.
//   2. THE DOTS. The capsule's five workspace dots don't vanish — ghost
//      twins (real `.workspace-dot` widgets, children of this revealer, so
//      CSS state/colors stay live) travel per-dot from each capsule dot's
//      bounds to its landing dot in the island content (the card headers),
//      with a slight per-dot stagger. The landing dots are opacity-0 until
//      the morph rests, then swap in under the ghosts invisibly.
//   3. THE CONTENT. `contentTarget` (labels + schematics) fades in over the
//      LAST stretch [CONTENT_START, 1] while the child paints with the glass
//      rect mapped onto the interpolated rect — content materializes INSIDE
//      the already-formed shape (it's fading in from 0 during that window, so
//      the transient scaled render is imperceptible; the SHAPE is never
//      scaled).
//
// Bounds are re-read via compute_bounds every frame (bar relayouts can't
// leave a stale origin). If the source capsule is hidden/unmapped at open
// (showWorkspaces off), the whole morph degrades to the v1 fallback: a
// centered OVERLAY_POP-equivalent (subtle rect zoom + whole-widget fade) with
// the island's own glass params, no ghosts, landing dots left riding the
// content fade.
//
// Same engine family as ScaleRevealer: snapshot-time paint that ends at
// identity (commandment 9 satisfied at rest; mid-morph paint intentionally
// diverges from the allocation, the same accepted transient as every
// ScaleRevealer overlay). Gtk.Bin semantics for the child (measure/allocation
// pass through 1:1, per-frame repaint only). Overflow stays VISIBLE (widget
// default): mid-morph the shape travels outside the wrapper's own bounds
// toward the bar, and Gtk.Overlay doesn't clip overlay children.
//
// The caller decides WHERE the island rests. For the true capsule-as-island
// effect, anchor the wrapper so its top edge sits at the capsule's top (the
// bar pins overview.margin_top to the capsule's bounds on each open): the top
// edge then stays pinned through the whole lerp — the capsule never travels,
// it only transforms.

const CONTENT_START = 0.45   // contentTarget fades over [CONTENT_START, 1]
// TEST DIAL (2026-07-19): global slow-motion multiplier so the morph can be
// studied by eye while the choreography is tuned — the transformation must be
// clearly perceptible (capsule visibly growing/settling). SHIP AT 1.
const SLOWMO = 5
const DOT_STAGGER = 0        // per-dot timeline offset. 0.06 was tried and read
                             // as "out of sync with the animation" (user,
                             // 2026-07-19): dots move in lockstep with the shape.
const POP_SOLID_AT = 0.25    // fallback pop only: whole-widget fade window
const GLASS_INSET = 2.0      // MUST match SquircleContainer's techInset default

/** Live paint recipe for one END of the glass morph. Read per frame (theme
 *  opacity/dark-mode changes mid-flight track automatically). */
export interface MorphGlass {
    alpha: number
    color: { r: number, g: number, b: number }
    border: { r: number, g: number, b: number, a: number }
    n: number
    /** Corner radius; null = perfect pill (radius follows the rect's h/2). */
    radius: number | null
}

interface Rect { x: number, y: number, w: number, h: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t),
})

// Same typing gotcha as ScaleRevealer: the ambient `ags/gtk4` typing exposes
// Gtk as `any` in value position, so the interface merge is what lets tsc see
// the Gtk.Widget inheritance. No TS `private`, no Widget-colliding names.
export interface MorphRevealer extends Gtk.Widget {}
export class MorphRevealer extends Gtk.Widget {
    static {
        GObject.registerClass({ GTypeName: "MorphRevealer" }, this)
    }

    child: Gtk.Widget
    getSourceWidget: () => Gtk.Widget | null
    contentTarget: Gtk.Widget | null
    glassWidget: Gtk.Widget | null
    glassArea: Gtk.Widget | null
    dots: {
        ghosts: Gtk.Widget[],
        getSource: (i: number) => Gtk.Widget | null,
        getTarget: (i: number) => Gtk.Widget | null,
    } | null
    glassFrom: () => MorphGlass
    glassTo: () => MorphGlass
    durationIn: number
    durationOut: number
    progress = 0          // 0 = collapsed into the source, 1 = at rest
    tickId: number | null = null
    fromSource = false    // latched per open: real capsule morph vs fallback pop

    constructor(child: Gtk.Widget, opts: {
        getSourceWidget: () => Gtk.Widget | null,
        glassFrom: () => MorphGlass,
        glassTo: () => MorphGlass,
        contentTarget?: Gtk.Widget | null,
        /** The island's real glass container — final rect of the morph. */
        glassWidget?: Gtk.Widget | null,
        /** Its paint layer (SquircleContainer's `.glassArea`), suppressed
         *  mid-morph so the interpolated clone owns the shape. */
        glassArea?: Gtk.Widget | null,
        dots?: MorphRevealer["dots"],
        durationIn?: number, durationOut?: number,
    }) {
        super({})
        this.child = child
        this.getSourceWidget = opts.getSourceWidget
        this.glassFrom = opts.glassFrom
        this.glassTo = opts.glassTo
        this.contentTarget = opts.contentTarget ?? null
        this.glassWidget = opts.glassWidget ?? null
        this.glassArea = opts.glassArea ?? null
        this.dots = opts.dots ?? null
        this.durationIn = opts.durationIn ?? 300
        this.durationOut = opts.durationOut ?? 220
        this.child.set_parent(this)
        for (const ghost of this.dots?.ghosts ?? []) ghost.set_parent(this)
        this.set_visible(false)
    }

    // Widget bounds in this widget's coordinates, or null when unusable.
    rectOf(w: Gtk.Widget | null): Rect | null {
        if (!w?.get_mapped()) return null
        const [ok, b] = w.compute_bounds(this)
        if (!ok || b.get_width() <= 0) return null
        return { x: b.get_x(), y: b.get_y(), w: b.get_width(), h: b.get_height() }
    }

    applyProgress() {
        const p = this.progress
        const resting = p >= 1
        // Real morph: solid object from frame 0 (the painted clone IS the
        // capsule). Fallback pop keeps the v1 quick fade-in.
        this.opacity = this.fromSource ? 1 : Math.min(1, p / POP_SOLID_AT)
        // The island's own glass paints only at rest — mid-flight the
        // interpolated clone owns the shape.
        if (this.glassArea) this.glassArea.opacity = resting ? 1 : 0
        // The capsule is REPLACED by the clone for the whole flight and while
        // open (opacity only, so it stays clickable geometry); back at close.
        const src = this.getSourceWidget?.()
        if (src) src.opacity = p <= 0 ? 1 : 0
        if (this.contentTarget)
            this.contentTarget.opacity = clamp01((p - CONTENT_START) / (1 - CONTENT_START))
        // Landing dots exist only at rest — the ghosts own the journey. Without
        // a ghost for dot i (fallback mode, or the compact has MUTATED away
        // from the dots page so the source dot is unmapped) that landing dot
        // rides the content fade with its parent instead of popping at rest.
        if (this.dots) {
            for (let i = 0; i < this.dots.ghosts.length; i++) {
                const target = this.dots.getTarget(i)
                if (!target) continue
                const hasGhost = this.fromSource && this.rectOf(this.dots.getSource(i)) !== null
                target.opacity = (!hasGhost || resting) ? 1 : 0
            }
        }
        this.queue_draw()
    }

    // Same contract as ScaleRevealer.reveal: manages its own visibility, hides
    // itself when the close finishes and THEN fires onDone (input-region
    // refresh). Easing is ease-in-out BOTH ways — a deliberate deviation from
    // the house asymmetric rule: that rule serves fade-pops, whose decelerating
    // exit leaves a low-opacity tail. The morph is a SOLID object and the
    // transformation must read in both directions; ease-in on close compressed
    // the whole spatial shrink into the final sprint, which read as "overview
    // vanishes, capsule appears" instead of one object transforming.
    reveal(open: boolean, onDone?: () => void) {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        if (open) {
            // Latched per open (the close mirrors the open's mode); the rects
            // themselves are still re-read live every frame.
            this.fromSource = this.rectOf(this.getSourceWidget?.() ?? null) !== null
            // Sync visuals before the first frame so the island never flashes
            // at full size/opacity between set_visible and the first tick.
            this.set_visible(true)
            this.applyProgress()
        }
        const from = this.progress
        const target = open ? 1 : 0
        if (from === target) {
            if (!open) this.set_visible(false)
            onDone?.()
            return
        }
        const duration = (open ? this.durationIn : this.durationOut) * SLOWMO
        let startUs: number | null = null
        this.tickId = this.add_tick_callback((_w, frameClock) => {
            const now = frameClock.get_frame_time()
            if (startUs === null) startUs = now
            const t = Math.min(1, (now - startUs) / (duration * 1000))
            // Cubic ease-in-out: leave gently, travel, decelerate into the
            // other form (see the reveal() doc above for why not asymmetric).
            const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
            this.progress = from + (target - from) * eased
            this.applyProgress()
            if (t >= 1) {
                this.tickId = null
                if (!open) this.set_visible(false)
                onDone?.()
                return GLib.SOURCE_REMOVE
            }
            return GLib.SOURCE_CONTINUE
        })
    }

    vfunc_get_request_mode(): Gtk.SizeRequestMode {
        return this.child.get_request_mode()
    }

    vfunc_measure(orientation: Gtk.Orientation, for_size: number): [number, number, number, number] {
        const [min, nat] = this.child.measure(orientation, for_size)
        return [min, nat, -1, -1]
    }

    vfunc_size_allocate(width: number, height: number, baseline: number) {
        this.child.allocate(width, height, baseline, null)
        // Ghosts get their natural size at the origin; snapshot places them.
        for (const ghost of this.dots?.ghosts ?? []) {
            const [, gw] = ghost.measure(Gtk.Orientation.HORIZONTAL, -1)
            const [, gh] = ghost.measure(Gtk.Orientation.VERTICAL, -1)
            ghost.allocate(Math.max(1, gw), Math.max(1, gh), -1, null)
        }
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot) {
        const p = this.progress
        if (p >= 1) { this.snapshot_child(this.child, snapshot); return }
        const w = this.get_width()
        const h = this.get_height()
        if (w <= 0 || h <= 0) return

        const f = this.rectOf(this.glassWidget) ?? { x: 0, y: 0, w, h }
        const s = (this.fromSource ? this.rectOf(this.getSourceWidget?.() ?? null) : null)
            ?? { x: f.x + f.w * 0.015, y: f.y + f.h * 0.015, w: f.w * 0.97, h: f.h * 0.97 }
        const R = lerpRect(s, f, p)
        // Content mapping: glass rect f → current rect R(p). Shared by the
        // child paint (2.) and the ghost-dot targets (3.).
        const sx = f.w > 0 ? R.w / f.w : 1
        const sy = f.h > 0 ? R.h / f.h : 1
        // Param interpolation factor: fallback pop holds the island's own
        // glass recipe for the whole (subtle) zoom.
        const k = this.fromSource ? p : 1

        // 1. THE SHAPE — real interpolated Cairo geometry, same painter and
        // params as SquircleContainer so both endpoint swaps are invisible.
        const gFrom = this.glassFrom()
        const gTo = this.glassTo()
        const bounds = new Graphene.Rect()
        bounds.init(-8, -8, w + 16, h + 16)   // slack for sub-pixel source rects
        const cr = snapshot.append_cairo(bounds)
        cr.translate(R.x, R.y)
        drawSquircle(
            cr, R.w, R.h, undefined,
            lerp(gFrom.alpha, gTo.alpha, k), true,
            {
                r: lerp(gFrom.color.r, gTo.color.r, k),
                g: lerp(gFrom.color.g, gTo.color.g, k),
                b: lerp(gFrom.color.b, gTo.color.b, k),
            },
            lerp(gFrom.radius ?? s.h / 2, gTo.radius ?? f.h / 2, k), false,
            {
                r: lerp(gFrom.border.r, gTo.border.r, k),
                g: lerp(gFrom.border.g, gTo.border.g, k),
                b: lerp(gFrom.border.b, gTo.border.b, k),
                a: lerp(gFrom.border.a, gTo.border.a, k),
            },
            lerp(gFrom.n, gTo.n, k), 1.0, GLASS_INSET,
        )

        // 2. THE CONTENT — child painted with the glass rect mapped onto R(p)
        // (glassArea is opacity-0, so only content pixels land); contentTarget
        // opacity does the late fade.
        if (f.w > 0 && f.h > 0) {
            const off = new Graphene.Point()
            off.init(R.x - f.x * sx, R.y - f.y * sy)
            snapshot.save()
            snapshot.translate(off)
            snapshot.scale(sx, sy)
            this.snapshot_child(this.child, snapshot)
            snapshot.restore()
        }

        // 3. THE DOTS — ghost twins travel from the capsule dots to where each
        // landing dot is being PAINTED THIS FRAME (its resting bounds pushed
        // through the same f→R(p) content mapping). Lerping toward the resting
        // position instead left the ghosts drifting off the still-scaling
        // cards they belong to until the last frame — read as "out of sync".
        // Painted last, so they ride on the glass.
        if (this.fromSource && this.dots) {
            const count = this.dots.ghosts.length
            const denom = Math.max(0.01, 1 - (count - 1) * DOT_STAGGER)
            for (let i = 0; i < count; i++) {
                const gs = this.rectOf(this.dots.getSource(i))
                const gt = this.rectOf(this.dots.getTarget(i))
                const ghost = this.dots.ghosts[i]
                const gw = ghost.get_width()
                const gh = ghost.get_height()
                if (!gs || !gt || gw <= 0 || gh <= 0) continue
                const mapped = {
                    x: R.x + (gt.x - f.x) * sx,
                    y: R.y + (gt.y - f.y) * sy,
                    w: gt.w * sx, h: gt.h * sy,
                }
                const r = lerpRect(gs, mapped, clamp01((p - i * DOT_STAGGER) / denom))
                const doff = new Graphene.Point()
                doff.init(r.x, r.y)
                snapshot.save()
                snapshot.translate(doff)
                snapshot.scale(r.w / gw, r.h / gh)
                this.snapshot_child(ghost, snapshot)
                snapshot.restore()
            }
        }
    }

    // Same GC story as ScaleRevealer: explicit teardown, deliberately no
    // vfunc_dispose (GJS blocks JS vfuncs during GC finalization — the child
    // would leak). Long-lived overlay wrappers never need it.
    dismantle() {
        if (this.tickId !== null) { this.remove_tick_callback(this.tickId); this.tickId = null }
        for (const ghost of this.dots?.ghosts ?? []) ghost.unparent()
        this.child?.unparent()
    }
}

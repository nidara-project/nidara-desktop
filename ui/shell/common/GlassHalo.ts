import GObject from "gi://GObject"
import Gtk from "gi://Gtk?version=4.0"
import Graphene from "gi://Graphene"
import Theme from "../core/ThemeManager"
import { GLASS_TINT, RADIUS } from "../../lib/nidara-kit/platform/tokens"
import { chromeIsDarkFor, haloAlphaFor } from "./AdaptiveGlass"

/**
 * GlassHalo — the diffuse container behind a panel made of separate pieces of glass
 * (the Control Center's tiles), #673.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
 *
 * The CC has no panel: its tiles ARE the outer glass, and over a busy backdrop each one
 * is a separate thin sheet with the page showing through it and between them. macOS
 * draws a large soft shadow when its Control Center opens (owner's observation). This is
 * that shadow, and it is also the FIRST step of the adaptive glass for the surface: it
 * sits in the same layer as the tiles, so everything painted under them adds to their
 * tint. Glass of alpha `a` over a halo of alpha `c`, both the skin's `GLASS_TINT`, is
 * exactly glass of alpha `1 − (1−a)(1−c)` — one number the legibility rule already knows
 * how to decide (`AdaptiveGlass.ts`: `haloAlphaFor` / `glassAlphaFor` split it).
 *
 * ── THE ONE LIMIT THAT SHAPES IT ─────────────────────────────────────────────
 *
 * Its alpha stays BELOW the layer's `ignore_alpha` (`HALO_MAX`, 0.22 against 0.23):
 * Hyprland does not blur behind it, so between and around the tiles it reads as a soft
 * shadow over the sharp backdrop, not as a panel of frosted glass. Past that, the tiles
 * thicken instead (owner, 2026-09-29: a switch from shadow to panel would be a visible
 * jump; the solid panel belongs to Reduce transparency, #674).
 *
 * ── SHAPE (owner, 2026-09-29: one halo, always there) ────────────────────────
 *
 * One rounded rectangle behind the whole panel, at full alpha under every piece of glass
 * (so the contrast it buys is the same everywhere a label can be), falling off OUTSIDE
 * the box with a raised-cosine profile: little above (8 px — the bar is 8 px up, and a
 * halo reaching over its capsules would darken them), 24 at the sides, 32 below — a light
 * from above, without moving the core off the tiles. In the skin's own tint: a shadow on
 * dark glass, a frosted haze on light glass (a dark shadow under black ink would LOWER its
 * contrast).
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * The shape is painted once per size and skin into a cached render node at full
 * strength; its alpha is an opacity node on top, so the adaptive animation and the
 * reveal's fade never repaint it. It paints outside its box: the revealer around it must
 * not clip it (`ScaleRevealer` clips only an unrolling reveal), and the bar's visible
 * region must cover it (`HALO_OUTSET`, read in `Bar.tsx`'s `paintedRects`) — outside the
 * region the compositor does not draw at all.
 */

/** How far the halo reaches past the panel's box, per side, in logical px. */
export const HALO_OUTSET = { top: 8, right: 24, bottom: 32, left: 24 } as const

export interface GlassHalo extends Gtk.Widget {}
export class GlassHalo extends Gtk.Widget {
    static {
        GObject.registerClass({ GTypeName: "NidaraGlassHalo" }, this)
    }

    /** Duck-typed by `AdaptiveGlass.redrawSubtree` (importing the class there would be a cycle). */
    readonly isGlassHalo = true
    child: Gtk.Widget
    private _node: any = null
    private _key = ""
    private _themeId: number

    constructor(child: Gtk.Widget) {
        super({ overflow: Gtk.Overflow.VISIBLE })
        this.child = child
        child.set_parent(this)
        // A skin change without a measurement (the mode, with nothing measured yet).
        this._themeId = Theme.connect("changed", () => this.queue_draw())
    }

    vfunc_get_request_mode(): Gtk.SizeRequestMode {
        return this.child.get_request_mode()
    }

    vfunc_measure(orientation: Gtk.Orientation, forSize: number): [number, number, number, number] {
        const [min, nat, minB, natB] = this.child.measure(orientation, forSize)
        return [min, nat, minB, natB]
    }

    vfunc_size_allocate(width: number, height: number, baseline: number) {
        this.child.allocate(width, height, baseline, null)
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot) {
        const alpha = haloAlphaFor(this)
        const w = this.get_width(), h = this.get_height()
        if (alpha > 0 && w > 0 && h > 0) {
            const dark = chromeIsDarkFor(this)
            const key = `${w}x${h}|${dark}`
            if (key !== this._key || !this._node) {
                this._node = buildHalo(w, h, dark)
                this._key = key
            }
            if (this._node) {
                snapshot.push_opacity(alpha)
                snapshot.append_node(this._node)
                snapshot.pop()
            }
        }
        this.snapshot_child(this.child, snapshot)
    }

    vfunc_dispose() {
        if (this._themeId) { Theme.disconnect(this._themeId); this._themeId = 0 }
        this._node = null
        this.child?.unparent()
        super.vfunc_dispose()
    }
}

/** 1 at the core's edge, 0 at the halo's outer edge; flat at both ends, so neither the
 *  core nor the outside shows a line. */
const profile = (t: number) => 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.max(0, t))))

/** The halo at full strength (alpha 1 at the core), as a render node. */
function buildHalo(w: number, h: number, dark: boolean): any {
    const o = HALO_OUTSET
    const tint = dark ? GLASS_TINT.dark : GLASS_TINT.light
    const bounds = new Graphene.Rect()
    bounds.init(-o.left, -o.top, w + o.left + o.right, h + o.top + o.bottom)
    const snap = new Gtk.Snapshot()
    const cr = snap.append_cairo(bounds)
    try {
        // The core's corners follow the tiles' (`RADIUS.xl`), and grow with the halo.
        const r0 = RADIUS.xl
        const path = (t: number) => {
            const x0 = -o.left * t, y0 = -o.top * t
            const x1 = w + o.right * t, y1 = h + o.bottom * t
            const r = Math.min(r0 + ((o.left + o.right + o.top + o.bottom) / 4) * t, (x1 - x0) / 2, (y1 - y0) / 2)
            cr.newPath()
            cr.arc(x1 - r, y0 + r, r, -Math.PI / 2, 0)
            cr.arc(x1 - r, y1 - r, r, 0, Math.PI / 2)
            cr.arc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI)
            cr.arc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5)
            cr.closePath()
        }
        // Nested fills from the outside in, each REPLACING what is under it (SOURCE):
        // every band ends up at exactly its profile value — no accumulation, and no
        // antialiased seam between abutting rings (`drawShadowFromPath` explains both).
        const steps = Math.max(o.top, o.right, o.bottom, o.left)
        cr.pushGroup()
        cr.setOperator(1)   // SOURCE
        for (let i = steps; i >= 0; i--) {
            const t = i / steps
            path(t)
            cr.setSourceRGBA(tint.r, tint.g, tint.b, profile(t))
            cr.fill()
        }
        cr.popGroupToSource()
        cr.setOperator(2)   // OVER
        cr.paint()
    } finally {
        cr.$dispose()
    }
    return snap.to_node()
}

import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"

// ── Constants ─────────────────────────────────────────────────────────────────

const CORNER_R = 14   // matches --crystal-radius-lg
const ARROW_W  = 18   // arrow base width
const ARROW_H  = 10   // arrow height (GTK allocates ~12px for the native arrow slot)
const TIP_R    =  3   // bezier tip rounding radius

// ── CrystalPopover ────────────────────────────────────────────────────────────

export class CrystalPopover extends Gtk.Popover {
    static {
        GObject.registerClass({ GTypeName: "CrystalPopover" }, this)
    }

    constructor(params?: Partial<Gtk.Popover.ConstructorProps>) {
        super(params)
        this.add_css_class("crystal-popover")
    }

    vfunc_snapshot(snapshot: Gtk.Snapshot): void {
        const w = this.get_width()
        const h = this.get_height()

        // ── Detect EFFECTIVE position from the arrow widget's actual allocation ──
        // get_position() returns the preference; GTK may flip it. The arrow widget's
        // allocation always reflects the final placement.
        const pos = this._effectivePosition(w, h)

        // ── Read glass color from FluidCrystal's named color ──────────────────
        let fr = 0.19, fg = 0.19, fb = 0.19, fa = 0.92
        try {
            const [ok, rgba] = (this.get_style_context() as any).lookup_color("fc_popover_bg")
            if (ok) { fr = rgba.red; fg = rgba.green; fb = rgba.blue; fa = rgba.alpha }
        } catch {}

        const isLight = (fr + fg + fb) / 3 > 0.5
        const [bR, bG, bB, bA] = isLight ? [0.0, 0.0, 0.0, 0.10] : [1.0, 1.0, 1.0, 0.14]

        // ── Draw custom Cairo background ──────────────────────────────────────
        const bounds = new Graphene.Rect()
        bounds.init(0, 0, w, h)
        const cr = snapshot.append_cairo(bounds)
        drawPopover(cr, w, h, pos, fr, fg, fb, fa, bR, bG, bB, bA)

        // ── Snapshot children WITHOUT the GTK native backgrounds ─────────────
        // We skip the internal 'arrow' child (we draw our own) and snapshot only
        // the children inside the 'contents' wrapper, bypassing its opaque CSS bg.
        let internalChild = this.get_first_child()
        while (internalChild) {
            if (internalChild.has_css_class("arrow")) {
                // Intentionally skip — our Cairo arrow replaces the native one
            } else {
                // 'contents' wrapper: render what's inside it, not the wrapper itself
                let userChild = internalChild.get_first_child()
                while (userChild) {
                    ;(this as any).snapshot_child(userChild, snapshot)
                    userChild = userChild.get_next_sibling()
                }
            }
            internalChild = internalChild.get_next_sibling()
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _effectivePosition(totalW: number, totalH: number): Gtk.PositionType {
        // The native arrow widget is allocated on the side it actually points from,
        // regardless of the preferred get_position() value (which may be pre-flip).
        let child = this.get_first_child()
        while (child) {
            if (child.has_css_class("arrow")) {
                const a = child.get_allocation()
                if (a.height > 0 && a.y <= 0)               return Gtk.PositionType.BOTTOM // arrow at top
                if (a.height > 0 && a.y + a.height >= totalH) return Gtk.PositionType.TOP   // arrow at bottom
                if (a.width  > 0 && a.x <= 0)               return Gtk.PositionType.RIGHT  // arrow at left
                if (a.width  > 0 && a.x + a.width >= totalW)  return Gtk.PositionType.LEFT  // arrow at right
                break
            }
            child = child.get_next_sibling()
        }
        return this.get_position() // fallback to preference
    }
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawPopover(
    cr: any,
    w: number, h: number,
    pos: Gtk.PositionType,
    fr: number, fg: number, fb: number, fa: number,
    br: number, bg: number, bb: number, ba: number,
): void {
    cr.newPath()
    buildPath(cr, w, h, pos)
    cr.setSourceRGBA(fr, fg, fb, fa)
    cr.fillPreserve()
    cr.setSourceRGBA(br, bg, bb, ba)
    cr.setLineWidth(1.0)
    cr.stroke()
}

function buildPath(cr: any, w: number, h: number, pos: Gtk.PositionType): void {
    const PI = Math.PI
    const r  = CORNER_R
    const hw = ARROW_W / 2
    const ah = ARROW_H
    const tr = TIP_R

    // Content box bounds: the arrow slot is subtracted on the pointing side
    let x0: number, y0: number, x1: number, y1: number
    switch (pos) {
        case Gtk.PositionType.TOP:    x0=0;  y0=0;  x1=w;    y1=h-ah; break  // arrow at bottom
        case Gtk.PositionType.BOTTOM: x0=0;  y0=ah; x1=w;    y1=h;    break  // arrow at top
        case Gtk.PositionType.LEFT:   x0=0;  y0=0;  x1=w-ah; y1=h;    break  // arrow at right
        default:                      x0=ah; y0=0;  x1=w;    y1=h;    break  // RIGHT: arrow at left
    }

    // Arrow base center (centered on the content box edge)
    const acx = (x0 + x1) / 2
    const acy = (y0 + y1) / 2

    if (pos === Gtk.PositionType.TOP) {
        // Arrow at bottom pointing down, tip at (acx, h)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);              cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);              cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(acx + hw, y1)
        cr.lineTo(acx + tr, y1 + ah - tr)
        cr.curveTo(acx + tr*0.55, y1+ah,  acx - tr*0.55, y1+ah,  acx - tr, y1+ah - tr)
        cr.lineTo(acx - hw, y1)
        cr.lineTo(x0 + r, y1);              cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);              cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else if (pos === Gtk.PositionType.BOTTOM) {
        // Arrow at top pointing up, tip at (acx, 0)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(acx - hw, y0)
        cr.lineTo(acx - tr, y0 - ah + tr)
        cr.curveTo(acx - tr*0.55, y0-ah,  acx + tr*0.55, y0-ah,  acx + tr, y0-ah + tr)
        cr.lineTo(acx + hw, y0)
        cr.lineTo(x1 - r, y0);              cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);              cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);              cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);              cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else if (pos === Gtk.PositionType.LEFT) {
        // Arrow at right pointing right, tip at (w, acy)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);              cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, acy - hw)
        cr.lineTo(x1 + ah - tr, acy - tr)
        cr.curveTo(x1+ah, acy - tr*0.55,  x1+ah, acy + tr*0.55,  x1+ah - tr, acy + tr)
        cr.lineTo(x1, acy + hw)
        cr.lineTo(x1, y1 - r);              cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);              cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);              cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else {
        // RIGHT: arrow at left pointing left, tip at (0, acy)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);              cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);              cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);              cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, acy + hw)
        cr.lineTo(x0 - ah + tr, acy + tr)
        cr.curveTo(x0-ah, acy + tr*0.55,  x0-ah, acy - tr*0.55,  x0-ah + tr, acy - tr)
        cr.lineTo(x0, acy - hw)
        cr.lineTo(x0, y0 + r);              cr.arc(x0 + r, y0 + r, r, PI, -PI/2)
    }

    cr.closePath()
}

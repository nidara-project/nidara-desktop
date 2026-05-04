import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"
import Graphene from "gi://Graphene"

// ── Constants ─────────────────────────────────────────────────────────────────

const CORNER_R = 14   // matches --crystal-radius-lg
const ARROW_W  = 18   // arrow base width
const ARROW_H  = 10   // arrow height (GTK allocates ~12px for the arrow slot)
const TIP_R    =  3   // cubic-bezier tip rounding radius

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
        const pos = this.get_position()

        // Read the glass background color injected by FluidCrystal
        let fillR = 0.19, fillG = 0.19, fillB = 0.19, fillA = 0.92
        try {
            const [ok, rgba] = (this.get_style_context() as any).lookup_color("fc_popover_bg")
            if (ok) { fillR = rgba.red; fillG = rgba.green; fillB = rgba.blue; fillA = rgba.alpha }
        } catch {}

        // Border: white for dark bg, black for light bg
        const isLight = (fillR + fillG + fillB) / 3 > 0.5
        const bR = isLight ? 0.0 : 1.0
        const bG = isLight ? 0.0 : 1.0
        const bB = isLight ? 0.0 : 1.0
        const bA = isLight ? 0.10 : 0.14

        const bounds = new Graphene.Rect()
        bounds.init(0, 0, w, h)
        const cr = snapshot.append_cairo(bounds)
        drawPopover(cr, w, h, pos, fillR, fillG, fillB, fillA, bR, bG, bB, bA)

        // Render children on top of our custom background
        super.vfunc_snapshot(snapshot)
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

    // Content box bounds (minus the arrow slot on the pointing side)
    let x0: number, y0: number, x1: number, y1: number

    switch (pos) {
        case Gtk.PositionType.TOP:    x0=0;  y0=0;  x1=w;    y1=h-ah; break  // arrow at bottom
        case Gtk.PositionType.BOTTOM: x0=0;  y0=ah; x1=w;    y1=h;    break  // arrow at top
        case Gtk.PositionType.LEFT:   x0=0;  y0=0;  x1=w-ah; y1=h;    break  // arrow at right
        case Gtk.PositionType.RIGHT:  x0=ah; y0=0;  x1=w;    y1=h;    break  // arrow at left
        default:                      x0=0;  y0=0;  x1=w;    y1=h-ah; break
    }

    // Arrow base centers along the pointing edge (centered on the popover)
    const acx = (x0 + x1) / 2  // horizontal center of content box
    const acy = (y0 + y1) / 2  // vertical center of content box

    if (pos === Gtk.PositionType.TOP) {
        // Arrow at bottom, tip at (acx, h)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);          cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);          cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(acx + hw, y1)
        // Arrow: right-base → rounded tip (downward) → left-base
        cr.lineTo(acx + tr, y1 + ah - tr)
        cr.curveTo(acx + tr * 0.55, y1 + ah,  acx - tr * 0.55, y1 + ah,  acx - tr, y1 + ah - tr)
        cr.lineTo(acx - hw, y1)
        cr.lineTo(x0 + r, y1);          cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);          cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else if (pos === Gtk.PositionType.BOTTOM) {
        // Arrow at top, tip at (acx, 0)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(acx - hw, y0)
        // Arrow: left-base → rounded tip (upward) → right-base
        cr.lineTo(acx - tr, y0 - ah + tr)
        cr.curveTo(acx - tr * 0.55, y0 - ah,  acx + tr * 0.55, y0 - ah,  acx + tr, y0 - ah + tr)
        cr.lineTo(acx + hw, y0)
        cr.lineTo(x1 - r, y0);          cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);          cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);          cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);          cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else if (pos === Gtk.PositionType.LEFT) {
        // Arrow at right, tip at (w, acy)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);          cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, acy - hw)
        // Arrow: top-base → rounded tip (rightward) → bottom-base
        cr.lineTo(x1 + ah - tr, acy - tr)
        cr.curveTo(x1 + ah, acy - tr * 0.55,  x1 + ah, acy + tr * 0.55,  x1 + ah - tr, acy + tr)
        cr.lineTo(x1, acy + hw)
        cr.lineTo(x1, y1 - r);          cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);          cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, y0 + r);          cr.arc(x0 + r, y0 + r, r, PI, -PI/2)

    } else {
        // RIGHT — arrow at left, tip at (0, acy)
        cr.moveTo(x0 + r, y0)
        cr.lineTo(x1 - r, y0);          cr.arc(x1 - r, y0 + r, r, -PI/2, 0)
        cr.lineTo(x1, y1 - r);          cr.arc(x1 - r, y1 - r, r, 0, PI/2)
        cr.lineTo(x0 + r, y1);          cr.arc(x0 + r, y1 - r, r, PI/2, PI)
        cr.lineTo(x0, acy + hw)
        // Arrow: bottom-base → rounded tip (leftward) → top-base
        cr.lineTo(x0 - ah + tr, acy + tr)
        cr.curveTo(x0 - ah, acy + tr * 0.55,  x0 - ah, acy - tr * 0.55,  x0 - ah + tr, acy - tr)
        cr.lineTo(x0, acy - hw)
        cr.lineTo(x0, y0 + r);          cr.arc(x0 + r, y0 + r, r, PI, -PI/2)
    }

    cr.closePath()
}

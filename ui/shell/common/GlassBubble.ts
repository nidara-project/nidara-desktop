import { Gtk } from "ags/gtk4"
import Theme from "../core/ThemeManager"

// The Nidara glass bubble: a rounded body with a pointer spliced into one side,
// painted in Cairo as a SINGLE continuous shape (one glass fill, one 1px inner
// edge wrapping body AND arrow with no seam). Shared by the tooltip
// (`common/Tooltip.ts`) and the dock context menu (`surfaces/dock/DockItem.tsx`)
// so both speak the same glass language. A GTK popover arrow can't do this on
// translucent glass — its base seam shows through — which is the whole reason
// this is Cairo. The popover is still its own surface, so it keeps Hyprland's blur.

export type ArrowSide = "top" | "bottom" | "left" | "right"

// Pointer geometry — ONE size, same on the tooltip and the dock menu. It's a clear
// downward TRIANGLE (straight diagonal sides) whose very tip is a small circular arc
// (radius TIP_R). The arc must stay SMALL relative to the triangle: a big arc eats the
// straight sides and the whole thing reads as a bell, not a triangle. The straight
// sides run tangent into the arc, so there's no kink. Don't make it tall enough to
// separate the body far from the anchor.
export const ARROW_W = 24   // base width of the pointer
export const ARROW_H = 16   // how far it protrudes (= the separation from the anchor)
export const BUF = 2        // AA buffer so the silhouette never clips the DrawingArea edge
const BORDER_W = 1          // inner edge width
const TIP_R = 8             // tip arc radius (= how round the point is) — independent of ARROW_H
const BASE_R = 8            // radius of the curved join where the pointer meets the body edge

// Map a popover position to the side the pointer is painted on (it points back at
// the anchor): a popover ABOVE the widget (TOP) needs the arrow on its BOTTOM, etc.
export const sideFor = (pos: Gtk.PositionType): ArrowSide => {
    switch (pos) {
        case Gtk.PositionType.BOTTOM: return "top"
        case Gtk.PositionType.LEFT:   return "right"
        case Gtk.PositionType.RIGHT:  return "left"
        default:                      return "bottom" // TOP
    }
}

// Round ONE corner of the pointer: vertex V between its neighbours `prev` and `next`,
// with a true circular arc of radius `rc` tangent to both edges (no kink). Emits
// lineTo(tangent-in) + the arc to tangent-out — so chaining these draws the whole
// pointer (base join → tip → base join), every corner a clean arc. Used for both the
// tip (sharp apex) and the two base joins where the pointer meets the body edge.
const corner = (
    cr: any, px: number, py: number, vx: number, vy: number, nx: number, ny: number, rc: number,
) => {
    // Unit directions from V toward each neighbour.
    let i1x = px - vx, i1y = py - vy; const l1 = Math.hypot(i1x, i1y) || 1; i1x /= l1; i1y /= l1
    let o1x = nx - vx, o1y = ny - vy; const l2 = Math.hypot(o1x, o1y) || 1; o1x /= l2; o1y /= l2
    let dot = i1x * o1x + i1y * o1y; dot = Math.max(-1, Math.min(1, dot))
    const half = Math.acos(dot) / 2, sinH = Math.sin(half) || 1e-3, tanH = Math.tan(half) || 1e-3
    // Tangent distance along each edge; cap to ~half each so neighbouring corners on a
    // shared edge can't overrun each other.
    const d = Math.min(rc / tanH, l1 * 0.5, l2 * 0.5)
    const reff = d * tanH
    const tix = vx + i1x * d, tiy = vy + i1y * d     // tangent-in (toward prev)
    const tox = vx + o1x * d, toy = vy + o1y * d     // tangent-out (toward next)
    let bvx = i1x + o1x, bvy = i1y + o1y; const bl = Math.hypot(bvx, bvy) || 1; bvx /= bl; bvy /= bl
    const ccx = vx + bvx * (reff / sinH), ccy = vy + bvy * (reff / sinH)   // arc centre on the bisector
    const a1 = Math.atan2(tiy - ccy, tix - ccx), a2 = Math.atan2(toy - ccy, tox - ccx)
    // Pick the sweep that bulges toward V (the proper rounded corner), on any side.
    const mid = (a1 + (a2 < a1 ? a2 + 2 * Math.PI : a2)) / 2
    const dV = Math.hypot(ccx + reff * Math.cos(mid) - vx, ccy + reff * Math.sin(mid) - vy)
    const dVo = Math.hypot(ccx + reff * Math.cos(mid + Math.PI) - vx, ccy + reff * Math.sin(mid + Math.PI) - vy)
    cr.lineTo(tix, tiy)
    if (dV <= dVo) cr.arc(ccx, ccy, reff, a1, a2)
    else           cr.arcNegative(ccx, ccy, reff, a1, a2)
}

// ONE continuous path: a rounded rect (perfect arcs) with a pointer spliced into
// `side`, centred on the edge plus `off` (the slide correction — see paintGlassBubble).
// The pointer is a triangle whose THREE corners are all circular arcs — the tip
// (radius `tipR`) and the two base joins where it meets the body edge (radius `baseR`)
// — with straight diagonals between. `aw`/`ah` are the pointer's base width /
// protrusion. Fill it for the glass body; stroke it (clipped to itself) for the 1px
// inner edge — the rim then wraps body AND pointer as one outline.
export const bubblePath = (
    cr: any, x: number, y: number, w: number, h: number, r: number, side: ArrowSide,
    off: number = 0,
    aw: number = ARROW_W, ah: number = ARROW_H, tipR: number = TIP_R, baseR: number = BASE_R,
) => {
    const x2 = x + w, y2 = y + h
    const cx = x + w / 2 + off, cy = y + h / 2 + off
    const HALF = Math.PI / 2
    cr.moveTo(x + r, y)
    if (side === "top") {
        corner(cr, x + r, y,        cx - aw / 2, y,      cx, y - ah,        baseR)
        corner(cr, cx - aw / 2, y,  cx, y - ah,          cx + aw / 2, y,    tipR)
        corner(cr, cx, y - ah,      cx + aw / 2, y,      x2 - r, y,         baseR)
    }
    cr.lineTo(x2 - r, y)
    cr.arc(x2 - r, y + r, r, -HALF, 0)                        // top-right
    if (side === "right") {
        corner(cr, x2, y + r,       x2, cy - aw / 2,     x2 + ah, cy,       baseR)
        corner(cr, x2, cy - aw / 2, x2 + ah, cy,         x2, cy + aw / 2,   tipR)
        corner(cr, x2 + ah, cy,     x2, cy + aw / 2,     x2, y2 - r,        baseR)
    }
    cr.lineTo(x2, y2 - r)
    cr.arc(x2 - r, y2 - r, r, 0, HALF)                        // bottom-right
    if (side === "bottom") {
        corner(cr, x2 - r, y2,      cx + aw / 2, y2,     cx, y2 + ah,       baseR)
        corner(cr, cx + aw / 2, y2, cx, y2 + ah,         cx - aw / 2, y2,   tipR)
        corner(cr, cx, y2 + ah,     cx - aw / 2, y2,     x + r, y2,         baseR)
    }
    cr.lineTo(x + r, y2)
    cr.arc(x + r, y2 - r, r, HALF, Math.PI)                   // bottom-left
    if (side === "left") {
        corner(cr, x, y2 - r,       x, cy + aw / 2,      x - ah, cy,        baseR)
        corner(cr, x, cy + aw / 2,  x - ah, cy,          x, cy - aw / 2,    tipR)
        corner(cr, x - ah, cy,      x, cy - aw / 2,      x, y + r,          baseR)
    }
    cr.lineTo(x, y + r)
    cr.arc(x + r, y + r, r, Math.PI, 3 * HALF)                // top-left
    cr.closePath()
}

export interface GlassBubbleOpts {
    /** Shell skin (glass follows the pinned appearance — legible over any wallpaper)
     *  vs app-mode (follows the system mode, e.g. the About window). Default true. */
    chrome?: boolean
    /** Max corner radius (clamped further so the arrow base fits the straight edge).
     *  Tooltip ≈ 13; a roomier menu can pass more. Default 13. */
    radiusMax?: number
    /** Shift the pointer along its edge (px, ± from the centre) so it keeps aiming
     *  at the anchor when the compositor SLID the popup along a screen edge
     *  (Tooltip.ts measures this). Clamped so the base never eats the corner arcs. */
    arrowOffset?: number
}

export const paintGlassBubble = (cr: any, w: number, h: number, side: ArrowSide, opts: GlassBubbleOpts = {}) => {
    const { chrome = true, radiusMax = 13 } = opts
    const arrowW = ARROW_W, arrowH = ARROW_H, tipR = TIP_R
    if (w <= 0 || h <= 0) return
    // Shell skin follows the pinned appearance; app-mode (About) follows the system mode.
    const dark = chrome ? Theme.chromeIsDark : Theme.isDark
    const tint = dark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
    // Glass alpha tracks the overlay slider, but FLOORED at 0.38. This is a popup,
    // and Hyprland blurs popups with `popups_ignorealpha = 0.30` (NOT the bar/dock
    // layer's 0.01/0.04 — see hyprland.lua). Below that the bubble stops blurring
    // and reads flat. 0.38 mirrors NidaraTheme's popover-bg floor for the same reason.
    // App-mode (About) is a normal window with no blur → keep it near-opaque.
    const alpha = chrome ? Math.max(Theme.overlayOpacity, 0.38) : 0.9

    // Body rect: inset by BUF all round, plus arrowH on the arrow side (the
    // pointer protrudes into that reserved strip).
    const bx = BUF + (side === "left" ? arrowH : 0)
    const by = BUF + (side === "top" ? arrowH : 0)
    const bw = w - 2 * BUF - ((side === "left" || side === "right") ? arrowH : 0)
    const bh = h - 2 * BUF - ((side === "top" || side === "bottom") ? arrowH : 0)
    if (bw <= 0 || bh <= 0) return

    // Near-pill radius, but clamped so the arrow base fits in the straight segment.
    let r = Math.min(bh, bw) / 2
    r = Math.min(r, radiusMax)
    const edgeLen = (side === "top" || side === "bottom") ? bw : bh
    r = Math.min(r, (edgeLen - arrowW) / 2 - 2)
    r = Math.max(r, 4)

    // Fit the pointer's base inside the edge's straight portion (the body can be
    // narrower than arrowW on a short tooltip; never let the base eat the corners).
    const aw = Math.min(arrowW, Math.max(edgeLen - 2 * r - 4, 6))

    // Slide correction: clamp the requested pointer shift so the base joins stay
    // on the straight segment between the corner arcs.
    const maxOff = Math.max(0, (edgeLen - aw) / 2 - r - 2)
    const off = Math.max(-maxOff, Math.min(maxOff, opts.arrowOffset ?? 0))

    cr.setOperator(2) // OVER

    // 1) Glass fill — AA (smooth silhouette).
    cr.save()
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, alpha)
    cr.fill()
    cr.restore()

    // 2) Inner edge — clip to the silhouette, then stroke it at double width so
    //    only the inner ~1px survives the clip (no outer AA spilling onto glass).
    cr.save()
    cr.setAntialias(1) // NONE for a crisp clip
    bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR)
    cr.clip()
    cr.setAntialias(2) // AA for a smooth stroke
    bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR)
    cr.setLineWidth(BORDER_W * 2)
    if (dark) cr.setSourceRGBA(1, 1, 1, 0.16)   // 1px inner white edge on dark glass
    else      cr.setSourceRGBA(0, 0, 0, 0.12)   // subtle dark rim for definition on light glass
    cr.stroke()
    cr.restore()
}

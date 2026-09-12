import Gtk from "gi://Gtk?version=4.0"
import Cairo from "gi://cairo"
import { GLASS_TINT, GLASS_SPECULAR } from "../tokens"
import { glassRimGradient, squircleCorner, drawShadowFromPath, GLASS_SHADOW } from "../glass-paint"
import { kitAppearance } from "./appearance"

// The Nidara glass bubble: a rounded body with a pointer spliced into one side,
// painted in Cairo as a SINGLE continuous shape (one glass fill, one 1px inner
// edge wrapping body AND arrow with no seam). Shared by the tooltip
// (`nidara-kit/tooltip.ts`) and the dock context menu (`surfaces/dock/DockItem.tsx`)
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
export const ARROW_W = 16   // base width of the pointer
export const ARROW_H = 8    // how far it protrudes (= the separation from the anchor). W:H sets the tip
                            // apex angle — 16:8 ≈ 90°: a short, wide-ish pointer that stays close to the anchor
export const BUF = 2        // AA buffer so the silhouette never clips the DrawingArea edge
const BORDER_W = 1          // inner edge width
const TIP_R = 4             // tip arc radius (= how round the point is) — kept small so the arc stays well under half the diagonal and the point reads crisp, not bell-like
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
    slide: number = 0,
    aw: number = ARROW_W, ah: number = ARROW_H, tipR: number = TIP_R, baseR: number = BASE_R,
    n: number = 2,
    offset: number = 0,
) => {
    if (offset !== 0) {
        const halfBase = Math.max(0.5, aw / 2)
        const L = Math.hypot(ah, halfBase)
        aw = Math.max(2, aw + 2 * offset * (L - halfBase) / Math.max(0.5, ah))
        ah = Math.max(1, ah + offset * (L / halfBase - 1))
        tipR = Math.max(0.5, tipR + offset)
        baseR = Math.max(0.5, baseR - offset)
        x -= offset; y -= offset
        w += offset * 2; h += offset * 2
        r = Math.min(Math.max(0, r + offset), Math.min(w, h) / 2)
    }
    const x2 = x + w, y2 = y + h
    const cx = x + w / 2 + slide, cy = y + h / 2 + slide
    const HALF = Math.PI / 2
    cr.moveTo(x + r, y)
    if (side === "top") {
        corner(cr, x + r, y,        cx - aw / 2, y,      cx, y - ah,        baseR)
        corner(cr, cx - aw / 2, y,  cx, y - ah,          cx + aw / 2, y,    tipR)
        corner(cr, cx, y - ah,      cx + aw / 2, y,      x2 - r, y,         baseR)
    }
    cr.lineTo(x2 - r, y)
    if (n === 2) cr.arc(x2 - r, y + r, r, -HALF, 0)           // top-right
    else squircleCorner(cr, x2 - r, y + r, r, n, +1, -1, true)
    if (side === "right") {
        corner(cr, x2, y + r,       x2, cy - aw / 2,     x2 + ah, cy,       baseR)
        corner(cr, x2, cy - aw / 2, x2 + ah, cy,         x2, cy + aw / 2,   tipR)
        corner(cr, x2 + ah, cy,     x2, cy + aw / 2,     x2, y2 - r,        baseR)
    }
    cr.lineTo(x2, y2 - r)
    if (n === 2) cr.arc(x2 - r, y2 - r, r, 0, HALF)           // bottom-right
    else squircleCorner(cr, x2 - r, y2 - r, r, n, +1, +1, false)
    if (side === "bottom") {
        corner(cr, x2 - r, y2,      cx + aw / 2, y2,     cx, y2 + ah,       baseR)
        corner(cr, cx + aw / 2, y2, cx, y2 + ah,         cx - aw / 2, y2,   tipR)
        corner(cr, cx, y2 + ah,     cx - aw / 2, y2,     x + r, y2,         baseR)
    }
    cr.lineTo(x + r, y2)
    if (n === 2) cr.arc(x + r, y2 - r, r, HALF, Math.PI)      // bottom-left
    else squircleCorner(cr, x + r, y2 - r, r, n, -1, +1, true)
    if (side === "left") {
        corner(cr, x, y2 - r,       x, cy + aw / 2,      x - ah, cy,        baseR)
        corner(cr, x, cy + aw / 2,  x - ah, cy,          x, cy - aw / 2,    tipR)
        corner(cr, x - ah, cy,      x, cy - aw / 2,      x, y + r,          baseR)
    }
    cr.lineTo(x, y + r)
    if (n === 2) cr.arc(x + r, y + r, r, Math.PI, 3 * HALF)   // top-left
    else squircleCorner(cr, x + r, y + r, r, n, -1, -1, false)
    cr.closePath()
}

export interface GlassBubbleOpts {
    /** Shell skin (glass follows the pinned appearance — legible over any wallpaper)
     *  vs app-mode (follows the system mode, e.g. the About window). Default true. */
    chrome?: boolean
    /** Max corner radius (clamped further so the arrow base fits the straight edge).
     *  Tooltip ≈ 13; a roomier menu can pass more. Default 13. */
    radiusMax?: number
    /** Superellipse exponent of the BODY corners — `drawSquircle`'s `n`. Default 2 (true
     *  circular arcs), which is right for a tooltip: it is a near-pill and its ends ARE
     *  stadium arcs. A menu bubble passes 3.2 so its silhouette matches the squircle cards
     *  it is a sibling of (system menu, CC context menu, bar panels). The arrow's own three
     *  corners stay circular either way — they are features of the pointer, not of the box. */
    n?: number
    /** Shift the pointer along its edge (px, ± from the centre) so it keeps aiming
     *  at the anchor when the compositor SLID the popup along a screen edge
     *  (Tooltip.ts measures this). Clamped so the base never eats the corner arcs. */
    arrowOffset?: number
    /** Explicit dark mode override. If omitted, resolved through kitAppearance(). */
    dark?: boolean
    /** Explicit glass opacity override. If omitted, resolved through kitAppearance(). */
    alpha?: number
}

export const paintGlassBubble = (cr: any, w: number, h: number, side: ArrowSide, opts: GlassBubbleOpts = {}) => {
    const { chrome = true, radiusMax = 13, n = 2 } = opts
    const arrowW = ARROW_W, arrowH = ARROW_H, tipR = TIP_R
    if (w <= 0 || h <= 0) return

    const app = kitAppearance()
    const dark = opts.dark ?? (chrome ? (app.chromeIsDark?.() ?? app.surfaceIsDark(null as any)) : app.surfaceIsDark(null as any))
    const tint = dark
        ? { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }
        : { r: GLASS_TINT.light.r, g: GLASS_TINT.light.g, b: GLASS_TINT.light.b }

    // Glass alpha tracks the overlay slider, but FLOORED at 0.38 for popups with blur.
    const alpha = opts.alpha ?? Math.max(app.overlayOpacity?.() ?? 0.55, 0.38)

    // Body rect: inset by BUF all round, plus arrowH on the arrow side.
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

    // Fit pointer's base inside the straight portion.
    const aw = Math.min(arrowW, Math.max(edgeLen - 2 * r - 4, 6))

    // Slide correction: clamp requested pointer shift.
    const maxOff = Math.max(0, (edgeLen - aw) / 2 - r - 2)
    const off = Math.max(-maxOff, Math.min(maxOff, opts.arrowOffset ?? 0))

    cr.setOperator(2) // OVER

    // 0) DROP SHADOW
    const shM = GLASS_SHADOW.spread * 2 + 2
    drawShadowFromPath(
        cr,
        (offset, dy) => bubblePath(cr, bx, by + dy, bw, bh, r, side, off, aw, arrowH, tipR, BASE_R, n, offset),
        -shM, -shM, w + shM * 2, h + shM * 2,
        GLASS_SHADOW.spread, GLASS_SHADOW.alpha, GLASS_SHADOW.drop,
    )

    // 1) Glass fill — AA
    cr.save()
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR, BASE_R, n)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, alpha)
    cr.fill()
    cr.restore()

    // 2) Inner edge & physical glass highlights.
    const rimPath = () => bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR, BASE_R, n, -BORDER_W / 2)

    const cx = bx + bw * 0.5
    const { r: lr, g: lg, b: lb } = GLASS_SPECULAR

    // A) Top inner bevel bloom
    cr.save()
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, r, side, off, aw, arrowH, tipR, BASE_R, n)
    cr.clip()
    const topBloomH = Math.min(3.5, Math.max(2.0, bh * 0.12))
    const topBloom = new Cairo.LinearGradient(cx, by, cx, by + topBloomH)
    topBloom.addColorStopRGBA(0.0, lr, lg, lb, 0.06)
    topBloom.addColorStopRGBA(1.0, lr, lg, lb, 0.0)
    cr.rectangle(bx, by, bw, topBloomH)
    cr.setSource(topBloom)
    cr.fill()
    cr.restore()

    // B) 1px continuous rim gradient
    cr.save()
    cr.setAntialias(2)
    rimPath()
    cr.setLineWidth(BORDER_W)
    cr.setSource(glassRimGradient(cx, by, bh, r))
    cr.stroke()
    cr.restore()
}

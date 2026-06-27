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
export const ARROW_W = 30   // base width of the pointer
export const ARROW_H = 20   // how far it protrudes (= the separation from the anchor)
export const BUF = 2        // AA buffer so the silhouette never clips the DrawingArea edge
const BORDER_W = 1          // inner edge width
const TIP_R = 8             // tip arc radius (= how round the point is) — independent of ARROW_H

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

// The pointer: two STRAIGHT sides from the base corners meeting a TRUE circular-arc
// fillet at the apex — only the very point is curved, the diagonals stay dead
// straight (the macOS look). (ax,ay)=base-left, (px,py)=apex, (bx,by)=base-right;
// `rt` = tip radius. The arc is tangent to both sides, so there's no kink at the join.
const arrowTip = (
    cr: any, ax: number, ay: number, px: number, py: number, bx: number, by: number, rt: number,
) => {
    // Unit directions from the apex back toward each base corner.
    let u1x = ax - px, u1y = ay - py; const l1 = Math.hypot(u1x, u1y) || 1; u1x /= l1; u1y /= l1
    let u2x = bx - px, u2y = by - py; const l2 = Math.hypot(u2x, u2y) || 1; u2x /= l2; u2y /= l2
    // Half the apex angle → tangent distance `d` along each side and effective radius.
    let dot = u1x * u2x + u1y * u2y; dot = Math.max(-1, Math.min(1, dot))
    const half = Math.acos(dot) / 2, sinH = Math.sin(half) || 1e-3, tanH = Math.tan(half) || 1e-3
    const d = Math.min(rt / tanH, l1 - 1, l2 - 1)   // cap so the fillet never reaches the base
    const reff = d * tanH
    const t1x = px + u1x * d, t1y = py + u1y * d     // tangent point on the left side
    const t2x = px + u2x * d, t2y = py + u2y * d     // tangent point on the right side
    let bvx = u1x + u2x, bvy = u1y + u2y; const bl = Math.hypot(bvx, bvy) || 1; bvx /= bl; bvy /= bl
    const cx = px + bvx * (reff / sinH), cy = py + bvy * (reff / sinH)   // fillet centre (on the bisector)
    const a1 = Math.atan2(t1y - cy, t1x - cx), a2 = Math.atan2(t2y - cy, t2x - cx)
    // Pick the sweep whose midpoint bulges toward the apex (works on any side).
    const mid = (a1 + (a2 < a1 ? a2 + 2 * Math.PI : a2)) / 2
    const toApex = Math.hypot(cx + reff * Math.cos(mid) - px, cy + reff * Math.sin(mid) - py)
    const toAway = Math.hypot(cx + reff * Math.cos(mid + Math.PI) - px, cy + reff * Math.sin(mid + Math.PI) - py)
    cr.lineTo(ax, ay)
    cr.lineTo(t1x, t1y)
    if (toApex <= toAway) cr.arc(cx, cy, reff, a1, a2)
    else                  cr.arcNegative(cx, cy, reff, a1, a2)
    cr.lineTo(bx, by)
}

// ONE continuous path: a rounded rect (perfect arcs) with a straight-sided,
// round-tipped pointer spliced into the centre of `side`. `aw`/`ah` are the
// pointer's base width / protrusion (clamped by the caller to fit small bubbles);
// `rt` is the tip fillet radius. Fill it for the glass body; stroke it (clipped to
// itself) for the 1px inner edge — the rim then wraps body AND arrow as one outline.
export const bubblePath = (
    cr: any, x: number, y: number, w: number, h: number, r: number, side: ArrowSide,
    aw: number = ARROW_W, ah: number = ARROW_H, rt: number = 0,
) => {
    const x2 = x + w, y2 = y + h
    const cx = x + w / 2, cy = y + h / 2
    const HALF = Math.PI / 2
    cr.moveTo(x + r, y)
    if (side === "top")    arrowTip(cr, cx - aw / 2, y, cx, y - ah, cx + aw / 2, y, rt)
    cr.lineTo(x2 - r, y)
    cr.arc(x2 - r, y + r, r, -HALF, 0)                        // top-right
    if (side === "right")  arrowTip(cr, x2, cy - aw / 2, x2 + ah, cy, x2, cy + aw / 2, rt)
    cr.lineTo(x2, y2 - r)
    cr.arc(x2 - r, y2 - r, r, 0, HALF)                        // bottom-right
    if (side === "bottom") arrowTip(cr, cx + aw / 2, y2, cx, y2 + ah, cx - aw / 2, y2, rt)
    cr.lineTo(x + r, y2)
    cr.arc(x + r, y2 - r, r, HALF, Math.PI)                   // bottom-left
    if (side === "left")   arrowTip(cr, x, cy + aw / 2, x - ah, cy, x, cy - aw / 2, rt)
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

    cr.setOperator(2) // OVER

    // 1) Glass fill — AA (smooth silhouette).
    cr.save()
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, r, side, aw, arrowH, tipR)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, alpha)
    cr.fill()
    cr.restore()

    // 2) Inner edge — clip to the silhouette, then stroke it at double width so
    //    only the inner ~1px survives the clip (no outer AA spilling onto glass).
    cr.save()
    cr.setAntialias(1) // NONE for a crisp clip
    bubblePath(cr, bx, by, bw, bh, r, side, aw, arrowH, tipR)
    cr.clip()
    cr.setAntialias(2) // AA for a smooth stroke
    bubblePath(cr, bx, by, bw, bh, r, side, aw, arrowH, tipR)
    cr.setLineWidth(BORDER_W * 2)
    if (dark) cr.setSourceRGBA(1, 1, 1, 0.16)   // 1px inner white edge on dark glass
    else      cr.setSourceRGBA(0, 0, 0, 0.12)   // subtle dark rim for definition on light glass
    cr.stroke()
    cr.restore()
}

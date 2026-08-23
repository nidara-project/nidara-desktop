import Cairo from "gi://cairo"
import GdkPixbuf from "gi://GdkPixbuf"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { GLASS_TINT, GLASS_SPECULAR } from "../../lib/tokens"

/** The single hex → Cairo-float conversion point. It now lives beside the accent
 *  palette in `ui/lib/accent.ts`, because the kit's slider paints the accent and a
 *  component in `ui/lib/` may not import from `ui/shell/`; re-exported here so the
 *  shell's five Cairo painters keep their import path. Always go through it, never
 *  re-derive r/g/b by hand — two call sites (Slider.ts, battery.ts) had drifted into
 *  hardcoding their OWN float copies of a color instead of parsing the real hex live. */
export { hexToFloatRgb } from "../../lib/accent"

// Reusable path generator for clipping or drawing
export const createSquirclePath = (
    cr: any,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    n: number = 3.2,
    perfect: boolean = false,
    offset: number = 0
) => {
    // REAL OFFSET LOGIC: BOX defined by (x, y, w, h)
    // Positive offset grows box outward, Negative offset shrinks box inward.
    const ox = x - offset
    const oy = y - offset
    const ow = w + (offset * 2)
    const oh = h + (offset * 2)

    // The visual radius must be adjusted by the same offset to maintain curvature intent
    const rd = Math.max(0, r + offset)

    const safe_rd = Math.min(rd, Math.min(ow, oh) / 2)

    if (perfect) {
        // GEOMETRIC PILL 💊 (Standard Arcs)
        cr.arc(ox + ow - safe_rd, oy + safe_rd, safe_rd, -Math.PI / 2, 0) // TR
        cr.lineTo(ox + ow, oy + oh - safe_rd)
        cr.arc(ox + ow - safe_rd, oy + oh - safe_rd, safe_rd, 0, Math.PI / 2) // BR
        cr.lineTo(ox + safe_rd, oy + oh)
        cr.arc(ox + safe_rd, oy + oh - safe_rd, safe_rd, Math.PI / 2, Math.PI) // BL
        cr.lineTo(ox, oy + safe_rd)
        cr.arc(ox + safe_rd, oy + safe_rd, safe_rd, Math.PI, 3 * Math.PI / 2) // TL
        cr.lineTo(ox + ow - safe_rd, oy)
    } else {
        // SQUIRCLE (Superellipse) — Continuous Analytical Cubic Bézier Splines.
        // Replaces polygon chords (stacked straight lineTo segments) with exact continuous
        // cubic Bézier curves (cr.curveTo), for smooth, continuous subpixel rasterization.
        //
        // ⚠️ `a` AND `b` ARE FITTED FOR n = 3.2 AND ONLY FOR n = 3.2. They are the two
        // tangent lengths of the fit; `mid` follows `n`, they do not. The accuracy this
        // comment used to claim ("99.96%, < 0.012px") is true at 3.2 and nowhere else.
        // Max radial error against the true superellipse, at corner radius 32:
        //
        //      n     3.2     3.5     4.0     4.5     5.0
        //      px   0.011   0.054   0.180   0.322   0.466
        //
        // Everything in the shell paints at 3.2 — every island, the overview, the app
        // grid, Prism (which sat at 4.5 until 2026-08-23, carried in by a refactor, and
        // was the one surface visibly off its own silhouette). n = 2 never reaches here:
        // it comes with `perfect`, which is four real arcs. So the fixed pair is right for
        // every caller today — but if you pass a different `n`, refit them (a minimax
        // sweep gets n=4.5 to 0.012px with a≈0.423, b≈0.155) rather than assuming the
        // curve you get is the superellipse you asked for.
        const mid = Math.pow(0.5, 1 / n)
        const a = 0.3100
        const b = 0.1950
        const mx = (1 - mid) * safe_rd
        const my = (1 - mid) * safe_rd

        // Top edge: horizontal straight line to top-right joint
        cr.moveTo(ox + safe_rd, oy)
        cr.lineTo(ox + ow - safe_rd, oy)

        // Top-right Corner: (ox + ow - safe_rd, oy) -> (ox + ow, oy + safe_rd)
        cr.curveTo(
            ox + ow - safe_rd + (a * safe_rd), oy,
            ox + ow - mx - (b * safe_rd), oy + my - (b * safe_rd),
            ox + ow - mx, oy + my
        )
        cr.curveTo(
            ox + ow - mx + (b * safe_rd), oy + my + (b * safe_rd),
            ox + ow, oy + safe_rd - (a * safe_rd),
            ox + ow, oy + safe_rd
        )

        // Right Edge (only if straight segment has positive height)
        if (oh - (2 * safe_rd) > 0.01) {
            cr.lineTo(ox + ow, oy + oh - safe_rd)
        }

        // Bottom-right Corner: (ox + ow, oy + oh - safe_rd) -> (ox + ow - safe_rd, oy + oh)
        cr.curveTo(
            ox + ow, oy + oh - safe_rd + (a * safe_rd),
            ox + ow - mx + (b * safe_rd), oy + oh - my - (b * safe_rd),
            ox + ow - mx, oy + oh - my
        )
        cr.curveTo(
            ox + ow - mx - (b * safe_rd), oy + oh - my + (b * safe_rd),
            ox + ow - safe_rd + (a * safe_rd), oy + oh,
            ox + ow - safe_rd, oy + oh
        )

        // Bottom Edge: horizontal straight line to bottom-left joint
        cr.lineTo(ox + safe_rd, oy + oh)

        // Bottom-left Corner: (ox + safe_rd, oy + oh) -> (ox, oy + oh - safe_rd)
        cr.curveTo(
            ox + safe_rd - (a * safe_rd), oy + oh,
            ox + mx + (b * safe_rd), oy + oh - my + (b * safe_rd),
            ox + mx, oy + oh - my
        )
        cr.curveTo(
            ox + mx - (b * safe_rd), oy + oh - my - (b * safe_rd),
            ox, oy + oh - safe_rd + (a * safe_rd),
            ox, oy + oh - safe_rd
        )

        // Left Edge (only if straight segment has positive height)
        if (oh - (2 * safe_rd) > 0.01) {
            cr.lineTo(ox, oy + safe_rd)
        }

        // Top-left Corner: (ox, oy + safe_rd) -> (ox + safe_rd, oy)
        cr.curveTo(
            ox, oy + safe_rd - (a * safe_rd),
            ox + mx - (b * safe_rd), oy + my + (b * safe_rd),
            ox + mx, oy + my
        )
        cr.curveTo(
            ox + mx + (b * safe_rd), oy + my - (b * safe_rd),
            ox + safe_rd - (a * safe_rd), oy,
            ox + safe_rd, oy
        )
    }
    cr.closePath()
}

/** How dark the FLANK of the rim goes, as `GLASS_TINT.dark` alpha at mid-height.
 *
 *  This is the one number to move if the sides read as too much or too little. It is
 *  a look decision with a physical argument behind it: at the top and bottom you meet
 *  the edge at a grazing angle and it REFLECTS (white, .42 and .24), but at mid-height
 *  you are looking straight THROUGH the edge, so what you should see is the thickness
 *  of the material — dark — not a highlight.
 *
 *  ⚠️ It was white `.08` there until 2026-08-23, which made the flank LIGHTER than the
 *  body it edges (measured over a bright wallpaper: flank 27,149,182 against a body of
 *  7,139,175). The capsule therefore had no dark side at all, which is why it read
 *  flat over pale wallpapers — the contrast the glass needs there has to come from the
 *  edge, because the fill cannot supply it without going opaque.
 *
 *  ⚠️ This reopens #230, which removed a lateral dark contour on the grounds that it
 *  "read as a drawn outline rather than as material". That judgement was made while
 *  `blur:brightness` was still painting a hard dark step along every antialiased edge
 *  (resolved debt #81) — the outline it rejected was partly the artefact. Reopened
 *  deliberately, by the owner, after that was fixed. */
const FLANK_DEPTH = 0.18

/** The 1px inner rim of every glass surface, as a vertical gradient over a box of
 *  `height` starting at `top`. `cx` only fixes the gradient's axis — it is vertical,
 *  so any x on the shape does.
 *
 *  ⚠️ THIS IS THE ONLY COPY OF THESE NUMBERS. `GlassBubble.ts` paints the same rim
 *  with a different technique (clip + double-width stroke, because of its arrow tip)
 *  and used to carry its own byte-identical table of the seven dark stops. #230
 *  unified the SHAPE of the rim and left two copies of the values, which is a
 *  divergence waiting for the next tweak: capsules and bubbles would drift apart one
 *  stop at a time, and only in one mode, which is the kind of thing you see six
 *  months later in a screenshot.
 *
 *  DARK — a seven-stop **Fresnel** ramp:
 *
 *      pos    | 0.0 | .18 | .35 | .50  | .65 | .82 | 1.0
 *      alpha  | .42 | .32 | .16 | .08  | .13 | .19 | .24
 *
 *  An edge reflects most where you meet it at a grazing angle — the top rim (key
 *  light, .42) and the bottom rim (ground bounce, .24) — and least where you look
 *  straight through the glass, the flank at mid-height (.08). **The dip in the
 *  middle is the whole point**: the lateral dark contour it replaced was faking the
 *  same effect by painting black down the sides, which read as a drawn outline
 *  rather than as material.
 *
 *  LIGHT — four stops, and a different idea: a white specular top fading into a
 *  dark lower rim, because on light glass the thing that needs defining is the
 *  BOTTOM edge against the content below it. `GlassBubble` does not share this half
 *  (it paints one flat `GLASS_TINT.dark` edge at .12); that divergence is deliberate
 *  and unifying it is a visual decision, not a refactor.
 *
 *  The white is `GLASS_SPECULAR`, not `GLASS_TINT.light`: it is the colour of the
 *  light, not of the surface. They were the same token until 2026-08-23, which meant
 *  a retint of light-mode glass would have dimmed the highlight on every dark
 *  capsule in the desktop. */
export const glassRimGradient = (cx: number, top: number, height: number, dark: boolean) => {
    const g = new Cairo.LinearGradient(cx, top, cx, top + height)
    const { r: lr, g: lg, b: lb } = GLASS_SPECULAR
    if (dark) {
        const { r: fr, g: fg, b: fb } = GLASS_TINT.dark
        g.addColorStopRGBA(0.0, lr, lg, lb, 0.42)
        g.addColorStopRGBA(0.16, lr, lg, lb, 0.26)
        g.addColorStopRGBA(0.30, lr, lg, lb, 0.04)
        g.addColorStopRGBA(0.50, fr, fg, fb, FLANK_DEPTH)
        g.addColorStopRGBA(0.70, lr, lg, lb, 0.06)
        g.addColorStopRGBA(0.84, lr, lg, lb, 0.18)
        g.addColorStopRGBA(1.0, lr, lg, lb, 0.24)
    } else {
        const { r: dr, g: dg, b: db } = GLASS_TINT.dark
        g.addColorStopRGBA(0.0, lr, lg, lb, 0.55)
        g.addColorStopRGBA(0.20, lr, lg, lb, 0.25)
        g.addColorStopRGBA(0.50, dr, dg, db, 0.10)
        g.addColorStopRGBA(1.0, dr, dg, db, 0.14)
    }
    return g
}

// Shared drawSquircle utility for consistent visual approach across Dock and CC
export const drawSquircle = (
    cr: any,
    width: number,
    height: number,
    targetW?: number,
    alpha: number = 0.3,
    enableGloss: boolean = false,
    color: { r: number, g: number, b: number } = { r: 1, g: 1, b: 1 }, // Default to white
    cornerRadius?: number, // New parameter for fixed radius
    perfect: boolean = false, // New parameter for geometric pill
    borderColor?: { r: number, g: number, b: number, a: number }, // New: Custom Border
    n: number = 3.2, // Superellipse factor
    borderWidth: number = 1.0, // Isolated border width
    inset: number = 2.5, // Configurable buffer to avoid edge clipping
    dash?: number[], // Optional dash pattern for the border stroke only (CC drag-ghost; real tiles never pass this)
    fillFrac?: number, // Gauge fill: bottom `fillFrac` (0..1) of the shape gets `color`/`alpha`,
                        // the rest gets `emptyColor`/`emptyAlpha` — ONE path, so the border/gloss
                        // below wrap both portions as a single continuous shape (CC slider tiles).
                        // undefined/omitted = fully filled with `color`, i.e. today's behavior.
    emptyColor?: { r: number, g: number, b: number },
    emptyAlpha?: number,
) => {
    if (width <= 0 || height <= 0) return

    // Gtk4 provides a clean surface; OVER is the standard blending mode.
    cr.setOperator(2) // OVER
    cr.setLineJoin(1) // ROUND join — eliminates any sharp miter spikes
    cr.setLineCap(1)  // ROUND cap

    // SAFE DRAW AREA
    const drawH = height - (inset * 2)
    const drawW = (targetW || width) - (inset * 2)
    const x = (width - drawW) / 2
    const y = inset

    // Calculate Radius
    const minDim = Math.min(drawW, drawH)
    let r = cornerRadius ?? (minDim * 0.5)
    if (r > minDim * 0.5) r = minDim * 0.5

    // CAIRO_ANTIALIAS_BEST. ⚠️ MEASURED 2026-08-23: on the image backend this is
    // byte-for-byte identical to ANTIALIAS_GRAY (2) for these shapes — 0 subpixels
    // differ across a full capsule, fill and rim — and costs the same (0.148 vs
    // 0.144 ms per render). Keep it, but do not believe it is buying quality, and do
    // not "fix" a rendering problem by reaching for it: it is already GRAY.
    const AA_QUALITY = 6

    // 1. MAIN GLASS BODY — AA fill, smooth silhouette.
    cr.save()
    cr.setAntialias(AA_QUALITY)
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    if (fillFrac !== undefined && fillFrac < 1) {
        cr.clip()
        const f = Math.max(0, Math.min(1, fillFrac))
        const fillH = drawH * f
        cr.setSourceRGBA(emptyColor?.r ?? color.r, emptyColor?.g ?? color.g, emptyColor?.b ?? color.b, emptyAlpha ?? alpha)
        cr.rectangle(x, y, drawW, drawH - fillH)
        cr.fill()
        cr.setSourceRGBA(color.r, color.g, color.b, alpha)
        cr.rectangle(x, y + (drawH - fillH), drawW, fillH)
        cr.fill()
    } else {
        cr.setSourceRGBA(color.r, color.g, color.b, alpha)
        cr.fill()
    }
    cr.restore()

    // 2. 1PX BORDER & SPECULAR CONTOUR (Clean modern glass rim — single-pass unclipped evaluation)
    cr.save()
    cr.setAntialias(AA_QUALITY)
    const strokeOffset = -borderWidth * 0.5
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, strokeOffset)
    cr.setLineWidth(borderWidth)

    if (borderColor && borderColor.a > 0.3) {
        // Explicit solid border (e.g. hover accent color on bar capsules)
        cr.setSourceRGBA(borderColor.r, borderColor.g, borderColor.b, borderColor.a)
    } else if (enableGloss) {
        // No mode argument reaches here, so the fill is asked what mode it is. Keep
        // GLASS_TINT.light above this threshold (tokens.ts says so too) — below it a
        // light capsule silently takes the dark branch.
        const isDark = !(color && color.r > 0.8 && color.g > 0.8 && color.b > 0.8)
        const cx = x + drawW * 0.5
        cr.setSource(glassRimGradient(cx, y, drawH, isDark))
    } else {
        const baseAlpha = borderColor ? borderColor.a : (borderWidth > 1.0 ? 0.12 : 0.10)
        const baseR = borderColor ? borderColor.r : 1
        const baseG = borderColor ? borderColor.g : 1
        const baseB = borderColor ? borderColor.b : 1
        cr.setSourceRGBA(baseR, baseG, baseB, baseAlpha)
    }

    if (dash) cr.setDash(dash, 0)
    cr.stroke()
    cr.restore()
}

/** Cover-fit scaling with the scaled copy CACHED, for painters that need an image
 *  to fill a box exactly.
 *
 *  Cover-fit = scale so the SHORTER side fills, then centre-crop. `scale_simple`
 *  allocates a whole new pixbuf, so calling it straight from a draw function
 *  re-allocates the image on every frame — every consumer needs the same "only
 *  when the box or the source actually changed" guard, which is what this closure
 *  is. One instance per painter (it holds that painter's cached copy); the
 *  returned function gives back the scaled pixbuf and the offset to paint it at.
 *
 *  Shared by `squircleThumb` and the workspace schematic's wallpaper backdrop. */
export function makeCoverFit() {
    let scaled: any = null
    let src: any = null
    let sw = 0, sh = 0
    return (pixbuf: any, w: number, h: number) => {
        const scale = Math.max(w / pixbuf.get_width(), h / pixbuf.get_height())
        const nw = Math.max(1, Math.round(pixbuf.get_width() * scale))
        const nh = Math.max(1, Math.round(pixbuf.get_height() * scale))
        if (!scaled || src !== pixbuf || sw !== nw || sh !== nh) {
            scaled = pixbuf.scale_simple(nw, nh, GdkPixbuf.InterpType.BILINEAR)
            src = pixbuf; sw = nw; sh = nh
        }
        return { pixbuf: scaled, x: (w - nw) / 2, y: (h - nh) / 2 }
    }
}

import { RADIUS } from "../../lib/tokens"

/** Canonical squircle thumbnail corner ratio (25%, matching macOS icon proportion). */
export const THUMB_RADIUS_RATIO = 0.25

/** A squircle-clipped, cover-fit thumbnail of `pixbuf`, as a `Gtk.DrawingArea`.
 *
 *  Cover-fit (scale so the SHORTER side fills, then centre-crop) rather than
 *  contain: a thumbnail column only reads as a column if every cell is the same
 *  rectangle, and letterboxing a 2560×1440 screenshot next to a square avatar
 *  makes the list look broken. The squircle clip is the same shape language as
 *  every other rounded surface here — GTK4 CSS `border-radius` does NOT clip a
 *  child's rendering, so this is Cairo's job, not the stylesheet's.
 *
 *  The cover-fit copy is cached by `makeCoverFit` and only recomputed when the
 *  allocation actually changes — never scale from inside a draw function without
 *  that guard.
 *
 *  Shared by the notification hero/thumb and the clipboard history rows. */
export function squircleThumb(
    pixbuf: any,
    w: number,
    h: number,
    radius?: number,
    cssClass = "squircle-thumb",
): Gtk.DrawingArea {
    const r = radius ?? Math.max(6, Math.min(RADIUS.md, Math.round(Math.min(w, h) * THUMB_RADIUS_RATIO)))
    const da = new Gtk.DrawingArea({ width_request: w, height_request: h, css_classes: [cssClass] })
    const coverFit = makeCoverFit()
    da.set_draw_func((_da: any, cr: any, dw: number, dh: number) => {
        if (dw <= 0 || dh <= 0) return
        const fit = coverFit(pixbuf, dw, dh)
        cr.save(); createSquirclePath(cr, 0, 0, dw, dh, r, 3.2); cr.clip()
        Gdk.cairo_set_source_pixbuf(cr, fit.pixbuf, fit.x, fit.y); cr.paint(); cr.restore()
    })
    return da
}

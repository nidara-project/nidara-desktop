import Cairo from "gi://cairo"
import GdkPixbuf from "gi://GdkPixbuf"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

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

    if (perfect) {
        // GEOMETRIC PILL 💊 (Standard Arcs)
        const safe_r = Math.min(rd, Math.min(ow, oh) / 2)

        cr.arc(ox + ow - safe_r, oy + safe_r, safe_r, -Math.PI / 2, 0) // TR
        cr.lineTo(ox + ow, oy + oh - safe_r)
        cr.arc(ox + ow - safe_r, oy + oh - safe_r, safe_r, 0, Math.PI / 2) // BR
        cr.lineTo(ox + safe_r, oy + oh)
        cr.arc(ox + safe_r, oy + oh - safe_r, safe_r, Math.PI / 2, Math.PI) // BL
        cr.lineTo(ox, oy + safe_r)
        cr.arc(ox + safe_r, oy + safe_r, safe_r, Math.PI, 3 * Math.PI / 2) // TL
        cr.lineTo(ox + ow - safe_r, oy)
    } else {
        // SQUIRCLE (Superellipse) - UNIFIED rd LOGIC
        // Top edge
        cr.moveTo(ox + rd, oy)
        cr.lineTo(ox + ow - rd, oy)

        // Top-right Corner (t from PI/2 to 0)
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(ox + ow - rd + px, oy + rd - py)
        }

        // Right Edge
        cr.lineTo(ox + ow, oy + oh - rd)

        // Bottom-right Corner (t from 0 to PI/2)
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(ox + ow - rd + px, oy + oh - rd + py)
        }

        // Bottom Edge
        cr.lineTo(ox + rd, oy + oh)

        // Bottom-left Corner (t from PI/2 to 0)
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(ox + rd - px, oy + oh - rd + py)
        }

        // Left Edge
        cr.lineTo(ox, oy + rd)

        // Top-left Corner (t from 0 to PI/2)
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(ox + rd - px, oy + rd - py)
        }
    }
    cr.closePath()
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

    // SAFE DRAW AREA
    const drawH = height - (inset * 2)
    const drawW = (targetW || width) - (inset * 2)
    const x = (width - drawW) / 2
    const y = inset

    // Calculate Radius
    const minDim = Math.min(drawW, drawH)
    let r = cornerRadius ?? (minDim * 0.5)
    if (r > minDim * 0.5) r = minDim * 0.5

    // 1. MAIN GLASS BODY — AA (GRAY) fill, smooth silhouette.
    // Was NONE (hard 1-bit edge) to dodge a feared "halo": Hyprland blurs any pixel
    // with alpha > ignore_alpha (0.01), so AA edge pixels (alpha = glass_alpha ×
    // coverage) show the blurred backdrop and were thought to glow at the curve.
    // Re-evaluated 2026-06-24 on real + worst-case LIGHT wallpapers: the halo is
    // negligible (the soft edge just blends into its surroundings) while NONE's
    // stair-stepped curves are clearly visible. AA chosen. Steps 2-3 still clip to
    // the path so their inner GRAY AA can't spill onto the transparent region.
    cr.save()
    cr.setAntialias(2) // GRAY (AA)
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

    // 2. BASE BORDER — GRAY stroke inside an AA clip
    cr.save()
    cr.setAntialias(2) // GRAY for smooth AA clip
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    cr.clip()
    const strokeOffset = -borderWidth // fully inset: outer edge at -borderWidth/2, AA can't reach glass boundary
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, strokeOffset)
    cr.setLineWidth(borderWidth)
    const baseAlpha = borderColor ? borderColor.a : (borderWidth > 1.0 ? 0.12 : 0.10)
    const baseR = borderColor ? borderColor.r : 1
    const baseG = borderColor ? borderColor.g : 1
    const baseB = borderColor ? borderColor.b : 1
    cr.setSourceRGBA(baseR, baseG, baseB, baseAlpha)
    if (dash) cr.setDash(dash, 0)
    cr.stroke()
    cr.restore()

    // 3. SPECULAR RIMS, FRESNEL EDGES & BEVEL HIGHLIGHTS — inside AA clip
    if (enableGloss) {
        cr.save()
        cr.setAntialias(2) // GRAY for smooth AA clip
        createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
        cr.clip()

        const rimIntensity = borderWidth > 1.0 ? 0.36 : 0.28
        const cx = x + drawW * 0.5
        const cy = y + drawH * 0.5

        // A) TOP INNER BEVEL BLOOM: Subtle diffuse highlight inside the top edge (2-4px)
        // simulating the physical thickness and frosted bevel of real glass.
        const bloomH = Math.min(4.0, Math.max(2.0, drawH * 0.12))
        const topBloom = new Cairo.LinearGradient(cx, y, cx, y + bloomH)
        topBloom.addColorStopRGBA(0.0, 0.95, 0.97, 1.0, rimIntensity * 0.20)
        topBloom.addColorStopRGBA(1.0, 0.95, 0.97, 1.0, 0.0)
        cr.rectangle(x, y, drawW, bloomH)
        cr.setSource(topBloom)
        cr.fill()

        // B) BOTTOM INNER BEVEL BLOOM: Symmetrical diffuse highlight inside the bottom edge (2-4px)
        const botBloom = new Cairo.LinearGradient(cx, y + drawH, cx, y + drawH - bloomH)
        botBloom.addColorStopRGBA(0.0, 0.95, 0.97, 1.0, rimIntensity * 0.20)
        botBloom.addColorStopRGBA(1.0, 0.95, 0.97, 1.0, 0.0)
        cr.rectangle(x, y + drawH - bloomH, drawW, bloomH)
        cr.setSource(botBloom)
        cr.fill()

        // C) 1PX CONTOUR STROKES: Symmetrical horizontal glass rims + dark lateral contour
        createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, -0.5)
        cr.setLineWidth(1.0)

        // 1. Top rim: bright highlight dropping off smoothly toward the upper curves
        const reach = Math.min(16.0, drawH * 0.45)
        const rimTop = new Cairo.LinearGradient(cx, y, cx, y + reach)
        rimTop.addColorStopRGBA(0.0, 0.96, 0.98, 1.0, rimIntensity)
        rimTop.addColorStopRGBA(1.0, 0.96, 0.98, 1.0, 0.0)
        cr.setSource(rimTop)
        cr.strokePreserve()

        // 2. Bottom rim: symmetrical bright highlight dropping off smoothly toward lower curves
        const rimBot = new Cairo.LinearGradient(cx, y + drawH, cx, y + drawH - reach)
        rimBot.addColorStopRGBA(0.0, 0.96, 0.98, 1.0, rimIntensity)
        rimBot.addColorStopRGBA(1.0, 0.96, 0.98, 1.0, 0.0)
        cr.setSource(rimBot)
        cr.strokePreserve()

        // 3. Lateral rims: dark 1px contour stroke along left and right curved edges
        // creating the continuous light-and-shade rim without darkening the glass body.
        const sideReach = Math.min(24.0, Math.max(8.0, drawW * 0.10))
        const rimSides = new Cairo.LinearGradient(x, cy, x + drawW, cy)
        const leftStop = Math.max(0.01, sideReach / drawW)
        const rightStop = Math.min(0.99, 1.0 - sideReach / drawW)
        const darkRimAlpha = 0.22
        rimSides.addColorStopRGBA(0.0, 0, 0, 0, darkRimAlpha)
        rimSides.addColorStopRGBA(leftStop, 0, 0, 0, 0.0)
        rimSides.addColorStopRGBA(rightStop, 0, 0, 0, 0.0)
        rimSides.addColorStopRGBA(1.0, 0, 0, 0, darkRimAlpha)
        cr.setSource(rimSides)
        cr.stroke()

        cr.restore()
    }
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

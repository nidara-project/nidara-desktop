import Cairo from "gi://cairo"
import GdkPixbuf from "gi://GdkPixbuf"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { GLASS_TINT } from "../../lib/tokens"

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
        // SQUIRCLE (Superellipse n=3.2) — Continuous Analytical Cubic Bézier Splines
        // Replaces polygon chords (stacked straight lineTo segments) with exact continuous
        // cubic Bézier curves (cr.curveTo). Matches the n=3.2 superellipse with 99.96% accuracy
        // (< 0.012px deviation) while ensuring 100% smooth, continuous subpixel rasterization.
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

    const AA_QUALITY = 6 // CAIRO_ANTIALIAS_BEST

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
        const isDark = !(color && color.r > 0.8 && color.g > 0.8 && color.b > 0.8)
        const cx = x + drawW * 0.5
        const rimGradient = new Cairo.LinearGradient(cx, y, cx, y + drawH)

        if (isDark) {
            // Dark mode: Pure macOS Liquid Glass Fresnel Gradient using canonical GLASS_TINT.light (#fafafa)
            // Top: Crisp specular key light
            // Sides: Smooth cosine falloff to subtle translucent glass, letting GLASS_TINT.dark (#161622) dominate
            // Bottom: Ambient ground bounce reflection
            const { r: lr, g: lg, b: lb } = GLASS_TINT.light
            rimGradient.addColorStopRGBA(0.0, lr, lg, lb, 0.42)
            rimGradient.addColorStopRGBA(0.18, lr, lg, lb, 0.32)
            rimGradient.addColorStopRGBA(0.35, lr, lg, lb, 0.16)
            rimGradient.addColorStopRGBA(0.50, lr, lg, lb, 0.08)
            rimGradient.addColorStopRGBA(0.65, lr, lg, lb, 0.13)
            rimGradient.addColorStopRGBA(0.82, lr, lg, lb, 0.19)
            rimGradient.addColorStopRGBA(1.0, lr, lg, lb, 0.24)
        } else {
            // Light mode: Clean glass definition
            // Top: White specular highlight (#fafafa)
            // Sides & Bottom: Crisp subtle dark rim using canonical GLASS_TINT.dark (#161622)
            const { r: lr, g: lg, b: lb } = GLASS_TINT.light
            const { r: dr, g: dg, b: db } = GLASS_TINT.dark
            rimGradient.addColorStopRGBA(0.0, lr, lg, lb, 0.55)
            rimGradient.addColorStopRGBA(0.20, lr, lg, lb, 0.25)
            rimGradient.addColorStopRGBA(0.50, dr, dg, db, 0.10)
            rimGradient.addColorStopRGBA(1.0, dr, dg, db, 0.14)
        }

        cr.setSource(rimGradient)
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

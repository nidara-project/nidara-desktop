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

/** The glass primitives — silhouette, Fresnel rim ramp, drop shadow — moved to
 *  `ui/lib/glass-paint.ts` on 2026-08-24 so the GREETER and the LOCKSCREEN can paint the
 *  same glass. They could not before: `ui/lib/` may not import from `ui/shell/`, so
 *  `ui/lib/glass-capsule.ts` had a flat rim and no shadow, and the #234–#248 wave landed
 *  on two thirds of the desktop. Re-exported here so every shell painter's import path
 *  is unchanged; read that file's header before touching the numbers. */
export {
    squircleCorner, createSquirclePath, glassRimGradient,
    drawGlassShadow, drawShadowFromPath,
} from "../../lib/glass-paint"
// `export … from` re-exports without binding locally, and `drawSquircle` /
// `squircleThumb` below still CALL two of these — hence the second line.
import { createSquirclePath, glassRimGradient } from "../../lib/glass-paint"

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
        // 🔑 No mode argument reaches here, and since the ramp was unified none is needed.
        // This used to sniff the mode out of the FILL COLOUR — `color.r > 0.8 && …` — with
        // a warning attached that `GLASS_TINT.light` had to stay above that threshold or a
        // light capsule would silently take the dark branch. One ramp deletes the guess and
        // the footgun with it.
        const cx = x + drawW * 0.5
        cr.setSource(glassRimGradient(cx, y, drawH, r))
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

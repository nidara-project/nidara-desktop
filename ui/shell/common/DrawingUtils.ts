import Cairo from "gi://cairo"

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

    // 2. BASE BORDER — GRAY stroke inside a NONE hard clip
    cr.save()
    cr.setAntialias(1) // NONE for clip
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    cr.clip()
    cr.setAntialias(2) // GRAY for smooth stroke inside clip
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

    // 3. SPECULAR RIMS — GRAY strokes inside NONE clip, only when gloss is enabled
    if (enableGloss) {
        cr.save()
        cr.setAntialias(1) // NONE for clip
        createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
        cr.clip()
        cr.setAntialias(2) // GRAY for smooth rim strokes inside clip
        createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, -0.5)
        cr.setLineWidth(1.0)

        const rimIntensity = borderWidth > 1.0 ? 0.4 : 0.3
        const cx = x + drawW * 0.5

        // Top rim: top edge → center, bright highlight
        const rimTop = new Cairo.LinearGradient(cx, y, cx, y + drawH * 0.5)
        rimTop.addColorStopRGBA(0.0, 1, 1, 1, rimIntensity)
        rimTop.addColorStopRGBA(1.0, 1, 1, 1, 0.0)
        cr.setSource(rimTop)
        cr.strokePreserve()

        // Bottom rim: subtle reflected light
        const rimBot = new Cairo.LinearGradient(cx, y + drawH, cx, y + drawH * 0.5)
        rimBot.addColorStopRGBA(0.0, 1, 1, 1, rimIntensity * 0.35)
        rimBot.addColorStopRGBA(1.0, 1, 1, 1, 0.0)
        cr.setSource(rimBot)
        cr.stroke()

        cr.restore()
    }
}

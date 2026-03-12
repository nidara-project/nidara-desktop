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
    inset: number = 2.5 // Configurable buffer to avoid edge clipping
) => {
    if (width <= 0 || height <= 0) return

    // CLEAR BUFFER
    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // SAFE DRAW AREA
    const drawH = height - (inset * 2)
    const drawW = (targetW || width) - (inset * 2)
    const x = (width - drawW) / 2
    const y = inset

    // Calculate Radius
    const minDim = Math.min(drawW, drawH)
    let r = cornerRadius ?? (minDim * 0.5)
    if (r > minDim * 0.5) r = minDim * 0.5

    cr.setAntialias(3)

    // 1. MAIN GLASS BODY (Inner-aligned)
    cr.save()
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, -0.5)
    cr.setSourceRGBA(color.r, color.g, color.b, alpha)
    cr.fill()
    cr.restore()

    // 2. BASE BORDER (INNER STROKE LOGIC)
    cr.save()
    const strokeOffset = -borderWidth / 2
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, strokeOffset)
    cr.setLineWidth(borderWidth)

    if (borderColor) {
        cr.setSourceRGBA(borderColor.r, borderColor.g, borderColor.b, borderColor.a)
    } else {
        const intensity = borderWidth > 1.0 ? 0.25 : 0.20
        const lg = new Cairo.LinearGradient(x, y, x + drawW, y + drawH)
        lg.addColorStopRGBA(0.0, 1, 1, 1, intensity)
        lg.addColorStopRGBA(0.4, 1, 1, 1, 0.05)
        lg.addColorStopRGBA(0.6, 1, 1, 1, 0.05)
        lg.addColorStopRGBA(1.0, 1, 1, 1, intensity)
        cr.setSource(lg)
    }
    cr.stroke()
    cr.restore()

    // 3. SPECULAR RIMS (Symmetric Tahoe Edges 💎)
    cr.save()
    const rimOffset = -0.5
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, rimOffset)
    cr.setLineWidth(1.0)

    const rimIntensity = borderWidth > 1.0 ? 0.4 : 0.3
    const rimGradTL = new Cairo.LinearGradient(x, y, x + (drawW * 0.5), y + (drawH * 0.5))
    rimGradTL.addColorStopRGBA(0.0, 1, 1, 1, rimIntensity)
    rimGradTL.addColorStopRGBA(0.4, 1, 1, 1, 0.0)
    cr.setSource(rimGradTL)
    cr.strokePreserve()

    const rimGradBR = new Cairo.LinearGradient(x + drawW, y + drawH, x + (drawW * 0.5), y + (drawH * 0.5))
    rimGradBR.addColorStopRGBA(0.0, 1, 1, 1, rimIntensity)
    rimGradBR.addColorStopRGBA(0.4, 1, 1, 1, 0.0)
    cr.setSource(rimGradBR)
    cr.stroke()

    cr.restore()
}

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
    const rd = Math.max(0, r + offset)

    if (perfect) {
        // GEOMETRIC PILL 💊 (Standard Arcs)
        const insX = 1
        const insY = 1
        const r_eff = Math.max(0, r + offset)
        const safe_r = Math.min(r_eff, Math.min(w - insX * 2, h - insY * 2) / 2)

        const x1 = x + insX
        const y1 = y + insY
        const w1 = w - insX * 2
        const h1 = h - insY * 2

        cr.arc(x1 + w1 - safe_r, y1 + safe_r, safe_r, -Math.PI / 2, 0) // TR
        cr.lineTo(x1 + w1, y1 + h1 - safe_r)
        cr.arc(x1 + w1 - safe_r, y1 + h1 - safe_r, safe_r, 0, Math.PI / 2) // BR
        cr.lineTo(x1 + safe_r, y1 + h1)
        cr.arc(x1 + safe_r, y1 + h1 - safe_r, safe_r, Math.PI / 2, Math.PI) // BL
        cr.lineTo(x1, y1 + safe_r)
        cr.arc(x1 + safe_r, y1 + safe_r, safe_r, Math.PI, 3 * Math.PI / 2) // TL
        cr.lineTo(x1 + w1 - safe_r, y1)
    } else {
        // SQUIRCLE (Superellipse)
        cr.moveTo(x + r, y - offset)
        cr.lineTo(x + w - r, y - offset)

        // Top-right Corner
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + w - r + px, y + r - py)
        }

        // Right Edge
        cr.lineTo(x + w + offset, y + h - r)

        // Bottom-right Corner
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + w - r + px, y + h - r + py)
        }

        // Bottom Edge
        cr.lineTo(x + w - r, y + h + offset)
        cr.lineTo(x + r, y + h + offset)

        // Bottom-left Corner
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + h - r + py)
        }

        // Left Edge
        cr.lineTo(x - offset, y + r)

        // Top-left Corner
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + r - py)
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
    borderWidth: number = 1.0 // Isolated border width
) => {
    if (width <= 0 || height <= 0) return

    // CLEAR BUFFER
    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // SAFE MARGINS: 3.0px is the optimal buffer to prevent rectangular edge clipping ("rectas")
    const margin = 3.0
    const drawH = height - (margin * 2)
    const drawW = (targetW || width) - (margin * 2)
    const x = (width - drawW) / 2
    const y = margin

    // Calculate Radius
    const minDim = Math.min(drawW, drawH)
    let r = cornerRadius ?? (minDim * 0.5)
    if (r > minDim * 0.5) r = minDim * 0.5

    cr.setAntialias(3)

    // 1. MAIN GLASS BODY
    cr.save()
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    cr.setSourceRGBA(color.r, color.g, color.b, alpha)
    cr.fill()
    cr.restore()

    // 2. BASE BORDER
    cr.save()
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    cr.setLineWidth(borderWidth)

    if (borderColor) {
        cr.setSourceRGBA(borderColor.r, borderColor.g, borderColor.b, borderColor.a)
    } else {
        const intensityTL = borderWidth > 1.0 ? 0.35 : 0.25
        const intensityBR = borderWidth > 1.0 ? 0.2 : 0.1
        const lg = new Cairo.LinearGradient(x, y, x + drawW, y + drawH)
        lg.addColorStopRGBA(0.0, 1, 1, 1, intensityTL)
        lg.addColorStopRGBA(0.4, 1, 1, 1, 0.05)
        lg.addColorStopRGBA(0.6, 1, 1, 1, 0.05)
        lg.addColorStopRGBA(1.0, 1, 1, 1, intensityBR)
        cr.setSource(lg)
    }
    cr.stroke()
    cr.restore()

    // 3. SPECULAR RIM (Tahoe Edge)
    cr.save()
    createSquirclePath(cr, x, y, drawW, drawH, r, n, perfect, 0)
    cr.setLineWidth(1.0)
    const rimIntensity = borderWidth > 1.0 ? 0.65 : 0.45
    const rimGrad = new Cairo.LinearGradient(x, y, x + (drawW * 0.6), y + (drawH * 0.6))
    rimGrad.addColorStopRGBA(0.0, 1, 1, 1, rimIntensity)
    rimGrad.addColorStopRGBA(0.4, 1, 1, 1, 0.1)
    rimGrad.addColorStopRGBA(1.0, 1, 1, 1, 0.0)
    cr.setSource(rimGrad)
    cr.stroke()
    cr.restore()
}

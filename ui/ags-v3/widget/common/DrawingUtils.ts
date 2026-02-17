import Cairo from "gi://cairo"

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
    borderColor?: { r: number, g: number, b: number, a: number } // New: Custom Border
) => {
    if (width <= 0 || height <= 0) return

    // CLEAR BUFFER
    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // SAFE MARGINS
    const marginY = 0
    const marginX = 12
    const drawH = height - (marginY * 2)
    const drawW = (targetW || width)
    const x = (width - drawW) / 2
    const y = marginY

    // Calculate Radius: Use provided cornerRadius, or default to "Pill" (half min dim)
    const minDim = Math.min(drawW, drawH)
    let r = cornerRadius ?? (minDim * 0.5)

    // Safety clamp (can't be larger than half the smallest side to avoid self-intersection)
    if (r > minDim * 0.5) r = minDim * 0.5

    const n = 3.2 // Superellipse exponent for G2/G3 continuous "Squircle" curvature

    cr.setAntialias(3)
    const path = (d = 0) => {
        cr.newPath()

        if (perfect) {
            // GEOMETRIC PILL 💊 (Standard Arcs)
            // V461: Added 1px inset (marginX=1, marginY=1) to prevent edge clipping
            const insX = 1
            const insY = 1
            const r_eff = Math.max(0, r + d)
            const safe_r = Math.min(r_eff, Math.min(drawW - insX * 2, drawH - insY * 2) / 2)

            const x1 = x + insX
            const y1 = y + insY
            const w1 = drawW - insX * 2
            const h1 = drawH - insY * 2

            // Standard Rounded Rect with explicit lineTo for robustness 🛡️
            // V462: Standard Order TR -> BR -> BL -> TL
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
            const rd = Math.max(0, r + d)
            // Top Edge
            cr.moveTo(x + r, y - d)
            cr.lineTo(x + drawW - r, y - d)

            // Top-right Corner
            for (let i = 64; i >= 0; i--) {
                let t = (i / 64) * (Math.PI / 2)
                let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
                let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
                cr.lineTo(x + drawW - r + px, y + r - py)
            }

            // Right Edge
            cr.lineTo(x + drawW + d, y + drawH - r)

            // Bottom-right Corner
            for (let i = 0; i <= 64; i++) {
                let t = (i / 64) * (Math.PI / 2)
                let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
                let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
                cr.lineTo(x + drawW - r + px, y + drawH - r + py)
            }

            // Bottom Edge
            cr.lineTo(x + drawW - r, y + drawH + d)
            cr.lineTo(x + r, y + drawH + d)

            // Bottom-left Corner
            for (let i = 64; i >= 0; i--) {
                let t = (i / 64) * (Math.PI / 2)
                let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
                let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
                cr.lineTo(x + r - px, y + drawH - r + py)
            }

            // Left Edge
            cr.lineTo(x - d, y + r)

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

    // 1. CLEAN GLASS BODY
    path()
    if (enableGloss) {
        // Softened Linear Gradient for "Glass" Look
        const pattern = new Cairo.LinearGradient(x, y, x, y + drawH)
        pattern.addColorStopRGBA(0, color.r, color.g, color.b, alpha + 0.10) // Top: Brighter
        pattern.addColorStopRGBA(1, color.r, color.g, color.b, alpha - 0.05) // Bottom: Translucent
        cr.setSource(pattern)
    } else {
        cr.setSourceRGBA(color.r, color.g, color.b, alpha)
    }
    cr.fill()

    // 2. BORDER (Custom or Gloss)
    if (borderColor) {
        path() // default d=0, maybe strict border?
        // Stitch suggested 0.5px, but Cairo often renders <1px poorly without careful alignment. 
        // 1px is safer.
        cr.setLineWidth(1)
        cr.setSourceRGBA(borderColor.r, borderColor.g, borderColor.b, borderColor.a)
        cr.stroke()
    } else if (enableGloss) {
        // Legacy Gloss Border
        path()
        const borderPat = new Cairo.LinearGradient(x, y, x, y + drawH)
        borderPat.addColorStopRGBA(0, 1, 1, 1, 0.4)   // Top Edge: Highlight
        borderPat.addColorStopRGBA(0.5, 1, 1, 1, 0.05) // Middle: Faded
        borderPat.addColorStopRGBA(1, 1, 1, 1, 0.0)   // Bottom: Gone

        cr.setLineWidth(1)
        cr.setSource(borderPat)
        cr.stroke()
    }
}

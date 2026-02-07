import Cairo from "gi://cairo"

export const drawSquircle = (cr: any, width: number, height: number, targetW?: number) => {
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

    const r = drawH * 0.44
    const n = 3.2

    cr.setAntialias(3)
    const path = (d = 0) => {
        const rd = Math.max(0, r + d)
        cr.newPath()
        cr.moveTo(x + r, y - d)
        cr.lineTo(x + drawW - r, y - d)

        // Top-right
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + drawW - r + px, y + r - py)
        }
        // Bottom-right
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + drawW - r + px, y + drawH - r + py)
        }

        cr.lineTo(x + r, y + drawH + d)

        // Bottom-left
        for (let i = 64; i >= 0; i--) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + drawH - r + py)
        }
        // Top-left
        for (let i = 0; i <= 64; i++) {
            let t = (i / 64) * (Math.PI / 2)
            let px = rd * Math.pow(Math.abs(Math.cos(t)), 2 / n)
            let py = rd * Math.pow(Math.abs(Math.sin(t)), 2 / n)
            cr.lineTo(x + r - px, y + r - py)
        }
        cr.closePath()
    }

    cr.setOperator(0); cr.paint(); cr.setOperator(2)

    // 1. CLEAN OUTER SHADOW
    cr.save()
    cr.rectangle(0, 0, width, height)
    path()
    cr.setFillRule(1)
    cr.clip()

    cr.save()
    cr.translate(0, 4)
    path(4)
    cr.setSourceRGBA(0, 0, 0, 0.04)
    cr.fill()
    cr.restore()
    cr.restore()


    // 3. (COMPLETED BY CSS) - Base Background

    // 4. GLASS GLOSS OVERLAY (The Sophisticated Highlight)
    // @ts-ignore
    const gradient = new Cairo.LinearGradient(x, y, x, y + drawH)
    gradient.addColorStopRGBA(0, 1, 1, 1, 0.18) // Soft light from top
    gradient.addColorStopRGBA(1, 1, 1, 1, 0.08) // Fading towards bottom
    path()
    cr.setSource(gradient)
    cr.fill()


    // 4. SPECULAR HIGHLIGHT (Glass Edge)
    cr.save()
    cr.translate(0, 1) // 1px Top inset
    path(0)
    cr.clip()

    // @ts-ignore
    const rimGrad = new Cairo.LinearGradient(x, y, x, y + 2)
    rimGrad.addColorStopRGBA(0, 1, 1, 1, 0.75) // More vibrant top edge
    rimGrad.addColorStopRGBA(1, 1, 1, 1, 0.0)

    cr.setSource(rimGrad)
    cr.setLineWidth(2.0)
    cr.stroke()
    cr.restore()

    // 5. M3 RIM LIGHT (Full path definition)
    path()
    cr.setSourceRGBA(1, 1, 1, 0.3)
    cr.setLineWidth(0.7)
    cr.stroke()

    // 6. BOTTOM DEFINITION (Anchor)
    cr.moveTo(x + r, y + drawH)
    cr.lineTo(x + drawW - r, y + drawH)
    cr.setSourceRGBA(0, 0, 0, 0.15)
    cr.setLineWidth(0.5)
    cr.stroke()
}

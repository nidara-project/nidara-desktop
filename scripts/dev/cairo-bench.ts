// cairo-bench.ts — where does a glass surface's Cairo time actually GO?
//
//   scripts/bundle.sh --js scripts/dev/cairo-bench.ts /tmp/cairo-bench.js
//   gjs -m /tmp/cairo-bench.js
//
// Splits one drawSquircle into its three costs so a proposal can name which one it
// attacks: PATH construction (JS + GJS→cairo binding crossings), FILL (pixman
// rasterisation of the area), and RIM (gradient + stroke). Plus two controls: a
// plain rectangle fill of the same area (rasterisation floor) and a cached-surface
// replay (what a memoised capsule would cost instead).
import Cairo from "gi://cairo"
import GLib from "gi://GLib"
import { createSquirclePath, drawSquircle, glassRimGradient } from "../../ui/shell/common/DrawingUtils"
import { GLASS_TINT } from "../../ui/lib/tokens"

const now = () => GLib.get_monotonic_time() / 1000  // ms

function bench(label: string, n: number, fn: () => void) {
    for (let i = 0; i < Math.min(50, n); i++) fn()   // warm
    const t0 = now()
    for (let i = 0; i < n; i++) fn()
    const dt = now() - t0
    print(`${label.padEnd(38)} ${(dt / n).toFixed(4)} ms/op   (${n} ops, ${dt.toFixed(1)} ms)`)
    return dt / n
}

const specimens = [
    { name: "dock capsule 1200x92 r32", w: 1200, h: 92, r: 32 },
    { name: "CC panel     356x610 r24", w: 356, h: 610, r: 24 },
    { name: "CC tile       160x88 r18", w: 160, h: 88, r: 18 },
    { name: "island pill    420x44 r22", w: 420, h: 44, r: 22 },
]

const tint = GLASS_TINT.dark
const border = { r: 1, g: 1, b: 1, a: 0.12 }

for (const s of specimens) {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, s.w, s.h)
    const cr = new Cairo.Context(surf) as any
    const N = 300
    print(`\n=== ${s.name}  (${(s.w * s.h / 1000).toFixed(0)}k px) ===`)

    bench("path only (no paint)", N, () => {
        createSquirclePath(cr, 0, 0, s.w, s.h, s.r, 3.2, false, 0)
        cr.newPath()
    })
    bench("path + solid fill", N, () => {
        createSquirclePath(cr, 0, 0, s.w, s.h, s.r, 3.2, false, 0)
        cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55)
        cr.fill()
    })
    bench("rect fill (raster floor)", N, () => {
        cr.rectangle(0, 0, s.w, s.h)
        cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55)
        cr.fill()
    })
    bench("gradient object only", N, () => {
        glassRimGradient(s.w / 2, 0, s.h, s.r)
    })
    bench("path + rim stroke only", N, () => {
        createSquirclePath(cr, 0, 0, s.w, s.h, s.r, 3.2, false, -0.5)
        cr.setLineWidth(1)
        cr.setSource(glassRimGradient(s.w / 2, 0, s.h, s.r))
        cr.stroke()
    })
    const full = bench("FULL drawSquircle (gloss)", N, () => {
        drawSquircle(cr, s.w, s.h, undefined, 0.55, true, tint, undefined, false, border, 3.2, 1.0, 0)
    })

    // Control: what a memoised capsule would cost to blit back.
    const cache = new Cairo.ImageSurface(Cairo.Format.ARGB32, s.w, s.h)
    const ccr = new Cairo.Context(cache) as any
    drawSquircle(ccr, s.w, s.h, undefined, 0.55, true, tint, undefined, false, border, 3.2, 1.0, 0)
    const cached = bench("cached surface replay", N, () => {
        cr.setSourceSurface(cache, 0, 0)
        cr.paint()
    })
    print(`  → cache would save ${((1 - cached / full) * 100).toFixed(1)}% of this surface's Cairo time`)
}

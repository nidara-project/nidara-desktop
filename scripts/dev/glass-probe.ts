// glass-probe.ts — render the REAL glass painters offscreen and read the pixels.
//
//   scripts/bundle.sh --js scripts/dev/glass-probe.ts /tmp/glass-probe.js
//   gjs -m /tmp/glass-probe.js /tmp/out          # → /tmp/out.png + /tmp/out.txt
//
// Why this exists. The glass tint and the Fresnel rim are NUMBERS — in
// `ui/lib/tokens.ts` and `common/DrawingUtils.ts` — and every question about them
// ("does this retint move anything?", "is the rim still the same ramp?") is really
// a question about PIXELS. Answering it by reading the source is how debt #79
// happened: `GLASS_TINT.light` shipped saying `#fafafa` in its strings while
// handing Cairo pure white, and nothing anywhere rendered the two halves.
//
// It needs no display and no compositor: `drawSquircle` takes a Cairo context, so
// an ImageSurface is a complete stage for it. That is the point — a change to the
// glass can be measured in a second, on any machine.
//
// The `.txt` is the instrument; the PNG is for eyes. Per specimen it dumps two
// traverses, and it takes BOTH to see the whole rim: the centre COLUMN is the axis
// the gradient runs along (top key light → bottom ground bounce), while the
// mid-height ROW is the only place the lateral stops land — the .08 dip at
// mid-flank is the point of the Fresnel ramp and it appears in NEITHER end of the
// column. `diff before.txt after.txt` is then an exact statement of what a change
// did; empty output means the render did not move by one bit.
//
// ⚠️ Specimens are painted over an OPAQUE mid-grey, not over nothing. Glass is
// translucent; over a transparent surface every sample comes back scaled by the
// alpha, which reads as a consistent — and false — result.

import Cairo from "gi://cairo"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import System from "system"
import { drawSquircle } from "../../ui/shell/common/DrawingUtils"
import { GLASS_TINT } from "../../ui/lib/tokens"

const W = 220, H = 64, PAD = 16
const BACKDROP = 0.5   // mid-grey: neither mode gets a flattering ground

// The dock's own capsule call, verbatim (`surfaces/dock/DockAxis.ts`) — a real
// specimen, not an invented one. Its border alpha is below drawSquircle's 0.3
// "explicit border" threshold, so it takes the enableGloss path: this IS the
// Fresnel rim, not a stand-in for it.
const specimens = [
    { name: "dock-capsule-dark",  tint: GLASS_TINT.dark,  alpha: 0.55, border: { r: 1, g: 1, b: 1, a: 0.12 } },
    { name: "dock-capsule-light", tint: GLASS_TINT.light, alpha: 0.55, border: { r: 0, g: 0, b: 0, a: 0.08 } },
]

const out = System.programArgs[0] || "/tmp/glass-probe"
const SW = W + PAD * 2
const SH = (H + PAD) * specimens.length + PAD

const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, SW, SH)
const cr = new Cairo.Context(surf)
cr.setSourceRGB(BACKDROP, BACKDROP, BACKDROP)
cr.paint()

specimens.forEach((s, i) => {
    cr.save()
    cr.translate(PAD, PAD + i * (H + PAD))
    drawSquircle(cr, W, H, undefined, s.alpha, true,
        { r: s.tint.r, g: s.tint.g, b: s.tint.b },
        undefined, false, s.border, 3.2, 1.0, 0)
    cr.restore()
})
surf.flush()

// Read back through GdkPixbuf: it un-premultiplies for us, so the numbers below
// are the colour you would name, not the stored one.
const buf = Gdk.pixbuf_get_from_surface(surf, 0, 0, SW, SH)!
const px = buf.get_pixels()
const stride = buf.get_rowstride()
const nch = buf.get_n_channels()
const at = (x: number, y: number) => {
    const o = y * stride + x * nch
    return `${px[o]} ${px[o + 1]} ${px[o + 2]}`
}

const lines: string[] = []
const cx = PAD + Math.floor(W / 2)
specimens.forEach((s, i) => {
    const oy = PAD + i * (H + PAD)
    lines.push(`# ${s.name}  ${s.tint.hex}  floats=${s.tint.r},${s.tint.g},${s.tint.b}  alpha=${s.alpha}`)
    lines.push(`# centre column x=${cx} — top rim, body, bottom rim`)
    for (let y = 0; y < H; y++) lines.push(`col ${y} ${at(cx, oy + y)}`)
    lines.push(`# mid row y=${Math.floor(H / 2)} — left flank, body, right flank`)
    const my = oy + Math.floor(H / 2)
    for (let x = 0; x < W; x++) lines.push(`row ${x} ${at(PAD + x, my)}`)
    lines.push("")
})

surf.writeToPNG(`${out}.png`)
GLib.file_set_contents(`${out}.txt`, lines.join("\n"))
print(`glass-probe: ${out}.png  ${out}.txt  (${specimens.length} specimens)`)

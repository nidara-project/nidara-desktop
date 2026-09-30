// edge-light-probe.ts — the glass's edge light, side by side, over real backdrops.
//
//   magick defaults/wallpaper/wallpaper.jpg -resize 1920x -gravity north \
//     -crop 640x140+0+0 +repage -blur 0x9 PNG24:/tmp/bg.png        (one per backdrop)
//   scripts/bundle.sh --js scripts/dev/edge-light-probe.ts /tmp/edge.js
//   gjs -m /tmp/edge.js /tmp/out.png /tmp/bg1.png [/tmp/bg2.png …]
//
// One row per backdrop, one column per edge-light variant (the first is none). Each
// cell holds a bar-sized pill with a label and a 2×1 CC capsule with its icon circle and
// title, both on dark glass at `TINT_ALPHA` (no blur threshold offscreen: the edge's
// `clear` is not capped by `EDGE_MIN_ALPHA` here). Printed per cell: the contrast of white text
// against the glass RIGHT BEHIND the label, which the edge light must not move — the
// light belongs to the edge, the contrast to the middle.
//
// ⚠️ The blur is ImageMagick's, not Hyprland's (see rim-backdrop-probe.ts): good for
// judging the look of an edge over a varying backdrop, not the blur itself.

import Cairo from "gi://cairo"
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import System from "system"
import { drawSquircle } from "../../ui/shell/common/DrawingUtils"
import { GLASS_TINT } from "../../ui/lib/nidara-kit/platform/tokens"
import { tintFromBackdrop } from "../../ui/lib/nidara-kit/platform/glass-legibility"

const [outPath, ...bgPaths] = System.programArgs
if (!outPath || bgPaths.length === 0) { print("uso: gjs -m edge.js <salida.png> <fondo.png> [fondo2.png …]"); System.exit(1) }

const TINT_ALPHA = 0.5
const VARIANTS = [
    { name: "sin luz", width: 0, alpha: 0 },
    { name: "media 6/.16", width: 6, alpha: 0.16 },
    { name: "fuerte 8/.26", width: 8, alpha: 0.26 },
    { name: "borde transparente 10 (tinte −70 %, luz .12)", width: 10, alpha: 0.12, clear: 0.7 },
    { name: "transparente + tinte del color del fondo", width: 10, alpha: 0.12, clear: 0.7, tintFromBackdrop: true },
]
const CELL_W = 640, CELL_H = 140, HEAD = 22

const surf = new Cairo.ImageSurface(Cairo.Format.RGB24, CELL_W * VARIANTS.length, HEAD + CELL_H * bgPaths.length)
const cr = new Cairo.Context(surf)
cr.setSourceRGB(0.1, 0.1, 0.1); cr.paint()

const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

const text = (s: string, x: number, y: number, size: number, bold: boolean) => {
    const layout = PangoCairo.create_layout(cr)
    layout.set_font_description(Pango.FontDescription.from_string(`Inter ${bold ? "Bold " : ""}${size}px`))
    layout.set_text(s, -1)
    const [, logical] = layout.get_pixel_extents()
    return { layout, w: logical.width, h: logical.height, draw: () => { cr.moveTo(x, y); PangoCairo.show_layout(cr, layout) } }
}

/** Mean luminance of the glass inside a box, read back from the surface BEFORE the text
 *  is drawn there — so it is the ground the text will sit on. */
const groundLum = (x: number, y: number, w: number, h: number) => {
    surf.flush()
    const pb = Gdk.pixbuf_get_from_surface(surf, x, y, w, h)!
    const px = pb.get_pixels(), rs = pb.get_rowstride(), nc = pb.get_n_channels()
    let sum = 0, n = 0
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const o = j * rs + i * nc
        sum += lum(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255); n++
    }
    return sum / n
}
const contrast = (l: number) => 1.05 / (l + 0.05)

// ── Tint from the backdrop: the kit's rule (`tintFromBackdrop`), fed the mean colour
// of the backdrop under each capsule, as the adaptive glass feeds it live.
const meanOf = (pb: any, x: number, y: number, w: number, h: number) => {
    const px = pb.get_pixels(), rs = pb.get_rowstride(), nc = pb.get_n_channels()
    let r = 0, g = 0, b = 0, n = 0
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        const o = j * rs + i * nc; r += px[o]; g += px[o + 1]; b += px[o + 2]; n++
    }
    return [r / n / 255, g / n / 255, b / n / 255]
}
const tintFor = (pb: any, x: number, y: number, w: number, h: number) => {
    const [r, g, b] = meanOf(pb, x, y, w, h)
    return tintFromBackdrop({ r, g, b })
}

const report: string[] = []
VARIANTS.forEach((v, col) => {
    cr.setSourceRGB(0.85, 0.85, 0.85)
    text(v.name, col * CELL_W + 8, 3, 13, true).draw()
    bgPaths.forEach((bgPath, row) => {
        const ox = col * CELL_W, oy = HEAD + row * CELL_H
        const bg = GdkPixbuf.Pixbuf.new_from_file(bgPath)
        Gdk.cairo_set_source_pixbuf(cr, bg, ox, oy)
        cr.rectangle(ox, oy, CELL_W, CELL_H); cr.fill()
        const barTint = (v as any).tintFromBackdrop ? tintFor(bg, 30, 20, 200, 36) : GLASS_TINT.dark
        const tileTint = (v as any).tintFromBackdrop ? tintFor(bg, 300, 28, 180, 84) : GLASS_TINT.dark

        // A bar-sized pill: 32 tall, label 14 bold.
        cr.save(); cr.pushGroup(); cr.translate(ox + 30, oy + 20)
        drawSquircle(cr, 200, 36, undefined, TINT_ALPHA, true, barTint, undefined, true, undefined, 3.2, 1.0, 2, undefined, undefined, undefined, undefined, v)
        cr.popGroupToSource(); cr.paint()   // the glass on its own layer, as a DrawingArea is
        cr.restore()
        const bar = text("Wi-Fi   18:30", 0, 0, 14, true)
        const bx = ox + 30 + (200 - bar.w) / 2, by = oy + 20 + (36 - bar.h) / 2
        const barL = groundLum(Math.round(bx), Math.round(by + 3), bar.w, bar.h - 6)
        cr.setSourceRGB(1, 1, 1); text("Wi-Fi   18:30", bx, by, 14, true).draw()

        // A 2×1 CC capsule: 176×80, icon circle 44 at 4 + 18 in, title 14 bold.
        cr.save(); cr.pushGroup(); cr.translate(ox + 300, oy + 28)
        drawSquircle(cr, 180, 84, undefined, TINT_ALPHA, true, tileTint, undefined, true, undefined, 3.2, 1.0, 2, undefined, undefined, undefined, undefined, v)
        cr.popGroupToSource(); cr.paint()   // the glass on its own layer, as a DrawingArea is
        cr.restore()
        cr.setSourceRGBA(1, 1, 1, 0.22)
        cr.arc(ox + 300 + 2 + 18 + 22, oy + 28 + 42, 22, 0, 2 * Math.PI); cr.fill()
        const tile = text("Luz nocturna", 0, 0, 14, true)
        const tx = ox + 300 + 2 + 18 + 44 + 8, ty = oy + 28 + 42 - tile.h / 2
        const tileL = groundLum(Math.round(tx), Math.round(ty + 3), tile.w, tile.h - 6)
        cr.setSourceRGB(1, 1, 1); text("Luz nocturna", tx, ty, 14, true).draw()

        report.push(`${v.name.slice(0, 22).padEnd(22)} ${bgPath.split("/").pop()!.padEnd(26)} barra ${contrast(barL).toFixed(2)}:1   pieza ${contrast(tileL).toFixed(2)}:1`)
    })
})

surf.writeToPNG(outPath)
print(report.join("\n"))
print(`→ ${outPath}`)

// rim-backdrop-probe.ts — does the rim survive over a REAL backdrop?
//
//   magick defaults/wallpaper/wallpaper-chroma.jpg -resize 1400x -gravity center \
//     -crop 640x420+0+0 +repage -blur 0x9 -brightness-contrast 0x20 PNG24:/tmp/bg.png
//   scripts/bundle.sh --js scripts/dev/rim-backdrop-probe.ts /tmp/rim.js
//   gjs -m /tmp/rim.js /tmp/bg.png /tmp/out          # → /tmp/out.png + /tmp/out.txt
//
// `glass-probe` paints over an opaque mid-grey on purpose: a flat ground is what makes
// the ramp's own numbers readable. This one asks the opposite question, and it is the
// one that decides whether a rim value is worth anything.
//
// 🔑 A bright blurred wallpaper varies by ~23/255 across a capsule — the SAME order as
// the rim's own contrast against the body it edges (9–14 %). So a rim that measures
// cleanly over flat grey can be invisible over the thing it actually sits on, and no
// amount of flat-ground measuring will ever say so. The backdrop is not a nicety here;
// it is the condition the rim has to beat.
//
// ⚠️ The blur is ImageMagick's, not Hyprland's — an approximation of `size 2, passes 2,
// contrast 1.2` (dual-kawase). Good enough for "does the edge survive a varying
// backdrop", NOT for judging the blur itself. For that, capture the real compositor.

import Cairo from "gi://cairo"
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import GLib from "gi://GLib"
import System from "system"
import { createSquirclePath, glassRimGradient } from "../../ui/shell/common/DrawingUtils"
import { bubblePath, ARROW_W, ARROW_H } from "../../ui/shell/common/GlassBubble"
import { GLASS_TINT, GLASS_SPECULAR } from "../../ui/lib/tokens"

const PATCH = Number(System.programArgs[2] ?? 0)
const bgPath = System.programArgs[0]
const out = System.programArgs[1] || "/tmp/rim-backdrop"
if (!bgPath) { print("uso: gjs -m rim.js <fondo.png> [salida]"); System.exit(1) }
const bg = GdkPixbuf.Pixbuf.new_from_file(bgPath)

/** The LIGHT ramp exactly as it shipped before the unification: four fixed stops, no
 *  radius anywhere, the dark pinned to a single point at 50 %. Kept here and nowhere
 *  else, so the sheet below is a real before/after and not a reconstruction. */
const rampBefore = (cx: number, top: number, height: number, dark: boolean, radius: number) => {
    if (dark) return glassRimGradient(cx, top, height, radius)   // dark did not change
    const g = new Cairo.LinearGradient(cx, top, cx, top + height)
    const { r: lr, g: lg, b: lb } = GLASS_SPECULAR
    const { r: dr, g: dg, b: db } = GLASS_TINT.dark
    g.addColorStopRGBA(0.0, lr, lg, lb, 0.55)
    g.addColorStopRGBA(0.20, lr, lg, lb, 0.25)
    g.addColorStopRGBA(0.50, dr, dg, db, 0.10)
    g.addColorStopRGBA(1.0, dr, dg, db, 0.14)
    return g
}

// Two specimens, because the flank's whole problem is that it follows the RADIUS: the
// dock capsule is short and round (its side is a short straight run), the CC panel is
// tall (its side is nearly the whole silhouette, and it is where the old light ramp
// degenerated into a top-to-bottom fade with nothing at all up top).
const specimens = [
    { name: "cápsula dock", w: 240, h: 92, r: 32 },
    { name: "panel CC",     w: 240, h: 300, r: 24 },
    // El bubble entra aquí porque su canto CLARO era una tercera tabla: `GLASS_TINT.dark`
    // plano a .12, sin gradiente. Ahora toma la rampa común como todo lo demás.
    { name: "bubble menú",  w: 240, h: 120, r: 13, bubble: true },
]
const modes = [
    { name: "oscuro", dark: true,  tint: GLASS_TINT.dark,  border: { r: 1, g: 1, b: 1, a: 0.12 } },
    { name: "claro",  dark: false, tint: GLASS_TINT.light, border: { r: 0, g: 0, b: 0, a: 0.08 } },
]

const PAD = 24
const COLS = 2                                   // antes | después
const cellW = specimens[0].w + PAD * 2
const totalH = specimens.reduce((a, s) => a + s.h + PAD * 2, 0) * modes.length
const SW = cellW * COLS, SH = totalH

const sheet = new Cairo.ImageSurface(Cairo.Format.ARGB32, SW, SH)
const scr = new Cairo.Context(sheet) as any

const lines: string[] = []
const say = (s = "") => { lines.push(s); print(s) }
say(`# fondo: ${bgPath}`)
say(`# efecto del canto: el MISMO píxel con canto / sin canto, sobre el fondo real.`)
say(`# Medido en el tramo RECTO del lado, que es lo que el flanco tiene que oscurecer.`)
say()

let yCursor = 0
let rowIndex = 0
for (const m of modes) {
    for (const sp of specimens) {
        const cellH = sp.h + PAD * 2
        // varía por FILA (para no ver cuatro veces la misma esquina), nunca por columna
        const bgShift = (rowIndex++ * 53) % 90 + PATCH
        const readings: string[][] = [[], []]
        for (let col = 0; col < COLS; col++) {
            const ox = col * cellW, oy = yCursor
            // ⚠️ LAS DOS COLUMNAS MIRAN EL MISMO TROZO DE PARED. Un primer borrador
            // desplazaba el fondo por celda "para que no se leyera como un patrón" y con
            // eso las dos mitades del antes/después dejaban de ser comparables: la fila
            // OSCURA, que no cambia de rampa, leía −13.1 % contra −13.6 % sólo por eso.
            // Esa fila es el control de identidad de esta hoja — si no sale idéntica, lo
            // que estás midiendo es el fondo.
            scr.save()
            scr.rectangle(ox, oy, cellW, cellH); scr.clip()
            Gdk.cairo_set_source_pixbuf(scr, bg, ox - bgShift, oy - bgShift)
            scr.paint(); scr.restore()

            const x = ox + PAD, y = oy + PAD
            const bh2 = (sp as any).bubble ? sp.h - ARROW_H : sp.h
            const path = (target: any, off: number) => (sp as any).bubble
                ? bubblePath(target, x, y, sp.w, bh2, sp.r, "bottom", 0, ARROW_W, ARROW_H, 4, 8, 3.2, off)
                : createSquirclePath(target, x, y, sp.w, sp.h, sp.r, 3.2, false, off)

            // ⚠️ EL CANTO SE MIDE CONTRA SÍ MISMO, no contra el cuerpo de al lado.
            // Un primer borrador comparaba el píxel del canto con uno 9 px hacia dentro,
            // y sobre un fondo con gradiente local esos 9 px ya cambian sin que el rim
            // haga nada: daba +13.8 % sobre el wallpaper oscuro, es decir "el flanco se
            // vuelve claro", que era el FONDO y no el flanco. Se pinta la misma celda dos
            // veces, con canto y sin él, y se compara píxel contra el MISMO píxel.
            const paintCell = (target: any, withRim: boolean) => {
                target.save()
                target.rectangle(ox, oy, cellW, cellH); target.clip()
                Gdk.cairo_set_source_pixbuf(target, bg, ox - bgShift, oy - bgShift)
                target.paint(); target.restore()

                target.save(); target.setAntialias(2)
                path(target, 0)
                target.setSourceRGBA(m.tint.r, m.tint.g, m.tint.b, 0.55)
                target.fill(); target.restore()
                if (!withRim) return

                const flatLightBubble = (sp as any).bubble && !m.dark && col === 0
                target.save(); target.setAntialias(2)
                path(target, -0.5)
                target.setLineWidth(1)
                if (flatLightBubble) target.setSourceRGBA(GLASS_TINT.dark.r, GLASS_TINT.dark.g, GLASS_TINT.dark.b, 0.12)
                else target.setSource(col === 0
                    ? rampBefore(x + sp.w / 2, y, bh2, m.dark, sp.r)
                    : glassRimGradient(x + sp.w / 2, y, bh2, sp.r))
                target.stroke(); target.restore()
            }

            paintCell(scr, true)                       // la hoja que se mira

            const bare = new Cairo.ImageSurface(Cairo.Format.ARGB32, SW, SH)
            const bcr = new Cairo.Context(bare) as any
            paintCell(bcr, false)                      // el mismo sitio, sin canto
            bare.flush(); sheet.flush()

            const read = (surface: any) => {
                const buf = Gdk.pixbuf_get_from_surface(surface, 0, 0, SW, SH)!
                const px = buf.get_pixels(), st = buf.get_rowstride(), nc = buf.get_n_channels()
                return (X: number, Y: number) => {
                    const o = Y * st + X * nc
                    return 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]
                }
            }
            const withRim = read(sheet), noRim = read(bare)
            for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
                const Y = Math.round(y + sp.r + (bh2 - 2 * sp.r) * f)
                const X = Math.round(x)
                readings[col].push(`${((withRim(X, Y) / noRim(X, Y) - 1) * 100).toFixed(1)}%`)
            }
        }
        say(`${m.name.padEnd(7)} ${sp.name.padEnd(14)} antes  ${readings[0].map(v => v.padStart(7)).join("")}`)
        say(`${"".padEnd(7)} ${"".padEnd(14)} DESPUÉS${readings[1].map(v => v.padStart(7)).join("")}`)
        yCursor += cellH
    }
}

sheet.flush()
sheet.writeToPNG(`${out}.png`)
GLib.file_set_contents(`${out}.txt`, lines.join("\n"))
say()
print(`rim-backdrop-probe: ${out}.png  ${out}.txt`)
print(`  columna izquierda = ANTES · derecha = DESPUÉS · filas: oscuro cápsula/panel, claro cápsula/panel`)

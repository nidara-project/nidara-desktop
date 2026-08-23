// bubble-probe.ts — is the bubble the same shape and the same material as the capsule?
//
//   scripts/bundle.sh --js scripts/dev/bubble-probe.ts /tmp/bubble-probe.js
//   gjs -m /tmp/bubble-probe.js /tmp/bubble          # → /tmp/bubble.png + /tmp/bubble.txt
//
// Why this exists. Debt #84 says the bubble's rim is weaker than the capsule's, and
// only on the curves, because `GlassBubble` clips with AA and strokes at 2× while
// `drawSquircle` offsets the path inward and strokes at 1× — an antialiased clip
// MULTIPLIES coverages, so on a curve the result is clip × stroke. It measured that
// as 0 differing pixels on the straight runs and 280 on the corners, max 8/255.
//
// Two things follow that the debt entry does NOT cover, and this probe measures both:
//
//   A. The two shapes are drawn by two different ALGORITHMS. `createSquirclePath`
//      emits four cubic Béziers fitted to the superellipse; `bodyCorner` emits 48
//      straight chords. A chord polyline is INSCRIBED — it always cuts inside the
//      true curve — so the bubble and the capsule do not merely reflect differently,
//      they are not the same silhouette. Specimen A is that difference in pixels.
//
//   B. The rim technique, reproduced on ONE geometry so the two idioms are the only
//      variable. That is the POSITIVE CONTROL: if this probe does not reproduce the
//      debt entry's 0/280/8 it is measuring the wrong thing, and nothing else it
//      prints can be believed.
//
// ⚠️ Specimen A fills WHITE at alpha 1 over BLACK on purpose: the stored byte is then
// the coverage itself, so "pixels differing" is a statement about the silhouette
// rather than about the glass tint. Specimen B keeps #84's mid-grey ground, so its
// numbers are comparable to the ones already written down.

import Cairo from "gi://cairo"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import System from "system"
import { createSquirclePath, glassRimGradient } from "../../ui/shell/common/DrawingUtils"
import { bubblePath, paintGlassBubble, ARROW_W, ARROW_H, BUF } from "../../ui/shell/common/GlassBubble"
import { GLASS_TINT } from "../../ui/lib/tokens"

const out = System.programArgs[0] || "/tmp/bubble-probe"

// Body box shared by every specimen: a real menu bubble's proportions.
const W = 300, H = 100, R = 18, N = 3.2
const PAD = 20
const BACKDROP = 0.5

// ── the two dialects ────────────────────────────────────────────────────────────

/** `GlassBubble.bodyCorner` as it stood before the unification: one superellipse
 *  quarter as 48 straight chords. It lives HERE now, not in the shell, because the
 *  shell has one dialect again — but the probe still needs it, and for a better reason
 *  than nostalgia: its vertices sit exactly ON the curve, so it is the closest thing to
 *  the ideal that can be drawn, and specimen A is the pixel record of what the shape
 *  change actually moved. */
const bodyCorner = (
    cr: any, cx: number, cy: number, r: number, n: number,
    sx: number, sy: number, fromTop: boolean,
) => {
    const STEPS = 48
    for (let i = 0; i <= STEPS; i++) {
        const t = (fromTop ? STEPS - i : i) / STEPS * (Math.PI / 2)
        const px = r * Math.pow(Math.abs(Math.cos(t)), 2 / n)
        const py = r * Math.pow(Math.abs(Math.sin(t)), 2 / n)
        cr.lineTo(cx + sx * px, cy + sy * py)
    }
}

/** That dialect's body, with the arrow splices removed — same corner calls, same order,
 *  same direction, so this is the pre-unification silhouette and nothing else. */
const chordPath = (cr: any, x: number, y: number, w: number, h: number, r: number, n: number) => {
    const x2 = x + w, y2 = y + h
    cr.moveTo(x + r, y)
    cr.lineTo(x2 - r, y)
    bodyCorner(cr, x2 - r, y + r, r, n, +1, -1, true)     // top-right
    cr.lineTo(x2, y2 - r)
    bodyCorner(cr, x2 - r, y2 - r, r, n, +1, +1, false)   // bottom-right
    cr.lineTo(x + r, y2)
    bodyCorner(cr, x + r, y2 - r, r, n, -1, +1, true)     // bottom-left
    cr.lineTo(x, y + r)
    bodyCorner(cr, x + r, y + r, r, n, -1, -1, false)     // top-left
    cr.closePath()
}

// ── plumbing ────────────────────────────────────────────────────────────────────

const render = (w: number, h: number, ground: number | null, fn: (cr: any) => void) => {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h)
    const cr = new Cairo.Context(surf) as any
    if (ground !== null) { cr.setSourceRGB(ground, ground, ground); cr.paint() }
    fn(cr)
    surf.flush()
    const buf = Gdk.pixbuf_get_from_surface(surf, 0, 0, w, h)!
    return { surf, px: buf.get_pixels(), stride: buf.get_rowstride(), nch: buf.get_n_channels() }
}

/** Is (x,y) inside one of the four corner boxes of the body rect? The straight runs
 *  are everything else — the split #84 reports, and the split that tells a coverage
 *  bug from a gradient one. */
const inCorner = (x: number, y: number, ox: number, oy: number, r: number) => {
    const lx = x - ox, ly = y - oy
    const cx = lx < r ? true : lx >= W - r
    const cy = ly < r ? true : ly >= H - r
    return cx && cy
}

interface Diff { total: number; straight: number; corner: number; maxDelta: number; aOnly: number; bOnly: number }

const diff = (a: any, b: any, w: number, h: number, ox: number, oy: number, r: number): Diff => {
    const d: Diff = { total: 0, straight: 0, corner: 0, maxDelta: 0, aOnly: 0, bOnly: 0 }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = y * a.stride + x * a.nch
            let m = 0
            for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.px[o + c] - b.px[o + c]))
            if (m === 0) continue
            d.total++
            d.maxDelta = Math.max(d.maxDelta, m)
            if (inCorner(x, y, ox, oy, r)) d.corner++; else d.straight++
            if (a.px[o] > b.px[o]) d.aOnly++; else d.bOnly++
        }
    }
    return d
}

const lines: string[] = []
const say = (s = "") => { lines.push(s); print(s) }

// ── SPECIMEN A — the two silhouettes ────────────────────────────────────────────
// White on black: the byte IS the coverage.

const SW = W + PAD * 2, SH = H + PAD * 2
const fillWith = (path: (cr: any) => void) => render(SW, SH, 0, (cr: any) => {
    cr.setAntialias(2)
    path(cr)
    cr.setSourceRGBA(1, 1, 1, 1)
    cr.fill()
})

const aBezier = fillWith((cr) => createSquirclePath(cr, PAD, PAD, W, H, R, N, false, 0))
const aChord  = fillWith((cr) => chordPath(cr, PAD, PAD, W, H, R, N))
const dA = diff(aBezier, aChord, SW, SH, PAD, PAD, R)

say(`# SPECIMEN A — silhouette: shipped squircleCorner (4 Béziers) vs the 48 chords it replaced`)
say(`#   body ${W}x${H} r=${R} n=${N}, white on black, coverage compared byte for byte`)
say(`A  pixels differing      ${dA.total}`)
say(`A    on straight runs    ${dA.straight}`)
say(`A    on the corners      ${dA.corner}`)
say(`A  max coverage delta    ${dA.maxDelta}/255`)
say(`A  Bézier covers more    ${dA.aOnly} px      (chord polyline is inscribed → cuts inside)`)
say(`A  chords cover more     ${dA.bOnly} px`)
say()

// ── SPECIMEN B — the two rim techniques, ONE geometry (positive control) ────────
// Both over #84's mid-grey ground, same fill, same gradient. The only variable is
// offset-and-stroke-1x versus clip-and-stroke-2x.

const tint = GLASS_TINT.dark
const glassFill = (cr: any) => {
    cr.setAntialias(2)
    createSquirclePath(cr, PAD, PAD, W, H, R, N, false, 0)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55)
    cr.fill()
}

const bOffset = render(SW, SH, BACKDROP, (cr: any) => {
    glassFill(cr)
    cr.save(); cr.setAntialias(2)
    createSquirclePath(cr, PAD, PAD, W, H, R, N, false, -0.5)   // inward by half the line width
    cr.setLineWidth(1)
    cr.setSource(glassRimGradient(PAD + W / 2, PAD, H, R))
    cr.stroke(); cr.restore()
})

const bClip = render(SW, SH, BACKDROP, (cr: any) => {
    glassFill(cr)
    cr.save(); cr.setAntialias(2)
    createSquirclePath(cr, PAD, PAD, W, H, R, N, false, 0)
    cr.clip()                                                    // AA clip: coverages MULTIPLY
    createSquirclePath(cr, PAD, PAD, W, H, R, N, false, 0)
    cr.setLineWidth(2)
    cr.setSource(glassRimGradient(PAD + W / 2, PAD, H, R))
    cr.stroke(); cr.restore()
})

const dB = diff(bOffset, bClip, SW, SH, PAD, PAD, R)
say(`# SPECIMEN B — rim technique on ONE geometry: offset+stroke1x vs clip+stroke2x`)
say(`#   THE POSITIVE CONTROL. Debt #84 recorded 0 straight / 280 corner / max 8-of-255.`)
say(`B  pixels differing      ${dB.total}`)
say(`B    on straight runs    ${dB.straight}`)
say(`B    on the corners      ${dB.corner}`)
say(`B  max channel delta     ${dB.maxDelta}/255`)
say(`B  offset idiom brighter ${dB.aOnly} px`)
say(`B  clip idiom brighter   ${dB.bOnly} px`)
say()

// ── SPECIMEN C — which dialect is actually the superellipse? ────────────────────
// Specimen A says the two silhouettes differ, but not which one is RIGHT. This one
// is analytic — no rasteriser involved. For any point P, the superellipse residual
// F(P) = |X/r|ⁿ + |Y/r|ⁿ scales as sⁿ along a ray, so the point on the true curve in
// P's direction is at s = F(P)^(−1/n) and the radial error is |P|·|1 − s| in px.
//
// `createSquirclePath` carries a fitted pair (a = 0.3100, b = 0.1950) and a claim
// about its accuracy. `bodyCorner`'s vertices sit ON the curve by construction, so
// its only error is the sagitta between them. This prints both, so the claim and the
// alternative are measured the same way.

const bez = (t: number, p0: number, c1: number, c2: number, p3: number) => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3
}

/** Max radial error of the TOP-RIGHT corner of each dialect, against the true
 *  superellipse of radius r and exponent n. Corner centre at the origin; the quarter
 *  runs X ∈ [0, r], Y ∈ [−r, 0]. */
const cornerError = (r: number, n: number) => {
    const err = (X: number, Y: number) => {
        const F = Math.pow(Math.abs(X / r), n) + Math.pow(Math.abs(Y / r), n)
        if (F <= 0) return 0
        const s = Math.pow(F, -1 / n)
        return Math.hypot(X, Y) * Math.abs(1 - s)
    }

    // A) the fitted Béziers, control points transcribed from `createSquirclePath`
    //    (top-right corner, box origin subtracted so the corner centre is 0,0).
    const mid = Math.pow(0.5, 1 / n)
    const a = 0.3100, b = 0.1950
    const m = (1 - mid) * r
    const segs = [
        // start (0,−r) → junction (mid·r, −mid·r)
        [0, -r, a * r, -r, r - m - b * r, -r + m - b * r, r - m, -r + m],
        // junction → end (r, 0)
        [r - m, -r + m, r - m + b * r, -r + m + b * r, r, -a * r, r, 0],
    ]
    let bezMax = 0
    for (const [x0, y0, x1, y1, x2, y2, x3, y3] of segs) {
        for (let i = 0; i <= 400; i++) {
            const t = i / 400
            bezMax = Math.max(bezMax, err(bez(t, x0, x1, x2, x3), bez(t, y0, y1, y2, y3)))
        }
    }

    // B) `bodyCorner`'s 48 chords — vertices exact, error lives between them.
    const STEPS = 48
    const vx: number[] = [], vy: number[] = []
    for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS * (Math.PI / 2)
        vx.push(r * Math.pow(Math.abs(Math.cos(t)), 2 / n))
        vy.push(-r * Math.pow(Math.abs(Math.sin(t)), 2 / n))
    }
    let chordMax = 0
    for (let i = 0; i < STEPS; i++) {
        for (let k = 1; k < 16; k++) {
            const u = k / 16
            chordMax = Math.max(chordMax, err(vx[i] + (vx[i + 1] - vx[i]) * u, vy[i] + (vy[i + 1] - vy[i]) * u))
        }
    }
    return { bezMax, chordMax }
}

say(`# SPECIMEN C — radial error against the TRUE superellipse (analytic, no raster)`)
say(`#   n=${N}. \`createSquirclePath\`'s header claims 0.011 px at r=32.`)
say(`#   r      Bézier fit      48 chords`)
for (const r of [12, 18, 24, 32, 48]) {
    const e = cornerError(r, N)
    say(`C  ${String(r).padStart(3)}    ${e.bezMax.toFixed(4)} px      ${e.chordMax.toFixed(4)} px`)
}
say()

// The rim technique is a coverage effect, so its size follows how much of the
// silhouette is CURVED. Sweep the radius to show that #84's 280/8 and this probe's
// numbers are the same mechanism at two different specimens.
say(`# SPECIMEN B' — the same rim comparison swept over the radius`)
say(`#   r    px differing   straight   corner   max delta`)
for (const r of [8, 12, 18, 24, 32, 40]) {
    const off = render(SW, SH, BACKDROP, (cr: any) => {
        cr.setAntialias(2)
        createSquirclePath(cr, PAD, PAD, W, H, r, N, false, 0)
        cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55); cr.fill()
        cr.save(); cr.setAntialias(2)
        createSquirclePath(cr, PAD, PAD, W, H, r, N, false, -0.5)
        cr.setLineWidth(1); cr.setSource(glassRimGradient(PAD + W / 2, PAD, H, r))
        cr.stroke(); cr.restore()
    })
    const clp = render(SW, SH, BACKDROP, (cr: any) => {
        cr.setAntialias(2)
        createSquirclePath(cr, PAD, PAD, W, H, r, N, false, 0)
        cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55); cr.fill()
        cr.save(); cr.setAntialias(2)
        createSquirclePath(cr, PAD, PAD, W, H, r, N, false, 0); cr.clip()
        createSquirclePath(cr, PAD, PAD, W, H, r, N, false, 0)
        cr.setLineWidth(2); cr.setSource(glassRimGradient(PAD + W / 2, PAD, H, r))
        cr.stroke(); cr.restore()
    })
    const d = diff(off, clp, SW, SH, PAD, PAD, r)
    say(`B' ${String(r).padStart(3)}   ${String(d.total).padStart(8)}   ${String(d.straight).padStart(8)} ${String(d.corner).padStart(8)}   ${d.maxDelta}/255`)
}
say()

// ── SPECIMEN D — the bubble that ships, before and after ────────────────────────
// The two idioms on the REAL bubble geometry, arrow and all: the old clip+stroke2x
// against the new offset+stroke1x. This is the before/after the debt entry asked for,
// and the only specimen that includes the pointer — which is where an offset can go
// wrong, because a triangle does not offset like a box.

const BH = H + ARROW_H + BUF * 2
const bx = BUF, by = BUF, bw = W - 2 * BUF, bh = BH - 2 * BUF - ARROW_H
const bodyR = Math.min(R, (bw - ARROW_W) / 2 - 2)
const SDW = W, SDH = BH

const bubbleFill = (cr: any) => {
    cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, bodyR, "bottom", 0, ARROW_W, ARROW_H, 4, 8, N)
    cr.setSourceRGBA(tint.r, tint.g, tint.b, 0.55)
    cr.fill()
}

const dNew = render(SDW, SDH, BACKDROP, (cr: any) => {
    bubbleFill(cr)
    cr.save(); cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, bodyR, "bottom", 0, ARROW_W, ARROW_H, 4, 8, N, -0.5)
    cr.setLineWidth(1)
    cr.setSource(glassRimGradient(bx + bw / 2, by, bh, bodyR))
    cr.stroke(); cr.restore()
})

const dOld = render(SDW, SDH, BACKDROP, (cr: any) => {
    bubbleFill(cr)
    cr.save(); cr.setAntialias(2)
    bubblePath(cr, bx, by, bw, bh, bodyR, "bottom", 0, ARROW_W, ARROW_H, 4, 8, N)
    cr.clip()
    bubblePath(cr, bx, by, bw, bh, bodyR, "bottom", 0, ARROW_W, ARROW_H, 4, 8, N)
    cr.setLineWidth(2)
    cr.setSource(glassRimGradient(bx + bw / 2, by, bh, bodyR))
    cr.stroke(); cr.restore()
})

// Three zones this time: the body's corner arcs, the pointer's own strip, and the
// straight runs. The pointer is the one that has to come back CHANGED but not broken.
const zoneOf = (x: number, y: number) => {
    const inArrow = y >= by + bh - 1 && Math.abs(x - (bx + bw / 2)) <= ARROW_W
    if (inArrow) return "arrow"
    const lx = x - bx, ly = y - by
    const cx2 = lx < bodyR || lx >= bw - bodyR
    const cy2 = ly < bodyR || ly >= bh - bodyR
    return (cx2 && cy2) ? "corner" : "straight"
}
const zones: any = { corner: 0, straight: 0, arrow: 0 }
let dMax = 0
for (let y = 0; y < SDH; y++) {
    for (let x = 0; x < SDW; x++) {
        const o = y * dNew.stride + x * dNew.nch
        let m = 0
        for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(dNew.px[o + c] - dOld.px[o + c]))
        if (m === 0) continue
        zones[zoneOf(x, y)]++
        dMax = Math.max(dMax, m)
    }
}

// ⚠️ Counting which idiom comes out BRIGHTER measures nothing, and the first draft of
// this probe printed exactly that. The rim is bright at the top and dark at the flank,
// so a WEAKER rim is brighter in one half and darker in the other — the count splits
// roughly down the middle either way and looks like a result. What "weaker" means is
// LESS DEPARTURE FROM THE PLAIN FILL, so the fill with no rim at all is the reference,
// and rim strength is the mean |pixel − fill| over the pixels the rim actually touches.
const dBare = render(SDW, SDH, BACKDROP, bubbleFill)
const strength = (img: any, zone: string) => {
    let sum = 0, n = 0
    for (let y = 0; y < SDH; y++) {
        for (let x = 0; x < SDW; x++) {
            if (zoneOf(x, y) !== zone) continue
            const o = y * img.stride + x * img.nch
            let m = 0
            for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(img.px[o + c] - dBare.px[o + c]))
            if (m === 0) continue
            sum += m; n++
        }
    }
    return n ? sum / n : 0
}
const sOldC = strength(dOld, "corner"), sNewC = strength(dNew, "corner")
const sOldS = strength(dOld, "straight"), sNewS = strength(dNew, "straight")

say(`# SPECIMEN D — the shipping bubble: old clip+stroke2x vs new offset+stroke1x`)
say(`#   body ${bw}x${bh} r=${bodyR.toFixed(1)} n=${N}, pointer ${ARROW_W}x${ARROW_H} on the bottom`)
say(`D  pixels moved, corners   ${zones.corner}`)
say(`D  pixels moved, straights ${zones.straight}`)
say(`D  pixels moved, pointer   ${zones.arrow}`)
say(`D  max channel delta       ${dMax}/255`)
say(`#  rim STRENGTH = mean |pixel − the same fill with no rim|, over what the rim touches`)
say(`D  corners   before ${sOldC.toFixed(2)}   after ${sNewC.toFixed(2)}   ${((sNewC / sOldC - 1) * 100).toFixed(1)}%`)
say(`D  straights before ${sOldS.toFixed(2)}   after ${sNewS.toFixed(2)}   ${((sNewS / sOldS - 1) * 100).toFixed(1)}%`)
say()

// ── the sheet, for eyes ─────────────────────────────────────────────────────────
// Four rows: the two silhouettes, the two rim idioms, and the real bubble as it ships.

const BUBBLE_H = H + 8 + 4   // paintGlassBubble reserves BUF + arrowH inside its box
const rows = 4
const sheet = new Cairo.ImageSurface(Cairo.Format.ARGB32, SW * 2 + PAD, SH * rows + BUBBLE_H)
const scr = new Cairo.Context(sheet) as any
scr.setSourceRGB(BACKDROP, BACKDROP, BACKDROP); scr.paint()
const place = (s: any, col: number, row: number) => {
    scr.save(); scr.translate(col * (SW + PAD), row * SH)
    scr.setSourceSurface(s.surf, 0, 0); scr.paint(); scr.restore()
}
place(aBezier, 0, 0); place(aChord, 1, 0)
place(bOffset, 0, 1); place(bClip, 1, 1)

// Row 3: the bubble's own before | after. Row 4: the real `paintGlassBubble` at both
// exponents — n=3.2 is the menus, n=2 is the tooltip — so the PNG shows what ships.
scr.save(); scr.translate(PAD, SH * 2); scr.setSourceSurface(dOld.surf, 0, 0); scr.paint(); scr.restore()
scr.save(); scr.translate(SW + PAD, SH * 2); scr.setSourceSurface(dNew.surf, 0, 0); scr.paint(); scr.restore()
scr.save(); scr.translate(PAD, SH * 3)
paintGlassBubble(scr, W, BUBBLE_H, "bottom", { chrome: true, radiusMax: R, n: N })
scr.restore()
scr.save(); scr.translate(SW + PAD, SH * 3)
paintGlassBubble(scr, W, BUBBLE_H, "bottom", { chrome: true, radiusMax: R, n: 2 })
scr.restore()

sheet.flush()
sheet.writeToPNG(`${out}.png`)
GLib.file_set_contents(`${out}.txt`, lines.join("\n"))
print(`bubble-probe: ${out}.png  ${out}.txt`)
print(`  row 1: Béziers | 48 chords   row 2: offset+1x | clip+2x`)
print(`  row 3: bubble BEFORE | AFTER   row 4: paintGlassBubble n=3.2 | n=2`)

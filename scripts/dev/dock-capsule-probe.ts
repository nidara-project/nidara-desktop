// dock-capsule-probe.ts — did the dock's capsule move?
//
//   scripts/bundle.sh --js scripts/dev/dock-capsule-probe.ts /tmp/dcp.js && gjs -m /tmp/dcp.js
//
// The dock's shadow is the one that could not be added by passing a prop: its gloss
// `DrawingArea` IS the capsule (`inset: 0`), so making room outside the silhouette
// meant growing that widget and subtracting the same pad from its margins. Every
// number the dock is tuned around — PILL_PADDING, BASE_MARGIN, ICON_MARGIN, the
// running-dot zone, EXCLUSIVE_ZONE — is derived from `iconSize` and must not move.
//
// So this renders the capsule the OLD way (widget = capsule, inset 0) and the NEW way
// (widget grown by the pad on every side, capsule drawn at inset = pad, margins
// compensated) into the same screen coordinates, and diffs them. The shadow is
// expected to differ OUTSIDE the silhouette; one pixel of difference INSIDE it, or a
// silhouette that starts anywhere else, means the compensation is wrong.
//
// ⚠️ The capsule is compared WITHOUT its shadow, on purpose. "Did it move" is a
// question about geometry and the shadow is a separate feature; leaving it in makes
// the diff meaningless, because a rectangular comparison window around a pill with a
// 35px corner radius contains a lot of area OUTSIDE the silhouette, where the shadow
// paints and is supposed to. The first version of this probe did exactly that and
// reported the capsule as MOVED when it had not.
//
// ⚠️ Positive control included: it re-runs with the compensation deliberately broken
// by one pixel and asserts the diff CATCHES it. A geometry check that cannot fail is
// not a check — and a 1px capsule shift is exactly the kind of thing an eye forgives
// on a screenshot and a user notices as "the icons sit wrong now".
import Cairo from "gi://cairo"
import Gdk from "gi://Gdk?version=4.0"
import { drawSquircle, drawGlassShadow } from "../../ui/shell/common/DrawingUtils"
import { GLASS_SHADOW } from "../../ui/shell/common/SquircleContainer"
import { GLASS_TINT } from "../../ui/lib/tokens"

const PAD = GLASS_SHADOW.spread
// A real dock at the default 48px icon: PILL_PADDING = round(48*0.22) = 11,
// PILL_HEIGHT = 48 + 22 = 70, BASE_MARGIN = 11 - round(48*0.16)/2 ≈ 7.
const PILL_HEIGHT = 70, TARGET_W = 520, SCREEN_GAP = 8, MARGIN_START = 300
const W = 900, H = 200, WIN_H = H

const render = (mode: "old" | "new" | "broken") => {
    const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, H)
    const cr = new Cairo.Context(surf) as any
    cr.setSourceRGB(0.5, 0.5, 0.5); cr.paint()

    const tint = GLASS_TINT.dark
    const border = { r: 1, g: 1, b: 1, a: 0.12 }
    const paint = (dx: number, dy: number, w: number, h: number, inset: number, shadow: boolean) => {
        cr.save(); cr.translate(dx, dy)
        if (shadow) drawGlassShadow(cr, inset, inset, w - inset * 2, h - inset * 2,
            (h - inset * 2) / 2, 3.2, false, GLASS_SHADOW.spread, GLASS_SHADOW.alpha, GLASS_SHADOW.drop)
        drawSquircle(cr, w, h, undefined, 0.55, true,
            { r: tint.r, g: tint.g, b: tint.b }, undefined, false, border, 3.2, 1.0, inset)
        cr.restore()
    }
    const withShadow = false   // ver la nota de arriba
    if (mode === "old") {
        // widget = capsule: margin_start, height PILL_HEIGHT, bottom SCREEN_GAP
        paint(MARGIN_START, WIN_H - SCREEN_GAP - PILL_HEIGHT, TARGET_W, PILL_HEIGHT, 0, false)
    } else {
        // widget grown by PAD on every side; margins pulled back by the same PAD.
        // "broken" pulls the left margin back by one pixel too few — the whole point.
        const off = mode === "broken" ? PAD - 1 : PAD
        paint(MARGIN_START - off, WIN_H - Math.max(0, SCREEN_GAP - PAD) - (PILL_HEIGHT + PAD * 2),
              TARGET_W + PAD * 2, PILL_HEIGHT + PAD * 2, PAD, withShadow)
    }
    surf.flush()
    const b = Gdk.pixbuf_get_from_surface(surf, 0, 0, W, H)!
    return { px: b.get_pixels(), st: b.get_rowstride(), nc: b.get_n_channels() }
}

const old = render("old")
const cmp = (other: any) => {
    // The WHOLE canvas: with no shadow in either render, any differing pixel anywhere
    // is the capsule having landed somewhere else.
    let inside = 0, maxd = 0
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const o = y * old.st + x * old.nc
            let m = 0
            for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(old.px[o + c] - other.px[o + c]))
            if (m) { inside++; maxd = Math.max(maxd, m) }
        }
    }
    return { inside, maxd }
}

const good = cmp(render("new"))
const bad  = cmp(render("broken"))
print(`capsule pixels, old vs new     : ${good.inside} differ (max ${good.maxd}/255)`)
print(`capsule pixels, old vs BROKEN  : ${bad.inside} differ (max ${bad.maxd}/255)   <- the control`)
print(good.inside === 0 && bad.inside > 0
    ? "OK — the capsule did not move, and the check can still fail."
    : "FAIL — " + (good.inside ? "the capsule MOVED" : "the control did not trip: this check proves nothing"))

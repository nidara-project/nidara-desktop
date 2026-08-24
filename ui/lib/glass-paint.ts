import Cairo from "gi://cairo"
import { GLASS_TINT, GLASS_SPECULAR } from "./tokens"

/**
 * The Cairo primitives that DEFINE what Nidara glass looks like: the silhouette,
 * the Fresnel rim ramp, and the drop shadow.
 *
 * ⚠️ WHY THIS IS IN `ui/lib/` AND NOT IN THE SHELL. It used to live in
 * `ui/shell/common/DrawingUtils.ts`, and for as long as it did, the greeter and the
 * lockscreen could not reach it — `ui/lib/` may not import from `ui/shell/` (the same
 * constraint that moved `hexToFloatRgb` to `ui/lib/accent.ts`). So they had their own
 * painter, `ui/lib/glass-capsule.ts`, with a FLAT rim colour and no shadow at all.
 *
 * That was invisible until 2026-08-23, when the whole glass wave (#234–#248: one rim
 * ramp, one corner, the drop shadow) landed in the shell's painter and stopped at the
 * `ui/lib` boundary. The desktop got depth; the login screen — the first surface a user
 * ever sees — kept the flat slabs, and on a pale wallpaper they read as grey blocks.
 * The unification had unified two thirds of the desktop.
 *
 * Moving the primitives DOWN rather than copying them up is the whole point: the ramp's
 * own header says it is "THE ONLY COPY OF THESE NUMBERS", and a second table is exactly
 * the failure #234 spent an afternoon undoing. `DrawingUtils.ts` re-exports every name
 * here, so the shell's five Cairo painters keep their import path unchanged.
 */

/** ONE quarter of a superellipse |x/r|ⁿ + |y/r|ⁿ = 1, as two continuous cubic Bézier
 *  splines — the only place in this repo that knows how a rounded corner is shaped.
 *
 *  Placement follows `cr.arc`'s vocabulary so a caller reads like the arc it replaced:
 *  the corner is centred on (`cx`, `cy`), `sx`/`sy` (±1) put the quarter in one of the
 *  four quadrants around it, and `fromTop` says which end the path arrives at — true =
 *  start on the vertical axis at (cx, cy + sy·r) and finish on the horizontal one at
 *  (cx + sx·r, cy), false = the reverse. The control net is symmetric under that
 *  reversal, so the two directions are the same curve walked opposite ways. The caller
 *  owns the start point (a `moveTo` or the `lineTo` that closes the previous edge).
 *
 *  ⚠️ `a` AND `b` ARE FITTED FOR n = 3.2 AND ONLY FOR n = 3.2. They are the two tangent
 *  lengths of the fit; `mid` follows `n`, they do not. MEASURED against the true
 *  superellipse (`scripts/dev/bubble-probe.ts`, specimen C) — max radial error, which
 *  grows linearly with the radius:
 *
 *      r      12       18       24       32       48
 *      px   0.0042   0.0063   0.0084   0.0112   0.0168
 *
 *  and against `n`, at corner radius 32:
 *
 *      n     3.2     3.5     4.0     4.5     5.0
 *      px   0.011   0.054   0.180   0.322   0.466
 *
 *  Everything in the shell paints at 3.2 — every island, the overview, the app grid,
 *  Prism (which sat at 4.5 until 2026-08-23, carried in by a refactor, and was the one
 *  surface visibly off its own silhouette), and since the bubble was unified, the
 *  tooltip and the context menus. n = 2 never reaches here: it comes with `perfect`, or
 *  with `bubblePath`'s own arc branch, and both are four real arcs. So the fixed pair is
 *  right for every caller today — but if you pass a different `n`, refit them (a minimax
 *  sweep gets n=4.5 to 0.012px with a≈0.423, b≈0.155) rather than assuming the curve you
 *  get is the superellipse you asked for.
 *
 *  ⚠️ And it is a FIT, not the curve: it runs consistently INSIDE the true superellipse.
 *  The 48-chord polyline this replaced in `GlassBubble` was 2.6× closer to the ideal
 *  (0.0043 px at r=32) and 11.6× more expensive to build. Both are two orders of
 *  magnitude below one pixel; what you can actually see is two sibling surfaces wearing
 *  two different silhouettes, which is why there is now one. */
export const squircleCorner = (
    cr: any, cx: number, cy: number, r: number, n: number,
    sx: number, sy: number, fromTop: boolean,
) => {
    const mid = Math.pow(0.5, 1 / n) * r
    const a = 0.3100 * r
    const b = 0.1950 * r
    // The control net, as magnitudes in the first quadrant, from the vertical axis to
    // the horizontal one: P0, C1, C2, P3(=the 45° junction), C1', C2', P3'.
    const net: number[][] = [
        [0, r], [a, r], [mid - b, mid + b], [mid, mid], [mid + b, mid - b], [r, a], [r, 0],
    ]
    if (!fromTop) net.reverse()
    const px = (i: number) => cx + sx * net[i][0]
    const py = (i: number) => cy + sy * net[i][1]
    cr.curveTo(px(1), py(1), px(2), py(2), px(3), py(3))
    cr.curveTo(px(4), py(4), px(5), py(5), px(6), py(6))
}

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

    const safe_rd = Math.min(rd, Math.min(ow, oh) / 2)

    if (perfect) {
        // GEOMETRIC PILL 💊 (Standard Arcs)
        cr.arc(ox + ow - safe_rd, oy + safe_rd, safe_rd, -Math.PI / 2, 0) // TR
        cr.lineTo(ox + ow, oy + oh - safe_rd)
        cr.arc(ox + ow - safe_rd, oy + oh - safe_rd, safe_rd, 0, Math.PI / 2) // BR
        cr.lineTo(ox + safe_rd, oy + oh)
        cr.arc(ox + safe_rd, oy + oh - safe_rd, safe_rd, Math.PI / 2, Math.PI) // BL
        cr.lineTo(ox, oy + safe_rd)
        cr.arc(ox + safe_rd, oy + safe_rd, safe_rd, Math.PI, 3 * Math.PI / 2) // TL
        cr.lineTo(ox + ow - safe_rd, oy)
    } else {
        // SQUIRCLE (Superellipse) — four quarters, every one of them `squircleCorner`.
        // The straight edges are emitted here; the curvature is not this function's to
        // know. Right Edge / Left Edge stay conditional: on a pill there is no straight
        // run and a zero-length lineTo would put a degenerate segment in the path.
        cr.moveTo(ox + safe_rd, oy)
        cr.lineTo(ox + ow - safe_rd, oy)
        squircleCorner(cr, ox + ow - safe_rd, oy + safe_rd, safe_rd, n, +1, -1, true)
        if (oh - (2 * safe_rd) > 0.01) cr.lineTo(ox + ow, oy + oh - safe_rd)
        squircleCorner(cr, ox + ow - safe_rd, oy + oh - safe_rd, safe_rd, n, +1, +1, false)
        cr.lineTo(ox + safe_rd, oy + oh)
        squircleCorner(cr, ox + safe_rd, oy + oh - safe_rd, safe_rd, n, -1, +1, true)
        if (oh - (2 * safe_rd) > 0.01) cr.lineTo(ox, oy + safe_rd)
        squircleCorner(cr, ox + safe_rd, oy + safe_rd, safe_rd, n, -1, -1, false)
    }
    cr.closePath()
}

/** How dark the FLANK of the rim goes, as `GLASS_TINT.dark` alpha along the side.
 *  ONE number, for both modes — see `glassRimGradient` for why there is no second one.
 *
 *  This is the one thing to move if the sides read as too much or too little. It is a
 *  look decision with a physical argument behind it: at the top and bottom you meet the
 *  edge at a grazing angle and it REFLECTS, but at mid-height you are looking straight
 *  THROUGH the edge, so what you should see is the thickness of the material — dark —
 *  not a highlight.
 *
 *  ⚠️ Measure it RELATIVE to the body it edges, never as a raw pixel delta. The same
 *  alpha over a bright body and over a dark one produce very different absolute numbers
 *  and very similar perceived ones, and comparing the absolutes inverts the conclusion —
 *  it is how this file spent an afternoon claiming light glass had the stronger flank.
 *  Over a real blurred bright wallpaper (`scripts/dev/rim-backdrop-probe.ts`), same
 *  pixel with the rim against without it:
 *
 *      dark glass    −13.7 %   (−13.8 levels of 255)
 *      light glass   −16.2 %   (−36.7 levels)
 *
 *  Two and a half points apart on one shared number — less than the wallpaper behind it
 *  moves either of them. That is the measurement that says one number is enough.
 *
 *  ⚠️ It was white `.08` until 2026-08-23, which made the flank LIGHTER than the body it
 *  edges. The capsule therefore had no dark side at all, which is why it read flat over
 *  pale wallpapers — the contrast the glass needs there has to come from the edge,
 *  because the fill cannot supply it without going opaque.
 *
 *  ⚠️ Over a DARK wallpaper the dark-mode flank inverts: the tint ends up lighter than
 *  the composited body, so the side comes out +13.8 % — but that is **+1.9 levels of 255
 *  on a body sitting at 13.4**, which nobody can see. Documented so the next person who
 *  measures it does not go hunting. It is not a reason to make the flank mode-aware, or
 *  backdrop-aware; if it ever needs fixing the honest fix is a MULTIPLY pass, not a
 *  second table.
 *
 *  ⚠️ This reopens #230, which removed a lateral dark contour on the grounds that it
 *  "read as a drawn outline rather than as material". That judgement was made while
 *  `blur:brightness` was still painting a hard dark step along every antialiased edge
 *  (resolved debt #81) — the outline it rejected was partly the artefact. Reopened
 *  deliberately, by the owner, after that was fixed. */
const FLANK_DEPTH = 0.18

/** How far the dark wraps INTO the corner arcs, as a fraction of the corner.
 *
 *  1.0 keeps the dark to the straight side only — geometrically pure, and on a wide
 *  short capsule that is a very short run (a dock capsule is 92 tall with a radius of
 *  32, so only 28px of its side is straight) which reads as "a small darker bit"
 *  rather than a dark side. Lower values carry the dark round the corner and leave the
 *  key light on the CAPS, which is the effect being asked for: bright top and bottom,
 *  dark sides.
 *
 *  0.35 means the dark starts about a third of the way up each corner. On a pill,
 *  where `radius/height` is 0.5 and there is no straight side at all, it still leaves
 *  a bright cap at each end instead of collapsing to a point. */
const FLANK_SPREAD = 0.35

/** The 1px inner rim of every glass surface, as a vertical gradient over a box of
 *  `height` starting at `top`. `cx` only fixes the gradient's axis — it is vertical,
 *  so any x on the shape does.
 *
 *  ⚠️ THIS IS THE ONLY COPY OF THESE NUMBERS, and since 2026-08-23 it does not know
 *  what MODE it is in. There used to be two ramps here, a seven-stop one for dark and a
 *  four-stop one for light, and they disagreed in four places: the key light (.42 vs
 *  .55), the second stop (.16 vs .25), the flank (a plateau tied to the radius vs
 *  `GLASS_TINT.dark` at .10 pinned to a single stop at 50 %), and the bottom (a white
 *  ground bounce vs a dark lower edge). None of the four was ever derived — they were
 *  two tables written months apart, and the light one still carried, in light mode only,
 *  exactly the "very small darker bit" defect #239 fixed for dark.
 *
 *  Unified and then MEASURED over real blurred wallpapers rather than argued: one ramp
 *  puts the two modes 2.5 points apart in perceived edge contrast, inside the spread the
 *  backdrop itself causes. So a rim describes the same physical edge in both modes and is
 *  now literally the same gradient — no `dark` argument, and `drawSquircle` no longer has
 *  to guess the mode from its fill colour.
 *
 *  A **Fresnel** ramp, top to bottom:
 *
 *      key light .42  →  (roll-off .16)  →  flank FLANK_DEPTH  →  (roll-on .14)  →  .24
 *
 *  An edge reflects most where you meet it at a grazing angle — the top rim (key light)
 *  and the bottom rim (ground bounce) — and least where you look straight through the
 *  glass, the flank. **The dip in the middle is the whole point**: the lateral dark
 *  contour it replaced was faking the same effect by painting black down the sides,
 *  which read as a drawn outline rather than as material.
 *
 *  The white is `GLASS_SPECULAR`, not `GLASS_TINT.light`: it is the colour of the light,
 *  not of the surface — which is also why it does not belong to a mode. They were the
 *  same token until 2026-08-23, which meant a retint of light-mode glass would have
 *  dimmed the highlight on every dark capsule in the desktop.
 *
 *  ⚠️ Before adding a branch here, read the paragraph above: every divergence this ramp
 *  has ever had was found by measuring, after the fact, never proposed by one. If some
 *  surface really needs a different edge, give it a PARAMETER, not a second table. */
export const glassRimGradient = (
    cx: number, top: number, height: number, radius = 0,
    /** Multiplies every alpha in the ramp — the PARAMETER the header asks for instead of
     *  a second table, added 2026-08-24 for the greeter/lockscreen.
     *
     *  Those two screens have always drawn two rim WEIGHTS, not one: `LOCK_GLASS.rimStrong`
     *  (a .22) on the primary control, `rimSubtle` (a .14) on everything else, so the login
     *  button reads as the thing you press. The shell has no such distinction and passes
     *  nothing here, which leaves the canonical ramp exactly as it was.
     *
     *  ⚠️ The one value other than 1 that ships is `0.14 / 0.22 = 0.64`, and it is a RATIO
     *  the two tokens already had — not a new look invented at the ramp. Scaling preserves
     *  the Fresnel SHAPE (key light, flank dip, ground bounce) and only changes how loudly
     *  it speaks, which is the difference those two tokens were always expressing. If you
     *  find yourself wanting to bend a stop instead of the whole ramp, you want a second
     *  table, and the header above is about why you do not. */
    scale = 1,
) => {
    const g = new Cairo.LinearGradient(cx, top, cx, top + height)
    const a = (v: number) => v * scale
    const { r: lr, g: lg, b: lb } = GLASS_SPECULAR
    const { r: fr, g: fg, b: fb } = GLASS_TINT.dark

    // WHERE the sides actually are. The straight vertical run of the silhouette spans
    // y ∈ [radius, height − radius], so as a fraction of the height it is
    // [radius/height, 1 − radius/height] — and that is what has to be dark, not a fixed
    // percentage. A dock capsule (92 tall, r 32) is dark over .12–.88; a CC panel (610
    // tall, r 24) over .01–.99. One constant cannot serve both: pinning the dark to 0.50
    // puts it at a POINT in the middle of the side, which is what shipped in #239 and
    // what the owner saw — "a very small darker bit". It is also exactly what the LIGHT
    // ramp still did until this ramp was unified. On a pill (height = 2·radius) the two
    // collapse to 0.5, which is correct: a pill has no straight side, its widest point
    // IS mid-height.
    const t = Math.min(0.5, Math.max(0, radius / Math.max(1, height))) * FLANK_SPREAD
    const top2 = t, bot2 = 1 - t

    g.addColorStopRGBA(0.0, lr, lg, lb, a(0.42))           // top rim: key light
    if (top2 > 0.06) g.addColorStopRGBA(top2 * 0.55, lr, lg, lb, a(0.16))
    g.addColorStopRGBA(top2, fr, fg, fb, a(FLANK_DEPTH))   // ── the side starts
    g.addColorStopRGBA(bot2, fr, fg, fb, a(FLANK_DEPTH))   // ── the side ends
    if (bot2 < 0.94) g.addColorStopRGBA(bot2 + (1 - bot2) * 0.45, lr, lg, lb, a(0.14))
    g.addColorStopRGBA(1.0, lr, lg, lb, a(0.24))           // bottom rim: ground bounce
    return g
}

/** A soft outer shadow for a SQUIRCLE glass surface: six nested fills of the same
 *  silhouette, grown outward, rather than a blurred mask — no blur pass and no
 *  temporary surface. The algorithm is `drawShadowFromPath` below, which this only
 *  hands a squircle to; read its header before changing how the falloff is built.
 *  (It used to say "four strokes", and strokes are exactly what it must NOT be.)
 *
 *  Why a glass surface wants one at all: the rim is a MATERIAL highlight, not a
 *  delimiter. Its top and bottom stops are white, so against a white backdrop they
 *  vanish and all that survives is the dark flank — the surface reads as two vertical
 *  lines. That is the failure the owner reported over a white window, and it is the
 *  same failure macOS avoids by separating floating surfaces with a shadow rather
 *  than with their edge. A shadow also scales itself to the problem: over a busy
 *  colourful wallpaper it reads as depth and is nearly invisible, over flat white it
 *  becomes the only separator left.
 *
 *  ⚠️ IT NEEDS ROOM OUTSIDE THE SILHOUETTE, and that room is `inset` — the caller must
 *  reserve at least `spread` px or the falloff is simply clipped by the DrawingArea.
 *  `SquircleContainer`'s `GLASS_INSET` is 2.0, so a tile gets a 2px shadow unless it
 *  is given more, and buying more shrinks the painted glass by the same amount.
 *
 *  ⚠️ AND IT INTERACTS WITH COMPOSITOR BLUR. Hyprland decides where to blur by an
 *  alpha threshold per layer (`ignore_alpha`), and a shadow is by definition a band of
 *  LOW alpha outside the glass. If the shadow's alpha clears the layer's threshold,
 *  Hyprland blurs the backdrop behind the shadow — a smeared halo tracking the
 *  silhouette, which is exactly debt #237 (the dock blurring behind its magnified icon
 *  shadows). Check the layer's rule in `config/hypr/hyprland.lua` before enabling this
 *  on a new surface: `nidara-dock` sits at 0.23 and has room to spare, while
 *  `nidara-bar` and `nidara-island` sit at 0.01 and will blur behind almost any
 *  shadow. `scripts/ci/blur-threshold-check.mjs` guards the other end of that coupling
 *  (a threshold reaching the glass floor kills the blur entirely) but it does NOT know
 *  about shadows — this comment is the only warning there is. */
export const drawGlassShadow = (
    cr: any,
    x: number, y: number, w: number, h: number, r: number,
    n: number = 3.2,
    perfect: boolean = false,
    spread: number = 4,
    alpha: number = 0.18,
    /** Vertical offset, for the "lit from above" reading. ⚠️ It is SUBTRACTED from the
     *  top edge, and on a small `spread` that is most of what the top has: the rim's top
     *  stop is white, so against a white backdrop the shadow is the ONLY thing defining
     *  that edge. Measured on a CC tile at spread 2 — darkest contour pixel, 255 means
     *  nothing is there: sides 211, bottom 211, and the top going 218 / 227 / 239 / 244
     *  at drop 0 / 0.5 / 1 / 2. So a drop only pays for itself once `spread` is big
     *  enough to spare it; keep it near zero on tight shadows. */
    drop: number = 1,
) => {
    if (w <= 0 || h <= 0) return
    const m = spread + 2
    drawShadowFromPath(
        cr,
        (offset, dy) => createSquirclePath(cr, x, y + dy, w, h, r, n, perfect, offset),
        x - m, y - m, w + m * 2, h + m * 2,
        spread, alpha, drop,
    )
}

/** The shadow ALGORITHM, separated from the squircle so a second silhouette can use
 *  it. `path(offset, dy)` must emit the surface's outline grown outward by `offset`
 *  (0 = the silhouette itself) and translated down by `dy`; `bx/by/bw/bh` is the
 *  rectangle the shadow is punched out of, which must contain the whole grown outline.
 *
 *  Two callers: `drawGlassShadow` above (every capsule, tile and panel) and
 *  `paintGlassBubble`'s (`common/GlassBubble.ts`), whose outline includes the pointer.
 *  Splitting it was what let the bubble join without a second recipe — the numbers in
 *  `GLASS_SHADOW` are the shell's, not the squircle's.
 *
 *  ⚠️ NESTED FILLS, NOT CONCENTRIC STROKES. The first version of this stroked N rings
 *  of decreasing offset and increasing alpha, which LOOKS like a falloff and is not
 *  one: neighbouring strokes overlap, the overlaps composite, and the accumulated
 *  alpha stops being monotonic — an outer band covered by two strokes comes out
 *  DARKER than an inner band covered by one. At spread 2 the rings are packed tightly
 *  enough that it happened to come out clean; at 4 and 6 it produced a visibly lighter
 *  gap between the shadow and the rim, reported by the owner and then measured across
 *  the flank: 254 248 235 217 **230** 211, rising where it had to keep falling.
 *
 *  Filling nested shapes largest-first cannot do that. Every layer covers everything
 *  inside it, so coverage counts increase monotonically inward by construction, and
 *  the result is a staircase with no way to be non-monotonic.
 *
 *  ⚠️ THE OUTLINE'S OFFSET IS PERPENDICULAR TO ITS EDGES, WHICH IS NOT THE SAME AS
 *  `spread` PX IN EVERY DIRECTION. On a convex corner of interior half-angle θ the
 *  outline's vertex travels `offset / sin θ`, so a sharp point reaches further than a
 *  flat run does — a 90° corner by 1.41 x `spread`. A caller that reserves exactly
 *  `spread` px of room gets the tip of its shadow clipped flat, UNLESS that corner is
 *  rounded and its radius grows with the offset, which pulls the arc back toward the
 *  shape. That is exactly what saves the glass bubble's pointer; see specimen E of
 *  `scripts/dev/bubble-probe.ts`. Measure a new sharp-cornered caller, do not assume. */
export const drawShadowFromPath = (
    cr: any,
    path: (offset: number, dy: number) => void,
    bx: number, by: number, bw: number, bh: number,
    spread: number = 4,
    alpha: number = 0.18,
    drop: number = 1,
) => {
    if (bw <= 0 || bh <= 0 || spread <= 0 || alpha <= 0) return
    const LAYERS = 6
    // `alpha` is the TOTAL at the silhouette, which is the number that matters: it is
    // what a layer's `ignore_alpha` is compared against. Per-layer alpha is derived so
    // that N of them compose to it, rather than being a knob nobody can reason about.
    const per = 1 - Math.pow(1 - Math.min(0.95, alpha), 1 / LAYERS)
    cr.save()
    cr.setAntialias(6)
    // ⚠️ And clip the silhouette OUT before filling anything. Nested fills cover the
    // interior too, and the glass on top is translucent (0.55), so without this the
    // shadow shows straight through and darkens the whole surface — measured on a CC
    // tile over white, the body went 253 → 233 while the shadow was doing its job
    // outside. A drop shadow must not tint the thing it is under. EVEN_ODD punches the
    // hole: outer rectangle plus the silhouette, so only what is OUTSIDE gets painted.
    cr.rectangle(bx, by, bw, bh)
    path(0, 0)
    cr.setFillRule(1) // EVEN_ODD
    cr.clip()
    cr.setFillRule(0) // back to WINDING for the shapes themselves
    for (let i = LAYERS; i >= 1; i--) {
        path(spread * (i / LAYERS), drop)
        cr.setSourceRGBA(0, 0, 0, per)
        cr.fill()
    }
    cr.restore()
}

/** The shell's one drop-shadow recipe, for glass that FLOATS OVER CONTENT.
 *
 *  `spread: 2` is the value that costs nothing: the shadow lives in the surface's
 *  `inset`, and `GLASS_INSET` already reserves exactly that — so the painted glass
 *  does not shrink and nothing moves. Anything wider comes out of the glass.
 *
 *  `drop: 0` because at this spread a downward offset costs the TOP edge more than
 *  it buys in depth, and the top is precisely where the rim gives up: its top stop is
 *  white, so against a white backdrop the shadow is the only thing defining that edge.
 *  Measured on a CC tile — darkest contour pixel, 255 meaning nothing is there — the
 *  sides sit at 211 while the top goes 218 / 227 / 239 / 244 at drop 0 / 0.5 / 1 / 2.
 *
 *  `alpha` is the TOTAL at the silhouette, which is the number that has to stay under
 *  the layer's `ignore_alpha` — 0.18 against the 0.23 the bar and the dock both use.
 *
 *  ⚠️ Give this to the OUTERMOST glass of a surface only. A shadow on a control that
 *  sits inside another glass panel is a shadow inside a window: it reads as dirt, not
 *  as depth. The control centre and the notification centre are the apparent
 *  exception and are not one — they have no panel, their cards ARE the outer glass. */
export const GLASS_SHADOW = { spread: 2, alpha: 0.18, drop: 0 } as const

// glass-legibility-probe.ts — the adaptive glass's rule, held to its numbers (#673).
//
//   npx --yes esbuild@0.25.10 scripts/dev/glass-legibility-probe.ts --bundle \
//     --platform=node --format=esm --outfile=/tmp/glass-probe.mjs && node /tmp/glass-probe.mjs
//
// Pure: no GI, no display. Exits non-zero on any failure — and CI deletes a rule
// before running it once, and requires THAT run to fail, because a probe that has
// only ever printed "ok" has been run, not tested.

import {
    uncomposite, glassOver, tierContrast, markContrast, legibilityMargin, MARK_TARGET, decideGlass, decideGlassByBackdrop, mergeBackdropStats, backdropStats, hyprlandPrepare, hyprlandVibrancy, NIDARA_BLUR,
    GLASS_ADAPT_CEILING, TEXT_INK, TOOLTIP_GLASS_FLOOR, tintFromBackdrop, luminance, type Rgb, type BackdropStats,
} from "../../ui/lib/nidara-kit/platform/glass-legibility"
import { GLASS_TINT } from "../../ui/lib/nidara-kit/platform/tokens"

let failures = 0
const check = (ok: boolean, what: string) => {
    if (ok) console.log(`ok    ${what}`)
    else { failures++; console.log(`FAIL  ${what}`) }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const grey = (v: number): Rgb => ({ r: v, g: v, b: v })
const flat = (c: Rgb): BackdropStats => ({ brightest: c, darkest: c, mean: c, samples: 1000, area: 1000 })

// ── 1. The forward model is the one that was validated ───────────────────────
// tech-debt #82's table (GLASS_TINT.dark, white ink): 1.69 over pure white and 5.71
// over mid grey at 0.24. The live screenshot of 2026-09-29 matched this model to
// 1–2/255; if these move, the model moved.
check(near(tierContrast(grey(1), true, 0.24, "primary"), 1.69, 0.01), "dark 0.24 over white: primary 1.69 (#82)")
check(near(tierContrast(grey(0.5), true, 0.24, "primary"), 5.71, 0.01), "dark 0.24 over mid grey: primary 5.71 (#82)")
check(near(tierContrast(grey(1), true, 0.48, "dim"), 2.13, 0.01), "dark 0.48 over white: dim 2.13 (#673)")

// ── 2. uncomposite() is glassOver() run backwards ────────────────────────────
{
    const backdrop: Rgb = { r: 0.83, g: 0.41, b: 0.12 }
    const a = 0.48
    const tint = GLASS_TINT.dark
    const ours = { r: tint.r * a, g: tint.g * a, b: tint.b * a, a }
    const screen = glassOver(backdrop, true, a)
    const back = uncomposite(screen, ours, 0.3, 0.92)
    check(!!back && near(back.r, 0.83, 1e-9) && near(back.g, 0.41, 1e-9) && near(back.b, 0.12, 1e-9),
          "uncomposite recovers the backdrop under the glass exactly")
    check(uncomposite(screen, { ...ours, a: 0.97 }, 0.3, 0.92) === null, "uncomposite refuses near-opaque paint (text)")
    check(uncomposite(screen, { ...ours, a: 0.1 }, 0.3, 0.92) === null, "uncomposite refuses paint under ignore_alpha")
}

// ── 3. The statistics are percentiles, not extremes ──────────────────────────
{
    const px: Rgb[] = []
    for (let i = 0; i < 980; i++) px.push(grey(0.4))
    for (let i = 0; i < 20; i++) px.push(grey(1))      // 2 % stray white
    const s = backdropStats(px)!
    check(near(s.brightest.r, 0.4, 1e-9), "2 % of stray white pixels do not decide the brightest backdrop")
    check(backdropStats(px.slice(0, 10)) === null, "too few samples → no statistics")
}
{
    // What a surface leaves SEE-THROUGH (the gaps between the bar's capsules) counts
    // toward its typical backdrop, never toward its extremes: no text sits there.
    const glass: Rgb[] = [], gaps: Rgb[] = []
    for (let i = 0; i < 100; i++) glass.push(grey(0.2))
    for (let i = 0; i < 300; i++) gaps.push(grey(0.9))
    const s = backdropStats(glass, 64, 9, gaps)!
    check(near(s.mean.r, 0.725, 1e-9) && s.area === 3600, "see-through: the gaps count toward the mean and the area")
    check(s.brightest.r === 0.2 && s.darkest.r === 0.2 && s.samples === 100, "see-through: the extremes are the glass's alone")
    check(backdropStats(glass.slice(0, 10), 64, 9, gaps) === null, "see-through: gaps alone do not make a measurement")
}

// ── 4. The rule: A, then B ───────────────────────────────────────────────────
const floor = 0.48

// Nothing needed: a mid backdrop leaves the glass exactly as the user set it.
{
    const d = decideGlass(flat(grey(0.5)), true, floor)
    check(d.isDark && d.alpha === floor, "mid grey: dark glass stays at the slider")
}

// A: a backdrop the ceiling can carry → thicker, same skin.
{
    let g = 0
    for (let v = 0.3; v <= 1; v += 0.005)
        if (legibilityMargin(grey(v), true, floor) < 1 && legibilityMargin(grey(v), true, GLASS_ADAPT_CEILING) >= 1) { g = v; break }
    check(g > 0, "there is a backdrop only thickening fixes (the test below is not vacuous)")
    const d = decideGlass(flat(grey(g)), true, floor)
    check(d.isDark && d.alpha > floor && d.alpha <= GLASS_ADAPT_CEILING, `A: grey ${g.toFixed(3)} thickens dark glass (${d.alpha}) and keeps the skin`)
    check(legibilityMargin(grey(g), true, d.alpha) >= 1, "A: the thickened glass actually passes")
    check(legibilityMargin(grey(g), true, d.alpha - 0.01) < 1, "A: and is the LEAST thickening that passes")
}

// B: pure white is past what dark glass can carry at the ceiling → flip.
{
    const d = decideGlass(flat(grey(1)), true, floor)
    check(!d.isDark, "B: pure white flips dark glass to the light skin")
    check(legibilityMargin(grey(1), false, d.alpha) >= 1, "B: and the light skin passes there")
    // At the slider, not at the ceiling: light glass over white needs no extra body.
    // (The last-resort branch also flips, but at FULL body — this is what tells B
    // from it.)
    check(d.alpha === floor, `B: the flipped skin wears the slider's own body (${d.alpha})`)
}

// Light skin: black needs a little more body (secondary 4.5 needs 0.50 over black).
{
    const d = decideGlass(flat(grey(0)), false, floor)
    check(!d.isDark && near(d.alpha, 0.50, 0.011), `light over black thickens to ~0.50 (${d.alpha})`)
}

// A slider above the ceiling is the user's answer, and it is left alone.
{
    const d = decideGlass(flat(grey(1)), true, 0.8)
    check(d.isDark && d.alpha === 0.8, "a slider above the ceiling: nothing to adapt, no flip")
}

// ── 4b. A surface that carries marks, not text: the dock ─────────────────────
// Its running dot (INK.solid) at 3:1, not the text ramp at 4.5:1 — the dock would
// otherwise thicken for words it does not have.
{
    let g = 0
    for (let v = 0.3; v <= 1; v += 0.005)
        if (legibilityMargin(grey(v), true, floor) < 1 && legibilityMargin(grey(v), true, floor, "marks") >= 1) { g = v; break }
    check(g > 0, "marks: there is a backdrop where text needs more glass and the dot does not (the test below is not vacuous)")
    const text = decideGlass(flat(grey(g)), true, floor)
    const marks = decideGlass(flat(grey(g)), true, floor, undefined, "marks")
    check(text.alpha > floor && marks.isDark && marks.alpha === floor,
          `marks: over grey ${g.toFixed(3)} text thickens (${text.alpha}), the dock stays at its slider`)
}
{
    // …but a backdrop the dot cannot be seen on still moves the dock: A, then B.
    let g = 0
    for (let v = 0.3; v <= 1; v += 0.005)
        if (legibilityMargin(grey(v), true, floor, "marks") < 1 && legibilityMargin(grey(v), true, GLASS_ADAPT_CEILING, "marks") >= 1) { g = v; break }
    check(g > 0, "marks: there is a backdrop only thickening fixes for the dot")
    const d = decideGlass(flat(grey(g)), true, floor, undefined, "marks")
    check(d.isDark && d.alpha > floor && markContrast(grey(g), true, d.alpha) >= MARK_TARGET
          && markContrast(grey(g), true, d.alpha - 0.01) < MARK_TARGET,
          `marks A: grey ${g.toFixed(3)} thickens the dock to the least glass its dot reads on (${d.alpha})`)
    // Where text needs B, the dot does not: it reads on dark glass over pure white by
    // thickening alone (0.50), so the dock keeps the mode's skin.
    const white = decideGlass(flat(grey(1)), true, floor, undefined, "marks")
    check(!decideGlass(flat(grey(1)), true, floor).isDark && white.isDark && white.alpha <= GLASS_ADAPT_CEILING,
          `marks: pure white flips text to the light skin, but only thickens the dock (${white.alpha})`)
}

// ── 4c. Tooltips: a fixed floor that reads over ANY backdrop ─────────────────
// One line of primary text, not measured: its floor must carry it over the worst case
// for each skin, and be the LEAST that does (more would be solid for nothing).
{
    const d = TOOLTIP_GLASS_FLOOR.dark, l = TOOLTIP_GLASS_FLOOR.light
    check(tierContrast(grey(1), true, d, "primary") >= 4.5 && tierContrast(grey(1), true, d - 0.01, "primary") < 4.5,
          `tooltip, dark: ${d} is the least glass whose text reads 4.5:1 over pure white`)
    check(tierContrast(grey(0), false, l, "primary") >= 4.5 && tierContrast(grey(0), false, l - 0.01, "primary") < 4.5,
          `tooltip, light: ${l} is the least glass whose text reads 4.5:1 over pure black`)
    let worst = Infinity
    for (let v = 0; v <= 1.0001; v += 0.01)
        worst = Math.min(worst, tierContrast(grey(v), true, d, "primary"), tierContrast(grey(v), false, l, "primary"))
    check(worst >= 4.5, `tooltip: no grey backdrop defeats either floor (worst ${worst.toFixed(2)})`)
    check(d <= GLASS_ADAPT_CEILING && l <= GLASS_ADAPT_CEILING, "tooltip: both floors sit under the adaptive ceiling")
}

// ── 5. Hysteresis ────────────────────────────────────────────────────────────
{
    // A backdrop where dark glass at the ceiling passes, but not by FLIP_BACK_MARGIN.
    let g = 0
    for (let v = 0.3; v <= 1; v += 0.002) {
        const m = legibilityMargin(grey(v), true, GLASS_ADAPT_CEILING)
        if (m >= 1 && m < 1.1) { g = v; break }
    }
    check(g > 0, "there is a backdrop inside the flip-back band (the test below is not vacuous)")
    const stay = decideGlass(flat(grey(g)), true, floor, { isDark: false, alpha: floor })
    check(!stay.isDark, "a flipped surface does not flip back inside the margin")
    const fresh = decideGlass(flat(grey(g)), true, floor)
    check(fresh.isDark, "…while a fresh surface over the same backdrop keeps its own skin")
    const home = decideGlass(flat(grey(0.5)), true, floor, { isDark: false, alpha: floor })
    check(home.isDark && home.alpha === floor, "a flipped surface goes home once its skin clears the margin")
}
{
    // Deadband: shedding a sliver is not worth a repaint; needing more always is.
    let g = 0
    for (let v = 0.3; v <= 1; v += 0.002) {
        const need = decideGlass(flat(grey(v)), true, floor).alpha
        if (need > floor + 0.02 && need < GLASS_ADAPT_CEILING - 0.02) { g = v; break }
    }
    const need = decideGlass(flat(grey(g)), true, floor).alpha
    const kept = decideGlass(flat(grey(g)), true, floor, { isDark: true, alpha: need + 0.02 })
    check(kept.alpha === need + 0.02, "deadband: 0.02 of spare body is kept")
    const shed = decideGlass(flat(grey(g)), true, floor, { isDark: true, alpha: need + 0.05 })
    check(shed.alpha === need, "deadband: 0.05 of spare body is shed")
}

// ── 5b. A alone (`flip: false`) — how the shell decides since 2026-09-30 ─────
{
    const white = decideGlass(flat(grey(1)), true, floor, undefined, "text", false)
    check(white.isDark && white.alpha === GLASS_ADAPT_CEILING,
          `no flip: over pure white, dark glass stays dark and goes to the ceiling (${white.alpha})`)
    check(tierContrast(grey(1), true, GLASS_ADAPT_CEILING, "primary") >= 4.5,
          "no flip: at the ceiling, primary text still reads over pure white (A alone is enough for it)")
    const mid = decideGlass(flat(grey(0.5)), true, floor, undefined, "text", false)
    check(mid.isDark && mid.alpha === floor, "no flip: over mid grey nothing changes")
    // A surface that wore the other skin comes home at once, however bright the backdrop.
    check(decideGlass(flat(grey(1)), true, floor, { isDark: false, alpha: floor }, "text", false).isDark,
          "no flip: a surface in the other skin comes back to the one it is told to wear")
}

// ── 6. The bar row: its skin comes from the backdrop, not from the mode (#676) ─
{
    // Dark backdrop → white ink, light backdrop → black ink, whatever the mode.
    check(decideGlassByBackdrop(flat(grey(0.1)), floor).isDark, "by backdrop: a dark backdrop gets dark glass + white ink")
    check(!decideGlassByBackdrop(flat(grey(0.95)), floor).isDark, "by backdrop: a light backdrop gets light glass + black ink")
    // …whatever skin it wore before, when the other is CLEARLY better.
    check(decideGlassByBackdrop(flat(grey(0.1)), floor, { isDark: false, alpha: floor }).isDark,
          "by backdrop: light glass over a dark backdrop goes dark (not only when illegible)")
    // Hysteresis: find a grey where the two skins read within 10 % of each other.
    let g = 0
    for (let v = 0.2; v <= 0.9; v += 0.002) {
        const d = legibilityMargin(grey(v), true, floor), l = legibilityMargin(grey(v), false, floor)
        if (d >= 1 && l >= 1 && Math.max(d, l) / Math.min(d, l) < 1.05) { g = v; break }
    }
    check(g > 0, "there is a backdrop where both skins read about as well (the test below is not vacuous)")
    check(decideGlassByBackdrop(flat(grey(g)), floor, { isDark: true, alpha: floor }).isDark
          && !decideGlassByBackdrop(flat(grey(g)), floor, { isDark: false, alpha: floor }).isDark,
          `by backdrop: in the middle (grey ${g.toFixed(3)}) a surface keeps the skin it wears`)
}

{
    // The TYPICAL backdrop decides, not the extremes: a mostly dark bar with a pale
    // stretch keeps dark glass (and thickens it): white ink over a mostly dark top edge.
    const mixed: BackdropStats = { brightest: grey(0.8), darkest: grey(0.05), mean: grey(0.2), samples: 1000, area: 1000 }
    const d = decideGlassByBackdrop(mixed, floor)
    check(d.isDark && d.alpha > floor, `by backdrop: a mostly dark backdrop with a pale stretch keeps dark glass, thickened (${d.alpha})`)
}

{
    // A group decides by AREA: the bar's strip (large, sampled sparsely) against the
    // island's capsule (small, sampled densely). The case that shipped wrong on
    // 2026-09-29: the capsule's 2600 samples outvoted the strip's 681 and a bar over a
    // mostly purple strip went black-on-light.
    const strip: BackdropStats = { brightest: grey(0.7), darkest: grey(0.1), mean: grey(0.15), samples: 681, area: 81000 }
    const capsule: BackdropStats = { brightest: grey(0.6), darkest: grey(0.4), mean: grey(0.55), samples: 2600, area: 9500 }
    const m = mergeBackdropStats([strip, capsule])
    check(near(m.mean.r, (0.15 * 81000 + 0.55 * 9500) / 90500, 1e-9) && m.area === 90500,
          "merge: the typical backdrop is weighted by SCREEN covered, not by samples")
    check(decideGlassByBackdrop(m, floor).isDark, "merge: so the bar row over a mostly dark strip keeps white ink")
}

{
    // A strip of TWO colours — the default wallpaper under the bar: pale pink one side,
    // deep purple the other. A few percent of it changing side (a longer window title, a
    // new tray icon: the capsules grow over it) must not flip the row. With the median it
    // did (owner-caught 2026-09-29, same wallpaper, different workspaces): the median is
    // whichever colour covers more than half, and it jumped from one to the other.
    const strip = (lightShare: number) => {
        const px: Rgb[] = []
        for (let i = 0; i < 1000; i++) px.push(i < lightShare * 1000 ? { r: 0.87, g: 0.6, b: 0.84 } : { r: 0.3, g: 0.05, b: 0.7 })
        return backdropStats(px)!
    }
    const at51 = decideGlassByBackdrop(strip(0.51), floor)
    const at49 = decideGlassByBackdrop(strip(0.49), floor)
    check(decideGlassByBackdrop(strip(0.49), floor, at51).isDark === at51.isDark
          && decideGlassByBackdrop(strip(0.51), floor, at49).isDark === at49.isDark,
          "two-colour strip: 2 % of it changing side does not flip the row's skin")
}

// ── 7. Hyprland's colour pipeline, for a panel measured while CLOSED ─────────
{
    // The validation of 2026-09-29: the wallpaper under the bar's right capsule, blurred
    // (220,151,164 at x=80 and 84,16,162 at x=2400), went through Hyprland to within 1–2
    // levels of what `uncomposite` recovered live from the screen (253,134,153 / 76,7,168).
    const at = (c: Rgb) => { const o = hyprlandVibrancy(hyprlandPrepare(c, NIDARA_BLUR), NIDARA_BLUR); return [o.r, o.g, o.b].map(v => Math.round(v * 255)) }
    const pink = at({ r: 220 / 255, g: 151 / 255, b: 164 / 255 }), purple = at({ r: 84 / 255, g: 16 / 255, b: 162 / 255 })
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 4)
    check(close(pink, [252, 131, 156]) && close(purple, [77, 8, 170]),
          `Hyprland's pipeline reproduces the validated backdrops (${pink} / ${purple})`)
    const grey = at({ r: 0.5, g: 0.5, b: 0.5 })
    check(grey.every(v => v === 128), "…and leaves a mid grey alone (gain(0.5) = 0.5, no saturation to boost)")
}

// ── 8. The ramp the token engine emits is the ramp checked here ──────────────
check(TEXT_INK.dark.secondary === 0.8 && TEXT_INK.dark.dim === 0.6
      && TEXT_INK.light.secondary === 0.85 && TEXT_INK.light.dim === 0.72,
      "TEXT_INK holds the shipped ramp (a change here is a design change: re-measure #673)")

// ── 9. The dark glass's tint follows the backdrop's colour, never its grey ───
// Owner's call (2026-09-30): a colourless backdrop keeps the neutral tint — forcing a
// hue onto cream or grey-blue came out khaki and green-grey. A coloured one lends its
// hue at the neutral tint's lightness, and the decision is computed against it.
{
    const neutral = { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }
    const same = (a: Rgb, b: Rgb) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) < 1e-9
    check(same(tintFromBackdrop({ r: 0.96, g: 0.95, b: 0.92 }), neutral) && same(tintFromBackdrop(grey(0.5)), neutral),
          "tint: a colourless backdrop (cream, mid grey) keeps the neutral tint")
    const yellowGreen = { r: 208 / 255, g: 233 / 255, b: 188 / 255 }   // the dock's live backdrop, 2026-09-30
    check(same(tintFromBackdrop(yellowGreen), neutral) && same(tintFromBackdrop({ r: 0.94, g: 0.86, b: 0.47 }), neutral),
          "tint: a yellow or yellow-green backdrop keeps the neutral tint (dark, those hues are olive)")
    const blue = { r: 0.63, g: 0.75, b: 0.88 }   // pale blue, as under the 2026-09-30 sheet
    const t = tintFromBackdrop(blue)
    check(t.b > t.r + 0.02 && Math.abs(luminance(t) - luminance(neutral)) < 0.01,
          `tint: a pale blue backdrop gives a blue tint at the neutral one's luminance (${[t.r, t.g, t.b].map(v => Math.round(v * 255))})`)
    const st = { brightest: blue, darkest: blue, mean: blue, samples: 100, area: 100 }
    const d = decideGlass(st, true, 0.24, undefined, "text", false, t)
    check(d.tint === t && tierContrast(blue, true, d.alpha, "primary", t) >= 4.5,
          `tint: the decision carries it and holds primary 4.5:1 against it (alpha ${d.alpha})`)
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall ok")
if (failures) process.exit(1)

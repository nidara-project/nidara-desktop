// glass-legibility-probe.ts — the adaptive glass's rule, held to its numbers (#673).
//
//   npx --yes esbuild@0.25.10 scripts/dev/glass-legibility-probe.ts --bundle \
//     --platform=node --format=esm --outfile=/tmp/glass-probe.mjs && node /tmp/glass-probe.mjs
//
// Pure: no GI, no display. Exits non-zero on any failure — and CI deletes a rule
// before running it once, and requires THAT run to fail, because a probe that has
// only ever printed "ok" has been run, not tested.

import {
    uncomposite, glassOver, tierContrast, legibilityMargin, decideGlass, decideGlassByBackdrop, mergeBackdropStats, backdropStats, hyprlandPrepare, hyprlandVibrancy, NIDARA_BLUR,
    GLASS_ADAPT_CEILING, TEXT_INK, type Rgb, type BackdropStats,
} from "../../ui/lib/nidara-kit/platform/glass-legibility"
import { GLASS_TINT } from "../../ui/lib/nidara-kit/platform/tokens"

let failures = 0
const check = (ok: boolean, what: string) => {
    if (ok) console.log(`ok    ${what}`)
    else { failures++; console.log(`FAIL  ${what}`) }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const grey = (v: number): Rgb => ({ r: v, g: v, b: v })
const flat = (c: Rgb): BackdropStats => ({ brightest: c, darkest: c, median: c, samples: 1000, area: 1000 })

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

// ── 6. The bar row: its skin comes from the backdrop, not from the mode (#676) ─
{
    // As macOS's menu bar: dark backdrop → white ink, light backdrop → black ink.
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
    // stretch keeps dark glass (and thickens it), as macOS's menu bar keeps white ink.
    const mixed: BackdropStats = { brightest: grey(0.8), darkest: grey(0.05), median: grey(0.2), samples: 1000, area: 1000 }
    const d = decideGlassByBackdrop(mixed, floor)
    check(d.isDark && d.alpha > floor, `by backdrop: a mostly dark backdrop with a pale stretch keeps dark glass, thickened (${d.alpha})`)
}

{
    // A group decides by AREA: the bar's strip (large, sampled sparsely) against the
    // island's capsule (small, sampled densely). The case that shipped wrong on
    // 2026-09-29: the capsule's 2600 samples outvoted the strip's 681 and a bar over a
    // mostly purple strip went black-on-light.
    const strip: BackdropStats = { brightest: grey(0.7), darkest: grey(0.1), median: grey(0.15), samples: 681, area: 81000 }
    const capsule: BackdropStats = { brightest: grey(0.6), darkest: grey(0.4), median: grey(0.55), samples: 2600, area: 9500 }
    const m = mergeBackdropStats([strip, capsule])
    check(m.median.r === 0.15 && m.area === 90500, "merge: the typical backdrop is the one covering the most SCREEN, not the most samples")
    check(decideGlassByBackdrop(m, floor).isDark, "merge: so the bar row over a mostly dark strip keeps white ink")
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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall ok")
if (failures) process.exit(1)

// glass-legibility-probe.ts — the client-painted glass's model, held to its numbers.
//
//   npx --yes esbuild@0.25.10 scripts/dev/glass-legibility-probe.ts --bundle \
//     --platform=node --format=esm --outfile=/tmp/glass-probe.mjs && node /tmp/glass-probe.mjs
//
// Pure: no GI, no display. Exits non-zero on any failure — and CI moves a tooltip floor
// before running it once, and requires THAT run to fail, because a probe that has only
// ever printed "ok" has been run, not tested.
import {
    glassOver, tierContrast, TEXT_INK, TOOLTIP_GLASS_FLOOR, luminance, type Rgb,
    setGlassFrost, frostAt, frostedFill,
} from "../../ui/lib/nidara-kit/platform/glass-legibility"
import { GLASS_TINT } from "../../ui/lib/nidara-kit/platform/tokens"

let failures = 0
const check = (ok: boolean, what: string) => {
    if (ok) console.log(`ok    ${what}`)
    else { failures++; console.log(`FAIL  ${what}`) }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const grey = (v: number): Rgb => ({ r: v, g: v, b: v })

// ── 1. The forward model is the one that was validated ───────────────────────
// tech-debt #82's table (GLASS_TINT.dark, white ink): 1.69 over pure white and 5.71
// over mid grey at 0.24. The live screenshot of 2026-09-29 matched this model to
// 1–2/255; if these move, the model moved.
check(near(tierContrast(grey(1), true, 0.24, "primary"), 1.69, 0.01), "dark 0.24 over white: primary 1.69 (#82)")
check(near(tierContrast(grey(0.5), true, 0.24, "primary"), 5.71, 0.01), "dark 0.24 over mid grey: primary 5.71 (#82)")
check(near(tierContrast(grey(1), true, 0.48, "dim"), 2.13, 0.01), "dark 0.48 over white: dim 2.13 (#673)")

// ── 2. Tooltips: a fixed floor that reads over ANY backdrop ─────────────────
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
}

// ── 3. The ramp the token engine emits is the ramp checked here ──────────────
check(TEXT_INK.dark.secondary === 0.8 && TEXT_INK.dark.dim === 0.6
      && TEXT_INK.light.secondary === 0.85 && TEXT_INK.light.dim === 0.72,
      "TEXT_INK holds the shipped ramp (a change here is a design change: re-measure the tooltip floors)")

// ── 4. The frosted material's haze (#674) ──────────────────────────────────
// It exists to tell the materials apart over a DARK wallpaper, where more of a dark
// tint shows nothing; and it must not cost any guarantee measured without it.
{
    const dark = { r: 19 / 255, g: 1 / 255, b: 61 / 255 }   // behind the bar, 2026-09-30
    const white = grey(1)
    const plain = frostedFill({ r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }, 0.44, 0)
    setGlassFrost(0)
    const bare = glassOver(dark, true, 0.44)
    setGlassFrost(0.10)
    const hazed = glassOver(dark, true, 0.44)
    check(luminance(hazed) > 1.5 * luminance(bare),
          `frost: over the dark wallpaper the haze is SEEN (luminance ${luminance(bare).toFixed(4)} → ${luminance(hazed).toFixed(4)})`)
    const fill = frostedFill(plain.tint, 0.44)
    const byTwo = { r: (dark.r * 0.56 + plain.tint.r * 0.44) * 0.9 + 0.1, g: (dark.g * 0.56 + plain.tint.g * 0.44) * 0.9 + 0.1, b: (dark.b * 0.56 + plain.tint.b * 0.44) * 0.9 + 0.1 }
    const byOne = { r: dark.r * (1 - fill.alpha) + fill.tint.r * fill.alpha, g: dark.g * (1 - fill.alpha) + fill.tint.g * fill.alpha, b: dark.b * (1 - fill.alpha) + fill.tint.b * fill.alpha }
    check(near(byTwo.r, byOne.r, 1e-9) && near(byTwo.g, byOne.g, 1e-9) && near(byTwo.b, byOne.b, 1e-9),
          "frost: the one folded fill paints exactly the tint and the haze over it")
    check(frostAt(TOOLTIP_GLASS_FLOOR.dark) === 0, "frost: gone at the tooltips' floor")
    check(tierContrast(white, true, TOOLTIP_GLASS_FLOOR.dark, "primary") >= 4.5,
          `frost: a tooltip's text still clears 4.5:1 over pure white (${tierContrast(white, true, TOOLTIP_GLASS_FLOOR.dark, "primary").toFixed(2)})`)
    setGlassFrost(0)
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall ok")
if (failures) process.exit(1)

// SPDX-License-Identifier: LGPL-3.0-or-later
// No GI imports, here or in `./tokens`: the probe runs this under plain node.
import { GLASS_TINT } from "./tokens"

/**
 * NIDARA — the glass a client paints itself, and the text on it
 * =============================================================
 *
 * Pure arithmetic, no GTK, kept where a probe can hold it to its numbers
 * (`scripts/dev/glass-legibility-probe.ts`, run in CI with a control that must be caught).
 *
 * The glass is `GLASS_TINT` at an opacity, with the material's haze over it (`frostedFill`),
 * laid over the blurred backdrop:
 *
 *     screen = glass · alpha + backdrop · (1 − alpha)
 *
 * Measured 2026-09-29: the model reproduces the bar's glass in a live screenshot to 1–2/255
 * per channel. It is what a client painting its own glass (the greeter on Hyprland, a nested
 * control on a pane) paints with, and what the tooltip's floor is held against.
 *
 * Until 2026-10-13 it also held the ADAPTIVE glass's rule (#673: thicken each shell surface,
 * then flip its skin, by a backdrop it measured) and a model of Hyprland's blur. On Hyalo the
 * compositor paints the shell's glass and measures under it itself; both went with #762.
 */

/** A colour as sRGB-encoded floats, 0..1. */
export interface Rgb { r: number; g: number; b: number }

/**
 * The text ramp: the ink alpha of each tier, per skin. THE source — the token engine
 * (`theme-tokens.ts`) emits `--nidara-text-*` from these, so the tiers this module
 * checks are the tiers on screen by construction.
 *
 * Light gets more ink than dark on purpose: black ink over translucent light glass
 * reads washed-out at the dark alphas (the note that used to sit in the token engine).
 * Disabled (0.3) is not here: it is exempt from contrast minimums, as in WCAG.
 */
export const TEXT_INK = {
    dark:  { primary: 1, secondary: 0.8,  dim: 0.6 },
    light: { primary: 1, secondary: 0.85, dim: 0.72 },
} as const

export type TextTier = keyof typeof TEXT_INK.dark

/**
 * The least glass a TOOLTIP wears, per skin: what its one line of primary text needs to
 * reach 4.5:1 over the worst backdrop there is — pure white under dark glass, pure black
 * under light (owner, 2026-09-29). A tooltip is not measured: it is its own popup over
 * whatever is below it (a bar tooltip hangs over the windows, not over the bar's strip),
 * and measuring it would mean changing it while it is being read. It carries only the
 * primary tier, so it never needs rule B,. Held to
 * these numbers — they are the LEAST that passes — by `glass-legibility-probe.ts`.
 * More solid than the rest of the glass, on purpose: a tooltip is read at a glance.
 */
export const TOOLTIP_GLASS_FLOOR = { dark: 0.59, light: 0.47 } as const

const DARK_TINT: Rgb = { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }
const LIGHT_TINT: Rgb = { r: GLASS_TINT.light.r, g: GLASS_TINT.light.g, b: GLASS_TINT.light.b }
const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

const over = (dst: Rgb, src: Rgb, a: number): Rgb => ({
    r: dst.r * (1 - a) + src.r * a,
    g: dst.g * (1 - a) + src.g * a,
    b: dst.b * (1 - a) + src.b * a,
})

const toLinear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)

/** WCAG relative luminance of an sRGB colour. */
export function luminance(c: Rgb): number {
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
}

/** WCAG contrast ratio, ≥ 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const x = luminance(a), y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// ── The material's FROST (#674) ──────────────────────────────────────────────

/**
 * A white haze over the tint — what makes frosted glass read as frosted. Our tint only
 * DARKENS, so over a near-black wallpaper more of it changes nothing you can see: the
 * three glass materials came out identical there (owner-caught 2026-09-30, measured
 * behind the bar: 19,1,61). A haze LIGHTENS, which is what macOS's glass does (its dark
 * material lightens the backdrop too: `reference_macos27_glass_recipe`).
 *
 * It costs white text contrast, so it gives way as the glass thickens: full up to
 * `FROST_FULL_UNTIL` (the thickest floor any material sets), none from `FROST_GONE_AT`
 * on — under the tooltips' floor (0.59), so every guarantee measured without a haze still
 * holds where it was measured.
 *
 * A property of the whole MATERIAL, so it is set once per process by
 * whoever owns the material (the shell, from `Theme.glassFrost`) rather than threaded
 * through every call. 0 — no haze, the model as it was — until then.
 */
export const FROST_FULL_UNTIL = 0.48
export const FROST_GONE_AT = 0.58
let materialFrost = 0
export function setGlassFrost(frost: number): void { materialFrost = Math.max(0, Math.min(1, frost)) }
export function glassFrost(): number { return materialFrost }

/** The haze actually laid over glass at `alpha`. */
export function frostAt(alpha: number, frost: number = materialFrost): number {
    if (frost <= 0 || alpha >= FROST_GONE_AT) return 0
    return frost * Math.min(1, (FROST_GONE_AT - alpha) / (FROST_GONE_AT - FROST_FULL_UNTIL))
}

/**
 * The ONE fill that paints exactly the tint at `alpha` with the haze over it — so every
 * painter gets the frost by painting what it always painted, with this colour and alpha
 * (`over(over(B, T, a), W, f) ≡ over(B, T', a')`, a' = 1 − (1 − a)(1 − f),
 * T' = (T·a·(1 − f) + f) / a').
 */
export function frostedFill(tint: Rgb, alpha: number, frost: number = materialFrost): { tint: Rgb; alpha: number } {
    const f = frostAt(alpha, frost)
    if (f <= 0) return { tint, alpha }
    const a = 1 - (1 - alpha) * (1 - f)
    const k = alpha * (1 - f) / a, w = f / a
    return { alpha: a, tint: { r: tint.r * k + w, g: tint.g * k + w, b: tint.b * k + w } }
}

/** The glass as it reaches the eye: its tint at `alpha` over the (blurred) backdrop, and
 *  the material's haze over that (`frostAt`). `tint` overrides the DARK skin's; the light
 *  skin always wears `GLASS_TINT.light`. */
export function glassOver(backdrop: Rgb, isDark: boolean, alpha: number, tint?: Rgb): Rgb {
    const g = over(backdrop, isDark ? (tint ?? DARK_TINT) : LIGHT_TINT, alpha)
    const f = frostAt(alpha)
    return f > 0 ? over(g, WHITE, f) : g
}

/** The contrast of one tier of text on that glass. */
export function tierContrast(backdrop: Rgb, isDark: boolean, alpha: number, tier: TextTier, tint?: Rgb): number {
    const glass = glassOver(backdrop, isDark, alpha, tint)
    const ink = over(glass, isDark ? WHITE : BLACK, TEXT_INK[isDark ? "dark" : "light"][tier])
    return contrastRatio(ink, glass)
}


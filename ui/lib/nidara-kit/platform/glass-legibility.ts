// SPDX-License-Identifier: LGPL-3.0-or-later
// No GI imports, here or in `./tokens`: the probe runs this under plain node.
import { GLASS_TINT, INK } from "./tokens"

/**
 * NIDARA — is the text on a piece of glass legible, and what must the glass do if not
 * ===================================================================================
 *
 * Pure arithmetic, no GTK: the rule the adaptive glass (#673) applies, kept where a
 * probe can hold it to its numbers (`scripts/dev/glass-legibility-probe.ts`, run in
 * CI with a control that must be caught).
 *
 * ── WHAT IS BEING MODELLED ───────────────────────────────────────────────────
 *
 * A shell surface is our layer composited by Hyprland over the BLURRED backdrop:
 *
 *     screen = ours_premultiplied + backdrop · (1 − ours_alpha)
 *
 * and the glass body is `GLASS_TINT` at the surface's opacity. `uncomposite()` runs
 * that equation backwards on a captured pixel whose `ours` is known — which is how
 * `core/BackdropProbe.ts` learns what the text really sits on: the backdrop as
 * Hyprland processed it (blur, contrast, vibrancy), whatever put it there — wallpaper,
 * a fullscreen video, another client's layer.
 *
 * Measured 2026-09-29 before any of this was written: the forward model reproduces
 * the bar's glass in a live screenshot to 1–2/255 per channel. The numbers it gives
 * (dark skin, glass 0.48, 140,608 backdrops): primary text fails 4.5:1 on 22 % of
 * them, secondary on 36 %, dim on 67 %; worst case pure white, 3.21 / 2.64 / 2.13.
 * No global floor fixes that (tech-debt #82) — hence a per-surface answer.
 *
 * ── THE RULE (owner, 2026-09-29: "A+B") ──────────────────────────────────────
 *
 * A. **Thicken** the surface's tint, from the user's glass slider up to
 *    `GLASS_ADAPT_CEILING` — never below the slider: the slider is a floor now.
 * B. If the ceiling is not enough, **flip the skin** (dark glass + white ink ↔
 *    light glass + black ink) for that surface.
 *
 * The unit is the SURFACE (the whole bar, the open panel, the island, the app grid,
 * the dock), never one capsule of it: capsules of one bar at different tints read as
 * a bug.
 *
 * What "legible" means depends on what the surface CARRIES (`GlassContent`): text is
 * held to the text ramp's targets; the dock, which carries no text, to its marks'.
 */

/** A colour as sRGB-encoded floats, 0..1. */
export interface Rgb { r: number; g: number; b: number }

/** One pixel of OUR layer, as the renderer produced it: PREMULTIPLIED rgb, 0..1. */
export interface PremulRgba { r: number; g: number; b: number; a: number }

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
 * The minimum contrast each tier must reach against the glass it sits on.
 * Primary and secondary are body text → WCAG AA (4.5:1). Dim is metadata → the
 * large-text / UI-component minimum (3:1).
 */
export const LEGIBILITY_TARGET: Record<TextTier, number> = {
    primary: 4.5,
    secondary: 4.5,
    dim: 3.0,
}

/**
 * What a surface carries that has to stay readable on its glass.
 *
 * - `text` — the three tiers of `TEXT_INK`, at `LEGIBILITY_TARGET`. Every surface with
 *   words on it.
 * - `marks` — chrome ink (`INK.solid`) and no text: the dock, whose running dot is its
 *   only drawn content (its icons are the apps' own artwork, and the adaptive glass
 *   does not touch them). A mark is a non-text UI component, so WCAG 1.4.11's 3:1,
 *   not the 4.5:1 of body text — holding the dock to the text rule would thicken it
 *   for words it does not have. Its tooltips and menus are their own glass, and
 *   follow its SKIN, not its alpha.
 */
export type GlassContent = "text" | "marks"

/** The contrast a `marks` surface's ink must reach: WCAG 1.4.11 (non-text contrast). */
export const MARK_TARGET = 3.0

/**
 * How far A may thicken before B takes over. 0.60 because tech-debt #82 measured
 * that past ~0.59 the material stops reading as glass, and because it is the same
 * body the CC container's shadow reaches at its most (0.48 glass + 0.22 shadow ≈
 * 0.594). A slider set above it is left alone: the floor wins.
 */
export const GLASS_ADAPT_CEILING = 0.60

/**
 * The least glass a TOOLTIP wears, per skin: what its one line of primary text needs to
 * reach 4.5:1 over the worst backdrop there is — pure white under dark glass, pure black
 * under light (owner, 2026-09-29). A tooltip is not measured: it is its own popup over
 * whatever is below it (a bar tooltip hangs over the windows, not over the bar's strip),
 * and measuring it would mean changing it while it is being read. It carries only the
 * primary tier, so it never needs rule B, and both values sit under the ceiling. Held to
 * these numbers — they are the LEAST that passes — by `glass-legibility-probe.ts`.
 * More solid than the rest of the glass, on purpose: a tooltip is read at a glance.
 */
export const TOOLTIP_GLASS_FLOOR = { dark: 0.59, light: 0.47 } as const

/**
 * Hysteresis for the way BACK to the user's own skin: a flipped surface returns
 * only when its own skin clears every target by this factor at the ceiling. Without
 * it a backdrop sitting on the threshold flips the surface back and forth.
 */
export const FLIP_BACK_MARGIN = 1.1

/** An alpha change smaller than this, downwards, is not worth a repaint. */
export const ALPHA_DEADBAND = 0.03

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
 * It costs white text contrast, so it gives way as the adaptive glass thickens: full up
 * to `FROST_FULL_UNTIL` (the thickest floor any material sets), none from
 * `FROST_GONE_AT` on — under the tooltips' floor (0.59) and the ceiling (0.60), so
 * every guarantee measured without a haze still holds where it was measured. Over a
 * bright backdrop, where the glass has thickened, the backdrop is the light anyway.
 *
 * A property of the whole MATERIAL, like the ceiling, so it is set once per process by
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
 *  the material's haze over that (`frostAt`).
 *  `tint` is the DARK skin's tint when it is not the neutral one (`tintFromBackdrop`);
 *  the light skin always wears `GLASS_TINT.light`. */
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

/** The contrast of chrome ink (`INK.solid`, the dock's running dot) on that glass. */
export function markContrast(backdrop: Rgb, isDark: boolean, alpha: number, tint?: Rgb): number {
    const glass = glassOver(backdrop, isDark, alpha, tint)
    return contrastRatio(over(glass, isDark ? WHITE : BLACK, INK.solid), glass)
}

/**
 * The WORST tier's contrast as a fraction of its own target: ≥ 1 means every tier
 * passes. One number, so "does it pass" and "which choice passes better" are the
 * same comparison. For `marks` there is one tier, the mark.
 */
export function legibilityMargin(backdrop: Rgb, isDark: boolean, alpha: number, content: GlassContent = "text", tint?: Rgb): number {
    if (content === "marks") return markContrast(backdrop, isDark, alpha, tint) / MARK_TARGET
    let worst = Infinity
    for (const tier of Object.keys(LEGIBILITY_TARGET) as TextTier[])
        worst = Math.min(worst, tierContrast(backdrop, isDark, alpha, tier, tint) / LEGIBILITY_TARGET[tier])
    return worst
}

/**
 * The backdrop under a captured pixel, given what WE painted there.
 * `screen` is the captured pixel; `ours` is our layer's pixel, premultiplied.
 * Null where our paint is too opaque to see through with any precision — text,
 * icons — or too transparent to have been blurred (below the layer's `ignore_alpha`
 * the compositor shows the backdrop RAW, which is not what text on glass sits on).
 */
export function uncomposite(screen: Rgb, ours: PremulRgba, minAlpha: number, maxAlpha: number): Rgb | null {
    if (ours.a < minAlpha || ours.a > maxAlpha) return null
    const k = 1 / (1 - ours.a)
    const clamp = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v
    return {
        r: clamp((screen.r - ours.r) * k),
        g: clamp((screen.g - ours.g) * k),
        b: clamp((screen.b - ours.b) * k),
    }
}

/**
 * What a surface has behind it, reduced to the two backdrops that decide: the
 * BRIGHTEST (the worst case for dark glass and white ink) and the DARKEST (the worst
 * for light glass and black ink). High and low percentiles, not max and min, so a
 * handful of stray pixels — a cursor, an antialiased edge the renderer and the
 * compositor rounded differently — cannot move a whole surface.
 */
export interface BackdropStats {
    brightest: Rgb
    darkest: Rgb
    /** The TYPICAL backdrop: the MEAN colour of everything the surface covers — what a
     *  surface whose skin comes from its backdrop reads its skin from
     *  (`decideGlassByBackdrop`). For such a surface it spans its whole box, the parts it
     *  leaves see-through included (`backdropStats`'s `around`), not only its glass.
     *
     *  🔑 A mean, not the median — measured, 2026-09-29. Over a two-colour strip (the
     *  default wallpaper: pale pink left, deep purple right) the median is whichever
     *  colour covers more than half, so it JUMPS from one to the other when a few
     *  percent of the samples change side — and they did, every time the bar's capsules
     *  changed width: a longer window title on one workspace, a new tray icon. The bar
     *  changed skin over the same wallpaper (owner-caught). A mean moves by as much as
     *  the samples moved, and the hysteresis absorbs that. */
    mean: Rgb
    samples: number
    /** How much of the surface the samples behind `mean` stand for, in pixels. NOT
     *  `samples`: a large surface is sampled sparsely and a small one densely, so
     *  combining two by sample count let the island's small capsule outvote the whole
     *  bar four to one (2026-09-29 — the bar went black-on-light over a mostly purple
     *  strip). */
    area: number
}

/** Percentile used for both ends of `BackdropStats`. */
export const BACKDROP_PERCENTILE = 0.95

/** Reduce uncomposited backdrop pixels to their `BackdropStats`. Null if there are
 *  too few to mean anything. `pixelArea` = how many screen pixels each sample stands
 *  for (the sampling step squared). `around` = backdrop the surface covers WITHOUT
 *  glass (the gaps between the bar's capsules), sampled on the same grid: it counts
 *  toward the typical backdrop, never toward the extremes — no text sits on it. */
export function backdropStats(pixels: Rgb[], minSamples = 64, pixelArea = 1, around: Rgb[] = []): BackdropStats | null {
    if (pixels.length < minSamples) return null
    const ranked = pixels.map(p => ({ p, l: luminance(p) })).sort((x, y) => x.l - y.l)
    const at = (q: number) => ranked[Math.min(ranked.length - 1, Math.max(0, Math.round(q * (ranked.length - 1))))].p
    const all = pixels.length + around.length
    const mean = { r: 0, g: 0, b: 0 }
    for (const list of [pixels, around]) for (const p of list) { mean.r += p.r / all; mean.g += p.g / all; mean.b += p.b / all }
    return {
        brightest: at(BACKDROP_PERCENTILE),
        darkest: at(1 - BACKDROP_PERCENTILE),
        mean,
        samples: pixels.length,
        area: all * pixelArea,
    }
}

/**
 * Several surfaces that decide as one (the bar and the island's capsule): the worst
 * of their extremes, and their TYPICAL backdrop as the mean of their means weighted
 * by how much of the screen each covers (`area`, never `samples`) — i.e. the mean of
 * everything they cover, as if they had been measured as one.
 */
export function mergeBackdropStats(all: BackdropStats[]): BackdropStats {
    let brightest = all[0].brightest, darkest = all[0].darkest, samples = 0, area = 0
    for (const st of all) {
        if (luminance(st.brightest) > luminance(brightest)) brightest = st.brightest
        if (luminance(st.darkest) < luminance(darkest)) darkest = st.darkest
        samples += st.samples
        area += st.area
    }
    const mean = { r: 0, g: 0, b: 0 }
    for (const st of all) {
        const w = area > 0 ? st.area / area : 1 / all.length
        mean.r += st.mean.r * w; mean.g += st.mean.g * w; mean.b += st.mean.b * w
    }
    return { brightest, darkest, mean, samples, area }
}

/** What a surface wears: its tint's opacity, its skin, and — on the dark skin — the
 *  tint itself when it is taken from the backdrop (`tintFromBackdrop`). */
export interface GlassDecision {
    alpha: number
    isDark: boolean
    tint?: Rgb
}

const ALPHA_STEP = 0.01

/** The least alpha in [floor, top] at which `isDark` glass reaches `margin` over
 *  `backdrop`, or null if even `top` does not. */
function leastAlpha(backdrop: Rgb, isDark: boolean, floor: number, top: number, margin: number, content: GlassContent, tint?: Rgb): number | null {
    for (let a = floor; a <= top + 1e-9; a += ALPHA_STEP) {
        if (legibilityMargin(backdrop, isDark, a, content, isDark ? tint : undefined) >= margin) return Math.round(a * 100) / 100
    }
    return null
}

/**
 * The rule. `preferDark` is the skin the surface wears; `floor` is the user's glass
 * slider for it; `current` is what the surface wears now, for hysteresis (omit for a
 * surface with no history); `content` is what has to stay readable on it.
 *
 * `flip: false` is A alone: the surface keeps `preferDark` whatever is behind it and
 * only thickens, up to the ceiling. That is how the SHELL decides since 2026-09-30
 * (owner: its skin no longer changes with the wallpaper, or with the system mode —
 * `AdaptiveGlass.ts`); B stays here, held to its numbers, for the extreme case the
 * owner has yet to define. Measured: dark glass at the ceiling keeps primary text at
 * 4.69:1 over pure white, so A alone never leaves the primary tier below its target.
 */
export function decideGlass(
    stats: BackdropStats,
    preferDark: boolean,
    floor: number,
    current?: GlassDecision,
    content: GlassContent = "text",
    flip = true,
    /** The dark skin's tint, when it comes from the backdrop (`tintFromBackdrop`): the
     *  contrast is computed against the glass the surface will really wear. */
    tint?: Rgb,
): GlassDecision {
    const withTint = (d: GlassDecision): GlassDecision => d.isDark && tint ? { ...d, tint } : d
    const top = Math.max(floor, GLASS_ADAPT_CEILING)
    const worst = (isDark: boolean) => isDark ? stats.brightest : stats.darkest
    const settle = (d: GlassDecision): GlassDecision => {
        // Deadband, downwards only: a surface that needs MORE body gets it now; one
        // that could shed a sliver keeps what it has.
        if (current && current.isDark === d.isDark && d.alpha < current.alpha
            && current.alpha - d.alpha < ALPHA_DEADBAND)
            return { isDark: d.isDark, alpha: current.alpha }
        return d
    }

    const flipped = current !== undefined && current.isDark !== preferDark

    if (!flip) {
        // A alone: as much body as it takes, up to the ceiling, and never the other skin.
        const a = leastAlpha(worst(preferDark), preferDark, floor, top, 1, content, tint)
        return withTint(flipped ? { isDark: preferDark, alpha: a ?? top } : settle({ isDark: preferDark, alpha: a ?? top }))
    }

    // A flipped surface goes home only with room to spare.
    if (flipped) {
        const home = leastAlpha(worst(preferDark), preferDark, floor, top, FLIP_BACK_MARGIN, content, tint)
        if (home !== null) {
            return withTint({ isDark: preferDark, alpha: leastAlpha(worst(preferDark), preferDark, floor, top, 1, content, tint) ?? home })
        }
    } else {
        // A: thicken the user's own skin.
        const a = leastAlpha(worst(preferDark), preferDark, floor, top, 1, content, tint)
        if (a !== null) return withTint(settle({ isDark: preferDark, alpha: a }))
    }

    // B: the other skin.
    const b = leastAlpha(worst(!preferDark), !preferDark, floor, top, 1, content, tint)
    if (b !== null) return withTint(settle({ isDark: !preferDark, alpha: b }))

    // Neither reaches every target even at the ceiling (a backdrop that is bright
    // AND dark at once — a high-contrast photo under a tall panel). Take the skin
    // that comes closest, at full body.
    const mine = legibilityMargin(worst(preferDark), preferDark, top, content, tint)
    const theirs = legibilityMargin(worst(!preferDark), !preferDark, top, content, tint)
    if (flipped && theirs >= mine / FLIP_BACK_MARGIN) return withTint({ isDark: !preferDark, alpha: top })
    return withTint({ isDark: mine >= theirs ? preferDark : !preferDark, alpha: top })
}

// ── The dark glass's tint, taken from what is behind it ──────────────────────

const toLinearC = toLinear
const toSrgbC = (v: number) => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055

/** sRGB → OKLab (Björn Ottosson's matrices). */
export function toOklab(c: Rgb): [number, number, number] {
    const R = toLinearC(c.r), G = toLinearC(c.g), B = toLinearC(c.b)
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
}

/** OKLab → sRGB, clamped into the gamut. */
export function fromOklab(L: number, a: number, b: number): Rgb {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3)
    const c = (v: number) => Math.min(1, Math.max(0, toSrgbC(v)))
    return { r: c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
             g: c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
             b: c(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) }
}

/** Below this OKLab chroma a backdrop has no colour worth taking: the tint stays the
 *  neutral one. Between the two it blends, so a backdrop drifting across the line does
 *  not snap the glass from grey to coloured. Owner's call (2026-09-30), after seeing it:
 *  forcing a colour onto a near-neutral backdrop (cream to grey-blue) came out khaki and
 *  green-grey — mud, not tinted glass. */
export const TINT_CHROMA_NEUTRAL = 0.025
export const TINT_CHROMA_FULL = 0.045
/** The tint takes the backdrop's hue at this much more chroma than the backdrop has,
 *  up to `TINT_CHROMA_MAX`: at the neutral tint's lightness the same chroma reads
 *  weaker, and a blurred backdrop has already lost some. */
export const TINT_CHROMA_GAIN = 1.4
/** 0.05 since 2026-09-30 (was 0.09): the glass follows the backdrop's colour, quietly —
 *  at 0.09 a mis-hued tint over a wide surface was the first thing the eye found. */
export const TINT_CHROMA_MAX = 0.05

/** OKLab hues (degrees) whose DARK versions are mud, not colour: dark orange is brown,
 *  dark yellow and yellow-green are olive and khaki (measured live, 2026-09-30: the dock
 *  over a pale yellow-green wallpaper, mean hue 131°, came out olive). Inside the band
 *  the tint stays neutral; it fades in over `TINT_HUE_FADE` degrees on each side, so
 *  reds, pinks, purples, blues, cyans and greens keep their tint. */
export const TINT_MUD_HUES: [number, number] = [65, 140]
export const TINT_HUE_FADE = 20

/** 1 outside the mud band, 0 inside it, a linear fade between. */
function hueWeight(hueDeg: number): number {
    const [lo, hi] = TINT_MUD_HUES
    const h = ((hueDeg % 360) + 360) % 360
    if (h >= lo && h <= hi) return 0
    const d = h < lo ? lo - h : h - hi
    return Math.min(1, d / TINT_HUE_FADE)
}

/**
 * The dark glass's tint over `mean`, the backdrop's mean colour: the backdrop's HUE, at
 * the neutral tint's LIGHTNESS (so text keeps, to within a few hundredths, the contrast
 * it had — the decision computes it against this tint anyway), with a little more
 * chroma than the backdrop has. Over a near-neutral backdrop, or one whose hue would
 * darken into mud (`TINT_MUD_HUES`), the neutral tint.
 *
 * What it is for (owner, 2026-09-30): dark glass over a pale backdrop has to come out a
 * mid-tone for white text to read — that is fixed — but a mid-tone in the backdrop's own
 * colour reads as tinted glass, where the neutral tint reads as grey.
 */
export function tintFromBackdrop(mean: Rgb): Rgb {
    const [L0, na, nb] = toOklab(DARK_TINT)
    const [, a, b] = toOklab(mean)
    const c = Math.hypot(a, b)
    const h = Math.atan2(b, a)
    const k = Math.min(1, Math.max(0, (c - TINT_CHROMA_NEUTRAL) / (TINT_CHROMA_FULL - TINT_CHROMA_NEUTRAL)))
        * hueWeight(h * 180 / Math.PI)
    if (k <= 0) return DARK_TINT
    const c1 = Math.min(TINT_CHROMA_MAX, c * TINT_CHROMA_GAIN)
    return fromOklab(L0, na + (c1 * Math.cos(h) - na) * k, nb + (c1 * Math.sin(h) - nb) * k)
}

/**
 * The rule for a surface whose skin comes from its BACKDROP rather than from the mode
 * — the bar row (#676): white ink over a dark top edge, black
 * over a light one, whatever the system mode.
 *
 * It takes the skin that reads BEST over the TYPICAL backdrop — the mean of the whole
 * row (`BackdropStats.mean`: why a mean, and why the whole row), not the
 * extremes: the ink follows the brightness of the wallpaper up there, which is
 * why it reads "almost always white" over the usual dark-topped
 * wallpapers. Deciding from the worst cases instead turned a bar over a pink-to-purple
 * wallpaper light because of its pale left end (2026-09-29). Legibility at the
 * extremes is then `decideGlass`'s job: it thickens the chosen skin, and its B can
 * still take the other one if a backdrop is bright and dark at once.
 *
 * Hysteresis: a surface keeps the skin it wears unless the other one reads better by
 * `FLIP_BACK_MARGIN` — a backdrop in the middle would otherwise flip it on every
 * measurement.
 */
export function decideGlassByBackdrop(
    stats: BackdropStats,
    floor: number,
    current?: GlassDecision,
): GlassDecision {
    const onDark = legibilityMargin(stats.mean, true, floor)
    const onLight = legibilityMargin(stats.mean, false, floor)
    let isDark = onDark >= onLight
    if (current && current.isDark !== isDark) {
        const mine = current.isDark ? onDark : onLight
        const theirs = current.isDark ? onLight : onDark
        if (theirs < mine * FLIP_BACK_MARGIN && mine >= 1) isDark = current.isDark
    }
    return decideGlass(stats, isDark, floor, current && current.isDark === isDark ? current : undefined)
}


// ── What Hyprland does to a backdrop before our glass is laid on it ──────────

/** The blur settings that change a backdrop's COLOUR (not its sharpness):
 *  `decoration:blur:{contrast,brightness,vibrancy,vibrancy_darkness,passes}`. */
export interface HyprlandBlurParams {
    contrast: number
    brightness: number
    vibrancy: number
    vibrancyDarkness: number
    passes: number
}

/** Nidara's shipped values (config/hypr/hyprland.lua) — the fallback when the
 *  compositor cannot be asked. */
export const NIDARA_BLUR: HyprlandBlurParams = { contrast: 1.2, brightness: 1.0, vibrancy: 0.4, vibrancyDarkness: 0.1, passes: 2 }

const gainCh = (x: number, k: number) => {
    x = Math.min(1, Math.max(0, x))
    const hi = x >= 0.5, y = hi ? 1 - x : x
    const a = 0.5 * Math.pow(2 * y, k)
    return hi ? 1 - a : a
}

/** `blurprepare.glsl`: contrast (`gain`) and brightness above 1, per pixel, BEFORE
 *  the blur averages anything. */
export function hyprlandPrepare(c: Rgb, p: HyprlandBlurParams): Rgb {
    const k = Math.max(1, p.brightness)
    const f = (v: number) => (p.contrast !== 1 ? gainCh(v, p.contrast) : v) * k
    return { r: f(c.r), g: f(c.g), b: f(c.b) }
}

function rgb2hsl(c: Rgb): [number, number, number] {
    const mn = Math.min(c.r, c.g, c.b), mx = Math.max(c.r, c.g, c.b), d = mx - mn, l = (mn + mx) / 2
    let s = 0, h = 0
    if (l > 0 && l < 1) s = d / ((l < 0.5 ? l : 1 - l) * 2)
    if (d > 0) {
        if (mx === c.r && mx !== c.g) h = (c.g - c.b) / d
        else if (mx === c.g && mx !== c.b) h = 2 + (c.b - c.r) / d
        else h = 4 + (c.r - c.g) / d
        h /= 6; if (h < 0) h += 1
    }
    return [h, s, l]
}

function hsl2rgb(h: number, s: number, l: number): Rgb {
    let xt: number[]
    if (h < 1 / 3) xt = [6 * (1 / 3 - h), 6 * h, 0]
    else if (h < 2 / 3) xt = [0, 6 * (2 / 3 - h), 6 * (h - 1 / 3)]
    else xt = [6 * (h - 2 / 3), 0, 6 * (1 - h)]
    const ct = xt.map(v => 2 * s * Math.min(v, 1) + (1 - s))
    const out = l >= 0.5 ? ct.map(v => (1 - l) * v + (2 * l - 1)) : ct.map(v => l * v)
    return { r: out[0], g: out[1], b: out[2] }
}

/**
 * `blur1.glsl`'s vibrancy — applied to an already AVERAGED colour, once per pass, as the
 * shader does. Transcribed from Hyprland v0.56.2; the forward model built from it
 * reproduced a real screenshot of our glass to 1–2/255 (2026-09-29).
 */
export function hyprlandVibrancy(c: Rgb, p: HyprlandBlurParams): Rgb {
    if (p.vibrancy === 0) return c
    let col = c
    for (let i = 0; i < p.passes; i++) {
        const vd1 = 1 - p.vibrancyDarkness
        const [h, s, l] = rgb2hsl(col)
        const x = Math.sqrt(col.r * col.r * 0.299 + col.g * col.g * 0.587 + col.b * col.b * 0.114)
        const a = Math.min(1, Math.max(0, 0.8 * vd1))
        const pb = x <= a ? a - Math.sqrt(Math.max(0, a * a - x * x)) : a + Math.sqrt(Math.max(0, (1 - a) ** 2 - (x - 1) ** 2))
        const b1 = 0.11 * vd1, A = 0.93, C = 0.66
        const t = Math.min(1, Math.max(0, ((1 - ((1 - s * Math.cos(A)) ** 2 + (1 - pb * Math.sin(A)) ** 2)) - (b1 - C / 2)) / C))
        const boost = s > 0 ? t * t * (3 - 2 * t) : 0
        col = hsl2rgb(h, Math.min(1, Math.max(0, s + boost * p.vibrancy / p.passes)), l)
    }
    // `blurFinish.glsl`: brightness below 1, after the blur.
    const k = Math.min(1, p.brightness)
    return { r: col.r * k, g: col.g * k, b: col.b * k }
}

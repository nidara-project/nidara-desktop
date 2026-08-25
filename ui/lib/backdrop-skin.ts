import GdkPixbuf from "gi://GdkPixbuf"
import { GLASS_TINT } from "./tokens"
import { BACKDROP_TRIM } from "./glass-capsule"

/**
 * Which skin does this wallpaper want? — the measurement half of tech-debt #82.
 *
 * #82 is "thin glass cannot carry white text over a bright wallpaper", and its
 * table is unarguable: white text on `GLASS_TINT.dark` at the shell's floor
 * measures 1.69:1 over a white wallpaper, and nothing under alpha 0.59 clears
 * 4.5:1 there — by which point the material has stopped reading as glass. So the
 * material cannot buy legibility. #82 says so itself: give the TEXT its own
 * contrast, do not keep raising the floor.
 *
 * 🔑 THE MEASUREMENT THAT DECIDED THE SHAPE OF THE FIX. Sweeping 140,608 backdrops
 * (the RGB cube at step 5) and asking, for each, what the BETTER of the two skins
 * scores:
 *
 *   alpha 0.24 — white-on-dark fails AA on 42.9 % of backdrops
 *                black-on-light fails on 14.9 %
 *                ...but the WORST CASE for the better of the two is 6.07:1
 *   alpha 0.48 — white-on-dark fails on 12.2 %; better-of-two worst case 8.75:1
 *
 * **There is no backdrop where both skins fail.** Not a claim about wallpapers we
 * ship — a claim about every colour there is. That is why the answer here is to
 * CHOOSE the skin from what is behind rather than to thicken the glass: choosing
 * clears AA everywhere at the material we already have, and it costs nothing.
 *
 * It is also what the prior art converged on. Apple's Liquid Glass (WWDC25) flips
 * the material light↔dark by its backdrop and flips the symbols on top with it,
 * "to maximize contrast". Windows' Acrylic instead buries an exclusion-blend layer
 * INSIDE the material "to ensure contrast and legibility of UI placed on an acrylic
 * background" — unreachable for us: our Cairo painters never see the backdrop, and
 * Hyprland's blur brightness knob (the one thing that could have stood in) was
 * removed in #81/#235 for the hard edge it drew along every antialiased boundary.
 *
 * ⚠️ WHY THIS IS HONEST FOR THE LOGIN SCREENS AND NOT (YET) FOR THE DESKTOP. What
 * sits behind the greeter and the lockscreen is ALWAYS the wallpaper — nothing else
 * can be there. Behind the shell's bar a fullscreen or floating window can be, and
 * this module cannot see one. That is the whole reason the mechanism lands here
 * first; extending it to the shell is a separate decision with a real blind spot in
 * it.
 *
 * ⚠️ AND IT IS THE WALLPAPER, NOT THE BLURRED BACKDROP. What is actually behind the
 * glass is the wallpaper after Hyprland's blur + `contrast 1.2 / vibrancy 0.4`. Blur
 * is a local mean, so the mean survives it; the greeter audit of 2026-08-24 checked
 * exactly this and the real screen measured 150/255 where the offscreen prediction
 * said 150/255. Contrast pushes away from mid-grey, which can only move a decision
 * that was already at the crossover — and at the crossover both skins pass (grey 114
 * scores 6.67 dark / 6.80 light), so the cost of being wrong there is nil.
 */

export type Skin = "dark" | "light"

/** Channels in 0..1, the same units as `GLASS_TINT`. */
export interface RGB { r: number; g: number; b: number }

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG contrast ratio between two opaque colours. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `tint` at `alpha` over `back`, source-over, in sRGB — the order the painter uses. */
function composite(tint: RGB, alpha: number, back: RGB): RGB {
  return {
    r: alpha * tint.r + (1 - alpha) * back.r,
    g: alpha * tint.g + (1 - alpha) * back.g,
    b: alpha * tint.b + (1 - alpha) * back.b,
  }
}

const WHITE: RGB = { r: 1, g: 1, b: 1 }
const BLACK: RGB = { r: 0, g: 0, b: 0 }

/**
 * The wallpaper as the glass actually sees it — blurred, then colour-trimmed.
 *
 * 🔑 THIS STEP IS NOT A REFINEMENT, IT IS THE DIFFERENCE BETWEEN MODELLING THE SCREEN
 * AND MODELLING THE FILE. Neither login surface shows the image on disk: the greeter's
 * layer is blurred by Hyprland with `contrast 1.2 / vibrancy 0.4`
 * (config/greetd/hyprland-greeter.lua) and the lockscreen's painter applies the same
 * matrix to its own copy, because under session-lock it has to blur the wallpaper
 * itself. A decision taken on the raw mean is a decision about a picture nobody sees.
 *
 * The blur half needs nothing: a gaussian is a local mean, so averaging a band already
 * gives its blurred value — which is why the greeter audit's offscreen prediction of
 * 150/255 matched the real screen's 150/255. The TRIM half does not commute with
 * averaging in general, but contrast is affine (`out = (in − 0.5)·k + 0.5`), and an
 * affine map of a mean IS the mean of the map. Saturation is affine too. So applying
 * the matrix to the band's mean is exact for these two, not an approximation.
 *
 * The matrix is `glass-capsule.ts`'s, on one triple instead of a texture — same
 * constants, imported, and the column-major layout unpacked the same way.
 */
export function applyBackdropTrim(c: RGB): RGB {
  const s = 1 + BACKDROP_TRIM.vibrancy
  const lr = 0.2126, lg = 0.7152, lb = 0.0722
  const k = BACKDROP_TRIM.contrast * BACKDROP_TRIM.brightness
  const off = 0.5 * BACKDROP_TRIM.brightness - 0.5 * k

  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return {
    r: clamp((lr + (1 - lr) * s) * k * c.r + lg * (1 - s) * k * c.g + lb * (1 - s) * k * c.b + off),
    g: clamp(lr * (1 - s) * k * c.r + (lg + (1 - lg) * s) * k * c.g + lb * (1 - s) * k * c.b + off),
    b: clamp(lr * (1 - s) * k * c.r + lg * (1 - s) * k * c.g + (lb + (1 - lb) * s) * k * c.b + off),
  }
}

/** What a skin's body text scores over `backdrop`, with the glass in between.
 *
 *  A skin is a PAIR — dark glass carries white text, light glass carries black —
 *  and scoring one without the other is what makes a floor look like a fix. */
export function skinContrast(skin: Skin, backdrop: RGB, alpha: number): number {
  const tint = skin === "dark" ? GLASS_TINT.dark : GLASS_TINT.light
  const text = skin === "dark" ? WHITE : BLACK
  return contrastRatio(text, composite(tint, alpha, backdrop))
}

/**
 * The decision, over one or more regions of backdrop.
 *
 * 🔑 MAX-MIN, not the mean of the means. A wallpaper is not one colour: the band
 * behind the card can be dark while the band behind the power bar is bright, and
 * averaging those two produces a mid-grey that exists nowhere on the screen and
 * describes neither. So each region is scored under both skins and the skin that
 * serves its WORST region best wins. With one region it degenerates to the obvious
 * comparison; with several it is the only rule that cannot be gamed by a bright
 * corner.
 */
export function pickSkin(
  regions: RGB[],
  alpha: number,
): { skin: Skin; worst: number; dark: number; light: number } {
  const worstUnder = (skin: Skin) =>
    regions.reduce((lo, bg) => Math.min(lo, skinContrast(skin, bg, alpha)), Infinity)

  const dark = worstUnder("dark")
  const light = worstUnder("light")
  const skin: Skin = dark >= light ? "dark" : "light"
  return { skin, worst: Math.max(dark, light), dark, light }
}

/**
 * Mean colour of horizontal BANDS of the wallpaper, as the screen will show it.
 *
 * `bands` are [top, bottom] fractions of the visible height. `aspect` is the
 * surface's width/height: the wallpaper is painted COVER-fit (awww in the greeter's
 * compositor, a `Gtk.Picture` on the lock), so the parts of the image that fall
 * outside that aspect are cropped away and must not be measured — a panoramic
 * wallpaper on a 16:9 screen shows its middle, and its edges are not on the screen
 * at all.
 *
 * Returns `null` rather than a guess when the file cannot be read: the caller's
 * fallback is the skin the screens have always had, which is a safe answer, and a
 * fabricated mid-grey is not.
 */
export function sampleBands(
  path: string,
  aspect: number,
  bands: Array<[number, number]>,
  sampleWidth = 96,
): RGB[] | null {
  // ⚠️ No `: GdkPixbuf.Pixbuf` annotation, and that is not sloppiness. These two
  // bundles typecheck against `gi.d.ts`, which declares the `gi://` MODULES but no
  // namespaces, so naming a GI type as a type is an error here even when the same
  // expression is fine — `date-names.ts` and `icons.ts` carry the identical one.
  // Inferred, it costs nothing and adds no error to a check other people read.
  //
  // Scaled on LOAD, not after: a 4K JPEG decoded at full size to be averaged into a
  // handful of numbers is ~25 MB of pixels for nothing, on the startup path of a
  // screen whose whole job is to appear instantly.
  let pb
  try {
    pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, sampleWidth, -1, true)
  } catch (e) {
    console.warn(`[BackdropSkin] cannot read wallpaper ${path}: ${e}`)
    return null
  }
  if (!pb) return null

  const iw = pb.get_width()
  const ih = pb.get_height()
  if (iw < 1 || ih < 1) return null

  // COVER crop: keep the centred rect with the screen's aspect.
  const imgAspect = iw / ih
  let cx = 0, cy = 0, cw = iw, ch = ih
  if (imgAspect > aspect) {
    cw = Math.max(1, Math.round(ih * aspect))
    cx = Math.round((iw - cw) / 2)
  } else if (imgAspect < aspect) {
    ch = Math.max(1, Math.round(iw / aspect))
    cy = Math.round((ih - ch) / 2)
  }

  const pixels = pb.get_pixels()
  const stride = pb.get_rowstride()
  const chans = pb.get_n_channels()

  return bands.map(([top, bottom]) => {
    const y0 = cy + Math.floor(Math.min(top, bottom) * ch)
    const y1 = cy + Math.ceil(Math.max(top, bottom) * ch)
    let r = 0, g = 0, b = 0, n = 0
    for (let y = Math.max(cy, y0); y < Math.min(cy + ch, Math.max(y1, y0 + 1)); y++) {
      for (let x = cx; x < cx + cw; x++) {
        const i = y * stride + x * chans
        r += pixels[i]
        g += pixels[i + 1]
        b += pixels[i + 2]
        n++
      }
    }
    if (n === 0) return { r: 0, g: 0, b: 0 }
    // Trimmed on the way out, so every caller gets what is behind the GLASS rather
    // than what is in the file. See applyBackdropTrim for why that is exact here.
    return applyBackdropTrim({ r: r / n / 255, g: g / n / 255, b: b / n / 255 })
  })
}

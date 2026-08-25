import Gtk from "gi://Gtk?version=4.0"
import { LOCK_GLASS } from "./tokens"
import { resolveWallpaper, type WallpaperSurface } from "./wallpaper"
import { pickSkin, sampleBands, type Skin } from "./backdrop-skin"
import { setGlassSkin } from "./glass-capsule"

/**
 * Dress the login screens in the skin their wallpaper asks for — tech-debt #82.
 *
 * The measurement and the reasoning are in `backdrop-skin.ts`; this is the part that
 * knows about THESE TWO SCREENS: where their text sits, and how a skin is put on.
 *
 * 🔑 THE SKIN IS A CSS CLASS, NOT A GENERATED PALETTE, and that was a correction. The
 * first version emitted the light tokens from TypeScript the way `accentCssFor()`
 * emits the accent. It works for the accent because an accent is ONE colour with
 * pre-computed alphas; a skin is not. The scrim is a gradient whose alphas are pinned
 * by an invariant a CI gate computes from the STYLESHEET (`a_total < ignore_alpha`,
 * see the scrim's comment), and the hero's text-shadow composites with it. Emitting
 * the light halves from here would have put those numbers in a second file that the
 * gate does not read — which is the exact shape of every "two representations, one
 * decision" failure this repo keeps finding. So the light values live beside the dark
 * ones in `ui/greeter/style.scss`, under `window.skin-light`, and this file's whole
 * output is one class name.
 *
 * The painter is the one thing a class cannot reach — Cairo cannot read a CSS custom
 * property (the same wall `setAccentRim` exists for) — so the body's tint is handed
 * over as a value.
 */

/**
 * The bands of wallpaper that decide, as fractions of the surface's height.
 *
 * MEASURED, not estimated — `scripts/dev/lock-probe.js` prints the boxes, and these
 * are them at 1024×768 (2026-08-25, SCOPE=greeter):
 *
 *   hero date+clock   y 72…200   →  0.09…0.26
 *   card (with the username inside it, at y 346)
 *                     y 256…512  →  0.33…0.67
 *   power bar         y 696…728  →  0.91…0.95
 *   locale bar        y 696…728  →  0.91…0.95   (bottom-left, same row)
 *
 * All three carry text, so all three vote. The hero is included even though it has no
 * glass under it: it is the block that VANISHED on a light wallpaper (2026-08-09) and
 * the reason the scrim exists — and the scrim flips with the skin, so the hero's
 * legibility depends on this decision as much as the card's does.
 *
 * ⚠️ Fractions rather than pixels because the two surfaces run at whatever the monitor
 * is. The bands are broad on purpose: they are asking "what tone is behind this third
 * of the screen", and a band narrow enough to be precise would be narrow enough to be
 * fooled by one bright cloud.
 */
const TEXT_BANDS: Array<[number, number]> = [
  [0.09, 0.26], // hero: date + clock
  [0.33, 0.67], // card: username, password, primary button, session + error
  [0.88, 0.97], // the bottom row: power bar and locale bar
]

/**
 * Choose the skin for a login surface from its own wallpaper.
 *
 * `homeDir` is for the greeter, which runs as the `greeter` system user and has to be
 * told whose wallpaper to read — the same argument `resolveWallpaper` takes, for the
 * same reason.
 *
 * Falls back to `"dark"` whenever anything is missing or unreadable. That is the skin
 * both screens have always worn, so a failure here is a no-op rather than a surprise
 * — and it is the honest answer, because a wallpaper we could not read is a backdrop
 * we know nothing about.
 */
export function chooseLoginSkin(
  surface: WallpaperSurface,
  aspect: number,
  homeDir?: string,
): { skin: Skin; worst: number; path: string | null } {
  const path = resolveWallpaper(surface, homeDir)
  if (!path) return { skin: "dark", worst: 0, path: null }

  const regions = sampleBands(path, aspect, TEXT_BANDS)
  if (!regions || regions.length === 0) return { skin: "dark", worst: 0, path }

  const { skin, worst } = pickSkin(regions, LOCK_GLASS.fill.a)
  return { skin, worst, path }
}

/**
 * Put the chosen skin on a window: the CSS class the stylesheet keys off, and the
 * painter's body tint, which no class can reach.
 *
 * Call it on every login window before it maps. `setGlassSkin` is process-global (one
 * painter, one screen), so calling it once per window is redundant but not wrong — and
 * cheaper to reason about than a second code path that only the multi-monitor case
 * takes.
 */
export function applyLoginSkin(win: Gtk.Window, skin: Skin) {
  setGlassSkin(skin)
  if (skin === "light") win.add_css_class("skin-light")
  else win.remove_css_class("skin-light")
}

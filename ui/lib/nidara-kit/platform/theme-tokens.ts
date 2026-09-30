// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * NIDARA TOKEN ENGINE — the whole `--nidara-*` ramp, for EVERY bundle
 * ==================================================================
 *
 * One config (accent, glass material, reduce transparency) plus one boolean
 * (is this surface dark?) produce the ~60 custom properties that every Nidara
 * surface is painted from. The tokens are scoped to the GJS process — external
 * GTK apps are not affected; they get the accent through the portal instead.
 *
 * ⚠️ **It lived in `ui/shell/core/NidaraTheme.ts` until 2026-08-26, and that was
 * an accident of history, not a coupling.** It imports four things, all of them
 * from `ui/lib/`, and nothing from the shell — but because of where the file sat,
 * the greeter, the lockscreen and the installer could not have it. Each of them
 * grew a hand-typed partial copy of the ramp in its own SCSS, plus
 * `accentCssFor()` for a six-token accent subset, and the copies drifted: the
 * installer's was missing `--nidara-surface-strong`, so a kit button's hover
 * resolved to nothing at all (GTK4 does not warn about an undefined custom
 * property — the declaration simply does not apply).
 *
 * The shell's own module is still `core/NidaraTheme.ts`: it re-exports this file
 * and keeps the one piece that IS shell knowledge, the chrome scope naming the
 * shell's four skin surfaces.
 *
 * Feed it from `ui/lib/nidara-kit/platform/appearance.ts`, which answers the "what did the user
 * pick?" half from the portal or the mirror file, whichever this process can
 * reach.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "./file"
import { ACCENT_HEX, ACCENT_NAMES, hexToRgb, type AccentKey } from "./accent"
import { DANGER_HEX, WARNING_HEX } from "./status-colors"
import { GLASS_TINT } from "./tokens"
import { TEXT_INK } from "./glass-legibility"

// -- COLOR PALETTES ---------------------------------------------------
// The accent palette is the single source of truth in ui/lib/nidara-kit/platform/accent.ts.
// Here we reshape it to { color, name } for existing consumers (Settings, etc).

export const ACCENT_PALETTE = Object.fromEntries(
  (Object.keys(ACCENT_HEX) as AccentKey[]).map((k) => [k, { color: ACCENT_HEX[k], name: ACCENT_NAMES[k] }]),
) as Record<AccentKey, { color: string; name: string }>

export type { AccentKey }

// ── TYPES & INTERFACES ──────────────────────────────────────────────

// There is no shell-skin PIN any more (`shellAppearance`, removed 2026-09-29, #676).
// It existed to keep the shell legible over any wallpaper; the adaptive glass (#673)
// does that per surface, measuring what is really behind it, so the shell follows the
// system mode and the bar row reads its skin from its backdrop.

export interface NidaraThemeConfig {
  accent: AccentKey
  // What the user picks (#674): a MATERIAL and, from Accessibility, reduce transparency.
  glassMaterial: GlassMaterial
  reduceTransparency: boolean
  /** Settings → Appearance → Windows: Nidara's windows translucent (on) or solid. */
  windowTransparency: boolean
  // ⚠️ DERIVED, never stored: the glass opacity per surface (higher = more opaque) that
  // the two above give, through `glassOpacities`. Whoever changes either of them calls
  // `withGlass` — the painters read these four and nothing else.
  glassFrost: number      // The material's haze over the tint (`frostedFill`)
  barOpacity: number      // Bar capsules (Cairo)
  overlayOpacity: number  // Overlays CC/NC/Prism/… (Cairo)
  dockOpacity: number     // Dock (Cairo)
  windowOpacity: number   // Settings + About windows (CSS tokens)
}

/**
 * The range every glass FLOOR lies in — every entry of `GLASS_FLOORS` below.
 *
 * **Why the floor is 0.24 and not 0.05** (2026-08-23). Until then the floor was
 * 0.05 and the range was documented as "WYSIWYG — no floor": you could drag the
 * glass down to illegible, deliberately. That decision was sound while it was
 * made, because 5% glass was NOT actually 5% of anything — Hyprland's
 * `decoration:blur:brightness = 0.8` was dimming the blurred backdrop under every
 * one of our surfaces by 20%, so the material had a body no token in this repo
 * accounted for. That brightness had to go (it applies at FULL strength the
 * instant a pixel clears `ignore_alpha`, which draws a hard dark step along every
 * antialiased edge — see `tech-debt.md` #81), and removing it took the hidden body
 * with it: white text on 5% glass over a bright wallpaper measured **2.78:1**.
 *
 * 0.24 is the arithmetic of what was removed, not a taste: compositing at alpha α
 * over a backdrop dimmed to 80% is the same coverage as compositing at
 * `0.2 + 0.8·α` over an undimmed one, and `0.2 + 0.8 × 0.05 = 0.24`. So the new
 * floor IS the old default, honestly named.
 *
 * ⚠️ It is a floor, NOT a legibility guarantee. Legibility is the adaptive glass's
 * job (#673, `glass-legibility.ts`): each shell surface thickens itself over a pale
 * backdrop, up to `GLASS_ADAPT_CEILING`. `scripts/ci/blur-threshold-check.mjs` reads
 * `min` from this line: it must stay above every layer's `ignore_alpha`.
 */
export const GLASS_RANGE = { min: 0.24, max: 0.80 } as const

/**
 * The `ignore_alpha` every shell layer runs under (`nidara-bar`, `nidara-island`,
 * `nidara-dock`, `nidara-app-grid` in `config/hypr/hyprland.lua`). A pixel whose alpha
 * is at or below it gets NO backdrop blur. `scripts/ci/blur-threshold-check.mjs`
 * holds every one of those rules to this number — it is one decision in two languages.
 */
export const LAYER_IGNORE_ALPHA = 0.23

/**
 * The lowest whole-widget opacity at which glass painted at `glassAlpha` still clears
 * `LAYER_IGNORE_ALPHA`, i.e. still has its blur. A fade that goes below it shows the
 * panel UNBLURRED for its last frames — sharp wallpaper through a still-visible panel —
 * so the overlay pop fades down to this and then hides in one step
 * (`OVERLAY_POP.opacityFloor`, `ui/shell/common/ScaleRevealer.ts`). The 0.02 is headroom
 * for the compositor's 8-bit alpha. At the thinnest glass (0.24) this is ~1: the fade
 * goes away and only the scale moves, which is the honest consequence of glass that
 * thin — any fade at all would unblur it.
 */
export const blurSafeOpacity = (glassAlpha: number) =>
    glassAlpha > 0 ? Math.min(1, LAYER_IGNORE_ALPHA / glassAlpha + 0.02) : 0

/**
 * The glass MATERIAL (#674, owner's decision 2026-09-30): the one choice Settings →
 * Appearance offers, in place of the five opacity sliders it had (a master and four
 * per surface). Three positions, like the single Liquid Glass control of macOS 27 —
 * `clear` shows the most backdrop, `frosted` the least.
 *
 * A position is a TABLE, not a number: a floor per surface (`GLASS_FLOORS`) and a
 * compositor blur (`GLASS_BLUR`). That is what one master slider could not say — the
 * dock, which carries no text, wants thinner glass than a panel full of it
 * (tech-debt #83).
 *
 * Every value is a FLOOR since the adaptive glass (#673): a shell surface thickens
 * itself over a pale backdrop until its text is legible, whatever the material.
 *
 * ⚠️ PROVISIONAL numbers, to be calibrated on screen with the owner, position by
 * position (the decision in #674 says so). `clear` is where the owner had put the bar,
 * the panels and the dock by hand with the sliders (0.24). The windows are not in it:
 * `WINDOW_GLASS_OPACITY`.
 */
export const GLASS_MATERIALS = ["clear", "regular", "frosted"] as const
export type GlassMaterial = (typeof GLASS_MATERIALS)[number]
export const GLASS_MATERIAL_DEFAULT: GlassMaterial = "regular"

export interface GlassFloors { bar: number; overlay: number; dock: number }

/** Per material, per surface. Every entry lies in `GLASS_RANGE`. The WINDOWS are not
 *  here: they are not Liquid Glass (`WINDOW_GLASS_OPACITY`). */
export const GLASS_FLOORS: Record<GlassMaterial, GlassFloors> = {
  clear:   { bar: GLASS_RANGE.min, overlay: GLASS_RANGE.min, dock: GLASS_RANGE.min },
  regular: { bar: 0.32,            overlay: 0.36,            dock: GLASS_RANGE.min },
  frosted: { bar: 0.44,            overlay: 0.48,            dock: 0.32 },
}

/**
 * Nidara's WINDOWS (Settings, About, the installer, their dialogs) are not Liquid Glass
 * and do not follow the material (owner's decision, 2026-09-30). The glass material is
 * for the interface's surfaces and controls; a window is only translucent or not — one
 * switch (`windowTransparency`), on by default, and one opacity: this, or solid. 0.80 is
 * the value the owner had set by hand.
 *
 * ⚠️ Named TRANSPARENCY, not "tinting" (macOS's "Allow wallpaper tinting in windows"),
 * on purpose: what shows through a window is shaped by the compositor's blur, and
 * Hyprland has ONE for everything — the glass material sets it. A "tint" of our own
 * would be a promise we cannot keep (owner, 2026-09-30). A compositor of our own would
 * lift that: `project_own_compositor_vision`.
 */
export const WINDOW_GLASS_OPACITY = 0.80

/** The white haze each material lays over its tint (`frostAt` in glass-legibility.ts):
 *  what tells the three apart over a DARK wallpaper, where more of a dark tint shows
 *  nothing. It gives way by itself as the adaptive glass thickens. Provisional. */
export const GLASS_FROST: Record<GlassMaterial, number> = {
  clear: 0,
  regular: 0.04,
  frosted: 0.10,
}

/** Hyprland's `decoration:blur` per material. ONE blur for the whole compositor —
 *  Hyprland has no per-layer size — so it reaches every translucent window too, the same
 *  scope as macOS's control. `regular` is what `config/hypr/hyprland.lua` ships, so the
 *  shell pushes nothing at that position and a `hyprland-user.lua` override stands
 *  (`ui/shell/core/GlassBlur.ts`). */
export const GLASS_BLUR: Record<GlassMaterial, { size: number; passes: number }> = {
  clear:   { size: 1, passes: 2 },
  regular: { size: 2, passes: 2 },
  frosted: { size: 4, passes: 3 },
}

/**
 * Reduce transparency (Settings → Accessibility → Vision, #674): every glass surface
 * at this opacity — the tint, solid — whatever the material, and the material's control
 * greyed out. Hyprland still blurs behind it — nothing of that blur shows — and the
 * blur is left on deliberately: it is ONE compositor option, and switching it off would
 * reach every other app's translucent window, which is not what the switch says.
 */
export const SOLID_GLASS = 1

/** The four opacities the three choices give. The ONE place the table is read. */
export function glassOpacities(material: GlassMaterial, reduceTransparency: boolean, windowTransparency: boolean):
  Pick<NidaraThemeConfig, "glassFrost" | "barOpacity" | "overlayOpacity" | "dockOpacity" | "windowOpacity"> {
  if (reduceTransparency) {
    return { glassFrost: 0, barOpacity: SOLID_GLASS, overlayOpacity: SOLID_GLASS, dockOpacity: SOLID_GLASS, windowOpacity: SOLID_GLASS }
  }
  const f = GLASS_FLOORS[material] ?? GLASS_FLOORS[GLASS_MATERIAL_DEFAULT]
  return { glassFrost: GLASS_FROST[material] ?? 0, barOpacity: f.bar, overlayOpacity: f.overlay, dockOpacity: f.dock,
           windowOpacity: windowTransparency ? WINDOW_GLASS_OPACITY : SOLID_GLASS }
}

/** `c` with its four opacities re-derived from its material, reduce transparency and
 *  window transparency. Call it after changing any of them. */
export function withGlass<T extends NidaraThemeConfig>(c: T): T {
  return Object.assign(c, glassOpacities(c.glassMaterial, c.reduceTransparency, c.windowTransparency))
}

/** A value read from outside (the portal, the mirror, gsettings) as a material. */
export const asGlassMaterial = (v: unknown): GlassMaterial =>
  (GLASS_MATERIALS as readonly unknown[]).includes(v) ? (v as GlassMaterial) : GLASS_MATERIAL_DEFAULT

export const DEFAULT_CONFIG: NidaraThemeConfig = withGlass({
  accent: "blue",
  glassMaterial: GLASS_MATERIAL_DEFAULT,
  reduceTransparency: false,
  windowTransparency: true,
  glassFrost: 0,
  barOpacity: 0, overlayOpacity: 0, dockOpacity: 0, windowOpacity: 0,
})

// ── LOGIC ────────────────────────────────────────────────────────────

function generateTokenHeader(config: NidaraThemeConfig, isDark: boolean): string {
  const accent = ACCENT_PALETTE[config.accent].color

  const lines = [
    `/* Nidara Token Engine */`,
    // libadwaita named-colour bridge: AGS force-loads libadwaita in-process (it
    // calls Adw.init), so keep its accent named colours pointed at ours.
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `* {`,
  ]

  // Accent swatch palette — consumed by the picker swatches (.accent-<key> in _settings.scss).
  for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
    lines.push(`  --accent-${key}: ${color};`)
  }

  // No `.nd-icon` rule rides along any more: the shipped drawings are symbolic
  // files, so they take the CSS `color` that `--nidara-text` above already
  // carries for this mode. This used to append `-gtk-icon-filter: none` in light
  // mode, to undo the invert the sheets applied for dark.
  lines.push(
    ...nidaraVars(config, isDark),
    `}`,
  )
  return lines.join("\n")
}

/**
 * The mode-dependent `--nidara-*` custom properties (everything between `* {`
 * and `}`). Extracted so the same block can be re-emitted under a scoped
 * selector for the bar/dock chrome override (see generateChromeTokenScope) —
 * the chrome must carry the FULL token family, not just `--nidara-text`, or its
 * surfaces/edges/shadows would desync from its text colour.
 */
export function nidaraVars(config: NidaraThemeConfig, isDark: boolean): string[] {
  const accent = ACCENT_PALETTE[config.accent].color
  // Token glass (--nidara-bg, materials, popovers) tracks the WINDOW opacity — it
  // styles the CSS-painted Settings/About windows (`.nidara-window-glass` etc.).
  // The Cairo overlays use overlayOpacity directly. WYSIWYG — no legibility floor
  // (removed by design; for contrast raise the slider or pin the shell skin).
  const bgAlphaNum = config.windowOpacity
  const bgAlpha = bgAlphaNum.toFixed(2)

  const popoverBg = isDark ? GLASS_TINT.dark.hex : GLASS_TINT.light.hex
  const popoverAlpha = Math.max(bgAlphaNum, 0.38).toFixed(2)
  const popoverBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"

  const whiteOrBlack = isDark ? "#ffffff" : "#000000"
  const ink = TEXT_INK[isDark ? "dark" : "light"]
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  const fg = isDark ? "255, 255, 255" : "0, 0, 0"
  const bg = isDark ? GLASS_TINT.dark.rgb : GLASS_TINT.light.rgb
  const pbR = parseInt(popoverBg.slice(1, 3), 16)
  const pbG = parseInt(popoverBg.slice(3, 5), 16)
  const pbB = parseInt(popoverBg.slice(5, 7), 16)

  // Shadows: "whisper" range, heavier in dark (less ambient contrast).
  const sh = isDark
    ? {
        sm: "0 1px 2px rgba(0,0,0,0.20), 0 1px 1px rgba(0,0,0,0.16)",
        md: "0 2px 8px rgba(0,0,0,0.28), 0 1px 2px rgba(0,0,0,0.18)",
      }
    : {
        sm: "0 1px 2px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04)",
        md: "0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)",
      }
  // ⚠️ `--nidara-edge` (the rim of light) is NOT emitted any more, and neither are
  // the four `--nidara-material-*` or `--nidara-shadow-popover`. Buried 2026-09-20,
  // tech-debt #106: the rim is painted in Cairo (`ui/lib/nidara-kit/platform/glass-paint.ts`, mirrored
  // as numbers in `LOCK_GLASS`), the CSS copy had one reader left — the window card
  // — and #600 correctly took that away by giving window chrome back to Hyprland.
  // A token nothing reads is a value that drifts from the one on screen.

  return [
    `  --nidara-accent: ${accent};`,
    `  --nidara-accent-rgb: ${r}, ${g}, ${b};`,
    `  --nidara-accent-fg: #ffffff;`,
    `  --nidara-accent-60: rgba(${r}, ${g}, ${b}, 0.6);`,
    `  --nidara-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --nidara-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --nidara-bg: rgba(${bg}, ${bgAlpha});`,
    `  --nidara-surface-back: rgba(${fg}, 0.04);`,
    `  --nidara-surface: rgba(${fg}, 0.08);`,
    `  --nidara-surface-hover: rgba(${fg}, 0.12);`,
    `  --nidara-surface-active: rgba(${fg}, 0.16);`,
    // ── Interaction states ───────────────────────────────────────────────────
    // hover/pressed are MODE-AWARE (--nidara-surface-hover/-active = rgba(fg,…)):
    // they lighten in dark / darken in light, always moving toward the mode's
    // contrast, so they stay visible on ANY background — including a translucent
    // panel over a dark wallpaper, where a fixed dark "deepen" overlay vanished.
    // Selection is the ONLY place accent enters.
    `  --nidara-state-selected: rgba(${r}, ${g}, ${b}, ${isDark ? "0.22" : "0.16"});`,
    `  --nidara-surface-raised: rgba(${fg}, 0.20);`,
    `  --nidara-surface-strong: rgba(${fg}, 0.30);`,   // one step above raised, for hover on raised fills
    `  --nidara-text: ${whiteOrBlack};`,
    // The ramp's alphas live in `TEXT_INK` (glass-legibility.ts), which is also what
    // the adaptive glass checks for contrast — so the tiers it holds to a target are
    // the tiers on screen by construction, not a copy that can drift.
    `  --nidara-text-secondary: rgba(${fg}, ${ink.secondary});`,
    `  --nidara-text-dim: rgba(${fg}, ${ink.dim});`,
    `  --nidara-text-disabled: rgba(${fg}, 0.3);`,
    // The switch thumb. WHITE in both modes, deliberately: it is the moving part
    // of a control whose track goes accent when on, and it has to stay legible
    // against both the accent and the off-track. It is emitted here rather than
    // left in the shell's static block because the switch rules moved to the KIT
    // on 2026-09-20 — every bundle that uses `NidaraToggleRow` now paints with it.
    `  --nidara-thumb: #ffffff;`,
    `  --nidara-danger: ${DANGER_HEX};`,
    `  --nidara-danger-rgb: ${hexToRgb(DANGER_HEX)};`,
    `  --nidara-warning: ${WARNING_HEX};`,
    `  --nidara-popover-bg: rgba(${pbR}, ${pbG}, ${pbB}, ${popoverAlpha});`,
    `  --nidara-popover-border: ${popoverBorder};`,
    `  --nidara-shadow-sm: ${sh.sm};`,
    `  --nidara-shadow-md: ${sh.md};`,
  ]
}

export function generateTokensCss(config: NidaraThemeConfig, isDark: boolean): string {
  return generateTokenHeader(config, isDark)
}

/**
 * Scoped token sets — `generateSkinFlipScope` in `ui/shell/core/NidaraTheme.ts`, the
 * full `--nidara-*` family a surface wears while the adaptive glass (#673) has flipped
 * its skin. (Until 2026-09-29 the shell PIN used the same scope, `generateChromeTokenScope`;
 * the pin is gone, #676, and the lessons below are why the scope is shaped as it is.)
 *
 * Scope = every toplevel of the shell skin, listed in `CHROME_SCOPE_WINDOWS`.
 * `window#nidara-bar` hosts the bar content AND the floating overlays that are
 * still children of its `Gtk.Overlay` (CC/NC/Prism/system menu/overview/expansion
 * panel); the dock, the Activity Island and the app grid are each their own
 * toplevel. App-mode windows — Settings (`nidara-settings-window`) and About
 * (`nidara-about`) — are SEPARATE toplevels, deliberately NOT in the scope, so
 * they keep the system mode like any third-party app. Nothing else has to be
 * mirrored: the icons are symbolic and follow `--nidara-text`, which this scope
 * already redefines.
 *
 * ⚠️ THIS LIST IS A COUPLING TO WHICH SURFACES EXIST, AND IT HAS BEEN WRONG
 * BEFORE. It said "bar and dock" from the days when the island and the app grid
 * were children of the bar's window. Both later moved out to their own surfaces
 * (island 2026-07-26, app grid 2026-08-09) and neither was added here, so from
 * then until 2026-08-24 a user who pinned the shell to Dark on a Light system —
 * or the reverse — got a bar and a dock that obeyed and an island and an app grid
 * that did not: wrong tokens AND uninverted icons. The doc comment even claimed
 * the app grid was "scoped separately", which was never true.
 *
 * The same move broke `blur_popups` for the island in the same way (see
 * `config/hypr/hyprland.lua`). A surface leaving the bar's window silently leaves
 * everything that was scoped to the bar's window, which is why
 * `scripts/ci/chrome-scope-check.mjs` now compares this list against the
 * namespaces that actually exist.
 *
 * The selector must hit every DESCENDANT directly (`window#nidara-bar *`), not
 * just the container: GTK4 custom properties don't inherit reliably, and the
 * global `* { --nidara-* }` block matches every node directly — so a bare
 * `window#nidara-bar { --nidara-* }` only overrides the container itself and the
 * children keep the global value (glass flipped but text stayed). An id-qualified
 * universal beats `*` on specificity.
 */

/**
 * NIDARA TOKEN ENGINE — the whole `--nidara-*` ramp, for EVERY bundle
 * ==================================================================
 *
 * One config (accent, four glass opacities, shell-skin pin) plus one boolean
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
 * Feed it from `ui/lib/appearance.ts`, which answers the "what did the user
 * pick?" half from the portal or the mirror file, whichever this process can
 * reach.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "./file"
import { ACCENT_HEX, ACCENT_NAMES, hexToRgb, type AccentKey } from "./accent"
import { DANGER_HEX } from "./status-colors"
import { GLASS_TINT } from "./tokens"

// -- COLOR PALETTES ---------------------------------------------------
// The accent palette is the single source of truth in ui/lib/accent.ts.
// Here we reshape it to { color, name } for existing consumers (Settings, etc).

export const ACCENT_PALETTE = Object.fromEntries(
  (Object.keys(ACCENT_HEX) as AccentKey[]).map((k) => [k, { color: ACCENT_HEX[k], name: ACCENT_NAMES[k] }]),
) as Record<AccentKey, { color: string; name: string }>

export type { AccentKey }

// ── TYPES & INTERFACES ──────────────────────────────────────────────

/**
 * Shell-skin appearance, independent of the system dark/light (app) mode.
 * - "system": the shell follows the global app mode (default).
 * - "dark" / "light": the shell is pinned, so text + glass stay legible over any
 *   wallpaper regardless of the rest of the desktop's mode.
 * Covers the WHOLE shell skin — bar, dock, AND the overlays (CC/NC/Prism/system
 * menu/overview/app grid). App-mode windows (Settings, About) are excluded: they
 * follow the system mode like any third-party app.
 */
export type ShellAppearance = "system" | "dark" | "light"

export interface NidaraThemeConfig {
  accent: AccentKey
  // Glass opacity per surface (higher = more opaque). The "Glass" master slider in
  // Settings moves all four together; "Advanced" exposes them individually.
  barOpacity: number      // Bar capsules (Cairo)                     — range [0.05, 0.80]
  overlayOpacity: number  // Overlays CC/NC/Prism/… (Cairo)           — range [0.05, 0.80]
  dockOpacity: number     // Dock (Cairo)                             — range [0.05, 0.80]
  windowOpacity: number   // Settings + About windows (CSS tokens)    — range [0.05, 0.80]
  shellAppearance: ShellAppearance  // Whole shell-skin dark/light, independent of app mode
}

/**
 * The glass opacity range, for every surface and every slider that sets one.
 *
 * ⚠️ ONE definition. It used to be six literals — `clampOpacity` plus the master
 * and the four per-surface sliders in `settings/pages/Appearance.tsx` — which is
 * five chances for a slider to offer a value the clamp then silently refuses, a
 * control that lies about its own range.
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
 * floor IS the old default, honestly named — which is also why stored values are
 * migrated through that exact expression (`ThemeManager.loadSettings`).
 *
 * ⚠️ It is a floor, NOT a legibility guarantee, and do not describe it as one. On
 * a pure-white wallpaper white text on 24% glass is 1.69:1; nothing below **0.59**
 * clears 4.5:1 there, and at 0.59 the material stops reading as glass at all. The
 * real fix is to give the TEXT its own legibility (vibrancy / shadow / a scrim
 * under labels) so the glass can go thin again — `tech-debt.md` #82.
 *
 * ⚠️ ONE floor for all four surfaces, and that is load-bearing.
 * `ThemeManager.setGlassOpacity` writes one value to all four through one clamp,
 * and the master slider renders "—" and mutes itself whenever they disagree
 * (`glassUniform`). Give the window a different floor and the master goes mixed —
 * and greys out — the moment you drag it below that floor, i.e. across the whole
 * lower half of its travel. Per-surface floors need the mixer redesigned first: `tech-debt.md` #83.
 */
export const GLASS_RANGE = { min: 0.24, max: 0.80 } as const

/** The one clamp. Every setter and every slider bound goes through it. */
export const clampGlass = (v: number) => Math.max(GLASS_RANGE.min, Math.min(GLASS_RANGE.max, v))

// A stored opacity from before the glass rescale (2026-08-23) is `0.2 + 0.8·α` in
// today's model: glass at α over a backdrop the compositor dimmed to 80% covers as
// much as `0.2 + 0.8·α` over an undimmed one. That conversion used to run in the
// reader on every load (`readGlass`, keyed on appearance.json's `glassModel`); it
// is applied once by migrations/2026-09-14c-appearance-to-gsettings.sh now, and
// the stored values are always in this model.

/** The out-of-the-box glass for everything except the dock (2026-08-24, owner's call).
 *
 *  Chosen for LEGIBILITY first: at `GLASS_RANGE.min` the glass is thin enough that white
 *  text over a bright backdrop lands near 3:1 (measured on the login screen, which had been
 *  put on the same floor — see tech-debt #82), and a first boot should not ship a contrast
 *  problem. 0.48 is a little under the middle of the range: enough body to carry text over
 *  any wallpaper, still visibly glass rather than a painted panel.
 *
 *  ⚠️ It is a DEFAULT, not a floor. Existing installs keep whatever they stored — only a
 *  config with no value for a surface takes this. */
export const GLASS_DEFAULT = 0.48

export const DEFAULT_CONFIG: NidaraThemeConfig = {
  accent: "blue",
  // ⚠️ NOT UNIFORM ANY MORE, deliberately, and that has a visible consequence: the master
  // "Glass" slider in Settings → Appearance is an INDETERMINATE control, so out of the box
  // it reads "—" and mutes to 0.55 opacity instead of showing a number (`glassUniform` in
  // Appearance.tsx). That is the control being honest — the surfaces really do differ — and
  // it was accepted rather than overlooked. The four per-surface sliders under "Advanced"
  // are where the difference is legible, and dragging the master re-unifies everything.
  //
  // The dock stays at the floor because it is the one surface that sits over the WALLPAPER
  // with nothing behind it and never carries body text — its icons are opaque. Thin glass
  // costs it nothing and buys the most backdrop.
  barOpacity: GLASS_DEFAULT,
  overlayOpacity: GLASS_DEFAULT,
  dockOpacity: GLASS_RANGE.min,
  windowOpacity: GLASS_DEFAULT,
  shellAppearance: "system",
}

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
  // tech-debt #106: the rim is painted in Cairo (`ui/lib/glass-paint.ts`, mirrored
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
    // Secondary/dim are nudged UP in light mode: black ink over translucent light
    // glass (which sits on an arbitrary wallpaper) reads washed-out at the dark-mode
    // alphas, so the light ramp gets more ink. White on dark needs less (more
    // perceptual punch), so dark keeps 0.8/0.6.
    `  --nidara-text-secondary: rgba(${fg}, ${isDark ? "0.8" : "0.85"});`,
    `  --nidara-text-dim: rgba(${fg}, ${isDark ? "0.6" : "0.72"});`,
    `  --nidara-text-disabled: rgba(${fg}, 0.3);`,
    `  --nidara-danger: ${DANGER_HEX};`,
    `  --nidara-danger-rgb: ${hexToRgb(DANGER_HEX)};`,
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
 * Scoped token override that pins the WHOLE shell skin to `chromeIsDark`,
 * independent of the system mode (appearance.shellAppearance). Returns empty
 * when it already matches the system (the global `* {}` block covers it).
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

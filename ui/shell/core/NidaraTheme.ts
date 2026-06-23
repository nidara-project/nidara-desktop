/**
 * Nidara Token Engine
 * Generates CSS custom properties and @define-color tokens for Nidara's own UI.
 * These tokens are scoped to the AGS/GJS process — external GTK apps are not affected.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"
import { ACCENT_HEX, ACCENT_NAMES, type AccentKey } from "../../lib/accent"

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

export const DEFAULT_CONFIG: NidaraThemeConfig = {
  accent: "blue",
  barOpacity: 0.20,
  overlayOpacity: 0.20,
  dockOpacity: 0.20,
  windowOpacity: 0.20,
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

  lines.push(
    ...nidaraVars(config, isDark),
    `}`,
    isDark ? `` : `.nd-icon { -gtk-icon-filter: none; }`,
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
function nidaraVars(config: NidaraThemeConfig, isDark: boolean): string[] {
  const accent = ACCENT_PALETTE[config.accent].color
  // Token glass (--nidara-bg, materials, popovers) tracks the WINDOW opacity — it
  // styles the CSS-painted Settings/About windows (`.nidara-window-glass` etc.).
  // The Cairo overlays use overlayOpacity directly. WYSIWYG — no legibility floor
  // (removed by design; for contrast raise the slider or pin the shell skin).
  const bgAlphaNum = config.windowOpacity
  const bgAlpha = bgAlphaNum.toFixed(2)

  const popoverBg = isDark ? "#242424" : "#fafafa"
  const popoverAlpha = Math.max(bgAlphaNum, 0.38).toFixed(2)
  const popoverBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"

  const whiteOrBlack = isDark ? "#ffffff" : "#000000"
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  const fg = isDark ? "255, 255, 255" : "0, 0, 0"
  const bg = isDark ? "36, 36, 36" : "250, 250, 250"
  const pbR = parseInt(popoverBg.slice(1, 3), 16)
  const pbG = parseInt(popoverBg.slice(3, 5), 16)
  const pbB = parseInt(popoverBg.slice(5, 7), 16)

  // Dock item hover/plate tokens — scaled by dockOpacity
  const d = config.dockOpacity
  const dBase   = (d * 0.50).toFixed(3)
  const dRaised = d.toFixed(3)

  // Material vibrancy ladder. Anchored to the macOS-skill values for our blur
  // profile (size=2, passes=2, vibrancy=0.4 → "subtle" row: thin .30 / regular
  // .45 / thick .65 / chrome .85), then OFFSET by the overlay opacity so the
  // ladder still responds to user opacity.
  // lower z → thicker; higher z → thinner. Clamped to keep blur visible + legible.
  const ba = bgAlphaNum
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  const delta = ba - 0.25
  const matThin    = clamp(0.30 + delta, 0.18, 0.50).toFixed(3)
  const matRegular = clamp(0.45 + delta, 0.30, 0.65).toFixed(3)
  const matThick   = clamp(0.65 + delta, 0.50, 0.85).toFixed(3)
  const matChrome  = clamp(0.85 + delta, 0.70, 0.95).toFixed(3)

  // Shadows: "whisper" range, heavier in dark (less ambient contrast).
  const sh = isDark
    ? {
        sm: "0 1px 2px rgba(0,0,0,0.20), 0 1px 1px rgba(0,0,0,0.16)",
        md: "0 2px 8px rgba(0,0,0,0.28), 0 1px 2px rgba(0,0,0,0.18)",
        lg: "0 8px 24px rgba(0,0,0,0.40), 0 2px 6px rgba(0,0,0,0.24)",
        popover: "0 8px 24px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.14)",
        icon: "0 2px 5px rgba(0,0,0,0.6)",
      }
    : {
        sm: "0 1px 2px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04)",
        md: "0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)",
        lg: "0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
        popover: "0 10px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
        icon: "0 2px 5px rgba(0,0,0,0.20)",
      }
  // Rim-of-light edge: faint white top hairline on glass.
  const edge = isDark ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(255,255,255,0.50)"

  return [
    `  --nidara-accent: ${accent};`,
    `  --nidara-accent-rgb: ${r}, ${g}, ${b};`,
    `  --nidara-accent-fg: #ffffff;`,
    `  --nidara-accent-60: rgba(${r}, ${g}, ${b}, 0.6);`,
    `  --nidara-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --nidara-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --nidara-accent-08: rgba(${r}, ${g}, ${b}, 0.08);`,
    `  --nidara-bg: rgba(${bg}, ${bgAlpha});`,
    `  --nidara-bg-backdrop: rgba(${bg}, ${bgAlpha});`,
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
    `  --nidara-dock-surface: rgba(${fg}, ${dBase});`,
    `  --nidara-dock-surface-raised: rgba(${fg}, ${dRaised});`,
    `  --nidara-text: ${whiteOrBlack};`,
    // Secondary/dim are nudged UP in light mode: black ink over translucent light
    // glass (which sits on an arbitrary wallpaper) reads washed-out at the dark-mode
    // alphas, so the light ramp gets more ink. White on dark needs less (more
    // perceptual punch), so dark keeps 0.8/0.6.
    `  --nidara-text-secondary: rgba(${fg}, ${isDark ? "0.8" : "0.85"});`,
    `  --nidara-text-dim: rgba(${fg}, ${isDark ? "0.6" : "0.72"});`,
    `  --nidara-text-disabled: rgba(${fg}, 0.3);`,
    `  --nidara-danger: #ff3b30;`,
    `  --nidara-danger-rgb: 255, 59, 48;`,
    `  --nidara-success: #30d158;`,
    `  --nidara-warning: #f3ba4b;`,
    `  --nidara-warning-rgb: 243, 186, 75;`,
    `  --nidara-popover-bg: rgba(${pbR}, ${pbG}, ${pbB}, ${popoverAlpha});`,
    `  --nidara-popover-border: ${popoverBorder};`,
    `  --nidara-material-thin: rgba(${bg}, ${matThin});`,
    `  --nidara-material-regular: rgba(${bg}, ${matRegular});`,
    `  --nidara-material-thick: rgba(${bg}, ${matThick});`,
    `  --nidara-material-chrome: rgba(${bg}, ${matChrome});`,
    `  --nidara-edge: ${edge};`,
    `  --nidara-shadow-sm: ${sh.sm};`,
    `  --nidara-shadow-md: ${sh.md};`,
    `  --nidara-shadow-lg: ${sh.lg};`,
    `  --nidara-shadow-popover: ${sh.popover};`,
    `  --nidara-icon-shadow: ${sh.icon};`,
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
 * Scope = the entire bar window AND the entire dock window — `window#nidara-bar`
 * hosts the bar content AND every floating overlay (CC/NC/Prism/system menu/
 * overview/expansion panel, all children of the bar's Gtk.Overlay), and
 * `window#nidara-dock` hosts the dock + the app grid. So the pin covers the full
 * shell skin. App-mode windows — Settings (`nidara-settings-window`) and About
 * (`nidara-about`) — are SEPARATE toplevels, deliberately NOT in the scope, so
 * they keep the system mode like any third-party app. The `.nd-icon` filter is
 * mirrored too: symbolic icons invert in dark and not in light.
 *
 * The selector must hit every DESCENDANT directly (`window#nidara-bar *`), not
 * just the container: GTK4 custom properties don't inherit reliably, and the
 * global `* { --nidara-* }` block matches every node directly — so a bare
 * `window#nidara-bar { --nidara-* }` only overrides the container itself and the
 * children keep the global value (glass flipped but text stayed). An id-qualified
 * universal beats `*` on specificity.
 */
export function generateChromeTokenScope(
  config: NidaraThemeConfig,
  chromeIsDark: boolean,
  systemIsDark: boolean,
): string {
  if (chromeIsDark === systemIsDark) return "/* shell skin follows system mode */"
  const sel = "window#nidara-bar, window#nidara-bar *, window#nidara-dock, window#nidara-dock *"
  const body = nidaraVars(config, chromeIsDark).join("\n")
  const iconFilter = chromeIsDark ? "invert(1)" : "none"
  return `${sel} {\n${body}\n}\n`
    + `window#nidara-bar .nd-icon, window#nidara-dock .nd-icon { -gtk-icon-filter: ${iconFilter}; }`
}


/**
 * Crystal Token Engine
 * Generates CSS custom properties and @define-color tokens for Crystal Shell's own UI.
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

export interface TintPanels {
  controlCenter: boolean
  appGrid: boolean
}

export interface FluidCrystalConfig {
  accent: AccentKey
  transparency: number   // Settings window opacity — range [0.10, 0.90]
  shellOpacity: number   // Bar + CC + NC opacity   — range [0.06, 0.75]
  dockOpacity: number    // Dock opacity            — range [0.05, 0.60]
  tintStrength: number
  tintPanels: TintPanels
}

export const DEFAULT_CONFIG: FluidCrystalConfig = {
  accent: "blue",
  transparency: 0.75,
  shellOpacity: 0.20,
  dockOpacity: 0.20,
  tintStrength: 0.0,
  tintPanels: {
    controlCenter: false,
    appGrid: false,
  },
}

// ── CSS TEMPLATES ────────────────────────────────────────────────────
// Glass effects are applied via scoped SCSS per component (e.g. _settings.scss).
// We do NOT use generic GTK selectors to avoid leaking into external apps.

const PANEL_SELECTORS: Record<keyof TintPanels, string[]> = {
  controlCenter: [".cc-panel-structure"],
  appGrid: [".app-grid-content"],
}

// ── LOGIC ────────────────────────────────────────────────────────────

function generateTokenHeader(config: FluidCrystalConfig, isDark: boolean): string {
  const accent = ACCENT_PALETTE[config.accent].color
  const t = config.transparency
  const baseAlpha = (1.0 - t).toFixed(2)
  // Light mode floor: dark text needs at least 0.40 white opacity to pass WCAG AAA
  // even on a pure black wallpaper (worst case), including inner surface-raised overlays.
  const bgAlpha = (!isDark && parseFloat(baseAlpha) < 0.40) ? "0.40" : baseAlpha

  const baseBg = isDark ? "#242424" : "#fafafa"
  // Popovers share the window's base tone (not a lighter shade) so a frosted
  // dropdown reads as the same glass as the window, just floored in alpha enough
  // for compositor blur (see popoverAlpha).
  const popoverBg = baseBg
  // Popovers need alpha ≥ 0.32 so Hyprland's popups_ignorealpha=0.30 applies blur.
  const popoverAlpha = Math.max(parseFloat(bgAlpha), 0.38).toFixed(2)
  const popoverBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"

  const lines = [
    `/* Crystal Shell Token Engine */`,
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `@define-color fc_window_bg alpha(${baseBg}, ${bgAlpha});`,
    `@define-color fc_window_bg_backdrop alpha(${baseBg}, ${bgAlpha});`,
    `@define-color fc_popover_bg alpha(${popoverBg}, ${popoverAlpha});`,
    `@define-color fc_popover_border ${popoverBorder};`,
    `@define-color sidebar_bg_color transparent;`,
    `@define-color sidebar_backdrop_color transparent;`,
    `* {`,
    `  --fc-transparency: ${t.toFixed(2)};`,
    `  --fc-accent: ${accent};`,
  ]

  for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
    lines.push(`  --accent-${key}: ${color};`)
  }
  lines.push(`  --accent-color: ${accent};`)
  lines.push(`  --accent-bg-color: ${accent};`)
  lines.push(`  --accent-fg-color: #ffffff;`)

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
  // .45 / thick .65 / chrome .85), then OFFSET by the transparency slider so the
  // ladder still responds to user opacity. delta = 0 at default transparency.
  // lower z → thicker; higher z → thinner. Clamped to keep blur visible + legible.
  const ba = parseFloat(bgAlpha)
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

  lines.push(
    `  --crystal-accent: ${accent};`,
    `  --crystal-accent-rgb: ${r}, ${g}, ${b};`,
    `  --crystal-accent-fg: #ffffff;`,
    `  --crystal-accent-60: rgba(${r}, ${g}, ${b}, 0.6);`,
    `  --crystal-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --crystal-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --crystal-accent-08: rgba(${r}, ${g}, ${b}, 0.08);`,
    `  --crystal-bg: rgba(${bg}, ${bgAlpha});`,
    `  --crystal-bg-backdrop: rgba(${bg}, ${bgAlpha});`,
    `  --crystal-surface-back: rgba(${fg}, 0.04);`,
    `  --crystal-surface: rgba(${fg}, 0.08);`,
    `  --crystal-surface-hover: rgba(${fg}, 0.12);`,
    `  --crystal-surface-active: rgba(${fg}, 0.16);`,
    // ── Interaction states ───────────────────────────────────────────────────
    // hover/pressed are MODE-AWARE (--crystal-surface-hover/-active = rgba(fg,…)):
    // they lighten in dark / darken in light, always moving toward the mode's
    // contrast, so they stay visible on ANY background — including a translucent
    // panel over a dark wallpaper, where a fixed dark "deepen" overlay vanished.
    // Selection is the ONLY place accent enters.
    `  --crystal-state-selected: rgba(${r}, ${g}, ${b}, ${isDark ? "0.22" : "0.16"});`,
    `  --crystal-surface-raised: rgba(${fg}, 0.20);`,
    `  --crystal-surface-strong: rgba(${fg}, 0.30);`,   // one step above raised, for hover on raised fills
    `  --crystal-dock-surface: rgba(${fg}, ${dBase});`,
    `  --crystal-dock-surface-raised: rgba(${fg}, ${dRaised});`,
    `  --crystal-text: ${whiteOrBlack};`,
    `  --crystal-text-secondary: rgba(${fg}, 0.8);`,
    `  --crystal-text-dim: rgba(${fg}, 0.6);`,
    `  --crystal-text-disabled: rgba(${fg}, 0.3);`,
    `  --crystal-danger: #ff3b30;`,
    `  --crystal-danger-rgb: 255, 59, 48;`,
    `  --crystal-success: #30d158;`,
    `  --crystal-warning: #f3ba4b;`,
    `  --crystal-warning-rgb: 243, 186, 75;`,
    `  --crystal-popover-bg: rgba(${pbR}, ${pbG}, ${pbB}, ${popoverAlpha});`,
    `  --crystal-popover-border: ${popoverBorder};`,
    `  --crystal-material-thin: rgba(${bg}, ${matThin});`,
    `  --crystal-material-regular: rgba(${bg}, ${matRegular});`,
    `  --crystal-material-thick: rgba(${bg}, ${matThick});`,
    `  --crystal-material-chrome: rgba(${bg}, ${matChrome});`,
    `  --crystal-edge: ${edge};`,
    `  --crystal-shadow-sm: ${sh.sm};`,
    `  --crystal-shadow-md: ${sh.md};`,
    `  --crystal-shadow-lg: ${sh.lg};`,
    `  --crystal-shadow-popover: ${sh.popover};`,
    `  --crystal-icon-shadow: ${sh.icon};`,
    `}`,
    isDark ? `` : `.cs-icon { -gtk-icon-filter: none; }`,
  )
  return lines.join("\n")
}

export function generateTokensCss(config: FluidCrystalConfig, isDark: boolean): string {
  return generateTokenHeader(config, isDark)
}


export function generateTintCss(config: FluidCrystalConfig): string {
  const accent = ACCENT_PALETTE[config.accent].color
  const strength = config.tintStrength
  if (strength <= 0) return "/* No tint */"
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  const alpha = (strength * 0.3).toFixed(3)
  let css = `/* Tint */\n`
  for (const [panel, selectors] of Object.entries(PANEL_SELECTORS)) {
    if (!config.tintPanels[panel as keyof TintPanels]) continue
    for (const sel of selectors) {
      css += `${sel} { background-color: rgba(${r}, ${g}, ${b}, ${alpha}); }\n`
    }
  }
  return css
}


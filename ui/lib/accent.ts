/**
 * Crystal Shell — accent palette (single source of truth)
 *
 * The 9 canonical accent colors, shared by all three bundles (shell, greeter,
 * lockscreen). The shell's FluidCrystal token engine builds its ACCENT_PALETTE
 * from ACCENT_HEX; the greeter and lockscreen build their accent CSS via
 * accentCssFor(). SCSS swatches read the runtime --accent-<key> tokens that
 * FluidCrystal emits, so nothing hardcodes these hex values anywhere else.
 */

export const ACCENT_HEX = {
  blue:   "#0088FF",
  teal:   "#2190a4",
  green:  "#79B757",
  yellow: "#F3BA4B",
  orange: "#E9873A",
  red:    "#ED5F5D",
  pink:   "#E55E9C",
  purple: "#9A57A3",
  slate:  "#6f8396",
} as const

export type AccentKey = keyof typeof ACCENT_HEX

export const ACCENT_NAMES: Record<AccentKey, string> = {
  blue:   "Blue",
  teal:   "Teal",
  green:  "Green",
  yellow: "Yellow",
  orange: "Orange",
  red:    "Red",
  pink:   "Pink",
  purple: "Purple",
  slate:  "Slate",
}

/** "#rrggbb" → "r, g, b" */
export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}

/**
 * CSS block defining the --crystal-accent* custom properties for a given accent
 * key. Used by the greeter and lockscreen (which read the accent from
 * appearance.json and apply this via app.apply_css). Unknown/empty keys → "".
 */
export function accentCssFor(accent: string | null | undefined): string {
  if (!accent || !(accent in ACCENT_HEX)) return ""
  const color = ACCENT_HEX[accent as AccentKey]
  const rgb = hexToRgb(color)
  return [
    `* {`,
    `  --crystal-accent:     ${color};`,
    `  --crystal-accent-rgb: ${rgb};`,
    `  --crystal-accent-10:  rgba(${rgb}, 0.10);`,
    `  --crystal-accent-15:  rgba(${rgb}, 0.15);`,
    `  --crystal-accent-20:  rgba(${rgb}, 0.20);`,
    `  --crystal-accent-30:  rgba(${rgb}, 0.30);`,
    `  --crystal-focus-ring: rgba(${rgb}, 0.35);`,
    `}`,
  ].join("\n")
}

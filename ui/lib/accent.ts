/**
 * Nidara — accent palette (single source of truth)
 *
 * The 9 canonical accent colors, shared by all three bundles (shell, greeter,
 * lockscreen). The shell's NidaraTheme token engine builds its ACCENT_PALETTE
 * from ACCENT_HEX; the greeter and lockscreen build their accent CSS via
 * accentCssFor(). SCSS swatches read the runtime --accent-<key> tokens that
 * NidaraTheme emits, so nothing hardcodes these hex values anywhere else.
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

/** "#rrggbb" → { r, g, b } as 0..1 floats, what Cairo's setSourceRGBA wants. The
 *  single conversion point for any Cairo draw call that needs a color defined as a
 *  hex string elsewhere (the live accent, a semantic status color). It sits here
 *  rather than in the shell's `common/DrawingUtils.ts` — which re-exports it — so
 *  `nidara-kit/slider.ts` can fill its track with the accent without reaching into
 *  `ui/shell/`. */
export function hexToFloatRgb(hex: string): { r: number, g: number, b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

/**
 * CSS block defining the --nidara-accent* custom properties for a given accent
 * key. Used by the greeter and lockscreen (which read the accent from
 * appearance.json and apply this via app.apply_css). Unknown/empty keys → "".
 */
export function accentCssFor(accent: string | null | undefined): string {
  if (!accent || !(accent in ACCENT_HEX)) return ""
  const color = ACCENT_HEX[accent as AccentKey]
  const rgb = hexToRgb(color)
  return [
    `* {`,
    `  --nidara-accent:     ${color};`,
    `  --nidara-accent-rgb: ${rgb};`,
    `  --nidara-accent-10:  rgba(${rgb}, 0.10);`,
    `  --nidara-accent-15:  rgba(${rgb}, 0.15);`,
    `  --nidara-accent-20:  rgba(${rgb}, 0.20);`,
    `  --nidara-accent-30:  rgba(${rgb}, 0.30);`,
    `}`,
  ].join("\n")
}

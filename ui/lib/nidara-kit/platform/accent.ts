// SPDX-License-Identifier: LGPL-3.0-or-later
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
 * the appearance mirror and apply this via app.apply_css). Unknown/empty keys → "".
 *
 * ⚠️ `--nidara-state-selected` is an ACCENT token and is emitted here, which it was
 * not until 2026-09-07 (tech-debt #92 / issue #323). The login sheet declares it once
 * as the DEFAULT blue at 0.22, so a user who picked green got green everywhere on the
 * login screen except the selected row of a dropdown, which stayed blue forever — on
 * the two surfaces that have no dev mode to notice it in.
 *
 * 🔑 It is emitted from HERE and not typed in the stylesheet, and the reason outlives
 * the light skin it was written for: a value typed in the sheet would PIN the selection
 * to whatever colour was typed, for every user who chose a different one. Emitting it
 * from the same accent the rest of the screen uses is what keeps it following them.
 * (Until 2026-09-21 this block had a second half under `window.skin-light *`, for the
 * light skin's lighter 0.16 — the skin is gone, see #613.) The alpha is the shell's
 * own, from `ui/lib/nidara-kit/platform/theme-tokens.ts` ("Selection is the ONLY place accent enters").
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
    `  --nidara-accent-30:  rgba(${rgb}, 0.30);`,
    `  --nidara-state-selected: rgba(${rgb}, 0.22);`,
    `}`,
  ].join("\n")
}

/** Map an (r, g, b) triple (0..1 or 0..255) to the closest Nidara AccentKey. */
export function rgbToClosestAccent(r: number, g: number, b: number): AccentKey {
  const r255 = r <= 1.0 ? r * 255 : r
  const g255 = g <= 1.0 ? g * 255 : g
  const b255 = b <= 1.0 ? b * 255 : b

  let closestKey: AccentKey = "blue"
  let minDistance = Infinity

  for (const [key, hex] of Object.entries(ACCENT_HEX)) {
    const hr = parseInt(hex.slice(1, 3), 16)
    const hg = parseInt(hex.slice(3, 5), 16)
    const hb = parseInt(hex.slice(5, 7), 16)
    const dist = Math.hypot(r255 - hr, g255 - hg, b255 - hb)
    if (dist < minDistance) {
      minDistance = dist
      closestKey = key as AccentKey
    }
  }

  return closestKey
}


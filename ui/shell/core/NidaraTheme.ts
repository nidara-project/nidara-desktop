/**
 * The shell's view of the token engine.
 *
 * The engine itself is `ui/lib/nidara-kit/platform/theme-tokens.ts` since 2026-08-26 — it never
 * depended on anything in `ui/shell/`, and keeping it here was what stopped the
 * greeter, the lockscreen and the installer from having the ramp at all. This
 * module re-exports it so the shell's existing importers do not care, and keeps
 * the one piece that genuinely IS shell knowledge: which windows wear the shell
 * skin.
 */
export * from "../../lib/nidara-kit/platform/theme-tokens"

import { nidaraVars, type NidaraThemeConfig } from "../../lib/nidara-kit/platform/theme-tokens"

export const CHROME_SCOPE_WINDOWS = [
  "nidara-bar",
  "nidara-dock",
  "nidara-island",
  "nidara-app-grid",
] as const

export function generateChromeTokenScope(
  config: NidaraThemeConfig,
  chromeIsDark: boolean,
  systemIsDark: boolean,
): string {
  if (chromeIsDark === systemIsDark) return "/* shell skin follows system mode */"
  // An id-qualified universal per window: the bare container selector does not
  // reach the children (see the note above about GTK4 custom properties).
  const sel = CHROME_SCOPE_WINDOWS.map((w) => `window#${w}, window#${w} *`).join(", ")
  const body = nidaraVars(config, chromeIsDark).join("\n")
  // The icons need no rule of their own: they are symbolic files and take the
  // CSS `color` that `--nidara-text` — redefined right here for the pinned skin —
  // already gives them. This used to emit a second selector flipping
  // `-gtk-icon-filter` between invert(1) and none, which is what a non-symbolic
  // black drawing needed.
  return `${sel} {\n${body}\n}`
}


/**
 * The token sets a surface wears when the ADAPTIVE GLASS flips its skin (#673,
 * `common/AdaptiveGlass.ts`): a full `--nidara-*` set for each skin, scoped to a class
 * the surface's root carries only while flipped. Always emitted — toggling the class
 * is the whole switch, no stylesheet reload per flip.
 *
 * `window#<w> .nidara-skin-light *` is (1,1,1) and beats both the global `*` and the
 * pin's `window#<w> *` (1,0,1), so a flipped surface wins over the pin too — which is
 * the point: the pin is a preference, legibility over a white backdrop is not.
 */
export function generateSkinFlipScope(config: NidaraThemeConfig): string {
  const block = (isDark: boolean) => {
    const cls = isDark ? "nidara-skin-dark" : "nidara-skin-light"
    const sel = CHROME_SCOPE_WINDOWS.map((w) => `window#${w} .${cls}, window#${w} .${cls} *`).join(", ")
    return `${sel} {\n${nidaraVars(config, isDark).join("\n")}\n}`
  }
  return `${block(true)}\n${block(false)}`
}

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
import { INK_DARK_CLASS } from "../../lib/nidara-kit/platform/material"

export const CHROME_SCOPE_WINDOWS = [
  "nidara-bar",
  "nidara-dock",
  "nidara-island",
  "nidara-app-grid",
] as const

/** The shell's skin: dark, whatever the system mode (owner, 2026-09-30) — see
 *  `ThemeManager.chromeIsDark`. One constant, so the setting that is to offer a light
 *  skin later has one place to replace. */
export const SHELL_SKIN_IS_DARK = true

/**
 * The shell's windows wear THEIR skin, not the mode's: the global `*` token block
 * follows the system mode (it is also what Settings and About wear), so when the two
 * differ every window in `CHROME_SCOPE_WINDOWS` gets the full `--nidara-*` set of the
 * shell's skin, scoped to itself. Brought back on 2026-09-30 from the pin that was
 * removed the day before (#676) — same selector, same reason: an id-qualified universal
 * per window, because the bare container selector does not reach the children (GTK4
 * custom properties do not inherit reliably; see theme-tokens.ts).
 * The icons need no rule of their own: they are symbolic and take `--nidara-text`.
 */
export function generateChromeTokenScope(
  config: NidaraThemeConfig,
  chromeIsDark: boolean,
  systemIsDark: boolean,
): string {
  if (chromeIsDark === systemIsDark) return "/* the shell's skin is the mode's */"
  const sel = CHROME_SCOPE_WINDOWS.map((w) => `window#${w}, window#${w} *`).join(", ")
  return `${sel} {\n${nidaraVars(config, chromeIsDark).join("\n")}\n}`
}

/**
 * The token sets a surface wears when the ADAPTIVE GLASS flips its skin (#673,
 * `common/AdaptiveGlass.ts`): a full `--nidara-*` set for each skin, scoped to a class
 * the surface's root carries only while flipped. Always emitted — toggling the class
 * is the whole switch, no stylesheet reload per flip.
 *
 * `window#<w> .nidara-skin-light *` is (1,1,1) and beats both the global `*` and the
 * shell's `window#<w> *` (1,0,1), so a flipped surface's tokens win everywhere inside
 * it. (Nothing flips automatically since 2026-09-30 — `decideGlass`'s `flip: false` —
 * but the classes stay, for the light skin that is to come.)
 */
export function generateSkinFlipScope(config: NidaraThemeConfig): string {
  const block = (isDark: boolean) => {
    // A pane of Hyalo's glass whose content the compositor said is dark (the ink, #684,
    // `INK_DARK_CLASS`) wears the light skin's tokens: the same switch, per pane.
    const classes = isDark ? ["nidara-skin-dark"] : ["nidara-skin-light", INK_DARK_CLASS]
    const sel = CHROME_SCOPE_WINDOWS.flatMap((w) => classes.map((cls) => `window#${w} .${cls}, window#${w} .${cls} *`)).join(", ")
    return `${sel} {\n${nidaraVars(config, isDark).join("\n")}\n}`
  }
  return `${block(true)}\n${block(false)}`
}

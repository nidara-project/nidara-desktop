/**
 * The shell's view of the token engine.
 *
 * The engine itself is `ui/lib/theme-tokens.ts` since 2026-08-26 — it never
 * depended on anything in `ui/shell/`, and keeping it here was what stopped the
 * greeter, the lockscreen and the installer from having the ramp at all. This
 * module re-exports it so the shell's existing importers do not care, and keeps
 * the one piece that genuinely IS shell knowledge: which windows wear the shell
 * skin.
 */
export * from "../../lib/theme-tokens"

import { nidaraVars, type NidaraThemeConfig } from "../../lib/theme-tokens"

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
  const iconSel = CHROME_SCOPE_WINDOWS.map((w) => `window#${w} .nd-icon`).join(", ")
  const body = nidaraVars(config, chromeIsDark).join("\n")
  const iconFilter = chromeIsDark ? "invert(1)" : "none"
  return `${sel} {\n${body}\n}\n`
    + `${iconSel} { -gtk-icon-filter: ${iconFilter}; }`
}


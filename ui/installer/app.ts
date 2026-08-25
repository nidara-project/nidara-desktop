// Nidara Installer — the entry point of the fourth bundle.
//
// This surface exists only on the live medium: it is packaged as
// `nidara-installer`, which nothing but nidara-iso's package list ever names, so
// an installed desktop never carries code that partitions disks. See
// `nidara-iso/INSTALLER.md` for the decision and the shape.
//
// What it is NOT allowed to do is worth stating at the top of the file it would
// be added to: it never partitions, never formats, never pacstraps and never
// writes a bootloader. It collects answers, produces an archinstall config, and
// runs one process as root. Everything that can destroy data lives on the other
// side of that seam, in Arch's own code.

import app from "../lib/host"
import GLib from "gi://GLib"
import { setKitAppearance } from "../lib/nidara-kit"
import { ACCENT_HEX, accentCssFor, type AccentKey } from "../lib/accent"
import { setAccentRim } from "../lib/glass-capsule"
import { applyCrispFontRendering } from "../lib/font-rendering"
import { InstallerWindow } from "./widget/InstallerWindow"

// Our blank theme instead of Adwaita: with an empty gtk.css at
// /usr/share/themes/nidara/gtk-4.0/gtk.css, this sheet is the only CSS there is.
GLib.setenv("GTK_THEME", "nidara", true)

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/nidara/ui/installer/style.css"

/**
 * The live session's appearance, as the shell last wrote it.
 *
 * The installer runs INSIDE a running Nidara, so it has no opinions of its own:
 * whatever accent and mode the user picked while trying the desktop is what its
 * window wears. `/var/tmp/nidara/appearance.json` is the world-readable mirror
 * ThemeManager keeps for exactly this kind of second process (the greeter reads
 * the same pair of paths, and for the same reason).
 */
function readAppearance(): Record<string, unknown> {
  const candidates = [
    `${GLib.get_user_config_dir()}/nidara/appearance.json`,
    "/var/tmp/nidara/appearance.json",
  ]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      return JSON.parse(new TextDecoder().decode(data as Uint8Array))
    } catch { /* try the next one */ }
  }
  return {}
}

app.start({
  applicationId: "org.nidara.installer",
  applicationName: "Nidara Installer",
  logDomain: "nidara-installer",
  css: cssPath,

  main() {
    // Before any window exists: glyph baselines on the pixel grid. There is no
    // ThemeManager in this process to do it later.
    applyCrispFontRendering()

    const appearance = readAppearance()
    const accent = ACCENT_HEX[appearance.accent as AccentKey] ?? ACCENT_HEX.blue
    const isDark = appearance.isDark === true

    // The kit's appearance seam — one registration per bundle, before the first
    // kit widget is built. Cairo cannot read a CSS token, so the accent has to
    // arrive as a value and "is my surface dark?" has to be answered by whoever
    // knows. Here that is the file above; an unregistered bundle would silently
    // paint a blue control on a light surface.
    setKitAppearance({
      accent: () => accent,
      surfaceIsDark: () => isDark,
      onChange: () => () => {},
    })
    setAccentRim(accent)

    const css = accentCssFor(appearance.accent as string | undefined)
    // Same USER priority, added after the base sheet: equal priority + later
    // order wins the GTK4 cascade. Keep the order.
    if (css) app.apply_css(css, false)

    InstallerWindow({ isDark }).present()
  },
})

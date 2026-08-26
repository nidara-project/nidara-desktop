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
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { setKitAppearance } from "../lib/nidara-kit"
import { ACCENT_HEX, hexToRgb, type AccentKey } from "../lib/accent"
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
 * whatever accent, mode, and window opacity the user picked while trying the desktop
 * is what its window wears. `/var/tmp/nidara/appearance.json` is the world-readable mirror
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

function dynamicAppearanceCss(appearance: Record<string, unknown>): string {
  const isDark = appearance.isDark !== false
  const accentKey = (appearance.accent as AccentKey) ?? "blue"
  const accent = ACCENT_HEX[accentKey] ?? ACCENT_HEX.blue
  const rgb = hexToRgb(accent)
  const windowOpacity = typeof appearance.windowOpacity === "number"
    ? Math.max(0.24, Math.min(0.80, appearance.windowOpacity))
    : 0.48

  const tintRgb = isDark ? "22, 22, 34" : "246, 246, 250"
  const edgeColor = isDark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.10)"
  const shadowLg = isDark
    ? "0 8px 24px rgba(0, 0, 0, 0.40), 0 2px 6px rgba(0, 0, 0, 0.24)"
    : "0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.06)"

  return `
    * {
      --nidara-accent:          ${accent};
      --nidara-accent-rgb:      ${rgb};
      --nidara-accent-10:       rgba(${rgb}, 0.10);
      --nidara-accent-15:       rgba(${rgb}, 0.15);
      --nidara-accent-20:       rgba(${rgb}, 0.20);
      --nidara-accent-30:       rgba(${rgb}, 0.30);
      --nidara-accent-60:       rgba(${rgb}, 0.60);
      --nidara-state-selected:  rgba(${rgb}, ${isDark ? "0.22" : "0.16"});
      --nidara-bg:              rgba(${tintRgb}, ${windowOpacity});
      --nidara-edge:            1px solid ${edgeColor};
      --nidara-shadow-lg:       ${shadowLg};
    }
  `
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

    let currentAppearance = readAppearance()
    let currentAccent = ACCENT_HEX[currentAppearance.accent as AccentKey] ?? ACCENT_HEX.blue
    let currentIsDark = currentAppearance.isDark !== false

    const listeners = new Set<() => void>()

    // The kit's appearance seam — one registration per bundle, before the first
    // kit widget is built. Cairo cannot read a CSS token, so the accent has to
    // arrive as a value and "is my surface dark?" has to be answered by whoever
    // knows.
    setKitAppearance({
      accent: () => currentAccent,
      surfaceIsDark: () => currentIsDark,
      onChange: (cb) => {
        listeners.add(cb)
        return () => { listeners.delete(cb) }
      },
    })
    setAccentRim(currentAccent)

    const dynamicProvider = new Gtk.CssProvider()
    const display = Gdk.Display.get_default()
    if (display) {
      Gtk.StyleContext.add_provider_for_display(
        display,
        dynamicProvider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER + 20,
      )
    }

    const applyAppearance = (appState: Record<string, unknown>, win?: Gtk.Window) => {
      currentAppearance = appState
      currentAccent = ACCENT_HEX[appState.accent as AccentKey] ?? ACCENT_HEX.blue
      currentIsDark = appState.isDark !== false

      setAccentRim(currentAccent)
      try {
        dynamicProvider.load_from_string(dynamicAppearanceCss(appState))
      } catch (err) {
        console.error(`[nidara-installer] Failed to load appearance CSS: ${err}`)
      }

      if (win) {
        if (!currentIsDark) {
          win.add_css_class("installer-light")
        } else {
          win.remove_css_class("installer-light")
        }
      }
      listeners.forEach((cb) => cb())
    }

    applyAppearance(currentAppearance)

    const win = InstallerWindow({ isDark: currentIsDark })

    // Watch appearance.json for live settings changes (Settings → Appearance)
    const configPath = `${GLib.get_user_config_dir()}/nidara/appearance.json`
    const configFile = Gio.File.new_for_path(configPath)
    try {
      const monitor = configFile.monitor_file(Gio.FileMonitorFlags.NONE, null)
      monitor.connect("changed", () => {
        const next = readAppearance()
        applyAppearance(next, win)
      })
    } catch { /* ignore if monitoring not supported */ }

    win.present()
  },
})

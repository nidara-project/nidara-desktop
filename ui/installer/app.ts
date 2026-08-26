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
import { DANGER_HEX } from "../lib/status-colors"
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
function readAppearance(): { state: Record<string, unknown>; path: string | null } {
  const candidates = [
    `${GLib.get_user_config_dir()}/nidara/appearance.json`,
    "/var/tmp/nidara/appearance.json",
  ]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      return { state: JSON.parse(new TextDecoder().decode(data as Uint8Array)), path }
    } catch { /* try the next one */ }
  }
  return { state: {}, path: null }
}

/**
 * Is the session dark? A MISSING key means light, not dark.
 *
 * `isDark === true`, never `!== false`: the shell's own DEFAULT_CONFIG ships
 * light, so an installer that defaulted the other way would wear the opposite of
 * the desktop it was launched from the moment the mirror is unreadable — which is
 * exactly the case where nobody is around to notice the file was missing.
 */
function readIsDark(state: Record<string, unknown>): boolean {
  return state.isDark === true
}

/**
 * The half of the token ramp that only a running session can know: the accent the
 * user picked and the opacity they set for windows. `style.scss` carries the rest
 * (the ink, the surfaces, the radii) and its values here are the fallback for when
 * this block never loads.
 *
 * ⚠️ This is a hand-rolled subset of what `ui/shell/core/NidaraTheme.ts`
 * (`nidaraVars`) already emits in full — mode-aware, opacity-aware, ~60 tokens.
 * That engine imports nothing from the shell; it is simply in `ui/shell/` for
 * historical reasons, so three bundles re-derive a partial copy of it. Moving it
 * to `ui/lib/` deletes this function and the two ramps in `style.scss` with it.
 * See the skill's tech-debt #95(b).
 */
function dynamicAppearanceCss(appearance: Record<string, unknown>): string {
  const isDark = readIsDark(appearance)
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
      --nidara-danger:          ${DANGER_HEX};
      --nidara-danger-rgb:      ${hexToRgb(DANGER_HEX)};
      --nidara-edge:            1px solid ${edgeColor};
      --nidara-shadow-lg:       ${shadowLg};
    }
  `
}

/**
 * Held for the process's lifetime, at module scope on purpose: a `Gio.FileMonitor`
 * that nothing references is collected, and its "changed" signal then stops
 * arriving with no error and no log line — a live-update feature that silently
 * works for a few seconds and then does not.
 */
let appearanceMonitor: Gio.FileMonitor | null = null

app.start({
  applicationId: "org.nidara.installer",
  applicationName: "Nidara Installer",
  logDomain: "nidara-installer",
  css: cssPath,

  main() {
    // Before any window exists: glyph baselines on the pixel grid. There is no
    // ThemeManager in this process to do it later.
    applyCrispFontRendering()

    const first = readAppearance()
    let currentAppearance = first.state
    let currentAccent = ACCENT_HEX[currentAppearance.accent as AccentKey] ?? ACCENT_HEX.blue
    let currentIsDark = readIsDark(currentAppearance)

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

    // Above the base sheet (which `app.start({ css })` loads at USER priority), so
    // the values computed from the live session win over the sheet's fallbacks —
    // in GTK4 the provider's priority is decided before specificity is looked at.
    // A provider rather than `app.apply_css`, because this one is RELOADED on
    // every change and only a provider we keep a handle to can be replaced.
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
      currentIsDark = readIsDark(appState)

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

    // Follow Settings → Appearance while the installer is open: the user trying
    // the desktop may well change the accent WITH the installer on screen, and a
    // window that stayed on the old one would look like a foreign application.
    //
    // The watched path is the one that actually answered, not a fixed guess: if
    // the session's config dir was unreadable and the /var/tmp mirror is what we
    // read, that mirror is what changes.
    if (first.path) {
      try {
        const monitor = Gio.File.new_for_path(first.path)
          .monitor_file(Gio.FileMonitorFlags.NONE, null)
        monitor.connect("changed", () => applyAppearance(readAppearance().state, win))
        appearanceMonitor = monitor
      } catch { /* a filesystem without change notification: the window keeps what it read */ }
    }

    win.present()
  },
})

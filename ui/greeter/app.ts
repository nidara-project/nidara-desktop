import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Greeter from "./widget/Greeter"
import { getPreferredUser } from "./lib/greeter-prefs"
import { accentCssFor } from "../lib/accent"

// Use our blank theme instead of Adwaita.
// With an empty gtk.css at /usr/share/themes/nidara/gtk-4.0/gtk.css,
// GTK4 loads zero theme rules — our app CSS is the only CSS that applies.
GLib.setenv("GTK_THEME", "nidara", true)

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/nidara/ui/greeter/style.css"

function readAppearanceJson(): Record<string, unknown> | null {
  // Try the last-logged-in user's home dir first (works if /home/<user> is not
  // 700). Fall back to /var/tmp/nidara/appearance.json — written by ThemeManager
  // as a world-readable mirror so the greeter (system user) can always read it.
  const candidates: string[] = [
    `${getPreferredUser().homeDir}/.config/nidara/appearance.json`,
    "/var/tmp/nidara/appearance.json",
  ]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      return JSON.parse(new TextDecoder().decode(data as Uint8Array))
    } catch { /* try next */ }
  }
  return null
}

function loadAccentCss(): string {
  try {
    const cfg = readAppearanceJson()
    return accentCssFor(cfg?.accent as string | undefined)
  } catch {
    return ""
  }
}

app.start({
  instanceName: "nidara-greeter",
  css: cssPath,

  main() {
    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Greeter] No display"); return }

    const accentCss = loadAccentCss()
    if (accentCss) {
      // load_from_string with the same USER priority, but added AFTER the base CSS
      // → same priority + later order = wins in GTK4 cascade
      app.apply_css(accentCss)
    }

    // Login UI on the primary monitor only. The other outputs already show the
    // generic wallpaper painted by awww in the compositor (it covers all
    // outputs), so a per-monitor greeter window would only duplicate the
    // password field and race for keyboard focus.
    const monitors: any = display.get_monitors()
    if (monitors.get_n_items() === 0) { console.error("[Greeter] No monitors"); return }
    try {
      Greeter(monitors.get_item(0) as Gdk.Monitor)
    } catch (e) {
      console.error("[Greeter] Failed on primary monitor:", e)
    }
  },
})

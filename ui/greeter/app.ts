import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
import Greeter from "./widget/Greeter"
import { getDefaultUser } from "../lib/users"
import { accentCssFor } from "../lib/accent"

// Use our blank theme instead of Adwaita.
// With an empty gtk.css at /usr/share/themes/crystal-shell/gtk-4.0/gtk.css,
// GTK4 loads zero theme rules — our app CSS is the only CSS that applies.
GLib.setenv("GTK_THEME", "crystal-shell", true)

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/crystal-shell/ui/greeter/style.css"

function readAppearanceJson(): Record<string, unknown> | null {
  // Try the user's home dir first (works if /home/<user> is not 700).
  // Fall back to /var/tmp/crystal-shell/appearance.json — written by ThemeManager
  // as a world-readable mirror so the greeter (system user) can always read it.
  const candidates: string[] = [
    `${getDefaultUser().homeDir}/.config/crystal-shell/appearance.json`,
    "/var/tmp/crystal-shell/appearance.json",
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
  instanceName: "crystal-greeter",
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

    const monitors: any = display.get_monitors()
    const n = monitors.get_n_items()
    for (let i = 0; i < n; i++) {
      try {
        Greeter(monitors.get_item(i) as Gdk.Monitor)
      } catch (e) {
        console.error(`[Greeter] Failed on monitor ${i}:`, e)
      }
    }
  },
})

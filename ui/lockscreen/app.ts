import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import Lock from "./widget/Lock"

try {
  Adw.init()
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.PREFER_DARK)
} catch (e) {
  console.warn("[Lock] Adw init:", e)
}

// Share the greeter's compiled CSS
const cssPath = GLib.file_test("/usr/share/crystal-shell/ui/greeter/style.css", GLib.FileTest.EXISTS)
  ? "/usr/share/crystal-shell/ui/greeter/style.css"
  : "../greeter/style.css"

app.start({
  instanceName: "crystal-lock",
  css: cssPath,

  main() {
    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Lock] No display"); return }

    const monitors: any = display.get_monitors()
    const n = monitors.get_n_items()
    for (let i = 0; i < n; i++) {
      try {
        Lock(monitors.get_item(i) as Gdk.Monitor)
      } catch (e) {
        console.error(`[Lock] Failed on monitor ${i}:`, e)
      }
    }
  },
})

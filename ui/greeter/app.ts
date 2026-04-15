import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import Greeter from "./widget/Greeter"

// Force dark mode
try {
  GLib.unsetenv("GTK_THEME")
  Adw.init()
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.PREFER_DARK)
} catch (e) {
  console.warn("[Greeter] Adw init:", e)
}

// CSS: try relative path (dev / prod after cd), then absolute installed path
const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/crystal-shell/ui/greeter/style.css"

app.start({
  applicationId: "com.crystalshell.greeter",
  css: cssPath,

  main() {
    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Greeter] No display"); return }

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

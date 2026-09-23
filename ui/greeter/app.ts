import app from "../lib/nidara-kit/platform/host"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Greeter from "./widget/Greeter"
import { getPreferredUser } from "./lib/greeter-prefs"
import { initProcessLocale } from "./lib/i18n"
import { initAppearance } from "../lib/nidara-kit/platform/appearance-css"
import { applyCrispFontRendering } from "../lib/nidara-kit/platform/font-rendering"
import { useNoGtkTheme } from "../lib/nidara-kit/platform/gtk-theme"

// No GTK theme at all — this sheet is the only CSS there is (commandment 11).
useNoGtkTheme()

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/nidara/ui/greeter/style.css"

app.start({
  applicationId: "org.nidara.greeter",
  applicationName: "Nidara Greeter",
  logDomain: "nidara-greeter",
  css: cssPath,

  main() {
    // First thing after GTK init (which resets the locale to "C" — empty
    // greetd env): align the process locale with the greeter's language, so
    // the clock's date names AND Pango's CJK face selection are right from
    // the first frame. See lib/i18n.ts initProcessLocale().
    initProcessLocale()

    // Before any window exists: put glyph baselines on the pixel grid. The greeter
    // has no ThemeManager, so without this it renders text the shell would not.
    applyCrispFontRendering()

    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Greeter] No display"); return }

    // The token ramp, the kit's Cairo seam and the glass rim. The greeter is the ONE
    // surface outside any user session — the `greeter` system user, its own
    // compositor, no portal — so it reads the mirror the shell exports for it
    // (/var/tmp/nidara/appearance.json) instead. See the contract in ui/lib/nidara-kit/platform/appearance.ts.
    // `fixedDarkInk`: this screen's palette is NOT a fallback the session may
    // override. Everything behind it is a wallpaper, so it is permanently dark
    // glass with light ink — the desktop being in light mode says nothing about
    // what is legible here. Without it the ramp emitted from `isDark: false`
    // outranks this bundle's own sheet (it is installed at USER + 20) and paints
    // every label black over the login wallpaper. See #612.
    initAppearance({ channel: "mirror", fixedDarkInk: true })

    // Login UI on the primary monitor only. The other outputs already show the
    // generic wallpaper painted by awww in the compositor (it covers all
    // outputs), so a per-monitor greeter window would only duplicate the
    // password field and race for keyboard focus.
    const monitors: any = display.get_monitors()
    if (monitors.get_n_items() === 0) { console.error("[Greeter] No monitors"); return }
    try {
      const monitor = monitors.get_item(0) as Gdk.Monitor
      const win = Greeter(monitor)

    } catch (e) {
      console.error("[Greeter] Failed on primary monitor:", e)
    }
  },
})

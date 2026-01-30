import "./polyfills"
import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Dock from "./widget/Dock"

const windows = new Set()

app.start({
  main() {
    // Tacitly compile SCSS to CSS on startup for DistroIA
    try {
      const scss = `${GLib.get_current_dir()}/style.scss`
      const css = `${GLib.get_current_dir()}/style.css`
      GLib.spawn_command_line_sync(`sass ${scss} ${css}`)
      GLib.spawn_command_line_sync(`sed -i '/@charset "UTF-8";/d' ${css}`)
      console.log("[DISTROIA] SCSS compiled and cleaned successfully.")
    } catch (e) {
      console.error("[DISTROIA] Failed to compile SCSS:", e)
    }

    // Manually inject CSS with the HIGHEST priority (USER = 800)
    // This kills the system-wide purple theme once and for all.
    const styleFile = `${GLib.get_current_dir()}/style.css`
    const provider = new Gtk.CssProvider()
    provider.load_from_path(styleFile)

    const display = Gdk.Display.get_default()
    if (display) {
      Gtk.StyleContext.add_provider_for_display(
        display,
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER
      )

      const monitors = display.get_monitors()
      for (let i = 0; i < monitors.get_n_items(); i++) {
        const monitor = monitors.get_item(i) as Gdk.Monitor
        const win = Dock(monitor)
        windows.add(win)
      }
    }
    console.log(`[CSS] Nuclear injection successful with HIGHEST priority (800) from: ${styleFile}`)
  },
})

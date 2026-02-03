import "./polyfills"
import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Dock from "./widget/Dock"
import AppGrid from "./widget/AppGrid"
import Bar from "./widget/Bar"
import NotificationPopups from "./widget/NotificationPopups"
import ControlCenter from "./widget/ControlCenter"
import NotificationCenter from "./widget/NotificationCenter"

const windows = new Set<Gtk.Window>()
const appGrids: any[] = []
const controlCenters: any[] = []
const notificationCenters: any[] = []

console.log("[DISTROIA] app.ts loading... (Phase 56: Dual Center Architecture)");

app.start({
  main() {
    console.log("[DISTROIA] main() started!");

    // Manually inject CSS with the HIGHEST priority (USER = 800)
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
        console.log(`[DISTROIA] Creating UI stack for monitor ${i}`);
        try {
          const barWin = Bar(monitor)
          const dockWin = Dock(monitor)
          const gridWin = AppGrid(monitor)
          const notifWin = NotificationPopups(monitor)
          const ccWin = ControlCenter(monitor)
          const ncWin = NotificationCenter(monitor)

          windows.add(barWin); windows.add(dockWin)
          windows.add(gridWin); windows.add(notifWin)
          windows.add(ccWin); windows.add(ncWin)

          appGrids.push(gridWin)
          controlCenters.push(ccWin)
          notificationCenters.push(ncWin)
        } catch (err) {
          console.error("[DISTROIA] UI creation failed:", err);
        }
      }
    }

    // Global toggle for external triggers (Hyprland / Keyboard)
    (globalThis as any).toggleAppGrid = () => {
      appGrids.forEach(g => g.toggle())
    }

    (globalThis as any).toggleControlCenter = () => {
      // Toggle and close others
      notificationCenters.forEach(nc => nc.set_visible(false))
      controlCenters.forEach(cc => cc.toggle())
    }

    (globalThis as any).toggleNotificationCenter = () => {
      // Toggle and close others
      controlCenters.forEach(cc => cc.set_visible(false))
      notificationCenters.forEach(nc => nc.toggle())
    }

    console.log(`[CSS] Nuclear injection successful with HIGHEST priority (800) from: ${styleFile}`)
  },
  requestHandler(argv, res) {
    if (argv[0] === "toggleAppGrid()") {
      (globalThis as any).toggleAppGrid?.()
      res("ok")
    } else if (argv[0] === "toggleControlCenter()") {
      (globalThis as any).toggleControlCenter?.()
      res("ok")
    } else if (argv[0] === "toggleNotificationCenter()") {
      (globalThis as any).toggleNotificationCenter?.()
      res("ok")
    } else {
      res("unknown command")
    }
  }
})

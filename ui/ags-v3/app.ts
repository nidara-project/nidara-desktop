import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

// Widget Imports
import Dock from "./widget/Dock"
import AppGrid from "./widget/AppGrid"
import Bar from "./widget/Bar"
import NotificationPopups from "./widget/NotificationPopups"
import ControlCenter from "./widget/ControlCenter"
import NotificationCenter from "./widget/NotificationCenter"

console.log("[DISTROIA] app.ts loading... (Phase 65: Mega-Main Stability)");

app.start({
  main() {
    console.log("[DISTROIA] main() started!");

    const windows = new Set<Gtk.Window>()
    const appGrids: any[] = []
    const controlCenters: any[] = []
    const notificationCenters: any[] = []

    // 🎨 Dynamic Style Sync
    const styleFile = `${GLib.get_current_dir()}/style.css`
    const mainProvider = new Gtk.CssProvider()
    const themeProvider = new Gtk.CssProvider()
    const defaultDisplay = Gdk.Display.get_default()

    const syncTheme = () => {
      try {
        const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
        const fontName = settings.get_string("font-name")
        const [family, size] = fontName.match(/^(.*?) (\d+)$/)?.slice(1) || ["sans-serif", "11"]

        const themeCss = `
          * { 
            font-family: "${family}", "Symbols Nerd Font", sans-serif; 
          }
        `
        themeProvider.load_from_data(themeCss, themeCss.length)
        console.log(`[Style] Sync: ${family} ${size}px`)
      } catch (e) { console.error("[Style] GSettings error:", e) }
    }

    try {
      mainProvider.load_from_path(styleFile)
      if (defaultDisplay) {
        Gtk.StyleContext.add_provider_for_display(defaultDisplay, mainProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
        Gtk.StyleContext.add_provider_for_display(defaultDisplay, themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        syncTheme()

        // Listen for changes
        const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
        settings.connect("changed::font-name", syncTheme)
      }
    } catch (err) { console.error(`[Style] Error:`, err) }

    // 🏗️ Internal UI Logic
    const createUI = (monitor: Gdk.Monitor, idx: number) => {
      console.log(`[UI] Monitor ${idx}`);
      try {
        const barWin = Bar(monitor)
        const dockWin = Dock(monitor)
        windows.add(barWin); windows.add(dockWin)

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          const gridWin = AppGrid(monitor)
          const notifWin = NotificationPopups(monitor)
          const ccWin = ControlCenter(monitor)
          const ncWin = NotificationCenter(monitor)

          windows.add(gridWin); windows.add(notifWin)
          windows.add(ccWin); windows.add(ncWin)

          appGrids.push(gridWin)
          controlCenters.push(ccWin)
          notificationCenters.push(ncWin)
          return GLib.SOURCE_REMOVE
        })
      } catch (e) { console.error(`[UI] Error:`, e) }
    }

    const display = Gdk.Display.get_default()
    if (display) {
      const monitors = display.get_monitors()
      for (let i = 0; i < monitors.get_n_items(); i++) {
        if (i === 0) createUI(monitors.get_item(i) as Gdk.Monitor, i)
        else GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 200, () => {
          createUI(monitors.get_item(i) as Gdk.Monitor, i)
          return GLib.SOURCE_REMOVE
        })
      }
    }

    // 🕹️ Toggles Logic
    const toggleAppGrid = () => appGrids.forEach(g => g.toggle())
    const toggleCC = () => {
      notificationCenters.forEach(nc => nc.set_visible(false))
      controlCenters.forEach(cc => cc.toggle())
    }
    const toggleNC = () => {
      controlCenters.forEach(cc => cc.set_visible(false))
      notificationCenters.forEach(nc => nc.toggle())
    }

    // Expose Globals
    (globalThis as any).toggleAppGrid = toggleAppGrid;
    (globalThis as any).toggleControlCenter = toggleCC;
    (globalThis as any).toggleNotificationCenter = toggleNC;

    // Local request mapper
    (app as any).DistroIA = { toggleAppGrid, toggleCC, toggleNC }
  },
  requestHandler(argv, res) {
    const engine = (app as any).DistroIA
    if (!engine) return res("error: engine not ready")

    if (argv[0] === "toggleAppGrid()") { engine.toggleAppGrid(); res("ok") }
    else if (argv[0] === "toggleControlCenter()") { engine.toggleCC(); res("ok") }
    else if (argv[0] === "toggleNotificationCenter()") { engine.toggleNC(); res("ok") }
    else res("unknown command")
  }
})

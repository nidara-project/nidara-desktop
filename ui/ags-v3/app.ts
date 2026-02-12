import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
// @ts-ignore
import type { Monitor } from "gi://Gdk?version=4.0"
// @ts-ignore
import type { Window } from "gi://Gtk?version=4.0"

// Widget Imports
import Dock from "./widget/Dock"
import AppGrid from "./widget/AppGrid"
import Bar from "./widget/Bar"
import NotificationPopups from "./widget/NotificationPopups"
import ControlCenter from "./widget/ControlCenter"
import PowerMenu from "./widget/PowerMenu"

console.log("[DISTROIA] app.ts loading... (Phase 65: Mega-Main Stability)");

app.start({
  main() {
    console.log("[DISTROIA] main() started!");

    // Force Dark Theme for GTK4
    const settings = Gtk.Settings.get_default()
    if (settings) {
      settings.gtk_application_prefer_dark_theme = true
    }

    const windows = new Set<any>()
    const gridWindows: any[] = []
    const ccWindows: any[] = []
    const powerWindows: any[] = []

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
      if (GLib.file_test(styleFile, GLib.FileTest.EXISTS)) {
        mainProvider.load_from_path(styleFile)
        console.log(`[Style] Loaded: ${styleFile}`)
      } else {
        console.error(`[Style] NOT FOUND: ${styleFile}`)
      }

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
    const createUI = (monitor: any, idx: number) => {
      console.log(`[UI] Monitor ${idx}`);
      try {
        const barWin = Bar(monitor)
        const dockWin = Dock(monitor)
        windows.add(barWin); windows.add(dockWin)

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          const gridWin = AppGrid(monitor)
          const notifWin = NotificationPopups(monitor)
          const ccWin = ControlCenter(monitor)
          const powerWin = PowerMenu(monitor)

          windows.add(gridWin); windows.add(notifWin)
          windows.add(ccWin); windows.add(powerWin)

          gridWindows.push(gridWin)
          ccWindows.push(ccWin)
          powerWindows.push(powerWin)
          return GLib.SOURCE_REMOVE
        })
      } catch (e) { console.error(`[UI] Error:`, e) }
    }

    const display = Gdk.Display.get_default()
    if (display) {
      const monitors: any = display.get_monitors()
      for (let i = 0; i < monitors.get_n_items(); i++) {
        if (i === 0) createUI(monitors.get_item(i) as any, i)
        else GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 200, () => {
          createUI(monitors.get_item(i) as any, i)
          return GLib.SOURCE_REMOVE
        })
      }
    }

    // 🕹️ Toggles Logic
    const toggleAppGrid = () => {
      console.log(`[Toggle] AppGrid (Count: ${gridWindows.length})`)
      gridWindows.forEach(g => { try { g.toggle() } catch (e) { console.error(e) } })
    }
    const toggleCC = () => {
      console.log(`[Toggle] CC (Count: ${ccWindows.length})`)
      ccWindows.forEach(cc => { try { cc.toggle() } catch (e) { console.error(e) } })
    }
    const togglePower = () => {
      console.log(`[Toggle] Power (Count: ${powerWindows.length})`)
      powerWindows.forEach(p => { try { p.toggle() } catch (e) { console.error(e) } })
    }

    // Expose Globals
    (globalThis as any).toggleAppGrid = toggleAppGrid;
    (globalThis as any).toggleControlCenter = toggleCC;
    (globalThis as any).toggleNotificationCenter = toggleCC; // Redirect for safety
    (globalThis as any).togglePowerMenu = togglePower;

    // Local request mapper
    (app as any).DistroIA = { toggleAppGrid, toggleCC, toggleNC: toggleCC, togglePower }
  },
  requestHandler(argv, res) {
    const engine = (app as any).DistroIA
    if (!engine) return res("error: engine not ready")

    if (argv[0] === "toggleAppGrid()") { engine.toggleAppGrid(); res("ok") }
    else if (argv[0] === "toggleControlCenter()") { engine.toggleCC(); res("ok") }
    else if (argv[0] === "toggleNotificationCenter()") { engine.toggleNC(); res("ok") }
    else if (argv[0] === "togglePowerMenu()") { engine.togglePower(); res("ok") }
    else res("unknown command")
  }
})

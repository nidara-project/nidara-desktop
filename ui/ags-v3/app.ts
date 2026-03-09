import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { readFile } from "ags/file"

// @ts-ignore
import type { Monitor } from "gi://Gdk?version=4.0"
// @ts-ignore
import type { Window } from "gi://Gtk?version=4.0"

/**
 * 🛠️ THEME STRATEGY: 
 * We use Libadwaita exclusively for modern theme management. 
 * We explicitly disable the legacy GtkSettings property before Adw.init() 
 * to ensure Libadwaita takes full control and silences the deprecation warning.
 */
try {
  // No envenenamos el entorno por defecto.
  GLib.unsetenv("GTK_THEME")

  Adw.init()
  // No forzamos esquema de color. Dejamos que Libadwaita intente seguir el tema.
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.DEFAULT)
} catch (e) {
  console.warn("[App] Initialization failed:", e)
}

// Widget Imports (AFTER Adw init to prevent premature StyleManager access)
import Dock from "./widget/dock/Dock"
import { syncConstants } from "./widget/dock/DockPhysics"
import { onDockSettingsChanged } from "./widget/dock/state"
import AppGrid from "./widget/app-grid/AppGrid"
import Bar from "./widget/bar/Bar"
import NotificationPopups from "./widget/control-center/NotificationPopups"
import ControlCenter from "./widget/control-center/ControlCenter"
import NotificationCenter from "./widget/control-center/NotificationCenter"
import PowerMenu from "./widget/power-menu/PowerMenu"
import Settings from "./widget/settings/Settings"
import Theme from "./core/ThemeManager"

console.log("[DISTROIA] Calling app.start()...");
app.start({
  applicationId: "com.distroia.crystal",
  setup: () => {
    // Already initialized at top level for ultra-early sync
  },
  main() {
    const randomId = Math.floor(Math.random() * 10000);
    console.log(`[DISTROIA] main() started! (ID: ${randomId})`);


    const windows = new Set<any>()
    const gridWindows: any[] = []
    const ccWindows: any[] = []
    const notifCenterWindows: any[] = []
    const powerWindows: any[] = []
    const settingsWindows: any[] = []

    // 🎨 ABSOLUTE Style Sync: Points to the project config directory
    // V132: Robust path detection to avoid 'undefined/style.css'
    const styleFile = `/home/angel/Dev/Distroia/ui/ags-v3/style.css`
    const mainProvider = new Gtk.CssProvider()
    const themeProvider = new Gtk.CssProvider()

    // V145: THE "GENEVA CONVENTION" FIX REFINED 🕊️
    // We restore global display providers for AGS internal styles.
    // This is safe because our CSS is ID-scoped (#crystal-bar, etc.).

    const defaultDisplay = Gdk.Display.get_default()

    const syncTheme = () => {
      try {
        const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
        const fontName = settings.get_string("font-name")
        const [family, size] = fontName.match(/^(.*?) (\d+)$/)?.slice(1) || ["sans-serif", "11"]

        const configuredTheme = settings.get_string("icon-theme")
        const themeCss = `* { font-family: "${family}", "Symbols Nerd Font", sans-serif; }`

        // 🛡️ Flicker Guard: Skip if font hasn't changed
        if ((app as any)._lastFont === fontName) return
        (app as any)._lastFont = fontName;

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
        Gtk.StyleContext.add_provider_for_display(defaultDisplay, themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
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

        // Dock rebuild on settings change (debounced)
        let rebuildTimer: number | null = null
        onDockSettingsChanged(() => {
          if (rebuildTimer) GLib.source_remove(rebuildTimer)
          rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            rebuildTimer = null
            try {
              syncConstants()
              // Find and destroy old dock window
              windows.forEach(w => {
                if ((w as any).name === "crystal-dock") {
                  windows.delete(w)
                    ; (w as any).close()
                }
              })
              // Create new dock with updated constants
              const newDock = Dock(monitor)
              windows.add(newDock)
              console.log("[DockSettings] Dock rebuilt with new settings")
            } catch (e) {
              console.error("[DockSettings] Dock rebuild failed:", e)
            }
            return GLib.SOURCE_REMOVE
          })
        })

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          const initWin = (ctor: any, array: any[]) => {
            try {
              const win = ctor(monitor)
              windows.add(win)
              if (array) array.push(win)
            } catch (err) {
              console.error(`[UI] Failed to init ${ctor.name} on monitor ${idx}:`, err)
            }
          }

          initWin(AppGrid, gridWindows)
          initWin(NotificationPopups, [])
          initWin(ControlCenter, ccWindows)
          initWin(NotificationCenter, notifCenterWindows)
          initWin(PowerMenu, powerWindows)
          initWin(Settings, settingsWindows)

          return GLib.SOURCE_REMOVE
        })
      } catch (e) { console.error(`[UI] Error:`, e) }
    }

    // V127: Native Gtk Resolution
    try {
      const display = Gdk.Display.get_default()
      // @ts-ignore
      print("Display found: " + !!display)
      if (display) {
        const monitors: any = display.get_monitors()
        // @ts-ignore
        print("Monitor count: " + monitors.get_n_items())
        for (let i = 0; i < monitors.get_n_items(); i++) {
          createUI(monitors.get_item(i) as any, i)
        }
      }
    } catch (e) { console.error(`[UI] Error:`, e) }


    // 🕹️ Toggles Logic
    const toggleAppGrid = () => {
      console.log(`[Toggle] AppGrid (Count: ${gridWindows.length})`)
      gridWindows.forEach(g => { try { g.toggle() } catch (e) { console.error(e) } })
    }
    const toggleCC = () => {
      console.log(`[Toggle] CC (Count: ${ccWindows.length})`)
      ccWindows.forEach(cc => { try { cc.toggle() } catch (e) { console.error(e) } })
    }
    const toggleNC = () => {
      console.log(`[Toggle] NC (Count: ${notifCenterWindows.length})`)
      notifCenterWindows.forEach(nc => { try { nc.toggle() } catch (e) { console.error(e) } })
    }
    const togglePower = () => {
      console.log(`[Toggle] Power (Count: ${powerWindows.length})`)
      powerWindows.forEach(p => { try { p.toggle() } catch (e) { console.error(e) } })
    }
    const toggleSettings = () => {
      console.log(`[Toggle] Settings (Count: ${settingsWindows.length})`)
      settingsWindows.forEach(s => { try { s.toggle() } catch (e) { console.error(e) } })
    }
    const toggleSpotlight = () => {
      console.log("[Toggle] Spotlight")
      GLib.spawn_command_line_async("hyprlauncher")
    }

    // Expose Globals
    (globalThis as any).toggleAppGrid = toggleAppGrid;
    (globalThis as any).toggleControlCenter = toggleCC;
    (globalThis as any).toggleNotificationCenter = toggleNC;
    (globalThis as any).togglePowerMenu = togglePower;
    (globalThis as any).toggleSettings = toggleSettings;
    (globalThis as any).toggleSpotlight = toggleSpotlight;

    // Local request mapper
    (app as any).DistroIA = { toggleAppGrid, toggleCC, toggleControlCenter: toggleCC, toggleNC, togglePower, toggleSettings, toggleSpotlight }
  },
  requestHandler(argv, res) {
    const engine = (app as any).DistroIA
    if (!engine) return res("error: engine not ready")

    if (!argv || argv.length === 0) return res("ok")
    if (argv[0] === "toggleAppGrid()") { engine.toggleAppGrid(); res("ok") }
    else if (argv[0] === "toggleCC()") { engine.toggleCC(); res("ok") }
    else if (argv[0] === "toggleControlCenter()") { engine.toggleCC(); res("ok") }
    else if (argv[0] === "toggleNotificationCenter()") { engine.toggleNC(); res("ok") }
    else if (argv[0] === "togglePowerMenu()") { engine.togglePower(); res("ok") }
    else if (argv[0] === "toggleSettings()") { engine.toggleSettings(); res("ok") }
    else if (argv[0] === "toggleSpotlight()") { engine.toggleSpotlight(); res("ok") }
    else {
      console.warn(`[Handler] Unknown command: ${argv[0]}`)
      res("unknown command")
    }
  }
})

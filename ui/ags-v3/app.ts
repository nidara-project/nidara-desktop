import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status from "./core/Status"
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
 */
try {
  GLib.unsetenv("GTK_THEME")
  Adw.init()
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.DEFAULT)
} catch (e) {
  console.warn("[App] Initialization failed:", e)
}

// Widget Imports
import Dock from "./widget/dock/Dock"
import { syncConstants } from "./widget/dock/DockPhysics"
import { onDockSettingsChanged } from "./widget/dock/state"
import AppGrid from "./widget/app-grid/AppGrid"
import Bar from "./widget/bar/Bar"
import Overlays from "./widget/bar/Overlays"
import NotificationPopups from "./widget/control-center/NotificationPopups"
import PowerMenu from "./widget/power-menu/PowerMenu"
import Settings from "./widget/settings/Settings"
import PrismLab from "./widget/lab/PrismLab"
import Theme from "./core/ThemeManager"

console.log("[DISTROIA] Calling app.start()...");

app.start({
  applicationId: "com.distroia.crystal",
  main() {
    const randomId = Math.floor(Math.random() * 10000);
    console.log(`[DISTROIA] main() started! (ID: ${randomId})`);

    const windows = new Set<any>()
    const appLauncherWindows: any[] = []
    const powerWindows: any[] = []
    const settingsWindows: any[] = []
    const labWindows: any[] = []

    const createUI = (monitor: Gdk.Monitor, idx: number) => {
      try {
        const barWin = Bar(monitor)
        const dockWin = Dock(monitor)
        const overlays = Overlays(monitor, idx)
        const notifPopups = NotificationPopups(monitor)

        windows.add(barWin); 
        windows.add(dockWin);
        windows.add(notifPopups);
        overlays.forEach(w => windows.add(w))

        // Dock rebuild on settings change
        let rebuildTimer: number | null = null
        onDockSettingsChanged(() => {
          if (rebuildTimer) GLib.source_remove(rebuildTimer)
          rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            rebuildTimer = null
            try {
              syncConstants()
              windows.forEach(w => {
                if ((w as any).name === "crystal-dock") {
                  windows.delete(w)
                  ; (w as any).close()
                }
              })
              const newDock = Dock(monitor)
              windows.add(newDock)
            } catch (e) { console.error("[DockSettings] Dock rebuild failed:", e) }
            return GLib.SOURCE_REMOVE
          })
        })

        const initWin = (ctor: any, array: any[]) => {
          try {
            const win = ctor(monitor)
            windows.add(win)
            if (array) array.push(win)
          } catch (err) { console.error(`[UI] Failed to init ${ctor.name}:`, err) }
        }

        initWin(PowerMenu, powerWindows)
        initWin(Settings, settingsWindows)
        initWin(PrismLab, labWindows)
        initWin(AppGrid, appLauncherWindows)

      } catch (e) { console.error(`[UI] Error:`, e) }
    }

    try {
      const display = Gdk.Display.get_default()
      if (display) {
        const monitors: any = display.get_monitors()
        const n = monitors.get_n_items()
        for (let i = 0; i < n; i++) {
          createUI(monitors.get_item(i) as any, i)
        }
      }
    } catch (e) { console.error(`[UI] Error:`, e) }

    // 🕹️ Toggles Logic
    const toggleAppGrid = () => {
      appLauncherWindows.forEach(g => { try { g.toggle() } catch (e) { console.error(e) } })
    }
    const togglePower = () => {
      powerWindows.forEach(p => { try { p.toggle() } catch (e) { console.error(e) } })
    }
    const toggleSettings = () => {
      settingsWindows.forEach(s => { try { s.toggle() } catch (e) { console.error(e) } })
    }
    const togglePrismLab = () => {
      labWindows.forEach(l => { try { l.toggle() } catch (e) { console.error(e) } })
    }

    // Expose Globals
    (globalThis as any).toggleAppGrid = toggleAppGrid;
    (globalThis as any).togglePowerMenu = togglePower;
    (globalThis as any).toggleSettings = toggleSettings;
    (globalThis as any).togglePrismLab = togglePrismLab;

  },
  requestHandler(argv, res) {
    if (!argv || argv.length === 0) return res("ok")
    const cmd = argv[0].replace("()", "")
    
    switch (cmd) {
      case "toggleCC":
      case "toggleControlCenter":
        status.toggleCC(); break;
      case "toggleNC":
      case "toggleNotificationCenter":
        status.toggleNC(); break;
      case "togglePrism":
      case "toggleSpotlight":
        status.togglePrism(); break;
      case "toggleAppGrid":
        (globalThis as any).toggleAppGrid?.(); break;
      case "togglePowerMenu":
        (globalThis as any).togglePowerMenu?.(); break;
      case "toggleSettings":
        (globalThis as any).toggleSettings?.(); break;
      case "togglePrismLab":
        (globalThis as any).togglePrismLab?.(); break;
      default:
        console.warn(`[Handler] Unknown command: ${cmd}`)
        return res("unknown command")
    }
    res("ok")
  }
})

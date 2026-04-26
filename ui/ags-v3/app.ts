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
 *  THEME STRATEGY:
 * We use Libadwaita exclusively for modern theme management.
 */
try {
  GLib.unsetenv("GTK_THEME")
  Adw.init()
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.PREFER_DARK)
} catch (e) {
  console.warn("[App] Initialization failed:", e)
}

// Register custom crystal-shell icon theme (cs-xxx-symbolic icons)
try {
  const display = Gdk.Display.get_default()
  if (display) {
    const iconsPath = `${GLib.get_current_dir()}/assets/icons`
    Gtk.IconTheme.get_for_display(display).add_search_path(iconsPath)
  }
} catch (e) {
  console.warn("[Icons] Failed to register icon search path:", e)
}

// Widget Imports
import Dock from "./widget/dock/Dock"
import { syncConstants } from "./widget/dock/DockPhysics"
import { onDockSettingsChanged, onPinnedChanged } from "./widget/dock/state"
import AppGrid from "./widget/app-grid/AppGrid"
import Bar from "./widget/bar/Bar"
import Settings from "./widget/settings/Settings"
import Theme from "./core/ThemeManager"
import AboutWindow from "./widget/about/AboutWindow"
import notifConfig from "./core/NotifConfig"

console.log("[CRYSTAL_SHELL] Calling app.start()...");

app.start({
  applicationId: "com.crystalshell.fluid",
    main() {
    const randomId = Math.floor(Math.random() * 10000);
    console.log(`[CRYSTAL_SHELL] main() started! (ID: ${randomId})`);

    // Apply notification DND default
    if (notifConfig.dndDefault) {
        import("gi://AstalNotifd").then(({ default: AstalNotifd }) => {
            const notifd = AstalNotifd.get_default()
            if (notifd) notifd.dont_disturb = true
        }).catch(() => {})
    }

    //  STABILIZATION: Set Hyprland rules
    import("ags/process").then(({ execAsync }) => {
        execAsync("hyprctl keyword layerrule 'blur, crystal-bar'").catch(() => {})
        execAsync("hyprctl keyword layerrule 'ignorealpha 0.5, crystal-bar'").catch(() => {})
        execAsync("hyprctl keyword layerrule 'blur, crystal-launcher'").catch(() => {})
        execAsync("hyprctl keyword layerrule 'ignorealpha 0.3, crystal-launcher'").catch(() => {})
    }).catch(() => {})

    const windows = new Set<any>()
    const appLauncherWindows: any[] = []
    const settingsWindows: any[] = []

    const initWinGlobal = (ctor: any, mon: Gdk.Monitor, array: any[]) => {
      try {
        const win = ctor(mon)
        windows.add(win)
        if (array) array.push(win)
      } catch (err) { console.error(`[UI] Failed to init ${ctor.name}:`, err) }
    }

    const createUI = (monitor: Gdk.Monitor, idx: number) => {
      try {
        const barWin = Bar(monitor)
        const dockWin = Dock(monitor)
        
        windows.add(barWin); 
        windows.add(dockWin);

        // Dock rebuild on settings or pinned list change
        let rebuildTimer: number | null = null
        const scheduleDockRebuild = () => {
          if (rebuildTimer) GLib.source_remove(rebuildTimer)
          rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            rebuildTimer = null
            try {
              syncConstants()
              windows.forEach(w => {
                if (w.name === "crystal-dock" && (w as any).gdkmonitor === monitor) {
                  windows.delete(w)
                  ; (w as any).close()
                }
              })
              const newDock = Dock(monitor)
              windows.add(newDock)
            } catch (e) { console.error("[DockRebuild] Dock rebuild failed:", e) }
            return GLib.SOURCE_REMOVE
          })
        }
        onDockSettingsChanged(scheduleDockRebuild)
        onPinnedChanged(scheduleDockRebuild)

        // Settings deferred to toggleSettings (Lazy)
        initWinGlobal(AppGrid, monitor, appLauncherWindows)

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

    //  Toggles Logic
    const toggleAppGrid = () => {
      appLauncherWindows.forEach(g => { try { g.toggle() } catch (e) { console.error(e) } })
    }
    const toggleSettings = () => {
      // Lazy init on first open
      if (settingsWindows.length === 0) {
        const display = Gdk.Display.get_default()
        if (display) {
          const monitors: any = display.get_monitors()
          for (let i = 0; i < monitors.get_n_items(); i++) {
            initWinGlobal(Settings, monitors.get_item(i), settingsWindows)
          }
        }
      }
      // present() = show + focus, like a normal app window
      settingsWindows.forEach(s => {
          try { s.present() } catch (e) { console.error(e) }
      })
    }
    const toggleOverview = () => {
      status.toggleOverview()
    }
    // About window — lazy, created only when first toggled, destroyed on close
    status.connect("notify::about-open", () => {
      if (status.about_open) try { AboutWindow() } catch (e) { console.error("[About] failed:", e) }
    })
    const lockScreen = () => {
      windows.forEach(w => {
        if (w.name === "crystal-bar" || w.name === "crystal-dock") {
          try { w.hide() } catch (e) {}
        }
      })
    }
    const unlockScreen = () => {
      windows.forEach(w => {
        if (w.name === "crystal-bar" || w.name === "crystal-dock") {
          try { w.present() } catch (e) {}
        }
      })
    }

    // Expose Globals
    ;(globalThis as any).toggleAppGrid = toggleAppGrid;
    (globalThis as any).toggleSettings = toggleSettings;
    (globalThis as any).toggleOverview = toggleOverview;
    (globalThis as any).lockScreen = lockScreen;
    (globalThis as any).unlockScreen = unlockScreen;

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
      case "toggleSettings":
        (globalThis as any).toggleSettings?.(); break;
      case "toggleOverview":
        (globalThis as any).toggleOverview?.(); break;
      case "hideForLock":
        (globalThis as any).lockScreen?.(); break;
      case "showAfterLock":
        (globalThis as any).unlockScreen?.(); break;
      default:
        console.warn(`[Handler] Unknown command: ${cmd}`)
        return res("unknown command")
    }
    res("ok")
  }
})

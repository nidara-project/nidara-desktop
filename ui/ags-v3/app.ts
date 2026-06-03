// MUST be first: captures the asset root and moves the process CWD to $HOME
// before anything else can spawn a child or read the CWD.
import { SHELL_ROOT } from "./core/Paths"
import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status from "./core/Status"
import shellActions from "./core/ShellActions"
import { readFile } from "ags/file"

// @ts-ignore
import type { Monitor } from "gi://Gdk?version=4.0"
// @ts-ignore
import type { Window } from "gi://Gtk?version=4.0"

/**
 *  THEME STRATEGY:
 * Pure GTK4 dark/light coordination via Gtk.Settings — no libadwaita.
 * ThemeManager applies the persisted dark/light state right after boot;
 * this just seeds the startup default.
 */
try {
  GLib.unsetenv("GTK_THEME")
  const gtkSettings = Gtk.Settings.get_default()
  if (gtkSettings) gtkSettings.gtk_application_prefer_dark_theme = true
} catch (e) {
  console.warn("[App] Initialization failed:", e)
}

// Register custom crystal-shell icon theme (cs-xxx-symbolic icons)
try {
  const display = Gdk.Display.get_default()
  if (display) {
    const candidates = [
      `${GLib.get_user_config_dir()}/crystal-shell/ui/ags-v3/assets/icons`,
      `${SHELL_ROOT}/assets/icons`,
    ]
    const theme = Gtk.IconTheme.get_for_display(display)
    for (const p of candidates) {
      if (GLib.file_test(p, GLib.FileTest.IS_DIR)) { theme.add_search_path(p); break }
    }
  }
} catch (e) {
  console.warn("[Icons] Failed to register icon search path:", e)
}

// Widget Imports
import Dock from "./widget/dock/Dock"
import { syncConstants } from "./widget/dock/DockPhysics"
import { onDockSettingsChanged, dockSettings } from "./widget/dock/state"
import Bar from "./widget/bar/Bar"
import Settings from "./widget/settings/Settings"
import Theme from "./core/ThemeManager"
import AboutWindow from "./widget/about/AboutWindow"
import notifConfig from "./core/NotifConfig"
import { installPowerHooks } from "./core/PowerManager"

// Minimal interface for windows managed by the shell
interface ShellWindow {
  name: string
  gdkmonitor?: Gdk.Monitor
  close(): void
  hide(): void
  present(): void
  toggle?(): void
}

// Module-level IPC registry — populated by main(), read by requestHandler.
// requestHandler and main() share this object directly (no globalThis needed for IPC).
// Widget code (Dock, Bar, AppGrid) uses core/ShellActions — a shared typed registry
// populated here after main() runs, avoiding circular imports with app.ts.
const ipc: Record<string, (() => void) | undefined> = {}

app.start({
  applicationId: "com.crystalshell.fluid",
    main() {
    // Apply notification DND default
    if (notifConfig.dndDefault) {
        import("gi://AstalNotifd").then(({ default: AstalNotifd }) => {
            const notifd = AstalNotifd.get_default()
            if (notifd) notifd.dont_disturb = true
        }).catch(() => {})
    }

    installPowerHooks()

    //  STABILIZATION: Set Hyprland rules
    import("ags/process").then(({ execAsync }) => {
        execAsync("hyprctl keyword layerrule 'blur, crystal-bar'").catch(() => {})
        execAsync("hyprctl keyword layerrule 'ignorealpha 0.5, crystal-bar'").catch(() => {})
    }).catch(() => {})

    const windows = new Set<ShellWindow>()
    const settingsWindows: ShellWindow[] = []

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
              // Collect old dock windows BEFORE creating the new one.
              const oldDocks: any[] = []
              windows.forEach(w => {
                if (w.name === "crystal-dock" && (w as any).gdkmonitor === monitor) {
                  oldDocks.push(w)
                }
              })
              // Create new dock first so its exclusive zone is established before
              // the old window closes — prevents the gap where Hyprland briefly
              // sees no exclusive zone and expands windows into the dock area.
              const newDock = Dock(monitor)
              windows.add(newDock)
              // Now it is safe to close the old dock.
              for (const w of oldDocks) {
                windows.delete(w)
                w.close()
              }
            } catch (e) { console.error("[DockRebuild] Dock rebuild failed:", e) }
            return GLib.SOURCE_REMOVE
          })
        }
        // Only rebuild when layer-shell anchors/mode actually change.
        // All other settings (iconSize, screenGap, magnification, etc.) are applied
        // in-place by Dock.tsx's internal onDockSettingsChanged listener.
        let _prevPos = dockSettings.position
        let _prevAutoHide = dockSettings.autoHide
        onDockSettingsChanged((s) => {
          if (s.position !== _prevPos || s.autoHide !== _prevAutoHide) {
            _prevPos = s.position
            _prevAutoHide = s.autoHide
            scheduleDockRebuild()
          }
        })

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
      windows.forEach(w => {
        if (w.name === "crystal-dock") try { (w as any).toggleAppGridPanel?.() } catch (e) { console.error(e) }
      })
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
    const toggleGameOverlay = () => {
      // Only promotes bar — dock and appgrid are unaffected.
      // Activation requires a fullscreen window; deactivation is always allowed.
      windows.forEach(w => {
        if (w.name === "crystal-bar") {
          const isActive = (w as any).isGameOverlayActive?.() ?? false
          const isFullscreen = (w as any).isBarFullscreenMode?.() ?? false
          if (!isActive && !isFullscreen) return
          ;(w as any).setGameOverlayMode?.(!isActive)
        }
      })
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

    // Register IPC handlers (used by requestHandler)
    ipc.toggleAppGrid = toggleAppGrid
    ipc.toggleSettings = toggleSettings
    ipc.toggleOverview = toggleOverview
    ipc.toggleGameOverlay = toggleGameOverlay
    ipc.lockScreen = lockScreen
    ipc.unlockScreen = unlockScreen

    // Typed shared registry used by Dock, DockItem, Bar, AppGrid widgets
    shellActions.toggleAppGrid = toggleAppGrid
    shellActions.toggleSettings = toggleSettings
    shellActions.toggleOverview = toggleOverview
    shellActions.toggleGameOverlay = toggleGameOverlay
    shellActions.lockScreen = lockScreen
    shellActions.unlockScreen = unlockScreen

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
        ipc.toggleAppGrid?.(); break;
      case "toggleSettings":
        ipc.toggleSettings?.(); break;
      case "toggleOverview":
        ipc.toggleOverview?.(); break;
      case "toggleGameOverlay":
        ipc.toggleGameOverlay?.(); break;
      case "hideForLock":
        ipc.lockScreen?.(); break;
      case "showAfterLock":
        ipc.unlockScreen?.(); break;
      default:
        console.warn(`[Handler] Unknown command: ${cmd}`)
        return res("unknown command")
    }
    res("ok")
  }
})

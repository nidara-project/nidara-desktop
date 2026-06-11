// MUST be first: captures the asset root and moves the process CWD to $HOME
// before anything else can spawn a child or read the CWD.
import { SHELL_ROOT, readShellVersion } from "./core/Paths"
import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status from "./core/Status"
import shellActions from "./core/ShellActions"
import { currentLocale } from "./core/i18n"
import { readFile } from "ags/file"
import { exec } from "ags/process"
import agentConfig from "./core/AgentConfig"
import { describeConfig, getConfigValue, getAllConfigValues, setConfigValue } from "./core/ConfigRegistry"
import { registerConfigEntries } from "./config-entries"
import hyprlandState from "./core/HyprlandState"

// @ts-ignore
import type { Monitor } from "gi://Gdk?version=4.0"
// @ts-ignore
import type { Window } from "gi://Gtk?version=4.0"

/**
 *  THEME STRATEGY:
 * The shell uses no Adwaita widgets, but AGS's runtime calls Adw.init() when
 * libadwaita exists on the system — so dark/light goes through setPreferDark
 * (AdwStyleManager if initialized, plain Gtk.Settings otherwise).
 * ThemeManager applies the persisted dark/light state right after boot;
 * this just seeds the startup default.
 */
try {
  GLib.unsetenv("GTK_THEME")
  void setPreferDark(true)
} catch (e) {
  console.warn("[App] Initialization failed:", e)
}

// Register custom crystal-shell icon theme (cs-xxx-symbolic icons)
try {
  const display = Gdk.Display.get_default()
  if (display) {
    const iconsPath = `${SHELL_ROOT}/assets/icons`
    const theme = Gtk.IconTheme.get_for_display(display)
    if (GLib.file_test(iconsPath, GLib.FileTest.IS_DIR)) theme.add_search_path(iconsPath)
  }
} catch (e) {
  console.warn("[Icons] Failed to register icon search path:", e)
}

// Widget Imports
import Dock from "./surfaces/dock/Dock"
import { syncConstants } from "./surfaces/dock/DockPhysics"
import { onDockSettingsChanged, dockSettings } from "./surfaces/dock/state"
import Bar from "./surfaces/bar/Bar"
import Settings from "./surfaces/settings/Settings"
import Theme, { setPreferDark } from "./core/ThemeManager"
import AboutWindow from "./surfaces/about/AboutWindow"
import notifConfig from "./core/NotifConfig"

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
const ipc: Record<string, ((...args: string[]) => string | void) | undefined> = {}

// Declarative IPC surface — the single source of truth for `ags request`.
// `listActions` introspects this table, so adding a command here is ALL it takes
// for scripts and agents to discover it; never grow a parallel switch elsewhere.
// Commands that need main()-time closures (windows, monitors) go through `ipc`.
interface IpcCommand {
  desc: string
  aliases?: string[]
  run: (args: string[]) => string | void
}

const IPC_COMMANDS: Record<string, IpcCommand> = {
  toggleCC: {
    desc: "Toggle the Control Center overlay",
    aliases: ["toggleControlCenter"],
    run: () => status.toggleCC(),
  },
  toggleNC: {
    desc: "Toggle the Notification Center overlay",
    aliases: ["toggleNotificationCenter"],
    run: () => status.toggleNC(),
  },
  togglePrism: {
    desc: "Toggle Prism (spotlight-style search)",
    aliases: ["toggleSpotlight"],
    run: () => status.togglePrism(),
  },
  toggleAppGrid: { desc: "Toggle the fullscreen app grid", run: () => ipc.toggleAppGrid?.() },
  toggleSettings: { desc: "Show/hide the Settings window", run: () => ipc.toggleSettings?.() },
  settingsPage: {
    desc: "Open the Settings window on a specific page (e.g. `settingsPage bluetooth`)",
    run: args => ipc.openSettingsPage?.(args[0] ?? ""),
  },
  toggleOverview: { desc: "Toggle the workspaces overview", run: () => ipc.toggleOverview?.() },
  toggleGameOverlay: {
    desc: "Toggle game mode (bar promoted above fullscreen surfaces)",
    run: () => ipc.toggleGameOverlay?.(),
  },
  hideForLock: { desc: "Hide bar+dock while the lockscreen is up", run: () => ipc.lockScreen?.() },
  showAfterLock: { desc: "Restore bar+dock after unlock", run: () => ipc.unlockScreen?.() },
  describeConfig: {
    desc: "Describe every agent-facing setting as JSON: type, constraints, current value, writability",
    run: () => JSON.stringify(describeConfig(), null, 2),
  },
  getConfig: {
    desc: "Read a setting (`getConfig dock.iconSize`) or all of them (`getConfig`) as JSON",
    run: args => {
      if (!args[0]) return JSON.stringify(getAllConfigValues(), null, 2)
      const r = getConfigValue(args[0])
      return r.ok ? JSON.stringify({ key: args[0], value: r.value }) : r.error ?? "error"
    },
  },
  setConfig: {
    desc: "Change a setting (`setConfig appearance.accent blue`) — validated against describeConfig; gated by Settings → AI",
    run: args => {
      if (!args[0] || args[1] === undefined) return "usage: setConfig <key> <value>"
      if (!agentConfig.allowConfigWrite)
        return "config writes are disabled — enable them in Settings → AI (or ai.json)"
      return setConfigValue(args[0], args.slice(1).join(" "))
    },
  },
  screenshot: {
    desc: "Capture the focused monitor to a PNG and return its path (`screenshot [path]`) — agent visual verification; gated by Settings → AI",
    run: args => {
      if (!agentConfig.allowScreenshot)
        return "screenshots are disabled — enable them in Settings → AI (or ai.json)"
      const path = args[0] || `/tmp/crystal-shell-shot-${Date.now()}.png`
      try {
        const mon = hyprlandState.focusedMonitor?.name
        exec(mon ? ["grim", "-o", mon, path] : ["grim", path])
        return path
      } catch (e) {
        console.error("[IPC] screenshot failed:", e)
        return `screenshot failed: ${e}`
      }
    },
  },
  listActions: {
    desc: "Describe every IPC command as JSON (machine-readable: this output)",
    run: () => {
      const out: Record<string, { desc: string; aliases?: string[] }> = {}
      for (const [name, { desc, aliases }] of Object.entries(IPC_COMMANDS))
        out[name] = aliases ? { desc, aliases } : { desc }
      return JSON.stringify(out, null, 2)
    },
  },
  dumpState: {
    desc: "Dump live shell state as JSON (version, theme, locale, overlays, effective Hyprland config)",
    run: () => {
      const display = Gdk.Display.get_default()
      return JSON.stringify(
        {
          shell: {
            version: readShellVersion(),
            locale: currentLocale(),
            darkMode: Theme.isDark,
            monitors: display ? display.get_monitors().get_n_items() : 0,
          },
          // EFFECTIVE compositor config (includes hyprland-user.lua overrides) —
          // what the system actually runs, not our shipped defaults.
          hyprland: {
            gapsIn: hyprlandState.getOptionInt("general:gaps_in"),
            gapsOut: hyprlandState.getOptionInt("general:gaps_out"),
            rounding: hyprlandState.getOptionInt("decoration:rounding"),
            borderSize: hyprlandState.getOptionInt("general:border_size"),
          },
          ai: {
            allowConfigWrite: agentConfig.allowConfigWrite,
            allowScreenshot: agentConfig.allowScreenshot,
            allowMcp: agentConfig.allowMcp,
          },
          overlays: {
            controlCenter: status.cc_open,
            notificationCenter: status.nc_open,
            prism: status.prism_open,
            systemMenu: status.system_menu_open,
            overview: status.overview_open,
            settings: status.settings_open,
            about: status.about_open,
          },
          flags: {
            ccEditMode: status.cc_edit_mode,
            recording: status.recording,
            barExpandedId: status.bar_expanded_id,
            ccDetailId: status.cc_detail_id,
          },
        },
        null,
        2,
      )
    },
  },
}

// alias → canonical command name, derived once from the table above.
const IPC_ALIASES: Record<string, string> = {}
for (const [name, { aliases }] of Object.entries(IPC_COMMANDS))
  for (const alias of aliases ?? []) IPC_ALIASES[alias] = name

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

    // Agent-facing config surface (describeConfig/getConfig/setConfig)
    registerConfigEntries()

    // Note: the crystal-bar/dock blur layer rules live in hyprland.lua
    // (hl.layer_rule). They used to be re-applied here via `hyprctl keyword`,
    // which the Lua parser rejects ("Use eval.") — so those calls were dead
    // duplicates and have been removed.

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

        // Display scale / resolution change: the axis captures monMain/WIN_W/WIN_H
        // from the monitor geometry at build time, so a runtime scale change leaves
        // them stale and the dock's centering + input-region math breaks ("goes
        // crazy"). The monitor's logical geometry changes on any scale/mode change,
        // so rebuild with fresh geometry. (Debounced by scheduleDockRebuild.)
        try { monitor.connect("notify::geometry", scheduleDockRebuild) }
        catch (e) { console.error("[UI] monitor geometry watch failed:", e) }

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
    const openSettingsPage = (id: string): string => {
      if (!id) return "usage: settingsPage <pageId> (e.g. bluetooth, network, appearance)"
      if (settingsWindows.length === 0) toggleSettings()   // lazy-create + present
      else settingsWindows.forEach(s => { try { s.present() } catch (e) { console.error(e) } })
      let found = false
      settingsWindows.forEach(s => {
        if ((s as any).navigateToPage?.(id)) found = true
      })
      return found ? "ok" : `unknown page: ${id}`
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
    ipc.openSettingsPage = openSettingsPage as (...args: string[]) => string
    ipc.toggleOverview = toggleOverview
    ipc.toggleGameOverlay = toggleGameOverlay
    ipc.lockScreen = lockScreen
    ipc.unlockScreen = unlockScreen

    // Typed shared registry used by Dock, DockItem, Bar, AppGrid widgets
    shellActions.toggleAppGrid = toggleAppGrid
    shellActions.toggleSettings = toggleSettings
    shellActions.openSettingsPage = openSettingsPage
    shellActions.toggleOverview = toggleOverview
    shellActions.toggleGameOverlay = toggleGameOverlay
    shellActions.lockScreen = lockScreen
    shellActions.unlockScreen = unlockScreen

  },
  requestHandler(argv, res) {
    if (!argv || argv.length === 0) return res("ok")
    const cmd = argv[0].replace("()", "")
    const entry = IPC_COMMANDS[cmd] ?? IPC_COMMANDS[IPC_ALIASES[cmd]]
    if (!entry) {
      console.warn(`[Handler] Unknown command: ${cmd}`)
      return res("unknown command — try `ags request listActions`")
    }
    res(entry.run(argv.slice(1)) ?? "ok")
  }
})

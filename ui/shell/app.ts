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
import { exec, execAsync } from "ags/process"
import agentConfig from "./core/AgentConfig"
import appService from "./core/AppService"
import { describeConfig, getConfigValue, getAllConfigValues, setConfigValue } from "./core/ConfigRegistry"
import { registerConfigEntries } from "./config-entries"
import hyprlandState from "./core/HyprlandState"
import queryUI from "./core/UITree"

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
  // May return a Promise — requestHandler awaits it before responding, so a
  // command can read authoritative async state (e.g. `hyprctl clients -j`).
  run: (args: string[]) => string | void | Promise<string | void>
}

// Resolve a window argument to a live client. Accepts an exact address (`0x…`,
// what listWindows reports — precise) OR a class/title substring (convenient,
// e.g. "firefox"). The single front door for every window-targeting IPC command
// so they all accept the same flexible argument. Reads the cached client list
// (refreshed on open/close/move events), so it's current without re-shelling.
function resolveWindow(arg?: string): any | null {
  const q = (arg ?? "").trim()
  if (!q) return null
  const clients = (hyprlandState.clients ?? []) as any[]
  const norm = (s?: string) => (s ?? "").toLowerCase()
  if (q.startsWith("0x")) {
    // listWindows reports hyprctl addresses (with "0x"); AstalHyprland.Client.address
    // sometimes lacks the prefix (why _winSel normalizes) — strip it on both sides.
    const bare = (s?: string) => norm(s).replace(/^0x/, "")
    const target = bare(q)
    return clients.find(c => bare(c.address) === target) ?? null
  }
  return clients.find(c => norm(c.class) === norm(q))
    ?? clients.find(c => norm(c.class).includes(norm(q)))
    ?? clients.find(c => norm(c.title).includes(norm(q)))
    ?? null
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
  openSettings: {
    desc: "Open/raise the Settings window (a normal window — it closes via its own close button, not by re-invoking)",
    aliases: ["toggleSettings"],
    run: () => ipc.openSettings?.(),
  },
  settingsPage: {
    desc: "Open the Settings window on a specific page (e.g. `settingsPage bluetooth`)",
    run: args => ipc.openSettingsPage?.(args[0] ?? ""),
  },
  toggleOverview: { desc: "Toggle the workspaces overview", run: () => ipc.toggleOverview?.() },
  toggleGameOverlay: {
    desc: "Toggle game mode (bar promoted above fullscreen surfaces)",
    run: () => ipc.toggleGameOverlay?.(),
  },
  openWindowMenu: {
    desc: "Open the focused window's options menu (the AppTitle capsule menu) without a " +
      "synthetic click — a deterministic interaction hook. Pair with `queryUI .crystal-menu-label` to read its rows.",
    run: () => {
      if (!shellActions.openWindowMenu) return "window menu unavailable (no app-title bar)"
      shellActions.openWindowMenu()
      return "ok"
    },
  },
  disableComputerControl: {
    desc: "Kill switch: revoke agent computer-control instantly (same as clicking the bar indicator or Super+Shift+Esc). Leaves perception untouched.",
    run: () => {
      agentConfig.setAllowComputerControl(false)
      return "computer-control disabled"
    },
  },
  // ── Window & workspace management ────────────────────────────────────────
  // The shell controlling its OWN compositor (Hyprland IS Crystal Shell), so —
  // like launchApp — these are UNGATED: a window-manager op (focus/move/close a
  // window, switch workspace) is not "reaching into a third-party app". The
  // computer-use gate (allowComputerControl) stays on the things that DO reach
  // in: synthetic keyboard/pointer and AT-SPI actions. Every window-targeting
  // command takes a window via resolveWindow (address from listWindows, or a
  // class/title substring). They delegate to HyprlandState (the only hyprctl door).
  listWindows: {
    desc: "List open windows as JSON [{address, class, title, workspace, at, size, floating, fullscreen, pinned, grouped, focused}] — authoritative compositor state. Use `address` as the target for the window actions below (or pass a class substring). Pair with listWorkspaces.",
    run: async () => {
      const focused = (hyprlandState.focusedClient as any)?.address ?? ""
      const arr = await hyprlandState.getClientsJson()
      return JSON.stringify(
        arr.map((c: any) => ({
          address: c.address,
          class: c.class,
          title: c.title,
          workspace: c.workspace ? { id: c.workspace.id, name: c.workspace.name } : null,
          at: c.at,
          size: c.size,
          floating: !!c.floating,
          fullscreen: !!c.fullscreen,
          pinned: !!c.pinned,
          grouped: Array.isArray(c.grouped) ? c.grouped.length > 0 : false,
          focused: c.address === focused,
        })),
        null,
        2,
      )
    },
  },
  listWorkspaces: {
    desc: "List workspaces as JSON [{id, name, monitor, windows, active, special}] — `active` is the focused one. Use `id` as the target for focusWorkspace / moveWindowToWorkspace.",
    run: async () => {
      const focusedId = hyprlandState.focusedWorkspaceId
      const arr = await hyprlandState.getWorkspacesJson()
      return JSON.stringify(
        arr.map((w: any) => ({
          id: w.id,
          name: w.name,
          monitor: w.monitor,
          windows: w.windows,
          active: w.id === focusedId,
          special: String(w.name ?? "").startsWith("special:"),
        })),
        null,
        2,
      )
    },
  },
  focusWorkspace: {
    desc: "Switch workspace. Absolute id (`focusWorkspace 3`, see listWorkspaces), relative (`+1`/`-1` = next/prev incl. empty), or a Hyprland workspace string (`previous`, `e+1`, `name:foo`).",
    run: args => {
      const a = (args[0] ?? "").trim()
      if (!a) return "usage: focusWorkspace <id | +1 | -1 | previous | name:foo>"
      if (/^\d+$/.test(a)) {
        const id = parseInt(a, 10)
        hyprlandState.focusWorkspace(id)
        return `switched to workspace ${id}`
      }
      // Relative shorthand +N/-N → the cycle-incl-empty form the wheel binds use.
      const rel = a.match(/^([+-])(\d+)$/)
      const arg = rel ? `e${rel[1]}${rel[2]}` : a
      hyprlandState.focusWorkspaceArg(arg)
      return `switched workspace (${arg})`
    },
  },
  focusDirection: {
    desc: "Move keyboard focus in a direction: `focusDirection left|right|up|down` (l/r/u/d also accepted). Only moves focus — benign.",
    run: args => {
      const map: Record<string, "left" | "right" | "up" | "down"> = {
        l: "left", left: "left", r: "right", right: "right",
        u: "up", up: "up", d: "down", down: "down",
      }
      const dir = map[(args[0] ?? "").toLowerCase().trim()]
      if (!dir) return "usage: focusDirection <left|right|up|down>"
      hyprlandState.focusDirection(dir)
      return `moved focus ${dir}`
    },
  },
  focusWindow: {
    desc: "Focus/raise a window by address (from listWindows) or class/title (`focusWindow firefox`). Also the precondition for the synthetic keyboard (type_text/press_key require the target to be the focused window).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.focusWindow(w.address)
      return `focused ${w.class}: ${w.title}`
    },
  },
  closeWindow: {
    desc: "Close a window by address (from listWindows) or class/title (`closeWindow 0x..`). Asks the window to close (may prompt to save) — not a kill.",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.closeWindow(w.address)
      return `closed ${w.class}`
    },
  },
  moveWindowToWorkspace: {
    desc: "Move a window to a workspace (`moveWindowToWorkspace <window> <workspaceId>`). Window by address/class; workspace by id (see listWorkspaces).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      const id = parseInt(args[1] ?? "", 10)
      if (isNaN(id)) return "usage: moveWindowToWorkspace <window> <workspaceId>"
      hyprlandState.sendToWorkspace(w.address, id)
      return `moved ${w.class} → workspace ${id}`
    },
  },
  toggleFloat: {
    desc: "Toggle floating/tiled on a window (`toggleFloat <window>`).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.floatWindow(w.address)
      return `toggled float on ${w.class}`
    },
  },
  toggleFullscreen: {
    desc: "Toggle fullscreen on a window (`toggleFullscreen <window>`).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.toggleFullscreen(w.address)
      return `toggled fullscreen on ${w.class}`
    },
  },
  centerWindow: {
    desc: "Center a floating window on screen (`centerWindow <window>`; no-op for tiled windows).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.centerWindow(w.address)
      return `centered ${w.class}`
    },
  },
  togglePin: {
    desc: "Toggle pin (visible on every workspace; floating windows only) on a window (`togglePin <window>`).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.togglePin(w.address)
      return `toggled pin on ${w.class}`
    },
  },
  togglePseudo: {
    desc: "Toggle pseudo-tiling on a window (`togglePseudo <window>`). NB: pseudo state is not readable, so you can't verify it afterwards.",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.togglePseudo(w.address)
      return `toggled pseudo on ${w.class}`
    },
  },
  toggleGroup: {
    desc: "Toggle a tab-group on a window — creates a lone group or dissolves the whole group (`toggleGroup [window]`; omit the window to act on the focused one).",
    run: args => {
      if (!args[0]) {
        hyprlandState.toggleGroup()
        return "toggled group on the focused window"
      }
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0]}" — see listWindows`
      hyprlandState.toggleGroup(w.address)
      return `toggled group on ${w.class}`
    },
  },
  moveWindowOutOfGroup: {
    desc: "Pull a window out of its tab-group (`moveWindowOutOfGroup <window>`).",
    run: args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      hyprlandState.moveOutOfGroup(w.address)
      return `pulled ${w.class} out of its group`
    },
  },
  sendWindowToSpecial: {
    desc: "Send a window to a special (scratchpad) workspace (`sendWindowToSpecial [name] [window]`; name defaults to 'magic', window defaults to the focused one).",
    run: args => {
      const name = (args[0] || "magic").replace(/^special:/, "")
      const w = args[1] ? resolveWindow(args[1]) : null
      if (args[1] && !w) return `no window matching "${args[1]}" — see listWindows`
      hyprlandState.sendToSpecial(name, w?.address)
      return `sent ${w ? w.class : "the focused window"} → special:${name}`
    },
  },
  setLayout: {
    desc: "Set the Hyprland tiling layout: `setLayout dwindle` or `setLayout master`.",
    run: args => {
      const l = (args[0] ?? "").trim()
      if (l !== "dwindle" && l !== "master") return "usage: setLayout <dwindle|master>"
      hyprlandState.setLayout(l)
      return `layout → ${l}`
    },
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
  listApps: {
    desc: "List installed apps as JSON [{id, name, wmClass}] — the launchable set, the same index the dock and app grid use. Pair with launchApp.",
    run: () =>
      JSON.stringify(
        appService.getAllApps().map(a => ({ id: a.id, name: a.name, wmClass: a.wmClass })),
        null, 2,
      ),
  },
  launchApp: {
    desc: "Launch an installed app by id (`launchApp org.gnome.Nautilus`) — origin-aware (flatpak run / gtk-launch), exactly the dock-click path (uwsm-scoped, CWD=$HOME). Discover ids with listApps.",
    run: args => {
      const id = (args[0] ?? "").trim()
      if (!id) return "usage: launchApp <app-id> (see listApps)"
      if (!appService.hasApp(id)) return `no installed app with id "${id}" — see listApps`
      const cmd = appService.getLaunchCommand(id)
      // Same launch path as a dock click (DockItem.tsx): uwsm-scoped, cd $HOME so
      // children don't inherit the shell's CWD. Fire-and-forget.
      execAsync(["uwsm", "app", "--", "sh", "-c", `cd "$HOME" && exec ${cmd}`])
        .catch(e => console.error("[IPC] launchApp:", e))
      return `launched ${id}`
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
            allowComputerUse: agentConfig.allowComputerUse,
            allowComputerControl: agentConfig.allowComputerControl,
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
  queryUI: {
    desc: "Snapshot what the UI is rendering as JSON (read-only, like dumpState). " +
      "Optional selector: `.cssClass`, `#id`, `Type`, or `selector@window` " +
      "(e.g. `queryUI .bar-app-name`, `queryUI .crystal-menu-row@bar`)",
    run: args => JSON.stringify(queryUI(args[0]), null, 2),
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
    // Show + raise Settings. present()'s Wayland activation is IGNORED by Hyprland
    // when the window sits on another workspace (misc:focus_on_activate=false), so
    // after presenting we dispatch an explicit focus to the window — that switches
    // to its workspace, exactly like clicking any running app in the dock. The
    // window is a normal Hyprland client (class io.Astal.ags, title set by
    // CrystalWindow); match both to disambiguate from the About window.
    const raiseSettings = () => {
      settingsWindows.forEach(s => { try { s.present() } catch (e) { console.error(e) } })
      const c = hyprlandState.clients.find(
        (c: any) => c.class === "io.Astal.ags" && c.title === "Crystal Shell Settings")
      if (c?.address) hyprlandState.focusWindow(c.address)
    }
    // Open/raise Settings — a normal window (NOT a toggle: re-invoking just
    // raises it; it closes via its own close button). IPC alias: toggleSettings.
    const openSettings = () => {
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
      raiseSettings()
    }
    const openSettingsPage = (id: string): string => {
      if (!id) return "usage: settingsPage <pageId> (e.g. bluetooth, network, appearance)"
      if (settingsWindows.length === 0) openSettings()   // lazy-create + raise
      else raiseSettings()
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
    ipc.openSettings = openSettings
    ipc.openSettingsPage = openSettingsPage as (...args: string[]) => string
    ipc.toggleOverview = toggleOverview
    ipc.toggleGameOverlay = toggleGameOverlay
    ipc.lockScreen = lockScreen
    ipc.unlockScreen = unlockScreen

    // Typed shared registry used by Dock, DockItem, Bar, AppGrid widgets
    shellActions.toggleAppGrid = toggleAppGrid
    shellActions.openSettings = openSettings
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
    const out = entry.run(argv.slice(1))
    // Async commands (listWindows reads `hyprctl clients -j`) respond once the
    // Promise settles; sync commands respond immediately.
    if (out instanceof Promise) {
      out.then(v => res(v ?? "ok")).catch(e => res(`error: ${e}`))
      return
    }
    res(out ?? "ok")
  }
})

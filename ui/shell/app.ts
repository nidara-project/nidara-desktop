// MUST be first: captures the asset root and moves the process CWD to $HOME
// before anything else can spawn a child or read the CWD.
import { SHELL_ROOT, readShellVersion } from "./core/Paths"
import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import status, { ISLAND_OVERVIEW, ISLAND_PLAYER, ISLAND_BATTERY, ISLAND_AGENT } from "./core/Status"
import inputYield from "./core/InputYield"
import { selectedPlayer } from "./core/MediaService"
import shellActions from "./core/ShellActions"
import { currentLocale } from "./core/i18n"
import { readFile } from "ags/file"
import { exec, execAsync } from "ags/process"
import agentConfig from "./core/AgentConfig"
import agentService from "./core/AgentService"
import { initAgentGlow } from "./core/AgentGlow"
import appService, { type AppData } from "./core/AppService"
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

// Register custom nidara icon theme (nd-xxx-symbolic icons)
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
import AgentPointer, { isAgentPointerActive } from "./surfaces/agent-pointer/AgentPointer"
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
// Entries may return a Promise (requestHandler already awaits it — agentPointer
// resolves when the fake cursor lands; the GJS main loop stays free meanwhile).
const ipc: Record<string, ((...args: string[]) => string | void | Promise<string | void>) | undefined> = {}

// Whether the fullscreen app grid is open. Unlike the other overlays it lives
// inside the dock window (not Status.ts), so dumpState reads its real state from
// the dock via this accessor. Populated by main(); false until the dock exists.
let isAppGridOpen: () => boolean = () => false

// What the Activity Island COVERS on screen, monitor-relative — capsule plus the
// revealed mode, or null when the island paints nothing. Also populated by main().
//
// This is agent-facing. The Assistant lives inside that island and cannot see it:
// it was resolving controls that sit underneath its own panel and clicking them
// where the user has no way to watch. `dumpState` reports the rect and `yieldInput
// begin` hands it to the pointer helper, so a click can say so instead of landing
// invisibly. OR across monitors is meaningless here (each island is on its own
// monitor), so this reports the FIRST island that is painting something.
type Rect = { x: number, y: number, w: number, h: number }
let islandRect: () => Rect | null = () => null

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

// Resolve a launch argument to an installed app, by id OR by name. `launchApp`
// used to demand an EXACT desktop id, so the obvious `launchApp calculator` came
// back "no installed app with id … — see listApps", and an agent obeys that
// literally: it dumps the whole catalogue (80 apps, 7 KB) to learn one id, and
// that dump then rides in `history` and is resent on every later step of the
// turn. Measured on the bench 2026-07-31: two of thirteen steps, for a name the
// index resolves on its own — `search()` is the same one Prism searches. An
// ambiguous query is answered with the CANDIDATES; a reply that points back at
// the catalogue is what costs the catalogue (the `settingsPage` lesson, #68).
function resolveApp(q: string): { app?: AppData; error?: string } {
  const exactId = appService.hasApp(q) ? appService.getAppData(q) : null
  if (exactId) return { app: exactId }

  const hits = appService.search(q)
  if (hits.length === 0) return { error: `no installed app matching "${q}" — see listApps` }
  const byName = hits.find(a => a.name.toLowerCase() === q.toLowerCase())
  if (byName) return { app: byName }
  if (hits.length === 1) return { app: hits[0] }
  const list = hits.map(a => `${a.id} (${a.name})`).join(", ")
  return { error: `"${q}" matches ${hits.length} apps: ${list} — launch one by id` }
}

// Does a live client belong to the app we just launched? `wmClass` is often null
// in the index (it is parsed from the desktop entry, which frequently omits it —
// Calculator has none), so the id's own tail is the reliable half.
function clientIsApp(cls: string | undefined, app: AppData): boolean {
  const c = (cls ?? "").toLowerCase()
  if (!c) return false
  const wm = (app.wmClass ?? "").toLowerCase()
  if (wm && (c === wm || c.includes(wm))) return true
  const id = app.id.toLowerCase()
  return c === id || c.split(".").pop() === id.split(".").pop()
}

// Wait for the launched app's window and put it in front. A window that maps while
// one of our own layer surfaces holds an EXCLUSIVE keyboard grab does NOT get
// focus — Hyprland refuses outright, the constraint `core/InputYield` exists for —
// and the Assistant island holds that grab the entire time the user is talking to
// it. So an app the Assistant launches comes up unfocused and the very next
// pointer/keyboard verb refuses: on the bench that was a wasted step plus a
// `focus_window` round trip on EVERY "open X and do Y", and only from inside the
// Assistant (an external MCP client, with nothing grabbing, never sees it).
// Costs nothing in the ordinary case: `begin()` is a no-op when no surface is
// grabbing, and there Hyprland has already focused the window itself.
// Waiting also removes a race the caller used to absorb — perception right after
// a launch could find no window at all — so the reply says which of the two
// happened instead of leaving it to be discovered.
async function focusLaunched(target: AppData, before: Set<string>): Promise<string> {
  const bare = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "")
  const deadline = GLib.get_monotonic_time() + 5_000_000
  let win: any = null
  while (!win && GLib.get_monotonic_time() < deadline) {
    await new Promise<void>(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { r(); return GLib.SOURCE_REMOVE }))
    win = ((hyprlandState.clients ?? []) as any[])
      .find(c => !before.has(bare(c.address)) && clientIsApp(c.class, target)) ?? null
  }
  if (!win) return " — no window within 5s (it may still be starting, or be a background app)"

  await inputYield.begin()
  try {
    await hyprlandState.focusWindow(win.address)
    await new Promise<void>(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { r(); return GLib.SOURCE_REMOVE }))
    const now = hyprlandState.focusedClient as any
    return bare(now?.address) === bare(win.address)
      ? `, window ready and focused: ${win.class}`
      : `, window ready but focus refused by the compositor (still on ${now?.class ?? "nothing"})`
  } finally {
    inputYield.end()
  }
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
    desc: "Toggle search (apps and recent files)",
    aliases: ["toggleSearch"],
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
  togglePlayer: {
    desc: "Toggle the media player island (the bar capsule's expanded player). Needs an MPRIS player on the bus — verify via dumpState `overlays.island`",
    run: () => selectedPlayer() ? void status.toggleIsland(ISLAND_PLAYER) : "no media player on the bus",
  },
  toggleAgent: {
    desc: "Toggle the built-in Assistant island (the conversational agent). Opens the empty state if no provider is configured (Settings → AI)",
    run: () => void status.toggleIsland(ISLAND_AGENT),
  },
  agentNewConversation: {
    // DELIBERATELY OUT OF THE ASSISTANT'S OWN REACH: this name is in the daemon's
    // HIDDEN_ACTIONS, so it never enters run_action's index and run_action cannot
    // resolve it. The Assistant must not be able to discard its own context — a
    // reset mid-turn would break the tool_call/tool_result pairing it is standing
    // on, and "start over" is the user's call, not a move in a turn. Every other
    // caller keeps it: a terminal (`ags request`) and an MCP client, which is the
    // point — an eval harness driving the bench is exactly who needs it.
    desc: "End the Assistant's conversation and begin an empty one — drops BOTH halves (the transcript the user reads and the model's history), in memory and on disk. The programmatic twin of the island's \"New conversation\" button, and the only way to reach a fresh conversation without restarting the shell: deleting the state files under a live shell does nothing, because the shell holds the conversation in memory and rewrites them at the next turn end. Refuses while a turn is in flight — read `dumpState` `ai.assistant` and retry once `busy` is false.",
    // No alias on purpose: a second name would look covered by the daemon's
    // denylist without being it — aliases are a FIELD in listActions, never a key,
    // so they never enter run_action's index and the denylist never sees them.
    run: () => {
      if (agentService.busy)
        return "a turn is in flight — nothing was discarded; wait for dumpState ai.assistant.busy to go false and call again"
      const turns = agentService.transcript.length
      agentService.reset()
      return turns ? `conversation ended — ${turns} turns dropped` : "conversation was already empty"
    },
  },
  setIsland: {
    desc: "Set the Activity Island to an EXACT state — `setIsland closed` (alias `\"\"`) collapses it to the bar capsule, `setIsland agent|overview|player|battery` opens that mode. Unlike the toggle* commands this is not ambiguous when you cannot see the current state, so it is the one to use programmatically; read the state back from dumpState `overlays.island` / `overlays.islandBounds`. The Assistant runs INSIDE this island: closing it does not end the turn or lose the conversation (the transcript is persisted and redrawn on reopen), so closing it to uncover a control you need to click is safe.",
    run: args => {
      const raw = (args[0] ?? "").trim().toLowerCase()
      const mode = (raw === "closed" || raw === "close" || raw === "none") ? "" : raw
      const known = ["", ISLAND_OVERVIEW, ISLAND_PLAYER, ISLAND_BATTERY, ISLAND_AGENT]
      if (!known.includes(mode))
        return `unknown island mode "${raw}" — one of: closed, ${known.filter(Boolean).join(", ")}`
      if (mode === ISLAND_PLAYER && !selectedPlayer()) return "no media player on the bus"
      status.island_mode = mode
      return mode === "" ? "island closed" : `island set to ${mode}`
    },
  },
  toggleAbout: {
    desc: "Toggle the About window (system info card, window `nidara-about`) — the deterministic hook " +
      "for the system-menu item. Pair with `queryUI .about-spec-val@about` or dumpState `overlays.about` to verify.",
    run: () => status.toggleAbout(),
  },
  toggleBarOverlay: {
    desc: "Toggle the bar overlay (bar promoted above fullscreen surfaces)",
    aliases: ["toggleGameOverlay"],
    run: () => ipc.toggleBarOverlay?.(),
  },
  openWindowMenu: {
    desc: "Open the focused window's options menu (the AppTitle capsule menu) without a " +
      "synthetic click — a deterministic interaction hook. Pair with `queryUI .nidara-menu-label` to read its rows.",
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
  notifyComputerAction: {
    desc: "Signal that a computer-use action just fired (called by nidara-act/type/click). Lights the bar's AI-control indicator's 'active' state for a few seconds, then it decays back to 'armed'. Fire-and-forget; no effect unless control is granted.",
    run: () => {
      agentConfig.pulseComputerAction()
      return "ok"
    },
  },
  agentPointer: {
    desc: "PURELY VISUAL — drives the fake AI-cursor overlay that mirrors computer-use pointer actions; it never injects input (nidara-input does that underneath). Grammar: `agentPointer click|rightclick|move|scroll <gx> <gy> [from <bx> <by>]` or `agentPointer drag <gx> <gy> <gx2> <gy2> [from <bx> <by>]` (global logical px; the request resolves when the cursor LANDS on the target), then `agentPointer confirm` (the real action fired → click ripple, or for `move` just the linger: a hover presses nothing, so it must not ripple) or `agentPointer cancel` (aborted → fade out, no ripple). Called by nidara-click; action kinds obey the allowComputerControl gate.",
    run: args => ipc.agentPointer?.(...args),
  },
  yieldInput: {
    desc: "PLUMBING for the computer-use helpers, which call it themselves — there is no reason to invoke it directly. `yieldInput begin` makes every shell surface holding an EXCLUSIVE keyboard grab (the Assistant island, Prism, the app grid) drop it and go click-through, and only answers once the compositor has APPLIED the release; `yieldInput end` hands it back. Without it Hyprland refuses to move window focus at all while we grab, and routes synthetic clicks to our own surface — see core/InputYield. Self-heals if a helper dies mid-action. `begin` answers with JSON `{yielded, islandBounds}` so the caller can tell whether its target sits under the Activity Island.",
    run: async args => {
      const verb = (args[0] ?? "").trim().toLowerCase()
      if (verb === "begin") {
        // Read the rect BEFORE yielding — the yield makes the island click-through
        // but does not move or hide it, so this is what still covers the screen.
        // Returned here rather than via a second request: the helper is already
        // paying for this round trip, and a click needs the answer at exactly this
        // moment (the panel can be revealed or collapsed between two actions).
        const r = islandRect()
        await inputYield.begin()
        return JSON.stringify({ yielded: true, islandBounds: r })
      }
      if (verb === "end") { inputYield.end(); return "restored" }
      return "usage: yieldInput <begin|end>"
    },
  },
  // ── Window & workspace management ────────────────────────────────────────
  // The shell controlling its OWN compositor (Hyprland IS Nidara), so —
  // like launchApp — these are UNGATED: a window-manager op (focus/move/close a
  // window, switch workspace) is not "reaching into a third-party app". The
  // computer-use gate (allowComputerControl) stays on the things that DO reach
  // in: synthetic keyboard/pointer and AT-SPI actions. Every window-targeting
  // command takes a window via resolveWindow (address from listWindows, or a
  // class/title substring). They delegate to HyprlandState (the only hyprctl door).
  listWindows: {
    desc: "List open windows as JSON [{address, class, title, workspace, at, size, floating, fullscreen, pinned, grouped, focused}] — authoritative compositor state. Use `address` as the target for the window actions below (or pass a class substring). Pair with listWorkspaces.",
    run: async () => {
      // AstalHyprland's focusedClient.address can lack the "0x" prefix that
      // `hyprctl clients -j` reports — compare bare, like resolveWindow does.
      const bare = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "")
      const focused = bare((hyprlandState.focusedClient as any)?.address)
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
          focused: bare(c.address) === focused && focused !== "",
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
  reloadHyprland: {
    desc: "Make Hyprland re-read its config, applying edits to hyprland-user.lua (keybinds, window rules). Ungated, like the other compositor ops: it re-runs the config the user already has. Call it after editing that file, then verify with dumpState.",
    run: () => {
      hyprlandState.reloadConfig()
      return "hyprland config reloaded"
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
    desc: "Focus/raise a window by address (from listWindows) or class/title (`focusWindow firefox`). Also the precondition for the synthetic keyboard (type_text/press_key require the target to be the focused window). VERIFIES the move and says so — it does not report success for a focus the compositor refused.",
    run: async args => {
      const w = resolveWindow(args[0])
      if (!w) return `no window matching "${args[0] ?? ""}" — see listWindows`
      // Yield first, or this is a no-op: Hyprland refuses to move window focus
      // while one of our layer surfaces holds an EXCLUSIVE grab, which the
      // Assistant island always does while the user is typing at it. That is what
      // made every "focused X" here a lie the model then acted on (core/InputYield).
      await inputYield.begin()
      try {
        await hyprlandState.focusWindow(w.address)
        // Settle: the dispatch is a subprocess and the answer arrives by event.
        await new Promise<void>(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { r(); return GLib.SOURCE_REMOVE }))
        const bare = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "")
        const now = hyprlandState.focusedClient as any
        if (bare(now?.address) !== bare(w.address))
          return `focus refused by the compositor — still on ${now?.class ?? "nothing"}; asked for ${w.class}: ${w.title}`
        return `focused ${w.class}: ${w.title}`
      } finally {
        inputYield.end()
      }
    },
  },
  closeWindow: {
    desc: "Close a window by address (from listWindows) or class/title (`closeWindow 0x..`). Asks the window to close (may prompt to save) — not a kill. Gated by Settings → AI.",
    run: args => {
      // The ONE gated member of the window/workspace cluster. The rest stay
      // ungated because they are reversible (focus, move, float, layout) — this
      // one can destroy unsaved work, and "the model misread a sentence" is a
      // realistic way to trigger it. The prompt tells the assistant to ask before
      // anything destructive, but a rule in a prompt is a suggestion, not a lock.
      if (!agentConfig.allowWindowClose)
        return "closing windows is disabled — enable it in Settings → AI (or ai.json)"
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
      const path = args[0] || `/tmp/nidara-shot-${Date.now()}.png`
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
    desc: "Launch an installed app by NAME or id (`launchApp calculator`, `launchApp org.gnome.Nautilus`) — origin-aware (flatpak run / gtk-launch), exactly the dock-click path (uwsm-scoped, CWD=$HOME). A name that matches several apps comes back with the candidates, so listApps is only for browsing. Waits for the window and focuses it, then says so: the next perception or pointer call can go straight at it.",
    run: async args => {
      const q = (args[0] ?? "").trim()
      if (!q) return "usage: launchApp <name-or-id> (e.g. `launchApp calculator`; see listApps)"
      const { app: target, error } = resolveApp(q)
      if (!target) return error!
      const cmd = appService.getLaunchCommand(target.id)
      const before = new Set(
        ((hyprlandState.clients ?? []) as any[]).map(c => (c.address ?? "").toLowerCase().replace(/^0x/, "")),
      )
      // Same launch path as a dock click (DockItem.tsx): uwsm-scoped, cd $HOME so
      // children don't inherit the shell's CWD. Fire-and-forget.
      execAsync(["uwsm", "app", "--", "sh", "-c", `cd "$HOME" && exec ${cmd}`])
        .catch(e => console.error("[IPC] launchApp:", e))
      return `launched ${target.id}${await focusLaunched(target, before)}`
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
    desc: "Dump live shell state as JSON (version, theme, locale, monitors incl. resolution/refresh/scale, overlays, effective Hyprland config)",
    run: () => {
      const display = Gdk.Display.get_default()
      return JSON.stringify(
        {
          shell: {
            version: readShellVersion(),
            locale: currentLocale(),
            darkMode: Theme.isDark,
            // A COUNT was all this reported until now, which meant the one
            // question anybody actually asks about their display — "what
            // resolution am I running?" — had no answer anywhere on the agent
            // surface. Reading nidara-monitor.lua does not answer it either: that
            // file records the user's PICK, which is normally `mode = "preferred"`.
            // AstalHyprland's monitor objects carry the effective geometry the
            // compositor is really driving, and HyprlandState already caches them
            // for the Display page, so this is the authoritative answer for free.
            // Kept as `monitors` (an array now): every consumer of the old number
            // wanted "how many", and .length still gives it.
            monitors: hyprlandState.monitors.map((m: any) => ({
              name: m.name,
              description: m.description || m.model || "",
              width: m.width,
              height: m.height,
              refreshRate: Math.round((m.refreshRate ?? 0) * 100) / 100,
              scale: m.scale,
              x: m.x,
              y: m.y,
              transform: m.transform,
              focused: m.focused,
            })),
            monitorCount: display ? display.get_monitors().get_n_items() : 0,
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
            allowWindowClose: agentConfig.allowWindowClose,
            allowMcp: agentConfig.allowMcp,
            allowComputerUse: agentConfig.allowComputerUse,
            allowComputerControl: agentConfig.allowComputerControl,
            // The built-in Assistant's LIVE conversation, not a gate. Added for
            // agentNewConversation, whose refusal has to name something a caller
            // can actually poll — a refusal that names no next step is the defect
            // this surface keeps re-learning. Costs the Assistant nothing: it
            // cannot call dumpState (HIDDEN_ACTIONS), only outside clients can.
            assistant: {
              configured: agentService.configured(),
              busy: agentService.busy,
              state: agentService.state,
              turns: agentService.transcript.length,
            },
          },
          overlays: {
            controlCenter: status.cc_open,
            notificationCenter: status.nc_open,
            prism: status.prism_open,
            appGrid: isAppGridOpen(),
            systemMenu: status.system_menu_open,
            overview: status.island_mode === ISLAND_OVERVIEW,   // back-compat key
            island: status.island_mode,
            // Where the island physically sits, so an agent driving another app can
            // tell that a control it resolved is hidden behind the Assistant's own
            // panel — and close it (`setIsland closed`) instead of clicking where
            // the user cannot see. null = the island is painting nothing there.
            islandBounds: islandRect(),
            settings: status.settings_open,
            about: status.about_open,
          },
          flags: {
            ccEditMode: status.cc_edit_mode,
            recording: status.recording,
            barExpandedId: status.bar_expanded_id,
            ccDetailId: status.cc_detail_id,
            agentPointer: isAgentPointerActive(),
          },
          // WHO HOLDS THE KEYBOARD. The compositor will not tell you: `hyprctl
          // activewindow` reports the focused WINDOW (which stays put while a layer
          // surface holds the keys), `hyprctl layers` does not expose keyboard
          // interactivity at all, and Hyprland's log carries no focus lines (checked:
          // 55 MB, zero matches). But OUR side knows — GDK marks a toplevel active
          // when the compositor sends it wl_keyboard.enter — so ask the windows.
          //
          // `active` true on a shell surface means the keyboard is going THERE, not
          // to the user's window. `focusWidget` is what would receive a keypress
          // inside it, which is how you catch a surface holding the keyboard for a
          // panel that is no longer open.
          keyboardFocus: (() => {
            const out: Record<string, unknown> = {}
            try {
              for (const w of (app.get_windows() ?? [])) {
                const name = (w as any).name || "(unnamed)"
                let focusWidget: string | null = null
                try {
                  const f = (w as any).get_focus?.()
                  if (f) {
                    const cls = (f.cssClasses ?? []).join(".")
                    focusWidget = `${f.constructor?.$gtype?.name ?? "widget"}${cls ? "." + cls : ""}`
                  }
                } catch (_) {}
                // `is-active` is a PROPERTY on Gtk.Window, not a method — read it as
                // one (with get_property as a fallback) or GJS throws.
                let active = false
                try { active = !!(w as any).is_active } catch (_) {}
                if (!active) { try { active = !!(w as any).get_property?.("is-active") } catch (_) {} }
                out[name] = {
                  active,
                  visible: !!(w as any).visible,
                  focusable: !!(w as any).focusable,
                  focusWidget,
                }
              }
            } catch (e) {
              out["error"] = String(e)
            }
            return out
          })(),
        },
        null,
        2,
      )
    },
  },
  queryUI: {
    // The first clause is all an agent sees in nidara-agent's action index, so it
    // has to say WHOSE windows these are: query_app reads other apps through
    // AT-SPI and cannot see Nidara at all, and an agent that doesn't know this
    // tries the accessibility tree on its own Settings window and finds nothing.
    desc: "Read Nidara's OWN windows as JSON — bar, dock, Control Center, Assistant island, Settings — read-only, and the only way to see them: query_app cannot. " +
      "Optional selector: `.cssClass`, `#id`, `Type`, or `selector@window` " +
      "(e.g. `queryUI .bar-app-name`, `queryUI .nidara-menu-row@bar`)",
    run: args => JSON.stringify(queryUI(args[0]), null, 2),
  },
}

// alias → canonical command name, derived once from the table above.
const IPC_ALIASES: Record<string, string> = {}
for (const [name, { aliases }] of Object.entries(IPC_COMMANDS))
  for (const alias of aliases ?? []) IPC_ALIASES[alias] = name

app.start({
  applicationId: "org.nidara.desktop",
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

    // "The Assistant is working in this window" — the inner glow follows
    // agentService.busy. Also clears a glow left on by a shell that died mid-turn.
    initAgentGlow()

    // Note: the nidara-bar/dock blur layer rules live in hyprland.lua
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
        // Fake AI cursor (created UNMAPPED — zero cost until an action plays)
        const pointerWin = AgentPointer(monitor)

        windows.add(barWin);
        windows.add(dockWin);
        windows.add(pointerWin as any);
        // The Activity Island's own OVERLAY layer surface (see IslandWindow.ts):
        // a sibling toplevel the bar creates, tracked here so teardown reaches it.
        const islandWin = (barWin as any).islandWindow
        if (islandWin) windows.add(islandWin)

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
                if (w.name === "nidara-dock" && (w as any).gdkmonitor === monitor) {
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
        if (w.name === "nidara-dock") try { (w as any).toggleAppGridPanel?.() } catch (e) { console.error(e) }
      })
    }
    // Expose the app grid's real open-state to dumpState (it lives in the dock,
    // not Status.ts). OR across docks = open on any monitor.
    isAppGridOpen = () => {
      let open = false
      windows.forEach(w => {
        if (w.name === "nidara-dock") try { if ((w as any).isAppGridPanelOpen?.()) open = true } catch (e) { console.error(e) }
      })
      return open
    }
    // Same idiom for the island's covered rect (see islandRect's declaration).
    islandRect = () => {
      let r: Rect | null = null
      windows.forEach(w => {
        if (r || w.name !== "nidara-island") return
        try { r = (w as any).occupiedRect?.() ?? null } catch (e) { console.error(e) }
      })
      return r
    }
    // Show + raise Settings. present()'s Wayland activation is IGNORED by Hyprland
    // when the window sits on another workspace (misc:focus_on_activate=false), so
    // after presenting we dispatch an explicit focus to the window — that switches
    // to its workspace, exactly like clicking any running app in the dock. The
    // window is a normal Hyprland client (class io.Astal.ags, title set by
    // NidaraWindow); match both to disambiguate from the About window.
    const raiseSettings = () => {
      settingsWindows.forEach(s => { try { s.present() } catch (e) { console.error(e) } })
      const c = hyprlandState.clients.find(
        (c: any) => c.class === "io.Astal.ags" && c.title === "Nidara Settings")
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
      // Every failure hands back the valid ids. A bare "unknown page: AI" told an
      // agent only that its guess was wrong, so it burned a step re-guessing
      // (measured 2026-07-30) — and the ids are not derivable from the sidebar
      // labels, which are translated.
      const validPages = (): string =>
        [...new Set(settingsWindows.flatMap(s => (s as any).pageIds ?? []))].join(", ")
      if (!id) return `usage: settingsPage <pageId> — valid: ${validPages() || "bluetooth, network, appearance, …"}`
      if (settingsWindows.length === 0) openSettings()   // lazy-create + raise
      else raiseSettings()
      let found = false
      settingsWindows.forEach(s => {
        if ((s as any).navigateToPage?.(id)) found = true
      })
      return found ? "ok" : `unknown page: ${id} — valid: ${validPages()}`
    }
    const toggleOverview = () => {
      status.toggleOverview()
    }
    const toggleBarOverlay = () => {
      // Only promotes bar — dock and appgrid are unaffected.
      // Activation requires a fullscreen window; deactivation is always allowed.
      windows.forEach(w => {
        if (w.name === "nidara-bar") {
          const isActive = (w as any).isBarOverlayActive?.() ?? false
          const isFullscreen = (w as any).isBarFullscreenMode?.() ?? false
          if (!isActive && !isFullscreen) return
          ;(w as any).setBarOverlayMode?.(!isActive)
        }
      })
    }
    // About window — lazy, created only when first toggled, destroyed on close
    status.connect("notify::about-open", () => {
      if (status.about_open) try { AboutWindow() } catch (e) { console.error("[About] failed:", e) }
    })
    const lockScreen = () => {
      windows.forEach(w => {
        // Why hide at all, when ext-session-lock-v1 already hides every layer?
        // Because the protocol only covers the steady state. Hyprland's
        // renderAllClientsForWorkspace returns BEFORE drawing any layer once the
        // lock client has confirmed (`clientLocked()`), and only layers carrying
        // the `above_lock` rule come back above the lock surface — Nidara sets
        // that rule nowhere, so nothing of ours can outrank the lockscreen.
        // Input matches: with the session locked the pointer hit-test skips
        // every layer without `above_lock 2`, and keyboard focus is forced onto
        // the lock surface. (Verified against Hyprland 0.56 sources 2026-08-07:
        // Renderer.cpp renderAllClientsForWorkspace/renderLockscreen/renderLayer,
        // ViewHitTester.cpp layerSurfaceAt, InputManager.cpp.)
        //
        // What IS ours to cover are the two gaps around that steady state:
        //   1. bin/nidara-lock calls hideForLock BEFORE launching the bundle.
        //      Until the lock surface is committed on every monitor the session
        //      still renders whole — bar, dock and island included.
        //   2. The OVERLAY fallback (Gtk4SessionLock unsupported), where the
        //      lockscreen is just another OVERLAY layer competing with ours.
        // nidara-island must be named explicitly: it carries the compact CAPSULE
        // as well as the expanded modes, on its own surface since #53.
        if (w.name === "nidara-bar" || w.name === "nidara-dock" || w.name === "nidara-island") {
          try { w.hide() } catch (e) {}
        }
        // The agent pointer paints on OVERLAY (above the lockscreen fallback) —
        // vanish it instantly, symmetric with hiding the rest of the shell skin.
        if (w.name === "nidara-agent-pointer") {
          try { (w as any).agentPointerCancel?.(true) } catch (e) {}
        }
      })
    }
    const unlockScreen = () => {
      windows.forEach(w => {
        if (w.name === "nidara-bar" || w.name === "nidara-dock" || w.name === "nidara-island") {
          try { w.present() } catch (e) {}
        }
      })
    }

    // Fake AI cursor choreography (PURELY VISUAL — nidara-input injects the real
    // input; see surfaces/agent-pointer/). Action kinds route to the overlay on
    // the monitor containing the target point and return a Promise that resolves
    // when the cursor LANDS; confirm/cancel broadcast (ungated — they only ever
    // finish an animation that the gate already allowed to start).
    const agentPointer = (...args: string[]): string | Promise<string | void> => {
      const kind = (args[0] ?? "").trim()
      const pointers: any[] = []
      windows.forEach(w => { if (w.name === "nidara-agent-pointer") pointers.push(w) })
      if (pointers.length === 0) return "agent-pointer overlay unavailable"
      if (kind === "confirm" || kind === "cancel") {
        pointers.forEach(p => {
          try { kind === "confirm" ? p.agentPointerConfirm() : p.agentPointerCancel() }
          catch (e) { console.error("[AgentPointer] IPC:", e) }
        })
        return "ok"
      }
      if (!["click", "rightclick", "move", "scroll", "drag"].includes(kind))
        return "usage: agentPointer click|rightclick|move|scroll <gx> <gy> [from <bx> <by>] | drag <gx> <gy> <gx2> <gy2> [from <bx> <by>] | confirm | cancel"
      // Defense in depth: the visual mirrors gated computer-control actions, so
      // action kinds obey the same gate (nidara-click checks it too).
      if (!agentConfig.allowComputerControl)
        return "computer-control is disabled — the agent-pointer visual only plays for gated actions"
      const rest = args.slice(1)
      const fi = rest.indexOf("from")
      const coords = (fi >= 0 ? rest.slice(0, fi) : rest).map(Number)
      const fromPair = (fi >= 0 ? rest.slice(fi + 1, fi + 3) : []).map(Number)
      const [gx, gy, gx2, gy2] = coords
      if (!isFinite(gx) || !isFinite(gy)) return "agentPointer: numeric <gx> <gy> required"
      if (kind === "drag" && (!isFinite(gx2) || !isFinite(gy2)))
        return "agentPointer drag: numeric <gx2> <gy2> required"
      const [fbx, fby] = fromPair
      const target = pointers.find(p => {
        try {
          const g = p.gdkmonitor?.get_geometry?.()
          return g && gx >= g.x && gx < g.x + g.width && gy >= g.y && gy < g.y + g.height
        } catch { return false }
      }) ?? pointers[0]
      return target.agentPointerRun(kind, gx, gy, gx2, gy2,
        isFinite(fbx) ? fbx : undefined, isFinite(fby) ? fby : undefined)
    }

    // Register IPC handlers (used by requestHandler)
    ipc.toggleAppGrid = toggleAppGrid
    ipc.agentPointer = agentPointer
    ipc.openSettings = openSettings
    ipc.openSettingsPage = openSettingsPage as (...args: string[]) => string
    ipc.toggleOverview = toggleOverview
    ipc.toggleBarOverlay = toggleBarOverlay
    ipc.lockScreen = lockScreen
    ipc.unlockScreen = unlockScreen

    // Typed shared registry used by Dock, DockItem, Bar, AppGrid widgets
    shellActions.toggleAppGrid = toggleAppGrid
    shellActions.openSettings = openSettings
    shellActions.openSettingsPage = openSettingsPage
    shellActions.toggleOverview = toggleOverview
    shellActions.toggleBarOverlay = toggleBarOverlay
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

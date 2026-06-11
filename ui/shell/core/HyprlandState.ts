import GObject from "gi://GObject"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import { execAsync, exec } from "ags/process"

// Tracked IPC event names that require a full state refresh
const TRACKED_EVENTS = [
    "workspace", "workspacev2", "activewindow", "activewindowv2",
    "movewindow", "movewindowv2",
    "openwindow", "closewindow",
    "focusedmon", "fullscreen",
    "changefloatingmode",
    "monitor-added", "monitor-removed",
]

class HyprlandStateClass extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "CrystalHyprlandState",
            // "changed" = structural window/workspace state (fires often).
            // "config-reloaded" = Hyprland re-read its config (`hyprctl reload` or a
            //   hyprland-user.lua edit). Effective-config consumers (InputConfig,
            //   MonitorConfig) listen to THIS, not "changed", to re-sync from the live
            //   config so they don't clobber external edits on their next write.
            Signals: { "changed": {}, "config-reloaded": {} },
        }, this)
    }

    private readonly hl: AstalHyprland.Hyprland
    private _refreshPending = false

    // Cached raw arrays — one refresh per signal batch, shared by all consumers
    clients:    AstalHyprland.Client[]    = []
    workspaces: AstalHyprland.Workspace[] = []
    monitors:   AstalHyprland.Monitor[]   = []

    // AstalHyprland.Monitor.available_modes is always null, so the mode list is read
    // from `hyprctl monitors -j` and cached here (refreshed only on monitor add/remove,
    // not on every event). Consumers (Display settings) read it instead of re-shelling.
    availableModesByName = new Map<string, string[]>()

    // Pre-computed derived state — rebuilt on every refresh
    clientsByWorkspace = new Map<number, AstalHyprland.Client[]>()
    occupiedWorkspaces = new Set<number>()
    specialWorkspaces:  AstalHyprland.Workspace[] = []
    submap = ""

    // Synced synchronously from the IPC event data so it's always up-to-date
    // even before AstalHyprland has settled its own property updates.
    focusedWorkspaceId = 0

    // Direct proxies — no caching needed, these are lightweight GObject accessors
    get focusedWorkspace() { return this.hl.focused_workspace }
    get focusedClient()    { return this.hl.focused_client }
    get focusedMonitor()   { return this.hl.focused_monitor }

    constructor() {
        super()
        this.hl = AstalHyprland.get_default()

        const refresh = () => this._scheduleRefresh()
        const onMonitors = () => { this._refreshModes(); refresh() }
        // Avoid notify::clients and notify::focused-* — AstalHyprland re-emits them
        // whenever it rebuilds its internal state (e.g. on windowtitle events from Chrome/
        // YouTube), even when the logical state hasn't changed. TRACKED_EVENTS IPC signals
        // cover all structural changes: focus (activewindow), workspace (workspace),
        // open/close (openwindow/closewindow), move (movewindow), monitor (focusedmon).
        this.hl.connect("monitor-added",   onMonitors)
        this.hl.connect("monitor-removed", onMonitors)
        this.hl.connect("event", (_h: any, name: string, data: string) => {
            if (name === "submap") {
                this.submap = data || ""
                this._scheduleRefresh()
                return
            }
            // Hyprland re-read its config (`hyprctl reload`, or a hyprland-user.lua
            // edit). Refresh the modes cache (a monitor's modes can change) and let
            // effective-config consumers re-sync via "config-reloaded".
            if (name === "configreloaded") {
                this._refreshModes()
                this.emit("config-reloaded")
                return
            }
            // Sync workspace ID from IPC data directly — before idle_add fires —
            // so hs.focusedWorkspaceId is always current when "changed" is emitted.
            if (name === "workspace") {
                const id = parseInt(data)
                if (!isNaN(id)) this.focusedWorkspaceId = id
            } else if (name === "workspacev2") {
                // format: "ID,name"
                const id = parseInt(data.split(",")[0])
                if (!isNaN(id)) this.focusedWorkspaceId = id
            }
            if (TRACKED_EVENTS.includes(name)) refresh()
        })

        this._refresh()
        this._refreshModes()
    }

    // Cache available modes per monitor from hyprctl (one sync read; modes only
    // change when a monitor is added/removed). Returns [] if unknown.
    private _refreshModes() {
        try {
            const arr = JSON.parse(exec(["hyprctl", "monitors", "-j"]))
            this.availableModesByName.clear()
            for (const m of arr) this.availableModesByName.set(m.name, m.availableModes ?? [])
        } catch (e) { console.error("[HyprlandState] modes refresh failed:", e) }
    }

    getAvailableModes(name: string): string[] {
        return this.availableModesByName.get(name) ?? []
    }

    /** Read an effective Hyprland option's int value via `hyprctl getoption` (works
     *  with the Lua parser, unlike `keyword`). On-demand read — the first of the
     *  "effective config in HyprlandState" idea (gaps etc. could follow the same way). */
    getOptionInt(name: string): number {
        try { return JSON.parse(exec(["hyprctl", "getoption", name, "-j"])).int ?? 0 }
        catch (e) { console.error("[HyprlandState] getOptionInt", name, e); return 0 }
    }

    /** Async read of an effective option: resolves the parsed `getoption -j` JSON
     *  ({int, float, str, set…}) or null on failure. Use for batch re-syncs
     *  (InputConfig); prefer getOptionInt for one-off sync reads. */
    async getOptionJson(name: string): Promise<any | null> {
        try { return JSON.parse(await execAsync(["hyprctl", "getoption", "-j", name])) }
        catch (e) { console.error("[HyprlandState] getOptionJson", name, e); return null }
    }

    /** Run a Lua-parser eval — the ONLY way to change Hyprland config live (the Lua
     *  parser rejects `hyprctl keyword`). Failures are logged with the offending call. */
    evalLua(luaCall: string) {
        return execAsync(["hyprctl", "eval", luaCall])
            .catch(e => console.error("[HyprlandState] evalLua:", luaCall, e))
    }

    /** Set the compositor cursor theme + size (`hyprctl setcursor`). */
    setCursor(theme: string, size: number) {
        return execAsync(["hyprctl", "setcursor", theme, String(size)]).catch(() => {})
    }

    /** Hyprland version, e.g. "0.55.2" ("" on failure). */
    async version(): Promise<string> {
        try {
            const out = await execAsync(["hyprctl", "version"])
            const m = out.match(/Hyprland\s+v?([\d][\w.-]*)/)
            return m ? m[1] : out.split("\n")[0].trim()
        } catch { return "" }
    }

    // Coalesces multiple signals that fire in the same GLib iteration into one refresh.
    private _scheduleRefresh() {
        if (this._refreshPending) return
        this._refreshPending = true
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshPending = false
            this._refresh()
            return GLib.SOURCE_REMOVE
        })
    }

    private _refresh() {
        try {
            this.clients    = this.hl.get_clients()    || []
            this.workspaces = this.hl.get_workspaces() || []
            this.monitors   = this.hl.get_monitors()   || []

            // Keep focusedWorkspaceId in sync with AstalHyprland's view
            // (handles named workspaces and the initial state before any IPC fires).
            const fwId = this.hl.focused_workspace?.id
            if (fwId != null) this.focusedWorkspaceId = fwId

            this.clientsByWorkspace.clear()
            this.occupiedWorkspaces.clear()
            this.specialWorkspaces = []

            for (const ws of this.workspaces) {
                if (!ws) continue
                const name: string = (ws as any).name || ""
                if (name.startsWith("special:")) {
                    this.specialWorkspaces.push(ws)
                } else {
                    this.occupiedWorkspaces.add(ws.id)
                }
            }

            for (const c of this.clients) {
                if (!c?.workspace?.id) continue
                const wsId = c.workspace.id
                if (!this.clientsByWorkspace.has(wsId))
                    this.clientsByWorkspace.set(wsId, [])
                this.clientsByWorkspace.get(wsId)!.push(c)
            }

            this.emit("changed")
        } catch (e) {
            console.error("[HyprlandState] refresh failed:", e)
        }
    }

    // ── Dispatch API ─────────────────────────────────────────────────────────
    // Single source of truth for all hyprctl dispatch strings.
    // RULE: HyprlandState is the ONLY door to hyprctl — services and widgets
    // never shell out to hyprctl directly; they call (or add) a method here.
    // (Exempt: config text we WRITE for other daemons to run, e.g. the
    // hypridle config in Power.tsx — those execute outside the shell.)
    // RULE: dispatch strings are hl.dsp.* Lua ONLY — the classic syntax
    // (`togglefloating addr`, `movetoworkspace N,addr`…) is a Lua error that
    // .catch swallows, so it fails silently (four methods shipped broken that
    // way until 2026-06-11).

    private _dispatch(call: string) {
        return execAsync(["hyprctl", "dispatch", call])
            .catch(e => console.error("[HyprlandState] dispatch:", call, e))
    }

    // `{ window = 'address:0x..' }` selector — verified on float/pin/move/close.
    private _winSel(address: string): string {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return `window = 'address:${addr}'`
    }

    focusWorkspace(id: number) {
        return this._dispatch(`hl.dsp.focus({ workspace = ${id} })`)
    }

    focusWindow(address: string) {
        return this._dispatch(`hl.dsp.focus({ ${this._winSel(address)} })`)
    }

    closeWindow(address: string) {
        return this._dispatch(`hl.dsp.window.close({ ${this._winSel(address)} })`)
    }

    sendToWorkspace(address: string, wsId: number) {
        return this._dispatch(`hl.dsp.window.move({ workspace = ${wsId}, ${this._winSel(address)} })`)
    }

    floatWindow(address: string) {
        return this._dispatch(`hl.dsp.window.float({ action = 'toggle', ${this._winSel(address)} })`)
    }

    /** Pseudo-tile toggle. NOTE: pseudo state is NOT readable (`hyprctl clients -j`
     *  has no `pseudo` field, nor does HL.Window) — callers can't show a check. */
    togglePseudo(address: string) {
        return this._dispatch(`hl.dsp.window.pseudo({ ${this._winSel(address)} })`)
    }

    /** Pin = visible on every workspace (floating windows only). */
    togglePin(address: string) {
        return this._dispatch(`hl.dsp.window.pin({ ${this._winSel(address)} })`)
    }

    toggleFullscreen(address: string) {
        return this._dispatch(`hl.dsp.window.fullscreen({ ${this._winSel(address)} })`)
    }

    /** Center on screen (floating windows only). */
    centerWindow(address: string) {
        return this._dispatch(`hl.dsp.window.center({ ${this._winSel(address)} })`)
    }

    async floatAllInWorkspace(wsId: number) {
        // Window state comes from hyprctl, NOT AstalHyprland.Client.floating —
        // that prop goes stale (a tiled window can read floating=true), which
        // made this skip windows and the menu draw wrong checks (2026-06-11).
        const arr = await this.getClientsJson()
        for (const c of arr) {
            if (c.workspace?.id === wsId && !c.floating) await this.floatWindow(c.address)
        }
    }

    // Group vocabulary — verified live 2026-06-11: `group.toggle` accepts the
    // window selector (creates a lone group / dissolves the whole group);
    // `window.move({ out_of_group })` pulls ONE window out and also honors the
    // selector. `into_group` does NOT take a selector (acts on the focused
    // window only) and tab switching is just `focusWindow` on a member address.
    toggleGroup(address?: string) {
        return this._dispatch(address
            ? `hl.dsp.group.toggle({ ${this._winSel(address)} })`
            : `hl.dsp.group.toggle()`)
    }

    moveOutOfGroup(address: string) {
        return this._dispatch(`hl.dsp.window.move({ out_of_group = true, ${this._winSel(address)} })`)
    }

    sendToSpecial(name = "magic") {
        return this._dispatch(`hl.dsp.window.move({ workspace = 'special:${name}' })`)
    }

    /** One-shot raw read of ALL clients from hyprctl. This is the authoritative
     *  window state: AstalHyprland.Client props (floating, fullscreen) go stale,
     *  and pinned/grouped aren't exposed at all. Called on demand (menu open,
     *  bulk ops) — deliberately NOT part of _refresh, which runs on every IPC
     *  event. Returns [] on failure. */
    async getClientsJson(): Promise<any[]> {
        try { return JSON.parse(await execAsync(["hyprctl", "clients", "-j"])) }
        catch (e) { console.error("[HyprlandState] getClientsJson:", e); return [] }
    }

    /** getClientsJson narrowed to one window (null if gone). */
    async getClientJson(address: string): Promise<any | null> {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return (await this.getClientsJson()).find((c: any) => c.address === addr) ?? null
    }

    setLayout(layout: "dwindle" | "master") {
        return this.evalLua(`hl.config({ general = { layout = '${layout}' } })`)
    }
}

const hs = new HyprlandStateClass()
export default hs

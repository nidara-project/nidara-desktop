import GObject from "gi://GObject"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import { execAsync } from "ags/process"

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
            Signals: { "changed": {} },
        }, this)
    }

    private readonly hl: AstalHyprland.Hyprland
    private _refreshPending = false

    // Cached raw arrays — one refresh per signal batch, shared by all consumers
    clients:    AstalHyprland.Client[]    = []
    workspaces: AstalHyprland.Workspace[] = []
    monitors:   AstalHyprland.Monitor[]   = []

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
        // Avoid notify::clients and notify::focused-* — AstalHyprland re-emits them
        // whenever it rebuilds its internal state (e.g. on windowtitle events from Chrome/
        // YouTube), even when the logical state hasn't changed. TRACKED_EVENTS IPC signals
        // cover all structural changes: focus (activewindow), workspace (workspace),
        // open/close (openwindow/closewindow), move (movewindow), monitor (focusedmon).
        this.hl.connect("monitor-added",   refresh)
        this.hl.connect("monitor-removed", refresh)
        this.hl.connect("event", (_h: any, name: string, data: string) => {
            if (name === "submap") {
                this.submap = data || ""
                this._scheduleRefresh()
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
    // Single source of truth for all hyprctl dispatch strings

    focusWorkspace(id: number) {
        return execAsync(["hyprctl", "dispatch", `hl.dsp.focus({ workspace = ${id}})`])
            .catch(console.error)
    }

    focusWindow(address: string) {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return execAsync(["hyprctl", "dispatch", `hl.dsp.focus({ window = 'address:${addr}'})`])
            .catch(console.error)
    }

    closeWindow(address: string) {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return execAsync(["hyprctl", "dispatch", `hl.dsp.window.close({ window = 'address:${addr}'})`])
            .catch(console.error)
    }

    sendToWorkspace(address: string, wsId: number) {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return execAsync(["hyprctl", "dispatch", `movetoworkspace ${wsId},address:${addr}`])
            .catch(console.error)
    }

    floatWindow(address: string) {
        const addr = address.startsWith("0x") ? address : "0x" + address
        return execAsync(["hyprctl", "dispatch", `togglefloating address:${addr}`])
            .catch(console.error)
    }

    async floatAllInWorkspace(wsId: number) {
        const clients = this.clientsByWorkspace.get(wsId) || []
        for (const c of clients) {
            if (!(c as any).floating) await this.floatWindow(c.address)
        }
    }

    toggleGroup() {
        return execAsync(["hyprctl", "dispatch", "togglegroup"]).catch(console.error)
    }

    sendToSpecial(name = "magic") {
        return execAsync(["hyprctl", "dispatch", `movetoworkspace special:${name}`])
            .catch(console.error)
    }

    setLayout(layout: "dwindle" | "master") {
        return execAsync(["hyprctl", "keyword", "general:layout", layout])
            .catch(console.error)
    }
}

const hs = new HyprlandStateClass()
export default hs

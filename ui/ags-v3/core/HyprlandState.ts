import GObject from "gi://GObject"
import AstalHyprland from "gi://AstalHyprland"
import { execAsync } from "ags/process"

// Tracked IPC event names that require a full state refresh
const TRACKED_EVENTS = [
    "workspace", "activewindow", "activewindowv2",
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

    // Cached raw arrays — one refresh per signal batch, shared by all consumers
    clients:    AstalHyprland.Client[]    = []
    workspaces: AstalHyprland.Workspace[] = []
    monitors:   AstalHyprland.Monitor[]   = []

    // Pre-computed derived state — rebuilt on every refresh
    clientsByWorkspace = new Map<number, AstalHyprland.Client[]>()
    occupiedWorkspaces = new Set<number>()
    specialWorkspaces:  AstalHyprland.Workspace[] = []
    submap = ""

    // Direct proxies — no caching needed, these are lightweight GObject accessors
    get focusedWorkspace() { return this.hl.focused_workspace }
    get focusedClient()    { return this.hl.focused_client }
    get focusedMonitor()   { return this.hl.focused_monitor }

    constructor() {
        super()
        this.hl = AstalHyprland.get_default()

        const refresh = () => this._refresh()
        this.hl.connect("notify::clients",           refresh)
        this.hl.connect("notify::focused-workspace", refresh)
        this.hl.connect("notify::focused-client",    refresh)
        this.hl.connect("monitor-added",             refresh)
        this.hl.connect("monitor-removed",           refresh)
        this.hl.connect("event", (_h: any, name: string, data: string) => {
            if (name === "submap") {
                this.submap = data || ""
                this.emit("changed")
                return
            }
            if (TRACKED_EVENTS.includes(name)) refresh()
        })

        this._refresh()
    }

    private _refresh() {
        try {
            this.clients    = this.hl.get_clients()    || []
            this.workspaces = this.hl.get_workspaces() || []
            this.monitors   = this.hl.get_monitors()   || []

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

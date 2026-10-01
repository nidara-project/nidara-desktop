// HyaloState — Hyalo's side of `core/CompositorState.ts` (read its header): the shell's
// windows, workspaces and monitors from Hyalo's IPC, and every window-manager command
// sent back through it.
//
// Hyalo's window manager (hyalo/compositor/src/wm/) keeps the state and announces every
// change on its event stream: `windows_changed`, `workspaces_changed`, `focus_changed`
// (each once per round of its event loop, with the whole list), `window_title_changed` on
// its own, `outputs_changed`. So unlike HyprlandState there is nothing to re-read after an
// event and no focus to reconcile — Hyalo's answer about the focused window is the truth,
// grab or no grab. Commands are the ones its key bindings use (`wm/actions.rs`), sent as
// `{"request":"do","command":…}`.
//
// Addresses: Hyalo names a window by a number; the shell's address is that number in
// bare hex, the shape every surface already compares with `bareAddr`.

import GObject from "gi://GObject"
import GLib from "gi://GLib"
import * as hyalo from "./hyalo-ipc"
import {
    bareAddr, FULLSCREEN, type ClientGeometry, type Compositor, type CompositorCaps,
    type CompositorMonitor, type CompositorWindow, type CompositorWorkspace,
    type WindowSnapshot, type WorkspaceSnapshot, TRANSFORM_NAMES,
} from "./compositor-types"

/** Hyalo's `windows` entry (hyalo/compositor/src/ipc/mod.rs WindowInfo). */
interface HyaloWindow {
    id: number
    app_id: string
    title: string
    initial_app_id: string
    initial_title: string
    pid: number | null
    parent: number | null
    workspace: number
    output: string
    floating: boolean
    fullscreen: "none" | "maximized" | "fullscreen"
    pinned: boolean
    pseudo: boolean
    focused: boolean
    visible: boolean
    focus_order: number
    x: number
    y: number
    width: number
    height: number
}

/** Hyalo's `workspaces` entry (WorkspaceInfo). */
interface HyaloWorkspace {
    id: number
    name: string
    output: string
    special: boolean
    mode: "floating" | "tiling"
    windows: number
    active: boolean
    focused: boolean
    last_window: number | null
}

interface HyaloLayer {
    output: string
    layer: string
    namespace: string
    x: number
    y: number
    width: number
    height: number
}

const FS_MODE = { none: 0, maximized: 1, fullscreen: FULLSCREEN } as const

const addrOf = (id: number) => id.toString(16)
/** The window id an address names, or null. */
const idOf = (address: string): number | null => {
    const n = parseInt(bareAddr(address), 16)
    return Number.isFinite(n) ? n : null
}

/** One Hyalo command. Hyalo's refusal ("no window has the focus") is logged, not thrown:
 *  every caller is a click or an IPC verb, and the click's surface already closed. */
function run(command: string): Promise<void> {
    const reply = hyalo.request({ request: "do", command })
    if (!reply) console.error(`[HyaloState] ${command}: Hyalo could not be reached`)
    else if (reply.error) console.error(`[HyaloState] ${command}: ${reply.error}`)
    return Promise.resolve()
}

/** `run` on one window, if the address names one. */
function onWindow(verb: string, address: string, ...after: (string | number)[]): Promise<void> {
    const id = idOf(address)
    if (id === null) return Promise.resolve()
    return run([verb, ...after, id].join(" "))
}

export class HyaloStateClass extends GObject.Object implements Compositor {
    static {
        GObject.registerClass({
            GTypeName: "NidaraHyaloState",
            // The same three signals as HyprlandState, with the same meaning.
            Signals: {
                "changed": {},
                "config-reloaded": {},
                "title-changed": { param_types: [GObject.TYPE_STRING] },
            },
        }, this)
    }

    readonly kind = "hyalo" as const
    // No tab groups and dwindle only (owner, 2026-10-01); the glow comes with #684.
    readonly caps: CompositorCaps = { groups: false, layouts: false, glow: false, backdropCapture: false }

    clients: CompositorWindow[] = []
    workspaces: CompositorWorkspace[] = []
    monitors: CompositorMonitor[] = []
    clientsByWorkspace = new Map<number, CompositorWindow[]>()
    occupiedWorkspaces = new Set<number>()
    specialWorkspaces: CompositorWorkspace[] = []
    focusedWorkspaceId = 0

    private _windows: HyaloWindow[] = []
    private _workspaces: HyaloWorkspace[] = []
    private _outputs: hyalo.HyaloOutput[] = []
    private _focusedId: number | null = null
    private _lastSig = ""
    private _focusWaiters = new Set<() => void>()

    constructor() {
        super()
        this._windows = hyalo.request({ request: "windows" })?.ok?.windows ?? []
        this._workspaces = hyalo.request({ request: "workspaces" })?.ok?.workspaces ?? []
        this._outputs = hyalo.getOutputs()
        this._focusedId = this._windows.find(w => w.focused)?.id ?? null
        this._rebuild()
        hyalo.subscribeEvents(ev => this._onEvent(ev))
    }

    private _onEvent(ev: { event: string; [k: string]: any }) {
        switch (ev.event) {
            case "windows_changed":
                this._windows = ev.windows ?? []
                break
            case "workspaces_changed":
                this._workspaces = ev.workspaces ?? []
                break
            case "outputs_changed":
                this._outputs = ev.outputs ?? []
                break
            case "focus_changed":
                this._focusedId = ev.id ?? null
                for (const w of [...this._focusWaiters]) w()
                break
            case "window_title_changed": {
                const c = this.clients.find(c => c.address === addrOf(ev.id))
                const w = this._windows.find(w => w.id === ev.id)
                if (w) w.title = ev.title
                if (c && c.title !== ev.title) {
                    c.title = ev.title
                    this.emit("title-changed", c.address)
                }
                return
            }
            case "config_reloaded":
                this.emit("config-reloaded")
                return
            default:
                return
        }
        this._rebuild()
    }

    /** The shell's shapes from Hyalo's lists; "changed" only when something a surface
     *  draws moved (titles excluded, as on Hyprland — they have their own signal). */
    private _rebuild() {
        const outputs = this._outputs.filter(o => o.enabled)
        const outIndex = (name: string) => outputs.findIndex(o => o.name === name)
        const wsName = (id: number) => this._workspaces.find(w => w.id === id)?.name ?? String(id)

        this.clients = this._windows.map(w => ({
            address: addrOf(w.id),
            class: w.app_id,
            title: w.title,
            initialClass: w.initial_app_id,
            initialTitle: w.initial_title,
            pid: w.pid ?? 0,
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
            workspace: { id: w.workspace, name: wsName(w.workspace) },
            monitor: outIndex(w.output),
            floating: w.floating,
            pinned: w.pinned,
            mapped: true,
            hidden: !w.visible,
            xwayland: false,
            fullscreen: FS_MODE[w.fullscreen] ?? 0,
        }))

        this.workspaces = this._workspaces.map(w => ({
            id: w.id,
            name: w.name,
            monitor: w.output,
            monitorID: outIndex(w.output),
            windows: w.windows,
            hasfullscreen: this._windows.some(x => x.workspace === w.id && x.fullscreen === "fullscreen"),
            lastwindow: w.last_window != null ? addrOf(w.last_window) : "",
            lastwindowtitle: this._windows.find(x => x.id === w.last_window)?.title ?? "",
        }))

        const focusedOutput = this._workspaces.find(w => w.focused)?.output
            ?? this._windows.find(w => w.focused)?.output
            ?? outputs[0]?.name
        this.monitors = outputs.map((o, i) => {
            const active = this._workspaces.find(w => w.output === o.name && w.active && !w.special)
            const special = this._workspaces.find(w => w.output === o.name && w.active && w.special)
            const m = o.current_mode
            return {
                id: i,
                name: o.name,
                description: [o.make, o.model].filter(Boolean).join(" "),
                make: o.make,
                model: o.model,
                serial: o.serial,
                width: m?.width ?? 0,
                height: m?.height ?? 0,
                refreshRate: (m?.refresh ?? 0) / 1000,
                x: o.position?.[0] ?? 0,
                y: o.position?.[1] ?? 0,
                scale: o.scale,
                transform: Math.max(0, TRANSFORM_NAMES.indexOf(o.transform)),
                focused: o.name === focusedOutput,
                disabled: false,
                activeWorkspace: { id: active?.id ?? 0, name: active?.name ?? "" },
                specialWorkspace: { id: special?.id ?? 0, name: special?.name ?? "" },
                availableModes: o.modes.map(md => `${md.width}x${md.height}@${(md.refresh / 1000).toFixed(2)}Hz`),
            }
        })

        this.focusedWorkspaceId = this.focusedMonitor?.activeWorkspace.id ?? this.focusedWorkspaceId

        this.clientsByWorkspace.clear()
        this.occupiedWorkspaces.clear()
        this.specialWorkspaces = []
        for (const ws of this.workspaces) {
            if (ws.id < 0) this.specialWorkspaces.push(ws)
            else this.occupiedWorkspaces.add(ws.id)
        }
        for (const c of this.clients) {
            if (!this.clientsByWorkspace.has(c.workspace.id)) this.clientsByWorkspace.set(c.workspace.id, [])
            this.clientsByWorkspace.get(c.workspace.id)!.push(c)
        }

        let sig = `${this.focusedWorkspaceId}|${this._focusedId ?? ""}`
        for (const c of this.clients)
            sig += `;${c.address},${c.class},${c.x},${c.y},${c.width},${c.height},${c.fullscreen},${c.floating},${c.workspace.id},${c.hidden}`
        sig += "#"
        for (const w of this.workspaces) sig += `${w.id}:${w.monitor},`
        sig += "#"
        for (const m of this.monitors) sig += `${m.name}:${m.x},${m.y},${m.width}x${m.height}@${m.scale},${m.focused},${m.activeWorkspace.id},${m.specialWorkspace.id};`
        if (sig !== this._lastSig) {
            this._lastSig = sig
            this.emit("changed")
        }
    }

    get focusedWorkspace(): CompositorWorkspace | null {
        return this.workspaces.find(w => w.id === this.focusedWorkspaceId) ?? null
    }

    get focusedMonitor(): CompositorMonitor | null {
        return this.monitors.find(m => m.focused) ?? this.monitors[0] ?? null
    }

    get focusedClient(): CompositorWindow | null {
        if (this._focusedId === null) return null
        return this.clients.find(c => c.address === addrOf(this._focusedId!)) ?? null
    }

    isRealFullscreen(client: CompositorWindow | null | undefined): boolean {
        return !!client && client.fullscreen === FULLSCREEN
    }

    // ── Fresh reads: Hyalo answers from its model, so "fresh" is one request away.

    async readWindows(): Promise<WindowSnapshot[]> {
        const list: HyaloWindow[] = hyalo.request({ request: "windows" })?.ok?.windows ?? []
        const wsName = (id: number) => this.workspaces.find(w => w.id === id)?.name ?? String(id)
        return list.map(w => ({
            address: "0x" + addrOf(w.id),
            class: w.app_id,
            title: w.title,
            workspace: { id: w.workspace, name: wsName(w.workspace) },
            at: [w.x, w.y],
            size: [w.width, w.height],
            floating: w.floating,
            fullscreen: FS_MODE[w.fullscreen] ?? 0,
            pinned: w.pinned,
            grouped: [],
        }))
    }

    async readWindow(address: string): Promise<WindowSnapshot | null> {
        const bare = bareAddr(address)
        return (await this.readWindows()).find(w => bareAddr(w.address) === bare) ?? null
    }

    async readWorkspaces(): Promise<WorkspaceSnapshot[]> {
        const list: HyaloWorkspace[] = hyalo.request({ request: "workspaces" })?.ok?.workspaces ?? []
        return list.map(w => ({ id: w.id, name: w.name, monitor: w.output, windows: w.windows }))
    }

    async readGeometry(): Promise<ClientGeometry> {
        const map: ClientGeometry = new Map()
        for (const w of (await this.readWindows()))
            map.set(bareAddr(w.address), { x: w.at[0], y: w.at[1], width: w.size[0], height: w.size[1] })
        return map
    }

    async version(): Promise<string> {
        return hyalo.request({ request: "version" })?.ok?.version ?? ""
    }

    private _layers(): HyaloLayer[] {
        return hyalo.request({ request: "layers" })?.ok?.layers ?? []
    }

    async layerTop(namespace: string, monitor?: string): Promise<number | null> {
        const l = this._layers().find(l => l.namespace === namespace && (!monitor || l.output === monitor))
        return l ? l.y : null
    }

    async isLayerAbove(a: string, b: string): Promise<boolean | null> {
        const layers = this._layers()
        // Listed bottom first within each output and level: later = above.
        for (const out of new Set(layers.map(l => `${l.output}/${l.layer}`))) {
            const list = layers.filter(l => `${l.output}/${l.layer}` === out)
            const ia = list.findIndex(l => l.namespace === a)
            const ib = list.findIndex(l => l.namespace === b)
            if (ia >= 0 && ib >= 0) return ia > ib
        }
        return null
    }

    // ── Window management.

    focusWorkspace(id: number) { return run(`workspace ${id}`) }
    focusWorkspaceFromShell(id: number) { return this.focusWorkspace(id) }

    focusWorkspaceArg(arg: string) {
        // Hyprland's spellings, which the shell's IPC verbs pass through: `+1`/`-1` are
        // relative, `r+1` the same; a name Hyalo does not have is refused there.
        const a = arg.trim()
        const rel = a.match(/^[er]?([+-]\d+)$/)
        if (rel) {
            const step = parseInt(rel[1], 10)
            const dir = step > 0 ? "e+1" : "e-1"
            let p = Promise.resolve()
            for (let i = 0; i < Math.abs(step); i++) p = p.then(() => run(`workspace ${dir}`))
            return p
        }
        return run(`workspace ${a}`)
    }

    focusDirection(dir: "left" | "right" | "up" | "down") { return run(`focus ${dir}`) }
    focusWindow(address: string) { return onWindow("focus-window", address) }
    closeWindow(address: string) { return onWindow("close-window", address) }
    sendToWorkspace(address: string, wsId: number) { return onWindow("move-to-workspace-silent", address, wsId) }
    floatWindow(address: string) { return onWindow("toggle-floating", address) }
    enableFloatWindow(address: string) { return onWindow("float", address) }
    tileWindow(address: string) { return onWindow("tile", address) }
    togglePseudo(address: string) { return onWindow("pseudo", address) }
    togglePin(address: string) { return onWindow("pin", address) }
    toggleFullscreen(address: string) { return onWindow("fullscreen", address) }
    centerWindow(address: string) { return onWindow("center", address) }
    floatAllInWorkspace(wsId: number) { return run(`float-all ${wsId}`) }
    tileAllInWorkspace(wsId: number) { return run(`tile-all ${wsId}`) }

    /** Every numbered workspace the shell offers (1–5) gets its effective mode stated;
     *  Hyalo reorganizes only those whose mode changed. Workspaces beyond follow Hyalo's own
     *  default (`[workspaces]` in hyalo.toml). */
    async applyWorkspaceModes(defaultMode: "floating" | "tiling", overrides: Record<string, "floating" | "tiling">) {
        for (let ws = 1; ws <= 5; ws++) await run(`set-workspace-mode ${ws} ${overrides[String(ws)] ?? defaultMode}`)
    }

    sendToSpecial(name = "magic", address?: string) {
        const id = address ? idOf(address) : null
        return run(id !== null ? `move-to-special ${name} ${id}` : `move-to-special ${name}`)
    }

    // No tab groups and one tiling layout on Hyalo (`caps`): a caller that did not ask
    // first gets told, not a silent nothing.
    toggleGroup(_address?: string) {
        console.warn("[HyaloState] toggleGroup: Hyalo has no tab groups (caps.groups)")
        return Promise.resolve()
    }

    moveOutOfGroup(_address: string) { return this.toggleGroup() }

    setLayout(layout: "dwindle" | "master") {
        if (layout !== "dwindle") console.warn(`[HyaloState] setLayout ${layout}: Hyalo tiles with dwindle only (caps.layouts)`)
        return Promise.resolve()
    }

    // ── Focus after a grab. Hyalo hands the keyboard back to where it was when a focus
    // grab ends (hyalo/compositor/src/protocols/focus_grab.rs), and to the focused window
    // when a panel that had it goes away — so there is nothing to restore here.

    restoreFocusAfterGrab() { /* Hyalo restores it itself. */ }

    /** `cb` once Hyalo has applied a release: its next focus announcement, or 80 ms —
     *  the same contract (and the same fallback) as on Hyprland. */
    afterGrabRelease(cb: () => void) {
        let done = false
        let timer = 0
        const go = () => {
            if (done) return
            done = true
            this._focusWaiters.delete(go)
            if (timer) { GLib.source_remove(timer); timer = 0 }
            cb()
        }
        this._focusWaiters.add(go)
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => { timer = 0; go(); return GLib.SOURCE_REMOVE })
    }

    reevaluatePointerFocus() { return run("refocus-pointer") }

    async cursorPosition(): Promise<[number, number] | null> {
        const p = hyalo.request({ request: "cursor_position" })?.ok
        return p ? [Math.round(p.x), Math.round(p.y)] : null
    }

    // ── The pointer, the glow, the config, pictures.

    setCursor(theme: string, size: number) { return run(`set-cursor ${theme} ${size}`) }
    setRealCursorVisible(visible: boolean) { return run(`cursor-visible ${visible ? "on" : "off"}`) }
    setGlow(_enabled: boolean) { return Promise.resolve() }
    async supportsGlow() { return false }

    reloadConfig() {
        const reply = hyalo.request({ request: "reload_config" })
        if (reply?.error) console.error("[HyaloState] reload:", reply.error)
        return Promise.resolve()
    }

    async screenshot(path: string, monitor?: string): Promise<void> {
        const output = monitor ?? this.focusedMonitor?.name
        const reply = hyalo.request({ request: "screenshot", path, ...(output ? { output } : {}) })
        if (!reply) throw new Error("Hyalo could not be reached")
        if (reply.error) throw new Error(reply.error)
    }
}

let instance: HyaloStateClass | null = null

/** The one HyaloState, created on first call. Only `core/CompositorState.ts` calls it. */
export function createHyaloState(): HyaloStateClass {
    return instance ??= new HyaloStateClass()
}

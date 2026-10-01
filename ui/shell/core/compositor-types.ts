// compositor-types.ts — the shapes and the interface of `core/CompositorState.ts`, apart
// from it so both backends can import them without importing each other. Read the header
// of CompositorState.ts first.

/** A window. `address` is bare hex (no `0x`) — compare with `bareAddr()` regardless. */
export interface CompositorWindow {
    address: string
    /** The Wayland app id (X11 class under XWayland). */
    class: string
    title: string
    /** What it was called when it opened: what a rule that runs once, at open, sees. */
    initialClass: string
    initialTitle: string
    pid: number
    x: number
    y: number
    width: number
    height: number
    workspace: { id: number; name: string }
    /** Index into `monitors`. */
    monitor: number
    floating: boolean
    pinned: boolean
    mapped: boolean
    hidden: boolean
    xwayland: boolean
    /** 0 none, 1 maximized, 2 fullscreen — NOT a boolean (`isRealFullscreen`). */
    fullscreen: number
}

export interface CompositorWorkspace {
    /** Negative for a special (scratchpad) workspace, whose name is `special:<name>`. */
    id: number
    name: string
    /** The connector it is on (`DP-1`). */
    monitor: string
    monitorID: number
    windows: number
    hasfullscreen: boolean
    /** Bare address of the window this workspace would focus, "" if none. */
    lastwindow: string
    lastwindowtitle: string
}

export interface CompositorMonitor {
    id: number
    name: string
    description: string
    make: string
    model: string
    serial: string
    /** The mode, in pixels. */
    width: number
    height: number
    refreshRate: number
    /** Logical position. */
    x: number
    y: number
    scale: number
    /** wl_output transform, 0–7. */
    transform: number
    focused: boolean
    disabled: boolean
    activeWorkspace: { id: number; name: string }
    specialWorkspace: { id: number; name: string }
    availableModes: string[]
}

/** A window as the compositor reports it RIGHT NOW (`readWindows`): authoritative where
 *  the cached `clients` is a snapshot of the last event. `address` is `0x`-prefixed,
 *  `at`/`size` are [x, y] / [w, h] — the shape `listWindows` hands to agents. */
export interface WindowSnapshot {
    address: string
    class: string
    title: string
    workspace: { id: number; name: string }
    at: [number, number]
    size: [number, number]
    floating: boolean
    fullscreen: number
    pinned: boolean
    /** Addresses of the windows in its tab group, itself included; [] when ungrouped. */
    grouped: string[]
}

export interface WorkspaceSnapshot {
    id: number
    name: string
    monitor: string
    windows: number
}

export interface ClientGeom { x: number; y: number; width: number; height: number }
export type ClientGeometry = Map<string, ClientGeom>

/** What one compositor can do and the other cannot. A surface asks before it offers. */
export interface CompositorCaps {
    /** Tab groups (Hyprland). Hyalo has none, by the owner's decision. */
    groups: boolean
    /** A choice of tiling layout (`setLayout`). Hyalo has dwindle only, for now. */
    layouts: boolean
    /** The inner glow the Assistant lights on the window it works in (Hyprland ≥ 0.56). */
    glow: boolean
}

export type CompositorKind = "hyprland" | "hyalo"
export type CompositorSignal = "changed" | "config-reloaded" | "title-changed"

/** wl_output transforms by number, in protocol order (Hyalo names them; Hyprland numbers). */
export const TRANSFORM_NAMES = [
    "normal", "90", "180", "270", "flipped", "flipped-90", "flipped-180", "flipped-270",
]

/** Real fullscreen (over the bar), as opposed to maximized. */
export const FULLSCREEN = 2

export const bareAddr = (s?: string) => (s ?? "").toLowerCase().replace(/^0x/, "")

export interface Compositor {
    readonly kind: CompositorKind
    readonly caps: CompositorCaps

    // ── State, rebuilt from the compositor's events; read straight after "changed".
    clients: CompositorWindow[]
    workspaces: CompositorWorkspace[]
    monitors: CompositorMonitor[]
    clientsByWorkspace: Map<number, CompositorWindow[]>
    /** Normal workspaces that exist. */
    occupiedWorkspaces: Set<number>
    specialWorkspaces: CompositorWorkspace[]
    /** The normal workspace shown on the focused monitor. */
    focusedWorkspaceId: number
    readonly focusedWorkspace: CompositorWorkspace | null
    readonly focusedMonitor: CompositorMonitor | null
    /** The focused window — always one on the focused workspace (or a special one). */
    readonly focusedClient: CompositorWindow | null
    isRealFullscreen(client: CompositorWindow | null | undefined): boolean

    // ── Fresh reads.
    readWindows(): Promise<WindowSnapshot[]>
    readWindow(address: string): Promise<WindowSnapshot | null>
    readWorkspaces(): Promise<WorkspaceSnapshot[]>
    /** Window boxes as of NOW, by bare address (`clients` geometry can be stale). */
    readGeometry(): Promise<ClientGeometry>
    version(): Promise<string>
    /** Top edge (global y) of one of our layer surfaces by namespace, or null. */
    layerTop(namespace: string, monitor?: string): Promise<number | null>
    /** Is layer surface `a` above `b` on the same level? null if not comparable. */
    isLayerAbove(a: string, b: string): Promise<boolean | null>

    // ── Window management. A window is named by its address, bare or `0x`-prefixed.
    focusWorkspace(id: number): Promise<unknown>
    /** Switch workspace from one of OUR surfaces (the app grid, the overview). */
    focusWorkspaceFromShell(id: number): Promise<unknown>
    /** `e+1`, `e-1`, `previous`, or a number. */
    focusWorkspaceArg(arg: string): Promise<unknown>
    focusDirection(dir: "left" | "right" | "up" | "down"): Promise<unknown>
    /** Focus AND raise. The one door every route to a window goes through. */
    focusWindow(address: string): Promise<unknown>
    closeWindow(address: string): Promise<unknown>
    sendToWorkspace(address: string, wsId: number): Promise<unknown>
    /** Toggle. */
    floatWindow(address: string): Promise<unknown>
    enableFloatWindow(address: string): Promise<unknown>
    tileWindow(address: string): Promise<unknown>
    togglePseudo(address: string): Promise<unknown>
    togglePin(address: string): Promise<unknown>
    toggleFullscreen(address: string): Promise<unknown>
    centerWindow(address: string): Promise<unknown>
    floatAllInWorkspace(wsId: number): Promise<unknown>
    tileAllInWorkspace(wsId: number): Promise<unknown>
    /** No address = the focused window. */
    sendToSpecial(name?: string, address?: string): Promise<unknown>
    /** Floating or tiling per workspace (#513): the default, and the workspaces that differ.
     *  A workspace whose mode CHANGES re-floats or re-tiles its windows; re-stating the same
     *  mode moves nothing. */
    applyWorkspaceModes(defaultMode: "floating" | "tiling", overrides: Record<string, "floating" | "tiling">): Promise<unknown>
    /** `caps.groups` only. */
    toggleGroup(address?: string): Promise<unknown>
    moveOutOfGroup(address: string): Promise<unknown>
    /** `caps.layouts` only. */
    setLayout(layout: "dwindle" | "master"): Promise<unknown>

    // ── Focus after our own surfaces let go of the keyboard (common/FocusGrab.ts).
    restoreFocusAfterGrab(): void
    afterGrabRelease(cb: () => void): void
    /** Where the real pointer is (global logical), or null when it cannot be read. */
    cursorPosition(): Promise<[number, number] | null>
    /** Re-decide what the pointer is over without moving it. */
    reevaluatePointerFocus(): Promise<unknown>

    // ── The pointer, the glow, the config, pictures.
    setCursor(theme: string, size: number): Promise<unknown>
    /** Draw the real pointer or not; input is unaffected. Whoever hides it restores it. */
    setRealCursorVisible(visible: boolean): Promise<unknown>
    setGlow(enabled: boolean): Promise<unknown>
    supportsGlow(): Promise<boolean>
    reloadConfig(): Promise<unknown>
    /** A PNG of one monitor (the focused one when unnamed) at `path`. Throws on failure. */
    screenshot(path: string, monitor?: string): Promise<void>
}

/** The compositor with its GObject signals: "changed" = windows/workspaces/focus/monitors
 *  (structural, often); "title-changed"(bareAddr) = a window renamed itself and nothing
 *  else; "config-reloaded" = the compositor re-read its configuration. (Apart from
 *  `Compositor` because each backend's `connect` is typed by its GObject class.) */
export type CompositorObject = Compositor & {
    connect(signal: CompositorSignal, cb: (...args: any[]) => any): number
    disconnect(id: number): void
}

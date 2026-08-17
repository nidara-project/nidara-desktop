// hypr-ipc.ts — Hyprland's two unix sockets, spoken directly.
//
// This is what AstalHyprland was: `$XDG_RUNTIME_DIR/hypr/$HIS/.socket.sock` takes
// a command and answers with JSON, `.socket2.sock` streams `EVENT>>DATA` lines.
// Nothing else. It is deliberately dumb — no caching, no derived state, no
// GObjects; `core/HyprlandState.ts` owns all of that and is the only module that
// should import this one.
//
// **Why not `hyprctl`.** The shell already shells out to it for writes and
// on-demand reads, and that is fine because those are async and rare. The state
// refresh is neither: it runs on every structural event, and a process spawn
// costs milliseconds on the main loop. Measured on this box — the four reads a
// refresh needs (clients, workspaces, monitors, activewindow) take **1.1 ms
// total** over the socket; the same four as `hyprctl` subprocesses are an order
// of magnitude worse. Sync socket reads are what let `_refresh` stay
// synchronous, which every consumer depends on (they read `hs.clients` straight
// after "changed").
//
// 🔑 **Addresses come back BARE here**, without the `0x` prefix, because that is
// what AstalHyprland handed out (`address.replace("0x", "")`) and the whole shell
// is written against it — including the dispatchers that build `address:0x${a}`.
// A prefixed address would silently produce `address:0x0x…`, which Hyprland
// answers by doing nothing at all. Compare with `bareAddr()` regardless.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

/** A window. Field names match what AstalHyprland exposed, not raw hyprctl JSON:
 *  `at`/`size` are unpacked into x/y/width/height and the address is bare. */
export interface HyprClient {
    address: string
    class: string
    title: string
    initialClass: string
    initialTitle: string
    pid: number
    x: number
    y: number
    width: number
    height: number
    workspace: { id: number; name: string }
    monitor: number
    floating: boolean
    pinned: boolean
    mapped: boolean
    hidden: boolean
    xwayland: boolean
    /** Hyprland's FSMODE int — 0 none, 1 maximized, 2 fullscreen. NOT a boolean. */
    fullscreen: number
}

export interface HyprWorkspace {
    id: number
    name: string
    monitor: string
    monitorID: number
    windows: number
    hasfullscreen: boolean
    /** Bare address of the window this workspace would focus, "" if none. */
    lastwindow: string
    lastwindowtitle: string
}

export interface HyprMonitor {
    id: number
    name: string
    description: string
    make: string
    model: string
    serial: string
    width: number
    height: number
    refreshRate: number
    x: number
    y: number
    scale: number
    transform: number
    focused: boolean
    disabled: boolean
    activeWorkspace: { id: number; name: string }
    specialWorkspace: { id: number; name: string }
    availableModes: string[]
}

/** Hyprland's FSMODE for real fullscreen (`isRealFullscreen` is the reader). */
export const FSMODE_FULLSCREEN = 2

const bare = (s?: string) => (s ?? "").replace(/^0x/, "")

function socketDir(): string | null {
    const sig = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")
    const rt = GLib.getenv("XDG_RUNTIME_DIR")
    if (!sig || !rt) return null
    return `${rt}/hypr/${sig}`
}

/** Send one command, read the whole reply. Sync on purpose — see the header. */
export function request(cmd: string): string | null {
    const dir = socketDir()
    if (!dir) return null
    let conn: any = null
    try {
        conn = new Gio.SocketClient().connect(
            Gio.UnixSocketAddress.new(`${dir}/.socket.sock`), null)
        conn.get_output_stream().write_all(new TextEncoder().encode(cmd), null)
        // Hyprland closes its side after answering, so "read to EOF" terminates.
        const dis = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
        let out = ""
        for (;;) {
            const [line] = dis.read_line_utf8(null)
            if (line === null) break
            out += line + "\n"
        }
        return out
    } catch (e) {
        console.error(`[HyprIPC] request ${cmd} failed:`, e)
        return null
    } finally {
        try { conn?.close(null) } catch { /* already gone */ }
    }
}

function requestJson<T>(cmd: string, fallback: T): T {
    const raw = request(cmd)
    if (!raw) return fallback
    try { return JSON.parse(raw) as T }
    catch (e) { console.error(`[HyprIPC] ${cmd} returned unparseable JSON:`, e); return fallback }
}

export function getClients(): HyprClient[] {
    const raw = requestJson<any[]>("j/clients", [])
    return raw.map(c => ({
        address: bare(c.address),
        class: c.class ?? "",
        title: c.title ?? "",
        initialClass: c.initialClass ?? "",
        initialTitle: c.initialTitle ?? "",
        pid: c.pid ?? 0,
        // hyprctl reports geometry as at:[x,y] / size:[w,h]; the shell has always
        // read four scalars off the Astal object, so unpack here rather than in
        // a dozen call sites.
        x: c.at?.[0] ?? 0,
        y: c.at?.[1] ?? 0,
        width: c.size?.[0] ?? 0,
        height: c.size?.[1] ?? 0,
        workspace: { id: c.workspace?.id ?? 0, name: c.workspace?.name ?? "" },
        monitor: c.monitor ?? -1,
        floating: !!c.floating,
        pinned: !!c.pinned,
        mapped: !!c.mapped,
        hidden: !!c.hidden,
        xwayland: !!c.xwayland,
        fullscreen: typeof c.fullscreen === "number" ? c.fullscreen : 0,
    }))
}

export function getWorkspaces(): HyprWorkspace[] {
    const raw = requestJson<any[]>("j/workspaces", [])
    return raw.map(w => ({
        id: w.id ?? 0,
        name: w.name ?? "",
        monitor: w.monitor ?? "",
        monitorID: w.monitorID ?? 0,
        windows: w.windows ?? 0,
        hasfullscreen: !!w.hasfullscreen,
        lastwindow: bare(w.lastwindow),
        lastwindowtitle: w.lastwindowtitle ?? "",
    }))
}

export function getMonitors(): HyprMonitor[] {
    return requestJson<HyprMonitor[]>("j/monitors", [])
}

/** The compositor's own answer to "who is focused", or null. Reconciling that
 *  answer against the focused workspace is HyprlandState's job, not ours. */
export function getActiveClientAddress(): string | null {
    const raw = requestJson<any>("j/activewindow", {})
    const addr = bare(raw?.address)
    return addr ? addr : null
}

type EventHandler = (name: string, data: string) => void

/** Stream `.socket2.sock`. One connection for the process's lifetime.
 *
 *  ⚠️ A dead event socket does not look broken — the shell keeps its last state
 *  and simply stops learning, which is the failure mode tech-debt #71 was about.
 *  So EOF is logged loudly and retried instead of ending the stream quietly. */
export function subscribeEvents(onEvent: EventHandler): void {
    const dir = socketDir()
    if (!dir) {
        console.error("[HyprIPC] no HYPRLAND_INSTANCE_SIGNATURE — running outside Hyprland?")
        return
    }

    let retryDelayS = 1

    const connect = () => {
        let dis: any
        try {
            const conn = new Gio.SocketClient().connect(
                Gio.UnixSocketAddress.new(`${dir}/.socket2.sock`), null)
            dis = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
        } catch (e) {
            console.error("[HyprIPC] event socket connect failed:", e)
            scheduleRetry()
            return
        }
        retryDelayS = 1

        const pump = () => {
            dis.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream: any, res: any) => {
                let line: string | null = null
                try { [line] = stream.read_line_finish_utf8(res) }
                catch (e) {
                    console.error("[HyprIPC] event read failed:", e)
                    scheduleRetry()
                    return
                }
                if (line === null) {
                    console.error("[HyprIPC] event socket closed by Hyprland — reconnecting")
                    scheduleRetry()
                    return
                }
                // "name>>data"; data may itself contain ">>", so split once.
                const sep = line.indexOf(">>")
                if (sep > 0) {
                    try { onEvent(line.slice(0, sep), line.slice(sep + 2)) }
                    catch (e) { console.error("[HyprIPC] event handler threw:", e) }
                }
                pump()
            })
        }
        pump()
    }

    const scheduleRetry = () => {
        const delay = retryDelayS
        retryDelayS = Math.min(retryDelayS * 2, 30)
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            connect()
            return GLib.SOURCE_REMOVE
        })
    }

    connect()
}

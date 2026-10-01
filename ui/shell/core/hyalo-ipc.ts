// hyalo-ipc.ts — Hyalo's IPC socket, spoken directly (hyalo/, #681).
//
// Hyalo is the compositor of our own, a preview session next to Hyprland (#680). Its
// socket is `$HYALO_SOCKET` — exported to the session's services by `uwsm finalize`,
// so the shell finds it in its environment — and it speaks one JSON object per line
// both ways: a request, one reply; or `event_stream`, after which the connection is a
// stream of events. The protocol is defined in hyalo/compositor/src/ipc/mod.rs.
//
// Same shape as hypr-ipc.ts and for the same reasons: deliberately dumb, sync requests
// (a local socket answers in well under a millisecond, and consumers read state straight
// after a change), one long-lived event connection that says so loudly when it dies.
// `core/Displays.ts` is the module that should import this one.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

export interface HyaloMode {
    width: number
    height: number
    /** mHz, as DRM gives it. */
    refresh: number
    preferred: boolean
}

export interface HyaloOutput {
    name: string
    make: string
    model: string
    serial: string
    enabled: boolean
    powered: boolean
    modes: HyaloMode[]
    current_mode: HyaloMode | null
    scale: number
    /** normal, 90, 180, 270, flipped, flipped-90, flipped-180, flipped-270 */
    transform: string
    position: [number, number] | null
    logical_size: [number, number] | null
    vrr_supported: boolean
    vrr_enabled: boolean
}

/** The fields of `set_output`; one left out keeps its current value. */
export interface HyaloOutputSettings {
    enabled?: boolean
    mode?: string
    scale?: number
    transform?: string
    position?: [number, number]
    vrr?: boolean
}

/** Whether the shell is running on Hyalo. */
export function isHyalo(): boolean {
    return !!GLib.getenv("HYALO_SOCKET")
}

function connect(): any | null {
    const path = GLib.getenv("HYALO_SOCKET")
    if (!path) return null
    return new Gio.SocketClient().connect(Gio.UnixSocketAddress.new(path), null)
}

/** One request, one reply: `{ ok }` or `{ error }`; null if Hyalo could not be reached. */
export function request(req: object): { ok?: any; error?: string } | null {
    let conn: any = null
    try {
        conn = connect()
        if (!conn) return null
        conn.get_output_stream().write_all(new TextEncoder().encode(JSON.stringify(req) + "\n"), null)
        // Hyalo keeps the connection open for further requests: read ONE line, then close.
        const dis = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
        const [line] = dis.read_line_utf8(null)
        if (line === null) return null
        return JSON.parse(line)
    } catch (e) {
        console.error(`[HyaloIPC] ${JSON.stringify(req)} failed:`, e)
        return null
    } finally {
        try { conn?.close(null) } catch { /* already gone */ }
    }
}

export function getOutputs(): HyaloOutput[] {
    return request({ request: "outputs" })?.ok?.outputs ?? []
}

/** Applies settings to one output at runtime. Returns Hyalo's refusal, or null. */
export function setOutput(name: string, settings: HyaloOutputSettings): string | null {
    const reply = request({ request: "set_output", name, ...settings })
    if (!reply) return "Hyalo could not be reached"
    return reply.error ?? null
}

type EventHandler = (event: { event: string; [k: string]: any }) => void

/** Stream Hyalo's events for the process's lifetime, reconnecting if the stream dies. */
export function subscribeEvents(onEvent: EventHandler): void {
    if (!isHyalo()) return
    let retryDelayS = 1
    // The connection is HELD: a GIOStream closes its streams when disposed, and a reaped
    // wrapper would close the socket under the pending read (hypr-ipc.ts, 2026-09-30).
    let conn: any = null

    const start = () => {
        let dis: any
        try {
            conn = connect()
            conn.get_output_stream().write_all(new TextEncoder().encode('{"request":"event_stream"}\n'), null)
            dis = new Gio.DataInputStream({ base_stream: conn.get_input_stream() })
        } catch (e) {
            console.error("[HyaloIPC] event stream connect failed:", e)
            scheduleRetry()
            return
        }
        retryDelayS = 1
        let first = true
        const pump = () => {
            dis.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream: any, res: any) => {
                let line: string | null = null
                try { [line] = stream.read_line_finish_utf8(res) }
                catch (e) {
                    console.error("[HyaloIPC] event read failed:", e)
                    scheduleRetry()
                    return
                }
                if (line === null) {
                    console.error("[HyaloIPC] event stream closed by Hyalo — reconnecting")
                    scheduleRetry()
                    return
                }
                // The first line answers the subscription itself.
                if (first) first = false
                else {
                    try { onEvent(JSON.parse(line)) }
                    catch (e) { console.error("[HyaloIPC] event handler threw:", e) }
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
            start()
            return GLib.SOURCE_REMOVE
        })
    }

    start()
}

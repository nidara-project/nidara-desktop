// notifd — the shell client of nidara-sessiond (#819).
//
// The Rust daemon in session/ owns org.freedesktop.Notifications, persistence,
// decoded images and sender expiry. This module owns only a live mirror. DnD and
// the user's popup timeout remain shell policy in NotifConfig / the banners.
// Keep Notification and the facade API stable: no surface knows about the split.
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const BUS_NAME = "org.nidara.Session"
const BUS_PATH = "/org/nidara/Notifications"
const IFACE = "org.nidara.Notifications1"

export const ClosedReason = { EXPIRED: 1, DISMISSED: 2, CLOSED: 3, UNDEFINED: 4 } as const
export const Urgency = { LOW: 0, NORMAL: 1, CRITICAL: 2 } as const

export type NotifAction = { id: string, label: string }

type Hints = Record<string, any>

export class Notification {
    readonly id: number
    readonly app_name: string
    readonly app_icon: string
    readonly summary: string
    readonly body: string
    readonly expire_timeout: number
    readonly time: number
    private readonly hints: Hints
    private readonly actions: NotifAction[]

    constructor(init: {
        id: number, app_name?: string, app_icon?: string, summary?: string, body?: string,
        expire_timeout?: number, time?: number, hints?: Hints, actions?: NotifAction[],
    }) {
        this.id = init.id
        this.app_name = init.app_name ?? ""
        this.app_icon = init.app_icon ?? ""
        this.summary = init.summary ?? ""
        this.body = init.body ?? ""
        this.expire_timeout = init.expire_timeout ?? -1
        this.time = init.time ?? Math.floor(Date.now() / 1000)
        this.hints = init.hints ?? {}
        this.actions = init.actions ?? []
    }

    private str(name: string): string {
        const v = this.hints[name]
        return typeof v === "string" ? v : ""
    }

    /** Standard `image-path` hint — always a PATH here: an `image-data` payload is
     *  decoded to a PNG on arrival (in nidara-sessiond), so the card only ever
     *  has one kind of hero to read.
     *
     *  `image_path` is the 1.1 spelling, still sent by older toolkits. AstalNotifd
     *  read only the modern one, so those senders' heroes were silently dropped. */
    get image(): string { return this.str("image-path") || this.str("image_path") }
    get desktop_entry(): string { return this.str("desktop-entry") }
    get category(): string { return this.str("category") }
    get transient(): boolean { return !!this.hints["transient"] }
    get resident(): boolean { return !!this.hints["resident"] }

    /** `urgency` arrives as a byte, but senders exist that write it as int64 —
     *  both unpack to a JS number, which is the whole reason this is not a cast. */
    get urgency(): number {
        const v = this.hints["urgency"]
        return typeof v === "number" ? v : Urgency.NORMAL
    }

    get_actions(): NotifAction[] { return this.actions }

    /** Resolve as DISMISSED_BY_USER. A no-op if it is already gone — the clear-all
     *  cascade dismisses a snapshot taken before the animation, and by the time it
     *  lands a row may have expired on its own. */
    dismiss(): void { getDefault().resolve(this.id, ClosedReason.DISMISSED) }

    /** Tell the sender an action was picked. Resolves the notification too, unless
     *  it declared the `resident` hint (the freedesktop rule for a card that stays
     *  up while its buttons are used). */
    invoke(actionId: string): void { getDefault().invokeAction(this.id, actionId) }

    /** JSON for the on-disk store. Only scalar hints survive: a sender can put any
     *  variant in there (byte arrays included), and JSON would turn those into
     *  objects that come back as garbage. */
    serialize(): any {
        const hints: Hints = {}
        for (const [k, v] of Object.entries(this.hints)) {
            const t = typeof v
            if (t === "string" || t === "number" || t === "boolean") hints[k] = v
        }
        return {
            id: this.id, app_name: this.app_name, app_icon: this.app_icon,
            summary: this.summary, body: this.body, expire_timeout: this.expire_timeout,
            time: this.time, hints, actions: this.actions,
        }
    }
}

type Event = { name: string, args: any[] }
class Notifd {
    private notifs = new Map<number, Notification>()
    private proxy: any = null
    private owner: string | null = null
    private generation = 0
    private pending: Event[] | null = null
    private warned = false
    private notifiedCbs = new Set<(id: number, replaced: boolean) => void>()
    private resolvedCbs = new Set<(id: number, reason: number) => void>()

    constructor() {
        // DO_NOT_AUTO_START: opening the shell must never claim the public name
        // or activate a notification server in somebody else's session.
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            null, BUS_NAME, BUS_PATH, IFACE, null, (_source: any, result: any) => {
                try {
                    this.proxy = Gio.DBusProxy.new_for_bus_finish(result)
                    this.proxy.connect("g-signal", (_p: any, sender: string, name: string, params: any) => {
                        if (sender !== this.owner) return
                        const event = { name, args: params.deepUnpack() }
                        if (this.pending) this.pending.push(event)
                        else this.apply(event, true)
                    })
                    this.proxy.connect("notify::g-name-owner", () => this.reconnect())
                    this.reconnect()
                } catch (e) { this.warn(e) }
            })
    }
    private warn(error?: any): void {
        if (this.warned) return
        this.warned = true
        console.warn("[notifd] nidara-sessiond is unavailable — Notification Center is empty", error ?? "")
    }
    private reconnect(): void {
        const owner = this.proxy.get_name_owner()
        if (owner === this.owner && owner !== null) return
        this.owner = owner
        const generation = ++this.generation
        this.pending = null
        if (!owner) {
            const ids = [...this.notifs.keys()]
            this.notifs.clear()
            ids.forEach(id => this.resolved(id, ClosedReason.UNDEFINED))
            this.warn()
            return
        }
        // Subscribe BEFORE List, and buffer until its reply. Calls target the
        // UNIQUE owner: an old daemon's late reply cannot overwrite a reconnect.
        // Replay buffered signals silently onto the snapshot, including arrivals
        // racing List. No onNotified for hydration => no banner flood on restart.
        this.pending = []
        this.proxy.get_connection().call(owner, BUS_PATH, IFACE, "List", null,
            new GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, 3000, null,
            (conn: any, result: any) => {
                try {
                    const [json] = conn.call_finish(result).deepUnpack()
                    if (generation !== this.generation) return
                    const list = JSON.parse(json)
                    const old = [...this.notifs.keys()]
                    this.notifs = new Map(list.map((raw: any) => [raw.id, new Notification(raw)]))
                    for (const event of this.pending ?? []) this.apply(event, false)
                    this.pending = null
                    old.filter(id => !this.notifs.has(id)).forEach(id => this.resolved(id, ClosedReason.UNDEFINED))
                    // The NC may already be open. Its existing watchResolved
                    // subscription rereads the roster; reserve id 0 (never a
                    // notification) for this local snapshot invalidation. Banners
                    // retire id 0 harmlessly. Never send this over D-Bus and never
                    // call onNotified for history, which would create banners.
                    this.resolved(0, ClosedReason.UNDEFINED)
                } catch (e) {
                    if (generation !== this.generation) return
                    this.pending = null
                    this.notifs.clear()
                    this.warn(e)
                }
            })
    }
    private apply(event: Event, live: boolean): void {
        if (event.name === "Notified") {
            const [id, replaced, json] = event.args
            try {
                this.notifs.set(id, new Notification(JSON.parse(json)))
                if (live) this.notifiedCbs.forEach(cb => { try { cb(id, replaced) } catch (e) { console.error("[notifd] notified handler:", e) } })
            } catch (e) { console.error("[notifd] invalid notification:", e) }
        } else if (event.name === "Resolved") {
            const [id, reason] = event.args
            this.notifs.delete(id)
            if (live) this.resolved(id, reason)
        }
    }
    private resolved(id: number, reason: number): void {
        this.resolvedCbs.forEach(cb => { try { cb(id, reason) } catch (e) { console.error("[notifd] resolved handler:", e) } })
    }
    get notifications(): Notification[] { return [...this.notifs.values()] }
    getNotification(id: number): Notification | null { return this.notifs.get(id) ?? null }
    onNotified(cb: (id: number, replaced: boolean) => void): () => void {
        this.notifiedCbs.add(cb)
        return () => this.notifiedCbs.delete(cb)
    }
    onResolved(cb: (id: number, reason: number) => void): () => void {
        this.resolvedCbs.add(cb)
        return () => this.resolvedCbs.delete(cb)
    }
    private call(method: string, params: any): void {
        if (!this.owner || !this.proxy || this.pending) return
        this.proxy.get_connection().call(this.owner, BUS_PATH, IFACE, method, params, null,
            Gio.DBusCallFlags.NO_AUTO_START, 3000, null, (conn: any, result: any) => {
                try { conn.call_finish(result) } catch (e) { this.warn(e) }
            })
    }
    resolve(id: number, reason: number): void {
        // Notification.dismiss() is the facade's only resolve caller. Sender
        // CloseNotification and expiry are handled by the daemon itself.
        if (reason === ClosedReason.DISMISSED) this.call("Dismiss", new GLib.Variant("(u)", [id]))
    }
    invokeAction(id: number, actionId: string): void {
        this.call("InvokeAction", new GLib.Variant("(us)", [id, actionId]))
    }
}
let _instance: Notifd | null = null
export function getDefault(): Notifd {
    if (!_instance) _instance = new Notifd()
    return _instance
}
/** Start the client independently of whether the bar includes the bell widget. */
export function startNotifClient(): void { getDefault() }

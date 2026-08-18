// notifd — the shell's OWN notification daemon.
//
// This is the server side of `org.freedesktop.Notifications`: Nidara owns that bus
// name, so every `notify-send`, every Firefox toast and every chat message on this
// desktop arrives HERE. It replaced AstalNotifd on 2026-08-18. Same shape as
// `core/mpris.ts` and `core/bluez.ts` — there is no library beneath it, only a
// freedesktop spec, and the Vala it replaces was a `Gio.DBusExportedObject` doing
// exactly this.
//
// The layer above is `core/NotifService.ts`; nothing outside `core/` talks to this
// file. Notifications are PLAIN objects, not GObjects, because no consumer listens
// to a single notification — they listen to the daemon (`onNotified`/`onResolved`)
// and re-read. That skips the ParamSpec accessor trap that `mpris.ts` documents.
//
// What did NOT come across from AstalNotifd, and why:
//
//   - **`dont_disturb`.** It never was daemon behaviour: the library's own docs say
//     it "does not have any effect on its own; it is merely a value shared between
//     the daemon process and proxies", parked in GSettings so several Astal
//     processes could see one bit. Nidara has no proxies — DnD is a UI policy the
//     popups apply, so it lives in `core/NotifConfig.ts` with the other
//     notification preferences.
//   - **Proxy mode.** Half of AstalNotifd exists so a second Astal process can act
//     as a client of the first. The shell is one process and is always the server.
//   - **`ignore_timeout` / `default_timeout`.** No UI ever set either; the popup
//     timeout the user CAN set is `notifConfig.popupTimeout`, and it is applied by
//     the banner, not by the server.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"

const BUS_NAME = "org.freedesktop.Notifications"
const BUS_PATH = "/org/freedesktop/Notifications"

/** freedesktop reason codes for `NotificationClosed`. */
export const ClosedReason = { EXPIRED: 1, DISMISSED: 2, CLOSED: 3, UNDEFINED: 4 } as const

export const Urgency = { LOW: 0, NORMAL: 1, CRITICAL: 2 } as const

const IFACE = `
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg type="s" name="app_name" direction="in"/>
      <arg type="u" name="replaces_id" direction="in"/>
      <arg type="s" name="app_icon" direction="in"/>
      <arg type="s" name="summary" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="as" name="actions" direction="in"/>
      <arg type="a{sv}" name="hints" direction="in"/>
      <arg type="i" name="expire_timeout" direction="in"/>
      <arg type="u" name="id" direction="out"/>
    </method>
    <method name="CloseNotification">
      <arg type="u" name="id" direction="in"/>
    </method>
    <method name="GetCapabilities">
      <arg type="as" name="capabilities" direction="out"/>
    </method>
    <method name="GetServerInformation">
      <arg type="s" name="name" direction="out"/>
      <arg type="s" name="vendor" direction="out"/>
      <arg type="s" name="version" direction="out"/>
      <arg type="s" name="spec_version" direction="out"/>
    </method>
    <signal name="NotificationClosed">
      <arg type="u" name="id"/>
      <arg type="u" name="reason"/>
    </signal>
    <signal name="ActionInvoked">
      <arg type="u" name="id"/>
      <arg type="s" name="action_key"/>
    </signal>
  </interface>
</node>`

// 🔑 What we answer to `GetCapabilities` is a PROMISE to the sender, and a sender
// that believes it changes what it sends. AstalNotifd shipped the freedesktop
// example list wholesale — including three Nidara does not honour:
//
//   - `sound` obliges the server to play `sound-file`/`sound-name`. Nidara plays
//     nothing, and a client that trusts the claim suppresses its OWN sound: the
//     notification simply goes silent, with no error anywhere.
//   - `body-hyperlinks` promises `<a href>` is followed. The card strips tags, so
//     the anchor text survives and the URL is thrown away — whereas a sender told
//     we do NOT support them writes the URL out as text, which is readable.
//   - `action-icons` asks senders to put icon NAMES where labels go. The card
//     renders labels.
//
// The four that stay are the ones the card actually does: it consumes markup
// (strips tags, decodes entities — see NotificationCenter), draws `image-path`
// heroes, draws `app_icon`, keeps notifications in the NC across a restart, and
// renders actions as buttons.
const CAPABILITIES = ["actions", "body", "body-markup", "body-images", "icon-static", "persistence"]

const SERVER_INFO = ["nidara", "nidara-project", "1.0", "1.2"]

// State and decoded images go under ~/.cache, NOT ~/.config/nidara, and the reason
// is privacy rather than tidiness: `~/.config/nidara` is a READ ROOT of the
// assistant's file layer (`bin/nidara-agent`, allowFileRead defaults ON), so a
// notification store there would hand every chat message that ever popped up to
// the model by default. It is also disposable by nature — a stream, not settings.
// The directory is created 0700 for the same reason: notification bodies are the
// user's mail, chat and 2FA codes.
const CACHE_DIR = `${GLib.get_user_cache_dir()}/nidara/notifd`
const STATE_PATH = `${CACHE_DIR}/state.json`
const IMAGE_DIR = `${CACHE_DIR}/images`
const IMAGE_CACHE_MAX = 150

/** Upper bound on a `replaces_id` the server will adopt as its own. Ids are
 *  uint32 on the wire and the sequence has to stay below that ceiling. */
const MAX_ADOPTED_ID = 0x7fffffff

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
     *  decoded to a PNG on arrival (see `cacheImageData`), so the card only ever
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

class Notifd {
    private notifs = new Map<number, Notification>()
    private timers = new Map<number, number>()
    private nextId = 1
    private exported: any = null
    private flushTimer: number | null = null

    private notifiedCbs = new Set<(id: number, replaced: boolean) => void>()
    private resolvedCbs = new Set<(id: number, reason: number) => void>()

    constructor() {
        this.restore()
        this.publish()
    }

    // ── The list ─────────────────────────────────────────────────────────────

    get notifications(): Notification[] {
        return [...this.notifs.values()]
    }

    getNotification(id: number): Notification | null {
        return this.notifs.get(id) ?? null
    }

    onNotified(cb: (id: number, replaced: boolean) => void): () => void {
        this.notifiedCbs.add(cb)
        return () => this.notifiedCbs.delete(cb)
    }

    onResolved(cb: (id: number, reason: number) => void): () => void {
        this.resolvedCbs.add(cb)
        return () => this.resolvedCbs.delete(cb)
    }

    // ── Resolution ───────────────────────────────────────────────────────────

    resolve(id: number, reason: number): void {
        const n = this.notifs.get(id)
        if (!n) return
        this.notifs.delete(id)
        this.clearTimer(id)
        this.emitSignal("NotificationClosed", new GLib.Variant("(uu)", [id, reason]))
        this.queueFlush()
        this.resolvedCbs.forEach(cb => { try { cb(id, reason) } catch (e) { console.error("[notifd] resolved handler:", e) } })
    }

    invokeAction(id: number, actionId: string): void {
        const n = this.notifs.get(id)
        if (!n) return
        this.emitSignal("ActionInvoked", new GLib.Variant("(us)", [id, actionId]))
        if (!n.resident) this.resolve(id, ClosedReason.CLOSED)
    }

    // ── D-Bus surface ────────────────────────────────────────────────────────

    private publish(): void {
        const impl = {
            Notify: (
                app_name: string, replaces_id: number, app_icon: string,
                summary: string, body: string, actions: string[],
                hints: Record<string, any>, expire_timeout: number,
            ): number => this.notify(app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout),
            CloseNotification: (id: number) => this.resolve(id, ClosedReason.CLOSED),
            GetCapabilities: () => CAPABILITIES,
            GetServerInformation: () => SERVER_INFO,
        }

        try {
            this.exported = Gio.DBusExportedObject.wrapJSObject(IFACE, impl)
        } catch (e) {
            console.error("[notifd] could not wrap the interface:", e)
            return
        }

        Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (conn: any) => {
                try { this.exported.export(conn, BUS_PATH) }
                catch (e) { console.error(`[notifd] could not export ${BUS_PATH}:`, e) }
            },
            () => console.log(`[notifd] serving ${BUS_NAME}`),
            // Losing the name is not fatal and not silent: another daemon (dunst,
            // mako, a stray astal-notifd) has it, so the shell keeps drawing the
            // notifications it already has and simply receives no new ones.
            () => console.warn(`[notifd] ${BUS_NAME} is owned by another process — no notifications will arrive`),
        )
    }

    private emitSignal(name: string, params: any): void {
        try { this.exported?.emit_signal(name, params) } catch (e) { console.error(`[notifd] emit ${name}:`, e) }
    }

    private notify(
        app_name: string, replaces_id: number, app_icon: string,
        summary: string, body: string, actions: string[],
        hints: Record<string, any>, expire_timeout: number,
    ): number {
        const unpacked: Hints = {}
        for (const [k, v] of Object.entries(hints ?? {})) {
            // Three hints carry raw pixels and none of them is kept as data:
            // `image-data` is decoded below, and the two deprecated spellings are
            // dropped, exactly as every other server does.
            if (k === "image-data" || k === "image_data" || k === "icon_data") continue
            try { unpacked[k] = v?.recursiveUnpack ? v.recursiveUnpack() : v } catch { /* skip a hint we cannot read */ }
        }

        // `image-data` is raw pixels on the wire. The card reads a PATH (it opens
        // the file to measure the hero before deciding a layout), so decode once,
        // here, and let `image-path` be the only shape downstream.
        if (hints?.["image-data"]) {
            const file = this.cacheImageData(hints["image-data"], app_name)
            if (file) unpacked["image-path"] = file
        }

        // 🔑 **`replaces_id` is honoured even when that notification is already
        // gone**, which is what the spec says ("if replaces_id is not 0, the
        // returned value is the same value as replaces_id") and NOT what
        // AstalNotifd did — it minted a fresh id whenever the old one had been
        // resolved. That is a duplicate-spam bug with a long fuse: an app driving
        // a progress notification keeps sending the SAME replaces_id, so once the
        // user dismisses it, every further update becomes a new row.
        //
        // The sequence is dragged past any id we adopt so a later notification
        // cannot collide with it; `MAX_ADOPTED_ID` is the sanity bound, because a
        // sender that passes garbage must not be able to push the counter to the
        // top of uint32 and wrap it.
        const adopted = replaces_id > 0 && replaces_id <= MAX_ADOPTED_ID
        const replaced = replaces_id > 0 && this.notifs.has(replaces_id)
        const id = adopted ? replaces_id : this.nextId++
        if (id >= this.nextId) this.nextId = id + 1

        const n = new Notification({
            id, app_name, app_icon, summary, body,
            expire_timeout,
            time: Math.floor(Date.now() / 1000),
            hints: unpacked,
            actions: parseActions(actions ?? []),
        })

        this.clearTimer(id)
        this.notifs.set(id, n)
        this.queueFlush()
        this.notifiedCbs.forEach(cb => { try { cb(id, replaced) } catch (e) { console.error("[notifd] notified handler:", e) } })

        // Server-side expiry. Only for a POSITIVE timeout: 0 means "never" and a
        // negative one means "server decides", and what the server decides here is
        // to keep it — the banner retires on `notifConfig.popupTimeout`, the card
        // stays in the NC until the user clears it. That is Nidara's persistence
        // model, and it is what AstalNotifd's `default-timeout = -1` did too.
        if (expire_timeout > 0) {
            this.timers.set(id, GLib.timeout_add(GLib.PRIORITY_DEFAULT, expire_timeout, () => {
                this.timers.delete(id)
                this.resolve(id, ClosedReason.EXPIRED)
                return GLib.SOURCE_REMOVE
            }))
        }

        return id
    }

    private clearTimer(id: number): void {
        const t = this.timers.get(id)
        if (t) { try { GLib.source_remove(t) } catch {} ; this.timers.delete(id) }
    }

    // ── Image cache ──────────────────────────────────────────────────────────

    /** `(iiibiiay)`: width, height, rowstride, has-alpha, bits-per-sample,
     *  channels, data. Written to a PNG named by the content hash, so the same
     *  avatar arriving fifty times is one file. */
    private cacheImageData(variant: any, app_name: string): string | null {
        try {
            const [w, h, rowstride, hasAlpha, bps, , data] = variant.deepUnpack()
            if (bps !== 8) {
                console.warn(`[notifd] ${app_name}: image-data at ${bps} bits per sample is not supported`)
                return null
            }
            const bytes = new GLib.Bytes(data)
            const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, hasAlpha, bps, w, h, rowstride)
            if (!pixbuf) return null

            GLib.mkdir_with_parents(IMAGE_DIR, 0o700)
            const path = `${IMAGE_DIR}/${hashBytes(data)}.png`
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                pixbuf.savev(path, "png", [], [])
                pruneImageCache()
            }
            return path
        } catch (e) {
            console.error("[notifd] could not decode image-data:", e)
            return null
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    /** Debounced: a burst of ten notifications writes the file once. */
    private queueFlush(): void {
        if (this.flushTimer) { try { GLib.source_remove(this.flushTimer) } catch {} }
        this.flushTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.flushTimer = null
            this.flush()
            return GLib.SOURCE_REMOVE
        })
    }

    private flush(): void {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700)
            // `transient` is excluded from persistence by the spec — it is exactly
            // what the hint means.
            const list = this.notifications.filter(n => !n.transient).map(n => n.serialize())
            GLib.file_set_contents(STATE_PATH, JSON.stringify({ version: 1, notifications: list }))
        } catch (e) {
            console.error("[notifd] could not write the store:", e)
        }
    }

    private restore(): void {
        try {
            if (!GLib.file_test(STATE_PATH, GLib.FileTest.EXISTS)) return
            const [ok, bytes] = GLib.file_get_contents(STATE_PATH)
            if (!ok) return
            const parsed = JSON.parse(new TextDecoder().decode(bytes))
            for (const raw of parsed?.notifications ?? []) {
                const n = new Notification(raw)
                this.notifs.set(n.id, n)
                if (n.id >= this.nextId) this.nextId = n.id + 1
            }
        } catch (e) {
            console.error("[notifd] could not read the store:", e)
        }
    }
}

/** `["id", "Label", "id2", "Label2"]` — the wire format is a flat strv of pairs. */
function parseActions(strv: string[]): NotifAction[] {
    const out: NotifAction[] = []
    for (let i = 0; i + 1 < strv.length; i += 2) out.push({ id: strv[i], label: strv[i + 1] })
    return out
}

function hashBytes(data: Uint8Array): string {
    const cs = GLib.Checksum.new(GLib.ChecksumType.SHA256)
    cs.update(data)
    return cs.get_string().slice(0, 32)
}

/** Keep the decoded-image folder bounded. Same shape as the media cover-art cache:
 *  oldest first, and only when it is actually over. */
function pruneImageCache(): void {
    try {
        const dir = Gio.File.new_for_path(IMAGE_DIR)
        const en = dir.enumerate_children("standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null)
        const files: { path: string, mtime: number }[] = []
        let info
        while ((info = en.next_file(null)) !== null) {
            files.push({ path: `${IMAGE_DIR}/${info.get_name()}`, mtime: info.get_modification_date_time()?.to_unix() ?? 0 })
        }
        en.close(null)
        if (files.length <= IMAGE_CACHE_MAX) return
        files.sort((a, b) => a.mtime - b.mtime)
        for (const f of files.slice(0, files.length - IMAGE_CACHE_MAX)) {
            try { Gio.File.new_for_path(f.path).delete(null) } catch {}
        }
    } catch { /* a missing cache dir is not an error */ }
}

let _instance: Notifd | null = null

/** The daemon. */
export function getDefault(): Notifd {
    if (!_instance) _instance = new Notifd()
    return _instance
}

/** Claim `org.freedesktop.Notifications` and restore the stored notifications.
 *
 *  `app.ts` calls this at boot on purpose. Everything else reaches the daemon
 *  through `core/NotifService`, which creates it lazily — and "lazily" would have
 *  meant "when the bar's bell widget is built", so a desktop with the bell removed
 *  would have stopped receiving notifications at all, silently. Being the server
 *  is not a widget's responsibility. */
export function startNotifServer(): void {
    getDefault()
}

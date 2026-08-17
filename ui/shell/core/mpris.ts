// core/mpris.ts — MPRIS spoken directly over D-Bus, replacing AstalMpris.
//
// MPRIS is a pure D-Bus specification: there is no library underneath it to
// wrap, so AstalMpris was 1558 lines of Vala over `Gio.DBusProxy` — exactly the
// object this file uses. Two proxies per player (the root interface for
// Identity/DesktopEntry, the Player interface for everything else), one
// NameOwnerChanged subscription for the roster, and that is the whole library.
//
// ## The players are GObjects on purpose
//
// Unlike Battery or Hyprland, the media consumers DO listen per object:
// `player.connect("notify")` (CC tiles, island, the media panel) and
// `notify::playback-status` (MediaService's "last active wins" heuristic, the
// island's activity switch). So `MprisPlayer` keeps being a GObject with real
// properties, and `g-properties-changed` is what drives the notifies. Nothing
// on the consumer side had to change shape.
//
// The property accessors are declared in snake_case (`playback_status`,
// `can_go_next`, …) because that is the name the call sites already use, and
// because GJS treats a snake_case accessor pair as THE accessor for the
// ParamSpec — a getter without its setter is a hard error at registration, and
// a ParamSpec with no accessor of ours gets an auto-generated one backed by
// separate storage, which would read stale forever. Pair them, guard them for
// equality, notify by hand.
//
// ## Position is extrapolated, not polled (this is the spec's own advice)
//
// `Position` is deliberately excluded from PropertiesChanged by the MPRIS spec,
// which tells clients to assume it advances at `Rate` and to re-read it when
// `Seeked` fires. AstalMpris instead POLLED it once a second and emitted
// `notify::position`, which is where the 1 Hz "notify" storm every media
// consumer in this repo has a comment about (and a guard against) came from.
//
// Here `position` is a plain JS accessor — NOT a GObject property — computed
// from an anchor (last known µs + the monotonic clock at that moment). Anchors
// are set on: creation, PlaybackStatus change, track change, `Seeked`, a seek
// we perform, and a lazy resync (one async round trip, at most every 10 s, and
// only when somebody actually reads `position`). A shell with a paused player
// and no media surface open now makes zero D-Bus traffic for position.
//
// ## What is deliberately NOT here
//
// AstalMpris also exposed volume, rate, loop/shuffle status, fullscreen,
// raise/quit, per-field metadata (composer, lyrics, disc number…) and a
// `cover_art` cache. Nothing in the shell reads any of it: art resolution has
// lived in MediaService since it had to cover the `data:`/`https:` URLs Astal's
// cache could not, and `art_url` is what it wants.

import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const BUS_NAMESPACE = "org.mpris.MediaPlayer2"
const OBJECT_PATH = "/org/mpris/MediaPlayer2"
const IFACE_ROOT = "org.mpris.MediaPlayer2"
const IFACE_PLAYER = "org.mpris.MediaPlayer2.Player"
const IFACE_PROPS = "org.freedesktop.DBus.Properties"

/** MPRIS PlaybackStatus, as the raw spec strings the bus carries. */
export const PlaybackStatus = {
    PLAYING: "Playing",
    PAUSED: "Paused",
    STOPPED: "Stopped",
} as const

/** Re-read Position from the bus at most this often, and only on demand. */
const RESYNC_US = 10_000_000

// ── Variant readers ──────────────────────────────────────────────────────────
// Metadata is a{sv} filled by every media app in the wild, so nothing about the
// types can be assumed: `mpris:length` arrives as x or t, `xesam:artist` as an
// array (spec) or a bare string (some browsers), `mpris:trackid` as o or s.

function vStr(v: any): string {
    if (!v) return ""
    const t = v.get_type_string()
    if (t === "s" || t === "o" || t === "g") return v.get_string()[0]
    if (t === "as" || t === "ao") return v.get_strv().join(", ")
    if (t === "v") return vStr(v.get_variant())
    return ""
}

function vNum(v: any): number {
    if (!v) return 0
    const t = v.get_type_string()
    switch (t) {
        case "x": return Number(v.get_int64())
        case "t": return Number(v.get_uint64())
        case "i": return v.get_int32()
        case "u": return v.get_uint32()
        case "n": return v.get_int16()
        case "q": return v.get_uint16()
        case "d": return v.get_double()
        case "v": return vNum(v.get_variant())
        default: return 0
    }
}

function vBool(v: any, fallback = true): boolean {
    if (!v) return fallback
    return v.get_type_string() === "b" ? v.get_boolean() : fallback
}

function meta(m: any, key: string): any {
    if (!m) return null
    try { return m.lookup_value(key, null) } catch { return null }
}

// ── The player ───────────────────────────────────────────────────────────────

export class MprisPlayer extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraMprisPlayer",
            Properties: {
                "identity": GObject.ParamSpec.string("identity", "", "", GObject.ParamFlags.READWRITE, ""),
                "entry": GObject.ParamSpec.string("entry", "", "", GObject.ParamFlags.READWRITE, ""),
                "title": GObject.ParamSpec.string("title", "", "", GObject.ParamFlags.READWRITE, ""),
                "artist": GObject.ParamSpec.string("artist", "", "", GObject.ParamFlags.READWRITE, ""),
                "album": GObject.ParamSpec.string("album", "", "", GObject.ParamFlags.READWRITE, ""),
                "art-url": GObject.ParamSpec.string("art-url", "", "", GObject.ParamFlags.READWRITE, ""),
                "playback-status": GObject.ParamSpec.string("playback-status", "", "", GObject.ParamFlags.READWRITE, PlaybackStatus.STOPPED),
                "length": GObject.ParamSpec.double("length", "", "", GObject.ParamFlags.READWRITE, 0, Number.MAX_VALUE, 0),
                "can-go-next": GObject.ParamSpec.boolean("can-go-next", "", "", GObject.ParamFlags.READWRITE, true),
                "can-go-previous": GObject.ParamSpec.boolean("can-go-previous", "", "", GObject.ParamFlags.READWRITE, true),
                "can-seek": GObject.ParamSpec.boolean("can-seek", "", "", GObject.ParamFlags.READWRITE, false),
                "can-control": GObject.ParamSpec.boolean("can-control", "", "", GObject.ParamFlags.READWRITE, true),
            },
        }, this)
    }

    readonly bus_name: string

    private _conn: any
    private _proxy: any = null      // org.mpris.MediaPlayer2.Player
    private _rootProxy: any = null  // org.mpris.MediaPlayer2

    private _identity = ""
    private _entry = ""
    private _title = ""
    private _artist = ""
    private _album = ""
    private _artUrl = ""
    private _status: string = PlaybackStatus.STOPPED
    private _length = 0
    private _canNext = true
    private _canPrev = true
    private _canSeek = false
    private _canControl = true

    private _trackid = ""
    private _rate = 1
    private _posUs = 0        // last known Position, in µs
    private _posAtUs = 0      // monotonic time that anchor was taken
    private _lastSyncUs = 0
    private _syncing = false
    private _closed = false

    constructor(conn: any, busName: string) {
        super()
        this._conn = conn
        this.bus_name = busName
    }

    /** Build both proxies; resolves once the player can answer for itself. */
    async open(): Promise<void> {
        const flags = Gio.DBusProxyFlags.DO_NOT_AUTO_START
            | Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES

        const mk = (iface: string) => new Promise<any>((resolve, reject) => {
            Gio.DBusProxy.new(this._conn, flags, null, this.bus_name, OBJECT_PATH, iface, null,
                (_src: any, res: any) => {
                    try { resolve(Gio.DBusProxy.new_finish(res)) } catch (e) { reject(e) }
                })
        })

        const [player, root] = await Promise.all([mk(IFACE_PLAYER), mk(IFACE_ROOT)])
        if (this._closed) return
        this._proxy = player
        this._rootProxy = root

        this._proxy.connect("g-properties-changed", (_p: any, changed: any) => {
            // Re-read the whole cache rather than the delta: a partial update is
            // one cached-property read per field, and players differ wildly in
            // what they bundle into a single PropertiesChanged.
            const trackChanged = !!changed?.lookup_value?.("Metadata", null)
            const statusChanged = !!changed?.lookup_value?.("PlaybackStatus", null)
            this._syncPlayer()
            if (trackChanged || statusChanged) this._resync()
        })
        this._rootProxy.connect("g-properties-changed", () => this._syncRoot())

        this._proxy.connect("g-signal", (_p: any, _sender: string, signal: string, params: any) => {
            if (signal !== "Seeked") return
            try { this._anchor(vNum(params.get_child_value(0))) } catch {}
        })

        this._syncRoot()
        this._syncPlayer()
        this._anchor(vNum(this._proxy.get_cached_property("Position")))
    }

    /** The name left the bus: stop everything and let the object go. */
    close() {
        this._closed = true
        this._proxy = null
        this._rootProxy = null
    }

    // ── Properties ───────────────────────────────────────────────────────────
    // Each pair is the ParamSpec's real accessor; the setters are internal (the
    // bus is the only writer) and notify only on an actual change, which is what
    // keeps a repainting consumer off the "notify" treadmill.

    get identity(): string { return this._identity }
    set identity(v: string) { if (v !== this._identity) { this._identity = v; this.notify("identity") } }

    get entry(): string { return this._entry }
    set entry(v: string) { if (v !== this._entry) { this._entry = v; this.notify("entry") } }

    get title(): string { return this._title }
    set title(v: string) { if (v !== this._title) { this._title = v; this.notify("title") } }

    get artist(): string { return this._artist }
    set artist(v: string) { if (v !== this._artist) { this._artist = v; this.notify("artist") } }

    get album(): string { return this._album }
    set album(v: string) { if (v !== this._album) { this._album = v; this.notify("album") } }

    get art_url(): string { return this._artUrl }
    set art_url(v: string) { if (v !== this._artUrl) { this._artUrl = v; this.notify("art-url") } }

    get playback_status(): string { return this._status }
    set playback_status(v: string) { if (v !== this._status) { this._status = v; this.notify("playback-status") } }

    get length(): number { return this._length }
    set length(v: number) { if (v !== this._length) { this._length = v; this.notify("length") } }

    get can_go_next(): boolean { return this._canNext }
    set can_go_next(v: boolean) { if (v !== this._canNext) { this._canNext = v; this.notify("can-go-next") } }

    get can_go_previous(): boolean { return this._canPrev }
    set can_go_previous(v: boolean) { if (v !== this._canPrev) { this._canPrev = v; this.notify("can-go-previous") } }

    get can_seek(): boolean { return this._canSeek }
    set can_seek(v: boolean) { if (v !== this._canSeek) { this._canSeek = v; this.notify("can-seek") } }

    get can_control(): boolean { return this._canControl }
    set can_control(v: boolean) { if (v !== this._canControl) { this._canControl = v; this.notify("can-control") } }

    // ── Position (seconds; a plain accessor, never a GObject property) ────────

    get position(): number {
        if (!this._proxy) return 0
        let us = this._posUs
        if (this._status === PlaybackStatus.PLAYING) {
            us += (GLib.get_monotonic_time() - this._posAtUs) * this._rate
            this._maybeResync()
        }
        const secs = us / 1e6
        if (secs < 0) return 0
        return this._length > 0 && secs > this._length ? this._length : secs
    }

    /** Seek to an absolute position in seconds. */
    set position(seconds: number) {
        if (!this._proxy || !this._canSeek) return
        const targetUs = Math.max(0, Math.round(seconds * 1e6))
        // SetPosition is the precise call, but it is a documented NO-OP unless
        // the TrackId matches the current track — and plenty of players publish
        // no usable `mpris:trackid` at all. Fall back to a relative Seek, which
        // needs no track identity.
        const useSet = this._trackid.startsWith("/")
        const args = useSet
            ? new GLib.Variant("(ox)", [this._trackid, targetUs])
            : new GLib.Variant("(x)", [Math.round(targetUs - this.position * 1e6)])
        this._call(useSet ? "SetPosition" : "Seek", args)
        this._anchor(targetUs)
    }

    // ── Transport ────────────────────────────────────────────────────────────

    play_pause() { this._call("PlayPause") }
    next() { this._call("Next") }
    previous() { this._call("Previous") }

    private _call(method: string, args: any = null) {
        if (!this._proxy) return
        this._proxy.call(method, args, Gio.DBusCallFlags.NO_AUTO_START, -1, null,
            (_s: any, res: any) => {
                try { this._proxy?.call_finish(res) }
                catch (e) { console.error(`[Mpris] ${this.bus_name}.${method}:`, e) }
            })
    }

    // ── Bus → properties ─────────────────────────────────────────────────────

    private _syncRoot() {
        const p = this._rootProxy
        if (!p) return
        this.identity = vStr(p.get_cached_property("Identity"))
        this.entry = vStr(p.get_cached_property("DesktopEntry"))
    }

    private _syncPlayer() {
        const p = this._proxy
        if (!p) return
        const m = p.get_cached_property("Metadata")

        const trackid = vStr(meta(m, "mpris:trackid"))
        if (trackid !== this._trackid) {
            this._trackid = trackid
            this._anchor(0) // a new track starts at 0 until the resync lands
        }

        this.title = vStr(meta(m, "xesam:title"))
        this.artist = vStr(meta(m, "xesam:artist"))
        this.album = vStr(meta(m, "xesam:album"))
        this.art_url = vStr(meta(m, "mpris:artUrl"))
        this.length = vNum(meta(m, "mpris:length")) / 1e6

        const rate = vNum(p.get_cached_property("Rate"))
        this._rate = rate > 0 ? rate : 1

        const status = vStr(p.get_cached_property("PlaybackStatus"))
        if (status && status !== this._status) {
            // Freeze the extrapolation at its current value BEFORE the status
            // flips, or a pause would keep the clock running until the resync.
            this._posUs = this.position * 1e6
            this._posAtUs = GLib.get_monotonic_time()
            this.playback_status = status
        }

        this.can_go_next = vBool(p.get_cached_property("CanGoNext"))
        this.can_go_previous = vBool(p.get_cached_property("CanGoPrevious"))
        this.can_seek = vBool(p.get_cached_property("CanSeek"), false)
        this.can_control = vBool(p.get_cached_property("CanControl"))
    }

    // ── Position anchoring ───────────────────────────────────────────────────

    private _anchor(us: number) {
        this._posUs = Number.isFinite(us) && us > 0 ? us : 0
        this._posAtUs = GLib.get_monotonic_time()
        this._lastSyncUs = this._posAtUs
    }

    private _maybeResync() {
        if (GLib.get_monotonic_time() - this._lastSyncUs < RESYNC_US) return
        this._resync()
    }

    /** One async read of Position. Bounds the drift of the extrapolation (a
     *  player that buffers, or advertises a Rate it does not honour). */
    private _resync() {
        if (!this._proxy || this._syncing) return
        this._syncing = true
        this._lastSyncUs = GLib.get_monotonic_time()
        this._conn.call(
            this.bus_name, OBJECT_PATH, IFACE_PROPS, "Get",
            new GLib.Variant("(ss)", [IFACE_PLAYER, "Position"]),
            new GLib.VariantType("(v)"), Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
            (_s: any, res: any) => {
                this._syncing = false
                try {
                    const reply = this._conn.call_finish(res)
                    this._anchor(vNum(reply.get_child_value(0).get_variant()))
                } catch {
                    // Players are allowed to not implement Position at all
                    // (browsers on a live stream). Keep the last anchor.
                }
            },
        )
    }
}

// ── The roster ───────────────────────────────────────────────────────────────

let conn: any = null
let started = false
const byBus = new Map<string, MprisPlayer>()
const opening = new Set<string>()
const listeners: Array<() => void> = []

function notifyListeners() {
    listeners.forEach(fn => { try { fn() } catch (e) { console.error("[Mpris] listener:", e) } })
}

function addPlayer(busName: string) {
    if (byBus.has(busName) || opening.has(busName) || !conn) return
    opening.add(busName)
    const player = new MprisPlayer(conn, busName)
    player.open()
        .then(() => {
            // `opening` is also how a departure cancels: removePlayer() drops the
            // name from it, so a delete that finds nothing means the player left
            // the bus while its proxies were still being built.
            if (!opening.delete(busName)) { player.close(); return }
            byBus.set(busName, player)
            notifyListeners()
        })
        .catch((e: any) => {
            opening.delete(busName)
            console.error(`[Mpris] cannot open ${busName}:`, e)
        })
}

function removePlayer(busName: string) {
    opening.delete(busName)
    const player = byBus.get(busName)
    if (!player) return
    player.close()
    byBus.delete(busName)
    notifyListeners()
}

function start() {
    if (started) return
    started = true
    try {
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, null)
    } catch (e) {
        console.error("[Mpris] no session bus:", e)
        return
    }

    // Server-side filtering: MATCH_ARG0_NAMESPACE means the bus only wakes us
    // for org.mpris.MediaPlayer2.* names, not for every service that comes and
    // goes on the session bus.
    conn.signal_subscribe(
        "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
        "/org/freedesktop/DBus", BUS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
        (_c: any, _sender: string, _path: string, _iface: string, _signal: string, params: any) => {
            const [name, , newOwner] = params.deep_unpack()
            if (typeof name !== "string" || !name.startsWith(`${BUS_NAMESPACE}.`)) return
            if (newOwner) addPlayer(name)
            else removePlayer(name)
        },
    )

    // The initial roster. Async on purpose: nothing in the shell blocks on a
    // player existing at startup — the media surfaces build empty and rewire
    // through MediaService.subscribe(), the same path an async art download
    // already uses.
    conn.call(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames",
        null, new GLib.VariantType("(as)"), Gio.DBusCallFlags.NONE, 3000, null,
        (_s: any, res: any) => {
            try {
                const [names] = conn.call_finish(res).deep_unpack()
                for (const n of names as string[]) {
                    if (n.startsWith(`${BUS_NAMESPACE}.`)) addPlayer(n)
                }
            } catch (e) {
                console.error("[Mpris] ListNames failed:", e)
            }
        },
    )
}

/** Every player currently on the session bus, in arrival order. */
export function players(): MprisPlayer[] {
    start()
    return [...byBus.values()]
}

/** Subscribe to "a player appeared or left". Returns an unsubscribe function. */
export function subscribePlayers(cb: () => void): () => void {
    start()
    listeners.push(cb)
    return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
    }
}

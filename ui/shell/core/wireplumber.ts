// The shell's own door to WirePlumber.
//
// Replaces AstalWp (2026-08-18). Unlike AstalMpris and AstalBluetooth — which
// were D-Bus proxies with no library underneath — this one DOES have a library
// under it, and it ships its own typelib: `Wp-0.5`, from `wireplumber`, which is
// already a hard dependency of the session (install.sh installs it for PipeWire).
// AstalWp was ~4.7k lines of C over it; this is the part of that we actually use.
//
// What the shell asks of WirePlumber, in full:
//
//   - the list of audio sinks, sources, and per-app playback streams;
//   - each one's human label, its per-app icon, its volume and its mute;
//   - which sink/source is the default;
//   - a signal when any of the above changes.
//
// That is `mixer-api` + `default-nodes-api` + one `WpObjectManager`. Everything
// else AstalWp modelled — devices, profiles, routes, video, recorders, channel
// objects — has no consumer here: Nidara draws speakers and mics with its own
// `Icons.speaker`/`Icons.mic`, so even the endpoint→device→`device.icon-name`
// chain (device.c, 725 lines) was dead weight. Only STREAM icons are read.
//
// `core/AudioService.ts` keeps its public API unchanged, so no surface moved.
//
// ── The one that would have changed every volume in the UI ───────────────────
//
// ⚠️ **`mixer-api` starts in LINEAR scale; AstalWp set it to CUBIC.** Measured on
// the same sink at the same instant, before writing any of this:
//
//     scale=0 (linear, the default)  → 0.6361
//     scale=1 (cubic, what Astal set) → 0.8600
//     AstalWp                         → 0.8600      wpctl get-volume → 0.86
//
// Leaving the plugin at its own default is not a crash and not a warning — the
// slider simply reads 64 % where the system says 86 %, everywhere, forever. The
// scale is set explicitly below and the probe asserts it against `wpctl`.
//
// ── Two GJS facts about libwireplumber, both measured here ───────────────────
//
// ⚠️ `Wp.Core` has its own `connect()` and `disconnect()` — the PipeWire ones —
// which SHADOW GObject's. Same trap `NM.Device` sprang in #176, but worse here,
// because it is SILENT: `core.connect("disconnected", cb)` does not throw and does
// not warn. It ignores the arguments, connects to PipeWire, and returns true — so
// the handler is simply never attached and nothing ever tells you. Subscribing
// needs the escape hatch below; disconnecting goes through
// `GObject.signal_handler_disconnect` (which is what `safeDisconnect` does).
//
// ⚠️ `WpIterator.next()` throws at exhaustion in GJS ("Don't know how to convert
// GType (null)"): the terminating step hands back an UNSET GValue. The obvious
// `while (it.next())` loop therefore dies on the last step instead of stopping.
// `foreach()` has no such edge and is what this file uses.
//
// ── Why nodes are still GObjects ─────────────────────────────────────────────
//
// Because consumers listen per object: the kit's volume slider, the CC tile, the
// bar icon and the Settings rows all wire `notify::volume` / `notify::mute` onto
// the endpoint or stream they were handed. A plain-object roster would have
// forced every one of those call sites to change shape.
//
// ⚠️ The GJS rule from AstalMpris, obeyed again: the snake_case accessors ARE the
// ParamSpec's accessors, so every property declares the PAIR with an equality
// guard and a manual `notify()`. And the rule from AstalBluetooth: `volume` and
// `mute` are properties whose setters WRITE to the mixer, so the internal refresh
// path must NOT go through them — it uses `_applyVolume`, or every reading of the
// graph would be echoed straight back at it.

import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Wp from "gi://Wp?version=0.5"

/** `media.class` values, exactly as PipeWire spells them. */
const CLASS_SPEAKER = "Audio/Sink"
const CLASS_MIC = "Audio/Source"
const CLASS_MIC_VIRTUAL = "Audio/Source/Virtual"
const CLASS_STREAM = "Stream/Output/Audio"
// `Stream/Input/Audio` (AstalWp's "recorders") is deliberately not modelled: no
// surface in the shell lists what is RECORDING. The REC indicator is Nidara's own
// screen-recorder state, not a WirePlumber query.

/** mixer-api's `scale` property: 0 = linear, 1 = cubic. See the header. */
const SCALE_CUBIC = 1

/** AstalWp's clamp, kept: PipeWire itself allows >1.0 (amplification). */
const MAX_VOLUME = 1.5

/** GObject's `connect`, reached past whatever the GI class put in its place.
 *  Only needed for `Wp.Core`; every other object here has an unshadowed one. */
function gobjectConnect(obj: any, signal: string, cb: (...args: any[]) => void): number {
    return GObject.Object.prototype.connect.call(obj, signal, cb)
}

function pwProp(node: any, key: string): string | null {
    try {
        const v = node?.get_property?.(key)
        return v === undefined ? null : v
    } catch {
        return null
    }
}

/** Walk a `WpObjectManager`'s objects. `foreach` and not `next()` — see header. */
function eachObject(om: any, fn: (obj: any) => void): void {
    try {
        om?.new_iterator?.()?.foreach((obj: any) => { if (obj) fn(obj) })
    } catch (e) {
        console.error("[Wp] iterate:", e)
    }
}

// ── One node: a sink, a source, or a per-app stream ──────────────────────────

export class AudioNode extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraWpNode",
            Properties: {
                "id": GObject.ParamSpec.uint("id", "", "", GObject.ParamFlags.READWRITE, 0, GLib.MAXUINT32, 0),
                "description": GObject.ParamSpec.string("description", "", "", GObject.ParamFlags.READWRITE, ""),
                "name": GObject.ParamSpec.string("name", "", "", GObject.ParamFlags.READWRITE, ""),
                "icon": GObject.ParamSpec.string("icon", "", "", GObject.ParamFlags.READWRITE, ""),
                "media-class": GObject.ParamSpec.string("media-class", "", "", GObject.ParamFlags.READWRITE, ""),
                "volume": GObject.ParamSpec.double("volume", "", "", GObject.ParamFlags.READWRITE, 0, MAX_VOLUME, 0),
                "mute": GObject.ParamSpec.boolean("mute", "", "", GObject.ParamFlags.READWRITE, false),
            },
        }, this)
    }

    private _wpNode: any
    private _mixer: any
    private _paramsId = 0
    private _propsId = 0

    private _id = 0
    private _description = ""
    private _name = ""
    private _icon = ""
    private _mediaClass = ""
    private _volume = 0
    private _mute = false

    constructor(wpNode: any, mixer: any) {
        super()
        this._wpNode = wpNode
        this._mixer = mixer

        // Both, as AstalWp did: `params-changed` covers a Props update (a volume
        // knob moved on the device), `notify::properties` covers the pw property
        // dictionary being replaced (a stream renaming its media.name mid-play).
        this._paramsId = wpNode.connect("params-changed", () => this._syncProps())
        this._propsId = wpNode.connect("notify::properties", () => this._syncProps())

        this._syncProps()
        this.refreshVolume()
    }

    get id() { return this._id }
    set id(v: number) { if (v !== this._id) { this._id = v; this.notify("id") } }

    get description() { return this._description }
    set description(v: string) { if (v !== this._description) { this._description = v; this.notify("description") } }

    get name() { return this._name }
    set name(v: string) { if (v !== this._name) { this._name = v; this.notify("name") } }

    get icon() { return this._icon }
    set icon(v: string) { if (v !== this._icon) { this._icon = v; this.notify("icon") } }

    get media_class() { return this._mediaClass }
    set media_class(v: string) { if (v !== this._mediaClass) { this._mediaClass = v; this.notify("media-class") } }

    /** 0–1 (cubic, PulseAudio-style — the scale `wpctl` prints). Writing SENDS to
     *  the mixer; the graph answers with `changed` and `refreshVolume` lands it. */
    get volume() { return this._volume }
    set volume(v: number) { this._writeVolume(v) }

    get mute() { return this._mute }
    set mute(v: boolean) { this._writeMute(v) }

    get is_stream() { return this._mediaClass === CLASS_STREAM }

    // ── Reading ──────────────────────────────────────────────────────────────

    /** The pw properties the shell actually shows. Mapping taken from AstalWp's
     *  node.c/stream.c so nothing in the UI changes wording:
     *
     *   - `description` = node.description → node.nick → node.name. For a stream
     *     this is the CLIENT ("Google Chrome"); `name` is the stream's own
     *     media.name ("Playback"), which is why every row reads
     *     `description || name`.
     *   - `icon` is streams-only and falls back to a REAL theme name. The
     *     placeholder is a NO, not an icon — `AudioService.streamIconName` exists
     *     precisely because a client with no declared icon is indistinguishable
     *     from one with a generic one otherwise. */
    private _syncProps(): void {
        const node = this._wpNode
        if (!node) return

        const idStr = pwProp(node, "object.id")
        if (idStr !== null) this.id = Number(idStr) || 0

        this.description = pwProp(node, "node.description")
            ?? pwProp(node, "node.nick")
            ?? pwProp(node, "node.name")
            ?? ""
        this.name = pwProp(node, "media.name") ?? ""
        this.media_class = pwProp(node, "media.class") ?? ""

        if (this.media_class === CLASS_STREAM) {
            this.icon = pwProp(node, "media.icon-name")
                ?? pwProp(node, "window.icon-name")
                ?? pwProp(node, "application.icon-name")
                ?? "application-x-executable-symbolic"
        }
    }

    /** Re-read volume/mute from the mixer. Called on the plugin's `changed` for
     *  this id — never from a setter. */
    refreshVolume(): void {
        const v = this._readMixer()
        if (!v) return
        this._applyVolume(v)
    }

    private _readMixer(): any {
        if (!this._mixer || !this._id) return null
        try {
            const variant = this._mixer.emit("get-volume", this._id)
            return variant ? variant.recursiveUnpack() : null
        } catch (e) {
            console.error("[Wp] get-volume:", e)
            return null
        }
    }

    /** AstalWp's reading, kept: the node's volume is the LOUDEST channel, not the
     *  aggregate `volume` key. On a sink with an unbalanced left/right the two
     *  disagree, and the slider must show the one the user hears peaking. */
    private _applyVolume(v: any): void {
        let volume = typeof v.volume === "number" ? v.volume : 0
        const channels = v.channelVolumes
        if (channels) {
            for (const key of Object.keys(channels)) {
                const cv = channels[key]?.volume
                if (typeof cv === "number" && cv > volume) volume = cv
            }
        }
        if (volume !== this._volume) { this._volume = volume; this.notify("volume") }
        const mute = !!v.mute
        if (mute !== this._mute) { this._mute = mute; this.notify("mute") }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /** Per-channel and proportional, as AstalWp did — NOT a flat `volume` key.
     *  Sending a scalar makes the mixer level every channel, so a user who set a
     *  left/right balance in pavucontrol would lose it the first time they touched
     *  Nidara's slider. Each channel keeps its ratio to the loudest one. */
    private _writeVolume(v: number): void {
        if (!this._mixer || !this._id) return
        const target = Math.min(MAX_VOLUME, Math.max(0, v))
        const current = this._readMixer()
        if (!current) return

        const payload: Record<string, any> = {}
        const channels = current.channelVolumes
        if (channels && Object.keys(channels).length > 0) {
            const scaled: Record<string, any> = {}
            for (const key of Object.keys(channels)) {
                const cv = channels[key]?.volume ?? 0
                // `this._volume` is the loudest channel; at 0 there is no ratio to
                // preserve, so every channel takes the new value outright.
                const next = this._volume === 0 ? target : cv * target / this._volume
                scaled[key] = new GLib.Variant("a{sv}", { volume: GLib.Variant.new_double(Math.min(MAX_VOLUME, next)) })
            }
            payload.channelVolumes = new GLib.Variant("a{sv}", scaled)
        } else {
            payload.volume = GLib.Variant.new_double(target)
        }
        this._emitSetVolume(payload)
    }

    private _writeMute(v: boolean): void {
        if (!this._mixer || !this._id) return
        this._emitSetVolume({ mute: GLib.Variant.new_boolean(v) })
    }

    private _emitSetVolume(payload: Record<string, any>): void {
        try {
            this._mixer.emit("set-volume", this._id, new GLib.Variant("a{sv}", payload))
        } catch (e) {
            console.error("[Wp] set-volume:", e)
        }
    }

    destroy(): void {
        if (this._wpNode) {
            if (this._paramsId) GObject.signal_handler_disconnect(this._wpNode, this._paramsId)
            if (this._propsId) GObject.signal_handler_disconnect(this._wpNode, this._propsId)
        }
        this._paramsId = 0
        this._propsId = 0
        this._wpNode = null
        this._mixer = null
    }
}

// ── The graph ────────────────────────────────────────────────────────────────

export class Audio extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraWpAudio",
            Properties: {
                "default-speaker": GObject.ParamSpec.jsobject("default-speaker", "", "", GObject.ParamFlags.READWRITE),
                "default-microphone": GObject.ParamSpec.jsobject("default-microphone", "", "", GObject.ParamFlags.READWRITE),
            },
            Signals: {
                "speaker-added": { param_types: [GObject.TYPE_JSOBJECT] },
                "speaker-removed": { param_types: [GObject.TYPE_JSOBJECT] },
                "microphone-added": { param_types: [GObject.TYPE_JSOBJECT] },
                "microphone-removed": { param_types: [GObject.TYPE_JSOBJECT] },
                "stream-added": { param_types: [GObject.TYPE_JSOBJECT] },
                "stream-removed": { param_types: [GObject.TYPE_JSOBJECT] },
            },
        }, this)
    }

    private _core: any = null
    private _om: any = null
    private _mixer: any = null
    private _defaults: any = null
    private _nodes = new Map<any, AudioNode>()   // WpNode → our node
    private _defaultSpeaker: AudioNode | null = null
    private _defaultMic: AudioNode | null = null
    private _pending = 2
    private _started = false
    private _connected = false

    constructor() {
        super()

        // ⚠️ Exactly once per process: `Wp.init` installs a GLib log writer, and
        // GLib aborts the process on a second `g_log_set_writer_func()`. This class
        // is a singleton, which is what keeps that true.
        Wp.init(Wp.InitFlags.ALL)
        this._core = Wp.Core.new(null, null, null)

        gobjectConnect(this._core, "connected", () => { this._connected = true })
        gobjectConnect(this._core, "disconnected", () => {
            this._connected = false
            console.error("[Wp] PipeWire went away")
        })
    }

    /** Whether the graph has actually answered. `start()` succeeding only means
     *  the socket was there; the handshake lands a turn of the loop later. */
    get is_connected(): boolean { return this._connected }

    /** Idempotent. False means PipeWire is not running — try again later.
     *
     *  ⚠️ Measured: `wp_core_connect()` returns FALSE when the socket is absent,
     *  which is the only reliable "is there a graph" answer available
     *  synchronously. `is_connected()` is still false at this point even on a
     *  healthy machine, so it cannot be the gate. */
    start(): boolean {
        if (this._started) return true
        // PipeWire's `connect()`, not GObject's (see header).
        if (!this._core?.connect()) return false
        this._started = true

        this._om = new Wp.ObjectManager()
        this._om.add_interest_full(Wp.ObjectInterest.new_type(Wp.Node.$gtype))
        this._om.request_object_features(Wp.Node.$gtype, Wp.OBJECT_FEATURES_ALL)
        // Interest on the TYPE only, media.class filtered in JS: the constrained
        // form of `wp_object_interest_new` is C-variadic and so not introspectable,
        // and the whole graph is ~10 nodes on a normal machine.
        this._om.connect("installed", () => this._seed())
        this._om.connect("object-added", (_om: any, obj: any) => this._add(obj))
        this._om.connect("object-removed", (_om: any, obj: any) => this._remove(obj))

        this._loadPlugin("libwireplumber-module-mixer-api", "mixer-api")
        this._loadPlugin("libwireplumber-module-default-nodes-api", "default-nodes-api")
        return true
    }

    /** Both plugins must be ACTIVE before the object manager is installed:
     *  a node built without the mixer would have no volume to read and no
     *  `changed` to learn from. */
    private _loadPlugin(module: string, name: string): void {
        this._core.load_component(module, "module", null, name, null, (_o: any, res: any) => {
            try {
                this._core.load_component_finish(res)
            } catch (e) {
                console.error(`[Wp] load ${name}:`, e)
                return
            }
            const plugin = Wp.Plugin.find(this._core, name)
            if (!plugin) {
                console.error(`[Wp] ${name} not found after load`)
                return
            }
            plugin.activate(Wp.PluginFeatures.ENABLED, null, (_p: any, r: any) => {
                try {
                    plugin.activate_finish(r)
                } catch (e) {
                    console.error(`[Wp] activate ${name}:`, e)
                    return
                }
                if (name === "mixer-api") {
                    // THE line. Without it every volume in the shell reads low.
                    plugin.set_property("scale", SCALE_CUBIC)
                    this._mixer = plugin
                    plugin.connect("changed", (_m: any, id: number) => this._volumeChanged(id))
                } else {
                    this._defaults = plugin
                    plugin.connect("changed", () => this._defaultsChanged())
                }
                if (--this._pending === 0) this._core.install_object_manager(this._om)
            })
        })
    }

    // ── Roster ───────────────────────────────────────────────────────────────

    private _seed(): void {
        eachObject(this._om, (obj) => this._add(obj))
        this._defaultsChanged()
    }

    private _add(wpNode: any): void {
        if (this._nodes.has(wpNode)) return
        const mediaClass = pwProp(wpNode, "media.class") ?? ""
        const signal = this._signalFor(mediaClass)
        if (!signal) return

        const node = new AudioNode(wpNode, this._mixer)
        this._nodes.set(wpNode, node)
        // Defaults BEFORE the roster signal, not after. A sink that appears may BE
        // the new default (the first one at startup always is, and so is a headset
        // plugged in later) — and a handler for `speaker-added` that asks who the
        // default is would otherwise be answered "nobody" for the very node that
        // just became it. The bar's volume icon does exactly that ask.
        this._defaultsChanged()
        this.emit(`${signal}-added`, node)
    }

    private _remove(wpNode: any): void {
        const node = this._nodes.get(wpNode)
        if (!node) return
        this._nodes.delete(wpNode)
        const signal = this._signalFor(node.media_class)
        if (signal) this.emit(`${signal}-removed`, node)
        if (this._defaultSpeaker === node) this._setDefaultSpeaker(null)
        if (this._defaultMic === node) this._setDefaultMic(null)
        node.destroy()
        this._defaultsChanged()
    }

    private _signalFor(mediaClass: string): string | null {
        switch (mediaClass) {
            case CLASS_SPEAKER: return "speaker"
            case CLASS_MIC:
            case CLASS_MIC_VIRTUAL: return "microphone"
            case CLASS_STREAM: return "stream"
            default: return null
        }
    }

    private _byMediaClass(...classes: string[]): AudioNode[] {
        const out: AudioNode[] = []
        for (const node of this._nodes.values()) {
            if (classes.includes(node.media_class)) out.push(node)
        }
        return out
    }

    get_speakers(): AudioNode[] { return this._byMediaClass(CLASS_SPEAKER) }
    get_microphones(): AudioNode[] { return this._byMediaClass(CLASS_MIC, CLASS_MIC_VIRTUAL) }
    get_streams(): AudioNode[] { return this._byMediaClass(CLASS_STREAM) }

    // ── Defaults ─────────────────────────────────────────────────────────────

    /** AstalWp handed out a PERMANENT proxy endpoint that swapped its inner node
     *  when the default changed, and consequently never emitted
     *  `notify::default-speaker` at all (nothing in the library emits it). This
     *  returns the REAL node and notifies, so the consumers that already re-target
     *  on that signal — the CC tile, the bar icon — start actually being told. */
    get default_speaker(): AudioNode | null { return this._defaultSpeaker }
    set default_speaker(v: AudioNode | null) { this._setDefaultSpeaker(v) }

    get default_microphone(): AudioNode | null { return this._defaultMic }
    set default_microphone(v: AudioNode | null) { this._setDefaultMic(v) }

    private _setDefaultSpeaker(v: AudioNode | null): void {
        if (v === this._defaultSpeaker) return
        this._defaultSpeaker = v
        this.notify("default-speaker")
    }

    private _setDefaultMic(v: AudioNode | null): void {
        if (v === this._defaultMic) return
        this._defaultMic = v
        this.notify("default-microphone")
    }

    private _defaultsChanged(): void {
        if (!this._defaults) return
        this._setDefaultSpeaker(this._defaultFor(CLASS_SPEAKER, this.get_speakers()))
        this._setDefaultMic(this._defaultFor(CLASS_MIC, this.get_microphones()))
    }

    private _defaultFor(mediaClass: string, candidates: AudioNode[]): AudioNode | null {
        let id = 0
        try {
            id = this._defaults.emit("get-default-node", mediaClass)
        } catch (e) {
            console.error("[Wp] get-default-node:", e)
            return null
        }
        return candidates.find(n => n.id === id) ?? null
    }

    private _volumeChanged(id: number): void {
        for (const node of this._nodes.values()) {
            if (node.id === id) { node.refreshVolume(); return }
        }
    }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let instance: Audio | null = null
let failed = false

/** The shell's one WirePlumber connection, or null while PipeWire is not there.
 *
 *  Returned IMMEDIATELY — the roster fills on the main loop a moment later,
 *  exactly as AstalWp's did, which is why every consumer primes inside its
 *  subscription rather than reading once at build time (see the CC volume tile).
 *
 *  🔑 Null and "empty" are DIFFERENT answers, and keeping them apart is the whole
 *  reason `start()` is separate from the constructor. An object that had failed to
 *  connect would look exactly like a machine with no sound card — the shell would
 *  draw "no audio hardware" over a dead socket, and a probe would report a green
 *  run against nothing. It also buys the retry for free: a shell that starts
 *  before PipeWire settles heals on the next call instead of staying deaf for the
 *  session. */
export function getDefault(): Audio | null {
    if (failed) return null
    if (!instance) {
        try {
            instance = new Audio()
        } catch (e) {
            console.error("[Wp] init failed:", e)
            failed = true                 // a throw here is not a "try again later"
            return null
        }
    }
    return instance.start() ? instance : null
}

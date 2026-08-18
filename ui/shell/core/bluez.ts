// The shell's own door to BlueZ.
//
// Replaces AstalBluetooth (2026-08-18). That library was 681 lines of Vala over
// `Gio.DBusObjectManagerClient` on `org.bluez` — there is **no library
// underneath it**, exactly as there was none under AstalMpris. BlueZ is a D-Bus
// service, so a client of it is a set of proxies, and this file is those proxies.
//
// Two facts made this the cheap one to absorb:
//
//   - the WRITE half was already ours. The pairing agent (`org.bluez.Agent1`,
//     AgentManager1 register/unregister, the Rejected/Canceled returns) has been
//     raw D-Bus in `core/BluetoothService.ts` since long before this. The library
//     was only ever answering "what is on the bus and what are its properties".
//   - there was exactly ONE runtime use of it in the whole shell — the
//     `get_default()` inside that same facade. Settings and the bar widget only
//     ever held `AstalBluetooth.Device` as a TYPE.
//
// `core/BluetoothService.ts` keeps its public API unchanged, so no surface moved.
//
// ── Why devices are still GObjects ───────────────────────────────────────────
//
// Because consumers listen per object: `watchDevices` wires `notify::paired`,
// `notify::connected` and `notify::name` on every device, and re-wires them when
// the set changes. A plain-object roster would have forced every one of those
// call sites to change shape, which is not what an absorption is for.
//
// ⚠️ The GJS rule this cost us on AstalMpris, measured then and obeyed here: the
// snake_case accessors ARE the ParamSpec's accessors. A getter without its setter
// is a hard error at registration, and a ParamSpec with no accessor of ours gets
// an auto-generated one backed by separate storage — it would read stale forever.
// So every property below declares the PAIR, with an equality guard and a manual
// `notify()`. The setters of read-only BlueZ properties are internal: they exist
// for the ParamSpec and are driven from `PropertiesChanged`, never by callers.
import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const BLUEZ = "org.bluez"
const IF_ADAPTER = "org.bluez.Adapter1"
const IF_DEVICE = "org.bluez.Device1"
const IF_OM = "org.freedesktop.DBus.ObjectManager"

/** A `Gio.DBusProxy` for one interface on one object, or null if it cannot be had. */
function proxyFor(conn: any, path: string, iface: string): any {
    try {
        return Gio.DBusProxy.new_sync(
            conn, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            BLUEZ, path, iface, null)
    } catch (e) {
        console.error(`[BlueZ] proxy ${iface} at ${path}:`, e)
        return null
    }
}

/**
 * Write one D-Bus property.
 *
 * Through the CONNECTION, not `proxy.call()`: a proxy's `call` takes a METHOD
 * name and speaks the proxy's own interface, so passing it
 * "org.freedesktop.DBus.Properties" lands the interface where the method belongs
 * and GJS refuses with "Expected an object of type GVariant for argument
 * 'parameters' but got type string". Properties live on another interface, so the
 * write has to name object, interface and method itself.
 */
function setProp(proxy: any, iface: string, name: string, value: any): void {
    const conn = proxy?.get_connection?.()
    const path = proxy?.get_object_path?.()
    if (!conn || !path) return
    conn.call(
        BLUEZ, path, "org.freedesktop.DBus.Properties", "Set",
        new GLib.Variant("(ssv)", [iface, name, value]),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (src: any, res: any) => {
            try { src.call_finish(res) }
            catch (e) { console.error(`[BlueZ] set ${iface}.${name}:`, e) }
        })
}

/** Unwrap a cached D-Bus property, or `fallback` when the device does not have it. */
function prop(proxy: any, name: string, fallback: any): any {
    try {
        const v = proxy?.get_cached_property(name)
        return v === null || v === undefined ? fallback : v.deepUnpack()
    } catch {
        return fallback
    }
}

// ── Device ───────────────────────────────────────────────────────────────────

export class Device extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraBluezDevice",
            Properties: {
                "name": GObject.ParamSpec.string("name", "", "", GObject.ParamFlags.READWRITE, ""),
                "address": GObject.ParamSpec.string("address", "", "", GObject.ParamFlags.READWRITE, ""),
                "icon": GObject.ParamSpec.string("icon", "", "", GObject.ParamFlags.READWRITE, ""),
                "paired": GObject.ParamSpec.boolean("paired", "", "", GObject.ParamFlags.READWRITE, false),
                "connected": GObject.ParamSpec.boolean("connected", "", "", GObject.ParamFlags.READWRITE, false),
                "trusted": GObject.ParamSpec.boolean("trusted", "", "", GObject.ParamFlags.READWRITE, false),
            },
        }, this)
    }

    readonly object_path: string
    private _proxy: any = null
    private _propsId = 0

    private _name = ""
    private _address = ""
    private _icon = ""
    private _paired = false
    private _connected = false
    private _trusted = false

    constructor(conn: any, path: string) {
        super()
        this.object_path = path
        this._proxy = proxyFor(conn, path, IF_DEVICE)
        if (!this._proxy) return
        this._propsId = this._proxy.connect("g-properties-changed", () => this._sync())
        this._sync()
    }

    /** Re-read everything from the proxy's cache. Each setter guards on equality,
     *  so a PropertiesChanged carrying one key emits exactly one notify. */
    private _sync(): void {
        // BlueZ omits `Name` entirely for a device that never advertised one —
        // hence the address fallback that `BluetoothService.deviceName` relies on.
        this.name = prop(this._proxy, "Name", "")
        this.address = prop(this._proxy, "Address", "")
        this.icon = prop(this._proxy, "Icon", "")
        this.paired = prop(this._proxy, "Paired", false)
        this.connected = prop(this._proxy, "Connected", false)
        // NOT `this.trusted = …`: that setter WRITES to BlueZ, and this method runs
        // on every PropertiesChanged. Assigning here echoed each notification
        // straight back onto the bus, and the throw took the whole roster with it —
        // the seed loop aborted after the adapter, so the shell saw one adapter and
        // zero devices. A property whose setter has side effects needs a separate
        // internal path for "the bus told us", and that is the rule for all of them.
        this._setTrusted(prop(this._proxy, "Trusted", false))
    }

    private _setTrusted(v: boolean): void {
        if (v !== this._trusted) { this._trusted = v; this.notify("trusted") }
    }

    get name(): string { return this._name }
    set name(v: string) { if (v !== this._name) { this._name = v; this.notify("name") } }

    get address(): string { return this._address }
    set address(v: string) { if (v !== this._address) { this._address = v; this.notify("address") } }

    get icon(): string { return this._icon }
    set icon(v: string) { if (v !== this._icon) { this._icon = v; this.notify("icon") } }

    get paired(): boolean { return this._paired }
    set paired(v: boolean) { if (v !== this._paired) { this._paired = v; this.notify("paired") } }

    get connected(): boolean { return this._connected }
    set connected(v: boolean) { if (v !== this._connected) { this._connected = v; this.notify("connected") } }

    /** The one property here a CALLER writes: BluetoothService trusts a device the
     *  moment it pairs, so BlueZ stops asking the agent to authorise every
     *  reconnection. The local field follows PropertiesChanged, not this call. */
    get trusted(): boolean { return this._trusted }
    set trusted(v: boolean) {
        this._setTrusted(v)
        setProp(this._proxy, IF_DEVICE, "Trusted", new GLib.Variant("b", v))
    }

    // NOT named `connect`/`disconnect`: those are GObject's own signal methods and
    // every consumer calls `dev.connect("notify::paired", …)`. AstalBluetooth named
    // them the same way for the same reason.
    connect_device(_cancellable?: any): void { this._call("Connect") }
    disconnect_device(_cancellable?: any): void { this._call("Disconnect") }
    pair(): void { this._call("Pair") }

    /** Fire and forget, but never silently: a refused pairing is a real answer. */
    private _call(method: string): void {
        this._proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null,
            (src: any, res: any) => {
                try { src.call_finish(res) }
                catch (e) { console.error(`[BlueZ] ${method} on ${this.object_path}:`, e) }
            })
    }

    destroy(): void {
        if (this._proxy && this._propsId) GObject.signal_handler_disconnect(this._proxy, this._propsId)
        this._propsId = 0
        this._proxy = null
    }
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class Adapter extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraBluezAdapter",
            Properties: {
                "powered": GObject.ParamSpec.boolean("powered", "", "", GObject.ParamFlags.READWRITE, false),
                "discovering": GObject.ParamSpec.boolean("discovering", "", "", GObject.ParamFlags.READWRITE, false),
            },
        }, this)
    }

    readonly object_path: string
    private _proxy: any = null
    private _propsId = 0
    private _powered = false
    private _discovering = false

    constructor(conn: any, path: string) {
        super()
        this.object_path = path
        this._proxy = proxyFor(conn, path, IF_ADAPTER)
        if (!this._proxy) return
        this._propsId = this._proxy.connect("g-properties-changed", () => this._sync())
        this._sync()
    }

    private _sync(): void {
        this._setPowered(prop(this._proxy, "Powered", false))
        const d = prop(this._proxy, "Discovering", false)
        if (d !== this._discovering) { this._discovering = d; this.notify("discovering") }
    }

    private _setPowered(v: boolean): void {
        if (v !== this._powered) { this._powered = v; this.notify("powered") }
    }

    get powered(): boolean { return this._powered }
    /** Writing this is what actually turns the radio on and off. The local field
     *  is corrected by PropertiesChanged either way, so a refused write does not
     *  leave the toggle lying about the radio. */
    set powered(v: boolean) {
        this._setPowered(v)
        setProp(this._proxy, IF_ADAPTER, "Powered", new GLib.Variant("b", v))
    }

    get discovering(): boolean { return this._discovering }
    set discovering(v: boolean) { if (v !== this._discovering) { this._discovering = v; this.notify("discovering") } }

    start_discovery(): void { this._call("StartDiscovery", null) }
    stop_discovery(): void { this._call("StopDiscovery", null) }

    /** BlueZ forgets a device by OBJECT PATH, which is why Device carries its own. */
    remove_device(dev: Device | string): void {
        const path = typeof dev === "string" ? dev : dev?.object_path
        if (!path) return
        this._call("RemoveDevice", new GLib.Variant("(o)", [path]))
    }

    private _call(method: string, args: any): void {
        this._proxy?.call(method, args, Gio.DBusCallFlags.NONE, -1, null,
            (src: any, res: any) => {
                try { src.call_finish(res) }
                catch (e) { console.error(`[BlueZ] ${method}:`, e) }
            })
    }

    destroy(): void {
        if (this._proxy && this._propsId) GObject.signal_handler_disconnect(this._proxy, this._propsId)
        this._propsId = 0
        this._proxy = null
    }
}

// ── The roster ───────────────────────────────────────────────────────────────

export class Bluetooth extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "NidaraBluez",
            Properties: {
                "is-powered": GObject.ParamSpec.boolean("is-powered", "", "", GObject.ParamFlags.READWRITE, false),
                "adapters": GObject.ParamSpec.jsobject("adapters", "", "", GObject.ParamFlags.READWRITE),
                "devices": GObject.ParamSpec.jsobject("devices", "", "", GObject.ParamFlags.READWRITE),
            },
        }, this)
    }

    private _conn: any = null
    private _adapters: Adapter[] = []
    private _devices: Device[] = []
    private _isPowered = false
    private _powerIds = new Map<Adapter, number>()
    private _subIds: number[] = []

    constructor() {
        super()
        try {
            this._conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
        } catch (e) {
            // BlueZ lives on the SYSTEM bus. No bus, no Bluetooth — the facade's
            // hasAdapter() goes false and the page shows its no-adapter banner.
            console.error("[BlueZ] no system bus:", e)
            return
        }

        // One subscription per ObjectManager signal, filtered by the bus itself.
        for (const [member, handler] of [
            ["InterfacesAdded", (params: any) => this._onAdded(params)],
            ["InterfacesRemoved", (params: any) => this._onRemoved(params)],
        ] as const) {
            this._subIds.push(this._conn.signal_subscribe(
                BLUEZ, IF_OM, member, "/", null, Gio.DBusSignalFlags.NONE,
                (_c: any, _s: any, _p: any, _i: any, _m: any, params: any) => handler(params)))
        }

        // bluetoothd restarting, or a dongle appearing, is a name-owner change.
        // Without this the roster would keep dead proxies for a service that left.
        Gio.bus_watch_name_on_connection(
            this._conn, BLUEZ, Gio.BusNameWatcherFlags.NONE,
            () => this._seed(),
            () => this._clear())

        // And seed SYNCHRONOUSLY, here. The watcher above is not enough on its own:
        // it delivers `appeared` through the main loop, so a caller reading
        // `devices()` in the same tick as `get_default()` would see an empty roster
        // — measured, and it is what AstalBluetooth's `for_bus_sync` never did.
        // `_seed` returns quietly when nobody owns the name, which is the other
        // half of this: calling GetManagedObjects unconditionally made every
        // machine without Bluetooth log a CRITICAL at boot ("Could not activate
        // remote peer 'org.bluez': unit failed") — not an error, just a laptop
        // with no radio.
        this._seed()
    }

    /** Does anyone own org.bluez right now? Cheap, synchronous, and the guard that
     *  keeps a radio-less machine quiet. */
    private _bluezIsUp(): boolean {
        try {
            const r = this._conn.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", new GLib.Variant("(s)", [BLUEZ]),
                new GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE, 2000, null)
            return r.deepUnpack()[0]
        } catch {
            return false
        }
    }

    /** Ask BlueZ for everything it has, once. */
    private _seed(): void {
        this._clear()
        if (!this._conn || !this._bluezIsUp()) return
        try {
            const reply = this._conn.call_sync(
                BLUEZ, "/", IF_OM, "GetManagedObjects", null,
                new GLib.VariantType("(a{oa{sa{sv}}})"),
                Gio.DBusCallFlags.NONE, -1, null)
            const [objects] = reply.deepUnpack() as [Record<string, Record<string, unknown>>]
            for (const [path, ifaces] of Object.entries(objects)) this._add(path, Object.keys(ifaces))
        } catch (e) {
            console.error("[BlueZ] GetManagedObjects:", e)
        }
        this._publish()
    }

    private _onAdded(params: any): void {
        const [path, ifaces] = params.deepUnpack() as [string, Record<string, unknown>]
        if (this._add(path, Object.keys(ifaces))) this._publish()
    }

    private _onRemoved(params: any): void {
        const [path, ifaces] = params.deepUnpack() as [string, string[]]
        let changed = false
        if (ifaces.includes(IF_DEVICE)) {
            const i = this._devices.findIndex(d => d.object_path === path)
            if (i >= 0) { this._devices[i].destroy(); this._devices.splice(i, 1); changed = true }
        }
        if (ifaces.includes(IF_ADAPTER)) {
            const i = this._adapters.findIndex(a => a.object_path === path)
            if (i >= 0) { this._dropAdapter(this._adapters[i]); this._adapters.splice(i, 1); changed = true }
        }
        if (changed) this._publish()
    }

    /** @returns whether the roster actually changed. */
    private _add(path: string, ifaces: string[]): boolean {
        let changed = false
        if (ifaces.includes(IF_ADAPTER) && !this._adapters.some(a => a.object_path === path)) {
            const a = new Adapter(this._conn, path)
            // The adapter's power IS the shell's `is_powered`, so follow it.
            this._powerIds.set(a, a.connect("notify::powered", () => this._syncPower()))
            this._adapters.push(a)
            changed = true
        }
        if (ifaces.includes(IF_DEVICE) && !this._devices.some(d => d.object_path === path)) {
            // Per-object try/catch: one unreadable device must not cost us the rest
            // of the roster. It did exactly that once — see `_sync` above.
            try {
                this._devices.push(new Device(this._conn, path))
                changed = true
            } catch (e) {
                console.error(`[BlueZ] device ${path}:`, e)
            }
        }
        return changed
    }

    private _dropAdapter(a: Adapter): void {
        const id = this._powerIds.get(a)
        if (id) GObject.signal_handler_disconnect(a, id)
        this._powerIds.delete(a)
        a.destroy()
    }

    private _clear(): void {
        this._devices.forEach(d => d.destroy())
        this._adapters.forEach(a => this._dropAdapter(a))
        this._devices = []
        this._adapters = []
        this._publish()
    }

    /** Emit the two list notifies and re-derive power, in that order. */
    private _publish(): void {
        this.notify("adapters")
        this.notify("devices")
        this._syncPower()
    }

    private _syncPower(): void {
        const v = this._adapters.length > 0 && this._adapters[0].powered
        if (v !== this._isPowered) { this._isPowered = v; this.notify("is-powered") }
    }

    get adapters(): Adapter[] { return this._adapters }
    set adapters(v: Adapter[]) { this._adapters = v; this.notify("adapters") }

    get devices(): Device[] { return this._devices }
    set devices(v: Device[]) { this._devices = v; this.notify("devices") }

    /** First adapter, or null. A derived getter with no notify of its own — the
     *  same shape AstalBluetooth had, which is why `watchAdapter` listens to
     *  `notify::adapters` and re-reads rather than watching this. */
    get adapter(): Adapter | null { return this._adapters[0] ?? null }

    get is_powered(): boolean { return this._isPowered }
    set is_powered(v: boolean) { if (v !== this._isPowered) { this._isPowered = v; this.notify("is-powered") } }
}

let instance: Bluetooth | null = null

/** The singleton, built on first use. Mirrors `AstalBluetooth.get_default()`. */
export function get_default(): Bluetooth {
    if (!instance) instance = new Bluetooth()
    return instance
}

export default { get_default, Bluetooth, Adapter, Device }

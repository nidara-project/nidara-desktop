// NetworkService — the single source of network domain logic, and the ONLY place
// in the shell that talks to NetworkManager.
//
// It used to be a stateless facade over AstalNetwork. It is not any more: the
// read half now sits directly on `libnm` (`gi://NM`), the same C library Astal's
// Vala wrapper was wrapping. The write half never went through Astal at all: it
// was `nmcli` calls, and joining/leaving/forgetting a Wi-Fi network moved to libnm
// on 2026-09-14 (see "Wi-Fi commands") — the radio, rescan and VPN still spawn nmcli.
//
// WHY the wrapper went away (tech-debt #22/#71): `AstalNetwork.Network` resolves
// its Wifi/Wired wrappers ONCE, in `construct`, from a single `get_devices()`
// scan. It never connects to NM's `device-added`/`device-removed`, so a USB
// dongle plugged in after login is invisible for the rest of the session — in
// Settings, in the Control Center AND in the bar. It could not be repaired from
// outside either: both wrappers have `internal` constructors, so a consumer
// cannot build the missing one, and `notify::wifi` / `notify::wired` exist in
// the API but can never fire because nothing ever assigns them.
//
// libnm gives us the device list AND the two signals, so device presence is a
// live subscription here (`watchDevices`) instead of a fact frozen at boot. The
// UI contract is unchanged: this module owns the command vocabulary, the
// NM-flag/frequency derivations and the notify-subscription helpers; it never
// imports Gtk and never builds anything.
//
// Everything below is READ-ONLY against NM except the commands. Widgets
// must not import `gi://NM` — they ask this module, like they already did.

import { execAsync } from "../../lib/process"
import GLib from "gi://GLib"
import NM from "gi://NM?version=1.0"
import { t, currentLocale } from "./i18n"
import { takeUserCancel } from "./NetworkCancels"
import { safeDisconnect } from "./signals"

type Dispose = () => void

// ── The NM client ───────────────────────────────────────────────────────────
//
// One synchronous client for the shell's lifetime. `NM.Client.new()` is the sync
// constructor; it is absent from the generated typings (it collides with
// `Gio.Initable.new`, the same way `new_finish` is flagged "Conflicted" there),
// so the cast is deliberate and the only one in this file.

let _client: NM.Client | null = null
let _clientTried = false

function client(): NM.Client | null {
    if (_clientTried) return _client
    _clientTried = true
    try {
        _client = (NM.Client as any).new(null) as NM.Client
    } catch (e) {
        console.error("[Network] NetworkManager is unavailable:", e)
        _client = null
    }
    return _client
}

// ── Device selection ────────────────────────────────────────────────────────
//
// Same rule Astal used: among the devices of a type, prefer one that carries an
// active connection, else take the first. Kept deliberately — a machine with two
// wifi radios (the `fake-wifi.sh` rig is exactly that: wlan0 client + wlan1 AP)
// must keep picking the same one it picked before.

function pickDevice(type: NM.DeviceType): NM.Device | null {
    const c = client()
    if (!c) return null
    const all = c.get_devices().filter(d => d.get_device_type() === type)
    return all.find(d => !!d.get_active_connection()) ?? all[0] ?? null
}

// ── Internet state ──────────────────────────────────────────────────────────

/** Replaces `AstalNetwork.Internet`. Same three states, same derivation. */
export enum Internet { CONNECTED, CONNECTING, DISCONNECTED }

function internetOf(device: NM.Device | null | undefined): Internet {
    const ac = device?.get_active_connection()
    if (!ac) return Internet.DISCONNECTED
    switch (ac.state) {
        case NM.ActiveConnectionState.ACTIVATED:  return Internet.CONNECTED
        case NM.ActiveConnectionState.ACTIVATING: return Internet.CONNECTING
        default:                                  return Internet.DISCONNECTED
    }
}

// ── Handles ─────────────────────────────────────────────────────────────────
//
// Thin live views over an NM device — every member is a getter that reads the
// device at call time, so a handle is never stale while its device lives. They
// keep the property names the old Astal wrappers had (`active_access_point`,
// `get_access_points`) so the surfaces read the same as before.

export interface WifiHandle {
    readonly device: NM.DeviceWifi
    readonly enabled: boolean
    readonly ssid: string
    readonly active_access_point: NM.AccessPoint | null
    readonly internet: Internet
    get_access_points(): NM.AccessPoint[]
}

export interface WiredHandle {
    readonly device: NM.DeviceEthernet
    readonly internet: Internet
    readonly speed: number
}

function makeWifi(device: NM.DeviceWifi): WifiHandle {
    return {
        device,
        get enabled() { return client()?.wireless_enabled ?? false },
        get active_access_point() { return device.get_active_access_point() ?? null },
        get ssid() {
            const ap = device.get_active_access_point()
            return ap ? apSsid(ap) : ""
        },
        get internet() { return internetOf(device) },
        get_access_points() { return device.get_access_points() ?? [] },
    }
}

function makeWired(device: NM.DeviceEthernet): WiredHandle {
    return {
        device,
        get internet() { return internetOf(device) },
        get speed() { return device.speed },
    }
}

// ── Live device presence ────────────────────────────────────────────────────
//
// THE fix for tech-debt #22/#71. The selected devices are resolved once and then
// re-resolved on every NM device-added/device-removed, and listeners are only
// told when the SELECTION actually changed.
//
// That guard is not an optimisation, it is correctness: NM emits device-added
// for every tun/bridge/veth the system creates, so a VPN going up or Docker
// starting would otherwise rebuild the Wi-Fi list and re-arm every subscription
// in the shell for a device nobody asked about.

let _wifiDevice:  NM.DeviceWifi | null = null
let _wiredDevice: NM.DeviceEthernet | null = null
let _wifiHandle:  WifiHandle | null = null
let _wiredHandle: WiredHandle | null = null
let _resolved = false

const deviceListeners = new Set<() => void>()

function resolve(): boolean {
    const w = pickDevice(NM.DeviceType.WIFI) as NM.DeviceWifi | null
    const e = pickDevice(NM.DeviceType.ETHERNET) as NM.DeviceEthernet | null
    if (w === _wifiDevice && e === _wiredDevice) return false

    _wifiDevice  = w
    _wiredDevice = e
    _wifiHandle  = w ? makeWifi(w)  : null
    _wiredHandle = e ? makeWired(e) : null
    return true
}

function ensureResolved(): void {
    if (_resolved) return
    _resolved = true

    const c = client()
    if (!c) return

    resolve()

    const onChange = () => {
        if (!resolve()) return
        for (const cb of [...deviceListeners]) {
            try { cb() } catch (e) { console.error("[Network] device listener failed:", e) }
        }
    }
    // Shell-lifetime subscriptions on the client singleton — never disposed.
    c.connect("device-added", onChange)
    c.connect("device-removed", onChange)
}

/**
 * False when NetworkManager itself could not be reached (not installed, not
 * running). Distinct from "no adapter": with no NM there is nothing to watch and
 * no question worth re-asking, so surfaces say so once and stop.
 */
export function available(): boolean {
    ensureResolved()
    return client() !== null
}

/** The Wi-Fi device wrapper, or null when the machine has no wireless adapter. */
export function wifi(): WifiHandle | null {
    ensureResolved()
    return _wifiHandle
}

/** The Ethernet device wrapper, or null when the machine has no wired adapter. */
export function wired(): WiredHandle | null {
    ensureResolved()
    return _wiredHandle
}

/**
 * Fires whenever the Wi-Fi or Ethernet adapter APPEARS or DISAPPEARS.
 *
 * This is the subscription that did not exist before: hardware presence is a
 * question that gets re-answered, not a build-time fact. Any surface that draws
 * something different with/without an adapter must go through this — Settings
 * switches a placeholder, the CC/bar tiles rebuild their content.
 */
export function watchDevices(cb: () => void): Dispose {
    ensureResolved()
    deviceListeners.add(cb)
    return () => { deviceListeners.delete(cb) }
}

/**
 * Bind `subscribe` to the CURRENT devices and re-bind it whenever they change,
 * notifying `cb` on each swap. Every watcher below is built on this, which is
 * what makes them survive a hot-plug: a handler armed on a device that has just
 * been unplugged is torn down, re-armed on the new one, and the caller is told
 * to re-read the world.
 */
function rebindable(subscribe: () => Dispose, cb: () => void): Dispose {
    let inner = subscribe()
    const off = watchDevices(() => {
        inner()
        inner = subscribe()
        cb()
    })
    return () => { inner(); off() }
}

// A tiny signal-bag: collect (object, handlerId) pairs and disconnect them all.
function bag() {
    const ids: Array<[any, number]> = []
    const extra: Dispose[] = []
    return {
        on(obj: any, sig: string, cb: () => void) {
            if (obj?.connect) ids.push([obj, obj.connect(sig, cb)])
        },
        add(d: Dispose) { extra.push(d) },
        dispose(): void {
            ids.forEach(([obj, id]) => safeDisconnect(obj, id))
            extra.forEach(d => d())
        },
    }
}

/**
 * Keep a handler on a device's CURRENT active connection.
 *
 * A device's `NM.ActiveConnection` is a different object per connection, so a
 * handler armed on the one that existed at subscribe time goes stale the moment
 * the user joins another network — and the ACTIVATING → ACTIVATED transition,
 * which is what "connected" actually means, is a property change on that object.
 * So it is re-armed every time the device swaps connections.
 */
function onActiveConnection(device: NM.Device, cb: () => void): Dispose {
    let ac: NM.ActiveConnection | null = null
    let acId = 0

    const rebind = () => {
        if (ac && acId) safeDisconnect(ac, acId)
        ac = device.get_active_connection() ?? null
        acId = ac ? ac.connect("notify::state", cb) : 0
    }
    rebind()

    const devId = device.connect("notify::active-connection", () => { rebind(); cb() })
    return () => {
        if (ac && acId) safeDisconnect(ac, acId)
        safeDisconnect(device, devId)
    }
}

// ── Pure derivations ────────────────────────────────────────────────────────

const NM_AP_FLAGS_PRIVACY = 0x1
// NM.80211ApSecurityFlags bits used to classify the security scheme.
const SEC_KEY_8021X = 0x200
const SEC_KEY_SAE   = 0x400   // WPA3 personal
const SEC_KEY_OWE   = 0x800   // Enhanced Open

export function isSecured(ap: any): boolean {
    return (ap.flags & NM_AP_FLAGS_PRIVACY) !== 0
        || (ap.wpa_flags ?? 0) !== 0
        || (ap.rsn_flags ?? 0) !== 0
}

export function securityLabel(ap: any): string {
    const rsn = ap.rsn_flags ?? 0
    const wpa = ap.wpa_flags ?? 0
    if (rsn === 0 && wpa === 0) {
        return (ap.flags & NM_AP_FLAGS_PRIVACY) ? "WEP" : t("settings.network.security.open")
    }
    const parts: string[] = []
    if (rsn & SEC_KEY_SAE) parts.push("WPA3")
    if (rsn & SEC_KEY_OWE) parts.push("OWE")
    if ((rsn & SEC_KEY_8021X) || (wpa & SEC_KEY_8021X)) parts.push(t("settings.network.security.enterprise"))
    if (parts.length === 0) parts.push(rsn !== 0 ? "WPA2" : "WPA")
    return parts.join(" / ")
}

/** "2,4 GHz" in Spanish, "2.4 GHz" in English — the decimal is the locale's. */
export function freqBand(freq: number): string {
    const ghz = freq >= 5925 ? 6 : freq >= 4900 ? 5 : 2.4
    return `${new Intl.NumberFormat(currentLocale()).format(ghz)} GHz`
}

export function freqChannel(freq: number): number {
    if (freq === 2484) return 14
    if (freq >= 2412 && freq <= 2484) return Math.round((freq - 2407) / 5)
    if (freq >= 5000 && freq < 5925)  return Math.round((freq - 5000) / 5)
    if (freq >= 5925)                 return Math.round((freq - 5950) / 5)
    return 0
}

/**
 * An access point's SSID as text.
 *
 * The one place where NM is rawer than the wrapper we dropped: `NM.AccessPoint`
 * exposes `ssid` as GLib.Bytes (an SSID is arbitrary bytes, not a string), so it
 * goes through NM's own decoder. Everything else an AP carries — bssid, strength,
 * frequency, max_bitrate, flags, wpa_flags, rsn_flags — is read straight off the
 * NM object, because Astal's AccessPoint was pure pass-through for those.
 */
export function apSsid(ap: NM.AccessPoint): string {
    try {
        const data = ap.ssid?.get_data()
        if (!data || data.length === 0) return ""
        return NM.utils_ssid_to_utf8(data)
    } catch {
        return ""
    }
}

/** Best-effort IPv4 address for a wifi/wired handle (or any object with a device). */
export function getIp(service: any, fallback = "—"): string {
    const device = service?.device
    if (!device) return fallback
    // Only while ACTIVATED: NM leaves the last ip4-config on a device that has just
    // gone away — Wi-Fi switched off, cable pulled — and it read as still connected.
    if (device.get_state?.() !== NM.DeviceState.ACTIVATED) return fallback
    try {
        const addrs = device.get_ip4_config()?.get_addresses()
        if (addrs?.length > 0) return String(addrs[0].get_address())
    } catch {}
    return fallback
}

/** True when the wired device reports an established connection. */
export function wiredConnected(w: WiredHandle | null = wired()): boolean {
    return !!w && w.internet === Internet.CONNECTED
}

/**
 * True unless the Wi-Fi radio is explicitly off.
 *
 * Note the "unless": with no wireless hardware at all this answers TRUE, which
 * is what the Astal-backed version did (`undefined !== false`) and what the bar
 * icon expects — a machine without Wi-Fi must not render a "radio off" icon,
 * because the radio is not off, it is absent. Presence is `wifi() !== null`.
 */
export function wifiEnabled(w: WifiHandle | null = wifi()): boolean {
    if (!w) return true
    return w.enabled
}

// ── Wi-Fi commands ──────────────────────────────────────────────────────────
//
// Joining, leaving and forgetting a network go through libnm, never `nmcli`: a
// password passed as `nmcli … password X` is in argv — readable by any local user
// with `ps` — and nmcli cannot be asked again when the key is wrong. The shell
// now activates WITHOUT secrets and NetworkManager asks core/NetworkAgent for
// them, as often as it needs to (a wrong key, a router whose password changed);
// the dialogs that ask are libnma's (common/WifiSecretsDialog.ts).

/** Why a connection attempt ended without a connection. */
export class ConnectError extends Error {
    constructor(readonly reason: "cancelled" | "failed") { super(reason) }
}

function ssidBytesOf(conn: NM.Connection): Uint8Array | null {
    const w = conn.get_setting_wireless?.()
    const data = w?.get_ssid()?.get_data()
    return data && data.length > 0 ? data : null
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

/** Saved Wi-Fi profiles for this access point's network, matched by SSID BYTES —
 *  not by profile name, which only coincides when the shell itself created it
 *  (a profile made in nmtui as "Casa" is still this network). Newest first. */
function savedProfilesFor(ap: NM.AccessPoint): NM.RemoteConnection[] {
    const want = ap.ssid?.get_data() ?? null
    return (client()?.get_connections() ?? [])
        .filter(c => c.get_connection_type() === "802-11-wireless" && sameBytes(ssidBytesOf(c), want))
        .sort((a, b) => Number(b.get_setting_connection()?.get_timestamp() ?? 0) - Number(a.get_setting_connection()?.get_timestamp() ?? 0))
}

/** SSIDs (as text) that have at least one saved Wi-Fi profile. */
export function savedWifiSsids(): Set<string> {
    const set = new Set<string>()
    for (const c of client()?.get_connections() ?? []) {
        if (c.get_connection_type() !== "802-11-wireless") continue
        const data = ssidBytesOf(c)
        if (data) { try { set.add(NM.utils_ssid_to_utf8(data)) } catch {} }
    }
    return set
}

/** A saved profile's SSID as text ("" when it has none). */
export function profileSsid(rc: NM.Connection | null): string {
    const data = rc ? ssidBytesOf(rc) : null
    try { return data ? NM.utils_ssid_to_utf8(data) : "" } catch { return "" }
}

/** The profile carries a security setting (what a lock means for a network not in range). */
export function profileSecured(rc: NM.Connection): boolean {
    return !!rc.get_setting_wireless_security()
}

/**
 * Saved HIDDEN networks that the scan does not show by name — a hidden network announces
 * none, so without this it could never appear in a list, and rejoining it meant retyping
 * its name in "Other network…". libnma's form answered that with a "Connection" menu of
 * EVERY saved Wi-Fi profile, visible ones included (owner, 2026-09-28: "what is the sense
 * of adding a hidden one and picking a saved connection?"); the panel lists these instead.
 * Most recently used first.
 */
export function savedHiddenNetworks(): NM.RemoteConnection[] {
    const visible = new Set((_wifiDevice?.get_access_points() ?? []).map(apSsid).filter(Boolean))
    return (client()?.get_connections() ?? [])
        .filter(c => c.get_connection_type() === "802-11-wireless" && !!c.get_setting_wireless()?.get_hidden())
        .filter(c => { const ssid = profileSsid(c); return !!ssid && !visible.has(ssid) })
        .sort((a, b) => Number(b.get_setting_connection()?.get_timestamp() ?? 0) - Number(a.get_setting_connection()?.get_timestamp() ?? 0))
}

/** The objects libnma's Wi-Fi dialogs are built from. Only common/WifiSecretsDialog may use
 *  them — every other surface asks this module in its own vocabulary. */
export function nmObjects(): { client: NM.Client; device: NM.DeviceWifi } | null {
    const c = client()
    const d = wifi()?.device ?? null
    return c && d ? { client: c, device: d } : null
}

/** A visible access point broadcasting `conn`'s SSID, strongest first — what libnma's
 *  dialog needs to be built for a connection. Null for a hidden or out-of-range one. */
export function apForConnection(conn: NM.Connection): NM.AccessPoint | null {
    const want = ssidBytesOf(conn)
    return (_wifiDevice?.get_access_points() ?? [])
        .filter(ap => sameBytes(ap.ssid?.get_data() ?? null, want))
        .sort((a, b) => b.strength - a.strength)[0] ?? null
}

/** True when joining `ap` needs more than a password — an 802.1X (enterprise) network,
 *  which NM cannot complete from the access point alone: identity, EAP method and
 *  certificates have to come from a dialog BEFORE the connection exists. */
export function needsSetupDialog(ap: NM.AccessPoint): boolean {
    return ((ap.rsn_flags ?? 0) & SEC_KEY_8021X) !== 0 || ((ap.wpa_flags ?? 0) & SEC_KEY_8021X) !== 0
}

/**
 * Join `ap`. Resolves once the connection is ACTIVATED; rejects with a
 * ConnectError when it ends any other way. Secrets are never passed from here: a
 * `connection` built by libnma's dialog carries what the user typed over D-Bus, and
 * anything still missing — or refused — NetworkManager asks the agent for.
 *
 * With no saved profile and no `connection`, NM completes one from the access point
 * itself. A profile this call CREATED is deleted again if the attempt fails, so a
 * cancelled dialog or a refused key does not leave a "saved" network behind that
 * has no working key in it.
 */
export function connectAp(ap: NM.AccessPoint | null, connection: NM.Connection | null = null): Promise<void> {
    return new Promise((resolve, reject) => {
        const c = client()
        const dev = _wifiDevice
        if (!c || !dev || (!ap && !connection)) return reject(new ConnectError("failed"))

        const saved = connection || !ap ? null : savedProfilesFor(ap)[0] ?? null
        const follow = (ac: NM.ActiveConnection, fresh: boolean) => {
            let id = 0
            const done = (ok: boolean, why: ConnectError["reason"] = "failed") => {
                if (id) { safeDisconnect(ac, id); id = 0 }
                if (ok) return resolve()
                if (fresh) {
                    const rc = ac.get_connection()
                    rc?.delete_async(null, (o: any, r: any) => { try { o.delete_finish(r) } catch {} })
                }
                reject(new ConnectError(why))
            }
            const check = (state: number) => {
                if (state === NM.ActiveConnectionState.ACTIVATED) done(true)
                else if (state === NM.ActiveConnectionState.DEACTIVATED)
                    done(false, takeUserCancel(ac.get_uuid() ?? "") ? "cancelled" : "failed")
            }
            id = ac.connect("state-changed", (_a: any, state: number) => check(state))
            check(ac.get_state())
        }

        try {
            // A SAVED profile named directly (a hidden network from the panel's Known
            // list): activate it as it is — add_and_activate would save a second copy.
            if (!ap && connection instanceof NM.RemoteConnection) {
                c.activate_connection_async(connection, dev, null, null, (o: any, r: any) => {
                    try { follow(o.activate_connection_finish(r), false) }
                    catch (e) { console.error("[Network] activate saved:", e); reject(new ConnectError("failed")) }
                })
            } else if (saved && ap) {
                c.activate_connection_async(saved, dev, ap.get_path(), null, (o: any, r: any) => {
                    try { follow(o.activate_connection_finish(r), false) }
                    catch (e) { console.error("[Network] activate:", e); reject(new ConnectError("failed")) }
                })
            } else {
                // A null connection is completed by NM from the access point itself —
                // SSID, and the security scheme (WPA2, WPA3, open) the AP announces. A
                // hidden network has no AP to point at: its connection names the SSID.
                c.add_and_activate_connection_async(connection, dev, ap?.get_path() ?? null, null, (o: any, r: any) => {
                    try { follow(o.add_and_activate_connection_finish(r), true) }
                    catch (e) { console.error("[Network] add and activate:", e); reject(new ConnectError("failed")) }
                })
            }
        } catch (e) {
            console.error("[Network] connect:", e)
            reject(new ConnectError("failed"))
        }
    })
}

/** Leave whatever Wi-Fi network the adapter is on. */
export function disconnectWifi(): Promise<void> {
    return new Promise((resolve, reject) => {
        const dev = _wifiDevice
        if (!dev) return resolve()
        dev.disconnect_async(null, (o: any, r: any) => {
            try { o.disconnect_finish(r); resolve() } catch (e) { reject(e) }
        })
    })
}

/** What the Wi-Fi panel shows under the network the adapter is on (Apple's Option-click
 *  details, shown behind a visible chevron instead). Null unless connected. The IP and
 *  gateway arrive with DHCP, after the SSID — watch `watchWifi`, not `watchWifiLink`. */
export interface WifiConnectionDetails { ip: string; gateway: string; band: string; channel: number; security: string }

export function wifiConnectionDetails(): WifiConnectionDetails | null {
    const dev = _wifiDevice
    if (!dev || dev.get_state() !== NM.DeviceState.ACTIVATED) return null
    const ap = dev.get_active_access_point()
    if (!ap) return null
    let gateway = "—"
    try { gateway = dev.get_ip4_config()?.get_gateway() || "—" } catch {}
    return {
        ip: getIp(wifi()),
        gateway,
        band: freqBand(ap.frequency),
        channel: freqChannel(ap.frequency),
        security: securityLabel(ap),
    }
}

/** Delete every saved profile for `ap`'s network. */
export function forgetNetwork(ap: NM.AccessPoint): Promise<void> {
    return Promise.all(savedProfilesFor(ap).map(rc => new Promise<void>((resolve, reject) => {
        rc.delete_async(null, (o: any, r: any) => { try { o.delete_finish(r); resolve() } catch (e) { reject(e) } })
    }))).then(() => {})
}

/** Where the adapter stands with this access point, for a row that must survive
 *  being rebuilt: read from NM each time, never kept in the row. */
export function apLinkState(ap: NM.AccessPoint): "connected" | "connecting" | "idle" {
    const dev = _wifiDevice
    if (!dev) return "idle"
    const st = dev.get_state()
    if (st === NM.DeviceState.ACTIVATED)
        return dev.get_active_access_point()?.get_bssid() === ap.get_bssid() ? "connected" : "idle"
    if (st < NM.DeviceState.PREPARE || st > NM.DeviceState.ACTIVATED) return "idle"
    // While joining, the active AP is not reliable: NM drops it between a refused key
    // and the next attempt (the device goes back to scanning while it waits in
    // NEED_AUTH for the prompt). The connection being activated still names the
    // network, so match on its SSID.
    const rc = dev.get_active_connection()?.get_connection() ?? null
    return rc && sameBytes(ssidBytesOf(rc), ap.ssid?.get_data() ?? null) ? "connecting" : "idle"
}

/** Where the Wi-Fi adapter stands, as the bar and the Control Centre show it. */
export type WifiLink =
    | { state: "absent" }                        // no adapter
    | { state: "off" }                           // radio switched off
    | { state: "disconnected" }
    | { state: "connecting"; ssid: string }
    | { state: "connected"; ssid: string; strength: number }

export function wifiLink(): WifiLink {
    const w = wifi()
    if (!w) return { state: "absent" }
    if (!w.enabled) return { state: "off" }
    const st = w.device.get_state()
    const ap = w.device.get_active_access_point()
    if (st === NM.DeviceState.ACTIVATED && ap) return { state: "connected", ssid: apSsid(ap), strength: ap.strength }
    if (st >= NM.DeviceState.PREPARE && st < NM.DeviceState.ACTIVATED) {
        const rc = w.device.get_active_connection()?.get_connection() ?? null
        const bytes = rc ? ssidBytesOf(rc) : null
        let ssid = ""
        try { ssid = bytes ? NM.utils_ssid_to_utf8(bytes) : "" } catch {}
        return { state: "connecting", ssid }
    }
    return { state: "disconnected" }
}

/**
 * Signal strength (0–100, as NM reports it) as the 0–3 arcs of an icon. Thresholds
 * are GNOME's, collapsed from its five steps to our four glyphs: under 30 is the
 * dot alone, 30–54 one arc, 55–79 two, 80 and up all three.
 */
export function signalLevel(strength: number): 0 | 1 | 2 | 3 {
    if (strength >= 80) return 3
    if (strength >= 55) return 2
    if (strength >= 30) return 1
    return 0
}

/**
 * The networks in range, one row per SSID — an access point per radio and band is an
 * implementation detail, not a choice for the user (a dual-band router is two APs
 * with one name). Keeps the strongest AP of each; the network the adapter is on or
 * joining comes first, then by strength. Hidden networks (empty SSID) are not listed.
 */
export function visibleNetworks(limit = 12): NM.AccessPoint[] {
    const dev = _wifiDevice
    if (!dev) return []
    const best = new Map<string, NM.AccessPoint>()
    for (const ap of dev.get_access_points() ?? []) {
        const ssid = apSsid(ap)
        if (!ssid) continue
        const prev = best.get(ssid)
        if (!prev || ap.strength > prev.strength) best.set(ssid, ap)
    }
    const rank = (ap: NM.AccessPoint) => apLinkState(ap) === "idle" ? 0 : 1
    return [...best.values()]
        .sort((a, b) => rank(b) - rank(a) || b.strength - a.strength)
        .slice(0, limit)
}

export function rescan(): Promise<string> {
    return execAsync(["nmcli", "device", "wifi", "rescan"]).catch(() => "")
}

/** Turn the WiFi radio on/off. The one true way — replaces direct `.enabled`
 *  assignment and ad-hoc `nmcli radio` / bash one-liners scattered across UI. */
export function setWifiEnabled(on: boolean): Promise<string> {
    return execAsync(["nmcli", "radio", "wifi", on ? "on" : "off"]).catch(() => "")
}

/** Flip the WiFi radio based on its current state. */
export function toggleWifi(): Promise<string> {
    return setWifiEnabled(!wifiEnabled())
}

// ── Saving a profile ────────────────────────────────────────────────────────
//
// Every edit below goes the same way: clone the saved profile, change the clone,
// `verify()` it, and hand it to NM with `update2(TO_DISK)`. The RemoteConnection
// itself is never touched, so a refused edit leaves nothing half-changed in the
// client's cache. A remote profile carries no secrets and NM keeps the stored ones
// when the update has none — measured 2026-09-28 on a WPA-PSK profile: the key read
// back identical after an IP/DNS edit.

const newestFirst = (a: NM.Connection, b: NM.Connection) =>
    Number(b.get_setting_connection()?.get_timestamp() ?? 0) - Number(a.get_setting_connection()?.get_timestamp() ?? 0)

function saveProfile(rc: NM.RemoteConnection, edit: (conn: NM.Connection) => void): Promise<NM.Connection> {
    return new Promise((resolve, reject) => {
        const clone = NM.SimpleConnection.new_clone(rc)
        try { edit(clone); clone.verify() } catch (e) { return reject(e) }
        rc.update2(clone.to_dbus(NM.ConnectionSerializationFlags.ALL), NM.SettingsUpdate2Flags.TO_DISK, null, null, (o: any, r: any) => {
            try { o.update2_finish(r); resolve(clone) } catch (e) { reject(e) }
        })
    })
}

/** Our own mark on a profile: NM's `user` setting, free-form key/values NM stores and ignores. */
function userMark(conn: NM.Connection, key: string): string | null {
    return (conn.get_setting_by_name("user") as NM.SettingUser | null)?.get_data(key) ?? null
}

function setUserMark(conn: NM.Connection, key: string, value: string | null): void {
    let u = conn.get_setting_by_name("user") as NM.SettingUser | null
    if (!u) {
        if (value === null) return
        u = new NM.SettingUser()
        conn.add_setting(u)
    }
    u.set_data(key, value)
    if (u.get_keys().length === 0) conn.remove_setting(NM.SettingUser.$gtype)
}

function activate(rc: NM.Connection | null, dev: NM.Device): Promise<void> {
    return new Promise((resolve, reject) => {
        const c = client()
        if (!c) return reject(new Error("NetworkManager is unavailable"))
        c.activate_connection_async(rc, dev, null, null, (o: any, r: any) => {
            try { o.activate_connection_finish(r); resolve() } catch (e) { reject(e) }
        })
    })
}

// ── Ethernet: the switch ────────────────────────────────────────────────────
//
// macOS's "Make Inactive", GNOME's Wired toggle (owner, 2026-09-28: a switch, as
// GNOME). GNOME's is `nm_device_disconnect` alone, and NM keeps that block in /run:
// a cable switched off came back on at the next boot. Ours holds, like the Wi-Fi
// radio: switching off also clears `autoconnect` on each profile that had it and
// MARKS the ones it cleared, so switching on restores exactly those — a profile the
// user had set not to connect by itself stays that way.

const WIRED_OFF_MARK = "org.nidara.wired-off"

/**
 * The saved profiles NM could bring up on the wired adapter, most recently used first.
 *
 * ⚠️ Asked profile by profile (`connection_compatible`), never through
 * `nm_device_filter_connections`: GJS marshals that call's GPtrArray wrongly — it
 * answers twice, then throws "Unhandled GType (null)" and leaves the client's own
 * profile objects finalized under JS (measured 2026-09-28: a reproduction of three
 * calls; in the VM it broke Settings → Network and the CC tile once the cable was off,
 * the only time this path runs). 200 rounds of the per-profile check, GC included,
 * stay clean.
 */
function wiredProfiles(): NM.RemoteConnection[] {
    const c = client()
    const dev = wired()?.device
    if (!c || !dev) return []
    return c.get_connections()
        .filter(rc => {
            if (rc.get_connection_type() !== "802-3-ethernet") return false
            try { return dev.connection_compatible(rc) } catch { return false }
        })
        .sort(newestFirst)
}

const autoconnects = (conn: NM.Connection) => conn.get_setting_connection()?.get_autoconnect() ?? true

/**
 * The switch. On while a connection is up or coming up; otherwise, on when NM would
 * bring one up by itself — the device is not blocked (`nmcli device disconnect` blocks
 * it too) and a profile autoconnects, or there is no profile yet and NM will make its
 * default one when a cable arrives.
 */
export function wiredEnabled(): boolean {
    const dev = wired()?.device
    if (!dev) return false
    if (dev.get_active_connection()) return true
    if (!dev.get_autoconnect()) return false
    const profiles = wiredProfiles()
    return profiles.length === 0 || profiles.some(autoconnects)
}

/** Where the cable stands, in the words every Ethernet surface uses. */
export type WiredState = "absent" | "off" | "unplugged" | "disconnected" | "connecting" | "connected"

export function wiredState(): WiredState {
    const dev = wired()?.device
    if (!dev) return "absent"
    const st = dev.get_state()
    if (st === NM.DeviceState.ACTIVATED) return "connected"
    if (st >= NM.DeviceState.PREPARE && st < NM.DeviceState.ACTIVATED) return "connecting"
    if (!wiredEnabled()) return "off"
    if (!dev.get_carrier()) return "unplugged"
    return "disconnected"
}

/** Told when a profile or the switch changed by OUR hand — a change NM's device
 *  signals do not always carry (switching on with no cable changes profiles only). */
const wiredConfigListeners = new Set<() => void>()
const tellWiredConfig = () => { for (const cb of [...wiredConfigListeners]) { try { cb() } catch (e) { console.error("[Network] wired listener failed:", e) } } }

export async function setWiredEnabled(on: boolean): Promise<void> {
    const c = client()
    const dev = wired()?.device
    if (!c || !dev) return
    const profiles = wiredProfiles()
    try {
        if (!on) {
            for (const rc of profiles.filter(autoconnects))
                await saveProfile(rc, conn => {
                    conn.get_setting_connection().autoconnect = false
                    setUserMark(conn, WIRED_OFF_MARK, "1")
                })
            if (dev.get_active_connection())
                await new Promise<void>((resolve, reject) => dev.disconnect_async(null, (o: any, r: any) => {
                    try { o.disconnect_finish(r); resolve() } catch (e) { reject(e) }
                }))
            return
        }
        // What the switch turned off comes back; failing that (switched off elsewhere,
        // or every profile set not to autoconnect), the one used last.
        const marked = profiles.filter(rc => userMark(rc, WIRED_OFF_MARK))
        const restore = marked.length > 0 ? marked : profiles.some(autoconnects) ? [] : profiles.slice(0, 1)
        for (const rc of restore)
            await saveProfile(rc, conn => {
                conn.get_setting_connection().autoconnect = true
                setUserMark(conn, WIRED_OFF_MARK, null)
            })
        // Unblock the device (`nmcli device disconnect` blocks it too), or a cable plugged
        // in later would not be brought up. With a callback: GJS does not promisify this
        // one — called without, it throws. And ⚠️ the D-Bus path is NMObject's: NMDevice
        // has a `get_path()` of its own, the udev ID_PATH ("pci-0000:2a:00.0"), which
        // shadows it — handed to D-Bus, GLib asserts and the callback never runs, so the
        // switch hung forever (measured 2026-09-28).
        if (!dev.get_autoconnect())
            await new Promise<void>((resolve, reject) => c.dbus_set_property(NM.Object.prototype.get_path.call(dev),
                "org.freedesktop.NetworkManager.Device", "Autoconnect", new GLib.Variant("b", true), -1, null,
                (o: any, r: any) => { try { o.dbus_set_property_finish(r); resolve() } catch (e) { reject(e) } }))
        // Without a cable there is nothing to bring up: NM will, when one arrives.
        if (dev.get_carrier() && !dev.get_active_connection())
            await activate(restore[0] ?? profiles.find(autoconnects) ?? null, dev)
    } finally {
        tellWiredConfig()
    }
}

/** The cable's state in words, the same in the bar panel, the CC and Settings. */
export function wiredStateText(state: WiredState = wiredState()): string {
    switch (state) {
        case "connected": {
            const speed = linkSpeed(wired()?.speed ?? 0)
            return speed ? `${t("cc.ethernet.sub.connected")} · ${speed}` : t("cc.ethernet.sub.connected")
        }
        case "connecting":   return t("cc.ethernet.sub.connecting")
        case "off":          return t("cc.ethernet.sub.off")
        case "unplugged":    return t("cc.ethernet.sub.no-cable")
        case "disconnected": return t("cc.ethernet.sub.disconnected")
        default:             return "—"
    }
}

/** Negotiated link speed, in the locale's numbers: "100 Mb/s", "2,5 Gb/s". "" when unknown. */
export function linkSpeed(mbps: number): string {
    if (!mbps || mbps <= 0) return ""
    const nf = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 })
    return mbps >= 1000 ? `${nf.format(mbps / 1000)} Gb/s` : `${nf.format(mbps)} Mb/s`
}

// ── IP and DNS of a profile (Ethernet, and every saved Wi-Fi network) ───────
//
// macOS's TCP/IP and DNS tabs, which Apple gives Ethernet and Wi-Fi alike (owner,
// 2026-09-28: complete, and our own form — not nm-connection-editor). What a surface
// edits is an `IpTarget`: the profile, and the device it is live on right now, if any.
// NM does the work; this is the vocabulary between it and the form.

const AF_INET = 2
const AF_INET6 = 10

export const isIPv4 = (s: string) => NM.utils_ipaddr_valid(AF_INET, s)
export const isIPv6 = (s: string) => NM.utils_ipaddr_valid(AF_INET6, s)

/** "255.255.255.0" for 24. */
export function maskOfPrefix(prefix: number): string {
    const bits = prefix <= 0 ? 0 : (0xffffffff << (32 - Math.min(prefix, 32))) >>> 0
    return [24, 16, 8, 0].map(s => (bits >>> s) & 0xff).join(".")
}

/** A subnet mask as a prefix length: "255.255.255.0" or "24" → 24. Null when it is not a
 *  mask at all (a non-contiguous one included, which no router accepts). */
export function prefixOfMask(s: string): number | null {
    const v = s.trim()
    if (/^\d{1,2}$/.test(v)) { const n = Number(v); return n >= 1 && n <= 32 ? n : null }
    if (!isIPv4(v)) return null
    const bits = v.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0)
    const ones = bits.toString(2).replace(/0+$/, "")
    return bits !== 0 && !ones.includes("0") ? ones.length : null
}

export interface IpFamilyForm { method: string; address: string; prefix: string; gateway: string }
/** What the form holds: v4's prefix as a mask ("255.255.255.0"), v6's as a length;
 *  DNS servers of both families and search domains as the text the user types. */
export interface IpForm { v4: IpFamilyForm; v6: IpFamilyForm; dns: string; search: string }
/** What the device is actually using right now — DHCP's answers in automatic mode. */
export interface IpLive {
    v4: { address: string; mask: string; gateway: string } | null
    v6: { address: string; prefix: string; gateway: string } | null
    dns: string[]
    search: string[]
}

export interface IpTarget {
    /** The profile the form edits. Null = nothing saved yet (a cable never plugged in): applying makes one. */
    profile(): NM.RemoteConnection | null
    /** The device this profile is up on right now, or null. */
    liveDevice(): NM.Device | null
    /** Fires when the profile, its device's addresses or its state change. */
    watch(cb: () => void): Dispose
    /** For a profile that does not exist yet: the adapter it is for. */
    readonly iface: () => string
}

export function wiredIpTarget(): IpTarget {
    const dev = () => wired()?.device ?? null
    return {
        profile: () => (dev()?.get_active_connection()?.get_connection() as NM.RemoteConnection | null) ?? wiredProfiles()[0] ?? null,
        liveDevice: () => { const d = dev(); return d && d.get_state() === NM.DeviceState.ACTIVATED ? d : null },
        watch: watchWired,
        iface: () => dev()?.get_iface() ?? "",
    }
}

/** The saved profile for `ap`'s network. Null for a network not joined yet — there is nothing to edit. */
export function wifiIpTarget(ap: NM.AccessPoint): IpTarget {
    const profile = () => savedProfilesFor(ap)[0] ?? null
    return {
        profile,
        liveDevice: () => {
            const d = _wifiDevice
            const rc = profile()
            if (!d || !rc || d.get_state() !== NM.DeviceState.ACTIVATED) return null
            return d.get_active_connection()?.get_uuid() === rc.get_uuid() ? d : null
        },
        watch: (cb) => {
            const offWifi = watchWifi(cb)
            const c = client()
            const ids = c ? [c.connect("connection-added", cb), c.connect("connection-removed", cb)] : []
            return () => { offWifi(); if (c) ids.forEach(id => safeDisconnect(c, id)) }
        },
        iface: () => _wifiDevice?.get_iface() ?? "",
    }
}

function familyForm(s: NM.SettingIPConfig | null, v6: boolean): IpFamilyForm {
    const method = s?.get_method() || "auto"
    const a = s && s.get_num_addresses() > 0 ? s.get_address(0) : null
    return {
        method,
        address: a?.get_address() ?? "",
        prefix: a ? (v6 ? String(a.get_prefix()) : maskOfPrefix(a.get_prefix())) : (v6 ? "64" : ""),
        gateway: s?.get_gateway() ?? "",
    }
}

function listOf(n: number, get: (i: number) => string): string[] {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(get(i))
    return out
}

/** The form's values as the profile has them saved. */
export function ipForm(target: IpTarget): IpForm {
    const rc = target.profile()
    const s4 = rc?.get_setting_ip4_config() ?? null
    const s6 = rc?.get_setting_ip6_config() ?? null
    const dns = [s4, s6].flatMap(s => s ? listOf(s.get_num_dns(), i => s.get_dns(i)) : [])
    const search = [s4, s6].flatMap(s => s ? listOf(s.get_num_dns_searches(), i => s.get_dns_search(i)) : [])
    return { v4: familyForm(s4, false), v6: familyForm(s6, true), dns: dns.join(", "), search: [...new Set(search)].join(", ") }
}

/** What the device is using right now. Every field empty while the profile is not up. */
export function ipLive(target: IpTarget): IpLive {
    const dev = target.liveDevice()
    const empty: IpLive = { v4: null, v6: null, dns: [], search: [] }
    if (!dev) return empty
    const c4 = dev.get_ip4_config()
    const c6 = dev.get_ip6_config()
    const a4 = c4?.get_addresses()?.[0] ?? null
    // A global address before the link-local one every interface has.
    const a6s = c6?.get_addresses() ?? []
    const a6 = a6s.find(a => !a.get_address().toLowerCase().startsWith("fe80")) ?? a6s[0] ?? null
    return {
        v4: a4 ? { address: a4.get_address(), mask: maskOfPrefix(a4.get_prefix()), gateway: c4?.get_gateway() ?? "" } : null,
        v6: a6 ? { address: a6.get_address(), prefix: String(a6.get_prefix()), gateway: c6?.get_gateway() ?? "" } : null,
        dns: [...(c4?.get_nameservers() ?? []), ...(c6?.get_nameservers() ?? [])],
        search: [...new Set([...(c4?.get_searches() ?? []), ...(c6?.get_searches() ?? [])])],
    }
}

/** The DNS servers and search domains the form holds, as NM wants them. */
export function splitList(text: string): string[] {
    return text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
}

function writeFamily(s: NM.SettingIPConfig, f: IpFamilyForm, v6: boolean): void {
    s.method = f.method
    // A manual profile keeps any further addresses it had (nmcli can add several; the
    // form shows the first). Any other method holds none of its own.
    const rest: NM.IPAddress[] = []
    if (f.method === "manual") for (let i = 1; i < s.get_num_addresses(); i++) rest.push(s.get_address(i))
    s.clear_addresses()
    if (f.method === "manual") {
        const prefix = v6 ? Number(f.prefix) : prefixOfMask(f.prefix) ?? 0
        s.add_address(NM.IPAddress.new(v6 ? AF_INET6 : AF_INET, f.address.trim(), prefix))
        rest.forEach(a => s.add_address(a))
        s.gateway = f.gateway.trim() || null
    } else {
        s.gateway = null
    }
}

/**
 * Save the form into the profile, and put it into force at once when the profile is up
 * (NM's Reapply: no drop when only addresses change; a re-activation when Reapply
 * refuses). With no profile yet — a wired adapter that never had a cable — one is made.
 */
export async function applyIp(target: IpTarget, form: IpForm): Promise<void> {
    const c = client()
    if (!c) throw new Error("NetworkManager is unavailable")
    const dns = splitList(form.dns)
    const search = splitList(form.search)
    const edit = (conn: NM.Connection) => {
        let s4 = conn.get_setting_ip4_config()
        if (!s4) { s4 = new NM.SettingIP4Config(); conn.add_setting(s4) }
        let s6 = conn.get_setting_ip6_config()
        if (!s6) { s6 = new NM.SettingIP6Config(); conn.add_setting(s6) }
        writeFamily(s4, form.v4, false)
        writeFamily(s6, form.v6, true)
        for (const [s, isFamily] of [[s4, isIPv4], [s6, isIPv6]] as const) {
            s.clear_dns()
            dns.filter(isFamily).forEach(d => s.add_dns(d))
            // Servers of your own REPLACE the network's, as on macOS — not add to them.
            s.ignore_auto_dns = dns.length > 0
            s.clear_dns_searches()
        }
        search.forEach(d => s4!.add_dns_search(d))
    }

    let rc = target.profile()
    let saved: NM.Connection
    try {
        if (rc) {
            saved = await saveProfile(rc, edit)
        } else {
            const conn = NM.SimpleConnection.new()
            const sc = new NM.SettingConnection()
            sc.id = "Ethernet"
            sc.uuid = NM.utils_uuid_generate()
            sc.type = "802-3-ethernet"
            sc.interface_name = target.iface() || null
            sc.autoconnect = true
            conn.add_setting(sc)
            conn.add_setting(new NM.SettingWired())
            edit(conn)
            conn.verify()
            rc = await new Promise<NM.RemoteConnection>((resolve, reject) =>
                c.add_connection_async(conn, true, null, (o: any, r: any) => {
                    try { resolve(o.add_connection_finish(r)) } catch (e) { reject(e) }
                }))
            saved = conn
        }
    } finally {
        tellWiredConfig()
    }

    const dev = target.liveDevice()
    if (!dev) return
    try {
        await new Promise<void>((resolve, reject) => dev.reapply_async(saved, 0, 0, null, (o: any, r: any) => {
            try { o.reapply_finish(r); resolve() } catch (e) { reject(e) }
        }))
    } catch (e) {
        console.warn("[Network] reapply refused, re-activating:", e)
        await activate(rc, dev)
    }
}

/** macOS's "Renew DHCP Lease". NM has no call for it: bringing the profile up again asks anew. */
export function renewDhcp(target: IpTarget): Promise<void> {
    const dev = target.liveDevice()
    const rc = target.profile()
    return dev && rc ? activate(rc, dev) : Promise.resolve()
}

// ── VPN ─────────────────────────────────────────────────────────────────────

export interface VpnProfile { name: string; type: string; active: boolean }

export async function listVpnProfiles(): Promise<VpnProfile[]> {
    try {
        const out = await execAsync(["nmcli", "-t", "-f", "NAME,TYPE,ACTIVE", "connection", "show"])
        return out.trim().split("\n")
            .map(line => {
                const parts = line.split(":")
                return { name: parts[0] ?? "", type: parts[1] ?? "", active: parts[2] === "yes" }
            })
            .filter(p => p.type === "vpn" || p.type === "wireguard")
    } catch {
        return []
    }
}

export function vpnTypeName(type: string): string {
    if (type === "wireguard") return "WireGuard"
    return "VPN"
}

export function vpnUp(name: string): Promise<string> {
    return execAsync(["nmcli", "connection", "up", name])
}

export function vpnDown(name: string): Promise<string> {
    return execAsync(["nmcli", "connection", "down", name])
}

// ── Reactivity helpers ──────────────────────────────────────────────────────
//
// All of these re-arm themselves across a hot-plug (see `rebindable`), so a
// caller subscribes once and stays correct even if the adapter it was watching
// is unplugged and a different one appears.
//
// They are deliberately GRANULAR. The old wrappers offered one blunt `notify`
// per object and the bar paid for it: `widgets/wifi.ts` documents a full bar
// re-blur on every strength/scan churn because the only subscription available
// was too wide. Reading NM directly means each caller can ask for exactly the
// signal it redraws on.

/**
 * The Wi-Fi radio flag, and nothing else. This is the bar-icon subscription —
 * the icon depends solely on the radio being on, and anything wider costs a
 * re-blur per frame while a scan is running.
 */
export function watchWifiEnabled(cb: () => void): Dispose {
    return rebindable(() => {
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        return b.dispose
    }, cb)
}

/**
 * The radio flag plus WHICH network we are on — no IP, no bitrate.
 *
 * The subscription for a tile that shows an icon and an SSID. Kept separate from
 * `watchWifi` on purpose: `bitrate` and `ip4-config` churn hard while a scan or a
 * transfer is running, and a Control Center capsule redraws for nothing on both.
 */
/**
 * Everything `wifiLink()` reads: the radio flag, the device state, which AP it is
 * on, and THAT AP's strength — re-armed whenever the active AP changes. The bar
 * icon's subscription. Strength churns with every scan, so a consumer must compare
 * what it derives (a signal LEVEL, not the raw number) before touching a widget.
 */
export function watchWifiLink(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wifi()
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        if (!w) return b.dispose
        let ap: NM.AccessPoint | null = null
        let apId = 0
        const rearm = () => {
            if (ap && apId) safeDisconnect(ap, apId)
            ap = w.device.get_active_access_point() ?? null
            apId = ap ? ap.connect("notify::strength", cb) : 0
        }
        rearm()
        b.on(w.device, "notify::state", cb)
        b.on(w.device, "notify::active-access-point", () => { rearm(); cb() })
        b.add(() => { if (ap && apId) safeDisconnect(ap, apId) })
        return b.dispose
    }, cb)
}

export function watchWifiNetwork(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wifi()
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        if (w) b.on(w.device, "notify::active-access-point", cb)
        return b.dispose
    }, cb)
}

/**
 * Everything the Wi-Fi info surfaces read: SSID, IP, link speed, device state.
 *
 * The IP and the speed live on the NM device, not on any wifi object, and the
 * active AP changes before DHCP has assigned an address — so `ip4-config` and
 * `bitrate` are what actually carry them, exactly as the Astal-backed version
 * had to do. `active-connection` is watched on the device AND on the connection
 * itself, because ACTIVATING → ACTIVATED is a property change on the connection.
 */
export function watchWifi(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wifi()
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        if (!w) return b.dispose

        b.on(w.device, "notify::active-access-point", cb)
        b.on(w.device, "notify::ip4-config", cb)
        b.on(w.device, "notify::bitrate", cb)
        b.on(w.device, "notify::state", cb)
        b.add(onActiveConnection(w.device, cb))
        return b.dispose
    }, cb)
}

/** The access-point list, the active AP, the radio flag, how far the adapter has
 *  got with it (device state) and which networks are saved — everything an AP row
 *  shows, so a row can be rebuilt from NM instead of remembering anything. */
export function watchAccessPoints(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wifi()
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        b.on(client(), "connection-added", cb)
        b.on(client(), "connection-removed", cb)
        if (!w) return b.dispose

        b.on(w.device, "notify::state", cb)

        b.on(w.device, "access-point-added", cb)
        b.on(w.device, "access-point-removed", cb)
        b.on(w.device, "notify::active-access-point", cb)
        return b.dispose
    }, cb)
}

/** Everything the Ethernet surfaces read: link state, the switch, the cable, IP, speed —
 *  and the saved profiles, whose `autoconnect` IS the switch while nothing is up. */
export function watchWired(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wired()
        const b = bag()
        wiredConfigListeners.add(cb)
        b.add(() => { wiredConfigListeners.delete(cb) })
        b.on(client(), "connection-added", cb)
        b.on(client(), "connection-removed", cb)
        if (!w) return b.dispose

        b.on(w.device, "notify::state", cb)
        b.on(w.device, "notify::ip4-config", cb)
        b.on(w.device, "notify::ip6-config", cb)
        b.on(w.device, "notify::speed", cb)
        b.on(w.device, "notify::carrier", cb)
        b.on(w.device, "notify::autoconnect", cb)
        b.add(onActiveConnection(w.device, cb))
        return b.dispose
    }, cb)
}

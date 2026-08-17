// NetworkService — the single source of network domain logic, and the ONLY place
// in the shell that talks to NetworkManager.
//
// It used to be a stateless facade over AstalNetwork. It is not any more: the
// read half now sits directly on `libnm` (`gi://NM`), the same C library Astal's
// Vala wrapper was wrapping. The write half never went through Astal at all —
// every mutation here has always been an `nmcli` call.
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
// Everything below is READ-ONLY against NM except the nmcli commands. Widgets
// must not import `gi://NM` — they ask this module, like they already did.

import { execAsync } from "ags/process"
import NM from "gi://NM?version=1.0"
import { t } from "./i18n"
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

export function freqBand(freq: number): string {
    if (freq >= 5925) return "6 GHz"
    if (freq >= 4900) return "5 GHz"
    return "2.4 GHz"
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

// ── Wi-Fi commands (nmcli) ──────────────────────────────────────────────────

export function connectAp(ssid: string, password?: string): Promise<string> {
    const args = ["nmcli", "device", "wifi", "connect", ssid]
    if (password) args.push("password", password)
    return execAsync(args)
}

export function disconnectIface(iface: string): Promise<string> {
    return execAsync(["nmcli", "device", "disconnect", iface])
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

// ── Saved connection profiles ───────────────────────────────────────────────

/** Saved Wi-Fi connection profiles, by name. Filtering on the wifi type avoids
 *  matching a VPN/wired profile that happens to share an SSID's name. */
export async function listSavedWifiSsids(): Promise<Set<string>> {
    const set = new Set<string>()
    try {
        const out = await execAsync(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"])
        for (const line of out.trim().split("\n")) {
            if (!line) continue
            const parts = line.split(":")
            const type = parts.pop() ?? ""           // TYPE is the last field, never contains ":"
            const name = parts.join(":").replace(/\\:/g, ":")
            if (type === "802-11-wireless") set.add(name)
        }
    } catch {}
    return set
}

export function forgetProfile(name: string): Promise<string> {
    return execAsync(["nmcli", "connection", "delete", name])
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

/** The access-point list, the active AP, and the radio flag — the Settings list. */
export function watchAccessPoints(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wifi()
        const b = bag()
        b.on(client(), "notify::wireless-enabled", cb)
        if (!w) return b.dispose

        b.on(w.device, "access-point-added", cb)
        b.on(w.device, "access-point-removed", cb)
        b.on(w.device, "notify::active-access-point", cb)
        return b.dispose
    }, cb)
}

/** Everything the Ethernet surfaces read: link state, IP, negotiated speed. */
export function watchWired(cb: () => void): Dispose {
    return rebindable(() => {
        const w = wired()
        const b = bag()
        if (!w) return b.dispose

        b.on(w.device, "notify::state", cb)
        b.on(w.device, "notify::ip4-config", cb)
        b.on(w.device, "notify::speed", cb)
        b.add(onActiveConnection(w.device, cb))
        return b.dispose
    }, cb)
}

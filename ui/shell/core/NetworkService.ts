// NetworkService — the single source of network domain logic.
//
// AstalNetwork is already a reactive GObject singleton, so this is intentionally
// a *stateless facade* (a plain function module, not its own GObject): it owns
// the nmcli command vocabulary, the NM-flag/frequency derivations, and a thin
// notify-subscription helper. Everything network-related — the Settings page, the
// CC wifi/ethernet tiles, the bar widgets — consumes these instead of re-deriving
// `getIp`, the WiFi-enable command, or the `Internet.CONNECTED` check (which used
// to exist in 3–4 slightly-different copies). UI stays in the widgets; this never
// imports Gtk or builds anything.

import { execAsync } from "ags/process"
import AstalNetwork from "gi://AstalNetwork"
import { t } from "./i18n"
import { safeDisconnect } from "./signals"

/** The AstalNetwork singleton, or null if the service isn't available. */
export function net(): AstalNetwork.Network | null {
    return AstalNetwork.get_default()
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

/** Best-effort IPv4 address for a wired/wifi service object. */
export function getIp(service: any, fallback = "—"): string {
    if (!service) return fallback
    if (service.ip4_address && service.ip4_address !== "None") return String(service.ip4_address)
    try {
        const addrs = service.device?.get_ip4_config()?.get_addresses()
        if (addrs?.length > 0) return String(addrs[0].get_address())
    } catch {}
    return fallback
}

/** True when the wired service reports an established internet connection. */
export function wiredConnected(wired: any = net()?.wired): boolean {
    return !!(wired && wired.internet === AstalNetwork.Internet.CONNECTED)
}

/** True unless WiFi hardware is explicitly disabled (radio off). */
export function wifiEnabled(wifi: any = net()?.wifi): boolean {
    return (wifi as any)?.enabled !== false
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
// Wrap the repetitive notify-subscription boilerplate. WiFi's address/speed live
// on the NM *device* (not the AstalNetwork.Wifi wrapper), and `notify::ssid` fires
// before DHCP assigns an address — so live updates must also watch the device's
// ip4-config / bitrate / state. Returns a disposer; callers wire it to `unrealize`.

type Dispose = () => void

export function watchWifi(cb: () => void): Dispose {
    const wifi = net()?.wifi as any
    if (!wifi) return () => {}
    const ids: Array<[any, number]> = []
    const on = (obj: any, sig: string) => { if (obj?.connect) ids.push([obj, obj.connect(sig, cb)]) }

    on(wifi, "notify::enabled")
    on(wifi, "notify::ssid")
    on(wifi, "notify::active-access-point")
    on(wifi, "notify::internet")
    on(wifi, "notify::access-points")
    const dev = wifi.device
    on(dev, "notify::ip4-config")
    on(dev, "notify::bitrate")
    on(dev, "notify::state")

    return () => ids.forEach(([obj, id]) => safeDisconnect(obj, id))
}

export function watchWired(cb: () => void): Dispose {
    const wired = net()?.wired as any
    if (!wired) return () => {}
    const ids: Array<[any, number]> = []
    const on = (obj: any, sig: string) => { if (obj?.connect) ids.push([obj, obj.connect(sig, cb)]) }

    on(wired, "notify::internet")
    on(wired, "notify::ip4-address")
    on(wired.device, "notify::speed")

    return () => ids.forEach(([obj, id]) => safeDisconnect(obj, id))
}

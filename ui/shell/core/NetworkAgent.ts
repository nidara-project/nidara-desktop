// NetworkAgent — the desktop's NetworkManager SECRET AGENT: the process NM asks
// when a connection needs a password it does not have.
//
// Without one, every question NM had went unanswered ("No agents were available
// for this request" in its journal) and the shell had to work around it by putting
// the password on `nmcli`'s command line. That workaround is what broke, measured
// in a VM on 2026-09-14:
//   - a wrong password failed with no prompt and no message, because the retry is
//     NM asking the agent again (flag REQUEST_NEW) and nobody was listening;
//   - a network whose router password changed stayed unreachable forever, same
//     reason, and a click that retried without a password left behind a saved
//     profile with no key in it;
//   - the password sat in argv for the length of the activation, readable by any
//     local user through `ps`.
// With an agent, the shell activates a connection WITHOUT secrets and NM comes
// back here for them, over the system bus, as many times as it needs to.
//
// WHY raw D-Bus and not `NM.SecretAgentOld`: that class is abstract, and GJS
// refuses to implement its vfuncs — "VFunc get_secrets accepts another callback
// as a parameter. This is not supported" (tried 2026-09-14). gnome-shell carries a
// C subclass for the same reason. The D-Bus interface underneath is four methods,
// so this file speaks it directly, as BluetoothService does for org.bluez.Agent1.
//
// core/ never touches the UI: this file is D-Bus only, and the prompt is supplied
// by `startNetworkAgent(handler)` from app.ts.
//
// Scope: Wi-Fi personal networks — WPA/WPA2 PSK and WPA3 SAE, the `psk` key. Any
// other request (802.1X, WEP, VPN plugins) is answered NoSecrets, which is exactly
// what NM got before this file existed.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import NM from "gi://NM?version=1.0"

const NM_NAME = "org.freedesktop.NetworkManager"
const AGENT_PATH = "/org/freedesktop/NetworkManager/SecretAgent"   // fixed by NM, not ours to pick
const AGENT_ID = "org.nidara.Shell.NetworkAgent"
const ERR = "org.freedesktop.NetworkManager.SecretAgent"

// NMSecretAgentGetSecretsFlags
const FLAG_ALLOW_INTERACTION = 0x1
const FLAG_REQUEST_NEW = 0x2

const AGENT_IFACE = `<node>
  <interface name="org.freedesktop.NetworkManager.SecretAgent">
    <method name="GetSecrets">
      <arg name="connection" type="a{sa{sv}}" direction="in"/>
      <arg name="connection_path" type="o" direction="in"/>
      <arg name="setting_name" type="s" direction="in"/>
      <arg name="hints" type="as" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="secrets" type="a{sa{sv}}" direction="out"/>
    </method>
    <method name="CancelGetSecrets">
      <arg name="connection_path" type="o" direction="in"/>
      <arg name="setting_name" type="s" direction="in"/>
    </method>
    <method name="SaveSecrets">
      <arg name="connection" type="a{sa{sv}}" direction="in"/>
      <arg name="connection_path" type="o" direction="in"/>
    </method>
    <method name="DeleteSecrets">
      <arg name="connection" type="a{sa{sv}}" direction="in"/>
      <arg name="connection_path" type="o" direction="in"/>
    </method>
  </interface>
</node>`

/** One password question the UI must render. */
export interface WifiSecretsRequest {
    ssid: string
    /** NM already tried a key for this network and it was refused. */
    retry: boolean
    /** WPA3-SAE has no length rule; WPA/WPA2-PSK needs 8–63 characters (or 64 hex). */
    keyMgmt: "wpa-psk" | "sae"
}

export interface WifiSecretsHandler {
    /** Resolve the key, or null when the user cancelled. */
    prompt(req: WifiSecretsRequest): Promise<string | null>
    /** NM withdrew the request (timeout, the activation was cancelled) — close the prompt. */
    cancel(): void
}

/** A valid WPA/WPA2 personal key: 8–63 characters, or exactly 64 hex digits. */
export function validPsk(key: string, keyMgmt: WifiSecretsRequest["keyMgmt"]): boolean {
    if (keyMgmt === "sae") return key.length > 0
    return (key.length >= 8 && key.length <= 63) || /^[0-9a-fA-F]{64}$/.test(key)
}

/** SSIDs whose prompt the user dismissed, with when. NM does not carry that fact to
 *  the activation: a cancelled prompt ends it with reason DEVICE_DISCONNECTED, not
 *  NO_SECRETS (measured), so the only place that knows is here. */
const userCancels = new Map<string, number>()

/** Did the user dismiss the password prompt for `ssid` in the last half-minute?
 *  Consumes the record, so one cancel explains one failed attempt. */
export function takeUserCancel(ssid: string): boolean {
    const at = userCancels.get(ssid)
    userCancels.delete(ssid)
    return at !== undefined && Date.now() - at < 30_000
}

let handler: WifiSecretsHandler | null = null
let exported: any = null
let nmOwner: string | null = null
/** The request on screen, by connection path + setting, so CancelGetSecrets closes the right one. */
let pending: { key: string; inv: any } | null = null

function unpackSetting(conn: Record<string, Record<string, GLib.Variant>>, name: string): Record<string, any> {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(conn[name] ?? {})) {
        try { out[k] = (v as any).deepUnpack() } catch { out[k] = v }
    }
    return out
}

function fromNetworkManager(sender: string | null): boolean {
    // Compared by UNIQUE name: the agent path is well known, so any process on the
    // system bus can call GetSecrets — and a prompt that reads "Password for
    // <your network>" and hands the answer to whoever asked is a phishing kit.
    return !!sender && !!nmOwner && sender === nmOwner
}

function getSecrets(
    [conn, path, settingName, _hints, flags]: [Record<string, Record<string, GLib.Variant>>, string, string, string[], number],
    inv: any,
): void {
    if (!fromNetworkManager(inv.get_sender())) {
        inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "only NetworkManager may ask for secrets")
        return
    }
    const noSecrets = (why: string) => inv.return_dbus_error(`${ERR}.NoSecrets`, why)

    const sec = unpackSetting(conn, "802-11-wireless-security")
    const keyMgmt = sec["key-mgmt"]
    if (settingName !== "802-11-wireless-security" || (keyMgmt !== "wpa-psk" && keyMgmt !== "sae"))
        return noSecrets("not a personal Wi-Fi network")
    // Without ALLOW_INTERACTION NM is only asking whether we HOLD a secret. We
    // hold none: NM keeps them itself (system-owned, as nmcli always stored them).
    if (!(flags & FLAG_ALLOW_INTERACTION)) return noSecrets("no stored secrets")
    if (!handler) return noSecrets("no prompt available")

    const wifi = unpackSetting(conn, "802-11-wireless")
    let ssid = ""
    try { ssid = NM.utils_ssid_to_utf8(wifi.ssid) } catch {}
    if (!ssid) ssid = unpackSetting(conn, "connection").id ?? ""

    // One question at a time. A second request while one is on screen is NM retrying
    // or a different network racing; answering it UserCanceled lets NM fail that
    // activation cleanly instead of stacking dialogs.
    if (pending) return inv.return_dbus_error(`${ERR}.UserCanceled`, "another prompt is open")

    const key = `${path}:${settingName}`
    pending = { key, inv }
    handler.prompt({ ssid, retry: (flags & FLAG_REQUEST_NEW) !== 0, keyMgmt }).then(
        psk => {
            if (pending?.inv !== inv) return   // withdrawn meanwhile
            pending = null
            // try: NM may have timed the call out while the user was typing.
            try {
                if (psk === null) {
                    userCancels.set(ssid, Date.now())
                    inv.return_dbus_error(`${ERR}.UserCanceled`, "cancelled by the user")
                }
                else inv.return_value(new GLib.Variant("(a{sa{sv}})", [{ [settingName]: { psk: new GLib.Variant("s", psk) } }]))
            } catch (e) { console.error("[NetworkAgent] reply:", e) }
        },
        e => {
            if (pending?.inv === inv) pending = null
            try { inv.return_dbus_error(`${ERR}.UserCanceled`, String(e)) } catch {}
        },
    )
}

function register(bus: Gio.DBusConnection): void {
    bus.call(NM_NAME, "/org/freedesktop/NetworkManager/AgentManager", "org.freedesktop.NetworkManager.AgentManager",
        "RegisterWithCapabilities", new GLib.Variant("(su)", [AGENT_ID, 0]), null, Gio.DBusCallFlags.NONE, -1, null,
        (c: any, res: any) => {
            try { c.call_finish(res) } catch (e) { console.error("[NetworkAgent] register:", e) }
        })
}

/**
 * Put the agent on the system bus for the session and hand prompts to `h`.
 * Re-registers whenever NetworkManager (re)starts — NM forgets its agents with it.
 * Idempotent; fail-soft (a machine without NM just has no agent).
 */
export function startNetworkAgent(h: WifiSecretsHandler): void {
    handler = h
    if (exported) return
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
        exported = (Gio as any).DBusExportedObject.wrapJSObject(AGENT_IFACE, {
            GetSecretsAsync: getSecrets,
            CancelGetSecretsAsync([path, settingName]: [string, string], inv: any) {
                if (!fromNetworkManager(inv.get_sender())) {
                    inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "only NetworkManager may cancel")
                    return
                }
                if (pending?.key === `${path}:${settingName}`) {
                    // NM's rule: a cancelled GetSecrets is still answered, with UserCanceled.
                    try { pending.inv.return_dbus_error(`${ERR}.UserCanceled`, "withdrawn") } catch {}
                    pending = null
                    try { handler?.cancel() } catch {}
                }
                inv.return_value(null)
            },
            // Secrets live in NM (system-owned); an agent that stores nothing has nothing to save or delete.
            SaveSecretsAsync(_p: any[], inv: any) { inv.return_value(null) },
            DeleteSecretsAsync(_p: any[], inv: any) { inv.return_value(null) },
        })
        exported.export(bus, AGENT_PATH)
        Gio.bus_watch_name_on_connection(bus, NM_NAME, Gio.BusNameWatcherFlags.NONE,
            (_c: any, _name: string, owner: string) => { nmOwner = owner; register(bus) },
            () => {
                nmOwner = null
                if (pending) { pending = null; try { handler?.cancel() } catch {} }
            })
    } catch (e) {
        console.error("[NetworkAgent] could not start:", e)
        try { exported?.unexport() } catch {}
        exported = null
    }
}

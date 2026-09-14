// NetworkAgent — the desktop's NetworkManager SECRET AGENT: the process NM asks
// when a connection needs a secret it does not have, and the keeper of the secrets
// a user chose to store "for this user only".
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
// The KEYRING half is gnome-shell's and nm-applet's, on purpose: the same libsecret
// schema and attribute names, so a secret stored by either of them (a machine that
// ran GNOME before) is found here, and one stored here is found by them. Only
// AGENT_OWNED secrets are ours to keep — system-owned ones NM stores itself, and
// "ask every time" ones are never stored anywhere.
//
// core/ never touches the UI: this file is D-Bus + libsecret only. The dialog (libnma's,
// see common/WifiSecretsDialog.ts) is handed in by `startNetworkAgent`.
//
// Scope: Wi-Fi connections — the `802-11-wireless-security` and `802-1x` settings.
// Anything else (VPN plugins, which bring their own auth dialogs; mobile broadband)
// is answered NoSecrets, which is what NM got before this file existed.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import NM from "gi://NM?version=1.0"
import Secret from "gi://Secret"

const NM_NAME = "org.freedesktop.NetworkManager"
const AGENT_PATH = "/org/freedesktop/NetworkManager/SecretAgent"   // fixed by NM, not ours to pick
const AGENT_ID = "org.nidara.Shell.NetworkAgent"
const ERR = "org.freedesktop.NetworkManager.SecretAgent"

// NMSecretAgentGetSecretsFlags
const FLAG_ALLOW_INTERACTION = 0x1
const FLAG_REQUEST_NEW = 0x2

const WIFI_SETTINGS = new Set(["802-11-wireless-security", "802-1x"])

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

// gnome-shell's `network_agent_schema` / nm-applet's, attribute for attribute.
const SCHEMA = Secret.Schema.new(
    "org.freedesktop.NetworkManager.Connection",
    Secret.SchemaFlags.DONT_MATCH_NAME,
    {
        "connection-uuid": Secret.SchemaAttributeType.STRING,
        "setting-name": Secret.SchemaAttributeType.STRING,
        "setting-key": Secret.SchemaAttributeType.STRING,
    },
)

/** One secrets question the UI must render. */
export interface WifiSecretsRequest {
    /** The connection as NM sent it, secrets stripped — what libnma's dialog edits. */
    connection: NM.Connection
    settingName: string
    /** NM already tried a secret for this connection and it was refused. */
    retry: boolean
}

export interface WifiSecretsHandler {
    /** Resolve the connection's secrets (`a{sa{sv}}`), or null when the user cancelled. */
    prompt(req: WifiSecretsRequest): Promise<GLib.Variant | null>
    /** NM withdrew the request (timeout, the activation was cancelled) — close the dialog. */
    cancel(): void
}

/** Connection UUIDs whose dialog the user dismissed, with when. NM does not carry that
 *  fact to the activation: a cancelled prompt ends it with reason DEVICE_DISCONNECTED,
 *  not NO_SECRETS (measured), so the only place that knows is here. */
const userCancels = new Map<string, number>()

/** Did the user dismiss the secrets dialog for the connection `uuid` in the last
 *  half-minute? Consumes the record, so one cancel explains one failed attempt. */
export function takeUserCancel(uuid: string): boolean {
    const at = userCancels.get(uuid)
    userCancels.delete(uuid)
    return at !== undefined && Date.now() - at < 30_000
}

let handler: WifiSecretsHandler | null = null
let exported: any = null
let nmOwner: string | null = null
/** The request on screen, by connection path + setting, so CancelGetSecrets closes the right one. */
let pending: { key: string; inv: any } | null = null

function fromNetworkManager(sender: string | null): boolean {
    // Compared by UNIQUE name: the agent path is well known, so any process on the
    // system bus can call GetSecrets — and a dialog titled after your network that
    // hands what you type to whoever asked is a phishing kit.
    return !!sender && !!nmOwner && sender === nmOwner
}

/** The `a{sa{sv}}` argument as NM sent it — rebuilt from the raw invocation, because
 *  wrapJSObject has already unpacked the one it passes in. */
function connectionArg(inv: any): NM.Connection | null {
    try {
        return NM.SimpleConnection.new_from_dbus(inv.get_parameters().get_child_value(0))
    } catch (e) {
        console.error("[NetworkAgent] unreadable connection:", e)
        return null
    }
}

/** Secrets for (uuid, setting) already in the keyring, as `{ key: value }`. */
function keyringLookup(uuid: string, settingName: string): Promise<Record<string, string>> {
    return new Promise(resolve => {
        Secret.password_search(SCHEMA, { "connection-uuid": uuid, "setting-name": settingName },
            Secret.SearchFlags.ALL | Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS, null,
            (_s: any, res: any) => {
                const found: Record<string, string> = {}
                try {
                    for (const item of Secret.password_search_finish(res)) {
                        const key = item.get_attributes()?.["setting-key"]
                        const text = item.retrieve_secret_sync(null)?.get_text()
                        if (key && text) found[key] = text
                    }
                } catch (e) { console.error("[NetworkAgent] keyring lookup:", e) }
                resolve(found)
            })
    })
}

function getSecrets(params: any[], inv: any): void {
    const [, path, settingName, , flags] = params as [unknown, string, string, string[], number]
    if (!fromNetworkManager(inv.get_sender())) {
        inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "only NetworkManager may ask for secrets")
        return
    }
    const noSecrets = (why: string) => inv.return_dbus_error(`${ERR}.NoSecrets`, why)

    const conn = connectionArg(inv)
    if (!conn || conn.get_connection_type() !== "802-11-wireless" || !WIFI_SETTINGS.has(settingName))
        return noSecrets("not a Wi-Fi secret")
    const uuid = conn.get_uuid() ?? ""
    const retry = (flags & FLAG_REQUEST_NEW) !== 0

    const ask = () => {
        if (!(flags & FLAG_ALLOW_INTERACTION)) return noSecrets("interaction not allowed")
        if (!handler) return noSecrets("no dialog available")
        // One question at a time: a second request while one is on screen is answered
        // UserCanceled, so NM fails that activation cleanly instead of stacking dialogs.
        if (pending) return inv.return_dbus_error(`${ERR}.UserCanceled`, "another dialog is open")

        const key = `${path}:${settingName}`
        pending = { key, inv }
        handler.prompt({ connection: conn, settingName, retry }).then(
            secrets => {
                if (pending?.inv !== inv) return   // withdrawn meanwhile
                pending = null
                // try: NM may have timed the call out while the user was typing.
                try {
                    if (secrets === null) {
                        userCancels.set(uuid, Date.now())
                        inv.return_dbus_error(`${ERR}.UserCanceled`, "cancelled by the user")
                    } else {
                        inv.return_value(GLib.Variant.new_tuple([secrets]))
                        // What the user just typed is not saved by NM for us: an agent
                        // that asked keeps the agent-owned part itself (gnome-shell's
                        // shell_network_agent_respond does the same). The flags come from
                        // the request, the values from the dialog.
                        const merged = rawConnection(inv)
                        let typed: Record<string, Record<string, any>> = {}
                        try { typed = secrets.recursiveUnpack() as any } catch {}
                        for (const [name, keys] of Object.entries(typed)) merged[name] = { ...(merged[name] ?? {}), ...keys }
                        storeAgentOwned(uuid, conn.get_id() ?? "", merged)
                    }
                } catch (e) { console.error("[NetworkAgent] reply:", e) }
            },
            e => {
                if (pending?.inv === inv) pending = null
                try { inv.return_dbus_error(`${ERR}.UserCanceled`, String(e)) } catch {}
            },
        )
    }

    // A retry means what we (or NM) had was refused: never answer it from the keyring.
    if (retry) return ask()
    keyringLookup(uuid, settingName).then(found => {
        if (Object.keys(found).length === 0) return ask()
        const dict: Record<string, GLib.Variant> = {}
        for (const [k, v] of Object.entries(found)) dict[k] = new GLib.Variant("s", v)
        try { inv.return_value(new GLib.Variant("(a{sa{sv}})", [{ [settingName]: dict }])) } catch {}
    })
}

/**
 * Keep the AGENT_OWNED secrets of a connection in the keyring. `values` is the
 * connection as a plain `{ setting: { key: value } }` dict. Every secret key travels
 * with a `<key>-flags` companion (psk-flags, password-flags,
 * private-key-password-flags…), and only AGENT_OWNED ones are ours to keep.
 * (`NM.Setting.get_secret_flags` would say the same, but its out-parameter is not
 * annotated, so GJS cannot read it.)
 */
function storeAgentOwned(uuid: string, id: string, values: Record<string, Record<string, any>>): void {
    for (const [name, keys] of Object.entries(values)) {
        for (const [flagKey, flags] of Object.entries(keys ?? {})) {
            if (!flagKey.endsWith("-flags") || typeof flags !== "number") continue
            if (!(flags & NM.SettingSecretFlags.AGENT_OWNED)) continue
            const key = flagKey.slice(0, -"-flags".length)
            const value = keys[key]
            if (typeof value !== "string" || !value) continue
            Secret.password_store(SCHEMA, { "connection-uuid": uuid, "setting-name": name, "setting-key": key },
                Secret.COLLECTION_DEFAULT, `Network secret for ${id}/${name}/${key}`, value, null,
                (_s: any, res: any) => { try { Secret.password_store_finish(res) } catch (e) { console.error("[NetworkAgent] keyring store:", e) } })
        }
    }
}

function rawConnection(inv: any): Record<string, Record<string, any>> {
    try { return inv.get_parameters().get_child_value(0).recursiveUnpack() } catch { return {} }
}

function saveSecrets(_params: any[], inv: any): void {
    if (!fromNetworkManager(inv.get_sender())) {
        inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "only NetworkManager may save secrets")
        return
    }
    const conn = connectionArg(inv)
    if (conn) storeAgentOwned(conn.get_uuid() ?? "", conn.get_id() ?? "", rawConnection(inv))
    inv.return_value(null)
}

function deleteSecrets(_params: any[], inv: any): void {
    if (!fromNetworkManager(inv.get_sender())) {
        inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "only NetworkManager may delete secrets")
        return
    }
    const uuid = connectionArg(inv)?.get_uuid()
    if (uuid) {
        Secret.password_clear(SCHEMA, { "connection-uuid": uuid }, null,
            (_s: any, res: any) => { try { Secret.password_clear_finish(res) } catch {} })
    }
    inv.return_value(null)
}

function register(bus: Gio.DBusConnection): void {
    // Capabilities 0: no VPN hints support — VPN plugins keep their own auth dialogs.
    bus.call(NM_NAME, "/org/freedesktop/NetworkManager/AgentManager", "org.freedesktop.NetworkManager.AgentManager",
        "RegisterWithCapabilities", new GLib.Variant("(su)", [AGENT_ID, 0]), null, Gio.DBusCallFlags.NONE, -1, null,
        (c: any, res: any) => {
            try { c.call_finish(res) } catch (e) { console.error("[NetworkAgent] register:", e) }
        })
}

/**
 * Put the agent on the system bus for the session and hand dialogs to `h`.
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
            SaveSecretsAsync: saveSecrets,
            DeleteSecretsAsync: deleteSecrets,
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

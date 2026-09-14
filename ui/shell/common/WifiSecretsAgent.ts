import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import NM from "gi://NM?version=1.0"
import NMA from "gi://NMA4?version=1.0"
import * as Net from "../core/NetworkService"
import status from "../core/Status"
import { startNetworkAgent, type WifiSecretsRequest } from "../core/NetworkAgent"
import { runWifiDialog } from "./WifiSecretsDialog"

// The shell's half of the Wi-Fi dialogs: answering NetworkManager's secret requests for
// the whole session. Split out of WifiSecretsDialog.ts so that the half that JOINS a
// network (Settings, the CC's Wi-Fi detail) no longer drags the secret agent and Status
// into every process that imports it (#571). Started once, from app.ts — and only the
// shell may: NetworkManager takes one agent per identifier.

/** An empty `const char * const *` in the shape GJS will marshal — see WifiSecretsDialog.ts. */
const NO_HINTS = "\0\0\0\0\0\0\0\0"

/** The dialog answering the AGENT, so NM withdrawing a request closes that one and
 *  never a form the user opened from Settings. */
let agentDialog: NMA.WifiDialog | null = null

function prompt(req: WifiSecretsRequest): Promise<GLib.Variant | null> {
    const nm = Net.nmObjects()
    if (!nm) return Promise.resolve(null)
    const ap = Net.apForConnection(req.connection)
    let dialog: NMA.WifiDialog
    try {
        dialog = ap
            ? (NMA.WifiDialog as any).new(nm.client, req.connection, nm.device, ap, true)
            : NMA.WifiDialog.new_for_secrets(nm.client, req.connection, req.settingName, NO_HINTS)
    } catch (e) {
        console.error("[WifiSecrets] could not build the dialog:", e)
        return Promise.resolve(null)
    }
    agentDialog = dialog
    // Whatever overlay is open holds the keyboard grab (see Status.closeOverlays).
    return runWifiDialog(dialog, () => status.closeOverlays()).then(result => {
        if (agentDialog === dialog) agentDialog = null
        if (!result) return null
        // Only the secrets travel back to NM, and over D-Bus — never argv.
        return result[0].to_dbus(NM.ConnectionSerializationFlags.ONLY_SECRETS)
    })
}

/** Serve NetworkManager's secret requests for the whole session. Called once from app.ts. */
export function startWifiSecretsDialogs(): void {
    startNetworkAgent({
        prompt,
        // Through `response`, so the pending run resolves and the dialog is destroyed once.
        cancel: () => { (agentDialog as any)?.response(Gtk.ResponseType.CANCEL) },
    })
}

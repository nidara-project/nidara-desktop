import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import NM from "gi://NM?version=1.0"
import NMA from "gi://NMA4?version=1.0"
import { setWindowAppId } from "../../lib/nidara-kit/platform/app-id"
import * as Net from "../core/NetworkService"

// The Wi-Fi dialogs are libnma's (libnma-gtk4), the same library GNOME Settings
// builds its connection editor on: personal and enterprise (802.1X, certificates),
// WEP, LEAP, hidden networks. Decided 2026-09-14 over keeping a hand-made password
// dialog — one set of forms, maintained upstream, instead of ours for the common
// case and theirs for the rest. How they LOOK is an open follow-up.
//
// In common/, not in a surface: Settings → Network AND the Control Centre's Wi-Fi
// detail join networks, and a widget may not import a surface. Three doors, all in
// the shell process (no helper process — see #571 for Settings as its own process):
//   · secrets NetworkManager asks for — common/WifiSecretsAgent.ts, shell-only, which
//     builds its dialog with `runWifiDialog` from here;
//   · an enterprise network joined from Settings, which needs its form BEFORE a
//     connection can exist (setupNetwork);
//   · "Other network…", a hidden SSID (joinHiddenNetwork).
//
// ⚠️ libnma traps, measured from GJS on 2026-09-14 (a third, the worst, is at `borrowedRefs`):
//   - `WifiDialog.new_for_secrets(client, conn, setting, hints)`: the GIR types
//     `hints` as a string while the C reads a NULL-terminated string ARRAY. An empty
//     JS string is read as a pointer array (SIGSEGV in g_strdupv); null is refused by
//     GJS. Eight NUL bytes ARE a valid empty array, so that is what `NO_HINTS` is (in WifiSecretsAgent.ts, its only user) —
//     used only where there is no access point to build `WifiDialog.new` from.
//   - every constructor argument is non-nullable from GJS (connection, device, ap).

/**
 * ⚠️ The third trap, and the one that crashes the SHELL: `WifiDialog.get_connection()`
 * hands back its `device` and `ap` out-parameters BORROWED, while the GIR leaves them
 * at the default `(out)` = transfer full. GJS therefore drops a reference it never
 * got — on the shell's own wlan0 `NM.DeviceWifi` and on the access point — and a few
 * dialogs later libnm touches a finalized object: SIGSEGV inside libnm's D-Bus
 * property handling, twice in one VM session (2026-09-14). Probe, same session:
 * six `get_connection()` calls then rescans → "NM.DeviceWifi has been already
 * finalized" + core dump; with this compensation → 20 rescans and a clean exit.
 *
 * The compensation is one C reference per object returned, held for the life of the
 * process. It has to be IMMORTAL: a plain store is garbage-collected at teardown,
 * gives the references back, and the imbalance returns (measured: crash at exit).
 * A store that contains itself is a C reference cycle GC cannot break.
 */
const borrowedRefs = new Gio.ListStore()
borrowedRefs.append(borrowedRefs)

/** Every text field in `w`'s tree, in order. */
function entries(w: Gtk.Widget | null, out: Gtk.Entry[] = []): Gtk.Entry[] {
    for (let c = w?.get_first_child() ?? null; c; c = c.get_next_sibling()) {
        if (c instanceof Gtk.Entry) out.push(c)
        entries(c, out)
    }
    return out
}

/**
 * Present `dialog` and resolve with its connection on OK, null on anything else.
 * `beforePresent` runs right before the dialog shows — the shell passes
 * `status.closeOverlays()` there, because an open overlay holds the keyboard grab and the
 * form could not be typed into. It is a parameter and not an import so that this module
 * never needs Status: Settings joins networks through it too (#571).
 */
export function runWifiDialog(dialog: NMA.WifiDialog, beforePresent?: () => void): Promise<[NM.Connection, NM.Device | null, NM.AccessPoint | null] | null> {
    // A window that owns the desktop's name: without it Hyprland and the dock file the
    // dialog under the shell PROCESS id and it shows up as an unknown app.
    setWindowAppId(dialog, "nidara-settings")
    return new Promise(resolve => {
        // libnma leaves focus wherever GtkDialog puts it — on a check box, so the first
        // keystrokes went nowhere and Enter toggled "Show password". Start in the field.
        // Start in the first empty field. Not a single grab: at `map` the window is not
        // active yet and GtkWindow re-seats focus on activation; libnma builds its
        // security widgets in stages; and in one run of four the focus still ended on
        // "Show password", so Enter toggled a check box. So for the dialog's first
        // second, whenever focus lands anywhere but a text field, it is moved to the
        // field — through the ENTRY, because `window.set_focus(entry)` paints the ring
        // but leaves the entry's inner GtkText unfocused and typing goes nowhere.
        const toField = () => {
            if (!dialog.is_active) return
            const f = dialog.get_focus()
            if (f instanceof Gtk.Text || f instanceof Gtk.Entry) return
            // The first empty field; on a RETRY libnma pre-fills the refused key, so then
            // the first masked one — grab_focus selects its text, and typing replaces it.
            const usable = entries(dialog).filter(e => e.get_mapped() && e.get_sensitive())
            ;(usable.find(e => !e.text) ?? usable.find(e => !e.visibility) ?? usable[0])?.grab_focus()
        }
        const focusIds = [
            dialog.connect("notify::is-active", toField),
            dialog.connect("notify::focus-widget", toField),
        ]
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            focusIds.forEach(id => { try { dialog.disconnect(id) } catch {} })
            return GLib.SOURCE_REMOVE
        })
        // Enter submits, as in every password prompt. libnma's fields do not activate
        // the default, and GtkDialog has none until it is named; OK stays insensitive
        // while the form is invalid, so Enter cannot submit a half-filled one.
        dialog.set_default_response(Gtk.ResponseType.OK)
        dialog.connect("map", () => { for (const e of entries(dialog)) e.activates_default = true })
        dialog.connect("response", (_d: any, response: number) => {
            let result: [NM.Connection, NM.Device | null, NM.AccessPoint | null] | null = null
            if (response === Gtk.ResponseType.OK) {
                try {
                    result = dialog.get_connection() as any
                    if (result?.[1]) borrowedRefs.append(result[1])
                    if (result?.[2]) borrowedRefs.append(result[2])
                } catch (e) { console.error("[WifiSecrets] get_connection:", e) }
            }
            dialog.destroy()
            resolve(result)
        })
        beforePresent?.()
        dialog.present()
    })
}

/**
 * The enterprise form for `ap`, then the connection it describes. Resolves null when
 * the user cancelled. The caller activates the connection.
 */
export function setupNetwork(ap: NM.AccessPoint, beforePresent?: () => void): Promise<NM.Connection | null> {
    const nm = Net.nmObjects()
    if (!nm) return Promise.resolve(null)
    // A skeleton naming the network: libnma fills in security from the AP.
    const conn = NM.SimpleConnection.new()
    conn.add_setting(new NM.SettingConnection({ id: Net.apSsid(ap), uuid: NM.utils_uuid_generate(), type: "802-11-wireless" }))
    conn.add_setting(new NM.SettingWireless({ ssid: ap.ssid }))
    try {
        return runWifiDialog((NMA.WifiDialog as any).new(nm.client, conn, nm.device, ap, false), beforePresent).then(r => r?.[0] ?? null)
    } catch (e) {
        console.error("[WifiSecrets] could not build the setup dialog:", e)
        return Promise.resolve(null)
    }
}

/** "Other network…": name + security for a hidden SSID, then the connection to join. */
export function joinHiddenNetwork(beforePresent?: () => void): Promise<NM.Connection | null> {
    const nm = Net.nmObjects()
    if (!nm) return Promise.resolve(null)
    try {
        return runWifiDialog(NMA.WifiDialog.new_for_other(nm.client), beforePresent).then(r => r?.[0] ?? null)
    } catch (e) {
        console.error("[WifiSecrets] could not build the hidden-network dialog:", e)
        return Promise.resolve(null)
    }
}

/**
 * Join `ap` the way a user means it: an enterprise network the first time gets its
 * form, anything else is activated and NetworkManager asks for what it lacks.
 * Rejects with Net.ConnectError; a cancelled form rejects with reason "cancelled".
 * `beforePresent`: see runWifiDialog — only called if a form is actually shown.
 */
export function joinNetwork(ap: NM.AccessPoint, isSaved: boolean, beforePresent?: () => void): Promise<void> {
    if (isSaved || !Net.needsSetupDialog(ap)) return Net.connectAp(ap)
    return setupNetwork(ap, beforePresent).then(conn => {
        if (!conn) throw new Net.ConnectError("cancelled")
        return Net.connectAp(ap, conn)
    })
}

/** "Other network…" end to end: the form, then the connection it describes. */
export function joinOtherNetwork(beforePresent?: () => void): Promise<void> {
    return joinHiddenNetwork(beforePresent).then(conn => {
        if (!conn) throw new Net.ConnectError("cancelled")
        return Net.connectAp(null, conn)
    })
}

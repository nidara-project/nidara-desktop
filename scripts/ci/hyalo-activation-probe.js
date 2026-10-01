// hyalo-activation-probe.js — windows that ask to come to the front (xdg-activation-v1), for
// the Hyalo smoke (scripts/ci/hyalo-smoke.sh) and hyalo/compositor/src/activation.rs.
//
//   gjs -m hyalo-activation-probe.js app CMDFILE   two windows, `act-1` (400×300) and `act-2`
//       (200×150); a line `present act-N` written to CMDFILE presents that window — GTK asks
//       for a token with this client's last click and the surface that has its keyboard focus,
//       exactly as an application raising itself does.
//   gjs -m hyalo-activation-probe.js other         one window, `act-q` (600×450): somewhere
//       else for the user to be.
//
// The smoke clicks with the virtual pointer and reads the focus from Hyalo's IPC.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

const [mode, cmdFile] = ARGV
const app = new Gtk.Application({ application_id: mode === "app" ? "org.nidara.activationprobe" : "org.nidara.activationother" })

app.connect("activate", () => {
    const make = (title, w, h) => {
        const win = new Gtk.Window({ application: app, title, default_width: w, default_height: h })
        win.set_child(new Gtk.Label({ label: title }))
        win.present()
        return win
    }
    if (mode !== "app") {
        make("act-q", 600, 450)
        return
    }
    const windows = { "act-1": make("act-1", 400, 300) }
    // The second one a moment later, so the two map in a known order.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        windows["act-2"] = make("act-2", 200, 150)
        return GLib.SOURCE_REMOVE
    })
    let done = 0
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        try {
            const [ok, bytes] = GLib.file_get_contents(cmdFile)
            const lines = ok ? new TextDecoder().decode(bytes).split("\n").filter(Boolean) : []
            for (; done < lines.length; done++) {
                const m = lines[done].match(/^present (\S+)$/)
                if (m && windows[m[1]]) windows[m[1]].present()
            }
        } catch { /* no command yet */ }
        return GLib.SOURCE_CONTINUE
    })
})
app.run([])

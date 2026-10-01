// hyalo-inhibit-probe.js — a window that holds the keyboard's shortcuts, as a virtual machine
// or a remote desktop does (keyboard-shortcuts-inhibit-v1), for scripts/ci/hyalo-inhibit-check.sh.
// Prints INHIBITED / RELEASED as the compositor grants or takes the shortcuts back.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

const app = new Gtk.Application({ application_id: "org.nidara.inhibitprobe" })
app.connect("activate", () => {
    const win = new Gtk.Window({ application: app, title: "inhibit-probe", default_width: 320, default_height: 200 })
    win.set_child(new Gtk.Label({ label: "holds the shortcuts" }))
    win.present()
    // Once it is shown and focused: GTK asks the compositor for the shortcuts.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        const surface = win.get_surface()
        surface.connect("notify::shortcuts-inhibited", () => {
            print(surface.shortcuts_inhibited ? "INHIBITED" : "RELEASED")
        })
        surface.inhibit_system_shortcuts(null)
        return GLib.SOURCE_REMOVE
    })
})
app.run([])

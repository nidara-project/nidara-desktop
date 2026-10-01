// hyalo-dialog-probe.js — a window and a dialog over it, for scripts/ci/hyalo-dialog-check.sh.
//   gjs -m hyalo-dialog-probe.js modal      the dialog is modal (GTK says so with xdg-dialog-v1)
//   gjs -m hyalo-dialog-probe.js plain      a dialog that is not
// Titles: `dlg-parent-<mode>`, `dlg-<mode>`.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

const mode = ARGV[0] === "modal" ? "modal" : "plain"
const app = new Gtk.Application({ application_id: `org.nidara.dialogprobe.${mode}` })
app.connect("activate", () => {
    const parent = new Gtk.Window({ application: app, title: `dlg-parent-${mode}`, default_width: 480, default_height: 320 })
    parent.set_child(new Gtk.Label({ label: "parent" }))
    parent.present()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        const dialog = new Gtk.Window({
            application: app, title: `dlg-${mode}`, transient_for: parent, modal: mode === "modal",
            default_width: 240, default_height: 120,
        })
        dialog.set_child(new Gtk.Label({ label: mode }))
        dialog.present()
        return GLib.SOURCE_REMOVE
    })
})
app.run([])

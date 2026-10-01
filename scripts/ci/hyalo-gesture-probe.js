// hyalo-gesture-probe.js — a window that zooms on a touchpad pinch (pointer-gestures-v1), for
// scripts/ci/hyalo-gesture-check.sh. Prints `ZOOM <scale>` as GTK's zoom gesture follows it.

import Gtk from "gi://Gtk?version=4.0"

const app = new Gtk.Application({ application_id: "org.nidara.gestureprobe" })
app.connect("activate", () => {
    const win = new Gtk.Window({ application: app, title: "gesture-probe", default_width: 320, default_height: 200 })
    win.set_child(new Gtk.Label({ label: "pinch me" }))
    const zoom = new Gtk.GestureZoom()
    zoom.connect("scale-changed", (_g, scale) => print(`ZOOM ${scale.toFixed(2)}`))
    win.add_controller(zoom)
    win.present()
})
app.run([])

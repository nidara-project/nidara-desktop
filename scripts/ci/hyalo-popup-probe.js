// hyalo-popup-probe.js — clients for scripts/ci/hyalo-popup-check.sh.
//   gjs -m hyalo-popup-probe.js menu    a layer surface shaped like the dock (namespace `popup-probe`,
//                                       no keyboard of its own): a right-click on its icon opens an
//                                       autohide menu from an idle after the release, as DockItem
//                                       does. Prints `MENU OPEN` / `MENU CLOSED`
//   gjs -m hyalo-popup-probe.js field   a window (`popup-field`) with an entry: prints `FIELD IN` /
//                                       `FIELD OUT` as its window gets and loses the keyboard
// Needs gtk4-layer-shell preloaded, both roles: LD_PRELOAD=…/libgtk4-layer-shell.so.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import LayerShell from "gi://Gtk4LayerShell"

const role = ARGV[0] === "menu" ? "menu" : "field"
const say = (line) => { print(line); }

const app = new Gtk.Application({ application_id: `org.nidara.popupprobe.${role}` })
app.connect("activate", () => {
    if (role === "field") {
        const win = new Gtk.Window({ application: app, title: "popup-field", default_width: 400, default_height: 300 })
        const entry = new Gtk.Entry()
        const focus = new Gtk.EventControllerFocus()
        focus.connect("enter", () => say("FIELD IN"))
        focus.connect("leave", () => say("FIELD OUT"))
        entry.add_controller(focus)
        win.set_child(entry)
        win.present()
        return
    }
    const win = new Gtk.Window({ application: app, default_width: 300, default_height: 100 })
    LayerShell.init_for_window(win)
    LayerShell.set_namespace(win, "popup-probe")
    LayerShell.set_layer(win, LayerShell.Layer.OVERLAY)
    LayerShell.set_anchor(win, LayerShell.Edge.TOP, true)
    LayerShell.set_anchor(win, LayerShell.Edge.LEFT, true)
    LayerShell.set_margin(win, LayerShell.Edge.TOP, 200)
    LayerShell.set_margin(win, LayerShell.Edge.LEFT, 200)
    // The icon on the left; the rest of the surface is the dock's empty glass.
    const icon = new Gtk.Box({ width_request: 100, height_request: 100, halign: Gtk.Align.START })
    icon.append(new Gtk.Label({ label: "icon", hexpand: true }))
    const menu = new Gtk.Popover({ autohide: true, child: new Gtk.Label({ label: "one\ntwo\nthree" }) })
    menu.set_parent(icon)
    menu.connect("closed", () => say("MENU CLOSED"))
    const rightClick = new Gtk.GestureClick({ button: 3 })
    rightClick.connect("released", () => {
        if (menu.visible) { menu.popdown(); return }
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { menu.popup(); say("MENU OPEN"); return GLib.SOURCE_REMOVE })
    })
    icon.add_controller(rightClick)
    win.set_child(icon)
    win.present()
})
app.run([])

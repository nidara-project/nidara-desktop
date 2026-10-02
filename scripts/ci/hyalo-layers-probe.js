// hyalo-layers-probe.js — a bar and a dock as the shell makes them, for
// scripts/ci/hyalo-layers-check.sh: both cover the output and each reserves its strip (the bar
// 36 px at the top; the dock 80 px at the bottom, left or right). They are mapped in the order
// given, which is what Smithay's own placement depended on.
//   gjs -m hyalo-layers-probe.js bottom|left|right dock-first|bar-first
// Namespaces `probe-bar`, `probe-dock`. Needs gtk4-layer-shell preloaded:
// LD_PRELOAD=…/libgtk4-layer-shell.so.

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import LayerShell from "gi://Gtk4LayerShell"

const side = ARGV[0] ?? "bottom"
const order = ARGV[1] === "bar-first" ? ["bar", "dock"] : ["dock", "bar"]
const { Edge } = LayerShell

const app = new Gtk.Application({ application_id: "org.nidara.layersprobe" })
app.connect("activate", () => {
    const monitor = Gdk.Display.get_default().get_monitors().get_item(0)
    const { width, height } = monitor.get_geometry()
    const make = (name) => {
        const win = new Gtk.Window({ application: app, default_width: width, default_height: height })
        LayerShell.init_for_window(win)
        LayerShell.set_namespace(win, `probe-${name}`)
        LayerShell.set_layer(win, LayerShell.Layer.TOP)
        if (name === "bar") {
            for (const e of [Edge.TOP, Edge.LEFT, Edge.RIGHT]) LayerShell.set_anchor(win, e, true)
            LayerShell.set_exclusive_zone(win, 36)
        } else {
            const edge = side === "left" ? Edge.LEFT : side === "right" ? Edge.RIGHT : Edge.BOTTOM
            const across = edge === Edge.BOTTOM ? [Edge.LEFT, Edge.RIGHT] : [Edge.TOP, Edge.BOTTOM]
            for (const e of [edge, ...across]) LayerShell.set_anchor(win, e, true)
            LayerShell.set_exclusive_zone(win, 80)
        }
        win.set_child(new Gtk.Label({ label: name }))
        win.present()
    }
    order.forEach(make)
})
app.run([])

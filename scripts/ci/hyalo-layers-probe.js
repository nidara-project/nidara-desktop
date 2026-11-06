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
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import NidaraWl from "gi://NidaraWl"

const side = ARGV[0] ?? "bottom"
const order = ARGV[1] === "bar-first" ? ["bar", "dock"] : ["dock", "bar"]
const { Edge } = LayerShell

// Transfer the TS bar's compositor protocol checks to this dedicated client:
// both fusion membership and a restricted drawn region must reach Hyalo.
const windows = []
const publish = (win, expanded = false) => {
    const surface = win.get_surface()
    if (!surface) return GLib.SOURCE_CONTINUE
    NidaraWl.init()
    NidaraWl.material_begin(surface)
    NidaraWl.material_set_glass(surface, 0, 0)
    NidaraWl.material_set_fusion(surface, 1, 12)
    NidaraWl.material_add_shape(surface, 4, 4, 20, 20, 4, 2)
    NidaraWl.material_add_shape(surface, 28, 4, 20, 20, 4, 2)
    NidaraWl.material_commit(surface, 4, 1)
    const scale = surface.get_scale_factor()
    NidaraWl.visible_region_begin(surface)
    NidaraWl.visible_region_add_rect(surface, 0, 0, (expanded ? 200 : 100) * scale,
                                    (expanded ? 80 : 40) * scale)
    NidaraWl.visible_region_commit(surface)
    // Change content too: GTK may reuse an identical buffer without a new commit.
    win.get_child().set_label(expanded ? "expanded region" : "initial region")
    win.queue_draw()
    return GLib.SOURCE_REMOVE
}
const endpoint = Gio.DBusExportedObject.wrapJSObject(
    '<node><interface name="org.nidara.LayerProbe"><method name="Expand"/></interface></node>',
    { Expand() { windows.forEach(win => publish(win, true)) } },
)
endpoint.export(Gio.DBus.session, "/org/nidara/LayerProbe")
Gio.bus_own_name_on_connection(Gio.DBus.session, "org.nidara.LayerProbe",
                              Gio.BusNameOwnerFlags.NONE, null, null)
const app = new Gtk.Application({ application_id: "org.nidara.layersprobe" })
app.connect("activate", () => {
    const monitor = Gdk.Display.get_default().get_monitors().get_item(0)
    const { width, height } = monitor.get_geometry()
    // Neither full-output fixture may occlude the other's frame callbacks.
    const css = new Gtk.CssProvider()
    css.load_from_string("window#hyalo-layer-probe { background: transparent; box-shadow: none; }")
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    const make = (name) => {
        const win = new Gtk.Window({ application: app, default_width: width, default_height: height })
        win.set_name("hyalo-layer-probe")
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
        windows.push(win)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => publish(win))
    }
    order.forEach(make)
})
app.run([])

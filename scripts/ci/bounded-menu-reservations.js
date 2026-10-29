// SPDX-License-Identifier: LGPL-3.0-or-later
// Private checker fixture only: two real layer-shell exclusive reservations.
import Gtk from 'gi://Gtk?version=4.0'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import LayerShell from 'gi://Gtk4LayerShell'
const app = new Gtk.Application({ application_id: 'org.nidara.BoundedMenuReservations' })
app.connect('activate', () => {
    const windows = [LayerShell.Edge.TOP, LayerShell.Edge.BOTTOM].map((edge, index) => {
        const win = new Gtk.Window({ application: app, decorated: false })
        LayerShell.init_for_window(win)
        LayerShell.set_namespace(win, index === 0 ? 'bounded-menu-top' : 'bounded-menu-bottom')
        LayerShell.set_layer(win, LayerShell.Layer.TOP)
        LayerShell.set_anchor(win, edge, true)
        LayerShell.set_anchor(win, LayerShell.Edge.LEFT, true)
        LayerShell.set_anchor(win, LayerShell.Edge.RIGHT, true)
        win.set_child(new Gtk.Box({ height_request: index === 0 ? 48 : 36 }))
        LayerShell.set_exclusive_zone(win, index === 0 ? 48 : 36)
        win.present()
        return win
    })
    let previous = ''
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        try {
            const [ok, bytes] = Gio.File.new_for_path(GLib.getenv('NK_MENU_RESERVATIONS')).load_contents(null)
            const text = new TextDecoder().decode(bytes).trim()
            if (ok && text !== previous) {
                const sizes = text.split(' ').map(Number)
                if (sizes.length === 2 && sizes.every(v => Number.isInteger(v) && v > 0 && v <= 200)) {
                    windows.forEach((win, at) => {
                        win.get_child().set_size_request(-1, sizes[at])
                        LayerShell.set_exclusive_zone(win, sizes[at])
                    })
                    print(`RESERVATIONS ${text}`)
                    previous = text
                }
            }
        } catch (_) { }
        return GLib.SOURCE_CONTINUE
    })
})
app.run([])
